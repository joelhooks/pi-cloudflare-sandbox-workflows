import type * as CloudflareWorkersModule from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { WorkflowCapsuleSupervisorEnv } from "../../src/app/infrastructure/cloudflare-capsule-supervisor.ts";
import {
  REAPER_FAILED_STATE,
  reapStuckRunsForWorkItem,
} from "../../src/app/infrastructure/cloudflare-run-reaper.ts";

class StubDurableObject {
  protected readonly ctx: unknown;
  protected readonly env: unknown;

  constructor(ctx: unknown, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}

// Vitest runs in Node, where the `cloudflare:workers` virtual module is
// unresolvable. Stub the `DurableObject` base so the supervisor DO (and its
// reaper alarm) can be exercised without the workerd runtime. The real module
// exports many RPC-branded symbols; the supervisor only needs this base class.
const cloudflareWorkersStub = { DurableObject: StubDurableObject };
vi.mock(
  import("cloudflare:workers"),
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The partial stub provides only the DurableObject base the supervisor extends.
  () => cloudflareWorkersStub as unknown as typeof CloudflareWorkersModule
);

const { CloudflareWorkflowCapsuleSupervisor } =
  await import("../../src/app/infrastructure/cloudflare-capsule-supervisor.ts");
type CloudflareWorkflowCapsuleSupervisorInstance = InstanceType<
  typeof CloudflareWorkflowCapsuleSupervisor
>;

type D1QueryValue = null | number | string;

interface RunRow {
  actor_id: string;
  capsule_id: string;
  run_id: string;
  status: string;
  updated_at: string;
  work_item_id: string;
}

interface EventRow {
  readonly event_index: number;
  readonly run_id: string;
  readonly state: string;
  readonly summary: string;
}

const TERMINAL = new Set(["blocked", "captured"]);

const createFakeD1 = (input: { readonly runs: RunRow[] }) => {
  const { runs } = input;
  const events: EventRow[] = [];

  const maxEventIndex = (runId: string): null | number => {
    const indexes = events
      .filter((event) => event.run_id === runId)
      .map((event) => event.event_index);

    return indexes.length === 0 ? null : Math.max(...indexes);
  };

  const selectStuck = (values: readonly D1QueryValue[]) => {
    const [workItemId, ...rest] = values;
    const cutoff = String(rest.at(-1));
    const matched = runs.filter(
      (run) =>
        run.work_item_id === workItemId &&
        !TERMINAL.has(run.status) &&
        run.updated_at < cutoff
    );

    return {
      results: matched.map((run) => ({
        actor_id: run.actor_id,
        capsule_id: run.capsule_id,
        event_index: maxEventIndex(run.run_id),
        run_id: run.run_id,
        status: run.status,
        work_item_id: run.work_item_id,
      })),
    };
  };

  const runUpdate = (
    values: readonly D1QueryValue[]
  ): { meta: { changes: number }; success: true } => {
    const [status, updatedAt, runId] = values;
    const run = runs.find((candidate) => candidate.run_id === runId);
    if (run === undefined || TERMINAL.has(run.status)) {
      return { meta: { changes: 0 }, success: true };
    }
    run.status = String(status);
    run.updated_at = String(updatedAt);

    return { meta: { changes: 1 }, success: true };
  };

  const runEventInsert = (values: readonly D1QueryValue[]) => {
    const runId = values.at(0);
    const eventIndex = values.at(1);
    const state = values.at(5);
    const summary = values.at(6);
    const exists = events.some(
      (event) =>
        event.run_id === runId && event.event_index === Number(eventIndex)
    );
    if (!exists) {
      events.push({
        event_index: Number(eventIndex),
        run_id: String(runId),
        state: String(state),
        summary: String(summary),
      });
    }

    return { success: true };
  };

  return {
    d1: {
      prepare(query: string) {
        const statementFor = (values: readonly D1QueryValue[] = []) => ({
          all() {
            if (query.includes("from runs")) {
              return Promise.resolve(selectStuck(values));
            }

            return Promise.resolve({ results: [] });
          },
          bind(...boundValues: D1QueryValue[]) {
            return statementFor(boundValues);
          },
          run() {
            if (query.includes("update runs")) {
              return Promise.resolve(runUpdate(values));
            }

            if (query.includes("insert into workflow_events")) {
              return Promise.resolve(runEventInsert(values));
            }

            return Promise.resolve({ success: true });
          },
        });

        return statementFor();
      },
    },
    events,
    runs,
  };
};

const buildRun = (overrides: Partial<RunRow> = {}): RunRow => ({
  actor_id: "actor:reaper-test",
  capsule_id: "capsule:work-item:reaper-test",
  run_id: "run-reaper-test",
  status: "executingDynamicWorkflow",
  updated_at: "2026-06-10T00:00:00.000Z",
  work_item_id: "work-item:reaper-test",
  ...overrides,
});

describe("Cloudflare run reaper", () => {
  it("marks a stuck non-terminal run failed and reports it for slot release", async () => {
    const d1 = createFakeD1({ runs: [buildRun()] });

    const result = await reapStuckRunsForWorkItem({
      d1: d1.d1,
      now: () => "2026-06-10T00:11:00.000Z",
      timeoutMs: 600_000,
      workItemId: "work-item:reaper-test",
    });

    expect(result.reapedRunIds).toStrictEqual(["run-reaper-test"]);
    expect(d1.runs[0]?.status).toBe(REAPER_FAILED_STATE);
    expect(d1.events).toStrictEqual([
      {
        event_index: 1,
        run_id: "run-reaper-test",
        state: REAPER_FAILED_STATE,
        summary:
          "Run reaped: stuck in a non-terminal state past WORKFLOW_APP_TIMEOUT_MS (600000ms).",
      },
    ]);
  });

  it("does not reap a run still inside the timeout window", async () => {
    const d1 = createFakeD1({
      runs: [buildRun({ updated_at: "2026-06-10T00:10:30.000Z" })],
    });

    const result = await reapStuckRunsForWorkItem({
      d1: d1.d1,
      now: () => "2026-06-10T00:11:00.000Z",
      timeoutMs: 600_000,
      workItemId: "work-item:reaper-test",
    });

    expect(result.reapedRunIds).toStrictEqual([]);
    expect(d1.runs[0]?.status).toBe("executingDynamicWorkflow");
    expect(d1.events).toStrictEqual([]);
  });

  it("leaves a terminal run untouched", async () => {
    const d1 = createFakeD1({ runs: [buildRun({ status: "captured" })] });

    const result = await reapStuckRunsForWorkItem({
      d1: d1.d1,
      now: () => "2026-06-10T01:00:00.000Z",
      timeoutMs: 600_000,
      workItemId: "work-item:reaper-test",
    });

    expect(result.reapedRunIds).toStrictEqual([]);
    expect(d1.runs[0]?.status).toBe("captured");
    expect(d1.events).toStrictEqual([]);
  });

  it("is idempotent: a second sweep of an already-reaped run is a no-op", async () => {
    const d1 = createFakeD1({ runs: [buildRun()] });

    const first = await reapStuckRunsForWorkItem({
      d1: d1.d1,
      now: () => "2026-06-10T00:11:00.000Z",
      timeoutMs: 600_000,
      workItemId: "work-item:reaper-test",
    });
    const second = await reapStuckRunsForWorkItem({
      d1: d1.d1,
      now: () => "2026-06-10T00:22:00.000Z",
      timeoutMs: 600_000,
      workItemId: "work-item:reaper-test",
    });

    expect(first.reapedRunIds).toStrictEqual(["run-reaper-test"]);
    expect(second.reapedRunIds).toStrictEqual([]);
    expect(d1.events).toHaveLength(1);
  });
});

interface FakeDurableObjectState {
  readonly storage: {
    delete(key: string): Promise<void>;
    deleteAlarm(): Promise<void>;
    get(key: string): Promise<unknown>;
    getAlarm(): Promise<null | number>;
    list(options: { prefix: string }): Promise<Map<string, unknown>>;
    put(key: string, value: unknown): Promise<void>;
    setAlarm(scheduledTime: number): Promise<void>;
  };
}

const createFakeDurableObjectState = (): FakeDurableObjectState => {
  const store = new Map<string, unknown>();
  let alarm: null | number = null;

  return {
    storage: {
      delete(key: string) {
        store.delete(key);

        return Promise.resolve();
      },
      deleteAlarm() {
        alarm = null;

        return Promise.resolve();
      },
      get(key: string) {
        return Promise.resolve(store.get(key));
      },
      getAlarm() {
        return Promise.resolve(alarm);
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
      setAlarm(scheduledTime: number) {
        alarm = scheduledTime;

        return Promise.resolve();
      },
    },
  };
};

const createSupervisor = (input: {
  readonly d1: WorkflowCapsuleSupervisorEnv["WORKFLOW_APP_D1"];
  readonly state: FakeDurableObjectState;
}): CloudflareWorkflowCapsuleSupervisorInstance => {
  const env = {
    WORKFLOW_APP_D1: input.d1,
    WORKFLOW_APP_TIMEOUT_MS: 600_000,
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Vitest runs in Node; the Worker runtime provides a real DurableObjectState that this fake stands in for.
  const state = input.state as unknown as DurableObjectState;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- WORKFLOW_CAPSULE_SUPERVISOR is unused by the reaper path; the runtime would inject it.
  const supervisorEnv = env as unknown as WorkflowCapsuleSupervisorEnv;

  return new CloudflareWorkflowCapsuleSupervisor(state, supervisorEnv);
};

const RecordSnapshotSchema = z.object({
  activeLaneOwners: z.record(z.string(), z.string()),
  failedLaneIds: z.array(z.string()),
});

const admit = (
  supervisor: CloudflareWorkflowCapsuleSupervisorInstance,
  laneId: string,
  runId = "run-reaper-test"
): Promise<Response> =>
  supervisor.fetch(
    new Request("https://supervisor.internal/admit-lane", {
      body: JSON.stringify({
        kind: "planner",
        laneId,
        maxActiveLanes: 3,
        requestedAt: "2026-06-10T00:00:00.000Z",
        runId,
        workItemId: "work-item:reaper-test",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
  );

const persistCheckpoint = (
  supervisor: CloudflareWorkflowCapsuleSupervisorInstance,
  input: { readonly persistedAt: string; readonly runId: string }
): Promise<Response> =>
  supervisor.fetch(
    new Request("https://supervisor.internal/persist-checkpoint", {
      body: JSON.stringify({
        checkpoint: {
          completedStepIds: ["step-one"],
          envelopeSnapshot: { status: "active" },
          generatedMachineSnapshot: { status: "active" },
          outputArtifactRefs: [],
          persistedAt: input.persistedAt,
          runId: input.runId,
          schemaVersion: "workflow.run-step-checkpoint.v1",
          stepIndex: 0,
          workItemId: "work-item:reaper-test",
        },
        workItemId: "work-item:reaper-test",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
  );

interface RecordSnapshot {
  readonly activeLaneIds: readonly string[];
  readonly activeLaneOwners: Readonly<Record<string, string>>;
  readonly failedLaneIds: readonly string[];
}

const getRecord = async (
  supervisor: CloudflareWorkflowCapsuleSupervisorInstance
): Promise<RecordSnapshot> => {
  const response = await supervisor.fetch(
    new Request("https://supervisor.internal/record")
  );
  const record = RecordSnapshotSchema.parse(await response.json());

  return {
    activeLaneIds: Object.keys(record.activeLaneOwners),
    activeLaneOwners: record.activeLaneOwners,
    failedLaneIds: record.failedLaneIds,
  };
};

describe("Capsule supervisor reaper alarm", () => {
  it("admission arms the reaper alarm idempotently", async () => {
    const d1 = createFakeD1({ runs: [buildRun()] });
    const state = createFakeDurableObjectState();
    const supervisor = createSupervisor({ d1: d1.d1, state });

    await admit(supervisor, "lane-a");
    const firstAlarm = await state.storage.getAlarm();
    await admit(supervisor, "lane-b");
    const secondAlarm = await state.storage.getAlarm();

    expect(firstAlarm).not.toBeNull();
    expect(secondAlarm).toBe(firstAlarm);
  });

  it("alarm reaps a stuck run and releases its leaked admission slot", async () => {
    const d1 = createFakeD1({ runs: [buildRun()] });
    const state = createFakeDurableObjectState();
    const supervisor = createSupervisor({ d1: d1.d1, state });

    await admit(supervisor, "lane-a");
    await supervisor.alarm();

    expect(d1.runs[0]?.status).toBe(REAPER_FAILED_STATE);
    const record = await getRecord(supervisor);
    expect(record.activeLaneIds).toStrictEqual([]);
    expect(record.failedLaneIds).toStrictEqual(["lane-a"]);
  });

  it("alarm leaves a terminal run and its slot untouched", async () => {
    const d1 = createFakeD1({ runs: [buildRun({ status: "captured" })] });
    const state = createFakeDurableObjectState();
    const supervisor = createSupervisor({ d1: d1.d1, state });

    await admit(supervisor, "lane-a");
    await supervisor.alarm();

    expect(d1.runs[0]?.status).toBe("captured");
    const record = await getRecord(supervisor);
    expect(record.activeLaneIds).toStrictEqual(["lane-a"]);
    expect(record.failedLaneIds).toStrictEqual([]);
  });

  it("a second alarm after a reap is a no-op", async () => {
    const d1 = createFakeD1({ runs: [buildRun()] });
    const state = createFakeDurableObjectState();
    const supervisor = createSupervisor({ d1: d1.d1, state });

    await admit(supervisor, "lane-a");
    await supervisor.alarm();
    await supervisor.alarm();

    expect(d1.events).toHaveLength(1);
    const record = await getRecord(supervisor);
    expect(record.activeLaneIds).toStrictEqual([]);
    expect(record.failedLaneIds).toStrictEqual(["lane-a"]);
  });

  // FIX 2: reaping one run on a workItemId shared by two runs must release only
  // the reaped run's lanes, leaving the healthy concurrent run's lanes active.
  it("scopes slot release to the reaped run's lanes on a shared work item", async () => {
    const d1 = createFakeD1({
      runs: [
        buildRun({ run_id: "run-stuck" }),
        buildRun({ run_id: "run-healthy" }),
      ],
    });
    const state = createFakeDurableObjectState();
    const supervisor = createSupervisor({ d1: d1.d1, state });

    await admit(supervisor, "lane-stuck", "run-stuck");
    await admit(supervisor, "lane-healthy", "run-healthy");
    // A fresh checkpoint keeps the healthy run making forward progress, so the
    // reaper protects it; only the wedged (checkpointless) run is swept.
    await persistCheckpoint(supervisor, {
      persistedAt: new Date().toISOString(),
      runId: "run-healthy",
    });
    await supervisor.alarm();

    const record = await getRecord(supervisor);
    expect({
      activeLaneOwners: record.activeLaneOwners,
      failedLaneIds: record.failedLaneIds,
      healthyStatus: d1.runs.find((run) => run.run_id === "run-healthy")
        ?.status,
      stuckStatus: d1.runs.find((run) => run.run_id === "run-stuck")?.status,
    }).toStrictEqual({
      activeLaneOwners: { "lane-healthy": "run-healthy" },
      failedLaneIds: ["lane-stuck"],
      healthyStatus: "executingDynamicWorkflow",
      stuckStatus: REAPER_FAILED_STATE,
    });
  });

  // FIX 1 reconciliation: a wedged run whose latest checkpoint is also stale (no
  // forward progress past the timeout) is still swept; a run with a fresh
  // checkpoint is protected because the driver still owns its resume.
  it("sweeps a wedged run with a stale checkpoint but protects one with a fresh checkpoint", async () => {
    const d1 = createFakeD1({
      runs: [
        buildRun({ run_id: "run-wedged" }),
        buildRun({ run_id: "run-resuming" }),
      ],
    });
    const state = createFakeDurableObjectState();
    const supervisor = createSupervisor({ d1: d1.d1, state });

    await admit(supervisor, "lane-wedged", "run-wedged");
    await admit(supervisor, "lane-resuming", "run-resuming");
    // Stale checkpoint: persisted long before the cutoff -> wedged, reapable.
    await persistCheckpoint(supervisor, {
      persistedAt: "2026-06-10T00:00:00.000Z",
      runId: "run-wedged",
    });
    // Fresh checkpoint: persisted just now -> forward progress, protected.
    await persistCheckpoint(supervisor, {
      persistedAt: new Date().toISOString(),
      runId: "run-resuming",
    });
    await supervisor.alarm();

    const record = await getRecord(supervisor);
    expect({
      activeLaneOwners: record.activeLaneOwners,
      failedLaneIds: record.failedLaneIds,
      resumingStatus: d1.runs.find((run) => run.run_id === "run-resuming")
        ?.status,
      wedgedStatus: d1.runs.find((run) => run.run_id === "run-wedged")?.status,
    }).toStrictEqual({
      activeLaneOwners: { "lane-resuming": "run-resuming" },
      failedLaneIds: ["lane-wedged"],
      resumingStatus: "executingDynamicWorkflow",
      wedgedStatus: REAPER_FAILED_STATE,
    });
  });
});
