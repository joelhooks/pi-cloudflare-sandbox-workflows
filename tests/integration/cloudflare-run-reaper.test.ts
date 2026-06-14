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
            // Status reader (createCloudflareWorkflowRunStatusReader): a single
            // `where run_id = ?` lookup selecting blocker columns. Distinguished
            // from the reaper's stuck-run select (which scans by work_item_id)
            // purely by the `blocker_code` projection — no other query selects it.
            if (query.includes("blocker_code")) {
              const runId = values.at(0);
              const run = runs.find((candidate) => candidate.run_id === runId);

              return Promise.resolve({
                results:
                  run === undefined
                    ? []
                    : [
                        {
                          blocker_code: null,
                          blocker_message: null,
                          blocker_node_type: null,
                          blocker_step_id: null,
                          run_id: run.run_id,
                          status: run.status,
                        },
                      ],
              });
            }
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

  // Wound #24: a terminal run still holding a lane-owner slot IS the leak. The
  // reaper itself correctly never re-reaps a terminal run (no duplicate failed
  // event), but the alarm's safety-net reclaim now frees the slot the captured
  // run was squatting — the reaper's terminal-exclusion never released it, which
  // is exactly how the cap jammed. (Pre-fix this asserted the slot stayed held.)
  it("alarm reclaims a terminal run's leaked slot without re-reaping the run", async () => {
    const d1 = createFakeD1({ runs: [buildRun({ status: "captured" })] });
    const state = createFakeDurableObjectState();
    const supervisor = createSupervisor({ d1: d1.d1, state });

    await admit(supervisor, "lane-a");
    await supervisor.alarm();

    expect(d1.runs[0]?.status).toBe("captured");
    expect(d1.events).toStrictEqual([]);
    const record = await getRecord(supervisor);
    expect(record.activeLaneIds).toStrictEqual([]);
    expect(record.failedLaneIds).toStrictEqual(["lane-a"]);
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

// Wound #22: a re-drive must RECLAIM its own orphaned lane-owner reservation.
// The zombie-budget pre-admit (wound #16) reserves a lane's owner slot before
// dispatch; a drive torn between that reservation and the matching lane release
// leaves the slot held with no live process behind it. Lane ids are run-scoped
// (`lane:<kind>:<runId>...`), so the only thing that can ever collide with that
// slot is the SAME run's next drive — admission must re-admit it, not defer
// `already-active`. The deferral was converted by the planner into a terminal
// `adapter_unavailable`, which killed every re-drive's recovery (proven live:
// run-live-20260614T085001608Z planning -> blocked in 69ms, planner never ran).
const readDecision = async (response: Response) =>
  z
    .object({ reason: z.string().optional(), status: z.string() })
    .parse(await response.json());

describe("Capsule supervisor lane admission reclaim", () => {
  it("re-admits a run colliding with its own orphaned lane owner", async () => {
    const d1 = createFakeD1({ runs: [buildRun()] });
    const state = createFakeDurableObjectState();
    const supervisor = createSupervisor({ d1: d1.d1, state });
    const laneId = "lane:planner:run-reaper-test";

    // First admission reserves the owner slot.
    const first = await readDecision(await admit(supervisor, laneId));
    expect(first.status).toBe("admitted");

    // The drive tears here: the owner slot persists with no release. The run's
    // next drive re-admits the SAME lane and must reclaim its own orphan rather
    // than be deferred against itself.
    const reclaim = await readDecision(await admit(supervisor, laneId));
    expect(reclaim.status).toBe("admitted");

    // The reclaim does not leak a second owner: exactly one slot stays held.
    const record = await getRecord(supervisor);
    expect(record.activeLaneIds).toStrictEqual([laneId]);
    expect(record.activeLaneOwners).toStrictEqual({
      [laneId]: "run-reaper-test",
    });
  });

  it("still defers a DIFFERENT run colliding with an active lane owner", async () => {
    const d1 = createFakeD1({ runs: [buildRun()] });
    const state = createFakeDurableObjectState();
    const supervisor = createSupervisor({ d1: d1.d1, state });
    const laneId = "lane:planner:run-owner";

    const owner = await readDecision(
      await admit(supervisor, laneId, "run-owner")
    );
    expect(owner.status).toBe("admitted");

    // A different run must NOT reclaim someone else's slot — the safety branch
    // holds even though run-scoped lane ids make this impossible in production.
    const intruder = await readDecision(
      await admit(supervisor, laneId, "run-intruder")
    );
    expect(intruder).toStrictEqual({
      reason: "already-active",
      status: "deferred",
    });

    // The intruder neither stole nor duplicated ownership.
    const record = await getRecord(supervisor);
    expect(record.activeLaneOwners).toStrictEqual({ [laneId]: "run-owner" });
  });
});

// Wound #24: the cap death spiral. The supervisor DO is keyed by workItemId, so
// EVERY dream run shares one `activeLaneOwners` map against a global cap of three.
// The reaper only releases a slot for a run IT transitions; a run that reaches a
// terminal status WITHOUT being reaped — it self-blocked, or driveQueuedRuns
// retired its record once D1 already showed it terminal — leaves its lane-owner
// slot squatting forever with no live process behind it. Three such leaks jam the
// cap permanently and every new run dies at planner admission with
// `concurrency-cap-full` (proven live: 38 blocked runs squatting slots, fresh
// runs dying ~29s at admission). admitLaneCore now reclaims terminal-owner slots
// before deferring, and alarm() sweeps them as a periodic safety net. The doubles
// are hostile (the polite-fakes discipline): the leaked owners are REAL terminal
// rows in the authoritative store, reclaimed only on explicit terminal status —
// never on absence of a row, which would yank an in-flight run's reservation.
describe("Capsule supervisor cap reclaim (Wound #24)", () => {
  const fillCap = async (
    supervisor: CloudflareWorkflowCapsuleSupervisorInstance,
    runIds: readonly string[]
  ): Promise<void> => {
    for (const runId of runIds) {
      const decision = await readDecision(
        await admit(supervisor, `lane:planner:${runId}`, runId)
      );
      expect(decision.status).toBe("admitted");
    }
  };

  it("reclaims leaked terminal-owner slots so a fresh run is admitted instead of dying at a jammed cap", async () => {
    // Three distinct runs squat the cap, then all three go terminal in D1 with
    // their slots never released — the exact leak. blocked AND captured both
    // count as terminal; a captured leak must release too.
    const d1 = createFakeD1({
      runs: [
        buildRun({ run_id: "run-leak-1", status: "blocked" }),
        buildRun({ run_id: "run-leak-2", status: "blocked" }),
        buildRun({ run_id: "run-leak-3", status: "captured" }),
        buildRun({ run_id: "run-fresh", status: "executingDynamicWorkflow" }),
      ],
    });
    const state = createFakeDurableObjectState();
    const supervisor = createSupervisor({ d1: d1.d1, state });

    await fillCap(supervisor, ["run-leak-1", "run-leak-2", "run-leak-3"]);

    // Before the fix this dies: cap of three is full of leaked owners, so the
    // fresh run defers `concurrency-cap-full` (forged terminal by the planner).
    const fresh = await readDecision(
      await admit(supervisor, "lane:planner:run-fresh", "run-fresh")
    );

    expect(fresh.status).toBe("admitted");
    const record = await getRecord(supervisor);
    expect(record.activeLaneOwners).toStrictEqual({
      "lane:planner:run-fresh": "run-fresh",
    });
    // The three dead owners are reclaimed and recorded as force-released.
    expect(record.failedLaneIds).toStrictEqual([
      "lane:planner:run-leak-1",
      "lane:planner:run-leak-2",
      "lane:planner:run-leak-3",
    ]);
  });

  it("does NOT reclaim a cap full of LIVE owners: genuine backpressure still defers", async () => {
    const d1 = createFakeD1({
      runs: [
        buildRun({ run_id: "run-live-1", status: "executingDynamicWorkflow" }),
        buildRun({ run_id: "run-live-2", status: "executingDynamicWorkflow" }),
        buildRun({ run_id: "run-live-3", status: "executingDynamicWorkflow" }),
      ],
    });
    const state = createFakeDurableObjectState();
    const supervisor = createSupervisor({ d1: d1.d1, state });

    await fillCap(supervisor, ["run-live-1", "run-live-2", "run-live-3"]);

    const newcomer = await readDecision(
      await admit(supervisor, "lane:planner:run-newcomer", "run-newcomer")
    );

    // None of the three owners is terminal, so nothing is reclaimed and the cap
    // is genuinely full — this is real backpressure, deferred (not freed).
    expect(newcomer).toStrictEqual({
      reason: "concurrency-cap-full",
      status: "deferred",
    });
    const record = await getRecord(supervisor);
    expect(record.activeLaneIds).toStrictEqual([
      "lane:planner:run-live-1",
      "lane:planner:run-live-2",
      "lane:planner:run-live-3",
    ]);
    expect(record.failedLaneIds).toStrictEqual([]);
  });

  it("keeps the slot of an owner with NO authoritative row (in-flight): absence is not terminal", async () => {
    // The owners hold the cap but have no D1 row at all — the status reader
    // returns null for each. A polite reclaim would free the slot on "run not
    // found" and yank a still-launching run's reservation; the hostile-correct
    // reclaim treats null as alive and keeps every slot.
    const d1 = createFakeD1({ runs: [] });
    const state = createFakeDurableObjectState();
    const supervisor = createSupervisor({ d1: d1.d1, state });

    await fillCap(supervisor, ["run-ghost-1", "run-ghost-2", "run-ghost-3"]);

    const newcomer = await readDecision(
      await admit(supervisor, "lane:planner:run-newcomer", "run-newcomer")
    );

    expect(newcomer).toStrictEqual({
      reason: "concurrency-cap-full",
      status: "deferred",
    });
    const record = await getRecord(supervisor);
    expect(record.activeLaneIds).toStrictEqual([
      "lane:planner:run-ghost-1",
      "lane:planner:run-ghost-2",
      "lane:planner:run-ghost-3",
    ]);
    expect(record.failedLaneIds).toStrictEqual([]);
  });

  it("alarm safety net sweeps leaked terminal-owner slots with no admission probing", async () => {
    // No run-start records are queued (driveQueuedRuns is a no-op) and the runs
    // are already terminal so the reaper sweep finds nothing — only the new
    // safety-net reclaim drains the leaked slots on a bare alarm tick.
    const d1 = createFakeD1({
      runs: [
        buildRun({ run_id: "run-leak-1", status: "blocked" }),
        buildRun({ run_id: "run-leak-2", status: "captured" }),
      ],
    });
    const state = createFakeDurableObjectState();
    const supervisor = createSupervisor({ d1: d1.d1, state });

    await admit(supervisor, "lane:planner:run-leak-1", "run-leak-1");
    await admit(supervisor, "lane:planner:run-leak-2", "run-leak-2");
    await supervisor.alarm();

    const record = await getRecord(supervisor);
    expect(record.activeLaneIds).toStrictEqual([]);
    expect(record.failedLaneIds).toStrictEqual([
      "lane:planner:run-leak-1",
      "lane:planner:run-leak-2",
    ]);
  });
});
