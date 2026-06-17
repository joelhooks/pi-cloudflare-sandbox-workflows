import type * as CloudflareWorkersModule from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import type { WorkerFrontDoorContract } from "../../src/app/application/ports.ts";
import {
  LoadRunCheckpointResolutionSchema,
  RunDurabilityDumpSchema,
  RunStepCheckpointSchema,
  WorkflowEventStreamDocumentSchema,
  WorkflowRunBlockedSchema,
  WorkflowRunPausedSchema,
  WorkflowRunRequestSchema,
  WorkflowStatusProjectionSchema,
} from "../../src/app/domain/schemas.ts";
import type {
  RunStepCheckpoint,
  SafetyEnvelopeState,
  WorkflowRunDriveOptions,
  WorkflowRunRequest,
} from "../../src/app/domain/schemas.ts";
import type { WorkflowCapsuleSupervisorEnv } from "../../src/app/infrastructure/cloudflare-capsule-supervisor.ts";
import { createCloudflareWorkflowEventStreamReader } from "../../src/app/infrastructure/cloudflare-workflow-event-stream.ts";
import { createCloudflareWorkflowStatusProjection } from "../../src/app/infrastructure/cloudflare-workflow-status-projection.ts";
import { buildIntegrationTestRunRequest } from "./workflow-app-fixtures.ts";

class StubDurableObject {
  protected readonly ctx: unknown;
  protected readonly env: unknown;

  constructor(ctx: unknown, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}

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

type FakeD1Value = null | number | string;

interface FakeD1EventRow {
  readonly actor_id: string;
  readonly at: string;
  readonly capsule_id: string;
  readonly event_index: number;
  readonly redacted: number;
  readonly refs_json: string;
  readonly run_id: string;
  readonly state: string;
  readonly summary: string;
  readonly work_item_id: string;
}

interface FakeD1RunRow {
  readonly actor_id: string;
  readonly blocker_code: null | string;
  readonly blocker_message: null | string;
  readonly blocker_node_type: null | string;
  readonly blocker_step_id: null | string;
  readonly capsule_id: string;
  readonly plan_hash: null | string;
  readonly plan_ref: null | string;
  readonly run_id: string;
  readonly status: string;
  readonly updated_at: string;
  readonly work_item_id: string;
}

interface FakeD1Tables {
  readonly events: Map<string, FakeD1EventRow>;
  readonly runs: Map<string, FakeD1RunRow>;
}

interface FakeDurableObjectState {
  alarmAt: number | null;
  readonly store: Map<string, unknown>;
  readonly storage: {
    delete(key: string): Promise<void>;
    get(key: string): Promise<unknown>;
    getAlarm(): Promise<number | null>;
    list(options: { readonly prefix: string }): Promise<Map<string, unknown>>;
    put(key: string, value: unknown): Promise<void>;
    setAlarm(at: number): Promise<void>;
  };
}

interface CarrierFrontDoorLog {
  readonly checkpointReads: (null | number)[];
  readonly driveModes: (undefined | string)[];
  readonly persistedStepIndexes: number[];
}

const asNullableString = (value: FakeD1Value | undefined): null | string => {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new TypeError(
      `Expected a string D1 value, received ${typeof value}.`
    );
  }

  return value;
};

const asNumber = (value: FakeD1Value | undefined): number => {
  if (typeof value !== "number") {
    throw new TypeError(
      `Expected a number D1 value, received ${typeof value}.`
    );
  }

  return value;
};

const asString = (value: FakeD1Value | undefined): string => {
  if (typeof value !== "string") {
    throw new TypeError(
      `Expected a string D1 value, received ${typeof value}.`
    );
  }

  return value;
};

