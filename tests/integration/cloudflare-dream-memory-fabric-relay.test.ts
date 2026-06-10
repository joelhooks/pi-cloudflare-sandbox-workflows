/// <reference types="@cloudflare/workers-types" />

import { describe, expect, it } from "vitest";

import type { DreamMemoryRelayTokenSecretResolver } from "../../src/app/infrastructure/cloudflare-dream-memory-fabric-relay.ts";
import {
  createCloudflareDreamMemoryFabricRelay,
  createCloudflareDreamMemoryRelayTokenResolver,
  dreamMemoryRelayEndpointCatalog,
} from "../../src/app/infrastructure/cloudflare-dream-memory-fabric-relay.ts";
import {
  createIntegrationTestDreamMemoryCorrelationAdapter,
  createIntegrationTestDreamMemoryFabricAdapter,
  createIntegrationTestDreamMemoryRetrievalAdapter,
} from "../../src/app/infrastructure/memory-adapters.ts";
import { DreamMemoryRelayRequestEnvelopeSchema } from "../../src/app/workflow-nodes/dream-memory-fabric-schemas.ts";
import type { DreamMemoryRelayOperation } from "../../src/app/workflow-nodes/dream-memory-fabric-schemas.ts";
import { buildIntegrationTestRunRequest } from "./workflow-app-fixtures.ts";

interface FetchCall {
  readonly body: string;
  readonly headers: Record<string, string>;
  readonly method: string;
  readonly url: string;
}

const relayToken = "dream-relay-token-never-in-artifacts";

const responseFrom = (body: unknown, status = 200): Response =>
  Response.json(body, {
    status,
  });

const relayResponseFrom = (input: {
  readonly document: unknown;
  readonly operation: DreamMemoryRelayOperation;
  readonly runId: string;
  readonly workItemId: string;
}): Response =>
  responseFrom({
    document: input.document,
    followUpLinks: [],
    leaseReceipt: {
      capability: "dream.memory.relay",
      leaseId: `lease:dream-memory-relay:${input.runId}:${input.workItemId}:${input.operation}`,
      redacted: true,
      secretRef: "secretref:dream-memory-relay",
      status: "used",
      usedAt: "2026-06-09T18:00:00.000Z",
    },
    missingSources: [],
    operation: input.operation,
    redacted: true,
    runId: input.runId,
    schemaVersion: "dream.memory-relay.response.v1",
    sourceFreshness: [],
    sourceInventoryRefs: [],
    workItemId: input.workItemId,
  });

const urlForFetchInput = (input: Parameters<typeof fetch>[0]): string => {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.href;
  }

  return input.url;
};

const createQueuedFetch = (responses: readonly Response[]) => {
  const calls: FetchCall[] = [];
  const queue = [...responses];
  const fetcher: typeof fetch = (input, init) => {
    const response = queue.shift();
    if (response === undefined) {
      throw new Error("Unexpected relay fetch.");
    }

    if (typeof init?.body !== "string") {
      throw new TypeError("Expected Dream relay request body to be JSON text.");
    }

    calls.push({
      body: init.body,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      method: init.method ?? "GET",
      url: urlForFetchInput(input),
    });

    return Promise.resolve(response);
  };

  return { calls, fetcher };
};

const parseJson = (value: string): unknown => JSON.parse(value);

