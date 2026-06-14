import type * as CloudflareWorkersModule from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import {
  RunDurabilityDumpSchema,
  RunStepCheckpointSchema,
} from "../../src/app/domain/schemas.ts";
import type { RunStepCheckpoint } from "../../src/app/domain/schemas.ts";
import type { WorkflowCapsuleSupervisorEnv } from "../../src/app/infrastructure/cloudflare-capsule-supervisor.ts";
import {
  createCloudflareWorkflowRunsListReader,
  createCloudflareWorkflowRunWorkItemReader,
  WorkflowRunsListDocumentSchema,
  WorkflowRunsListQuerySchema,
} from "../../src/app/infrastructure/cloudflare-workflow-runs-list.ts";
import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1ResultLike,
} from "../../src/app/infrastructure/cloudflare-workflow-runs-list.ts";

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

const { CloudflareWorkflowCapsuleSupervisor } =
  await import("../../src/app/infrastructure/cloudflare-capsule-supervisor.ts");
type CloudflareWorkflowCapsuleSupervisorInstance = InstanceType<
  typeof CloudflareWorkflowCapsuleSupervisor
>;

interface FakeDurableObjectState {
  readonly store: Map<string, unknown>;
  readonly storage: {
    get(key: string): Promise<unknown>;
    getAlarm(): Promise<null | number>;
    list(options: { prefix: string }): Promise<Map<string, unknown>>;
    put(key: string, value: unknown): Promise<void>;
    setAlarm(at: number): Promise<void>;
  };
}

const createFakeDurableObjectState = (
  alarmAt: null | number = null
): FakeDurableObjectState => {
  const store = new Map<string, unknown>();
  let alarm = alarmAt;

  return {
    storage: {
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
      setAlarm(at: number) {
        alarm = at;

        return Promise.resolve();
      },
    },
    store,
  };
};

const createSupervisor = (
  state: FakeDurableObjectState,
  env: Partial<WorkflowCapsuleSupervisorEnv> = {}
): CloudflareWorkflowCapsuleSupervisorInstance => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Vitest runs in Node; the Worker runtime provides a real DurableObjectState that this fake stands in for.
  const durableState = state as unknown as DurableObjectState;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The durability path reads only timeout from env; the runtime would inject the full bindings.
  const supervisorEnv = env as unknown as WorkflowCapsuleSupervisorEnv;

  return new CloudflareWorkflowCapsuleSupervisor(durableState, supervisorEnv);
};

const buildCheckpoint = (
  overrides: Partial<RunStepCheckpoint> = {}
): RunStepCheckpoint =>
  RunStepCheckpointSchema.parse({
    completedStepIds: ["step-one", "step-two"],
    envelopeSnapshot: { status: "active", value: "executingDynamicWorkflow" },
    generatedMachineSnapshot: { status: "active", value: "step_2_step-three" },
    outputArtifactRefs: [
      "artifact://workflow-app/runs/run-dur/step-one",
      "artifact://workflow-app/runs/run-dur/step-two",
    ],
    persistedAt: "2026-06-11T00:00:00.000Z",
    runId: "run-dur",
    schemaVersion: "workflow.run-step-checkpoint.v1",
    stepIndex: 2,
    workItemId: "work-item:durability-test",
    ...overrides,
  });

