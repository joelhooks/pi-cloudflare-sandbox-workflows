import { hashJson, sha256Hex } from "../../app/domain/hash.ts";
import type { MemorySourceFamily } from "../../app/domain/source-profile.ts";
import {
  MemoryCaptureReceiptDocumentSchema,
  MemoryCorrelationGraphDocumentSchema,
  MemoryHydrationDocumentSchema,
  MemorySearchDocumentSchema,
  MemorySignalDocumentSchema,
} from "./schemas.ts";
import type {
  MemoryCorrelationGraphDocument,
  MemoryRelayCaptureArtifactPayload,
  MemoryRelayCaptureRunPayload,
  MemoryRelayCorrelationPayload,
  MemoryReceiptRef,
  MemorySignalKind,
} from "./schemas.ts";
import type {
  MemoryCapturePort,
  MemoryCorrelationPort,
  MemoryRetrievalPort,
  MemorySignalPort,
} from "./workflow-node-adapter.ts";

type MemoryCorrelationGraphNode =
  MemoryCorrelationGraphDocument["nodes"][number];
type MemoryCorrelationGraphEdge =
  MemoryCorrelationGraphDocument["edges"][number];

const nowIso = (): string => new Date().toISOString();

const memorySourceIdFor = (family: MemorySourceFamily): string =>
  `source:${family}:integration`;

export const createIntegrationTestMemoryFabricAdapter =
  (): MemoryCapturePort => ({
    captureArtifact(input: MemoryRelayCaptureArtifactPayload) {
      return Promise.resolve({
        document: MemoryCaptureReceiptDocumentSchema.parse({
          captureKind: "artifact",
          capturedAt: nowIso(),
          capturedRef: input.capturedRef,
          readability: input.readability,
          redacted: true,
          runId: input.runId,
          schemaVersion: "memory.capture-receipt.v1",
          sourceSystem: input.sourceSystem,
          workItemId: input.workItemId,
        }),
        status: "ready",
      });
    },
    captureRun(input: MemoryRelayCaptureRunPayload) {
      const capturedAt = nowIso();

      return Promise.resolve({
        document: MemoryCaptureReceiptDocumentSchema.parse({
          captureKind: "run",
          capturedAt,
          capturedRef: input.capturedRef ?? {
            artifactRef: `artifact://integration-memory/runs/${
              input.targetRunId ?? input.runId
            }/capture/run.json`,
            hash: hashJson({
              capturedAt,
              redacted: true,
              runId: input.runId,
              schemaVersion: "integration.memory.capture-run.v1",
              sourceSystem: input.sourceSystem,
              targetRunId: input.targetRunId ?? input.runId,
              workItemId: input.workItemId,
            }),
            mediaType: "application/json",
          },
          capturedRunId: input.targetRunId ?? input.runId,
          readability: input.readability,
          redacted: true,
          runId: input.runId,
          schemaVersion: "memory.capture-receipt.v1",
          sourceSystem: input.sourceSystem,
          workItemId: input.workItemId,
        }),
        status: "ready",
      });
    },
  });

const memorySearchReceiptFor = (input: {
  readonly family: MemorySourceFamily;
  readonly runId: string;
}): MemoryReceiptRef => ({
  artifactRef: `artifact://integration-memory/runs/${input.runId}/receipts/${input.family}.json`,
  family: input.family,
  hash: sha256Hex(`${input.runId}:${input.family}:memory-search-receipt`),
  receiptId: `receipt:integration-memory:${input.family}`,
  redactedLocator: `redacted://integration-memory/${input.family}`,
  ...(input.family === "agent-transcripts"
    ? { runtime: "codex" as const }
    : {}),
  sourceId: memorySourceIdFor(input.family),
  timestamp: nowIso(),
});