const createPreparedStatement = (query: string, tables: FakeD1Tables) => {
  let bound: FakeD1Value[] = [];
  const normalizedQuery = query.toLowerCase();
  const statement = {
    all(): Promise<{ readonly results: readonly unknown[] }> {
      const runId = asString(bound[0]);
      if (normalizedQuery.includes("from workflow_events")) {
        return Promise.resolve({
          results: [...tables.events.values()]
            .filter((row) => row.run_id === runId)
            .toSorted((left, right) => left.event_index - right.event_index),
        });
      }
      if (normalizedQuery.includes("from runs")) {
        const row = tables.runs.get(runId);

        return Promise.resolve({
          results: row === undefined ? [] : [row],
        });
      }

      throw new Error(`Unsupported fake D1 read: ${query}`);
    },
    bind(...values: FakeD1Value[]) {
      bound = values;

      return statement;
    },
    run(): Promise<{ readonly success: boolean }> {
      if (normalizedQuery.includes("insert into runs")) {
        const runId = asString(bound[0]);
        tables.runs.set(runId, {
          actor_id: asString(bound[3]),
          blocker_code: asNullableString(bound[7]),
          blocker_message: asNullableString(bound[8]),
          blocker_node_type: asNullableString(bound[10]),
          blocker_step_id: asNullableString(bound[9]),
          capsule_id: asString(bound[2]),
          plan_hash: asNullableString(bound[6]),
          plan_ref: asNullableString(bound[5]),
          run_id: runId,
          status: asString(bound[4]),
          updated_at: asString(bound[11]),
          work_item_id: asString(bound[1]),
        });

        return Promise.resolve({ success: true });
      }
      if (normalizedQuery.includes("insert into workflow_events")) {
        const eventIndex = asNumber(bound[1]);
        const runId = asString(bound[0]);
        tables.events.set(`${runId}:${eventIndex}`, {
          actor_id: asString(bound[4]),
          at: asString(bound[9]),
          capsule_id: asString(bound[3]),
          event_index: eventIndex,
          redacted: asNumber(bound[8]),
          refs_json: asString(bound[7]),
          run_id: runId,
          state: asString(bound[5]),
          summary: asString(bound[6]),
          work_item_id: asString(bound[2]),
        });

        return Promise.resolve({ success: true });
      }

      throw new Error(`Unsupported fake D1 write: ${query}`);
    },
  };

  return statement;
};

const createFakeD1 = () => {
  const tables: FakeD1Tables = {
    events: new Map(),
    runs: new Map(),
  };
  const d1 = {
    prepare(query: string) {
      return createPreparedStatement(query, tables);
    },
  };

  return {
    d1,
    events: tables.events,
    runs: tables.runs,
  };
};

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
      list(options: { readonly prefix: string }) {
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
  d1: WorkflowCapsuleSupervisorEnv["WORKFLOW_APP_D1"]
): CloudflareWorkflowCapsuleSupervisorInstance => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Vitest runs in Node; the Worker runtime provides a real DurableObjectState that this fake stands in for.
  const durableState = state as unknown as DurableObjectState;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The carrier canary binds D1 for status probes and leaves unrelated runtime bindings absent.
  const env = {
    WORKFLOW_APP_D1: d1,
  } as unknown as WorkflowCapsuleSupervisorEnv;

  return new CloudflareWorkflowCapsuleSupervisor(durableState, env);
};

const checkpointAt = (stepIndex: number): string =>
  `2026-06-17T01:5${stepIndex}:00.000Z`;

const outputArtifactRefFor = (
  request: WorkflowRunRequest,
  stepIndex: number
): string =>
  `artifact://workflow-app/runs/${request.runId}/carrier/${stepIndex}.json`;

const buildCheckpoint = (input: {
  readonly completedStepIds: readonly string[];
  readonly request: WorkflowRunRequest;
  readonly stepIndex: number;
}): RunStepCheckpoint =>
  RunStepCheckpointSchema.parse({
    completedStepIds: input.completedStepIds,
    envelopeSnapshot: {
      status: "active",
      value: "executingDynamicWorkflow",
    },
    generatedMachineSnapshot: {
      status: "active",
      value: `carrier_step_${input.stepIndex}`,
    },
    outputArtifactRefs: [outputArtifactRefFor(input.request, input.stepIndex)],
    persistedAt: checkpointAt(input.stepIndex),
    runId: input.request.runId,
    schemaVersion: "workflow.run-step-checkpoint.v1",
    stepIndex: input.stepIndex,
    workItemId: input.request.workItemId,
  });

