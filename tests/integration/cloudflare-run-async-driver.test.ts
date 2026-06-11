import type * as CloudflareWorkersModule from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import type { WorkerFrontDoorContract } from "../../src/app/application/ports.ts";
import {
  LoadRunCheckpointResolutionSchema,
  WorkflowRunBlockedSchema,
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
});
