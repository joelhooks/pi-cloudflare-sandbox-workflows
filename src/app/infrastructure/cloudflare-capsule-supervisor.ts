/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import type {
  AgentLaneAdmissionControllerContract,
  ContextCapsuleActorContract,
  WorkerFrontDoorContract,
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
  RunDurabilityDumpSchema,
  RunDurabilityRequestSchema,
  RunStepCheckpointSchema,
  StartRunRequestSchema,
  WorkflowEventSchema,
  WorkflowRunRequestSchema,
} from "../domain/schemas.ts";
import type {
  AgentLaneAdmissionDecision,
  AgentLaneReleaseReceipt,
  ContextCapsuleRecord,
  RunDurabilityDump,
  RunStepCheckpoint,
  StartRunRequest,
  WorkflowRunRequest,
} from "../domain/schemas.ts";
import type { CloudflareD1PackageRegistryConfig } from "./cloudflare-package-registry.ts";
import { reapStuckRunsForWorkItem } from "./cloudflare-run-reaper.ts";

export interface WorkflowCapsuleSupervisorEnv {
  readonly WORKFLOW_APP_D1?: CloudflareD1PackageRegistryConfig["d1"];
  readonly WORKFLOW_APP_TIMEOUT_MS?: number | string;
  readonly WORKFLOW_CAPSULE_SUPERVISOR: DurableObjectNamespace<CloudflareWorkflowCapsuleSupervisor>;
}

/**
 * Builds the front door that drives a run from inside the supervisor DO's
 * `alarm()` invocation (M2.5 step 4). The DO receives the full Worker `Env` at
 * runtime, so the default lazily imports `createFrontDoorFromEnv` and constructs
 * the production front door from its own bindings. Overridable for tests so the
 * async-contract behavior can be exercised without a live Sandbox/Artifacts.
 */
export type CapsuleSupervisorRunDriverFactory = (
  env: WorkflowCapsuleSupervisorEnv
) => Promise<WorkerFrontDoorContract> | WorkerFrontDoorContract;

let runDriverFactoryOverride: CapsuleSupervisorRunDriverFactory | undefined;