const recordProjection = async (input: {
  readonly d1: ReturnType<typeof createFakeD1>["d1"];
  readonly eventCount: number;
  readonly request: WorkflowRunRequest;
  readonly state: SafetyEnvelopeState;
  readonly summary: string;
}): Promise<void> => {
  const terminalBlocker =
    input.state === "blocked"
      ? {
          code: "adapter_unavailable",
          message: "Carrier canary terminal projection.",
          redacted: true,
        }
      : undefined;
  await createCloudflareWorkflowStatusProjection({
    d1: input.d1,
  }).record({
    projection: WorkflowStatusProjectionSchema.parse({
      actorId: input.request.actor.id,
      capsuleId: `capsule:${input.request.workItemId}`,
      currentState: input.state,
      eventCount: input.eventCount,
      lastEvent: {
        at: `2026-06-17T01:5${input.eventCount}:00.000Z`,
        refs: {
          receipt: outputArtifactRefFor(input.request, input.eventCount - 1),
        },
        state: input.state,
        summary: input.summary,
      },
      redacted: true,
      runId: input.request.runId,
      schemaVersion: "workflow.status-projection.v1",
      ...(terminalBlocker === undefined ? {} : { terminalBlocker }),
      updatedAt: `2026-06-17T01:5${input.eventCount}:01.000Z`,
      workItemId: input.request.workItemId,
    }),
  });
};

