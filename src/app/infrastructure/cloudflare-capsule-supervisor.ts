/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import type {
  AgentLaneAdmissionControllerContract,
  ContextCapsuleActorContract,
} from "../application/ports.ts";
import {
  AgentLaneAdmissionDecisionSchema,
  AgentLaneAdmissionRequestSchema,
  AgentLaneReleaseReceiptSchema,
  AgentLaneReleaseRequestSchema,
  ContextCapsuleRecordSchema,
  LoadRunCheckpointRequestSchema,
  LoadRunCheckpointResolutionSchema,
  PersistRunCheckpointRequestSchema,
  RunStepCheckpointSchema,
  WorkflowEventSchema,
} from "../domain/schemas.ts";
import type {
  AgentLaneAdmissionDecision,
  AgentLaneReleaseReceipt,
  ContextCapsuleRecord,
  RunStepCheckpoint,
} from "../domain/schemas.ts";
import type { CloudflareD1PackageRegistryConfig } from "./cloudflare-package-registry.ts";
import { reapStuckRunsForWorkItem } from "./cloudflare-run-reaper.ts";

export interface WorkflowCapsuleSupervisorEnv {
  readonly WORKFLOW_APP_D1?: CloudflareD1PackageRegistryConfig["d1"];
  readonly WORKFLOW_APP_TIMEOUT_MS?: number | string;
  readonly WORKFLOW_CAPSULE_SUPERVISOR: DurableObjectNamespace<CloudflareWorkflowCapsuleSupervisor>;
}

const TimeoutMsSchema = z.coerce.number().int().min(1);

const ResolveCapsuleRequestSchema = z.object({
  runId: z.string().min(1),
  workItemId: z.string().min(1),
});

const AppendCapsuleEventRequestSchema = z.object({
  event: WorkflowEventSchema,
  workItemId: z.string().min(1),
});

const SupervisorRecordSchema = z.object({
  activeLaneIds: z.array(z.string().min(1)).default([]),
  capsule: ContextCapsuleRecordSchema.optional(),
  completedLaneIds: z.array(z.string().min(1)).default([]),
  events: z.array(WorkflowEventSchema).default([]),
  failedLaneIds: z.array(z.string().min(1)).default([]),
  laneReleases: z
    .record(z.string().min(1), AgentLaneReleaseReceiptSchema)
    .default({}),
  maxObservedActiveLanes: z.number().int().min(0).default(0),
  workItemId: z.string().min(1).optional(),
});

type SupervisorRecord = z.infer<typeof SupervisorRecordSchema>;

const json = (body: unknown, init?: ResponseInit): Response =>
  Response.json(body, init);

const nowIso = (): string => new Date().toISOString();

/**
 * Storage key for a resumable run checkpoint. Keyed by `runId` + `stepIndex` so
 * a re-persist of the same step overwrites the same slot (idempotent), while
 * distinct steps each retain their own snapshot for inspection and resume.
 */
const checkpointStorageKey = (runId: string, stepIndex: number): string =>
  `checkpoint:${runId}:${stepIndex}`;

/**
 * Storage-key prefix for every checkpoint of a run. `ctx.storage.list({ prefix
 * })` over this prefix enumerates all persisted steps so resume can select the
 * highest `stepIndex` (the latest checkpoint).
 */
const checkpointStoragePrefix = (runId: string): string =>
  `checkpoint:${runId}:`;

const createCapsuleRecord = (input: {
  readonly runId: string;
  readonly workItemId: string;
}): ContextCapsuleRecord =>
  ContextCapsuleRecordSchema.parse({
    capsuleId: `capsule:${input.workItemId}`,
    createdAt: nowIso(),
    latestRunId: input.runId,
    pinnedPackageRefs: [],
    workItemId: input.workItemId,
  });

const omitLaneId = (
  laneIds: readonly string[],
  laneIdToOmit: string
): string[] => laneIds.filter((laneId) => laneId !== laneIdToOmit);

const appendUnique = (
  laneIds: readonly string[],
  laneIdToAppend: string
): string[] =>
  laneIds.includes(laneIdToAppend)
    ? [...laneIds]
    : [...laneIds, laneIdToAppend];

