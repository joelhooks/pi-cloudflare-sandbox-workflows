/// <reference types="@cloudflare/workers-types" />

import { describe, expect, it } from "vitest";

import {
  createIntegrationTestDreamMemoryCorrelationAdapter,
  createIntegrationTestDreamMemoryFabricAdapter,
  createIntegrationTestDreamMemoryRetrievalAdapter,
} from "../../src/app/infrastructure/memory-adapters.ts";
import { handleTrustedDreamMemoryRelayRequest } from "../../src/app/infrastructure/trusted-dream-memory-relay-server.ts";
import {
  DreamBackfillPlanDocumentSchema,
  DreamBackfillRunReceiptDocumentSchema,
  DreamCorrelationGraphDocumentSchema,
  DreamHydrationDocumentSchema,
  DreamMemorySearchDocumentSchema,
  DreamMemoryRelayRequestEnvelopeSchema,
  DreamSourceHealthDocumentSchema,
  DreamSourceInventoryDocumentSchema,
  dreamMemoryRelayResponseEnvelopeSchema,
} from "../../src/app/workflow-nodes/dream-memory-fabric-schemas.ts";
import type {
  DreamMemoryRelayOperation,
  DreamSourceFamily,
} from "../../src/app/workflow-nodes/dream-memory-fabric-schemas.ts";
import type {
  DreamMemoryFabricPort,
  DreamMemoryFabricResult,
} from "../../src/app/workflow-nodes/dream-memory-fabric.ts";
import { buildIntegrationTestRunRequest } from "./workflow-app-fixtures.ts";

const relayToken = "trusted-relay-token-never-in-response";
const timestamp = "2026-06-09T18:00:00.000Z";

const operationPath = (operation: DreamMemoryRelayOperation): string => {
  if (operation === "inventory") {
    return "/memory/inventory";
  }

  if (operation === "source-health") {
    return "/memory/source-health";
  }

  if (operation === "backfill-plan") {
    return "/memory/backfill/plan";
  }

  if (operation === "backfill-run") {
    return "/memory/backfill/run";
  }

  return `/memory/${operation}`;
};

const sourceFamiliesForPayload = (
  payload: unknown
): readonly DreamSourceFamily[] => {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "sourceFamiliesExpected" in payload &&
    Array.isArray(payload.sourceFamiliesExpected)
  ) {
    return payload.sourceFamiliesExpected.filter(
      (family): family is DreamSourceFamily => typeof family === "string"
    );
  }

  return ["agent-transcripts"];
};

const relayRequest = (input: {
  readonly operation: DreamMemoryRelayOperation;
  readonly payload: unknown;
  readonly token?: string;
}) => {
  const run = buildIntegrationTestRunRequest();
  const body = DreamMemoryRelayRequestEnvelopeSchema.parse({
    actor: run.actor,
    allowedSourceFamilies: [...sourceFamiliesForPayload(input.payload)],
    budget: {
      maxFiles: 50,
      maxRows: 100,
      maxTokens: 10_000,
    },
    idempotencyKey: `dream-relay-test:${run.runId}:${input.operation}`,
    lease: {
      capability: "dream.memory.relay",
      leaseId: `lease:dream-relay-test:${run.runId}:${input.operation}`,
      redacted: true,
      secretRef: "secretref:dream-memory-relay",
    },
    operation: input.operation,
    payload: input.payload,
    purpose: `Test ${input.operation}.`,
    redactionPolicy: {
      mode: "redacted-evidence",
      noCustomerDataInPublicArtifacts: true,
      noRawCredentials: true,
      noRawPrivatePaths: true,
      noRawTranscripts: true,
    },
    runId: run.runId,
    schemaVersion: "dream.memory-relay.request.v1",
    scope: {
      organizationId: run.actor.organizationId,
      projectId: "project:system-dreaming",
    },
    timeWindow: {
      label: "all-time",
    },
    traceContext: {
      parentSpanId: `span:${run.runId}:workflow`,
      redacted: true,
      spanId: `span:${run.runId}:dream-relay:${input.operation}`,
      traceId: `trace:${run.runId}`,
    },
    workItemId: run.workItemId,
  });
  const headers = new Headers({
    "content-type": "application/json",
  });
  if (input.token !== undefined) {
    headers.set("authorization", `Bearer ${input.token}`);
  }

  return new Request(
    `https://trusted-dream-relay.example.test${operationPath(input.operation)}`,
    {
      body: JSON.stringify(body),
      headers,
      method: "POST",
    }
  );
};

