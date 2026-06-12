import type * as CloudflareWorkersModule from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import type { WorkerFrontDoorContract } from "../../src/app/application/ports.ts";
import {
  LoadRunCheckpointResolutionSchema,
  WorkflowRunBlockedSchema,
  WorkflowRunPausedSchema,
  WorkflowRunRequestSchema,
} from "../../src/app/domain/schemas.ts";
import type {
  RunStepCheckpoint,
  WorkflowRunRequest,
} from "../../src/app/domain/schemas.ts";
import type { WorkflowCapsuleSupervisorEnv } from "../../src/app/infrastructure/cloudflare-capsule-supervisor.ts";
import { buildIntegrationTestRunRequest } from "./workflow-app-fixtures.ts";

class StubDurableObject {
  protected readonly ctx: unknown;
  protected readonly env: unknown;

  constructor(ctx: unknown, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}

// Vitest runs in Node, where `cloudflare:workers` is unresolvable. Stub the
// `DurableObject` base so the supervisor DO's async run driver can be exercised
// without the workerd runtime.
const cloudflareWorkersStub = { DurableObject: StubDurableObject };
vi.mock(
  import("cloudflare:workers"),
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The partial stub provides only the DurableObject base the supervisor extends.
  () => cloudflareWorkersStub as unknown as typeof CloudflareWorkersModule
);

const { __capsuleSupervisorTestHooks, CloudflareWorkflowCapsuleSupervisor } =
  await import("../../src/app/infrastructure/cloudflare-capsule-supervisor.ts");
type CloudflareWorkflowCapsuleSupervisorInstance = InstanceType<
  typeof CloudflareWorkflowCapsuleSupervisor
>;

interface FakeDurableObjectState {
  alarmAt: number | null;
  readonly store: Map<string, unknown>;
  readonly storage: {
    delete(key: string): Promise<void>;
    get(key: string): Promise<unknown>;
    getAlarm(): Promise<number | null>;
    list(options: { prefix: string }): Promise<Map<string, unknown>>;
    put(key: string, value: unknown): Promise<void>;
    setAlarm(at: number): Promise<void>;
  };
}

const createFakeDurableObjectState = (): FakeDurableObjectState => {
  const store = new Map<string, unknown>();
  const state: FakeDurableObjectState = {
    alarmAt: null,
    storage: {
      delete(key: string) {
        store.delete(key);

        return Promise.resolve();
      },
      get(key: string) {
        return Promise.resolve(store.get(key));
      },
      getAlarm() {
        return Promise.resolve(state.alarmAt);
      },
      list(options: { prefix: string }) {
        const matched = new Map<string, unknown>();
        for (const [key, value] of store) {
          if (key.startsWith(options.prefix)) {
            matched.set(key, value);
          }
        }

        return Promise.resolve(matched);
      },
      put(key: string, value: unknown) {
        store.set(key, value);

        return Promise.resolve();
      },
      setAlarm(at: number) {
        state.alarmAt = at;

        return Promise.resolve();
      },
    },
    store,
  };

  return state;
};

const createSupervisor = (
  state: FakeDurableObjectState,
  envOverride: Partial<WorkflowCapsuleSupervisorEnv> = {}
): CloudflareWorkflowCapsuleSupervisorInstance => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Vitest runs in Node; the Worker runtime provides a real DurableObjectState that this fake stands in for.
  const durableState = state as unknown as DurableObjectState;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The async driver path reads only WORKFLOW_APP_TIMEOUT_MS (for marker staleness); the runtime would inject the rest.
  const env = envOverride as unknown as WorkflowCapsuleSupervisorEnv;

  return new CloudflareWorkflowCapsuleSupervisor(durableState, env);
};

