/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import type {
  AgentLaneAdmissionControllerContract,
  ContextCapsuleActorContract,
  WorkerFrontDoorContract,
} from "../application/ports.ts";
import { StaleDriveGenerationError } from "../application/ports.ts";
import { MAX_STALL_GENERATIONS } from "../application/workflow-drive-constants.ts";
import {
  AgentLaneAdmissionDecisionSchema,
  AgentLaneAdmissionRequestSchema,
  AgentLaneReleaseReceiptSchema,
  AgentLaneReleaseRequestSchema,
  ContextCapsuleRecordSchema,
  LoadRunCheckpointRequestSchema,
  LoadRunCheckpointResolutionSchema,
  PersistRunCheckpointRequestSchema,
  RunDurabilityDumpSchema,
  RunDurabilityRequestSchema,
  RunStepCheckpointSchema,
  SafetyEnvelopeStateSchema,
  StartRunRequestSchema,
  StaleDriveGenerationRejectionSchema,
  WorkflowEventSchema,
  WorkflowDriveAdmissionSchema,
  WorkflowDriveFailureRecordRequestSchema,
  WorkflowDriveFailureSchema,
  WorkflowDriveGenerationAssertionRequestSchema,
  WorkflowDriveLaneDispatchRecordRequestSchema,
  WorkflowDriveLaneStatusRecordRequestSchema,
  WorkflowDriveLedgerPhaseCompletionRequestSchema,
  WorkflowDriveNodeAttemptRecordRequestSchema,
  WorkflowDriveNodeAttemptSchema,
  WorkflowDriveLedgerRequestSchema,
  WorkflowDriveLedgerSchema,
  WorkflowRunRequestSchema,
} from "../domain/schemas.ts";
import type {
  AgentLaneAdmissionDecision,
  AgentLaneReleaseReceipt,
  ContextCapsuleRecord,
  RunDurabilityDump,
  RunStepCheckpoint,
  SafetyEnvelopeState,
  WorkflowDriveAdmission,
  WorkflowDriveNodeAttempt,
  WorkflowDriveLedger,
  StartRunRequest,
  WorkflowRunRequest,
} from "../domain/schemas.ts";
import type { CloudflareD1PackageRegistryConfig } from "./cloudflare-package-registry.ts";
import {
  reapStuckRunsForWorkItem,
  TERMINAL_RUN_STATES,
} from "./cloudflare-run-reaper.ts";
import { createCloudflareWorkflowRunStatusReader } from "./cloudflare-workflow-event-stream.ts";

export interface WorkflowCapsuleSupervisorEnv {
  readonly WORKFLOW_APP_D1?: CloudflareD1PackageRegistryConfig["d1"];
  readonly WORKFLOW_APP_TIMEOUT_MS?: number | string;
  readonly WORKFLOW_CAPSULE_SUPERVISOR: DurableObjectNamespace<CloudflareWorkflowCapsuleSupervisor>;
  readonly ZOMBIE_NODE_MAX_ATTEMPTS?: number | string;
}

type CapsuleSupervisorPorts = ContextCapsuleActorContract &
  AgentLaneAdmissionControllerContract;

const ResolveCapsuleRequestSchema = z.object({
  runId: z.string().min(1),
  workItemId: z.string().min(1),
});

const AppendCapsuleEventRequestSchema = z.object({
  event: WorkflowEventSchema,
  workItemId: z.string().min(1),
});

interface InProcessCapsuleSupervisorCore {
  admitDriveCore(
    input: z.infer<typeof WorkflowDriveLedgerRequestSchema>
  ): Promise<WorkflowDriveAdmission>;
  admitLaneCore(
    input: z.infer<typeof AgentLaneAdmissionRequestSchema>
  ): Promise<AgentLaneAdmissionDecision>;
  appendEventCore(
    input: z.infer<typeof AppendCapsuleEventRequestSchema>
  ): Promise<void>;
  assertActiveDriveGenerationCore(
    input: z.infer<typeof WorkflowDriveGenerationAssertionRequestSchema>
  ): Promise<void>;
  loadDriveLedgerCore(
    input: z.infer<typeof WorkflowDriveLedgerRequestSchema>
  ): Promise<WorkflowDriveLedger>;
  loadLatestCheckpointCore(
    input: z.infer<typeof LoadRunCheckpointRequestSchema>
  ): Promise<RunStepCheckpoint | null>;
  persistCheckpointCore(
    input: z.infer<typeof PersistRunCheckpointRequestSchema>
  ): Promise<void>;
  recordDriveLaneDispatchCore(
    input: z.infer<typeof WorkflowDriveLaneDispatchRecordRequestSchema>
  ): Promise<WorkflowDriveLedger>;
  recordDriveLaneStatusCore(
    input: z.infer<typeof WorkflowDriveLaneStatusRecordRequestSchema>
  ): Promise<WorkflowDriveLedger>;
  recordDriveNodeAttemptCore(
    input: z.infer<typeof WorkflowDriveNodeAttemptRecordRequestSchema>
  ): Promise<WorkflowDriveNodeAttempt>;
  recordDrivePhaseCompletionCore(
    input: z.infer<typeof WorkflowDriveLedgerPhaseCompletionRequestSchema>
  ): Promise<WorkflowDriveLedger>;
  releaseLaneCore(
    input: z.infer<typeof AgentLaneReleaseRequestSchema>
  ): Promise<AgentLaneReleaseReceipt>;
  resolveCapsuleCore(
    input: z.infer<typeof ResolveCapsuleRequestSchema>
  ): Promise<ContextCapsuleRecord>;
}

export const createInProcessCapsuleSupervisorClient = (
  self: CloudflareWorkflowCapsuleSupervisor
): CapsuleSupervisorPorts => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Friend adapter in this module reaches private core methods without making them public Durable Object RPC methods.
  const core = self as unknown as InProcessCapsuleSupervisorCore;

  return {
    async admitDrive(input) {
      return WorkflowDriveAdmissionSchema.parse(
        await core.admitDriveCore(WorkflowDriveLedgerRequestSchema.parse(input))
      );
    },
    async admitLane(input): Promise<AgentLaneAdmissionDecision> {
      return AgentLaneAdmissionDecisionSchema.parse(
        await core.admitLaneCore(AgentLaneAdmissionRequestSchema.parse(input))
      );
    },
    async appendEvent(input): Promise<void> {
      await core.appendEventCore(AppendCapsuleEventRequestSchema.parse(input));
    },
    async assertActiveDriveGeneration(input): Promise<void> {
      await core.assertActiveDriveGenerationCore(
        WorkflowDriveGenerationAssertionRequestSchema.parse(input)
      );
    },
    async loadDriveLedger(input) {
      return WorkflowDriveLedgerSchema.parse(
        await core.loadDriveLedgerCore(
          WorkflowDriveLedgerRequestSchema.parse(input)
        )
      );
    },
    async loadLatestCheckpoint(input): Promise<RunStepCheckpoint | null> {
      return await core.loadLatestCheckpointCore(
        LoadRunCheckpointRequestSchema.parse(input)
      );
    },
    async persistCheckpoint(input): Promise<void> {
      await core.persistCheckpointCore(
        PersistRunCheckpointRequestSchema.parse(input)
      );
    },
    async recordDriveLaneDispatch(input) {
      return WorkflowDriveLedgerSchema.parse(
        await core.recordDriveLaneDispatchCore(
          WorkflowDriveLaneDispatchRecordRequestSchema.parse(input)
        )
      );
    },
    async recordDriveLaneStatus(input) {
      return WorkflowDriveLedgerSchema.parse(
        await core.recordDriveLaneStatusCore(
          WorkflowDriveLaneStatusRecordRequestSchema.parse(input)
        )
      );
    },
    async recordDriveNodeAttempt(input) {
      return WorkflowDriveNodeAttemptSchema.parse(
        await core.recordDriveNodeAttemptCore(
          WorkflowDriveNodeAttemptRecordRequestSchema.parse(input)
        )
      );
    },
    async recordDrivePhaseCompletion(input) {
      return WorkflowDriveLedgerSchema.parse(
        await core.recordDrivePhaseCompletionCore(
          WorkflowDriveLedgerPhaseCompletionRequestSchema.parse(input)
        )
      );
    },
    async releaseLane(input): Promise<AgentLaneReleaseReceipt> {
      return AgentLaneReleaseReceiptSchema.parse(
        await core.releaseLaneCore(AgentLaneReleaseRequestSchema.parse(input))
      );
    },
    async resolve(input) {
      return ContextCapsuleRecordSchema.parse(
        await core.resolveCapsuleCore(ResolveCapsuleRequestSchema.parse(input))
      );
    },
  };
};

/**
 * Builds the front door that drives a run from inside the supervisor DO's
 * `alarm()` invocation (M2.5 step 4). The DO receives the full Worker `Env` at
 * runtime, so the default lazily imports `createFrontDoorFromEnv` and constructs
 * the production front door from its own bindings. Overridable for tests so the
 * async-contract behavior can be exercised without a live Sandbox/Artifacts.
 */
export type CapsuleSupervisorRunDriverFactory = (
  env: WorkflowCapsuleSupervisorEnv,
  supervisor: CloudflareWorkflowCapsuleSupervisor
) => Promise<WorkerFrontDoorContract> | WorkerFrontDoorContract;

let runDriverFactoryOverride: CapsuleSupervisorRunDriverFactory | undefined;

const defaultRunDriverFactory: CapsuleSupervisorRunDriverFactory = async (
  env,
  supervisor
) => {
  const { createFrontDoorFromEnv } =
    await import("./cloudflare-worker-route.ts");

  return createFrontDoorFromEnv(env, {
    contextCapsulesOverride: createInProcessCapsuleSupervisorClient(supervisor),
  });
};

export const __capsuleSupervisorTestHooks = {
  resetRunDriverFactory(): void {
    runDriverFactoryOverride = undefined;
  },
  setRunDriverFactory(factory: CapsuleSupervisorRunDriverFactory): void {
    runDriverFactoryOverride = factory;
  },
};

const TimeoutMsSchema = z.coerce.number().int().min(1);

