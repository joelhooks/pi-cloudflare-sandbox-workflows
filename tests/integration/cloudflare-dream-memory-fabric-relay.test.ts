/// <reference types="@cloudflare/workers-types" />

import { describe, expect, it } from "vitest";

import type { MemoryRelayOperation } from "../../src/app/domain/source-profile.ts";
import type { MemoryRelayTokenSecretResolver } from "../../src/cartridges/memory-fabric/cloudflare-relay.ts";
import {
  createCloudflareMemoryFabricRelay,
  createCloudflareMemoryRelayTokenResolver,
  memoryRelayEndpointCatalog,
} from "../../src/cartridges/memory-fabric/cloudflare-relay.ts";
import {
  createIntegrationTestMemoryCorrelationAdapter,
  createIntegrationTestMemoryRetrievalAdapter,
} from "../../src/cartridges/memory-fabric/integration-test-adapters.ts";
import { MemoryRelayRequestEnvelopeSchema } from "../../src/cartridges/memory-fabric/schemas.ts";
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
  readonly operation: MemoryRelayOperation;
  readonly runId: string;
  readonly workItemId: string;
}): Response =>
  responseFrom({
    document: input.document,
    followUpLinks: [],
    leaseReceipt: {
      capability: "memory.relay",
      leaseId: `lease:memory-relay:${input.runId}:${input.workItemId}:${input.operation}`,
      redacted: true,
      secretRef: "secretref:memory-relay",
      status: "used",
      usedAt: "2026-06-09T18:00:00.000Z",
    },
    missingSources: [],
    operation: input.operation,
    redacted: true,
    runId: input.runId,
    schemaVersion: "memory.relay.response.v1",
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
      throw new TypeError(
        "Expected Memory relay request body to be JSON text."
      );
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
  it("posts Dream retrieval and capture requests to the trusted relay without leaking the relay token into documents", async () => {
    const request = buildIntegrationTestRunRequest();
    const correlationFixture = createIntegrationTestMemoryCorrelationAdapter();
    const retrievalFixture = createIntegrationTestMemoryRetrievalAdapter();
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
      schemaVersion: "memory.capture-receipt.v1" as const,
      sourceSystem: "cloudflare-workflow-run",
      workItemId: request.workItemId,
    };
    const captureArtifactDocument = {
      captureKind: "artifact" as const,
      capturedAt: "2026-06-09T18:00:00.000Z",
      capturedRef: {
        artifactRef: `artifact://relay-test/runs/${request.runId}/report/hitl-report.json`,
        hash: "d".repeat(64),
        mediaType: "application/json",
      },
      readability: "actor-private" as const,
      redacted: true as const,
      runId: request.runId,
      schemaVersion: "memory.capture-receipt.v1" as const,
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
    const adapter = createCloudflareMemoryFabricRelay({
      fetch: fakeFetch.fetcher,
      relayBaseUrl: "https://memory-relay.joelclaw.local",
      relaySecretRef: "secretref:memory-relay",
      secretResolver: createCloudflareMemoryRelayTokenResolver({
        secret: relayToken,
        secretRef: "secretref:memory-relay",
      }),
      userAgent: "pi-cloudflare-sandbox-workflows-test/0.0.0",
    });

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
      MemoryRelayRequestEnvelopeSchema.parse(parseJson(call.body))
    );

    expect({
      authorizationHeaders: fakeFetch.calls.map(
        (call) => call.headers["authorization"]
      ),
      captureArtifactKind: captureArtifactResult.document.captureKind,
      captureRunCapturedRunId:
        captureRunResult.document.captureKind === "run"
          ? captureRunResult.document.capturedRunId
          : null,
      captureRunKind: captureRunResult.document.captureKind,
      correlationEdgeCount: correlationResult.document.edges.length,
      correlationNodeCount: correlationResult.document.nodes.length,
      hydrationCount: hydrationResult.document.hydrated.length,
      idempotencyKeys: parsedRequestBodies.map((body) => body.idempotencyKey),
      methods: fakeFetch.calls.map((call) => call.method),
      operations: parsedRequestBodies.map((body) => body.operation),
      relayLeaseIds: [
        captureRunResult.relayLeaseReceipt,
        captureArtifactResult.relayLeaseReceipt,
        searchResult.relayLeaseReceipt,
        hydrationResult.relayLeaseReceipt,
        correlationResult.relayLeaseReceipt,
      ].map((receipt) => receipt?.leaseId),
      relayLeaseSecretRefs: [
        captureRunResult.relayLeaseReceipt,
        captureArtifactResult.relayLeaseReceipt,
        searchResult.relayLeaseReceipt,
        hydrationResult.relayLeaseReceipt,
        correlationResult.relayLeaseReceipt,
      ].map((receipt) => receipt?.secretRef),
      relayLeaseStatuses: [
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
      ],
      captureArtifactKind: "artifact",
      captureRunCapturedRunId: request.runId,
      captureRunKind: "run",
      correlationEdgeCount: 4,
      correlationNodeCount: 5,
      hydrationCount: 2,
      idempotencyKeys: [
        `memory-relay:${request.runId}:${request.workItemId}:capture-run`,
        `memory-relay:${request.runId}:${request.workItemId}:capture-artifact`,
        `memory-relay:${request.runId}:${request.workItemId}:search`,
        `memory-relay:${request.runId}:${request.workItemId}:hydrate`,
        `memory-relay:${request.runId}:${request.workItemId}:correlate`,
      ],
      methods: ["POST", "POST", "POST", "POST", "POST"],
      operations: [
        "capture-run",
        "capture-artifact",
        "search",
        "hydrate",
        "correlate",
      ],
      relayLeaseIds: [
        `lease:memory-relay:${request.runId}:${request.workItemId}:capture-run`,
        `lease:memory-relay:${request.runId}:${request.workItemId}:capture-artifact`,
        `lease:memory-relay:${request.runId}:${request.workItemId}:search`,
        `lease:memory-relay:${request.runId}:${request.workItemId}:hydrate`,
        `lease:memory-relay:${request.runId}:${request.workItemId}:correlate`,
      ],
      relayLeaseSecretRefs: [
        "secretref:memory-relay",
        "secretref:memory-relay",
        "secretref:memory-relay",
        "secretref:memory-relay",
        "secretref:memory-relay",
      ],
      relayLeaseStatuses: ["used", "used", "used", "used", "used"],
      requestBodiesLeakToken: false,
      requestSchemas: [
        "memory.relay.request.v1",
        "memory.relay.request.v1",
        "memory.relay.request.v1",
        "memory.relay.request.v1",
        "memory.relay.request.v1",
      ],
      responseDocumentsLeakToken: false,
      searchHitCount: 2,
      traceIds: [
        `trace:${request.runId}`,
        `trace:${request.runId}`,
        `trace:${request.runId}`,
        `trace:${request.runId}`,
        `trace:${request.runId}`,
      ],
      urls: [
        "https://memory-relay.joelclaw.local/memory/capture/run",
        "https://memory-relay.joelclaw.local/memory/capture/artifact",
        "https://memory-relay.joelclaw.local/memory/search",
        "https://memory-relay.joelclaw.local/memory/hydrate",
        "https://memory-relay.joelclaw.local/memory/correlate",
      ],
    });
  });

  it("publishes the full Memory relay endpoint catalog without direct private substrate paths", () => {
    expect(memoryRelayEndpointCatalog).toStrictEqual({
      endpoints: [
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
          operation: "search",
          path: "/memory/search",
        },
        {
          operation: "signals",
          path: "/memory/signals",
        },
      ],
      schemaVersion: "memory.relay.endpoint-catalog.v1",
    });
  });

  it("blocks before fetch when the configured relay token cannot be resolved", async () => {
    const request = buildIntegrationTestRunRequest();
    const fakeFetch = createQueuedFetch([]);
    const missingSecretResolver: MemoryRelayTokenSecretResolver = {
      resolve: () => Promise.resolve(null),
    };
    const adapter = createCloudflareMemoryFabricRelay({
      fetch: fakeFetch.fetcher,
      relayBaseUrl: "https://memory-relay.joelclaw.local",
      relaySecretRef: "secretref:memory-relay",
      secretResolver: missingSecretResolver,
      userAgent: "pi-cloudflare-sandbox-workflows-test/0.0.0",
    });

    const result = await adapter.searchMemories({
      actor: request.actor,
      maxHits: 1,
      query: "dynamic workflow proof",
      runId: request.runId,
      sourceFamilies: ["agent-transcripts"],
      workItemId: request.workItemId,
    });

    expect({
      blocker: result.status === "blocked" ? result.blocker : undefined,
      fetchCount: fakeFetch.calls.length,
      status: result.status,
    }).toStrictEqual({
      blocker: {
        code: "secret_denied",
        message: "Memory relay token is unavailable.",
        redacted: true,
      },
      fetchCount: 0,
      status: "blocked",
    });
  });

  it("blocks with a clean reason when the relay does not respond within the timeout", async () => {
    const request = buildIntegrationTestRunRequest();
    const tokenResolver: MemoryRelayTokenSecretResolver = {
      resolve: () => Promise.resolve("relay-token"),
    };
    // A hung relay surfaces as an AbortSignal.timeout TimeoutError; without the
    // bound the fetch would hang until workerd kills the whole invocation.
    const timeoutFetch = (() => {
      const error = new Error("The operation timed out.");
      error.name = "TimeoutError";

      return Promise.reject(error);
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- minimal fetch stub that always times out.
    }) as unknown as typeof fetch;
    const adapter = createCloudflareMemoryFabricRelay({
      fetch: timeoutFetch,
      relayBaseUrl: "https://memory-relay.joelclaw.local",
      relaySecretRef: "secretref:memory-relay",
      relayTimeoutMs: 5000,
      secretResolver: tokenResolver,
      userAgent: "pi-cloudflare-sandbox-workflows-test/0.0.0",
    });

    const result = await adapter.searchMemories({
      actor: request.actor,
      maxHits: 1,
      query: "dynamic workflow proof",
      runId: request.runId,
      sourceFamilies: ["agent-transcripts"],
      workItemId: request.workItemId,
    });

    expect({
      blocker: result.status === "blocked" ? result.blocker : undefined,
      status: result.status,
    }).toStrictEqual({
      blocker: {
        code: "adapter_unavailable",
        message: "Memory relay search did not respond within 5000ms.",
        redacted: true,
      },
      status: "blocked",
    });
  });
});