const defaultRunDriverFactory: CapsuleSupervisorRunDriverFactory = async (
  env
) => {
  const { createFrontDoorFromEnv } =
    await import("./cloudflare-worker-route.ts");

  return createFrontDoorFromEnv(env);
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

const ResolveCapsuleRequestSchema = z.object({
  runId: z.string().min(1),
  workItemId: z.string().min(1),
});

const AppendCapsuleEventRequestSchema = z.object({
  event: WorkflowEventSchema,
  workItemId: z.string().min(1),
});

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
 * Drive one queued run through the front door from inside the alarm invocation.
 * `WorkflowApp.run()` (reached via the front door) loads the latest checkpoint
 * and resumes from it, so a re-drive of an evicted run continues rather than
 * restarts (FIX 1). Returns `true` when the run reached a terminal status
 * (captured/blocked) so the caller may retire its run-start record; returns
 * `false` when the drive threw (e.g. transient adapter failure) so the record is
 * kept and a later alarm re-drives. Swallows and logs the error so one failed
 * run does not abort driving the rest of the queue.
 */
const driveOneQueuedRun = async (
  frontDoor: WorkerFrontDoorContract,
  request: WorkflowRunRequest
): Promise<boolean> => {
  try {
    // `startRun` resolves only at a terminal status (captured | blocked); an
    // eviction kills the invocation mid-await, leaving the run-start record and
    // a still-set driving marker for the next alarm to re-drive.
    await frontDoor.startRun(request);

    return true;
  } catch (error) {
    console.error("queued run driver failed", request.runId, error);

    return false;
  }
};

export class CloudflareWorkflowCapsuleSupervisor extends DurableObject<WorkflowCapsuleSupervisorEnv> {
  override fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    const postRoutes: Record<string, () => Promise<Response>> = {
      "/admit-lane": () => this.admitLane(request),
      "/append-event": () => this.appendEvent(request),
      "/get-durability": () => this.getDurability(request),
      "/load-latest-checkpoint": () => this.loadLatestCheckpoint(request),
      "/persist-checkpoint": () => this.persistCheckpoint(request),
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

  private async admitLane(request: Request): Promise<Response> {
    const input = AgentLaneAdmissionRequestSchema.parse(await request.json());
    const record = await this.getRecord();
    const activeLaneIds = activeLaneIdsOf(record);

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

    if (activeLaneIds.includes(input.laneId)) {
      return json(
        AgentLaneAdmissionDecisionSchema.parse({
          activeLaneIds,
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

    if (activeLaneIds.length >= input.maxActiveLanes) {
      return json(
        AgentLaneAdmissionDecisionSchema.parse({
          activeLaneIds,
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

    return json(
      AgentLaneAdmissionDecisionSchema.parse({
        activeLaneIds: Object.keys(nextActiveLaneOwners),
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
      reaperDueAtMs,
      redacted: true,
      runId: input.runId,
      schemaVersion: "workflow.run-durability.v1",
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

    // Arm a watchdog alarm BEFORE the drive, but only while a run-start record
    // is still queued (a non-terminal run that could be killed mid-drive).
    // driveQueuedRuns awaits the whole run to a terminal status; if workerd
    // evicts/kills this invocation mid-run (long multi-node walks exceed a
    // single invocation budget), every line below — including the reaper re-arm
    // at the end — never executes, leaving the run orphaned with no future alarm
    // to reap or re-drive it. Scheduling the watchdog first guarantees a later
    // alarm fires to resume the run from its latest checkpoint (fresh) or sweep
    // it (stale), so a killed drive is recovered rather than wedged forever.
    // Gating on queued records keeps an idle DO from re-arming forever.
    const queuedBeforeDrive = await this.ctx.storage.list({
      prefix: runStartStoragePrefix,
    });
    if (queuedBeforeDrive.size > 0) {
      await this.ensureReaperAlarm();
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

    await this.rearmReaperAlarmIfSlotsRemain();
  }

  /**
   * Drive every run parked by `/start-run`. A run-start record is kept until the
   * run reaches a TERMINAL status (captured/blocked); only then is it deleted
   * (FIX 1). A refired alarm therefore finds an evicted run's record and re-drives
   * it, at which point `WorkflowApp.run()` resumes from the latest checkpoint —
   * the run-start record is what makes resume reachable in production.
   *
   * Concurrency is guarded by a short-lived `driving:<runId>` marker carrying the
   * driver's start timestamp: a drive only begins when no marker exists or the
   * existing marker is stale (older than `WORKFLOW_APP_TIMEOUT_MS` — the previous
   * driver was evicted). A normal completion clears its own marker, so two alarms
   * never double-drive the same run; an evicted run leaves a stale marker that the
   * next alarm overrides to re-drive. Drives runs sequentially so one fresh
   * wall-clock budget is consumed at a time.
   */
  private async driveQueuedRuns(now: number): Promise<void> {
    const queued = await this.ctx.storage.list({
      prefix: runStartStoragePrefix,
    });
    if (queued.size === 0) {
      return;
    }

    const timeoutMs = this.resolveTimeoutMs();
    const driver = runDriverFactoryOverride ?? defaultRunDriverFactory;
    const frontDoor = await driver(this.env);
    for (const value of queued.values()) {
      const request = WorkflowRunRequestSchema.parse(value);
      if (await this.driverIsAlreadyRunning(request.runId, now, timeoutMs)) {
        continue;
      }

      await this.ctx.storage.put(drivingMarkerStorageKey(request.runId), {
        startedAtMs: now,
      });
      const reachedTerminal = await driveOneQueuedRun(frontDoor, request);
      if (reachedTerminal) {
        // Terminal: retire both the run-start record and the marker. A future
        // alarm finds nothing to re-drive.
        await this.ctx.storage.delete(runStartStorageKey(request.runId));
      }
      // Whether terminal or a transient throw, clear our marker. On eviction the
      // invocation dies before reaching here, so the marker survives (stale) and
      // re-drive is gated by staleness rather than re-driven immediately.
      await this.ctx.storage.delete(drivingMarkerStorageKey(request.runId));
    }
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

  private async rearmReaperAlarmIfSlotsRemain(): Promise<void> {
    const record = await this.getRecord();
    if (activeLaneIdsOf(record).length === 0) {
      // No slots to sweep: clear the tracked deadline so a stale due time does
      // not keep arming alarms after every run has released.
      await this.ctx.storage.delete(REAPER_DUE_AT_STORAGE_KEY);

      return;
    }

    await this.ensureReaperAlarm();
  }

  private async releaseLane(request: Request): Promise<Response> {
    const input = AgentLaneReleaseRequestSchema.parse(await request.json());
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