export class CloudflareWorkflowCapsuleSupervisor extends DurableObject<WorkflowCapsuleSupervisorEnv> {
  override fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    const postRoutes: Record<string, () => Promise<Response>> = {
      "/admit-lane": () => this.admitLane(request),
      "/append-event": () => this.appendEvent(request),
      "/load-latest-checkpoint": () => this.loadLatestCheckpoint(request),
      "/persist-checkpoint": () => this.persistCheckpoint(request),
      "/release-lane": () => this.releaseLane(request),
      "/resolve": () => this.resolveCapsule(request),
    };
    const getRoutes: Record<string, () => Promise<Response>> = {
      "/record": () => this.getRecordResponse(),
    };
    const handler =
      request.method === "POST" ? postRoutes[pathname] : getRoutes[pathname];

    return handler
      ? handler()
      : Promise.resolve(json({ error: "not found" }, { status: 404 }));
  }

  private async admitLane(request: Request): Promise<Response> {
    const input = AgentLaneAdmissionRequestSchema.parse(await request.json());
    const record = await this.getRecord();

    if (record.completedLaneIds.includes(input.laneId)) {
      return json(
        AgentLaneAdmissionDecisionSchema.parse({
          kind: input.kind,
          laneId: input.laneId,
          runId: input.runId,
          status: "already-completed",
          workItemId: input.workItemId,
        })
      );
    }

    if (record.activeLaneIds.includes(input.laneId)) {
      return json(
        AgentLaneAdmissionDecisionSchema.parse({
          activeLaneIds: record.activeLaneIds,
          kind: input.kind,
          laneId: input.laneId,
          maxActiveLanes: input.maxActiveLanes,
          reason: "already-active",
          retryAfterSeconds: 1,
          runId: input.runId,
          status: "deferred",
          workItemId: input.workItemId,
        })
      );
    }

    if (record.activeLaneIds.length >= input.maxActiveLanes) {
      return json(
        AgentLaneAdmissionDecisionSchema.parse({
          activeLaneIds: record.activeLaneIds,
          kind: input.kind,
          laneId: input.laneId,
          maxActiveLanes: input.maxActiveLanes,
          reason: "concurrency-cap-full",
          retryAfterSeconds: 2,
          runId: input.runId,
          status: "deferred",
          workItemId: input.workItemId,
        })
      );
    }

    const activeLaneIds = [...record.activeLaneIds, input.laneId];
    const nextRecord = SupervisorRecordSchema.parse({
      ...record,
      activeLaneIds,
      maxObservedActiveLanes: Math.max(
        record.maxObservedActiveLanes,
        activeLaneIds.length
      ),
      workItemId: input.workItemId,
    });
    await this.putRecord(nextRecord);
    await this.ensureReaperAlarm();

    return json(
      AgentLaneAdmissionDecisionSchema.parse({
        activeLaneIds,
        admissionId: `admission:${input.runId}:${input.laneId}:${crypto.randomUUID()}`,
        admittedAt: nowIso(),
        kind: input.kind,
        laneId: input.laneId,
        maxActiveLanes: input.maxActiveLanes,
        runId: input.runId,
        status: "admitted",
        workItemId: input.workItemId,
      })
    );
  }

  private async appendEvent(request: Request): Promise<Response> {
    const input = AppendCapsuleEventRequestSchema.parse(await request.json());
    const record = await this.getRecord();
    await this.putRecord(
      SupervisorRecordSchema.parse({
        ...record,
        events: [...record.events, input.event],
        workItemId: input.workItemId,
      })
    );

    return json({ ok: true });
  }

  /**
   * Persist a resumable run checkpoint to DO storage (M2.5 step 2). Overwrites
   * by `runId` + `stepIndex`, so re-persisting the same step is a stable no-op
   * that yields the same stored snapshot. Does not drive execution — only
   * durable state.
   */
  private async persistCheckpoint(request: Request): Promise<Response> {
    const input = PersistRunCheckpointRequestSchema.parse(await request.json());
    const checkpoint = RunStepCheckpointSchema.parse(input.checkpoint);
    await this.ctx.storage.put(
      checkpointStorageKey(checkpoint.runId, checkpoint.stepIndex),
      checkpoint
    );

    return json({ ok: true });
  }

  /**
   * Load the most-recent checkpoint for a run (M2.5 step 3, resume). Lists every
   * checkpoint slot under the run prefix and returns the one with the highest
   * `stepIndex`, or a null resolution when the run never checkpointed. This is
   * the read mirror of `persistCheckpoint`; it drives nothing — the resume
   * decision (rehydrate vs. fresh start) is made by the application.
   */
  private async loadLatestCheckpoint(request: Request): Promise<Response> {
    const input = LoadRunCheckpointRequestSchema.parse(await request.json());
    const stored = await this.ctx.storage.list({
      prefix: checkpointStoragePrefix(input.runId),
    });
    let latest: ReturnType<typeof RunStepCheckpointSchema.parse> | null = null;
    for (const value of stored.values()) {
      const checkpoint = RunStepCheckpointSchema.parse(value);
      if (latest === null || checkpoint.stepIndex > latest.stepIndex) {
        latest = checkpoint;
      }
    }

    return json(
      LoadRunCheckpointResolutionSchema.parse({ checkpoint: latest })
    );
  }

  private async getRecordResponse(): Promise<Response> {
    return json(await this.getRecord());
  }

  /**
   * Reaper alarm. Marks any run for this work item stuck in a non-terminal D1
   * state past the timeout as failed and releases its leaked admission slots.
   * No-op when no run is stuck (idempotent re-sweep) and when D1/timeout are
   * unbound. Re-arms itself while admission slots remain so a later crash is
   * still swept.
   */
  override async alarm(): Promise<void> {
    const reaperContext = this.resolveReaperContext();
    if (reaperContext === undefined) {
      return;
    }

    const record = await this.getRecord();
    if (record.workItemId === undefined) {
      return;
    }

    const { reapedRunIds } = await reapStuckRunsForWorkItem({
      d1: reaperContext.d1,
      timeoutMs: reaperContext.timeoutMs,
      workItemId: record.workItemId,
    });

    if (reapedRunIds.length > 0) {
      await this.releaseAdmissionSlotsAfterReap(record);
    }

    await this.rearmReaperAlarmIfSlotsRemain();
  }

  private resolveReaperContext():
    | undefined
    | {
        readonly d1: NonNullable<
          WorkflowCapsuleSupervisorEnv["WORKFLOW_APP_D1"]
        >;
        readonly timeoutMs: number;
      } {
    const d1 = this.env.WORKFLOW_APP_D1;
    const timeoutMs = TimeoutMsSchema.safeParse(
      this.env.WORKFLOW_APP_TIMEOUT_MS
    );
    if (d1 === undefined || !timeoutMs.success) {
      return undefined;
    }

    return { d1, timeoutMs: timeoutMs.data };
  }

  private async releaseAdmissionSlotsAfterReap(
    record: SupervisorRecord
  ): Promise<void> {
    if (record.activeLaneIds.length === 0) {
      return;
    }

    let { failedLaneIds } = record;
    for (const laneId of record.activeLaneIds) {
      failedLaneIds = appendUnique(failedLaneIds, laneId);
    }
    await this.putRecord(
      SupervisorRecordSchema.parse({
        ...record,
        activeLaneIds: [],
        failedLaneIds,
      })
    );
  }

  private async ensureReaperAlarm(): Promise<void> {
    const reaperContext = this.resolveReaperContext();
    if (reaperContext === undefined) {
      return;
    }

    const fireAt = Date.now() + reaperContext.timeoutMs;
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || existing > fireAt) {
      await this.ctx.storage.setAlarm(fireAt);
    }
  }

  private async rearmReaperAlarmIfSlotsRemain(): Promise<void> {
    const record = await this.getRecord();
    if (record.activeLaneIds.length === 0) {
      return;
    }

    await this.ensureReaperAlarm();
  }

  private async releaseLane(request: Request): Promise<Response> {
    const input = AgentLaneReleaseRequestSchema.parse(await request.json());
    const record = await this.getRecord();
    const activeLaneIds = omitLaneId(record.activeLaneIds, input.laneId);
    const artifactCommitSha =
      input.artifactCommitSha === undefined
        ? {}
        : { artifactCommitSha: input.artifactCommitSha };
    const receipt = AgentLaneReleaseReceiptSchema.parse({
      ...artifactCommitSha,
      activeLaneIds,
      kind: input.kind,
      laneId: input.laneId,
      releasedAt: input.releasedAt,
      runId: input.runId,
      status: input.status,
      workItemId: input.workItemId,
    });
    const nextRecord = SupervisorRecordSchema.parse({
      ...record,
      activeLaneIds,
      completedLaneIds:
        input.status === "completed"
          ? appendUnique(record.completedLaneIds, input.laneId)
          : record.completedLaneIds,
      failedLaneIds:
        input.status === "failed"
          ? appendUnique(record.failedLaneIds, input.laneId)
          : record.failedLaneIds,
      laneReleases: {
        ...record.laneReleases,
        [input.laneId]: {
          ...receipt,
          activeLaneIds,
        },
      },
      workItemId: input.workItemId,
    });
    await this.putRecord(nextRecord);

    return json(
      AgentLaneReleaseReceiptSchema.parse({
        ...receipt,
        activeLaneIds,
      })
    );
  }

  private async resolveCapsule(request: Request): Promise<Response> {
    const input = ResolveCapsuleRequestSchema.parse(await request.json());
    const record = await this.getRecord();
    const capsule = ContextCapsuleRecordSchema.parse(
      record.capsule === undefined
        ? createCapsuleRecord(input)
        : {
            ...record.capsule,
            latestRunId: input.runId,
          }
    );
    await this.putRecord(
      SupervisorRecordSchema.parse({
        ...record,
        capsule,
        workItemId: input.workItemId,
      })
    );

    return json(capsule);
  }

  private async getRecord(): Promise<SupervisorRecord> {
    return SupervisorRecordSchema.parse(
      (await this.ctx.storage.get("record")) ?? {}
    );
  }

  private async putRecord(record: SupervisorRecord): Promise<void> {
    await this.ctx.storage.put("record", SupervisorRecordSchema.parse(record));
  }
}

