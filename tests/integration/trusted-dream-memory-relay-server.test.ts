/// <reference types="@cloudflare/workers-types" />

import { describe, expect, it } from "vitest";

import {
  createIntegrationTestDreamMemoryCorrelationAdapter,
  createIntegrationTestDreamMemoryFabricAdapter,
  createIntegrationTestDreamMemoryRetrievalAdapter,
} from "../../src/cartridges/dream-memory-fabric/integration-test-adapters.ts";
import {
  DreamCaptureReceiptDocumentSchema,
  DreamCorrelationGraphDocumentSchema,
  DreamHydrationDocumentSchema,
  DreamMemorySearchDocumentSchema,
  DreamMemoryRelayRequestEnvelopeSchema,
  dreamMemoryRelayResponseEnvelopeSchema,
} from "../../src/cartridges/dream-memory-fabric/schemas.ts";
import type {
  DreamMemoryRelayOperation,
  DreamSourceFamily,
} from "../../src/cartridges/dream-memory-fabric/schemas.ts";
import { handleTrustedDreamMemoryRelayRequest } from "../../src/cartridges/dream-memory-fabric/trusted-relay-server.ts";
import type {
  DreamMemoryCapturePort,
  DreamMemoryFabricResult,
} from "../../src/cartridges/dream-memory-fabric/workflow-node-adapter.ts";
import { buildIntegrationTestRunRequest } from "./workflow-app-fixtures.ts";

const relayToken = "trusted-relay-token-never-in-response";
const timestamp = "2026-06-09T18:00:00.000Z";

const operationPath = (operation: DreamMemoryRelayOperation): string => {
  if (operation === "capture-run") {
    return "/memory/capture/run";
  }

  if (operation === "capture-artifact") {
    return "/memory/capture/artifact";
  }

  return `/memory/${operation}`;
};

const sourceFamiliesForPayload = (
  payload: unknown
): readonly DreamSourceFamily[] => {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "sourceFamilies" in payload &&
    Array.isArray(payload.sourceFamilies)
  ) {
    return payload.sourceFamilies.filter(
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
      capability: "memory.relay",
      leaseId: `lease:dream-relay-test:${run.runId}:${input.operation}`,
      redacted: true,
      secretRef: "secretref:memory-relay",
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

const createCountingDreamMemoryCapture = (): {
  readonly calls: string[];
  readonly port: DreamMemoryCapturePort;
} => {
  const calls: string[] = [];

  return {
    calls,
    port: {
      captureArtifact() {
        calls.push("capture-artifact");

        return blocked();
      },
      captureRun() {
        calls.push("capture-run");

        return blocked();
      },
    },
  };
};

describe("trusted Dream memory relay server", () => {
  it("serves capture-run and capture-artifact through typed relay envelopes without leaking the bearer token", async () => {
    const run = buildIntegrationTestRunRequest();
    const config = {
      dreamMemoryCapture: createIntegrationTestDreamMemoryFabricAdapter(),
      expectedBearerToken: relayToken,
      now: () => timestamp,
    };

    const captureRunResponse = await handleTrustedDreamMemoryRelayRequest({
      config,
      request: relayRequest({
        operation: "capture-run",
        payload: {
          actor: run.actor,
          readability: "actor-private",
          runId: run.runId,
          sourceFamilies: ["agent-transcripts", "cloudflare-runs"],
          sourceSystem: "cloudflare-workflow-run",
          targetRunId: run.runId,
          workItemId: run.workItemId,
        },
        token: relayToken,
      }),
    });
    const captureRunEnvelope = dreamMemoryRelayResponseEnvelopeSchema(
      DreamCaptureReceiptDocumentSchema
    ).parse(await parseJson(captureRunResponse));

    const captureArtifactResponse = await handleTrustedDreamMemoryRelayRequest({
      config,
      request: relayRequest({
        operation: "capture-artifact",
        payload: {
          actor: run.actor,
          capturedRef: {
            artifactRef: `artifact://relay-test/run/${run.runId}/dream/hitl-report.json`,
            hash: "a".repeat(64),
            mediaType: "application/json",
          },
          readability: "actor-private",
          runId: run.runId,
          sourceFamilies: ["repo-outputs", "cloudflare-runs"],
          sourceSystem: "cloudflare-artifacts",
          workItemId: run.workItemId,
        },
        token: relayToken,
      }),
    });
    const captureArtifactEnvelope = dreamMemoryRelayResponseEnvelopeSchema(
      DreamCaptureReceiptDocumentSchema
    ).parse(await parseJson(captureArtifactResponse));

    expect({
      captureArtifactKind: captureArtifactEnvelope.document.captureKind,
      captureArtifactOperation: captureArtifactEnvelope.operation,
      captureRunCapturedRunId:
        captureRunEnvelope.document.captureKind === "run"
          ? captureRunEnvelope.document.capturedRunId
          : null,
      captureRunKind: captureRunEnvelope.document.captureKind,
      captureRunOperation: captureRunEnvelope.operation,
      leaseSecretRefs: [
        captureRunEnvelope.leaseReceipt.secretRef,
        captureArtifactEnvelope.leaseReceipt.secretRef,
      ],
      responseLeaksToken: JSON.stringify([
        captureRunEnvelope,
        captureArtifactEnvelope,
      ]).includes(relayToken),
      usedAt: captureRunEnvelope.leaseReceipt.usedAt,
    }).toStrictEqual({
      captureArtifactKind: "artifact",
      captureArtifactOperation: "capture-artifact",
      captureRunCapturedRunId: run.runId,
      captureRunKind: "run",
      captureRunOperation: "capture-run",
      leaseSecretRefs: ["secretref:memory-relay", "secretref:memory-relay"],
      responseLeaksToken: false,
      usedAt: timestamp,
    });
  });

  it("serves search, hydrate, and correlate through trusted ports without returning raw transcripts", async () => {
    const run = buildIntegrationTestRunRequest();
    const config = {
      dreamMemoryCorrelation:
        createIntegrationTestDreamMemoryCorrelationAdapter(),
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
    const counting = createCountingDreamMemoryCapture();
    const run = buildIntegrationTestRunRequest();
    const response = await handleTrustedDreamMemoryRelayRequest({
      config: {
        dreamMemoryCapture: counting.port,
        expectedBearerToken: relayToken,
      },
      request: relayRequest({
        operation: "capture-run",
        payload: {
          actor: run.actor,
          readability: "actor-private",
          runId: run.runId,
          sourceSystem: "cloudflare-workflow-run",
          targetRunId: run.runId,
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
    const counting = createCountingDreamMemoryCapture();
    const searchResponse = await handleTrustedDreamMemoryRelayRequest({
      config: {
        dreamMemoryCapture: counting.port,
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
        dreamMemoryCapture: counting.port,
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
