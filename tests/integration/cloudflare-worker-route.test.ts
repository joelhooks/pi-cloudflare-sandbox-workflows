import { describe, expect, it } from "vitest";

import type { WorkerFrontDoorContract } from "../../src/app/application/ports.ts";
import {
  ArtifactRefSchema,
  WorkflowDebuggerAttachDocumentSchema,
  WorkflowEventStreamDocumentSchema,
  WorkflowRunBlockedSchema,
  WorkflowRunRequestSchema,
} from "../../src/app/domain/schemas.ts";
import { parseCloudflarePackageArtifactRef } from "../../src/app/infrastructure/cloudflare-package-artifacts-reader.ts";
import {
  PackageSeedFinalizeRequestSchema,
  PackageSeedPreparationReceiptSchema,
  PackageSeedReceiptSchema,
  PackageSeedRequestSchema,
} from "../../src/app/infrastructure/cloudflare-package-seeder.ts";
import {
  __cloudflareWorkerRouteTestHooks,
  handleWorkflowWorkerRequest,
} from "../../src/app/infrastructure/cloudflare-worker-route.ts";
import { createMemoryArtifactStore } from "../../src/app/infrastructure/memory-adapters.ts";
import { buildIntegrationTestRunRequest } from "./workflow-app-fixtures.ts";

const createBlockedFrontDoor = (calls: unknown[]): WorkerFrontDoorContract => ({
  route: "POST /runs",
  startRun(input) {
    calls.push(input);
    const request = WorkflowRunRequestSchema.parse(input);

    return Promise.resolve(
      WorkflowRunBlockedSchema.parse({
        blocker: {
          code: "adapter_unavailable",
          message: "Route test blocker.",
          redacted: true,
        },
        eventLog: [],
        runId: request.runId,
        status: "blocked",
      })
    );
  },
});

const fetchWithTestFrontDoor = (input: {
  readonly request: Request;
  readonly calls: unknown[];
}): Promise<Response> =>
  handleWorkflowWorkerRequest({
    createFrontDoor: () => createBlockedFrontDoor(input.calls),
    env: {},
    request: input.request,
  });

const createPackageSeedEnv = () => ({
  ARTIFACTS: {},
  WORKFLOW_APP_ADMIN_TOKEN: "admin-token",
  WORKFLOW_APP_ARTIFACTS_ACCOUNT_ID: "baac0d692a7fb14f11b159b48b13055e",
  WORKFLOW_APP_ARTIFACTS_NAMESPACE: "default",
  WORKFLOW_APP_D1: {},
});

const createWorkerEnv = (
  overrides: Record<string, unknown> = {}
): Record<string, unknown> => ({
  ARTIFACTS: {},
  DISCORD_BOT_SECRET_REF: "secretref:discord-bot",
  DISCORD_DRY_RUN_SECRET_REF: "secretref:discord-dry-run",
  DISCORD_USER_AGENT: "pi-cloudflare-sandbox-workflows/0.0.0",
  PI_AUTH_JSON_B64: "eyJvcGVuYWktY29kZXgiOnt9fQ==",
  PI_AUTH_SECRET_REF: "secretref:pi-agent-auth-json",
  Sandbox: {},
  WORKFLOW_APP_ARTIFACTS_ACCOUNT_ID: "baac0d692a7fb14f11b159b48b13055e",
  WORKFLOW_APP_ARTIFACTS_NAMESPACE: "default",
  WORKFLOW_APP_D1: {},
  WORKFLOW_APP_DISCORD_POLICY_ID: "discord-message-policy.v1",
  WORKFLOW_APP_MAX_ACTIVE_LANES: "3",
  WORKFLOW_APP_MODEL: "test-model",
  WORKFLOW_APP_REPO_PREFIX: "piwf",
  WORKFLOW_APP_TIMEOUT_MS: "600000",
  WORKFLOW_CAPSULE_SUPERVISOR: {},
  ...overrides,
});

const buildRouteEventStream = (input: {
  readonly events: readonly {
    readonly eventIndex: number;
    readonly state: "captured" | "resolvingCapsule";
    readonly summary: string;
  }[];
  readonly latestStatus: "captured" | "resolvingCapsule";
}) =>
  WorkflowEventStreamDocumentSchema.parse({
    eventCount: input.events.length,
    events: input.events.map((entry) => ({
      event: {
        at: "2026-06-09T10:12:00.000Z",
        refs: { capsuleId: "capsule:work-item:route-test" },
        state: entry.state,
        summary: entry.summary,
      },
      eventIndex: entry.eventIndex,
    })),
    generatedAt: "2026-06-09T10:13:00.000Z",
    latestStatus: input.latestStatus,
    redacted: true,
    runId: "run-route-test",
    schemaVersion: "workflow.event-stream.v1",
    sink: {
      description: "Test event stream projection.",
      kind: "cloudflare-d1-workflow-events",
      runId: "run-route-test",
      table: "workflow_events",
    },
    workItemId: "work-item:route-test",
  });