const parseJson = (response: Response): Promise<unknown> => response.json();

const blocked = <TDocument>(): Promise<DreamMemoryFabricResult<TDocument>> =>
  Promise.resolve({
    blocker: {
      code: "adapter_unavailable",
      message: "Counting adapter should not be invoked.",
      redacted: true,
    },
    status: "blocked",
  });

const createCountingDreamMemoryFabric = (): {
  readonly calls: string[];
  readonly port: DreamMemoryFabricPort;
} => {
  const calls: string[] = [];

  return {
    calls,
    port: {
      checkSourceHealth() {
        calls.push("source-health");

        return blocked();
      },
      inventorySources() {
        calls.push("inventory");

        return blocked();
      },
      planBackfill() {
        calls.push("backfill-plan");

        return blocked();
      },
    },
  };
};

describe("trusted Dream memory relay server", () => {
  it("serves inventory, source-health, and backfill-plan through typed relay envelopes without leaking the bearer token", async () => {
    const run = buildIntegrationTestRunRequest();
    const dreamMemoryFabric = createIntegrationTestDreamMemoryFabricAdapter();
    const config = {
      dreamMemoryBackfill: dreamMemoryFabric,
      dreamMemoryFabric,
      expectedBearerToken: relayToken,
      now: () => timestamp,
    };

    const inventoryResponse = await handleTrustedDreamMemoryRelayRequest({
      config,
      request: relayRequest({
        operation: "inventory",
        payload: {
          actor: run.actor,
          requiredRuntimes: ["pi", "codex", "claude", "cloudflare"],
          runId: run.runId,
          sourceFamiliesExpected: [
            "agent-transcripts",
            "brain",
            "cloudflare-runs",
          ],
          workItemId: run.workItemId,
        },
        token: relayToken,
      }),
    });
    const inventoryEnvelope = dreamMemoryRelayResponseEnvelopeSchema(
      DreamSourceInventoryDocumentSchema
    ).parse(await parseJson(inventoryResponse));

    const inventoryRef = `artifact://relay-test/run/${run.runId}/dream/source-inventory.json`;
    const healthResponse = await handleTrustedDreamMemoryRelayRequest({
      config,
      request: relayRequest({
        operation: "source-health",
        payload: {
          actor: run.actor,
          inventory: inventoryEnvelope.document,
          inventoryRef,
          runId: run.runId,
          workItemId: run.workItemId,
        },
        token: relayToken,
      }),
    });
    const healthEnvelope = dreamMemoryRelayResponseEnvelopeSchema(
      DreamSourceHealthDocumentSchema
    ).parse(await parseJson(healthResponse));

    const healthRef = `artifact://relay-test/run/${run.runId}/dream/source-health.json`;
    const backfillResponse = await handleTrustedDreamMemoryRelayRequest({
      config,
      request: relayRequest({
        operation: "backfill-plan",
        payload: {
          actor: run.actor,
          health: healthEnvelope.document,
          healthRef,
          inventory: inventoryEnvelope.document,
          inventoryRef,
          runId: run.runId,
          workItemId: run.workItemId,
        },
        token: relayToken,
      }),
    });
    const backfillEnvelope = dreamMemoryRelayResponseEnvelopeSchema(
      DreamBackfillPlanDocumentSchema
    ).parse(await parseJson(backfillResponse));

    const planRef = `artifact://relay-test/run/${run.runId}/dream/backfill-plan.json`;
    const backfillRunResponse = await handleTrustedDreamMemoryRelayRequest({
      config,
      request: relayRequest({
        operation: "backfill-run",
        payload: {
          actor: run.actor,
          plan: backfillEnvelope.document,
          planRef,
          runId: run.runId,
          workItemId: run.workItemId,
        },
        token: relayToken,
      }),
    });
    const backfillRunEnvelope = dreamMemoryRelayResponseEnvelopeSchema(
      DreamBackfillRunReceiptDocumentSchema
    ).parse(await parseJson(backfillRunResponse));

    expect({
      backfillOperation: backfillEnvelope.operation,
      backfillRunOperation: backfillRunEnvelope.operation,
      backfillRunSourceRefs: backfillRunEnvelope.sourceInventoryRefs,
      backfillRunStatuses: backfillRunEnvelope.document.actionResults.map(
        (action) => action.status
      ),
      backfillStatus: backfillEnvelope.document.status,
      healthOperation: healthEnvelope.operation,
      healthStatus: healthEnvelope.document.status,
      inventoryOperation: inventoryEnvelope.operation,
      inventorySchema: inventoryEnvelope.document.schemaVersion,
      leaseSecretRefs: [
        inventoryEnvelope.leaseReceipt.secretRef,
        healthEnvelope.leaseReceipt.secretRef,
        backfillEnvelope.leaseReceipt.secretRef,
        backfillRunEnvelope.leaseReceipt.secretRef,
      ],
      responseLeaksToken: JSON.stringify([
        inventoryEnvelope,
        healthEnvelope,
        backfillEnvelope,
        backfillRunEnvelope,
      ]).includes(relayToken),
      sourceInventoryRefs: backfillEnvelope.sourceInventoryRefs,
      usedAt: backfillEnvelope.leaseReceipt.usedAt,
    }).toStrictEqual({
      backfillOperation: "backfill-plan",
      backfillRunOperation: "backfill-run",
      backfillRunSourceRefs: [planRef],
      backfillRunStatuses: ["skipped"],
      backfillStatus: "backfill-required",
      healthOperation: "source-health",
      healthStatus: "degraded",
      inventoryOperation: "inventory",
      inventorySchema: "dream.source-inventory.v1",
      leaseSecretRefs: [
        "secretref:dream-memory-relay",
        "secretref:dream-memory-relay",
        "secretref:dream-memory-relay",
        "secretref:dream-memory-relay",
      ],
      responseLeaksToken: false,
      sourceInventoryRefs: [inventoryRef, healthRef],
      usedAt: timestamp,
    });
  });

  it("serves search, hydrate, and correlate through trusted ports without returning raw transcripts", async () => {
    const run = buildIntegrationTestRunRequest();
    const config = {
      dreamMemoryCorrelation:
        createIntegrationTestDreamMemoryCorrelationAdapter(),
      dreamMemoryFabric: createIntegrationTestDreamMemoryFabricAdapter(),
      dreamMemoryRetrieval: createIntegrationTestDreamMemoryRetrievalAdapter(),
      expectedBearerToken: relayToken,
      now: () => timestamp,
    };

    const searchResponse = await handleTrustedDreamMemoryRelayRequest({
      config,
      request: relayRequest({
        operation: "search",
        payload: {
          actor: run.actor,
          maxHits: 2,
          query: "dynamic workflow proof",
          runId: run.runId,
          sourceFamilies: ["agent-transcripts", "brain"],
          workItemId: run.workItemId,
        },
        token: relayToken,
      }),
    });
    const searchEnvelope = dreamMemoryRelayResponseEnvelopeSchema(
      DreamMemorySearchDocumentSchema
    ).parse(await parseJson(searchResponse));
    const receipts = searchEnvelope.document.hits.flatMap(
      (hit) => hit.receipts
    );

    const hydrationResponse = await handleTrustedDreamMemoryRelayRequest({
      config,
      request: relayRequest({
        operation: "hydrate",
        payload: {
          actor: run.actor,
          receipts,
          runId: run.runId,
          workItemId: run.workItemId,
        },
        token: relayToken,
      }),
    });
    const hydrationEnvelope = dreamMemoryRelayResponseEnvelopeSchema(
      DreamHydrationDocumentSchema
    ).parse(await parseJson(hydrationResponse));

    const correlationResponse = await handleTrustedDreamMemoryRelayRequest({
      config,
      request: relayRequest({
        operation: "correlate",
        payload: {
          actor: run.actor,
          hydration: hydrationEnvelope.document,
          hydrationRef: `artifact://relay-test/run/${run.runId}/dream/hydration.json`,
          runId: run.runId,
          search: searchEnvelope.document,
          searchRef: `artifact://relay-test/run/${run.runId}/dream/memory-search.json`,
          workItemId: run.workItemId,
        },
        token: relayToken,
      }),
    });
    const correlationEnvelope = dreamMemoryRelayResponseEnvelopeSchema(
      DreamCorrelationGraphDocumentSchema
    ).parse(await parseJson(correlationResponse));

    expect({
      correlationEdgeCount: correlationEnvelope.document.edges.length,
      correlationOperation: correlationEnvelope.operation,
      correlationSchema: correlationEnvelope.document.schemaVersion,
      hydrationFullTranscriptFlags: hydrationEnvelope.document.hydrated.map(
        (item) => item.fullTranscriptReturned
      ),
      hydrationOperation: hydrationEnvelope.operation,
      searchHitCount: searchEnvelope.document.hits.length,
      searchOperation: searchEnvelope.operation,
      searchSchema: searchEnvelope.document.schemaVersion,
    }).toStrictEqual({
      correlationEdgeCount: 4,
      correlationOperation: "correlate",
      correlationSchema: "dream.correlation-graph.v1",
      hydrationFullTranscriptFlags: [false, false],
      hydrationOperation: "hydrate",
      searchHitCount: 2,
      searchOperation: "search",
      searchSchema: "dream.memory-search.v1",
    });
  });

  it("rejects unauthenticated relay requests before invoking trusted memory ports", async () => {
    const counting = createCountingDreamMemoryFabric();
    const run = buildIntegrationTestRunRequest();
    const response = await handleTrustedDreamMemoryRelayRequest({
      config: {
        dreamMemoryFabric: counting.port,
        expectedBearerToken: relayToken,
      },
      request: relayRequest({
        operation: "inventory",
        payload: {
          actor: run.actor,
          requiredRuntimes: ["pi"],
          runId: run.runId,
          sourceFamiliesExpected: ["agent-transcripts"],
          workItemId: run.workItemId,
        },
      }),
    });

    expect({
      calls: counting.calls,
      status: response.status,
    }).toStrictEqual({
      calls: [],
      status: 401,
    });
  });

  it("blocks retrieval and correlation operations when no trusted adapter is installed", async () => {
    const counting = createCountingDreamMemoryFabric();
    const searchResponse = await handleTrustedDreamMemoryRelayRequest({
      config: {
        dreamMemoryFabric: counting.port,
        expectedBearerToken: relayToken,
      },
      request: relayRequest({
        operation: "search",
        payload: {
          query: "dynamic workflow proof",
        },
        token: relayToken,
      }),
    });
    const searchJson = await parseJson(searchResponse);

    const correlationResponse = await handleTrustedDreamMemoryRelayRequest({
      config: {
        dreamMemoryFabric: counting.port,
        expectedBearerToken: relayToken,
      },
      request: relayRequest({
        operation: "correlate",
        payload: {
          query: "dynamic workflow proof",
        },
        token: relayToken,
      }),
    });
    const correlationJson = await parseJson(correlationResponse);

    expect({
      bodyLeaksToken: JSON.stringify([searchJson, correlationJson]).includes(
        relayToken
      ),
      calls: counting.calls,
      correlationStatus: correlationResponse.status,
      searchStatus: searchResponse.status,
    }).toStrictEqual({
      bodyLeaksToken: false,
      calls: [],
      correlationStatus: 501,
      searchStatus: 501,
    });
  });
});