const supervisorRequestUrl = (path: string): string =>
  new URL(path, "https://workflow-capsule-supervisor.internal").toString();

const postJson = async (
  stub: DurableObjectStub,
  path: string,
  body: unknown
): Promise<unknown> => {
  const response = await stub.fetch(
    new Request(supervisorRequestUrl(path), {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
  );
  if (!response.ok) {
    throw new Error(`Capsule supervisor request failed: ${path}`);
  }

  return await response.json();
};

export const createCloudflareCapsuleSupervisorClient = (
  namespace: DurableObjectNamespace<CloudflareWorkflowCapsuleSupervisor>
): ContextCapsuleActorContract & AgentLaneAdmissionControllerContract => {
  const stubFor = (workItemId: string): DurableObjectStub =>
    namespace.get(namespace.idFromName(workItemId));

  return {
    async admitLane(input): Promise<AgentLaneAdmissionDecision> {
      return AgentLaneAdmissionDecisionSchema.parse(
        await postJson(stubFor(input.workItemId), "/admit-lane", input)
      );
    },
    async appendEvent(input): Promise<void> {
      await postJson(stubFor(input.workItemId), "/append-event", input);
    },
    async loadLatestCheckpoint(input): Promise<RunStepCheckpoint | null> {
      const resolution = LoadRunCheckpointResolutionSchema.parse(
        await postJson(
          stubFor(input.workItemId),
          "/load-latest-checkpoint",
          input
        )
      );

      return resolution.checkpoint;
    },
    async persistCheckpoint(input): Promise<void> {
      await postJson(stubFor(input.workItemId), "/persist-checkpoint", input);
    },
    async releaseLane(input): Promise<AgentLaneReleaseReceipt> {
      return AgentLaneReleaseReceiptSchema.parse(
        await postJson(stubFor(input.workItemId), "/release-lane", input)
      );
    },
    async resolve(input): Promise<ContextCapsuleRecord> {
      return ContextCapsuleRecordSchema.parse(
        await postJson(stubFor(input.workItemId), "/resolve", input)
      );
    },
  };
};