interface FakeRouteWebSocket {
  accept: () => void;
  accepted: boolean;
  close: (code?: number, reason?: string) => void;
  closeCode: number | null;
  closeReason: null | string;
  readyState: number;
  send: (message: string) => void;
  readonly sent: string[];
}

interface FakeRouteUpgradeResponseInstance {
  headers: Headers;
  status: number;
  webSocket: null | undefined | WebSocket;
}

interface WorkflowWebSocketTestMessage {
  readonly data: unknown;
  readonly event: string;
  readonly id?: string;
}

const createFakeRouteWebSocket = (): FakeRouteWebSocket => ({
  accept() {
    this.accepted = true;
  },
  accepted: false,
  close(code, reason) {
    this.closeCode = code ?? null;
    this.closeReason = reason ?? null;
    this.readyState = WebSocket.CLOSED;
  },
  closeCode: null,
  closeReason: null,
  readyState: WebSocket.OPEN,
  send(message) {
    this.sent.push(message);
  },
  sent: [],
});

const FakeRouteUpgradeResponseImplementation =
  function FakeRouteUpgradeResponseImplementation(
    this: FakeRouteUpgradeResponseInstance,
    _body: BodyInit | null,
    init?: ResponseInit
  ): void {
    this.headers = new Headers();
    this.status = init?.status ?? 200;
    this.webSocket = init?.webSocket;
  };
const FakeRouteUpgradeResponse =
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Node's Response constructor rejects 101, so this Worker-shaped constructor is installed only inside the WebSocket test.
  FakeRouteUpgradeResponseImplementation as unknown as typeof Response;

const isWorkflowWebSocketTestMessage = (
  value: unknown
): value is WorkflowWebSocketTestMessage => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("event" in value) || typeof value.event !== "string") {
    return false;
  }
  if ("id" in value && typeof value.id !== "string") {
    return false;
  }

  return "data" in value;
};

const parseWorkflowWebSocketTestMessage = (
  message: string
): WorkflowWebSocketTestMessage => {
  const parsed: unknown = JSON.parse(message);
  if (!isWorkflowWebSocketTestMessage(parsed)) {
    throw new Error("Invalid workflow WebSocket test message.");
  }

  return parsed;
};

const isFakeRouteUpgradeResponse = (
  value: unknown
): value is FakeRouteUpgradeResponseInstance => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  return (
    "headers" in value &&
    value.headers instanceof Headers &&
    "status" in value &&
    typeof value.status === "number" &&
    "webSocket" in value
  );
};