describe("Cloudflare Dream memory fabric relay adapter", () => {
  it("posts Dream preflight requests to the trusted relay without leaking the relay token into documents", async () => {
    const request = buildIntegrationTestRunRequest();
    const fixture = createIntegrationTestDreamMemoryFabricAdapter();
    const correlationFixture =
      createIntegrationTestDreamMemoryCorrelationAdapter();
    const retrievalFixture = createIntegrationTestDreamMemoryRetrievalAdapter();
    const inventory = await fixture.inventorySources({
      actor: request.actor,
      requiredRuntimes: ["pi", "codex", "claude", "cloudflare"],
      runId: request.runId,
      sourceFamiliesExpected: ["agent-transcripts", "brain", "cloudflare-runs"],
      workItemId: request.workItemId,
    });
    if (inventory.status === "blocked") {
      throw new Error(inventory.blocker.message);
    }

    const health = await fixture.checkSourceHealth({
      actor: request.actor,
      inventory: inventory.document,
      inventoryRef: `artifact://relay-test/runs/${request.runId}/dream/source-inventory.json`,
      runId: request.runId,
      workItemId: request.workItemId,
    });
    if (health.status === "blocked") {
      throw new Error(health.blocker.message);
    }

    const backfill = await fixture.planBackfill({
      actor: request.actor,
      health: health.document,
      healthRef: `artifact://relay-test/runs/${request.runId}/dream/source-health.json`,
      inventory: inventory.document,
      inventoryRef: `artifact://relay-test/runs/${request.runId}/dream/source-inventory.json`,
      runId: request.runId,
      workItemId: request.workItemId,
    });
    if (backfill.status === "blocked") {
      throw new Error(backfill.blocker.message);
    }

    const backfillRun = await fixture.runBackfill({
      actor: request.actor,
      plan: backfill.document,
      planRef: `artifact://relay-test/runs/${request.runId}/dream/backfill-plan.json`,
      runId: request.runId,
      workItemId: request.workItemId,
    });
    if (backfillRun.status === "blocked") {
      throw new Error(backfillRun.blocker.message);
    }
    const captureRunDocument = {
      captureKind: "run" as const,
      capturedAt: "2026-06-09T18:00:00.000Z",
      capturedRef: {
        artifactRef: `artifact://relay-test/runs/${request.runId}/dream/capture-run.json`,
        hash: "c".repeat(64),
        mediaType: "application/json",
      },
      capturedRunId: request.runId,
      readability: "actor-private" as const,
      redacted: true as const,
      runId: request.runId,
      schemaVersion: "dream.capture-receipt.v1" as const,
      sourceSystem: "cloudflare-workflow-run",
      workItemId: request.workItemId,
    };
    const captureArtifactDocument = {
      captureKind: "artifact" as const,
      capturedAt: "2026-06-09T18:00:00.000Z",
      capturedRef: {
        artifactRef: `artifact://relay-test/runs/${request.runId}/dream/hitl-report.json`,
        hash: "d".repeat(64),
        mediaType: "application/json",
      },
      readability: "actor-private" as const,
      redacted: true as const,
      runId: request.runId,
      schemaVersion: "dream.capture-receipt.v1" as const,
      sourceSystem: "cloudflare-artifacts",
      workItemId: request.workItemId,
    };

    const search = await retrievalFixture.searchMemories({
      actor: request.actor,
      maxHits: 2,
      query: "dynamic workflow proof",
      runId: request.runId,
      sourceFamilies: ["agent-transcripts", "brain"],
      workItemId: request.workItemId,
    });
    if (search.status === "blocked") {
      throw new Error(search.blocker.message);
    }

    const receipts = search.document.hits.flatMap((hit) => hit.receipts);
    const hydration = await retrievalFixture.hydrateMemories({
      actor: request.actor,
      receipts,
      runId: request.runId,
      workItemId: request.workItemId,
    });
    if (hydration.status === "blocked") {
      throw new Error(hydration.blocker.message);
    }

    const correlation = await correlationFixture.correlateMemories({
      actor: request.actor,
      hydration: hydration.document,
      hydrationRef: `artifact://relay-test/runs/${request.runId}/dream/hydration.json`,
      runId: request.runId,
      search: search.document,
      searchRef: `artifact://relay-test/runs/${request.runId}/dream/memory-search.json`,
      workItemId: request.workItemId,
    });
    if (correlation.status === "blocked") {
      throw new Error(correlation.blocker.message);
    }

    const fakeFetch = createQueuedFetch([
      relayResponseFrom({
        document: inventory.document,
        operation: "inventory",
        runId: request.runId,
        workItemId: request.workItemId,
      }),
      relayResponseFrom({
        document: health.document,
        operation: "source-health",
        runId: request.runId,
        workItemId: request.workItemId,
      }),
      relayResponseFrom({
        document: backfill.document,
        operation: "backfill-plan",
        runId: request.runId,
        workItemId: request.workItemId,
      }),
      relayResponseFrom({
        document: backfillRun.document,
        operation: "backfill-run",
        runId: request.runId,
        workItemId: request.workItemId,
      }),
      relayResponseFrom({
        document: captureRunDocument,
        operation: "capture-run",
        runId: request.runId,
        workItemId: request.workItemId,
      }),
      relayResponseFrom({
        document: captureArtifactDocument,
        operation: "capture-artifact",
        runId: request.runId,
        workItemId: request.workItemId,
      }),
      relayResponseFrom({
        document: search.document,
        operation: "search",
        runId: request.runId,
        workItemId: request.workItemId,
      }),
      relayResponseFrom({
        document: hydration.document,
        operation: "hydrate",
        runId: request.runId,
        workItemId: request.workItemId,
      }),
      relayResponseFrom({
        document: correlation.document,
        operation: "correlate",
        runId: request.runId,
        workItemId: request.workItemId,
      }),
    ]);
    const adapter = createCloudflareDreamMemoryFabricRelay({
      fetch: fakeFetch.fetcher,
      relayBaseUrl: "https://memory-relay.joelclaw.local",
      relaySecretRef: "secretref:dream-memory-relay",
      secretResolver: createCloudflareDreamMemoryRelayTokenResolver({
        secret: relayToken,
        secretRef: "secretref:dream-memory-relay",
      }),
      userAgent: "pi-cloudflare-sandbox-workflows-test/0.0.0",
    });

    const inventoryResult = await adapter.inventorySources({
      actor: request.actor,
      requiredRuntimes: ["pi", "codex", "claude", "cloudflare"],
      runId: request.runId,
      sourceFamiliesExpected: ["agent-transcripts", "brain", "cloudflare-runs"],
      workItemId: request.workItemId,
    });
    if (inventoryResult.status === "blocked") {
      throw new Error(inventoryResult.blocker.message);
    }

    const healthResult = await adapter.checkSourceHealth({
      actor: request.actor,
      inventory: inventoryResult.document,
      inventoryRef: `artifact://relay-test/runs/${request.runId}/dream/source-inventory.json`,
      runId: request.runId,
      workItemId: request.workItemId,
    });
    if (healthResult.status === "blocked") {
      throw new Error(healthResult.blocker.message);
    }

    const backfillResult = await adapter.planBackfill({
      actor: request.actor,
      health: healthResult.document,
      healthRef: `artifact://relay-test/runs/${request.runId}/dream/source-health.json`,
      inventory: inventoryResult.document,
      inventoryRef: `artifact://relay-test/runs/${request.runId}/dream/source-inventory.json`,
      runId: request.runId,
      workItemId: request.workItemId,
    });
    if (backfillResult.status === "blocked") {
      throw new Error(backfillResult.blocker.message);
    }
    const backfillRunResult = await adapter.runBackfill({
      actor: request.actor,
      plan: backfillResult.document,
      planRef: `artifact://relay-test/runs/${request.runId}/dream/backfill-plan.json`,
      runId: request.runId,
      workItemId: request.workItemId,
    });
    if (backfillRunResult.status === "blocked") {
      throw new Error(backfillRunResult.blocker.message);
    }
    const captureRunResult = await adapter.captureRun({
      actor: request.actor,
      readability: "actor-private",
      runId: request.runId,
      sourceFamilies: ["agent-transcripts", "cloudflare-runs"],
      sourceSystem: "cloudflare-workflow-run",
      targetRunId: request.runId,
      workItemId: request.workItemId,
    });
    if (captureRunResult.status === "blocked") {
      throw new Error(captureRunResult.blocker.message);
    }
    const captureArtifactResult = await adapter.captureArtifact({
      actor: request.actor,
      capturedRef: captureArtifactDocument.capturedRef,
      readability: "actor-private",
      runId: request.runId,
      sourceFamilies: ["repo-outputs", "cloudflare-runs"],
      sourceSystem: "cloudflare-artifacts",
      workItemId: request.workItemId,
    });
    if (captureArtifactResult.status === "blocked") {
      throw new Error(captureArtifactResult.blocker.message);
    }
    const searchResult = await adapter.searchMemories({
      actor: request.actor,
      maxHits: 2,
      query: "dynamic workflow proof",
      runId: request.runId,
      sourceFamilies: ["agent-transcripts", "brain"],
      workItemId: request.workItemId,
    });
    if (searchResult.status === "blocked") {
      throw new Error(searchResult.blocker.message);
    }
    const hydrationResult = await adapter.hydrateMemories({
      actor: request.actor,
      receipts: searchResult.document.hits.flatMap((hit) => hit.receipts),
      runId: request.runId,
      workItemId: request.workItemId,
    });
    if (hydrationResult.status === "blocked") {
      throw new Error(hydrationResult.blocker.message);
    }
    const correlationResult = await adapter.correlateMemories({
      actor: request.actor,
      hydration: hydrationResult.document,
      hydrationRef: `artifact://relay-test/runs/${request.runId}/dream/hydration.json`,
      runId: request.runId,
      search: searchResult.document,
      searchRef: `artifact://relay-test/runs/${request.runId}/dream/memory-search.json`,
      workItemId: request.workItemId,
    });
    if (correlationResult.status === "blocked") {
      throw new Error(correlationResult.blocker.message);
    }
    const parsedRequestBodies = fakeFetch.calls.map((call) =>
      DreamMemoryRelayRequestEnvelopeSchema.parse(parseJson(call.body))
    );

    expect({
      authorizationHeaders: fakeFetch.calls.map(
        (call) => call.headers["authorization"]
      ),
      backfillRunCaptureFixStatuses:
        backfillRunResult.document.captureFixResults.map(
          (captureFix) => captureFix.status
        ),
      backfillRunStatuses: backfillRunResult.document.actionResults.map(
        (action) => action.status
      ),
      backfillStatus: backfillResult.document.status,
      captureArtifactKind: captureArtifactResult.document.captureKind,
      captureRunCapturedRunId:
        captureRunResult.document.captureKind === "run"
          ? captureRunResult.document.capturedRunId
          : null,
      captureRunKind: captureRunResult.document.captureKind,
      correlationEdgeCount: correlationResult.document.edges.length,
      correlationNodeCount: correlationResult.document.nodes.length,
      healthStatus: healthResult.document.status,
      hydrationCount: hydrationResult.document.hydrated.length,
      idempotencyKeys: parsedRequestBodies.map((body) => body.idempotencyKey),
      inventorySchemaVersion: inventoryResult.document.schemaVersion,
      methods: fakeFetch.calls.map((call) => call.method),
      operations: parsedRequestBodies.map((body) => body.operation),
      relayLeaseIds: [
        inventoryResult.relayLeaseReceipt,
        healthResult.relayLeaseReceipt,
        backfillResult.relayLeaseReceipt,
        backfillRunResult.relayLeaseReceipt,
        captureRunResult.relayLeaseReceipt,
        captureArtifactResult.relayLeaseReceipt,
        searchResult.relayLeaseReceipt,
        hydrationResult.relayLeaseReceipt,
        correlationResult.relayLeaseReceipt,
      ].map((receipt) => receipt?.leaseId),
      relayLeaseSecretRefs: [
        inventoryResult.relayLeaseReceipt,
        healthResult.relayLeaseReceipt,
        backfillResult.relayLeaseReceipt,
        backfillRunResult.relayLeaseReceipt,
        captureRunResult.relayLeaseReceipt,
        captureArtifactResult.relayLeaseReceipt,
        searchResult.relayLeaseReceipt,
        hydrationResult.relayLeaseReceipt,
        correlationResult.relayLeaseReceipt,
      ].map((receipt) => receipt?.secretRef),
      relayLeaseStatuses: [
        inventoryResult.relayLeaseReceipt,
        healthResult.relayLeaseReceipt,
        backfillResult.relayLeaseReceipt,
        backfillRunResult.relayLeaseReceipt,
        captureRunResult.relayLeaseReceipt,
        captureArtifactResult.relayLeaseReceipt,
        searchResult.relayLeaseReceipt,
        hydrationResult.relayLeaseReceipt,
        correlationResult.relayLeaseReceipt,
      ].map((receipt) => receipt?.status),
      requestBodiesLeakToken: fakeFetch.calls.some((call) =>
        call.body.includes(relayToken)
      ),
      requestSchemas: parsedRequestBodies.map((body) => body.schemaVersion),
      responseDocumentsLeakToken: JSON.stringify([
        inventoryResult.document,
        healthResult.document,
        backfillResult.document,
        backfillRunResult.document,
        captureRunResult.document,
        captureArtifactResult.document,
        searchResult.document,
        hydrationResult.document,
        correlationResult.document,
      ]).includes(relayToken),
      searchHitCount: searchResult.document.hits.length,
      traceIds: parsedRequestBodies.map((body) => body.traceContext.traceId),
      urls: fakeFetch.calls.map((call) => call.url),
    }).toStrictEqual({
      authorizationHeaders: [
        `Bearer ${relayToken}`,
        `Bearer ${relayToken}`,
        `Bearer ${relayToken}`,
        `Bearer ${relayToken}`,
        `Bearer ${relayToken}`,
        `Bearer ${relayToken}`,
        `Bearer ${relayToken}`,
        `Bearer ${relayToken}`,
        `Bearer ${relayToken}`,
      ],
      backfillRunCaptureFixStatuses: ["skipped"],
      backfillRunStatuses: ["skipped"],
      backfillStatus: "backfill-required",
      captureArtifactKind: "artifact",
      captureRunCapturedRunId: request.runId,
      captureRunKind: "run",
      correlationEdgeCount: 4,
      correlationNodeCount: 5,
      healthStatus: "degraded",
      hydrationCount: 2,
      idempotencyKeys: [
        `dream-memory-relay:${request.runId}:${request.workItemId}:inventory`,
        `dream-memory-relay:${request.runId}:${request.workItemId}:source-health`,
        `dream-memory-relay:${request.runId}:${request.workItemId}:backfill-plan`,
        `dream-memory-relay:${request.runId}:${request.workItemId}:backfill-run`,
        `dream-memory-relay:${request.runId}:${request.workItemId}:capture-run`,
        `dream-memory-relay:${request.runId}:${request.workItemId}:capture-artifact`,
        `dream-memory-relay:${request.runId}:${request.workItemId}:search`,
        `dream-memory-relay:${request.runId}:${request.workItemId}:hydrate`,
        `dream-memory-relay:${request.runId}:${request.workItemId}:correlate`,
      ],
      inventorySchemaVersion: "dream.source-inventory.v1",
      methods: [
        "POST",
        "POST",
        "POST",
        "POST",
        "POST",
        "POST",
        "POST",
        "POST",
        "POST",
      ],
      operations: [
        "inventory",
        "source-health",
        "backfill-plan",
        "backfill-run",
        "capture-run",
        "capture-artifact",
        "search",
        "hydrate",
        "correlate",
      ],
      relayLeaseIds: [
        `lease:dream-memory-relay:${request.runId}:${request.workItemId}:inventory`,
        `lease:dream-memory-relay:${request.runId}:${request.workItemId}:source-health`,
        `lease:dream-memory-relay:${request.runId}:${request.workItemId}:backfill-plan`,
        `lease:dream-memory-relay:${request.runId}:${request.workItemId}:backfill-run`,
        `lease:dream-memory-relay:${request.runId}:${request.workItemId}:capture-run`,
        `lease:dream-memory-relay:${request.runId}:${request.workItemId}:capture-artifact`,
        `lease:dream-memory-relay:${request.runId}:${request.workItemId}:search`,
        `lease:dream-memory-relay:${request.runId}:${request.workItemId}:hydrate`,
        `lease:dream-memory-relay:${request.runId}:${request.workItemId}:correlate`,
      ],
      relayLeaseSecretRefs: [
        "secretref:dream-memory-relay",
        "secretref:dream-memory-relay",
        "secretref:dream-memory-relay",
        "secretref:dream-memory-relay",
        "secretref:dream-memory-relay",
        "secretref:dream-memory-relay",
        "secretref:dream-memory-relay",
        "secretref:dream-memory-relay",
        "secretref:dream-memory-relay",
      ],
      relayLeaseStatuses: [
        "used",
        "used",
        "used",
        "used",
        "used",
        "used",
        "used",
        "used",
        "used",
      ],
      requestBodiesLeakToken: false,
      requestSchemas: [
        "dream.memory-relay.request.v1",
        "dream.memory-relay.request.v1",
        "dream.memory-relay.request.v1",
        "dream.memory-relay.request.v1",
        "dream.memory-relay.request.v1",
        "dream.memory-relay.request.v1",
        "dream.memory-relay.request.v1",
        "dream.memory-relay.request.v1",
        "dream.memory-relay.request.v1",
      ],
      responseDocumentsLeakToken: false,
      searchHitCount: 2,
      traceIds: [
        `trace:${request.runId}`,
        `trace:${request.runId}`,
        `trace:${request.runId}`,
        `trace:${request.runId}`,
        `trace:${request.runId}`,
        `trace:${request.runId}`,
        `trace:${request.runId}`,
        `trace:${request.runId}`,
        `trace:${request.runId}`,
      ],
      urls: [
        "https://memory-relay.joelclaw.local/memory/inventory",
        "https://memory-relay.joelclaw.local/memory/source-health",
        "https://memory-relay.joelclaw.local/memory/backfill/plan",
        "https://memory-relay.joelclaw.local/memory/backfill/run",
        "https://memory-relay.joelclaw.local/memory/capture/run",
        "https://memory-relay.joelclaw.local/memory/capture/artifact",
        "https://memory-relay.joelclaw.local/memory/search",
        "https://memory-relay.joelclaw.local/memory/hydrate",
        "https://memory-relay.joelclaw.local/memory/correlate",
      ],
    });
  });

  it("publishes the full Dream memory relay endpoint catalog without direct private substrate paths", () => {
    expect(dreamMemoryRelayEndpointCatalog).toStrictEqual({
      endpoints: [
        {
          operation: "backfill-plan",
          path: "/memory/backfill/plan",
        },
        {
          operation: "backfill-run",
          path: "/memory/backfill/run",
        },
        {
          operation: "capture-artifact",
          path: "/memory/capture/artifact",
        },
        {
          operation: "capture-run",
          path: "/memory/capture/run",
        },
        {
          operation: "correlate",
          path: "/memory/correlate",
        },
        {
          operation: "hydrate",
          path: "/memory/hydrate",
        },
        {
          operation: "inventory",
          path: "/memory/inventory",
        },
        {
          operation: "search",
          path: "/memory/search",
        },
        {
          operation: "signals",
          path: "/memory/signals",
        },
        {
          operation: "source-health",
          path: "/memory/source-health",
        },
      ],
      schemaVersion: "dream.memory-relay.endpoint-catalog.v1",
    });
  });

  it("blocks before fetch when the configured relay token cannot be resolved", async () => {
    const request = buildIntegrationTestRunRequest();
    const fakeFetch = createQueuedFetch([]);
    const missingSecretResolver: DreamMemoryRelayTokenSecretResolver = {
      resolve: () => Promise.resolve(null),
    };
    const adapter = createCloudflareDreamMemoryFabricRelay({
      fetch: fakeFetch.fetcher,
      relayBaseUrl: "https://memory-relay.joelclaw.local",
      relaySecretRef: "secretref:dream-memory-relay",
      secretResolver: missingSecretResolver,
      userAgent: "pi-cloudflare-sandbox-workflows-test/0.0.0",
    });

    const result = await adapter.inventorySources({
      actor: request.actor,
      requiredRuntimes: ["pi"],
      runId: request.runId,
      sourceFamiliesExpected: ["agent-transcripts"],
      workItemId: request.workItemId,
    });

    expect({
      blocker: result.status === "blocked" ? result.blocker : undefined,
      fetchCount: fakeFetch.calls.length,
      status: result.status,
    }).toStrictEqual({
      blocker: {
        code: "secret_denied",
        message: "Dream memory relay token is unavailable.",
        redacted: true,
      },
      fetchCount: 0,
      status: "blocked",
    });
  });
});
