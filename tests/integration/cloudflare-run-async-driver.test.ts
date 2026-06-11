import type * as CloudflareWorkersModule from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import type { WorkerFrontDoorContract } from "../../src/app/application/ports.ts";
import {
  WorkflowRunBlockedSchema,
  WorkflowRunRequestSchema,
} from "../../src/app/domain/schemas.ts";
import type { WorkflowRunRequest } from "../../src/app/domain/schemas.ts";
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
  state: FakeDurableObjectState
): CloudflareWorkflowCapsuleSupervisorInstance => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Vitest runs in Node; the Worker runtime provides a real DurableObjectState that this fake stands in for.
  const durableState = state as unknown as DurableObjectState;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The async driver path reads no env bindings under the injected factory; the runtime would inject them.
  const env = {} as unknown as WorkflowCapsuleSupervisorEnv;

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
});