describe("Cloudflare Worker route", () => {
  it("does not install a workflow-node adapter when the Dream memory relay is unconfigured", () => {
    const bindings =
      __cloudflareWorkerRouteTestHooks.WorkerEnvBindingSchema.parse(
        createWorkerEnv()
      );
    const dependency =
      __cloudflareWorkerRouteTestHooks.workflowCartridgeDependenciesFromWorkerBindings(
        bindings
      );

    expect("createWorkflowNodeAdapter" in dependency).toBeFalsy();
    expect("createPostExecutionArtifactRecorders" in dependency).toBeFalsy();
  });

  it("installs the Dream workflow-node cartridge adapter and proof recorder when the relay is configured", () => {
    const bindings =
      __cloudflareWorkerRouteTestHooks.WorkerEnvBindingSchema.parse(
        createWorkerEnv({
          DREAM_MEMORY_RELAY_BASE_URL: "https://dream-relay.example.test",
          DREAM_MEMORY_RELAY_SECRET_REF: "secretref:dream-memory-relay",
          DREAM_MEMORY_RELAY_TOKEN: "relay-token",
        })
      );
    const dependency =
      __cloudflareWorkerRouteTestHooks.workflowCartridgeDependenciesFromWorkerBindings(
        bindings
      );
    if (!("createWorkflowNodeAdapter" in dependency)) {
      throw new Error("Expected Dream workflow-node adapter factory.");
    }

    const adapter = dependency.createWorkflowNodeAdapter({
      artifacts: createMemoryArtifactStore("worker-route-dream-relay"),
    });
    if (!("createPostExecutionArtifactRecorders" in dependency)) {
      throw new Error("Expected Dream post-execution proof recorder factory.");
    }
    const recorders = dependency.createPostExecutionArtifactRecorders({
      artifacts: createMemoryArtifactStore("worker-route-dream-proof"),
    });

    expect("execute" in adapter).toBeTruthy();
    expect(recorders).toHaveLength(1);
    const [recorder] = recorders;
    if (recorder === undefined) {
      throw new Error("Expected Dream proof recorder.");
    }
    expect("record" in recorder).toBeTruthy();
  });

  it("returns a typed debugger attach document for an observed workflow run", async () => {
    const calls: unknown[] = [];
    const eventStream = buildRouteEventStream({
      events: [
        {
          eventIndex: 1,
          state: "resolvingCapsule",
          summary: "Context capsule resolved.",
        },
        {
          eventIndex: 2,
          state: "captured",
          summary: "Receipts captured.",
        },
      ],
      latestStatus: "captured",
    });
    const response = await handleWorkflowWorkerRequest({
      env: {},
      readEventStream(_env, input) {
        calls.push(input);

        return Promise.resolve(eventStream);
      },
      request: new Request(
        "https://workflow.example.test/runs/run-route-test/debugger?after=1",
        {
          method: "GET",
        }
      ),
    });
    const json = WorkflowDebuggerAttachDocumentSchema.parse(
      await response.json()
    );

    expect({
      attachPolicy: json.attachPolicy,
      cacheControl: response.headers.get("Cache-Control"),
      calls,
      latestEventIndex: json.latestEventIndex,
      routeSummary: {
        afterEventIndex: json.afterEventIndex,
        eventCount: json.eventCount,
        latestStatus: json.latestStatus,
        mode: json.mode,
        runId: json.runId,
        schemaVersion: json.schemaVersion,
        workItemId: json.workItemId,
      },
      source: json.source,
      status: response.status,
      transports: json.transports.map((transport) => ({
        kind: transport.kind,
        url: transport.url,
      })),
    }).toStrictEqual({
      attachPolicy: {
        redaction: "redacted-events-only",
        secretMaterial: "not-exposed",
        sideEffects: "read-only",
      },
      cacheControl: "no-store",
      calls: [{ runId: "run-route-test" }],
      latestEventIndex: 2,
      routeSummary: {
        afterEventIndex: 1,
        eventCount: 2,
        latestStatus: "captured",
        mode: "event-observer",
        runId: "run-route-test",
        schemaVersion: "workflow.debugger-attach.v1",
        workItemId: "work-item:route-test",
      },
      source: {
        eventStreamSchemaVersion: "workflow.event-stream.v1",
        sink: {
          description: "Test event stream projection.",
          kind: "cloudflare-d1-workflow-events",
          runId: "run-route-test",
          table: "workflow_events",
        },
      },
      status: 200,
      transports: [
        {
          kind: "event-stream-json",
          url: "https://workflow.example.test/runs/run-route-test/events",
        },
        {
          kind: "event-stream-sse",
          url: "https://workflow.example.test/runs/run-route-test/events?after=1&format=sse",
        },
        {
          kind: "event-stream-live-tail",
          url: "https://workflow.example.test/runs/run-route-test/events?after=1&tail=live",
        },
        {
          kind: "event-stream-websocket",
          url: "wss://workflow.example.test/runs/run-route-test/events?after=1",
        },
      ],
    });
  });

  it("rejects invalid debugger attach cursors before reading D1", async () => {
    const calls: unknown[] = [];
    const response = await handleWorkflowWorkerRequest({
      env: {},
      readEventStream(_env, input) {
        calls.push(input);

        return Promise.resolve(null);
      },
      request: new Request(
        "https://workflow.example.test/runs/run-route-test/debugger?after=latest",
        {
          method: "GET",
        }
      ),
    });

    expect({
      body: await response.json(),
      calls,
      status: response.status,
    }).toStrictEqual({
      body: {
        error: {
          code: "invalid_event_cursor",
          message: "Event stream cursor must be a non-negative integer.",
          redacted: true,
        },
      },
      calls: [],
      status: 400,
    });
  });

  it("rejects non-GET debugger attach requests without invoking the reader", async () => {
    const calls: unknown[] = [];
    const response = await handleWorkflowWorkerRequest({
      env: {},
      readEventStream(_env, input) {
        calls.push(input);

        return Promise.resolve(null);
      },
      request: new Request(
        "https://workflow.example.test/runs/run-route-test/debugger",
        {
          method: "POST",
        }
      ),
    });

    expect({
      allow: response.headers.get("Allow"),
      body: await response.json(),
      calls,
      status: response.status,
    }).toStrictEqual({
      allow: "GET",
      body: {
        error: {
          code: "method_not_allowed",
          message: "Use GET /runs/:runId/debugger.",
          redacted: true,
        },
      },
      calls: [],
      status: 405,
    });
  });

  it("returns a redacted workflow event snapshot for GET /runs/:runId/events", async () => {
    const eventStream = WorkflowEventStreamDocumentSchema.parse({
      eventCount: 1,
      events: [
        {
          event: {
            at: "2026-06-09T10:12:00.000Z",
            refs: { capsuleId: "capsule:work-item:route-test" },
            state: "resolvingCapsule",
            summary: "Context capsule resolved.",
          },
          eventIndex: 2,
        },
      ],
      generatedAt: "2026-06-09T10:13:00.000Z",
      latestStatus: "resolvingCapsule",
      redacted: true,
      runId: "run-route-test",
      schemaVersion: "workflow.event-stream.v1",
      sink: {
        description: "Test event stream projection.",
        kind: "cloudflare-d1-workflow-events",
        runId: "run-route-test",
        table: "workflow_events",
      },
      workItemId: "work-item:route-test",
    });
    const response = await handleWorkflowWorkerRequest({
      env: {},
      readEventStream(_env, input) {
        expect(input).toStrictEqual({ runId: "run-route-test" });

        return Promise.resolve(eventStream);
      },
      request: new Request(
        "https://workflow.example.test/runs/run-route-test/events",
        {
          method: "GET",
        }
      ),
    });
    const json = WorkflowEventStreamDocumentSchema.parse(await response.json());

    expect({
      cacheControl: response.headers.get("Cache-Control"),
      json,
      status: response.status,
    }).toStrictEqual({
      cacheControl: "no-store",
      json: eventStream,
      status: 200,
    });
  });

  it("returns a Server-Sent Events replay when the event route asks for SSE", async () => {
    const eventStream = WorkflowEventStreamDocumentSchema.parse({
      eventCount: 1,
      events: [
        {
          event: {
            at: "2026-06-09T10:12:00.000Z",
            refs: { capsuleId: "capsule:work-item:route-test" },
            state: "resolvingCapsule",
            summary: "Context capsule resolved.",
          },
          eventIndex: 2,
        },
      ],
      generatedAt: "2026-06-09T10:13:00.000Z",
      latestStatus: "resolvingCapsule",
      redacted: true,
      runId: "run-route-test",
      schemaVersion: "workflow.event-stream.v1",
      sink: {
        description: "Test event stream projection.",
        kind: "cloudflare-d1-workflow-events",
        runId: "run-route-test",
        table: "workflow_events",
      },
      workItemId: "work-item:route-test",
    });
    const response = await handleWorkflowWorkerRequest({
      env: {},
      readEventStream() {
        return Promise.resolve(eventStream);
      },
      request: new Request(
        "https://workflow.example.test/runs/run-route-test/events",
        {
          headers: { accept: "text/event-stream" },
          method: "GET",
        }
      ),
    });
    const body = await response.text();

    expect({
      bodyIncludesEvent: body.includes("event: workflow.event"),
      bodyIncludesSnapshot: body.includes("event: workflow.snapshot"),
      cacheControl: response.headers.get("Cache-Control"),
      contentType: response.headers.get("Content-Type"),
      status: response.status,
    }).toStrictEqual({
      bodyIncludesEvent: true,
      bodyIncludesSnapshot: true,
      cacheControl: "no-store",
      contentType: "text/event-stream; charset=utf-8",
      status: 200,
    });
  });

  it("live-tails workflow events from repeated event stream reads", async () => {
    const snapshots = [
      buildRouteEventStream({
        events: [
          {
            eventIndex: 1,
            state: "resolvingCapsule",
            summary: "Context capsule resolved.",
          },
        ],
        latestStatus: "resolvingCapsule",
      }),
      buildRouteEventStream({
        events: [
          {
            eventIndex: 1,
            state: "resolvingCapsule",
            summary: "Context capsule resolved.",
          },
          {
            eventIndex: 2,
            state: "captured",
            summary: "Receipts captured.",
          },
        ],
        latestStatus: "captured",
      }),
    ];
    const calls: unknown[] = [];
    const response = await handleWorkflowWorkerRequest({
      env: {},
      eventStreamTail: {
        maxPolls: 2,
        now: () => "2026-06-09T10:14:00.000Z",
        pollDelayMs: 0,
      },
      readEventStream(_env, input) {
        calls.push(input);

        return Promise.resolve(
          snapshots[Math.min(calls.length - 1, snapshots.length - 1)] ?? null
        );
      },
      request: new Request(
        "https://workflow.example.test/runs/run-route-test/events?tail=live&after=1",
        {
          method: "GET",
        }
      ),
    });
    const body = await response.text();

    expect({
      bodyIncludesClosedControl: body.includes("event: workflow.tail.closed"),
      bodyIncludesResumeSkippedEvent: body.includes(
        "id: 1\nevent: workflow.event"
      ),
      bodyIncludesSecondEvent: body.includes("id: 2\nevent: workflow.event"),
      bodyIncludesTerminalReason: body.includes('"reason":"terminal-state"'),
      cacheControl: response.headers.get("Cache-Control"),
      calls,
      contentType: response.headers.get("Content-Type"),
      status: response.status,
    }).toStrictEqual({
      bodyIncludesClosedControl: true,
      bodyIncludesResumeSkippedEvent: false,
      bodyIncludesSecondEvent: true,
      bodyIncludesTerminalReason: true,
      cacheControl: "no-store",
      calls: [{ runId: "run-route-test" }, { runId: "run-route-test" }],
      contentType: "text/event-stream; charset=utf-8",
      status: 200,
    });
  });

  it("upgrades the workflow event route to a WebSocket live observer", async () => {
    const pairs: {
      readonly client: FakeRouteWebSocket;
      readonly server: FakeRouteWebSocket;
    }[] = [];
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Vitest runs in Node, while this test installs the missing Workers WebSocketPair global.
    const websocketPairGlobal = globalThis as typeof globalThis & {
      WebSocketPair?: typeof WebSocketPair;
    };
    const OriginalResponse = globalThis.Response;
    const OriginalWebSocketPair = websocketPairGlobal.WebSocketPair;

    const FakeWebSocketPairImplementation =
      function FakeWebSocketPairImplementation(): {
        readonly 0: FakeRouteWebSocket;
        readonly 1: FakeRouteWebSocket;
      } {
        const pair = {
          client: createFakeRouteWebSocket(),
          server: createFakeRouteWebSocket(),
        };
        pairs.push(pair);

        return {
          0: pair.client,
          1: pair.server,
        };
      };
    const FakeWebSocketPair =
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The Worker runtime expects a newable WebSocketPair constructor; this fake provides only the tested pair contract.
      FakeWebSocketPairImplementation as unknown as typeof WebSocketPair;

    try {
      globalThis.Response = FakeRouteUpgradeResponse;
      websocketPairGlobal.WebSocketPair = FakeWebSocketPair;

      const snapshots = [
        buildRouteEventStream({
          events: [
            {
              eventIndex: 1,
              state: "resolvingCapsule",
              summary: "Context capsule resolved.",
            },
          ],
          latestStatus: "resolvingCapsule",
        }),
        buildRouteEventStream({
          events: [
            {
              eventIndex: 1,
              state: "resolvingCapsule",
              summary: "Context capsule resolved.",
            },
            {
              eventIndex: 2,
              state: "captured",
              summary: "Receipts captured.",
            },
          ],
          latestStatus: "captured",
        }),
      ];
      const calls: unknown[] = [];
      const routeResponse = await handleWorkflowWorkerRequest({
        env: {},
        eventStreamTail: {
          maxPolls: 2,
          now: () => "2026-06-09T10:14:00.000Z",
          pollDelayMs: 0,
        },
        readEventStream(_env, input) {
          calls.push(input);

          return Promise.resolve(
            snapshots[Math.min(calls.length - 1, snapshots.length - 1)] ?? null
          );
        },
        request: new Request(
          "https://workflow.example.test/runs/run-route-test/events?after=1",
          {
            headers: {
              connection: "Upgrade",
              upgrade: "websocket",
            },
            method: "GET",
          }
        ),
      });
      if (!isFakeRouteUpgradeResponse(routeResponse)) {
        throw new Error("Expected fake route upgrade response.");
      }
      const response = routeResponse;

      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      const [pair] = pairs;
      const messages = pair?.server.sent.map(parseWorkflowWebSocketTestMessage);

      expect({
        calls,
        closeCode: pair?.server.closeCode,
        closeReason: pair?.server.closeReason,
        eventMessages: messages?.filter(
          (message) => message.event === "workflow.event"
        ),
        responseSocketIsClient: Object.is(response.webSocket, pair?.client),
        serverAccepted: pair?.server.accepted,
        status: response.status,
        tailClose: messages?.find(
          (message) => message.event === "workflow.tail.closed"
        ),
      }).toStrictEqual({
        calls: [{ runId: "run-route-test" }, { runId: "run-route-test" }],
        closeCode: 1000,
        closeReason: "terminal-state",
        eventMessages: [
          {
            data: {
              event: {
                at: "2026-06-09T10:12:00.000Z",
                refs: { capsuleId: "capsule:work-item:route-test" },
                state: "captured",
                summary: "Receipts captured.",
              },
              eventIndex: 2,
            },
            event: "workflow.event",
            id: "2",
          },
        ],
        responseSocketIsClient: true,
        serverAccepted: true,
        status: 101,
        tailClose: {
          data: {
            at: "2026-06-09T10:14:00.000Z",
            eventCount: 2,
            lastEventIndex: 2,
            latestStatus: "captured",
            reason: "terminal-state",
            redacted: true,
            runId: "run-route-test",
            schemaVersion: "workflow.event-tail-control.v1",
            status: "closed",
            stream: {
              kind: "cloudflare-d1-workflow-events-live-tail",
              maxPolls: 2,
              pollDelayMs: 0,
            },
            workItemId: "work-item:route-test",
          },
          event: "workflow.tail.closed",
        },
      });
    } finally {
      globalThis.Response = OriginalResponse;
      if (OriginalWebSocketPair === undefined) {
        delete websocketPairGlobal.WebSocketPair;
      } else {
        websocketPairGlobal.WebSocketPair = OriginalWebSocketPair;
      }
    }
  });

  it("rejects invalid event stream cursors before reading D1", async () => {
    const calls: unknown[] = [];
    const response = await handleWorkflowWorkerRequest({
      env: {},
      readEventStream(_env, input) {
        calls.push(input);

        return Promise.resolve(null);
      },
      request: new Request(
        "https://workflow.example.test/runs/run-route-test/events?tail=live&after=latest",
        {
          method: "GET",
        }
      ),
    });

    expect({
      body: await response.json(),
      calls,
      status: response.status,
    }).toStrictEqual({
      body: {
        error: {
          code: "invalid_event_cursor",
          message: "Event stream cursor must be a non-negative integer.",
          redacted: true,
        },
      },
      calls: [],
      status: 400,
    });
  });

  it("rejects non-GET event stream route requests without invoking the reader", async () => {
    const calls: unknown[] = [];
    const response = await handleWorkflowWorkerRequest({
      env: {},
      readEventStream(_env, input) {
        calls.push(input);

        return Promise.resolve(null);
      },
      request: new Request(
        "https://workflow.example.test/runs/run-route-test/events",
        {
          method: "POST",
        }
      ),
    });

    expect({
      allow: response.headers.get("Allow"),
      body: await response.json(),
      calls,
      status: response.status,
    }).toStrictEqual({
      allow: "GET",
      body: {
        error: {
          code: "method_not_allowed",
          message: "Use GET /runs/:runId/events.",
          redacted: true,
        },
      },
      calls: [],
      status: 405,
    });
  });

  it("accepts POST /runs and delegates the typed request to the front door", async () => {
    const body = buildIntegrationTestRunRequest();
    const calls: unknown[] = [];

    const response = await fetchWithTestFrontDoor({
      calls,
      request: new Request("https://workflow.example.test/runs", {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    });
    const json = WorkflowRunBlockedSchema.parse(await response.json());

    expect({
      calls,
      json,
      status: response.status,
    }).toStrictEqual({
      calls: [body],
      json: {
        blocker: {
          code: "adapter_unavailable",
          message: "Route test blocker.",
          redacted: true,
        },
        eventLog: [],
        runId: body.runId,
        status: "blocked",
      },
      status: 200,
    });
  });

  it("rejects non-POST /runs without invoking the front door", async () => {
    const calls: unknown[] = [];

    const response = await fetchWithTestFrontDoor({
      calls,
      request: new Request("https://workflow.example.test/runs", {
        method: "GET",
      }),
    });

    expect({
      allow: response.headers.get("Allow"),
      body: await response.json(),
      calls,
      status: response.status,
    }).toStrictEqual({
      allow: "POST",
      body: {
        error: {
          code: "method_not_allowed",
          message: "Use POST /runs.",
          redacted: true,
        },
      },
      calls: [],
      status: 405,
    });
  });

  it("rejects invalid JSON before invoking the front door", async () => {
    const calls: unknown[] = [];

    const response = await fetchWithTestFrontDoor({
      calls,
      request: new Request("https://workflow.example.test/runs", {
        body: "{",
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    });

    expect({
      body: await response.json(),
      calls,
      status: response.status,
    }).toStrictEqual({
      body: {
        error: {
          code: "invalid_json",
          message: "Request body must be JSON.",
          redacted: true,
        },
      },
      calls: [],
      status: 400,
    });
  });

  it("rejects requests that do not match the workflow run schema", async () => {
    const calls: unknown[] = [];

    const response = await fetchWithTestFrontDoor({
      calls,
      request: new Request("https://workflow.example.test/runs", {
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    });

    expect({
      body: await response.json(),
      calls,
      status: response.status,
    }).toStrictEqual({
      body: {
        error: {
          code: "invalid_workflow_request",
          message: "Request body does not match the workflow run schema.",
          redacted: true,
        },
      },
      calls: [],
      status: 422,
    });
  });

  it("accepts guarded package seed requests and delegates the parsed seed request", async () => {
    const calls: unknown[] = [];

    const response = await handleWorkflowWorkerRequest({
      env: createPackageSeedEnv(),
      request: new Request(
        "https://workflow.example.test/admin/packages/seed",
        {
          body: JSON.stringify({
            subjects: [
              {
                subjectId: "actor:seed-admin",
                subjectType: "actor",
              },
            ],
          }),
          headers: {
            authorization: "Bearer admin-token",
            "content-type": "application/json",
          },
          method: "POST",
        }
      ),
      seedPackages(_env, input) {
        calls.push(input);

        return Promise.resolve(
          PackageSeedReceiptSchema.parse({
            packages: [
              {
                entitlementCount: 1,
                manifestArtifactRef:
                  "artifact://cloudflare-artifacts/pkg-badass-courses-claw-kernel/package.json",
                manifestHash: "0".repeat(64),
                packageId: "badass-courses/claw-kernel",
                repoName: "pkg-badass-courses-claw-kernel",
                seedCommitSha: "seed-commit",
                status: "created",
              },
            ],
            schemaVersion: "workflow.package-seed.v1",
          })
        );
      },
    });
    const parsedCall = PackageSeedRequestSchema.parse(calls.at(0));

    expect({
      body: await response.json(),
      defaultPackageCount: parsedCall.packages.length,
      defaultPackageIds: parsedCall.packages.map(
        (packageSeed) => packageSeed.packageId
      ),
      status: response.status,
      subject: parsedCall.subjects[0],
    }).toStrictEqual({
      body: {
        packages: [
          {
            entitlementCount: 1,
            manifestArtifactRef:
              "artifact://cloudflare-artifacts/pkg-badass-courses-claw-kernel/package.json",
            manifestHash: "0".repeat(64),
            packageId: "badass-courses/claw-kernel",
            repoName: "pkg-badass-courses-claw-kernel",
            seedCommitSha: "seed-commit",
            status: "created",
          },
        ],
        schemaVersion: "workflow.package-seed.v1",
      },
      defaultPackageCount: 4,
      defaultPackageIds: [
        "badass-courses/claw-kernel",
        "joelhooks/configured-familiar-kernel",
        "workflow/research-review-discord",
        "workflow/dream-memory-fabric",
      ],
      status: 200,
      subject: {
        canDiscover: true,
        canInvoke: false,
        canMount: true,
        subjectId: "actor:seed-admin",
        subjectType: "actor",
        versionRange: "*",
      },
    });
  });

  it("prepares and finalizes package seed requests through guarded admin routes", async () => {
    const prepareCalls: unknown[] = [];
    const finalizeCalls: unknown[] = [];

    const prepareResponse = await handleWorkflowWorkerRequest({
      env: createPackageSeedEnv(),
      preparePackageSeed(_env, input) {
        prepareCalls.push(input);

        return Promise.resolve(
          PackageSeedPreparationReceiptSchema.parse({
            packages: [
              {
                defaultBranch: "main",
                manifest: {
                  description: "Default operating law and package mount rules.",
                  exports: [],
                  kind: "kernel",
                  latestArtifactRef:
                    "artifact://cloudflare-artifacts/pkg-badass-courses-claw-kernel/package.json",
                  latestVersion: "1.0.0",
                  manifestPath: "package.json",
                  ownerRef: "org:badass-courses",
                  packageId: "badass-courses/claw-kernel",
                  title: "Claw Kernel",
                  trustTier: "reviewed",
                },
                manifestArtifactRef:
                  "artifact://cloudflare-artifacts/pkg-badass-courses-claw-kernel/package.json",
                manifestHash: "1".repeat(64),
                remote:
                  "https://artifacts.example.invalid/pkg-badass-courses-claw-kernel.git",
                repoName: "pkg-badass-courses-claw-kernel",
                status: "created",
                writeToken: "write-token",
              },
            ],
            schemaVersion: "workflow.package-seed-preparation.v1",
            subjects: [
              {
                subjectId: "actor:seed-admin",
                subjectType: "actor",
              },
            ],
          })
        );
      },
      request: new Request(
        "https://workflow.example.test/admin/packages/prepare-seed",
        {
          body: JSON.stringify({
            subjects: [
              {
                subjectId: "actor:seed-admin",
                subjectType: "actor",
              },
            ],
          }),
          headers: {
            authorization: "Bearer admin-token",
            "content-type": "application/json",
          },
          method: "POST",
        }
      ),
    });
    const preparation = PackageSeedPreparationReceiptSchema.parse(
      await prepareResponse.json()
    );

    const finalizeResponse = await handleWorkflowWorkerRequest({
      env: createPackageSeedEnv(),
      finalizePackageSeed(_env, input) {
        finalizeCalls.push(input);

        return Promise.resolve(
          PackageSeedReceiptSchema.parse({
            packages: [
              {
                entitlementCount: 1,
                manifestArtifactRef:
                  "artifact://cloudflare-artifacts/pkg-badass-courses-claw-kernel/package.json",
                manifestHash: "1".repeat(64),
                packageId: "badass-courses/claw-kernel",
                repoName: "pkg-badass-courses-claw-kernel",
                seedCommitSha: "seed-commit",
                status: "created",
              },
            ],
            schemaVersion: "workflow.package-seed.v1",
          })
        );
      },
      request: new Request(
        "https://workflow.example.test/admin/packages/finalize-seed",
        {
          body: JSON.stringify({
            packages: preparation.packages.map((preparedPackage) => ({
              defaultBranch: preparedPackage.defaultBranch,
              manifest: preparedPackage.manifest,
              manifestArtifactRef: preparedPackage.manifestArtifactRef,
              manifestHash: preparedPackage.manifestHash,
              remote: preparedPackage.remote,
              repoName: preparedPackage.repoName,
              seedCommitSha: "seed-commit",
              status: preparedPackage.status,
            })),
            subjects: preparation.subjects,
          }),
          headers: {
            authorization: "Bearer admin-token",
            "content-type": "application/json",
          },
          method: "POST",
        }
      ),
    });
    const finalizeCall = PackageSeedFinalizeRequestSchema.parse(
      finalizeCalls.at(0)
    );

    expect({
      finalizeBody: await finalizeResponse.json(),
      finalizeCallPackageCount: finalizeCall.packages.length,
      finalizeStatus: finalizeResponse.status,
      prepareCallDefaultPackageCount: PackageSeedRequestSchema.parse(
        prepareCalls.at(0)
      ).packages.length,
      prepareStatus: prepareResponse.status,
      returnedWriteToken: preparation.packages[0]?.writeToken,
    }).toStrictEqual({
      finalizeBody: {
        packages: [
          {
            entitlementCount: 1,
            manifestArtifactRef:
              "artifact://cloudflare-artifacts/pkg-badass-courses-claw-kernel/package.json",
            manifestHash: "1".repeat(64),
            packageId: "badass-courses/claw-kernel",
            repoName: "pkg-badass-courses-claw-kernel",
            seedCommitSha: "seed-commit",
            status: "created",
          },
        ],
        schemaVersion: "workflow.package-seed.v1",
      },
      finalizeCallPackageCount: 1,
      finalizeStatus: 200,
      prepareCallDefaultPackageCount: 4,
      prepareStatus: 200,
      returnedWriteToken: "write-token",
    });
  });

  it("rejects package seed requests without the admin bearer token", async () => {
    const calls: unknown[] = [];

    const response = await handleWorkflowWorkerRequest({
      env: createPackageSeedEnv(),
      request: new Request(
        "https://workflow.example.test/admin/packages/seed",
        {
          body: JSON.stringify({ subjects: [] }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }
      ),
      seedPackages(_env, input) {
        calls.push(input);

        return Promise.reject(new Error("seed should not run"));
      },
    });

    expect({
      body: await response.json(),
      calls,
      status: response.status,
    }).toStrictEqual({
      body: {
        error: {
          code: "missing_auth",
          message: "Package seed requires an admin bearer token.",
          redacted: true,
        },
      },
      calls: [],
      status: 401,
    });
  });
});

describe("Cloudflare package artifact refs", () => {
  it("parses concrete Cloudflare Artifacts package file refs", () => {
    expect(
      parseCloudflarePackageArtifactRef(
        ArtifactRefSchema.parse(
          "artifact://cloudflare-artifacts/package-research-review/package.json"
        )
      )
    ).toStrictEqual({
      path: "package.json",
      repoName: "package-research-review",
    });
    expect(
      parseCloudflarePackageArtifactRef(
        ArtifactRefSchema.parse(
          "artifact://cloudflare-artifacts/package-research-review"
        )
      )
    ).toStrictEqual({
      path: "package.json",
      repoName: "package-research-review",
    });
  });

  it("keeps logical package refs out of the Cloudflare package reader", () => {
    const logicalRef = ArtifactRefSchema.parse(
      "artifact://packages/workflows/research-review-discord/refs/v1"
    );

    expect(() => parseCloudflarePackageArtifactRef(logicalRef)).toThrow(
      "artifact://cloudflare-artifacts/<repo-name>/<path>"
    );
  });
});
