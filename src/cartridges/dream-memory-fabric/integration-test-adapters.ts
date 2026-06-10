import { hashJson, sha256Hex } from "../../app/domain/hash.ts";
import {
  DreamCaptureReceiptDocumentSchema,
  DreamCorrelationGraphDocumentSchema,
  DreamHydrationDocumentSchema,
  DreamMemorySearchDocumentSchema,
  DreamSignalDocumentSchema,
} from "./schemas.ts";
import type {
  DreamCorrelationGraphDocument,
  DreamMemoryRelayCaptureArtifactPayload,
  DreamMemoryRelayCaptureRunPayload,
  DreamMemoryRelayCorrelationPayload,
  DreamReceiptRef,
  DreamSignalKind,
  DreamSourceFamily,
} from "./schemas.ts";
import type {
  DreamMemoryCapturePort,
  DreamMemoryCorrelationPort,
  DreamMemoryRetrievalPort,
  DreamMemorySignalPort,
} from "./workflow-node-adapter.ts";

type DreamCorrelationGraphNode = DreamCorrelationGraphDocument["nodes"][number];
type DreamCorrelationGraphEdge = DreamCorrelationGraphDocument["edges"][number];

const nowIso = (): string => new Date().toISOString();

const dreamSourceIdFor = (family: DreamSourceFamily): string =>
  `source:${family}:integration`;

export const createIntegrationTestDreamMemoryFabricAdapter =
  (): DreamMemoryCapturePort => ({
    captureArtifact(input: DreamMemoryRelayCaptureArtifactPayload) {
      return Promise.resolve({
        document: DreamCaptureReceiptDocumentSchema.parse({
          captureKind: "artifact",
          capturedAt: nowIso(),
          capturedRef: input.capturedRef,
          readability: input.readability,
          redacted: true,
          runId: input.runId,
          schemaVersion: "dream.capture-receipt.v1",
          sourceSystem: input.sourceSystem,
          workItemId: input.workItemId,
        }),
        status: "ready",
      });
    },
    captureRun(input: DreamMemoryRelayCaptureRunPayload) {
      const capturedAt = nowIso();

      return Promise.resolve({
        document: DreamCaptureReceiptDocumentSchema.parse({
          captureKind: "run",
          capturedAt,
          capturedRef: input.capturedRef ?? {
            artifactRef: `artifact://integration-dream/runs/${
              input.targetRunId ?? input.runId
            }/capture/run.json`,
            hash: hashJson({
              capturedAt,
              redacted: true,
              runId: input.runId,
              schemaVersion: "integration.dream.capture-run.v1",
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
          schemaVersion: "dream.capture-receipt.v1",
          sourceSystem: input.sourceSystem,
          workItemId: input.workItemId,
        }),
        status: "ready",
      });
    },
  });

const dreamSearchReceiptFor = (input: {
  readonly family: DreamSourceFamily;
  readonly runId: string;
}): DreamReceiptRef => ({
  artifactRef: `artifact://integration-dream/runs/${input.runId}/receipts/${input.family}.json`,
  family: input.family,
  hash: sha256Hex(`${input.runId}:${input.family}:dream-search-receipt`),
  receiptId: `receipt:integration-dream:${input.family}`,
  redactedLocator: `redacted://integration-dream/${input.family}`,
  ...(input.family === "agent-transcripts"
    ? { runtime: "codex" as const }
    : {}),
  sourceId: dreamSourceIdFor(input.family),
  timestamp: nowIso(),
});

export const createIntegrationTestDreamMemoryRetrievalAdapter =
  (): DreamMemoryRetrievalPort & DreamMemorySignalPort => ({
    hydrateMemories(input) {
      return Promise.resolve({
        document: DreamHydrationDocumentSchema.parse({
          generatedAt: nowIso(),
          hydrated: input.receipts.map((receipt) => ({
            evidenceRef: `artifact://integration-dream/runs/${input.runId}/hydrated/${receipt.sourceId}.json`,
            fullTranscriptReturned: false,
            receipt,
            redactedExcerpt: `Redacted integration evidence for ${receipt.sourceId}; no raw transcript body returned.`,
            summary: `Hydrated redacted Dream evidence for ${receipt.sourceId}.`,
          })),
          redacted: true,
          runId: input.runId,
          schemaVersion: "dream.hydration.v1",
          workItemId: input.workItemId,
        }),
        status: "ready",
      });
    },
    mineSignals(input) {
      const signalKind: DreamSignalKind =
        input.signalKinds?.at(0) ?? "workflow-pattern";
      const family = input.sourceFamilies?.at(0) ?? "agent-transcripts";
      const receipt = dreamSearchReceiptFor({ family, runId: input.runId });

      return Promise.resolve({
        document: DreamSignalDocumentSchema.parse({
          generatedAt: nowIso(),
          redacted: true,
          runId: input.runId,
          schemaVersion: "dream.signals.v1",
          signals: [
            {
              confidence: 0.94,
              kind: signalKind,
              rating: 5,
              reasoning:
                "Integration Dream signal proves the generated workflow can mine redacted correction/workflow evidence before search and proposals.",
              receipts: [receipt],
              signalId: `signal:integration:${signalKind}`,
              summary:
                "Dream found workflow-proof pressure: dynamic generation needs verifier-backed signal evidence.",
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
        document: DreamMemorySearchDocumentSchema.parse({
          generatedAt: nowIso(),
          hits: families.slice(0, input.maxHits).map((family, index) => ({
            horizon: index === 0 ? ("all-time" as const) : ("30d" as const),
            receipts: [dreamSearchReceiptFor({ family, runId: input.runId })],
            redactedExcerpt: `Redacted integration search hit for ${input.query} in ${family}.`,
            score: 1 - index / 10,
            summary: `Integration Dream search found ${family} evidence for ${input.query}.`,
          })),
          query: input.query,
          redacted: true,
          runId: input.runId,
          schemaVersion: "dream.memory-search.v1",
          skippedSources: [],
          workItemId: input.workItemId,
        }),
        status: "ready",
      });
    },
  });

const integrationCorrelationReceiptKey = (receipt: DreamReceiptRef): string =>
  `${receipt.sourceId}:${receipt.receiptId}:${receipt.hash ?? ""}`;

const integrationCorrelationGraphFor = (
  input: DreamMemoryRelayCorrelationPayload
) => {
  const hydratedReceiptKeys = new Set(
    input.hydration.hydrated.map((hydrated) =>
      integrationCorrelationReceiptKey(hydrated.receipt)
    )
  );
  const nodes: DreamCorrelationGraphNode[] = [
    {
      label: "Integration Dream review",
      nodeId: "dream:integration-review",
      nodeType: "project",
      redacted: true,
    },
  ];
  const edges: DreamCorrelationGraphEdge[] = [];

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
          edgeId: `edge:${hitNodeId}:${receipt.receiptId}:supports-dream`,
          evidence: [receipt],
          fromNodeId: hitNodeId,
          relationship: "supports_dream",
          toNodeId: "dream:integration-review",
        });
      }
    }
  }

  return DreamCorrelationGraphDocumentSchema.parse({
    edges,
    generatedAt: nowIso(),
    nodes,
    redacted: true,
    runId: input.runId,
    schemaVersion: "dream.correlation-graph.v1",
    workItemId: input.workItemId,
  });
};

export const createIntegrationTestDreamMemoryCorrelationAdapter =
  (): DreamMemoryCorrelationPort => ({
    correlateMemories(input) {
      return Promise.resolve({
        document: integrationCorrelationGraphFor(input),
        status: "ready",
      });
    },
  });