const startRun = async (
  supervisor: CloudflareWorkflowCapsuleSupervisorInstance,
  request: WorkflowRunRequest
): Promise<unknown> => {
  const response = await supervisor.fetch(
    new Request("https://supervisor.internal/start-run", {
      body: JSON.stringify({ request, workItemId: request.workItemId }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
  );
  expect(response.ok).toBeTruthy();

  return await response.json();
};

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
  expect(response.ok).toBeTruthy();

  return LoadRunCheckpointResolutionSchema.parse(await response.json())
    .checkpoint;
};

const persistCheckpoint = async (
  supervisor: CloudflareWorkflowCapsuleSupervisorInstance,
  input: {
    readonly checkpoint: RunStepCheckpoint;
    readonly driveGeneration?: number;
  }
): Promise<void> => {
  const response = await supervisor.fetch(
    new Request("https://supervisor.internal/persist-checkpoint", {
      body: JSON.stringify({
        checkpoint: input.checkpoint,
        driveGeneration: input.driveGeneration,
        workItemId: input.checkpoint.workItemId,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
  );
  expect(response.ok).toBeTruthy();
};

const durability = async (
  supervisor: CloudflareWorkflowCapsuleSupervisorInstance,
  request: WorkflowRunRequest
) => {
  const response = await supervisor.fetch(
    new Request("https://supervisor.internal/get-durability", {
      body: JSON.stringify({
        runId: request.runId,
        workItemId: request.workItemId,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
  );
  expect(response.ok).toBeTruthy();

  return RunDurabilityDumpSchema.parse(await response.json());
};

const createCarrierFrontDoor = (input: {
  readonly d1: ReturnType<typeof createFakeD1>["d1"];
  readonly log: CarrierFrontDoorLog;
  readonly supervisor: CloudflareWorkflowCapsuleSupervisorInstance;
}): WorkerFrontDoorContract => ({
  route: "POST /runs",
  async startRun(value: unknown, options?: WorkflowRunDriveOptions) {
    const request = WorkflowRunRequestSchema.parse(value);
    input.log.driveModes.push(options?.driveMode);
    const latest = await loadLatestCheckpoint(input.supervisor, request);
    input.log.checkpointReads.push(latest?.stepIndex ?? null);
    const stepIndex = latest === null ? 0 : latest.stepIndex + 1;
    const completedStepIds =
      stepIndex === 0
        ? ["claim-run", "fake-node"]
        : ["claim-run", "fake-node", "terminal-project"];
    const checkpoint = buildCheckpoint({
      completedStepIds,
      request,
      stepIndex,
    });

    await persistCheckpoint(input.supervisor, {
      checkpoint,
      ...(options?.driveGeneration === undefined
        ? {}
        : { driveGeneration: options.driveGeneration }),
    });
    input.log.persistedStepIndexes.push(stepIndex);

    if (stepIndex === 0) {
      await recordProjection({
        d1: input.d1,
        eventCount: 2,
        request,
        state: "executingDynamicWorkflow",
        summary: "Carrier canary parked and checkpointed the fake node.",
      });

      return WorkflowRunPausedSchema.parse({
        completedStepIds,
        eventLog: [],
        runId: request.runId,
        status: "paused",
        stepIndex,
      });
    }

    await recordProjection({
      d1: input.d1,
      eventCount: 3,
      request,
      state: "blocked",
      summary: "Carrier canary terminally projected the resumed run.",
    });

    return WorkflowRunBlockedSchema.parse({
      blocker: {
        code: "adapter_unavailable",
        message: "Carrier canary terminal blocker.",
        redacted: true,
      },
      eventLog: [],
      runId: request.runId,
      status: "blocked",
    });
  },
});

describe("workflow carrier composition acceptance", () => {
  it("claims in D1, parks in the supervisor DO, resumes from checkpoint, and reads events from D1", async () => {
    const d1 = createFakeD1();
    const log: CarrierFrontDoorLog = {
      checkpointReads: [],
      driveModes: [],
      persistedStepIndexes: [],
    };
    const request = WorkflowRunRequestSchema.parse({
      ...buildIntegrationTestRunRequest(),
      runId: "run-carrier-composition-acceptance",
      workItemId: "work-item:carrier-composition",
    });
    const state = createFakeDurableObjectState();
    const firstSupervisor = createSupervisor(state, d1.d1);

    __capsuleSupervisorTestHooks.setRunDriverFactory((_env, supervisor) =>
      createCarrierFrontDoor({
        d1: d1.d1,
        log,
        supervisor,
      })
    );

    try {
      await recordProjection({
        d1: d1.d1,
        eventCount: 1,
        request,
        state: "resolvingCapsule",
        summary: "Carrier canary claimed the run in D1.",
      });

      const accepted = await startRun(firstSupervisor, request);

      await firstSupervisor.alarm();
      const firstDump = await durability(firstSupervisor, request);

      const freshSupervisor = createSupervisor(state, d1.d1);
      await freshSupervisor.alarm();

      const stateSizeBeforeD1Read = state.store.size;
      const eventStream = await createCloudflareWorkflowEventStreamReader({
        d1: d1.d1,
        now: () => "2026-06-17T01:59:00.000Z",
      }).read({ runId: request.runId });
      const parsedEventStream =
        WorkflowEventStreamDocumentSchema.parse(eventStream);

      expect({
        accepted,
        checkpointReads: log.checkpointReads,
        driveModes: log.driveModes,
        eventStates: parsedEventStream.events.map((entry) => entry.event.state),
        finalRunStartRecordPresent: state.store.has(
          `run-start:${request.runId}`
        ),
        firstAlarmCheckpoint: firstDump.checkpoint,
        latestStatus: parsedEventStream.latestStatus,
        persistedStepIndexes: log.persistedStepIndexes,
        stateSizeStableDuringD1Read: state.store.size === stateSizeBeforeD1Read,
      }).toStrictEqual({
        accepted: {
          runId: request.runId,
          status: "accepted",
        },
        checkpointReads: [null, 0],
        driveModes: ["single-step", "single-step"],
        eventStates: [
          "resolvingCapsule",
          "executingDynamicWorkflow",
          "blocked",
        ],
        finalRunStartRecordPresent: false,
        firstAlarmCheckpoint: {
          completedStepCount: 2,
          completedStepIds: ["claim-run", "fake-node"],
          outputArtifactRefCount: 1,
          outputArtifactRefs: [outputArtifactRefFor(request, 0)],
          persistedAt: "2026-06-17T01:50:00.000Z",
          stepIndex: 0,
        },
        latestStatus: "blocked",
        persistedStepIndexes: [0, 1],
        stateSizeStableDuringD1Read: true,
      });
    } finally {
      __capsuleSupervisorTestHooks.resetRunDriverFactory();
    }
  });
});