const createBlockedFrontDoor = (
  startedRuns: WorkflowRunRequest[]
): WorkerFrontDoorContract => ({
  route: "POST /runs",
  startRun(input) {
    const request = WorkflowRunRequestSchema.parse(input);
    startedRuns.push(request);

    return Promise.resolve(
      WorkflowRunBlockedSchema.parse({
        blocker: {
          code: "adapter_unavailable",
          message: "Async driver test blocker.",
          redacted: true,
        },
        eventLog: [],
        runId: request.runId,
        status: "blocked",
      })
    );
  },
});

const startRun = (
  supervisor: CloudflareWorkflowCapsuleSupervisorInstance,
  request: WorkflowRunRequest
): Promise<Response> =>
  supervisor.fetch(
    new Request("https://supervisor.internal/start-run", {
      body: JSON.stringify({ request, workItemId: request.workItemId }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
  );

/**
 * Read the latest persisted checkpoint for a run through the supervisor's own
 * `/load-latest-checkpoint` route — the exact resume read `WorkflowApp.run()`
 * performs. Lets a test front door assert it resumed from a checkpoint rather
 * than restarting from scratch.
 */
const loadLatestCheckpoint = async (
  supervisor: CloudflareWorkflowCapsuleSupervisorInstance,
  request: WorkflowRunRequest
): Promise<RunStepCheckpoint | null> => {
  const response = await supervisor.fetch(
    new Request("https://supervisor.internal/load-latest-checkpoint", {
      body: JSON.stringify({
        runId: request.runId,
        workItemId: request.workItemId,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
  );

  return LoadRunCheckpointResolutionSchema.parse(await response.json())
    .checkpoint;
};

const persistCheckpoint = (
  supervisor: CloudflareWorkflowCapsuleSupervisorInstance,
  request: WorkflowRunRequest,
  overrides: { readonly persistedAt: string; readonly stepIndex: number }
): Promise<Response> =>
  supervisor.fetch(
    new Request("https://supervisor.internal/persist-checkpoint", {
      body: JSON.stringify({
        checkpoint: {
          completedStepIds: ["step-one"],
          envelopeSnapshot: { status: "active" },
          generatedMachineSnapshot: { status: "active" },
          outputArtifactRefs: [],
          persistedAt: overrides.persistedAt,
          runId: request.runId,
          schemaVersion: "workflow.run-step-checkpoint.v1",
          stepIndex: overrides.stepIndex,
          workItemId: request.workItemId,
        },
        workItemId: request.workItemId,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
  );

const runStartKey = (request: WorkflowRunRequest): string =>
  `run-start:${request.runId}`;

const drivingMarkerKey = (request: WorkflowRunRequest): string =>
  `driving:${request.runId}`;

const TEST_TIMEOUT_MS = 600_000;

/**
 * Persist a checkpoint through the supervisor's own `/persist-checkpoint` route
 * (the exact durable write a single-step drive performs), so a stateful single-
 * step front door can advance the run one step index at a time and the DO reads
 * the same checkpoints the resume path would.
 */
const persistCheckpointViaSupervisor = (
  supervisor: CloudflareWorkflowCapsuleSupervisorInstance,
  request: WorkflowRunRequest,
  overrides: { readonly persistedAt: string; readonly stepIndex: number }
): Promise<Response> =>
  supervisor.fetch(
    new Request("https://supervisor.internal/persist-checkpoint", {
      body: JSON.stringify({
        checkpoint: {
          completedStepIds: Array.from(
            { length: overrides.stepIndex + 1 },
            (_unused, index) => `step-${index}`
          ),
          envelopeSnapshot: { status: "active" },
          generatedMachineSnapshot: { status: "active" },
          outputArtifactRefs: [],
          persistedAt: overrides.persistedAt,
          runId: request.runId,
          schemaVersion: "workflow.run-step-checkpoint.v1",
          stepIndex: overrides.stepIndex,
          workItemId: request.workItemId,
        },
        workItemId: request.workItemId,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
  );

interface SingleStepDriveLog {
  readonly driveModes: (string | undefined)[];
  readonly outcomeStatuses: ("blocked" | "captured" | "paused")[];
  readonly persistedStepIndexes: number[];
}

/**
 * A stateful single-step front door that drives a multi-node run against the
 * supervisor's OWN checkpoint storage: each `startRun` resumes from the latest
 * checkpoint, persists exactly one more (stepIndex + 1), and returns `paused`
 * until the last node, then a terminal status — exactly the contract the real
 * `WorkflowApp.run({ driveMode: "single-step" })` honors. Records the drive mode
 * the DO passed and the per-drive checkpoint index so a test can assert one node
 * per alarm.
 */
const createSingleStepFrontDoor = (
  supervisor: CloudflareWorkflowCapsuleSupervisorInstance,
  totalSteps: number,
  log: SingleStepDriveLog
): WorkerFrontDoorContract => ({
  route: "POST /runs",
  async startRun(input, options) {
    const request = WorkflowRunRequestSchema.parse(input);
    log.driveModes.push(options?.driveMode);

    const latest = await loadLatestCheckpoint(supervisor, request);
    const nextStepIndex = latest === null ? 0 : latest.stepIndex + 1;
    await persistCheckpointViaSupervisor(supervisor, request, {
      persistedAt: new Date().toISOString(),
      stepIndex: nextStepIndex,
    });
    log.persistedStepIndexes.push(nextStepIndex);

    if (nextStepIndex < totalSteps - 1) {
      log.outcomeStatuses.push("paused");

      return WorkflowRunPausedSchema.parse({
        completedStepIds: Array.from(
          { length: nextStepIndex + 1 },
          (_unused, index) => `step-${index}`
        ),
        eventLog: [],
        runId: request.runId,
        status: "paused",
        stepIndex: nextStepIndex,
      });
    }

    log.outcomeStatuses.push("blocked");

    // Terminal: a `blocked` result stands in for the run reaching its terminal
    // status after the last node + finishing envelope (captured/blocked both
    // retire the run-start record identically).
    return WorkflowRunBlockedSchema.parse({
      blocker: {
        code: "adapter_unavailable",
        message: "Single-step drive reached terminal in test.",
        redacted: true,
      },
      eventLog: [],
      runId: request.runId,
      status: "blocked",
    });
  },
});

describe("Capsule supervisor async run driver", () => {
  it("accepts /start-run by parking the run and arming an immediate alarm without driving it", async () => {
    const state = createFakeDurableObjectState();
    const supervisor = createSupervisor(state);
    const startedRuns: WorkflowRunRequest[] = [];
    __capsuleSupervisorTestHooks.setRunDriverFactory(() =>
      createBlockedFrontDoor(startedRuns)
    );
    try {
      const request = buildIntegrationTestRunRequest();

      const response = await startRun(supervisor, request);

      expect({
        alarmArmed: state.alarmAt !== null,
        body: await response.json(),
        parkedRun: state.store.get(`run-start:${request.runId}`),
        startedRunCount: startedRuns.length,
      }).toStrictEqual({
        alarmArmed: true,
        body: { runId: request.runId, status: "accepted" },
        parkedRun: request,
        startedRunCount: 0,
      });
    } finally {
      __capsuleSupervisorTestHooks.resetRunDriverFactory();
    }
  });

  it("drives the parked run on alarm and clears the run-start slot", async () => {
    const state = createFakeDurableObjectState();
    const supervisor = createSupervisor(state);
    const startedRuns: WorkflowRunRequest[] = [];
    __capsuleSupervisorTestHooks.setRunDriverFactory(() =>
      createBlockedFrontDoor(startedRuns)
    );
    try {
      const request = buildIntegrationTestRunRequest();
      await startRun(supervisor, request);

      await supervisor.alarm();

      expect({
        runStartCleared: !state.store.has(`run-start:${request.runId}`),
        startedRunIds: startedRuns.map((started) => started.runId),
      }).toStrictEqual({
        runStartCleared: true,
        startedRunIds: [request.runId],
      });
    } finally {
      __capsuleSupervisorTestHooks.resetRunDriverFactory();
    }
  });

  it("does not re-drive a run once its alarm has fired", async () => {
    const state = createFakeDurableObjectState();
    const supervisor = createSupervisor(state);
    const startedRuns: WorkflowRunRequest[] = [];
    __capsuleSupervisorTestHooks.setRunDriverFactory(() =>
      createBlockedFrontDoor(startedRuns)
    );
    try {
      const request = buildIntegrationTestRunRequest();
      await startRun(supervisor, request);

      await supervisor.alarm();
      await supervisor.alarm();

      expect(startedRuns.map((started) => started.runId)).toStrictEqual([
        request.runId,
      ]);
    } finally {
      __capsuleSupervisorTestHooks.resetRunDriverFactory();
    }
  });

  // FIX 1, test (a): an evicted mid-run run whose run-start record persists is
  // re-driven by a subsequent alarm and RESUMES from its checkpoint — it does
  // NOT restart, and the reaper never touches it. The post-eviction storage
  // state is seeded directly (run-start kept + a mid-run checkpoint + a stale
  // driving marker) because a real eviction kills the invocation before any
  // cleanup runs.
  it("re-drives an evicted run and resumes it from its latest checkpoint", async () => {
    const state = createFakeDurableObjectState();
    const supervisor = createSupervisor(state, {
      WORKFLOW_APP_TIMEOUT_MS: TEST_TIMEOUT_MS,
    });
    const request = buildIntegrationTestRunRequest();

    // Drive 1 progressed one step then was evicted: a checkpoint exists, the
    // run-start record survives, and a now-stale driving marker is left behind.
    await persistCheckpoint(supervisor, request, {
      persistedAt: new Date(Date.now() - 2 * TEST_TIMEOUT_MS).toISOString(),
      stepIndex: 0,
    });
    state.store.set(runStartKey(request), request);
    state.store.set(drivingMarkerKey(request), {
      startedAtMs: Date.now() - 2 * TEST_TIMEOUT_MS,
    });

    const checkpointSeenOnDrive: (RunStepCheckpoint | null)[] = [];
    const resumeAwareFrontDoor: WorkerFrontDoorContract = {
      route: "POST /runs",
      async startRun(input) {
        const parsed = WorkflowRunRequestSchema.parse(input);
        // The resume read WorkflowApp.run() performs: a non-null result here is
        // proof the drive resumed from the prior step rather than restarting.
        checkpointSeenOnDrive.push(
          await loadLatestCheckpoint(supervisor, parsed)
        );

        return WorkflowRunBlockedSchema.parse({
          blocker: {
            code: "adapter_unavailable",
            message: "Resume completed to terminal in test.",
            redacted: true,
          },
          eventLog: [],
          runId: parsed.runId,
          status: "blocked",
        });
      },
    };
    __capsuleSupervisorTestHooks.setRunDriverFactory(
      () => resumeAwareFrontDoor
    );
    try {
      await supervisor.alarm();

      expect({
        markerCleared: !state.store.has(drivingMarkerKey(request)),
        resumeCheckpointStepIndexes: checkpointSeenOnDrive.map(
          (checkpoint) => checkpoint?.stepIndex ?? null
        ),
        runStartClearedAfterTerminal: !state.store.has(runStartKey(request)),
      }).toStrictEqual({
        markerCleared: true,
        // A single re-drive that saw the prior checkpoint = resumed, not reaped.
        resumeCheckpointStepIndexes: [0],
        runStartClearedAfterTerminal: true,
      });
    } finally {
      __capsuleSupervisorTestHooks.resetRunDriverFactory();
    }
  });

  // Watchdog: a hard workerd kill mid-drive runs no catch/finally, so the only
  // thing that can recover the run is an alarm armed in storage BEFORE the drive
  // begins. Clearing the start alarm isolates the watchdog: only the pre-drive
  // arm can re-set it. Without the watchdog the run orphans (no future alarm).
  it("arms a watchdog alarm before driving so a hard-killed drive is recovered", async () => {
    const state = createFakeDurableObjectState();
    const emptyD1 = {
      prepare: () => ({
        all: () => Promise.resolve({ results: [] }),
        bind: () => ({
          all: () => Promise.resolve({ results: [] }),
          run: () => Promise.resolve({ meta: { changes: 0 }, success: true }),
        }),
        run: () => Promise.resolve({ meta: { changes: 0 }, success: true }),
      }),
    };
    const supervisor = createSupervisor(state, {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- minimal D1 stub; the watchdog only needs a bound D1 to resolve reaper context.
      WORKFLOW_APP_D1: emptyD1 as unknown as NonNullable<
        WorkflowCapsuleSupervisorEnv["WORKFLOW_APP_D1"]
      >,
      WORKFLOW_APP_TIMEOUT_MS: TEST_TIMEOUT_MS,
    });
    const request = buildIntegrationTestRunRequest();

    let alarmArmedWhenDriveBegan: boolean | null = null;
    __capsuleSupervisorTestHooks.setRunDriverFactory(() => ({
      route: "POST /runs",
      startRun(input) {
        WorkflowRunRequestSchema.parse(input);
        alarmArmedWhenDriveBegan = state.alarmAt !== null;
        // Simulate the invocation being killed mid-drive: a throw is the closest
        // observable analogue (driveOneQueuedRun keeps the record either way).
        throw new Error("simulated workerd eviction mid-drive");
      },
    }));
    try {
      await startRun(supervisor, request);
      // Simulate the start alarm having fired and been consumed by the runtime.
      state.alarmAt = null;

      await supervisor.alarm();

      expect({
        alarmArmedWhenDriveBegan,
        futureAlarmArmed: state.alarmAt !== null,
        runStartKept: state.store.has(runStartKey(request)),
      }).toStrictEqual({
        alarmArmedWhenDriveBegan: true,
        futureAlarmArmed: true,
        runStartKept: true,
      });
    } finally {
      __capsuleSupervisorTestHooks.resetRunDriverFactory();
    }
  });

  // FIX 1, test (b): the driving marker prevents concurrent double-drive, but a
  // stale marker (the prior driver was evicted) allows the next alarm to
  // re-drive. Both halves are exercised against the same seeded parked run.
  it("blocks double-drive on a fresh marker yet re-drives on a stale marker", async () => {
    const freshState = createFakeDurableObjectState();
    const freshSupervisor = createSupervisor(freshState, {
      WORKFLOW_APP_TIMEOUT_MS: TEST_TIMEOUT_MS,
    });
    const staleState = createFakeDurableObjectState();
    const staleSupervisor = createSupervisor(staleState, {
      WORKFLOW_APP_TIMEOUT_MS: TEST_TIMEOUT_MS,
    });
    const request = buildIntegrationTestRunRequest();
    const freshStarted: WorkflowRunRequest[] = [];
    const staleStarted: WorkflowRunRequest[] = [];

    // Fresh marker: another driver is mid-flight, so the alarm must NOT drive.
    freshState.store.set(runStartKey(request), request);
    freshState.store.set(drivingMarkerKey(request), {
      startedAtMs: Date.now(),
    });

    // Stale marker: the prior driver was evicted, so the alarm MUST re-drive.
    staleState.store.set(runStartKey(request), request);
    staleState.store.set(drivingMarkerKey(request), {
      startedAtMs: Date.now() - 2 * TEST_TIMEOUT_MS,
    });

    try {
      __capsuleSupervisorTestHooks.setRunDriverFactory(() =>
        createBlockedFrontDoor(freshStarted)
      );
      await freshSupervisor.alarm();

      __capsuleSupervisorTestHooks.setRunDriverFactory(() =>
        createBlockedFrontDoor(staleStarted)
      );
      await staleSupervisor.alarm();

      expect({
        freshDriveCount: freshStarted.length,
        freshRunStartKept: freshState.store.has(runStartKey(request)),
        staleDriveCount: staleStarted.length,
      }).toStrictEqual({
        // Fresh marker blocked the drive; the parked run is left for later.
        freshDriveCount: 0,
        freshRunStartKept: true,
        // Stale marker allowed the re-drive (one drive to terminal).
        staleDriveCount: 1,
      });
    } finally {
      __capsuleSupervisorTestHooks.resetRunDriverFactory();
    }
  });

  // step-driver(core): a multi-node run advances exactly ONE node per alarm. Each
  // alarm drives in single-step mode, persists one more checkpoint (stepIndex + 1),
  // re-arms a fresh resume alarm on `paused`, and keeps the run-start record until
  // terminal. The resume alarm is a strictly-future set (now + RESUME_DELAY_MS), not
  // alarm(now): inside the firing handler the phantom firing time defeats a lowering
  // re-arm and a past-time set never re-fires, so each node gets its own fresh
  // invocation budget instead of racing the reaper inside the same alarm.
  it("drives one node per alarm, re-arming a fresh resume alarm and retaining the run-start record until terminal", async () => {
    const state = createFakeDurableObjectState();
    const supervisor = createSupervisor(state, {
      WORKFLOW_APP_TIMEOUT_MS: TEST_TIMEOUT_MS,
    });
    const request = buildIntegrationTestRunRequest();
    const totalSteps = 3;
    const log: SingleStepDriveLog = {
      driveModes: [],
      outcomeStatuses: [],
      persistedStepIndexes: [],
    };
    __capsuleSupervisorTestHooks.setRunDriverFactory(() =>
      createSingleStepFrontDoor(supervisor, totalSteps, log)
    );
    try {
      await startRun(supervisor, request);

      // Alarms 1 + 2 each advance one node and pause; the run-start record + a
      // freshly re-armed alarm survive each. The DO clears the start alarm in the
      // fake state to observe the re-arm; the runtime would do this between fires.
      const runStartKeptAcrossAlarms: boolean[] = [];
      const alarmReArmedAfterPause: boolean[] = [];
      for (let alarmCount = 0; alarmCount < totalSteps - 1; alarmCount += 1) {
        state.alarmAt = null;
        // eslint-disable-next-line no-await-in-loop -- alarms fire sequentially.
        await supervisor.alarm();
        runStartKeptAcrossAlarms.push(state.store.has(runStartKey(request)));
        alarmReArmedAfterPause.push(state.alarmAt !== null);
      }

      // Final alarm runs the last node and reaches terminal, retiring the record.
      state.alarmAt = null;
      await supervisor.alarm();

      const latestCheckpoint = await loadLatestCheckpoint(supervisor, request);

      expect({
        // A fresh resume alarm was re-armed after each pause so the next node fires
        // on its own invocation a beat later (now + RESUME_DELAY_MS).
        alarmReArmedAfterPause,
        // The DO now drives single-step: one node per alarm, an explicit
        // driveMode on every startRun, so a heavy node owns a full invocation
        // budget instead of sharing one whole-run pass.
        driveModes: log.driveModes,
        // The latest checkpoint advanced to the final step index.
        latestCheckpointStepIndex: latestCheckpoint?.stepIndex ?? null,
        // The two pre-terminal drives paused; the last reached terminal.
        outcomeStatuses: log.outcomeStatuses,
        // One checkpoint per alarm, stepIndex incrementing by exactly one.
        persistedStepIndexes: log.persistedStepIndexes,
        // ...and retired only once the run reached terminal.
        runStartClearedAtTerminal: !state.store.has(runStartKey(request)),
        // The run-start record was retained while paused...
        runStartKeptAcrossAlarms,
      }).toStrictEqual({
        alarmReArmedAfterPause: [true, true],
        driveModes: ["single-step", "single-step", "single-step"],
        latestCheckpointStepIndex: 2,
        outcomeStatuses: ["paused", "paused", "blocked"],
        persistedStepIndexes: [0, 1, 2],
        runStartClearedAtTerminal: true,
        runStartKeptAcrossAlarms: [true, true],
      });
    } finally {
      __capsuleSupervisorTestHooks.resetRunDriverFactory();
    }
  });

  // step-driver(core): a run that advanced THIS alarm (its checkpoint is fresh)
  // is protected from the reaper — it paused with forward progress, so the next
  // alarm resumes it rather than the reaper sweeping it to blocked.
  it("does not sweep a run that advanced this alarm (fresh checkpoint after a paused drive)", async () => {
    const state = createFakeDurableObjectState();
    const request = buildIntegrationTestRunRequest();
    const reaped: string[] = [];
    // The reaper's "find stuck runs" SELECT returns this run as a candidate, so
    // protection must come from the fresh-checkpoint filter — not from D1
    // returning nothing. The UPDATE's bind records any run id D1 was asked to
    // sweep; a protected run is filtered out before the UPDATE, so it never lands.
    const reapingD1 = {
      prepare: (query: string) => ({
        all: () => Promise.resolve({ results: [] }),
        bind: (...args: unknown[]) => ({
          all: () =>
            /^\s*select/iu.test(query)
              ? Promise.resolve({
                  results: [
                    {
                      actor_id: request.actor.id,
                      capsule_id: `capsule:${request.workItemId}`,
                      event_index: 0,
                      run_id: request.runId,
                      status: "executingDynamicWorkflow",
                      work_item_id: request.workItemId,
                    },
                  ],
                })
              : Promise.resolve({ results: [] }),
          run: () => {
            if (/^\s*update/iu.test(query)) {
              const runId = args.at(2);
              if (typeof runId === "string") {
                reaped.push(runId);
              }
            }

            return Promise.resolve({ meta: { changes: 1 }, success: true });
          },
        }),
        run: () => Promise.resolve({ meta: { changes: 0 }, success: true }),
      }),
    };
    const supervisor = createSupervisor(state, {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- minimal D1 stub feeding the reaper a stuck-run candidate so the fresh-checkpoint protection is what spares the run.
      WORKFLOW_APP_D1: reapingD1 as unknown as NonNullable<
        WorkflowCapsuleSupervisorEnv["WORKFLOW_APP_D1"]
      >,
      WORKFLOW_APP_TIMEOUT_MS: TEST_TIMEOUT_MS,
    });
    const log: SingleStepDriveLog = {
      driveModes: [],
      outcomeStatuses: [],
      persistedStepIndexes: [],
    };
    // Seed an admission lane this run owns so the reaper has a slot to consider.
    state.store.set("record", {
      activeLaneOwners: { "lane:reaper-test": request.runId },
      workItemId: request.workItemId,
    });
    __capsuleSupervisorTestHooks.setRunDriverFactory(() =>
      createSingleStepFrontDoor(supervisor, 4, log)
    );
    try {
      await startRun(supervisor, request);

      // One alarm: drives one node (pauses with a fresh checkpoint), then the
      // reaper runs in the SAME alarm and must NOT sweep this run.
      await supervisor.alarm();

      expect({
        droveOneNode: log.persistedStepIndexes,
        paused: log.outcomeStatuses,
        reapedRunIds: reaped,
        runStartKept: state.store.has(runStartKey(request)),
      }).toStrictEqual({
        droveOneNode: [0],
        paused: ["paused"],
        // The fresh checkpoint protected the run — the reaper swept nothing.
        reapedRunIds: [],
        runStartKept: true,
      });
    } finally {
      __capsuleSupervisorTestHooks.resetRunDriverFactory();
    }
  });
});