const getDurability = async (
  supervisor: CloudflareWorkflowCapsuleSupervisorInstance,
  input: { readonly runId: string; readonly workItemId: string }
): Promise<unknown> => {
  const response = await supervisor.fetch(
    new Request("https://supervisor.internal/get-durability", {
      body: JSON.stringify(input),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
  );

  return await response.json();
};

interface FakeRunRow {
  readonly blocker_code?: null | string;
  readonly blocker_message?: null | string;
  readonly blocker_node_type?: null | string;
  readonly blocker_step_id?: null | string;
  readonly created_at: string;
  readonly run_id: string;
  readonly status: string;
  readonly updated_at: string;
  readonly work_item_id: string;
}

interface FakeD1Call {
  readonly bindings: readonly (null | number | string)[];
  readonly query: string;
}

const createFakeRunsD1 = (
  rows: readonly FakeRunRow[],
  calls: FakeD1Call[]
): D1DatabaseLike => ({
  prepare(query: string): D1PreparedStatementLike {
    const bindings: (null | number | string)[] = [];
    const statement: D1PreparedStatementLike = {
      all(): Promise<D1ResultLike> {
        calls.push({ bindings: [...bindings], query });
        // The list query trails with a limit binding; status (when present) is
        // bound first. Mirror the SQL the reader builds to filter + cap here.
        const statusFilter =
          query.includes("where status = ?") && typeof bindings[0] === "string"
            ? bindings[0]
            : null;
        const limit = bindings.at(-1);
        const filtered = rows.filter(
          (row) => statusFilter === null || row.status === statusFilter
        );
        const capped =
          typeof limit === "number" ? filtered.slice(0, limit) : filtered;

        return Promise.resolve({ results: capped });
      },
      bind(...values: (null | number | string)[]): D1PreparedStatementLike {
        bindings.push(...values);

        return statement;
      },
    };

    return statement;
  },
});

describe("Capsule supervisor run durability dump", () => {
  it("projects checkpoint, marker staleness, reaper due, alarm, and lane count", async () => {
    const state = createFakeDurableObjectState(1_700_000_500_000);
    const supervisor = createSupervisor(state, {
      WORKFLOW_APP_TIMEOUT_MS: "600000",
    });
    state.store.set("checkpoint:run-dur:2", buildCheckpoint());
    state.store.set("driving:run-dur", { startedAtMs: 1 });
    state.store.set("reaper-due-at", 1_700_000_900_000);
    state.store.set("run-start:run-dur", { runId: "run-dur" });
    state.store.set("record", {
      activeLaneOwners: {
        "lane-a": "run-dur",
        "lane-b": "run-other",
        "lane-c": "run-dur",
      },
      workItemId: "work-item:durability-test",
    });

    const dump = RunDurabilityDumpSchema.parse(
      await getDurability(supervisor, {
        runId: "run-dur",
        workItemId: "work-item:durability-test",
      })
    );

    expect({
      activeLaneCount: dump.activeLaneCount,
      alarmAtMs: dump.alarmAtMs,
      checkpoint: dump.checkpoint,
      drivingStale: dump.drivingMarker?.stale,
      hasRunStartRecord: dump.hasRunStartRecord,
      lastDriveFailure: dump.lastDriveFailure,
      reaperDueAtMs: dump.reaperDueAtMs,
      redacted: dump.redacted,
      runId: dump.runId,
      schemaVersion: dump.schemaVersion,
      workItemId: dump.workItemId,
    }).toStrictEqual({
      activeLaneCount: 2,
      alarmAtMs: 1_700_000_500_000,
      checkpoint: {
        completedStepCount: 2,
        completedStepIds: ["step-one", "step-two"],
        outputArtifactRefCount: 2,
        outputArtifactRefs: [
          "artifact://workflow-app/runs/run-dur/step-one",
          "artifact://workflow-app/runs/run-dur/step-two",
        ],
        persistedAt: "2026-06-11T00:00:00.000Z",
        stepIndex: 2,
      },
      drivingStale: true,
      hasRunStartRecord: true,
      lastDriveFailure: null,
      reaperDueAtMs: 1_700_000_900_000,
      redacted: true,
      runId: "run-dur",
      schemaVersion: "workflow.run-durability.v3",
      workItemId: "work-item:durability-test",
    });
  });

  it("returns null projections for a run with no durable state", async () => {
    const state = createFakeDurableObjectState();
    const supervisor = createSupervisor(state);

    const dump = RunDurabilityDumpSchema.parse(
      await getDurability(supervisor, {
        runId: "run-absent",
        workItemId: "work-item:durability-test",
      })
    );

    expect({
      activeLaneCount: dump.activeLaneCount,
      alarmAtMs: dump.alarmAtMs,
      checkpoint: dump.checkpoint,
      driveGeneration: dump.driveGeneration,
      drivingMarker: dump.drivingMarker,
      hasRunStartRecord: dump.hasRunStartRecord,
      laneDispatches: dump.laneDispatches,
      lastDriveFailure: dump.lastDriveFailure,
      nodeAttempts: dump.nodeAttempts,
      reaperDueAtMs: dump.reaperDueAtMs,
    }).toStrictEqual({
      activeLaneCount: 0,
      alarmAtMs: null,
      checkpoint: null,
      driveGeneration: null,
      drivingMarker: null,
      hasRunStartRecord: false,
      laneDispatches: [],
      lastDriveFailure: null,
      nodeAttempts: [],
      reaperDueAtMs: null,
    });
  });

  it("projects the drive ledger's node-attempt budget and lane dispatches, redacting lane infra ids", async () => {
    const state = createFakeDurableObjectState(1_700_000_500_000);
    const supervisor = createSupervisor(state, {
      WORKFLOW_APP_TIMEOUT_MS: "600000",
    });
    // A wedged-shape ledger: node 3 is a research.review lane sitting at attempt
    // 2 of 3 with a dispatch whose deadline has passed — exactly the state an
    // observer must be able to read to tell the zombie budget is accumulating
    // (or stuck) without guessing from the high-water checkpoint.
    state.store.set("drive-ledger:run-dur", {
      driveGeneration: 12,
      laneDispatches: {
        "node-3:review-generated-plan": {
          deadline: "2026-06-11T00:20:00.000Z",
          dispatchKey: "node-3:review-generated-plan",
          dispatchedAt: "2026-06-11T00:10:00.000Z",
          expectedOutputArtifactRefs: [
            "artifact://workflow-app/runs/run-dur/node-3/output",
          ],
          expectedReceiptArtifactRef:
            "artifact://workflow-app/runs/run-dur/node-3/receipt",
          kind: "worker",
          laneAuthLeaseId: "lease-secret-abc",
          laneId: "lane-research-review",
          nodeIndex: 3,
          nodeType: "joelclaw.research.review",
          processId: "proc-secret-xyz",
          promptArtifactRef:
            "artifact://workflow-app/runs/run-dur/node-3/prompt",
          runId: "run-dur",
          sandboxId: "sandbox-secret-1",
          schemaVersion: "workflow.drive-lane-dispatch.v1",
          status: "lane-dispatched",
          stepId: "review-generated-plan",
          workItemId: "work-item:durability-test",
        },
      },
      laneStatuses: {},
      lastDriveFailure: {
        at: "2026-06-11T00:16:00.000Z",
        driveGeneration: 12,
        message: "Error: redacted",
        stepIndexGuess: 3,
      },
      nodeAttempts: {
        "2": {
          attemptCount: 1,
          firstAttemptedAt: "2026-06-11T00:05:00.000Z",
          lastAttemptedAt: "2026-06-11T00:05:00.000Z",
          lastDriveGeneration: 5,
          nodeIndex: 2,
          nodeType: "joelclaw.memory.capture-artifact",
          stepId: "capture-generated-plan",
        },
        "3": {
          attemptCount: 2,
          firstAttemptedAt: "2026-06-11T00:10:00.000Z",
          lastAttemptedAt: "2026-06-11T00:15:00.000Z",
          lastDriveGeneration: 11,
          nodeIndex: 3,
          nodeType: "joelclaw.research.review",
          stepId: "review-generated-plan",
        },
      },
      phases: {},
      runId: "run-dur",
      schemaVersion: "workflow.drive-ledger.v1",
      updatedAt: "2026-06-11T00:15:00.000Z",
      workItemId: "work-item:durability-test",
    });

    const dump = RunDurabilityDumpSchema.parse(
      await getDurability(supervisor, {
        runId: "run-dur",
        workItemId: "work-item:durability-test",
      })
    );

    // driveGeneration surfaces, and node attempts come back sorted by nodeIndex
    // so the trail reads in execution order.
    expect(dump.driveGeneration).toBe(12);
    expect(dump.lastDriveFailure).toStrictEqual({
      at: "2026-06-11T00:16:00.000Z",
      driveGeneration: 12,
      message: "Error: redacted",
      stepIndexGuess: 3,
    });
    expect(dump.nodeAttempts).toStrictEqual([
      {
        attemptCount: 1,
        firstAttemptedAt: "2026-06-11T00:05:00.000Z",
        lastAttemptedAt: "2026-06-11T00:05:00.000Z",
        lastDriveGeneration: 5,
        nodeIndex: 2,
        nodeType: "joelclaw.memory.capture-artifact",
        stepId: "capture-generated-plan",
      },
      {
        attemptCount: 2,
        firstAttemptedAt: "2026-06-11T00:10:00.000Z",
        lastAttemptedAt: "2026-06-11T00:15:00.000Z",
        lastDriveGeneration: 11,
        nodeIndex: 3,
        nodeType: "joelclaw.research.review",
        stepId: "review-generated-plan",
      },
    ]);

    // The lane-dispatch projection carries the deadline diagnostic but drops the
    // infra identifiers so the dump stays redacted.
    expect(dump.laneDispatches).toStrictEqual([
      {
        deadline: "2026-06-11T00:20:00.000Z",
        dispatchKey: "node-3:review-generated-plan",
        dispatchedAt: "2026-06-11T00:10:00.000Z",
        kind: "worker",
        nodeIndex: 3,
        nodeType: "joelclaw.research.review",
        status: "lane-dispatched",
        stepId: "review-generated-plan",
      },
    ]);
    const projectedKeys = Object.keys(dump.laneDispatches[0] ?? {});
    for (const leaked of [
      "laneAuthLeaseId",
      "processId",
      "sandboxId",
      "promptArtifactRef",
      "expectedReceiptArtifactRef",
      "expectedOutputArtifactRefs",
      "laneId",
    ]) {
      expect(projectedKeys).not.toContain(leaked);
    }
  });
});

describe("Cloudflare workflow runs list reader", () => {
  const blockedRow: FakeRunRow = {
    blocker_code: "capability_denied",
    blocker_message: "Run blocked: capability denied for memory capture.",
    blocker_node_type: "joelclaw.memory.capture-artifact",
    blocker_step_id: "step-capture-artifact",
    created_at: "2026-06-11 00:00:00",
    run_id: "run-blocked",
    status: "blocked",
    updated_at: "2026-06-11 00:05:00",
    work_item_id: "work-item:one",
  };
  const capturedRow: FakeRunRow = {
    created_at: "2026-06-11 00:01:00",
    run_id: "run-captured",
    status: "captured",
    updated_at: "2026-06-11 00:06:00",
    work_item_id: "work-item:two",
  };

  it("lists runs with blocker detail and an echoed clamped query", async () => {
    const calls: FakeD1Call[] = [];
    const reader = createCloudflareWorkflowRunsListReader({
      d1: createFakeRunsD1([blockedRow, capturedRow], calls),
      now: () => "2026-06-11T01:00:00.000Z",
    });

    const document = WorkflowRunsListDocumentSchema.parse(
      await reader.list(WorkflowRunsListQuerySchema.parse({}))
    );

    expect({
      query: document.query,
      runCount: document.runCount,
      runs: document.runs,
      schemaVersion: document.schemaVersion,
    }).toStrictEqual({
      query: { limit: 50 },
      runCount: 2,
      runs: [
        {
          blocker: {
            code: "capability_denied",
            message: "Run blocked: capability denied for memory capture.",
            nodeType: "joelclaw.memory.capture-artifact",
            redacted: true,
            stepId: "step-capture-artifact",
          },
          createdAt: "2026-06-11 00:00:00",
          runId: "run-blocked",
          status: "blocked",
          updatedAt: "2026-06-11 00:05:00",
          workItemId: "work-item:one",
        },
        {
          createdAt: "2026-06-11 00:01:00",
          runId: "run-captured",
          status: "captured",
          updatedAt: "2026-06-11 00:06:00",
          workItemId: "work-item:two",
        },
      ],
      schemaVersion: "workflow.runs-list.v1",
    });
  });

  it("filters by status and clamps the limit", async () => {
    const calls: FakeD1Call[] = [];
    const reader = createCloudflareWorkflowRunsListReader({
      d1: createFakeRunsD1([blockedRow, capturedRow], calls),
      now: () => "2026-06-11T01:00:00.000Z",
    });

    const document = await reader.list(
      WorkflowRunsListQuerySchema.parse({ limit: "1000", status: "blocked" })
    );

    expect({
      boundStatus: calls.at(0)?.bindings.at(0),
      effectiveLimit: document.query.limit,
      runIds: document.runs.map((run) => run.runId),
      status: document.query.status,
    }).toStrictEqual({
      boundStatus: "blocked",
      effectiveLimit: 200,
      runIds: ["run-blocked"],
      status: "blocked",
    });
  });

  it("resolves the work item id that owns a run, or null when unknown", async () => {
    const calls: FakeD1Call[] = [];
    const reader = createCloudflareWorkflowRunWorkItemReader({
      d1: createFakeRunsD1([blockedRow], calls),
    });

    const found = await reader.read({ runId: "run-blocked" });
    const missingReader = createCloudflareWorkflowRunWorkItemReader({
      d1: createFakeRunsD1([], calls),
    });
    const missing = await missingReader.read({ runId: "run-absent" });

    expect({ found, missing }).toStrictEqual({
      found: "work-item:one",
      missing: null,
    });
  });
});