const SupervisorRecordSchema = z.object({
  // Active lanes carry their owning `runId` so the reaper can release only the
  // lanes of the runs it reaped (FIX 2). The DO is keyed by `workItemId`, so
  // concurrent runs share this record; a bare lane list would let reaping one
  // run nuke a healthy concurrent run's slots. External admission/release
  // contracts still surface a flat `activeLaneIds: string[]` (the record keys).
  activeLaneOwners: z.record(z.string().min(1), z.string().min(1)).default({}),
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

/**
 * Flat list of currently-active lane ids, derived from the owner map. The
 * external admission/release contracts speak in bare lane-id arrays; this is the
 * single place the owner map is projected back to that shape.
 */
const activeLaneIdsOf = (record: SupervisorRecord): string[] =>
  Object.keys(record.activeLaneOwners);

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

/**
 * Storage key for a queued run-start (M2.5 step 4). `POST /start-run` parks the
 * full run request here and arms an immediate alarm; the alarm driver lists this
 * prefix, starts each pending run in a fresh DO invocation, then deletes the key
 * so a re-fired alarm does not re-submit a run already in flight.
 */
const runStartStorageKey = (runId: string): string => `run-start:${runId}`;

const runStartStoragePrefix = "run-start:";

const driveLedgerStorageKey = (runId: string): string =>
  `drive-ledger:${runId}`;

/** Order durability ledger projections by execution order (node index). */
const byNodeIndex = (
  left: { readonly nodeIndex: number },
  right: { readonly nodeIndex: number }
): number => left.nodeIndex - right.nodeIndex;

/**
 * Storage key for the short-lived "driving" marker of a run (FIX 1). Holds the
 * timestamp the current driver started. A drive begins only when no marker
 * exists or the existing one is stale (older than `WORKFLOW_APP_TIMEOUT_MS` — the
 * prior driver was evicted). Set before driving, cleared on terminal completion.
 * Prevents two alarms from driving the SAME run concurrently while still letting
 * an evicted run (stale marker) be re-driven by the next alarm.
 */
const drivingMarkerStorageKey = (runId: string): string => `driving:${runId}`;

const DrivingMarkerSchema = z.object({
  driveGeneration: z.number().int().min(0).optional(),
  startedAtMs: z.number().int().min(0),
});

/**
 * Storage key for the reaper's own due time (the cheap note). `startRun`'s
 * immediate drive alarm would otherwise clobber the pending reaper alarm and let
 * the sweep deadline drift per enqueue; tracking the deadline separately lets the
 * alarm be set to `min(now-drive, reaperDueAt)` so a drive never indefinitely
 * defers the reaper.
 */
const REAPER_DUE_AT_STORAGE_KEY = "reaper-due-at";

const ReaperDueAtSchema = z.number().int().min(0);

const StallRunProjectionRowSchema = z.object({
  actor_id: z.string().min(1),
  capsule_id: z.string().min(1),
  event_index: z.number().int().min(0).nullable(),
  run_id: z.string().min(1),
  status: SafetyEnvelopeStateSchema,
  work_item_id: z.string().min(1),
});

const EventIndexRowSchema = z.object({
  event_index: z.number().int().min(0).nullable(),
});

const D1RunResultSchema = z.object({
  success: z.boolean().optional(),
});

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

const appendUnique = (
  laneIds: readonly string[],
  laneIdToAppend: string
): string[] =>
  laneIds.includes(laneIdToAppend)
    ? [...laneIds]
    : [...laneIds, laneIdToAppend];

/**
 * Outcome of driving one run for a single alarm (single-step drive).
 * - `terminal`: the run reached captured/blocked. Retire its run-start record.
 * - `paused`: exactly one dynamic node ran and its checkpoint is durable, more
 *   remain. Keep the run-start record and re-arm `alarm(now)` so the next alarm
 *   advances the next node at work-speed with no dead gap.
 * - `failed`: the drive threw (e.g. transient adapter failure, or a node that
 *   hung past the invocation budget). Keep the record; the watchdog/reaper
 *   backstop re-drives or sweeps it.
 */
type DriveOutcome = "failed" | "paused" | "stale" | "terminal";

interface DriveFailureRecorder {
  recordFailure(error: unknown): Promise<void>;
}

/**
 * Delay before a paused single-step drive's next node fires (the resume re-arm).
 * Small enough that nodes flow at near work-speed, but STRICTLY POSITIVE because
 * of two workerd alarm semantics that a now/past alarm trips over:
 *
 *   1. Inside an alarm handler, the firing alarm is not deleted until the handler
 *      returns successfully, so `getAlarm()` still reports the firing time
 *      `T_fired <= now`. `armAlarmAt` only ever LOWERS the alarm, so both
 *      `armAlarmAt(now)` and `armAlarmAt(now + delta)` see that phantom earlier
 *      time and set nothing — the run stalls after one node (observed live as run
 *      11's 1-node regress). The resume re-arm must therefore set the alarm
 *      UNCONDITIONALLY (see `armResumeAlarm`), not through the lowering guard.
 *   2. A `setAlarm(now)` / past-time alarm set from within a handler does not
 *      reliably re-fire in live workerd; a strictly-future time is the canonical
 *      self-reschedule that does.
 */
const RESUME_DELAY_MS = 250;

const DRIVE_FAILURE_MESSAGE_MAX_LENGTH = 240;

const SECRET_ASSIGNMENT_PATTERN =
  /\b(token|secret|password|passwd|bearer|authorization|api[_-]?key)\b\s*[:=]\s*["']?[^,\s"']+/giu;
const URL_PATTERN = /https?:\/\/\S+/giu;
const ARTIFACT_REF_PATTERN = /artifact:\/\/\S+/giu;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const ABSOLUTE_PATH_PATTERN =
  /(?:[A-Za-z]:)?\/(?:[^\s"'`,:;(){}[\]]+\/)+[^\s"'`,:;(){}[\]]*/gu;
const TOKENISH_PATTERN = /\b[A-Za-z0-9_-]{32,}\b/gu;

const redactedDriveFailureMessage = (error: unknown): string => {
  const raw =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : `Error: ${String(error)}`;
  const scrubbed = raw
    .replace(SECRET_ASSIGNMENT_PATTERN, "$1=[redacted-secret]")
    .replace(URL_PATTERN, "[redacted-url]")
    .replace(ARTIFACT_REF_PATTERN, "[redacted-artifact-ref]")
    .replace(EMAIL_PATTERN, "[redacted-email]")
    .replace(ABSOLUTE_PATH_PATTERN, "[redacted-path]")
    .replace(TOKENISH_PATTERN, "[redacted-token]")
    .replaceAll(/\s+/gu, " ")
    .trim();
  const message =
    scrubbed.length === 0 ? "Error: redacted drive failure." : scrubbed;

  return message.length <= DRIVE_FAILURE_MESSAGE_MAX_LENGTH
    ? message
    : `${message.slice(0, DRIVE_FAILURE_MESSAGE_MAX_LENGTH - 3)}...`;
};

const emptyDriveLedger = (input: {
  readonly runId: string;
  readonly workItemId: string;
}): WorkflowDriveLedger =>
  WorkflowDriveLedgerSchema.parse({
    driveGeneration: 0,
    lastWorkMutationGeneration: 0,
    phases: {},
    runId: input.runId,
    schemaVersion: "workflow.drive-ledger.v1",
    updatedAt: nowIso(),
    workItemId: input.workItemId,
  });

const withWorkMutationGeneration = (
  ledger: WorkflowDriveLedger,
  driveGeneration: number,
  updatedAt: string
): WorkflowDriveLedger =>
  WorkflowDriveLedgerSchema.parse({
    ...ledger,
    lastWorkMutationGeneration: driveGeneration,
    updatedAt,
  });

const ledgerHasRecordedWorkMutation = (ledger: WorkflowDriveLedger): boolean =>
  Object.keys(ledger.laneDispatches).length > 0 ||
  Object.keys(ledger.laneStatuses).length > 0 ||
  Object.keys(ledger.nodeAttempts).length > 0 ||
  Object.keys(ledger.phases).length > 0;

const seedUnknownWorkMutationGeneration = (
  ledger: WorkflowDriveLedger
): WorkflowDriveLedger =>
  ledger.lastWorkMutationGeneration === undefined
    ? WorkflowDriveLedgerSchema.parse({
        ...ledger,
        lastWorkMutationGeneration: ledgerHasRecordedWorkMutation(ledger)
          ? ledger.driveGeneration
          : 0,
      })
    : ledger;

const stalledGenerationsFor = (ledger: WorkflowDriveLedger): number =>
  ledger.driveGeneration -
  (ledger.lastWorkMutationGeneration ?? ledger.driveGeneration);

const staleDriveGeneration = (input: {
  readonly currentGeneration: number;
  readonly driveGeneration: number;
  readonly runId: string;
  readonly workItemId: string;
}): StaleDriveGenerationError =>
  new StaleDriveGenerationError(
    StaleDriveGenerationRejectionSchema.parse({
      code: "stale_drive_generation",
      currentGeneration: input.currentGeneration,
      driveGeneration: input.driveGeneration,
      message: `Drive generation ${input.driveGeneration} is stale for run ${input.runId}; current generation is ${input.currentGeneration}.`,
      redacted: true,
      runId: input.runId,
      workItemId: input.workItemId,
    })
  );

/**
 * Drive one queued run through the front door from inside the alarm invocation,
 * in single-step mode: `WorkflowApp.run()` resumes from the latest checkpoint and
 * executes EXACTLY ONE not-yet-completed dynamic node, then either pauses (more
 * nodes remain) or reaches a terminal status (the last node ran and the finishing
 * envelope completed). A `paused` result keeps the run advancing one node per
 * alarm with a fresh wall-clock budget per node, so a hung node is isolated to
 * its own invocation and a healthy run's checkpoint stays fresh (the reaper never
 * sweeps it). Swallows and logs a throw so one failed run does not abort driving
 * the rest of the queue.
 */
const driveOneQueuedRun = async (
  frontDoor: WorkerFrontDoorContract,
  request: WorkflowRunRequest,
  driveGeneration: number,
  failureRecorder: DriveFailureRecorder
): Promise<DriveOutcome> => {
  try {
    // Single-step drive: resume from the latest checkpoint and execute EXACTLY
    // ONE not-yet-completed dynamic node, then pause (more remain) or reach a
    // terminal status (the last node ran + the finishing envelope completed).
    // Each node gets its own fresh wall-clock budget, so a heavy real-data
    // retrieval node (search/hydrate/correlate over the live JoelClaw index) no
    // longer races the reaper inside a shared whole-run invocation — the failure
    // mode that reaped run 14 at node 3. The paused path (driveQueuedRuns) re-arms
    // an imminent future alarm so the next node fires at work-speed.
    const result = await frontDoor.startRun(request, {
      driveGeneration,
      driveMode: "single-step",
    });

    return result.status === "paused" ? "paused" : "terminal";
  } catch (error) {
    if (error instanceof StaleDriveGenerationError) {
      return "stale";
    }

    console.error("queued run driver failed", request.runId, error);
    try {
      await failureRecorder.recordFailure(error);
    } catch {
      // Best-effort observability: this write is fenced, and if a newer drive
      // already owns the generation, losing the failure breadcrumb must not mask
      // the original failure or change the "failed" outcome.
    }

    return "failed";
  }
};

export class CloudflareWorkflowCapsuleSupervisor extends DurableObject<WorkflowCapsuleSupervisorEnv> {
  /**
   * True when a single-step drive paused during the CURRENT alarm() handler and
   * already armed an imminent resume alarm (now + RESUME_DELAY_MS). The
   * end-of-handler reaper re-arm reads this to avoid clobbering that strictly-
   * earlier resume with the later eviction watchdog, which would stall the walk
   * after exactly one node. Reset at the top of every alarm().
   */
  private drivePausedThisAlarm = false;

  override fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    const postRoutes: Record<string, () => Promise<Response>> = {
      "/admit-drive": () => this.admitDrive(request),
      "/admit-lane": () => this.admitLane(request),
      "/append-event": () => this.appendEvent(request),
      "/assert-drive-generation": () => this.assertDriveGeneration(request),
      "/get-durability": () => this.getDurability(request),
      "/load-drive-ledger": () => this.loadDriveLedger(request),
      "/load-latest-checkpoint": () => this.loadLatestCheckpoint(request),
      "/persist-checkpoint": () => this.persistCheckpoint(request),
      "/record-drive-lane-dispatch": () =>
        this.recordDriveLaneDispatch(request),
      "/record-drive-lane-status": () => this.recordDriveLaneStatus(request),
      "/record-drive-node-attempt": () => this.recordDriveNodeAttempt(request),
      "/record-drive-phase": () => this.recordDrivePhase(request),
      "/release-lane": () => this.releaseLane(request),
      "/resolve": () => this.resolveCapsule(request),
      "/start-run": () => this.startRun(request),
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

  private async getDriveLedger(input: {
    readonly runId: string;
    readonly workItemId: string;
  }): Promise<WorkflowDriveLedger> {
    return WorkflowDriveLedgerSchema.parse(
      (await this.ctx.storage.get(driveLedgerStorageKey(input.runId))) ??
        emptyDriveLedger(input)
    );
  }

  private async putDriveLedger(
    ledger: WorkflowDriveLedger
  ): Promise<WorkflowDriveLedger> {
    const parsed = WorkflowDriveLedgerSchema.parse(ledger);
    await this.ctx.storage.put(driveLedgerStorageKey(parsed.runId), parsed);

    return parsed;
  }

  private async latestCheckpointForRun(
    runId: string
  ): Promise<RunStepCheckpoint | null> {
    const stored = await this.ctx.storage.list({
      prefix: checkpointStoragePrefix(runId),
    });
    let latest: RunStepCheckpoint | null = null;
    for (const value of stored.values()) {
      const checkpoint = RunStepCheckpointSchema.parse(value);
      if (latest === null || checkpoint.stepIndex > latest.stepIndex) {
        latest = checkpoint;
      }
    }

    return latest;
  }

  private async nextStepIndexGuess(runId: string): Promise<number> {
    const latest = await this.latestCheckpointForRun(runId);

    return latest === null ? 0 : latest.stepIndex + 1;
  }

  private async recordLastDriveFailure(input: {
    readonly driveGeneration: number;
    readonly error: unknown;
    readonly runId: string;
    readonly stepIndexGuess: number;
    readonly workItemId: string;
  }): Promise<void> {
    const failure = WorkflowDriveFailureRecordRequestSchema.parse({
      driveGeneration: input.driveGeneration,
      failure: {
        message: redactedDriveFailureMessage(input.error),
        stepIndexGuess: input.stepIndexGuess,
      },
      runId: input.runId,
      workItemId: input.workItemId,
    });
    await this.assertActiveGeneration(failure);
    const current = await this.getDriveLedger(failure);
    const at = nowIso();
    await this.putDriveLedger({
      ...current,
      lastDriveFailure: WorkflowDriveFailureSchema.parse({
        ...failure.failure,
        at,
        driveGeneration: failure.driveGeneration,
      }),
      updatedAt: at,
    });
  }

  private async nextEventIndexForRun(runId: string): Promise<number> {
    const d1 = this.env.WORKFLOW_APP_D1;
    if (d1 === undefined) {
      return 1;
    }
    const result = await d1
      .prepare(
        `select max(event_index) as event_index
         from workflow_events
         where run_id = ?`
      )
      .bind(runId)
      .all();
    const row = EventIndexRowSchema.parse(
      result.results?.[0] ?? { event_index: null }
    );

    return (row.event_index ?? 0) + 1;
  }

  private async readRunProjectionForStall(runId: string): Promise<null | {
    readonly actorId: string;
    readonly capsuleId: string;
    readonly status: SafetyEnvelopeState;
    readonly workItemId: string;
  }> {
    const d1 = this.env.WORKFLOW_APP_D1;
    if (d1 === undefined) {
      return null;
    }
    const result = await d1
      .prepare(
        `select
           runs.run_id as run_id,
           runs.work_item_id as work_item_id,
           runs.capsule_id as capsule_id,
           runs.actor_id as actor_id,
           runs.status as status,
           (select max(event_index) from workflow_events where workflow_events.run_id = runs.run_id) as event_index
         from runs
         where runs.run_id = ?
         limit 1`
      )
      .bind(runId)
      .all();
    const first = result.results?.[0];
    if (first === undefined) {
      return null;
    }
    const row = StallRunProjectionRowSchema.parse(first);

    return {
      actorId: row.actor_id,
      capsuleId: row.capsule_id,
      status: row.status,
      workItemId: row.work_item_id,
    };
  }

  private static async assertD1Write(
    statement: ReturnType<
      NonNullable<WorkflowCapsuleSupervisorEnv["WORKFLOW_APP_D1"]>["prepare"]
    >,
    summary: string
  ): Promise<void> {
    const result = D1RunResultSchema.parse(await statement.run());
    if (result.success === false) {
      throw new Error(summary);
    }
  }

  private async blockStalledRun(input: {
    readonly ledger: WorkflowDriveLedger;
    readonly request: WorkflowRunRequest;
    readonly stallGenerations: number;
  }): Promise<boolean> {
    const d1 = this.env.WORKFLOW_APP_D1;
    if (d1 === undefined) {
      return false;
    }
    const row = await this.readRunProjectionForStall(input.request.runId);
    if (row !== null && TERMINAL_RUN_STATES.has(row.status)) {
      return true;
    }

    const now = nowIso();
    const message = `wedged: ${input.stallGenerations} consecutive drives advanced no ledger work`;
    const actorId = row?.actorId ?? input.request.actor.id;
    const capsuleId = row?.capsuleId ?? `capsule:${input.request.workItemId}`;
    const workItemId = row?.workItemId ?? input.request.workItemId;
    const nextEventIndex = await this.nextEventIndexForRun(input.request.runId);
    const lastWorkMutationGeneration =
      input.ledger.lastWorkMutationGeneration ?? input.ledger.driveGeneration;

    await CloudflareWorkflowCapsuleSupervisor.assertD1Write(
      d1
        .prepare(
          `insert into runs (run_id, work_item_id, capsule_id, actor_id, status, plan_ref, plan_hash, blocker_code, blocker_message, blocker_step_id, blocker_node_type, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           on conflict(run_id) do update set
             work_item_id = excluded.work_item_id,
             capsule_id = excluded.capsule_id,
             actor_id = excluded.actor_id,
             status = excluded.status,
             plan_ref = coalesce(excluded.plan_ref, runs.plan_ref),
             plan_hash = coalesce(excluded.plan_hash, runs.plan_hash),
             blocker_code = excluded.blocker_code,
             blocker_message = excluded.blocker_message,
             blocker_step_id = excluded.blocker_step_id,
             blocker_node_type = excluded.blocker_node_type,
             updated_at = excluded.updated_at`
        )
        .bind(
          input.request.runId,
          workItemId,
          capsuleId,
          actorId,
          "blocked",
          null,
          null,
          "drive_stall_reaped",
          message,
          null,
          null,
          now
        ),
      "Stall-generation reaper run row could not be persisted."
    );
    await CloudflareWorkflowCapsuleSupervisor.assertD1Write(
      d1
        .prepare(
          `insert into workflow_events (run_id, event_index, work_item_id, capsule_id, actor_id, state, summary, refs_json, redacted, at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           on conflict(run_id, event_index) do update set
             work_item_id = excluded.work_item_id,
             capsule_id = excluded.capsule_id,
             actor_id = excluded.actor_id,
             state = excluded.state,
             summary = excluded.summary,
             refs_json = excluded.refs_json,
             redacted = excluded.redacted,
             at = excluded.at`
        )
        .bind(
          input.request.runId,
          nextEventIndex,
          workItemId,
          capsuleId,
          actorId,
          "blocked",
          "Run blocked by stall-generation reaper.",
          JSON.stringify({
            driveGeneration: String(input.ledger.driveGeneration),
            lastWorkMutationGeneration: String(lastWorkMutationGeneration),
            maxStallGenerations: String(MAX_STALL_GENERATIONS),
            reaperReason: "drive-stall-generations",
            stallGenerations: String(input.stallGenerations),
          }),
          1,
          now
        ),
      "Stall-generation reaper event row could not be persisted."
    );

    return true;
  }

  private async assertActiveGeneration(input: {
    readonly driveGeneration: number;
    readonly runId: string;
    readonly workItemId: string;
  }): Promise<void> {
    const ledger = await this.getDriveLedger(input);
    if (ledger.driveGeneration !== input.driveGeneration) {
      throw staleDriveGeneration({
        currentGeneration: ledger.driveGeneration,
        driveGeneration: input.driveGeneration,
        runId: input.runId,
        workItemId: input.workItemId,
      });
    }
  }

  private async admitDrive(request: Request): Promise<Response> {
    const input = WorkflowDriveLedgerRequestSchema.parse(await request.json());

    return json(await this.admitDriveCore(input));
  }

  private async admitDriveCore(input: {
    readonly runId: string;
    readonly workItemId: string;
  }): Promise<WorkflowDriveAdmission> {
    const admission = await this.admitDriveForRun(input);

    return WorkflowDriveAdmissionSchema.parse({
      driveGeneration: admission.driveGeneration,
      ledger: admission.ledger,
      runId: input.runId,
      workItemId: input.workItemId,
    });
  }

  private async assertDriveGeneration(request: Request): Promise<Response> {
    const input = WorkflowDriveGenerationAssertionRequestSchema.parse(
      await request.json()
    );
    try {
      await this.assertActiveDriveGenerationCore(input);
    } catch (error) {
      if (error instanceof StaleDriveGenerationError) {
        return json(error.rejection, { status: 409 });
      }

      throw error;
    }

    return json({ ok: true });
  }

  private async assertActiveDriveGenerationCore(input: {
    readonly driveGeneration: number;
    readonly runId: string;
    readonly workItemId: string;
  }): Promise<void> {
    await this.assertActiveGeneration(input);
  }

  private async loadDriveLedger(request: Request): Promise<Response> {
    const input = WorkflowDriveLedgerRequestSchema.parse(await request.json());

    return json(await this.loadDriveLedgerCore(input));
  }

  private async loadDriveLedgerCore(input: {
    readonly runId: string;
    readonly workItemId: string;
  }): Promise<WorkflowDriveLedger> {
    return await this.getDriveLedger(input);
  }

  private async recordDrivePhase(request: Request): Promise<Response> {
    const input = WorkflowDriveLedgerPhaseCompletionRequestSchema.parse(
      await request.json()
    );
    try {
      return json(await this.recordDrivePhaseCompletionCore(input));
    } catch (error) {
      if (error instanceof StaleDriveGenerationError) {
        return json(error.rejection, { status: 409 });
      }

      throw error;
    }
  }

  private async recordDrivePhaseCompletionCore(
    input: z.infer<typeof WorkflowDriveLedgerPhaseCompletionRequestSchema>
  ): Promise<WorkflowDriveLedger> {
    await this.assertActiveGeneration(input);
    const current = await this.getDriveLedger(input);
    const completedAt = nowIso();
    const phase = {
      ...input.phase,
      completedAt,
      driveGeneration: input.driveGeneration,
    };

    return await this.putDriveLedger({
      ...withWorkMutationGeneration(
        current,
        input.driveGeneration,
        completedAt
      ),
      phases: {
        ...current.phases,
        [phase.phaseId]: phase,
      },
    });
  }

  private async recordDriveNodeAttempt(request: Request): Promise<Response> {
    const input = WorkflowDriveNodeAttemptRecordRequestSchema.parse(
      await request.json()
    );
    try {
      return json(await this.recordDriveNodeAttemptCore(input));
    } catch (error) {
      if (error instanceof StaleDriveGenerationError) {
        return json(error.rejection, { status: 409 });
      }

      throw error;
    }
  }

  private async recordDriveNodeAttemptCore(
    input: z.infer<typeof WorkflowDriveNodeAttemptRecordRequestSchema>
  ): Promise<WorkflowDriveNodeAttempt> {
    await this.assertActiveGeneration(input);

    const current = await this.getDriveLedger(input);
    const nodeAttemptKey = String(input.nodeIndex);
    const existing = current.nodeAttempts[nodeAttemptKey];
    const attemptedAt = nowIso();
    const attempt: WorkflowDriveNodeAttempt =
      WorkflowDriveNodeAttemptSchema.parse({
        attemptCount: (existing?.attemptCount ?? 0) + 1,
        firstAttemptedAt: existing?.firstAttemptedAt ?? attemptedAt,
        lastAttemptedAt: attemptedAt,
        lastDriveGeneration: input.driveGeneration,
        nodeIndex: input.nodeIndex,
        ...(input.nodeType === undefined ? {} : { nodeType: input.nodeType }),
        stepId: input.stepId,
      });

    await this.putDriveLedger({
      ...withWorkMutationGeneration(
        current,
        input.driveGeneration,
        attemptedAt
      ),
      nodeAttempts: {
        ...current.nodeAttempts,
        [nodeAttemptKey]: attempt,
      },
    });

    return attempt;
  }

  private async recordDriveLaneDispatch(request: Request): Promise<Response> {
    const input = WorkflowDriveLaneDispatchRecordRequestSchema.parse(
      await request.json()
    );
    try {
      return json(await this.recordDriveLaneDispatchCore(input));
    } catch (error) {
      if (error instanceof StaleDriveGenerationError) {
        return json(error.rejection, { status: 409 });
      }

      throw error;
    }
  }

  private async recordDriveLaneDispatchCore(
    input: z.infer<typeof WorkflowDriveLaneDispatchRecordRequestSchema>
  ): Promise<WorkflowDriveLedger> {
    await this.assertActiveGeneration({
      driveGeneration: input.driveGeneration,
      runId: input.dispatch.runId,
      workItemId: input.dispatch.workItemId,
    });

    const current = await this.getDriveLedger(input.dispatch);
    const { dispatch } = input;

    return await this.putDriveLedger({
      ...withWorkMutationGeneration(
        current,
        input.driveGeneration,
        dispatch.dispatchedAt
      ),
      laneDispatches: {
        ...current.laneDispatches,
        [dispatch.dispatchKey]: dispatch,
      },
    });
  }

  private async recordDriveLaneStatus(request: Request): Promise<Response> {
    const input = WorkflowDriveLaneStatusRecordRequestSchema.parse(
      await request.json()
    );
    try {
      return json(await this.recordDriveLaneStatusCore(input));
    } catch (error) {
      if (error instanceof StaleDriveGenerationError) {
        return json(error.rejection, { status: 409 });
      }

      throw error;
    }
  }

  private async recordDriveLaneStatusCore(
    input: z.infer<typeof WorkflowDriveLaneStatusRecordRequestSchema>
  ): Promise<WorkflowDriveLedger> {
    await this.assertActiveGeneration({
      driveGeneration: input.driveGeneration,
      runId: input.statusReceipt.runId,
      workItemId: input.statusReceipt.workItemId,
    });

    const current = await this.getDriveLedger(input.statusReceipt);
    const { statusReceipt } = input;

    return await this.putDriveLedger({
      ...withWorkMutationGeneration(
        current,
        input.driveGeneration,
        statusReceipt.checkedAt
      ),
      laneStatuses: {
        ...current.laneStatuses,
        [statusReceipt.dispatchKey]: statusReceipt,
      },
    });
  }

  private async admitLane(request: Request): Promise<Response> {
    const input = AgentLaneAdmissionRequestSchema.parse(await request.json());

    return json(await this.admitLaneCore(input));
  }

  private async admitLaneCore(
    input: z.infer<typeof AgentLaneAdmissionRequestSchema>
  ): Promise<AgentLaneAdmissionDecision> {
    let record = await this.getRecord();
    let activeLaneIds = activeLaneIdsOf(record);

    if (record.completedLaneIds.includes(input.laneId)) {
      const releaseCommitSha =
        record.laneReleases[input.laneId]?.artifactCommitSha;
      return AgentLaneAdmissionDecisionSchema.parse({
        ...(releaseCommitSha === undefined
          ? {}
          : { artifactCommitSha: releaseCommitSha }),
        kind: input.kind,
        laneId: input.laneId,
        runId: input.runId,
        status: "already-completed",
        workItemId: input.workItemId,
      });
    }

    const currentOwner = record.activeLaneOwners[input.laneId];
    if (currentOwner !== undefined) {
      // Wound #22: reclaim our OWN orphaned reservation. The zombie-budget
      // pre-admit (wound #16) reserves this lane's OWNER slot before dispatch; a
      // drive torn after that reservation but before it persists a lane
      // dispatch/release leaves the slot held with no live process behind it.
      // Lane ids are run-scoped (`lane:<kind>:<runId>...`), so the owner can only
      // ever be THIS run — an "already-active" collision is never cross-run
      // contention, only the run colliding with its own zombie from a dead prior
      // drive generation. The drive-generation fence plus the stall-generation
      // reaper guarantee that prior drive is gone before this admission runs (a
      // new generation is armed only once the previous driving marker goes
      // stale), so the run's next drive must be able to RECLAIM the slot rather
      // than be deferred against itself — the deferral was converted into a
      // terminal `adapter_unavailable` and killed every re-drive's recovery.
      // Re-admit idempotently (the owner mapping already names this run); keep
      // the reaper armed so the reclaimed lane stays watched.
      if (currentOwner === input.runId) {
        await this.ensureReaperAlarm();

        return AgentLaneAdmissionDecisionSchema.parse({
          activeLaneIds,
          admissionId: `admission:${input.runId}:${input.laneId}:${crypto.randomUUID()}`,
          admittedAt: nowIso(),
          kind: input.kind,
          laneId: input.laneId,
          maxActiveLanes: input.maxActiveLanes,
          runId: input.runId,
          status: "admitted",
          workItemId: input.workItemId,
        });
      }

      return AgentLaneAdmissionDecisionSchema.parse({
        activeLaneIds,
        kind: input.kind,
        laneId: input.laneId,
        maxActiveLanes: input.maxActiveLanes,
        reason: "already-active",
        retryAfterSeconds: 1,
        runId: input.runId,
        status: "deferred",
        workItemId: input.workItemId,
      });
    }

    if (activeLaneIds.length >= input.maxActiveLanes) {
      // Wound #24: before treating a full cap as backpressure, reclaim slots
      // whose owning run has already gone TERMINAL but was never released. The
      // reaper only frees slots for runs IT transitions
      // (releaseAdmissionSlotsAfterReap); a run that blocked/captured on its own —
      // or whose record was retired by driveQueuedRuns once D1 showed it terminal
      // — leaves its lane-owner slot squatting in `activeLaneOwners` with no live
      // process behind it. The DO is keyed by workItemId, so every dream run
      // shares ONE owner map and a cap of three; three such leaks jam the cap
      // permanently and every new run dies right here at planner admission with
      // `concurrency-cap-full`. Reclaim dead owners and re-check: only a cap full
      // of LIVE owners is genuine backpressure worth deferring.
      record = await this.reclaimTerminalOwnerSlots(record);
      activeLaneIds = activeLaneIdsOf(record);
    }

    if (activeLaneIds.length >= input.maxActiveLanes) {
      return AgentLaneAdmissionDecisionSchema.parse({
        activeLaneIds,
        kind: input.kind,
        laneId: input.laneId,
        maxActiveLanes: input.maxActiveLanes,
        reason: "concurrency-cap-full",
        retryAfterSeconds: 2,
        runId: input.runId,
        status: "deferred",
        workItemId: input.workItemId,
      });
    }

    const nextActiveLaneOwners = {
      ...record.activeLaneOwners,
      [input.laneId]: input.runId,
    };
    const nextRecord = SupervisorRecordSchema.parse({
      ...record,
      activeLaneOwners: nextActiveLaneOwners,
      maxObservedActiveLanes: Math.max(
        record.maxObservedActiveLanes,
        Object.keys(nextActiveLaneOwners).length
      ),
      workItemId: input.workItemId,
    });
    await this.putRecord(nextRecord);
    await this.ensureReaperAlarm();

    return AgentLaneAdmissionDecisionSchema.parse({
      activeLaneIds: Object.keys(nextActiveLaneOwners),
      admissionId: `admission:${input.runId}:${input.laneId}:${crypto.randomUUID()}`,
      admittedAt: nowIso(),
      kind: input.kind,
      laneId: input.laneId,
      maxActiveLanes: input.maxActiveLanes,
      runId: input.runId,
      status: "admitted",
      workItemId: input.workItemId,
    });
  }

  private async appendEvent(request: Request): Promise<Response> {
    const input = AppendCapsuleEventRequestSchema.parse(await request.json());

    await this.appendEventCore(input);

    return json({ ok: true });
  }

  private async appendEventCore(
    input: z.infer<typeof AppendCapsuleEventRequestSchema>
  ): Promise<void> {
    const record = await this.getRecord();
    await this.putRecord(
      SupervisorRecordSchema.parse({
        ...record,
        events: [...record.events, input.event],
        workItemId: input.workItemId,
      })
    );
  }

  /**
   * Enqueue a run for asynchronous, alarm-driven execution (M2.5 step 4). Parks
   * the full run request in DO storage and arms an immediate alarm, then returns
   * — the submitting `POST /runs` fetch returns 202 without ever driving the
   * run. The alarm (`driveQueuedRuns`) starts the run in a fresh DO invocation,
   * so the run never lives in a request fetch. Idempotent by `runId`: re-parking
   * the same run overwrites the same slot rather than queuing a duplicate.
   */
  private async startRun(request: Request): Promise<Response> {
    const input = StartRunRequestSchema.parse(await request.json());
    await this.ctx.storage.put(
      runStartStorageKey(input.request.runId),
      input.request
    );
    // Arm an immediate drive without clobbering a pending reaper deadline: set
    // the alarm to min(now, reaperDueAt) so the sweep deadline never drifts per
    // enqueue (the cheap note). The reaper's own due time is tracked separately.
    await this.armAlarmAt(Date.now());

    return json({ runId: input.request.runId, status: "accepted" });
  }

  /**
   * Persist a resumable run checkpoint to DO storage (M2.5 step 2). Overwrites
   * by `runId` + `stepIndex`, so re-persisting the same step is a stable no-op
   * that yields the same stored snapshot. Does not drive execution — only
   * durable state.
   */
  private async persistCheckpoint(request: Request): Promise<Response> {
    const input = PersistRunCheckpointRequestSchema.parse(await request.json());
    try {
      await this.persistCheckpointCore(input);
    } catch (error) {
      if (error instanceof StaleDriveGenerationError) {
        return json(error.rejection, { status: 409 });
      }

      throw error;
    }

    return json({ ok: true });
  }

  private async persistCheckpointCore(
    input: z.infer<typeof PersistRunCheckpointRequestSchema>
  ): Promise<void> {
    const checkpoint = RunStepCheckpointSchema.parse(input.checkpoint);
    if (input.driveGeneration !== undefined) {
      await this.assertActiveGeneration({
        driveGeneration: input.driveGeneration,
        runId: checkpoint.runId,
        workItemId: checkpoint.workItemId,
      });
    }
    await this.ctx.storage.put(
      checkpointStorageKey(checkpoint.runId, checkpoint.stepIndex),
      checkpoint
    );
    await this.clearDriveNodeAttemptsThrough({
      checkpointStepIndex: checkpoint.stepIndex,
      ...(input.driveGeneration === undefined
        ? {}
        : { driveGeneration: input.driveGeneration }),
      runId: checkpoint.runId,
      workItemId: checkpoint.workItemId,
    });
  }

  private async clearDriveNodeAttemptsThrough(input: {
    readonly checkpointStepIndex: number;
    readonly driveGeneration?: number;
    readonly runId: string;
    readonly workItemId: string;
  }): Promise<void> {
    const current = WorkflowDriveLedgerSchema.nullable().parse(
      (await this.ctx.storage.get(driveLedgerStorageKey(input.runId))) ?? null
    );
    if (current === null) {
      return;
    }

    const nodeAttempts = Object.fromEntries(
      Object.entries(current.nodeAttempts).filter(
        ([, attempt]) => attempt.nodeIndex > input.checkpointStepIndex
      )
    );
    const laneDispatches = Object.fromEntries(
      Object.entries(current.laneDispatches).filter(
        ([, dispatch]) => dispatch.nodeIndex > input.checkpointStepIndex
      )
    );
    const laneStatuses = Object.fromEntries(
      Object.entries(current.laneStatuses).filter(
        ([, statusReceipt]) =>
          statusReceipt.nodeIndex > input.checkpointStepIndex
      )
    );
    const checkpointAt = nowIso();
    if (
      input.driveGeneration === undefined &&
      Object.keys(nodeAttempts).length ===
        Object.keys(current.nodeAttempts).length &&
      Object.keys(laneDispatches).length ===
        Object.keys(current.laneDispatches).length &&
      Object.keys(laneStatuses).length ===
        Object.keys(current.laneStatuses).length
    ) {
      return;
    }

    await this.putDriveLedger({
      ...(input.driveGeneration === undefined
        ? { ...current, updatedAt: checkpointAt }
        : withWorkMutationGeneration(
            current,
            input.driveGeneration,
            checkpointAt
          )),
      laneDispatches,
      laneStatuses,
      nodeAttempts,
    });
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
    const latest = await this.loadLatestCheckpointCore(input);

    return json(
      LoadRunCheckpointResolutionSchema.parse({ checkpoint: latest })
    );
  }

  private async loadLatestCheckpointCore(
    input: z.infer<typeof LoadRunCheckpointRequestSchema>
  ): Promise<RunStepCheckpoint | null> {
    return await this.latestCheckpointForRun(input.runId);
  }

  private async getRecordResponse(): Promise<Response> {
    return json(await this.getRecord());
  }

  /**
   * Read-only durability dump for a single run (the monitor's durability view).
   * Projects this DO's storage — latest checkpoint, driving marker (with
   * staleness judged against the configured timeout), the reaper's tracked due
   * time, the current armed alarm, the run-start record presence, and how many
   * admission lanes this run still owns — into a redacted document. Never the raw
   * XState snapshot bodies (counts/keys only) and never mutates storage.
   */
  private async getDurability(request: Request): Promise<Response> {
    const input = RunDurabilityRequestSchema.parse(await request.json());
    const now = Date.now();
    const timeoutMs = this.resolveTimeoutMs();

    const stored = await this.ctx.storage.list({
      prefix: checkpointStoragePrefix(input.runId),
    });
    let latest: RunStepCheckpoint | null = null;
    for (const value of stored.values()) {
      const checkpoint = RunStepCheckpointSchema.parse(value);
      if (latest === null || checkpoint.stepIndex > latest.stepIndex) {
        latest = checkpoint;
      }
    }

    const marker = DrivingMarkerSchema.nullable().parse(
      (await this.ctx.storage.get(drivingMarkerStorageKey(input.runId))) ?? null
    );
    const reaperDueAtMs = ReaperDueAtSchema.nullable().parse(
      (await this.ctx.storage.get(REAPER_DUE_AT_STORAGE_KEY)) ?? null
    );
    const alarmAtMs = await this.ctx.storage.getAlarm();
    const hasRunStartRecord =
      (await this.ctx.storage.get(runStartStorageKey(input.runId))) !==
      undefined;
    const record = await this.getRecord();
    const activeLaneCount = Object.values(record.activeLaneOwners).filter(
      (runId) => runId === input.runId
    ).length;

    // Read the drive ledger so the dump can expose the zombie-node attempt
    // budget and the async-lane dispatch deadlines — the two pieces of state
    // that make a wedged run legible ("is the 3-attempt budget accumulating?",
    // "is a research.review poll past its deadline yet still not terminal?")
    // instead of leaving an observer to guess from the high-water checkpoint.
    const ledger = WorkflowDriveLedgerSchema.nullable().parse(
      (await this.ctx.storage.get(driveLedgerStorageKey(input.runId))) ?? null
    );
    const nodeAttempts = (
      ledger === null ? [] : Object.values(ledger.nodeAttempts)
    )
      .map((attempt) => ({
        attemptCount: attempt.attemptCount,
        firstAttemptedAt: attempt.firstAttemptedAt,
        lastAttemptedAt: attempt.lastAttemptedAt,
        lastDriveGeneration: attempt.lastDriveGeneration,
        nodeIndex: attempt.nodeIndex,
        nodeType: attempt.nodeType,
        stepId: attempt.stepId,
      }))
      .toSorted(byNodeIndex);
    const laneDispatches = (
      ledger === null ? [] : Object.values(ledger.laneDispatches)
    )
      .map((dispatch) => ({
        deadline: dispatch.deadline,
        dispatchKey: dispatch.dispatchKey,
        dispatchedAt: dispatch.dispatchedAt,
        kind: dispatch.kind,
        nodeIndex: dispatch.nodeIndex,
        nodeType: dispatch.nodeType,
        status: dispatch.status,
        stepId: dispatch.stepId,
      }))
      .toSorted(byNodeIndex);

    const dump: RunDurabilityDump = RunDurabilityDumpSchema.parse({
      activeLaneCount,
      alarmAtMs,
      checkpoint:
        latest === null
          ? null
          : {
              completedStepCount: latest.completedStepIds.length,
              completedStepIds: latest.completedStepIds,
              outputArtifactRefCount: latest.outputArtifactRefs.length,
              outputArtifactRefs: latest.outputArtifactRefs,
              persistedAt: latest.persistedAt,
              stepIndex: latest.stepIndex,
            },
      driveGeneration: ledger === null ? null : ledger.driveGeneration,
      drivingMarker:
        marker === null
          ? null
          : {
              stale:
                timeoutMs !== undefined &&
                now - marker.startedAtMs >= timeoutMs,
              startedAtMs: marker.startedAtMs,
            },
      generatedAt: nowIso(),
      hasRunStartRecord,
      laneDispatches,
      lastDriveFailure:
        ledger === null ? null : (ledger.lastDriveFailure ?? null),
      nodeAttempts,
      reaperDueAtMs,
      redacted: true,
      runId: input.runId,
      schemaVersion: "workflow.run-durability.v3",
      workItemId: input.workItemId,
    });

    return json(dump);
  }

  /**
   * Durable alarm. Two responsibilities share the single alarm slot:
   *
   * 1. Run driver (M2.5 step 4 + FIX 1) — drive any run parked by `/start-run`
   *    in this fresh DO invocation, so the run never executes inside the
   *    submitting request fetch. A run-start record is retained until the run
   *    reaches a terminal status, so a refired alarm re-drives an evicted run and
   *    `WorkflowApp.run()` resumes it from its latest checkpoint.
   * 2. Reaper — mark any run for this work item stuck in a non-terminal D1 state
   *    past the timeout as failed and release its leaked admission slots. Runs
   *    whose latest checkpoint is still fresh (forward progress within the
   *    timeout) are protected: a healthy resuming run is left to the driver, only
   *    a genuinely wedged run (stale checkpoint) is swept — exactly one owner per
   *    stuck run.
   *
   * No-op when nothing is queued and no run is stuck (idempotent re-fire) and
   * when D1/timeout are unbound. Re-arms the reaper alarm while admission slots
   * remain so a later crash is still swept.
   */
  override async alarm(): Promise<void> {
    const now = Date.now();
    this.drivePausedThisAlarm = false;

    // Arm a watchdog alarm BEFORE the drive, but only while a run-start record
    // is still queued (a non-terminal run that could be killed mid-drive).
    // driveQueuedRuns awaits one node to a paused/terminal status; the very first
    // dynamic node can be a multi-minute planning prologue that exceeds a single
    // invocation budget, so if workerd evicts/kills this invocation mid-node,
    // every line below — including the reaper re-arm at the end — never executes,
    // leaving the run orphaned with no future alarm to reap or re-drive it (the
    // run-14 dark-DO failure). Scheduling the watchdog first guarantees a later
    // alarm fires to resume the run from its latest checkpoint (fresh) or sweep
    // it (stale), so a killed drive is recovered rather than wedged forever.
    // Gating on queued records keeps an idle DO from re-arming forever. This MUST
    // be phantom-safe: see armReaperWatchdog — the firing alarm is still reported
    // by getAlarm() inside this handler, so the lowering armAlarmAt would set
    // nothing and leave the DO dark on eviction.
    const queuedBeforeDrive = await this.ctx.storage.list({
      prefix: runStartStoragePrefix,
    });
    if (queuedBeforeDrive.size > 0) {
      await this.armReaperWatchdog(now);
    }

    await this.driveQueuedRuns(now);

    const reaperContext = this.resolveReaperContext();
    if (reaperContext === undefined) {
      await this.rearmReaperAlarmIfSlotsRemain();

      return;
    }

    const record = await this.getRecord();
    if (record.workItemId !== undefined) {
      const { reapedRunIds } = await reapStuckRunsForWorkItem({
        d1: reaperContext.d1,
        protectedRunIds: await this.runsWithFreshCheckpoint(
          record.workItemId,
          reaperContext.timeoutMs,
          now
        ),
        timeoutMs: reaperContext.timeoutMs,
        workItemId: record.workItemId,
      });

      if (reapedRunIds.length > 0) {
        await this.releaseAdmissionSlotsAfterReap(record, reapedRunIds);
      }
    }

    // Wound #24 safety net: the reaper above only releases slots for runs IT just
    // transitioned, but a run can reach a terminal status without the reaper ever
    // touching it (self-block, or driveQueuedRuns retiring its record once D1 went
    // terminal). Sweep any owner whose run is already terminal so a cap jammed by
    // leaked owners drains here even when no admission is currently probing — the
    // periodic complement to the admission-time reclaim in admitLaneCore.
    await this.reclaimTerminalOwnerSlots(await this.getRecord());

    await this.rearmReaperAlarmIfSlotsRemain();
  }

  /**
   * Drive every run parked by `/start-run`, ONE dynamic node per alarm. Each
   * drive runs in single-step mode: `WorkflowApp.run()` resumes from the latest
   * checkpoint, executes exactly one not-yet-completed dynamic node, and either
   * pauses (more nodes remain) or reaches a terminal status (the last node ran and
   * the finishing envelope completed). The run-start record is kept until the run
   * reaches a TERMINAL status; on `paused` it is kept and `alarm(now)` is re-armed
   * so the next alarm immediately advances the next node — nodes flow at
   * work-speed with no dead gap, a hung node is isolated to its own invocation,
   * and a healthy run's checkpoint stays fresh so the reaper never sweeps it. A
   * refired alarm also re-drives an evicted run's record, resuming from its latest
   * checkpoint — the record is what makes resume reachable in production.
   *
   * Concurrency is guarded by a short-lived `driving:<runId>` marker carrying the
   * driver's start timestamp: a drive only begins when no marker exists or the
   * existing marker is stale (older than `WORKFLOW_APP_TIMEOUT_MS` — the previous
   * driver was evicted). A normal completion (terminal or paused) clears its own
   * marker, so two alarms never double-drive the same run; an evicted run leaves a
   * stale marker that the next alarm overrides to re-drive. Drives runs
   * sequentially so one fresh wall-clock budget is consumed at a time.
   */
  private async driveQueuedRuns(now: number): Promise<void> {
    const queued = await this.ctx.storage.list({
      prefix: runStartStoragePrefix,
    });
    if (queued.size === 0) {
      return;
    }

    const timeoutMs = this.resolveTimeoutMs();
    // Probe the authoritative run store so this loop can retire records for runs
    // that are already finished. The single supervisor DO is keyed by workItemId,
    // so EVERY run for a work item is parked here and driven from this one loop.
    // A drive that throws — e.g. a planner refusing to re-run an already-completed
    // lane on a run that is already `blocked` — returns "failed", which KEEPS the
    // run-start record; and the reaper marks a stuck run `blocked` in D1 but never
    // retires its record either. Both leave a poison record that is re-driven
    // every alarm, burning this handler's wall-clock budget and starving newer
    // runs parked behind it (the run-15 phantom-accept: a fresh run 202's but is
    // evicted before it is ever driven because older terminal records monopolize
    // the alarm). D1 already knows these runs are terminal, so drop their records
    // before spending a drive on them.
    const d1 = this.env.WORKFLOW_APP_D1;
    const statusReader =
      d1 === undefined
        ? undefined
        : createCloudflareWorkflowRunStatusReader({ d1 });
    // Built lazily on the first run that actually needs driving so a pure
    // poison-drain alarm never constructs a front door it won't use (and a flaky
    // Sandbox/Artifacts binding can't throw before the poison is retired).
    let frontDoor: WorkerFrontDoorContract | undefined;
    for (const value of queued.values()) {
      const request = WorkflowRunRequestSchema.parse(value);

      if (statusReader !== undefined) {
        const snapshot = await statusReader.read({ runId: request.runId });
        if (snapshot !== null && TERMINAL_RUN_STATES.has(snapshot.status)) {
          // Authoritative store says terminal (blocked/captured): nothing left to
          // advance. Retire the record (and any stale marker) so it stops
          // re-driving and the runs behind it get their turn.
          await this.ctx.storage.delete(runStartStorageKey(request.runId));
          await this.ctx.storage.delete(drivingMarkerStorageKey(request.runId));
          continue;
        }
      }

      if (await this.driverIsAlreadyRunning(request.runId, now, timeoutMs)) {
        continue;
      }

      const admission = await this.admitDriveForRun({ request });
      if (admission.status === "stalled") {
        await this.ctx.storage.delete(runStartStorageKey(request.runId));
        await this.ctx.storage.delete(drivingMarkerStorageKey(request.runId));
        await this.releaseAdmissionSlotsAfterReap(await this.getRecord(), [
          request.runId,
        ]);
        continue;
      }
      if (frontDoor === undefined) {
        const driver = runDriverFactoryOverride ?? defaultRunDriverFactory;
        frontDoor = await driver(this.env, this);
      }

      await this.ctx.storage.put(drivingMarkerStorageKey(request.runId), {
        driveGeneration: admission.driveGeneration,
        startedAtMs: now,
      });
      const outcome = await driveOneQueuedRun(
        frontDoor,
        request,
        admission.driveGeneration,
        {
          recordFailure: async (error) => {
            await this.recordLastDriveFailure({
              driveGeneration: admission.driveGeneration,
              error,
              runId: request.runId,
              stepIndexGuess: await this.nextStepIndexGuess(request.runId),
              workItemId: request.workItemId,
            });
          },
        }
      );
      if (outcome === "terminal") {
        // Terminal: retire both the run-start record and the marker. A future
        // alarm finds nothing to re-drive.
        await this.ctx.storage.delete(runStartStorageKey(request.runId));
      } else if (outcome === "stale") {
        await this.clearDrivingMarkerIfOwned(
          request.runId,
          admission.driveGeneration
        );
        continue;
      } else if (outcome === "paused") {
        // Single-step drive paused after one node: KEEP the run-start record so
        // the next alarm resumes from the just-persisted checkpoint, and re-arm a
        // strictly-future alarm so that next node fires at work-speed with no dead
        // gap. Uses armResumeAlarm (unconditional future set), NOT armAlarmAt: the
        // firing alarm is still reported by getAlarm() inside this handler, and
        // armAlarmAt only lowers, so it would treat that phantom as an earlier
        // alarm and re-arm nothing — stalling after one node. The marker clears
        // below so the imminent re-drive is not blocked by a fresh marker.
        await this.armResumeAlarm(now);
        // Tell the end-of-handler reaper re-arm that an imminent resume is set,
        // so it does not clobber this strictly-earlier alarm with the far
        // eviction-watchdog deadline (which would stall the walk after one node).
        this.drivePausedThisAlarm = true;
      }
      // For terminal, paused, or a transient throw, clear our marker. On eviction
      // the invocation dies before reaching here, so the marker survives (stale)
      // and re-drive is gated by staleness rather than re-driven immediately.
      await this.clearDrivingMarkerIfOwned(
        request.runId,
        admission.driveGeneration
      );
    }
  }

  private async admitDriveForRun(
    input:
      | {
          readonly request: WorkflowRunRequest;
        }
      | {
          readonly runId: string;
          readonly workItemId: string;
        }
  ): Promise<
    | {
        readonly driveGeneration: number;
        readonly ledger: WorkflowDriveLedger;
        readonly status: "admitted";
      }
    | {
        readonly driveGeneration: number;
        readonly ledger: WorkflowDriveLedger;
        readonly stallGenerations: number;
        readonly status: "stalled";
      }
  > {
    const request = "request" in input ? input.request : undefined;
    const identity =
      "request" in input
        ? { runId: input.request.runId, workItemId: input.request.workItemId }
        : { runId: input.runId, workItemId: input.workItemId };
    const seeded = seedUnknownWorkMutationGeneration(
      await this.getDriveLedger(identity)
    );
    const stallGenerations = stalledGenerationsFor(seeded);
    if (
      request !== undefined &&
      stallGenerations >= MAX_STALL_GENERATIONS &&
      (await this.blockStalledRun({
        ledger: seeded,
        request,
        stallGenerations,
      }))
    ) {
      const ledger = await this.putDriveLedger({
        ...seeded,
        updatedAt: nowIso(),
      });

      return {
        driveGeneration: ledger.driveGeneration,
        ledger,
        stallGenerations,
        status: "stalled",
      };
    }

    const ledger = await this.putDriveLedger({
      ...seeded,
      driveGeneration: seeded.driveGeneration + 1,
      updatedAt: nowIso(),
    });

    return {
      driveGeneration: ledger.driveGeneration,
      ledger,
      status: "admitted",
    };
  }

  private async clearDrivingMarkerIfOwned(
    runId: string,
    driveGeneration: number
  ): Promise<void> {
    const marker = DrivingMarkerSchema.nullable().parse(
      (await this.ctx.storage.get(drivingMarkerStorageKey(runId))) ?? null
    );
    if (
      marker !== null &&
      marker.driveGeneration !== undefined &&
      marker.driveGeneration !== driveGeneration
    ) {
      return;
    }

    await this.ctx.storage.delete(drivingMarkerStorageKey(runId));
  }

  /**
   * True when a fresh `driving:<runId>` marker shows another driver is mid-flight
   * for this run, so this alarm must not double-drive it. A marker older than the
   * timeout means the prior driver was evicted; treat it as absent so the run is
   * re-driven. Without a bound timeout no staleness can be judged, so any existing
   * marker blocks (conservative).
   */
  private async driverIsAlreadyRunning(
    runId: string,
    now: number,
    timeoutMs: number | undefined
  ): Promise<boolean> {
    const marker = DrivingMarkerSchema.nullable().parse(
      (await this.ctx.storage.get(drivingMarkerStorageKey(runId))) ?? null
    );
    if (marker === null) {
      return false;
    }
    if (timeoutMs === undefined) {
      return true;
    }

    return now - marker.startedAtMs < timeoutMs;
  }

  /**
   * Run ids whose latest checkpoint was persisted within the timeout window —
   * proof of forward progress the reaper must not sweep (FIX 1, reaper-vs-resume
   * reconciliation). A run with no checkpoint, or only a stale one, is absent and
   * remains reapable.
   */
  private async runsWithFreshCheckpoint(
    workItemId: string,
    timeoutMs: number,
    now: number
  ): Promise<string[]> {
    const stored = await this.ctx.storage.list({ prefix: "checkpoint:" });
    const latestPersistedAtMs = new Map<string, number>();
    for (const value of stored.values()) {
      const checkpoint = RunStepCheckpointSchema.parse(value);
      if (checkpoint.workItemId !== workItemId) {
        continue;
      }
      const persistedAtMs = new Date(checkpoint.persistedAt).getTime();
      const previous = latestPersistedAtMs.get(checkpoint.runId);
      if (previous === undefined || persistedAtMs > previous) {
        latestPersistedAtMs.set(checkpoint.runId, persistedAtMs);
      }
    }

    const fresh: string[] = [];
    for (const [runId, persistedAtMs] of latestPersistedAtMs) {
      if (now - persistedAtMs < timeoutMs) {
        fresh.push(runId);
      }
    }

    return fresh;
  }

  /**
   * The configured run/step timeout, or `undefined` when unbound. Governs both
   * driving-marker staleness and reaper checkpoint staleness; unlike the reaper
   * context it does NOT require a D1 binding, so the driver can judge marker
   * staleness even where the reaper cannot run.
   */
  private resolveTimeoutMs(): number | undefined {
    const timeoutMs = TimeoutMsSchema.safeParse(
      this.env.WORKFLOW_APP_TIMEOUT_MS
    );

    return timeoutMs.success ? timeoutMs.data : undefined;
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
    const timeoutMs = this.resolveTimeoutMs();
    if (d1 === undefined || timeoutMs === undefined) {
      return undefined;
    }

    return { d1, timeoutMs };
  }

  /**
   * Release ONLY the admission slots whose owning run was reaped (FIX 2). The DO
   * is keyed by `workItemId`, so concurrent runs share `activeLaneOwners`;
   * releasing every lane would nuke a healthy concurrent run's slots. Lanes owned
   * by a reaped run are dropped from the active set and recorded as failed; every
   * other run's lanes stay active.
   */
  private async releaseAdmissionSlotsAfterReap(
    record: SupervisorRecord,
    reapedRunIds: readonly string[]
  ): Promise<void> {
    const reaped = new Set(reapedRunIds);
    const nextActiveLaneOwners: Record<string, string> = {};
    const reapedLaneIds: string[] = [];
    for (const [laneId, runId] of Object.entries(record.activeLaneOwners)) {
      if (reaped.has(runId)) {
        reapedLaneIds.push(laneId);
      } else {
        nextActiveLaneOwners[laneId] = runId;
      }
    }
    if (reapedLaneIds.length === 0) {
      return;
    }

    let { failedLaneIds } = record;
    for (const laneId of reapedLaneIds) {
      failedLaneIds = appendUnique(failedLaneIds, laneId);
    }
    await this.putRecord(
      SupervisorRecordSchema.parse({
        ...record,
        activeLaneOwners: nextActiveLaneOwners,
        failedLaneIds,
      })
    );
  }

  /**
   * Reclaim admission slots whose owning run has gone TERMINAL in the
   * authoritative run store but was never released (Wound #24 — the cap death
   * spiral). The reaper only frees slots for runs IT transitions
   * (releaseAdmissionSlotsAfterReap); two paths leak otherwise: a run that
   * reaches `blocked`/`captured` on its own never gets reaped, and
   * driveQueuedRuns retires a run's record the moment D1 shows it terminal —
   * neither path touches `activeLaneOwners`, so the dead run's lane-owner slot
   * squats forever with no live process behind it. The DO is keyed by
   * workItemId, so every dream run shares ONE owner map against a cap of three;
   * three such leaks jam the cap permanently and every new run dies at planner
   * admission with `concurrency-cap-full`.
   *
   * The reclaim is mechanism-agnostic: it does not care HOW the slot leaked, only
   * whether the owner is still alive. Dedupe the owner runIds, ask the status
   * reader for each, and drop ONLY owners whose snapshot is explicitly terminal
   * ({@link TERMINAL_RUN_STATES}). A `null` snapshot means the run has no
   * authoritative row yet (in-flight) — KEEP its slot; never free a slot on
   * absence of evidence (the alive run would lose its reservation mid-flight).
   * Returns the record unchanged when nothing is reclaimable, or when no D1
   * binding exists to judge terminality (the conservative no-op — better a stuck
   * cap than a wrongly-freed slot). Mirrors releaseAdmissionSlotsAfterReap:
   * reclaimed lanes are recorded in `failedLaneIds` (the force-released ledger).
   */
  private async reclaimTerminalOwnerSlots(
    record: SupervisorRecord
  ): Promise<SupervisorRecord> {
    const d1 = this.env.WORKFLOW_APP_D1;
    if (d1 === undefined) {
      return record;
    }
    const ownerRunIds = [...new Set(Object.values(record.activeLaneOwners))];
    if (ownerRunIds.length === 0) {
      return record;
    }

    const statusReader = createCloudflareWorkflowRunStatusReader({ d1 });
    const terminalRunIds = new Set<string>();
    for (const runId of ownerRunIds) {
      const snapshot = await statusReader.read({ runId });
      if (snapshot !== null && TERMINAL_RUN_STATES.has(snapshot.status)) {
        terminalRunIds.add(runId);
      }
    }
    if (terminalRunIds.size === 0) {
      return record;
    }

    const nextActiveLaneOwners: Record<string, string> = {};
    const reclaimedLaneIds: string[] = [];
    for (const [laneId, runId] of Object.entries(record.activeLaneOwners)) {
      if (terminalRunIds.has(runId)) {
        reclaimedLaneIds.push(laneId);
      } else {
        nextActiveLaneOwners[laneId] = runId;
      }
    }

    let { failedLaneIds } = record;
    for (const laneId of reclaimedLaneIds) {
      failedLaneIds = appendUnique(failedLaneIds, laneId);
    }
    const nextRecord = SupervisorRecordSchema.parse({
      ...record,
      activeLaneOwners: nextActiveLaneOwners,
      failedLaneIds,
    });
    await this.putRecord(nextRecord);

    return nextRecord;
  }

  /**
   * Record (and arm) the reaper's own due time. Tracked in storage separately
   * from the alarm slot so an immediate drive alarm set by `/start-run` never
   * clobbers the sweep deadline (the cheap note). Keeps the earliest pending due
   * time and arms the alarm no later than it.
   */
  private async ensureReaperAlarm(): Promise<void> {
    const reaperContext = this.resolveReaperContext();
    if (reaperContext === undefined) {
      return;
    }

    const fireAt = Date.now() + reaperContext.timeoutMs;
    const existing = ReaperDueAtSchema.nullable().parse(
      (await this.ctx.storage.get(REAPER_DUE_AT_STORAGE_KEY)) ?? null
    );
    const reaperDueAt = existing === null ? fireAt : Math.min(existing, fireAt);
    await this.ctx.storage.put(REAPER_DUE_AT_STORAGE_KEY, reaperDueAt);
    await this.armAlarmAt(reaperDueAt);
  }

  /**
   * Set the durable alarm to `min(at, reaperDueAt, existingAlarm)`. A drive
   * (`at = now`) and the reaper deadline (`reaperDueAt`) thus share one slot
   * without either deferring the other: an immediate drive never pushes the sweep
   * out, and the sweep never delays a drive.
   */
  private async armAlarmAt(at: number): Promise<void> {
    const reaperDueAt = ReaperDueAtSchema.nullable().parse(
      (await this.ctx.storage.get(REAPER_DUE_AT_STORAGE_KEY)) ?? null
    );
    const fireAt = reaperDueAt === null ? at : Math.min(at, reaperDueAt);
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || existing > fireAt) {
      await this.ctx.storage.setAlarm(fireAt);
    }
  }

  /**
   * Re-arm the alarm for an IMMINENT single-step resume (the paused path).
   * UNCONDITIONALLY sets the alarm to a strictly-future `now + RESUME_DELAY_MS`,
   * unlike `armAlarmAt` which only lowers an existing alarm.
   *
   * The unconditional future set is what makes single-step actually advance in
   * live workerd. Inside this alarm handler the firing alarm is not yet deleted,
   * so `getAlarm()` returns `T_fired <= now`; `armAlarmAt`'s lowering guard would
   * see that phantom earlier time and set nothing, leaving no future alarm once
   * the handler returns and workerd deletes the fired one — the run stalls after
   * exactly one node (run 11). A strictly-future `setAlarm` set during the handler
   * is retained and re-fires reliably (the canonical self-reschedule).
   *
   * The reaper deadline is not lost by moving the slot earlier: it lives in
   * `REAPER_DUE_AT_STORAGE_KEY` and `rearmReaperAlarmIfSlotsRemain` re-arms it at
   * the end of every alarm, and `armAlarmAt(reaperDueAt)` there won't raise this
   * sooner resume alarm (it only lowers), so both the imminent resume and the
   * eventual sweep are preserved.
   */
  private async armResumeAlarm(now: number): Promise<void> {
    await this.ctx.storage.setAlarm(now + RESUME_DELAY_MS);
  }

  /**
   * Arm the eviction watchdog from INSIDE an alarm() handler. Unlike
   * ensureReaperAlarm (which calls the lowering armAlarmAt), this UNCONDITIONALLY
   * `setAlarm`s a strictly-future deadline (`now + timeoutMs`, the start of the
   * re-drive window), so it survives the workerd phantom: during a handler the
   * firing alarm is not yet deleted, getAlarm() returns `T_fired <= now`, and a
   * lowering arm would see that phantom and set nothing — leaving the DO dark on
   * eviction (run 14). A strictly-future setAlarm during the handler is retained
   * and re-fires, so an evicted long node is recovered rather than wedged. The
   * tracked REAPER_DUE_AT deadline is kept at min(existing, fresh) so a sooner
   * pending sweep is never deferred, but a stale (<= now) phantom value is
   * replaced by the fresh future deadline rather than re-armed in the past.
   */
  private async armReaperWatchdog(now: number): Promise<void> {
    const reaperContext = this.resolveReaperContext();
    if (reaperContext === undefined) {
      return;
    }
    const fresh = now + reaperContext.timeoutMs;
    const existing = ReaperDueAtSchema.nullable().parse(
      (await this.ctx.storage.get(REAPER_DUE_AT_STORAGE_KEY)) ?? null
    );
    const reaperDueAt =
      existing === null || existing <= now ? fresh : Math.min(existing, fresh);
    await this.ctx.storage.put(REAPER_DUE_AT_STORAGE_KEY, reaperDueAt);
    await this.ctx.storage.setAlarm(reaperDueAt);
  }

  private async rearmReaperAlarmIfSlotsRemain(): Promise<void> {
    const record = await this.getRecord();
    const queued = await this.ctx.storage.list({
      prefix: runStartStoragePrefix,
    });
    if (activeLaneIdsOf(record).length === 0 && queued.size === 0) {
      // No active lanes AND no queued run-start records to drive: clear the
      // tracked deadline so a stale due time does not keep arming alarms after
      // everything has released. Queued records must keep the watchdog alive —
      // an evicted run that never returned paused still has a record to recover.
      await this.ctx.storage.delete(REAPER_DUE_AT_STORAGE_KEY);

      return;
    }
    if (this.drivePausedThisAlarm) {
      // A single-step drive paused this handler and already armed an imminent
      // resume (now + RESUME_DELAY_MS). Re-arming the far watchdog here would
      // clobber that strictly-earlier alarm and stall the walk after one node.
      // The resume fires first; the next handler re-evaluates the watchdog.
      return;
    }

    await this.armReaperWatchdog(Date.now());
  }

  private async releaseLane(request: Request): Promise<Response> {
    const input = AgentLaneReleaseRequestSchema.parse(await request.json());

    return json(await this.releaseLaneCore(input));
  }

  private async releaseLaneCore(
    input: z.infer<typeof AgentLaneReleaseRequestSchema>
  ): Promise<AgentLaneReleaseReceipt> {
    const record = await this.getRecord();
    const { [input.laneId]: _released, ...nextActiveLaneOwners } =
      record.activeLaneOwners;
    const activeLaneIds = Object.keys(nextActiveLaneOwners);
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
      activeLaneOwners: nextActiveLaneOwners,
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

    return AgentLaneReleaseReceiptSchema.parse({
      ...receipt,
      activeLaneIds,
    });
  }

  private async resolveCapsule(request: Request): Promise<Response> {
    const input = ResolveCapsuleRequestSchema.parse(await request.json());

    return json(await this.resolveCapsuleCore(input));
  }

  private async resolveCapsuleCore(
    input: z.infer<typeof ResolveCapsuleRequestSchema>
  ): Promise<ContextCapsuleRecord> {
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

    return capsule;
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
    if (response.status === 409) {
      throw new StaleDriveGenerationError(
        StaleDriveGenerationRejectionSchema.parse(await response.json())
      );
    }

    throw new Error(`Capsule supervisor request failed: ${path}`);
  }

  return await response.json();
};

export const createCloudflareCapsuleSupervisorClient = (
  namespace: DurableObjectNamespace<CloudflareWorkflowCapsuleSupervisor>
): CapsuleSupervisorPorts => {
  const stubFor = (workItemId: string): DurableObjectStub =>
    namespace.get(namespace.idFromName(workItemId));

  return {
    async admitDrive(input) {
      return WorkflowDriveAdmissionSchema.parse(
        await postJson(stubFor(input.workItemId), "/admit-drive", input)
      );
    },
    async admitLane(input): Promise<AgentLaneAdmissionDecision> {
      return AgentLaneAdmissionDecisionSchema.parse(
        await postJson(stubFor(input.workItemId), "/admit-lane", input)
      );
    },
    async appendEvent(input): Promise<void> {
      await postJson(stubFor(input.workItemId), "/append-event", input);
    },
    async assertActiveDriveGeneration(input): Promise<void> {
      await postJson(
        stubFor(input.workItemId),
        "/assert-drive-generation",
        input
      );
    },
    async loadDriveLedger(input) {
      return WorkflowDriveLedgerSchema.parse(
        await postJson(stubFor(input.workItemId), "/load-drive-ledger", input)
      );
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
    async recordDriveLaneDispatch(input) {
      return WorkflowDriveLedgerSchema.parse(
        await postJson(
          stubFor(input.dispatch.workItemId),
          "/record-drive-lane-dispatch",
          input
        )
      );
    },
    async recordDriveLaneStatus(input) {
      return WorkflowDriveLedgerSchema.parse(
        await postJson(
          stubFor(input.statusReceipt.workItemId),
          "/record-drive-lane-status",
          input
        )
      );
    },
    async recordDriveNodeAttempt(input) {
      return WorkflowDriveNodeAttemptSchema.parse(
        await postJson(
          stubFor(input.workItemId),
          "/record-drive-node-attempt",
          input
        )
      );
    },
    async recordDrivePhaseCompletion(input) {
      return WorkflowDriveLedgerSchema.parse(
        await postJson(stubFor(input.workItemId), "/record-drive-phase", input)
      );
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

/**
 * Enqueue a run on the supervisor DO for asynchronous, alarm-driven execution
 * (M2.5 step 4). Routes to the DO keyed by `workItemId` (the same key the run's
 * capsule lives under), parks the run via `/start-run`, and returns — the DO's
 * alarm drives the run in a fresh invocation. The caller (`POST /runs`) returns
 * 202 without awaiting execution.
 */
export const enqueueCapsuleSupervisorRun = async (
  namespace: DurableObjectNamespace<CloudflareWorkflowCapsuleSupervisor>,
  input: StartRunRequest
): Promise<void> => {
  const stub = namespace.get(namespace.idFromName(input.workItemId));
  await postJson(stub, "/start-run", StartRunRequestSchema.parse(input));
};

/**
 * Read the supervisor DO's read-only durability dump for a run (the monitor's
 * durability view). Routes to the DO sharded by `workItemId` (where the run's
 * checkpoints/markers live) and proxies `/get-durability`. Pure read — the DO
 * route never mutates storage.
 */
export const readCapsuleSupervisorRunDurability = async (
  namespace: DurableObjectNamespace<CloudflareWorkflowCapsuleSupervisor>,
  input: { readonly runId: string; readonly workItemId: string }
): Promise<RunDurabilityDump> => {
  const stub = namespace.get(namespace.idFromName(input.workItemId));

  return RunDurabilityDumpSchema.parse(
    await postJson(stub, "/get-durability", {
      runId: input.runId,
      workItemId: input.workItemId,
    })
  );
};