export const createIntegrationTestMemoryRetrievalAdapter =
  (): MemoryRetrievalPort & MemorySignalPort => ({
    hydrateMemories(input) {
      return Promise.resolve({
        document: MemoryHydrationDocumentSchema.parse({
          generatedAt: nowIso(),
          hydrated: input.receipts.map((receipt) => ({
            evidenceRef: `artifact://integration-memory/runs/${input.runId}/hydrated/${receipt.sourceId}.json`,
            fullTranscriptReturned: false,
            receipt,
            redactedExcerpt: `Redacted integration evidence for ${receipt.sourceId}; no raw transcript body returned.`,
            summary: `Hydrated redacted memory evidence for ${receipt.sourceId}.`,
          })),
          redacted: true,
          runId: input.runId,
          schemaVersion: "memory.hydration.v1",
          workItemId: input.workItemId,
        }),
        status: "ready",
      });
    },
    mineSignals(input) {
      const signalKind: MemorySignalKind =
        input.signalKinds?.at(0) ?? "workflow-pattern";
      const family = input.sourceFamilies?.at(0) ?? "agent-transcripts";
      const receipt = memorySearchReceiptFor({ family, runId: input.runId });

      return Promise.resolve({
        document: MemorySignalDocumentSchema.parse({
          generatedAt: nowIso(),
          redacted: true,
          runId: input.runId,
          schemaVersion: "memory.signals.v1",
          signals: [
            {
              confidence: 0.94,
              kind: signalKind,
              rating: 5,
              reasoning:
                "Integration signal proves the generated workflow can mine redacted correction/workflow evidence before search and proposals.",
              receipts: [receipt],
              signalId: `signal:integration:${signalKind}`,
              summary:
                "Signal mining found workflow-proof pressure: dynamic generation needs verifier-backed signal evidence.",
            },
          ].slice(0, input.maxSignals),
          workItemId: input.workItemId,
        }),
        status: "ready",
      });
    },
    searchMemories(input) {
      const families = input.sourceFamilies ?? (["agent-transcripts"] as const);

      return Promise.resolve({
        document: MemorySearchDocumentSchema.parse({
          generatedAt: nowIso(),
          hits: families.slice(0, input.maxHits).map((family, index) => ({
            horizon: index === 0 ? ("all-time" as const) : ("30d" as const),
            receipts: [memorySearchReceiptFor({ family, runId: input.runId })],
            redactedExcerpt: `Redacted integration search hit for ${input.query} in ${family}.`,
            score: 1 - index / 10,
            summary: `Integration memory search found ${family} evidence for ${input.query}.`,
          })),
          query: input.query,
          redacted: true,
          runId: input.runId,
          schemaVersion: "memory.search.v1",
          skippedSources: [],
          workItemId: input.workItemId,
        }),
        status: "ready",
      });
    },
  });

const integrationCorrelationReceiptKey = (receipt: MemoryReceiptRef): string =>
  `${receipt.sourceId}:${receipt.receiptId}:${receipt.hash ?? ""}`;

const integrationCorrelationGraphFor = (
  input: MemoryRelayCorrelationPayload
) => {
  const hydratedReceiptKeys = new Set(
    input.hydration.hydrated.map((hydrated) =>
      integrationCorrelationReceiptKey(hydrated.receipt)
    )
  );
  const nodes: MemoryCorrelationGraphNode[] = [
    {
      label: "Integration HITL review",
      nodeId: "report:integration-review",
      nodeType: "project",
      redacted: true,
    },
  ];
  const edges: MemoryCorrelationGraphEdge[] = [];

  for (const [index, hit] of input.search.hits.entries()) {
    const hitNodeId = `memory-hit:${index + 1}`;
    nodes.push({
      label: hit.summary,
      nodeId: hitNodeId,
      nodeType: "memory",
      redacted: true,
    });

    for (const receipt of hit.receipts) {
      const sourceNodeId = `source:${receipt.sourceId}`;
      nodes.push({
        label: `Integration source ${receipt.sourceId}`,
        nodeId: sourceNodeId,
        nodeType: "source",
        redacted: true,
      });
      edges.push({
        edgeId: `edge:${hitNodeId}:${receipt.receiptId}:source`,
        evidence: [receipt],
        fromNodeId: hitNodeId,
        relationship: "reported_by",
        toNodeId: sourceNodeId,
      });

      if (hydratedReceiptKeys.has(integrationCorrelationReceiptKey(receipt))) {
        edges.push({
          edgeId: `edge:${hitNodeId}:${receipt.receiptId}:supports-finding`,
          evidence: [receipt],
          fromNodeId: hitNodeId,
          relationship: "supports_finding",
          toNodeId: "report:integration-review",
        });
      }
    }
  }

  return MemoryCorrelationGraphDocumentSchema.parse({
    edges,
    generatedAt: nowIso(),
    nodes,
    redacted: true,
    runId: input.runId,
    schemaVersion: "memory.correlation-graph.v1",
    workItemId: input.workItemId,
  });
};

export const createIntegrationTestMemoryCorrelationAdapter =
  (): MemoryCorrelationPort => ({
    correlateMemories(input) {
      return Promise.resolve({
        document: integrationCorrelationGraphFor(input),
        status: "ready",
      });
    },
  });
