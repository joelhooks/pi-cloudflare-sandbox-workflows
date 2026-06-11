import type * as CloudflareWorkersModule from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import {
  LoadRunCheckpointResolutionSchema,
  RunStepCheckpointSchema,
} from "../../src/app/domain/schemas.ts";
import type { RunStepCheckpoint } from "../../src/app/domain/schemas.ts";
import type { WorkflowCapsuleSupervisorEnv } from "../../src/app/infrastructure/cloudflare-capsule-supervisor.ts";

class StubDurableObject {
  protected readonly ctx: unknown;
  protected readonly env: unknown;

  constructor(ctx: unknown, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}

// Vitest runs in Node, where `cloudflare:workers` is unresolvable. Stub the
// `DurableObject` base so the supervisor DO (and its checkpoint storage) can be
// exercised without the workerd runtime.
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
    list(options: { prefix: string }): Promise<Map<string, unknown>>;
    put(key: string, value: unknown): Promise<void>;
  };
}

const createFakeDurableObjectState = (): FakeDurableObjectState => {
  const store = new Map<string, unknown>();

  return {
    storage: {
      get(key: string) {
        return Promise.resolve(store.get(key));
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
    },
    store,
  };
};

const createSupervisor = (
  state: FakeDurableObjectState
): CloudflareWorkflowCapsuleSupervisorInstance => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Vitest runs in Node; the Worker runtime provides a real DurableObjectState that this fake stands in for.
  const durableState = state as unknown as DurableObjectState;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The checkpoint path reads no env bindings; the runtime would inject them.
  const env = {} as unknown as WorkflowCapsuleSupervisorEnv;

  return new CloudflareWorkflowCapsuleSupervisor(durableState, env);
};

const buildCheckpoint = (
  overrides: Partial<RunStepCheckpoint> = {}
): RunStepCheckpoint =>
  RunStepCheckpointSchema.parse({
    completedStepIds: ["step-one"],
    envelopeSnapshot: { status: "active", value: "executingDynamicWorkflow" },
    generatedMachineSnapshot: { status: "active", value: "step_1_step-two" },
    outputArtifactRefs: ["artifact://workflow-app/runs/run-cp/step-one"],
    persistedAt: "2026-06-10T00:00:00.000Z",
    runId: "run-cp",
    schemaVersion: "workflow.run-step-checkpoint.v1",
    stepIndex: 0,
    workItemId: "work-item:checkpoint-test",
    ...overrides,
  });

const persist = (
  supervisor: CloudflareWorkflowCapsuleSupervisorInstance,
  checkpoint: RunStepCheckpoint
): Promise<Response> =>
  supervisor.fetch(
    new Request("https://supervisor.internal/persist-checkpoint", {
      body: JSON.stringify({
        checkpoint,
        workItemId: checkpoint.workItemId,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
  );

const loadLatest = async (
  supervisor: CloudflareWorkflowCapsuleSupervisorInstance,
  input: { readonly runId: string; readonly workItemId: string }
): Promise<RunStepCheckpoint | null> => {
  const response = await supervisor.fetch(
    new Request("https://supervisor.internal/load-latest-checkpoint", {
      body: JSON.stringify(input),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
  );
  return LoadRunCheckpointResolutionSchema.parse(await response.json())
    .checkpoint;
};

describe("Capsule supervisor run-step checkpoint", () => {
  it("persists a checkpoint to DO storage keyed by runId + stepIndex", async () => {
    const state = createFakeDurableObjectState();
    const supervisor = createSupervisor(state);
    const checkpoint = buildCheckpoint();

    const response = await persist(supervisor, checkpoint);

    expect(response.ok).toBeTruthy();
    expect(
      RunStepCheckpointSchema.parse(state.store.get("checkpoint:run-cp:0"))
    ).toStrictEqual(checkpoint);
  });

  it("keeps a distinct slot for each step index", async () => {
    const state = createFakeDurableObjectState();
    const supervisor = createSupervisor(state);

    await persist(supervisor, buildCheckpoint({ stepIndex: 0 }));
    await persist(
      supervisor,
      buildCheckpoint({
        completedStepIds: ["step-one", "step-two"],
        stepIndex: 1,
      })
    );

    expect(state.store.has("checkpoint:run-cp:0")).toBeTruthy();
    expect(state.store.has("checkpoint:run-cp:1")).toBeTruthy();
    expect(
      RunStepCheckpointSchema.parse(state.store.get("checkpoint:run-cp:1"))
        .completedStepIds
    ).toStrictEqual(["step-one", "step-two"]);
  });

  it("re-persisting the same step is a stable idempotent overwrite", async () => {
    const state = createFakeDurableObjectState();
    const supervisor = createSupervisor(state);
    const checkpoint = buildCheckpoint();

    await persist(supervisor, checkpoint);
    const sizeAfterFirst = state.store.size;
    await persist(supervisor, checkpoint);

    expect(state.store.size).toBe(sizeAfterFirst);
    expect(
      RunStepCheckpointSchema.parse(state.store.get("checkpoint:run-cp:0"))
    ).toStrictEqual(checkpoint);
  });

  it("loads the highest-indexed checkpoint as the latest for resume", async () => {
    const state = createFakeDurableObjectState();
    const supervisor = createSupervisor(state);

    await persist(supervisor, buildCheckpoint({ stepIndex: 0 }));
    await persist(supervisor, buildCheckpoint({ stepIndex: 2 }));
    await persist(supervisor, buildCheckpoint({ stepIndex: 1 }));

    const latest = await loadLatest(supervisor, {
      runId: "run-cp",
      workItemId: "work-item:checkpoint-test",
    });

    expect(latest?.stepIndex).toBe(2);
  });

  it("returns a null resolution when the run never checkpointed", async () => {
    const state = createFakeDurableObjectState();
    const supervisor = createSupervisor(state);

    const latest = await loadLatest(supervisor, {
      runId: "run-never-ran",
      workItemId: "work-item:checkpoint-test",
    });

    expect(latest).toBeNull();
  });

  it("scopes the latest checkpoint to its own run id", async () => {
    const state = createFakeDurableObjectState();
    const supervisor = createSupervisor(state);

    await persist(
      supervisor,
      buildCheckpoint({ runId: "run-other", stepIndex: 9 })
    );
    await persist(
      supervisor,
      buildCheckpoint({ runId: "run-cp", stepIndex: 1 })
    );

    const latest = await loadLatest(supervisor, {
      runId: "run-cp",
      workItemId: "work-item:checkpoint-test",
    });

    expect({
      runId: latest?.runId,
      stepIndex: latest?.stepIndex,
    }).toStrictEqual({
      runId: "run-cp",
      stepIndex: 1,
    });
  });
});
