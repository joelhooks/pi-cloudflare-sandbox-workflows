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
  WorkflowEventSchema,
} from "../domain/schemas.ts";
import type {
  AgentLaneAdmissionDecision,
  AgentLaneReleaseReceipt,
  ContextCapsuleRecord,
} from "../domain/schemas.ts";

export interface WorkflowCapsuleSupervisorEnv {
  readonly WORKFLOW_CAPSULE_SUPERVISOR: DurableObjectNamespace<CloudflareWorkflowCapsuleSupervisor>;
}

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

  private async getRecordResponse(): Promise<Response> {
    return json(await this.getRecord());
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
