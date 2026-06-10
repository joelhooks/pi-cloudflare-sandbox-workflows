import { hashJson, sha256Hex } from "../../app/domain/hash.ts";
import {
  DreamBackfillPlanDocumentSchema,
  DreamBackfillRunReceiptDocumentSchema,
  DreamCaptureReceiptDocumentSchema,
  DreamCorrelationGraphDocumentSchema,
  DreamHydrationDocumentSchema,
  DreamMemorySearchDocumentSchema,
  DreamSignalDocumentSchema,
  DreamSourceHealthDocumentSchema,
  DreamSourceInventoryDocumentSchema,
} from "./schemas.ts";
import type {
  DreamCorrelationGraphDocument,
  DreamMemoryRelayBackfillRunPayload,
  DreamMemoryRelayCaptureArtifactPayload,
  DreamMemoryRelayCaptureRunPayload,
  DreamMemoryRelayCorrelationPayload,
  DreamReceiptRef,
  DreamRuntime,
  DreamSignalKind,
  DreamSourceFamily,
} from "./schemas.ts";
import type {
  DreamMemoryBackfillPort,
  DreamMemoryCapturePort,
  DreamMemoryCorrelationPort,
  DreamMemoryFabricPort,
  DreamMemoryRetrievalPort,
  DreamMemorySignalPort,
} from "./workflow-node-adapter.ts";

type DreamCorrelationGraphNode = DreamCorrelationGraphDocument["nodes"][number];
type DreamCorrelationGraphEdge = DreamCorrelationGraphDocument["edges"][number];

const nowIso = (): string => new Date().toISOString();

const dreamSourceIdFor = (family: DreamSourceFamily): string =>
  `source:${family}:integration`;

const dreamFamilyLabel = (family: DreamSourceFamily): string => {
  if (family === "docs-pdf-brain") {
    return "Docs/pdf-brain";
  }

  return family
    .split("-")
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
};

const runtimeCoverageSourceId = (runtime: DreamRuntime): string =>
  runtime === "cloudflare"
    ? dreamSourceIdFor("cloudflare-runs")
    : dreamSourceIdFor("agent-transcripts");

export const createIntegrationTestDreamMemoryFabricAdapter =
  (): DreamMemoryBackfillPort &
    DreamMemoryCapturePort &
    DreamMemoryFabricPort => ({
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
    checkSourceHealth(input) {
      const staleRuntimeCoverage = input.inventory.runtimeCoverage.filter(
        (coverage) => coverage.status !== "captured"
      );
      const indexHealth = input.inventory.sources.flatMap((source) =>
        source.derivedIndexes.length === 0
          ? [
              {
                freshnessCheckedAt: nowIso(),
                indexId: `${source.sourceId}:missing-derived-index`,
                indexKind: "view" as const,
                status: "missing" as const,
              },
            ]
          : source.derivedIndexes
      );

      return Promise.resolve({
        document: DreamSourceHealthDocumentSchema.parse({
          checkedAt: nowIso(),
          freshnessFailures: staleRuntimeCoverage.map(
            (coverage) =>
              `${coverage.runtime} coverage is ${coverage.status}; retrieval must not treat it as native captured evidence.`
          ),
          indexHealth,
          inventoryRef: {
            artifactRef: input.inventoryRef,
            hash: hashJson(input.inventory),
            mediaType: "application/json",
          },
          redacted: true,
          runId: input.runId,
          schemaVersion: "dream.source-health.v1",
          status: staleRuntimeCoverage.length === 0 ? "healthy" : "degraded",
          summary:
            staleRuntimeCoverage.length === 0
              ? "Integration memory fabric fixture reports source health as healthy."
              : "Integration memory fabric fixture reports explicit degraded runtime coverage.",
          workItemId: input.workItemId,
        }),
        status: "ready",
      });
    },
    inventorySources(input) {
      const generatedAt = nowIso();
      const sourceFamilies = [...new Set(input.sourceFamiliesExpected)];
      const sources = sourceFamilies.map((family) => {
        const sourceId = dreamSourceIdFor(family);

        return {
          adapter: {
            checkedAt: generatedAt,
            health: "healthy" as const,
            port: "IntegrationTestDreamMemoryFabricPort",
          },
          authority: {
            count: family === "agent-transcripts" ? 42 : 7,
            locatorHash: sha256Hex(sourceId),
            redactedLocator: `redacted://${sourceId}`,
            sourceSystem: `integration:${family}`,
          },
          blindSpots: [],
          derivedIndexes: [
            {
              authorityCount: family === "agent-transcripts" ? 42 : 7,
              derivedCount: family === "agent-transcripts" ? 42 : 7,
              freshnessCheckedAt: generatedAt,
              indexId: `${sourceId}:fixture-index`,
              indexKind: "view" as const,
              status: "fresh" as const,
            },
          ],
          family,
          freshness: {
            earliestAt: "2025-09-03T00:00:00.000Z",
            indexedAt: generatedAt,
            latestAt: generatedAt,
          },
          label: dreamFamilyLabel(family),
          privacyTier: "private" as const,
          scope: {
            organizationId: input.actor.organizationId,
            projectId: input.workItemId,
          },
          sourceId,
        };
      });
      const runtimeCoverage = input.requiredRuntimes.map((runtime) => {
        if (runtime === "claude") {
          return {
            horizonCounts: [],
            missingReason:
              "Integration fixture has no native Claude transcript relay configured.",
            runtime,
            sourceNative: false,
            status: "missing" as const,
          };
        }

        return {
          horizonCounts: [
            {
              earliestAt: "2025-09-03T00:00:00.000Z",
              hitCount: runtime === "cloudflare" ? 6 : 24,
              horizon: "all-time" as const,
              hydrationCount: runtime === "cloudflare" ? 2 : 4,
              latestAt: generatedAt,
              queryCount: runtime === "cloudflare" ? 3 : 8,
            },
          ],
          nativeProof: {
            evidenceRefs: [
              `artifact://integration-dream/runs/${input.runId}/proof/${runtime}.json`,
            ],
            redactedLocator: `redacted://native-${runtime}-fixture`,
            sourceId: runtimeCoverageSourceId(runtime),
          },
          runtime,
          sourceNative: true,
          status: "captured" as const,
        };
      });

      return Promise.resolve({
        document: DreamSourceInventoryDocumentSchema.parse({
          actor: input.actor,
          blindSpots:
            input.requiredRuntimes.includes("claude") &&
            runtimeCoverage.some(
              (coverage) =>
                coverage.runtime === "claude" && coverage.status === "missing"
            )
              ? [
                  "Claude native coverage is missing in the integration fixture.",
                ]
              : [],
          generatedAt,
          redacted: true,
          requiredRuntimes: input.requiredRuntimes,
          runId: input.runId,
          runtimeCoverage,
          schemaVersion: "dream.source-inventory.v1",
          scope: {
            organizationId: input.actor.organizationId,
            projectId: input.workItemId,
          },
          sourceFamiliesExpected: input.sourceFamiliesExpected,
          sources,
          summary:
            "Integration memory fabric fixture emits explicit source inventory with native and missing runtime coverage.",
          workItemId: input.workItemId,
        }),
        status: "ready",
      });
    },
    planBackfill(input) {
      const missingRuntimeCoverage = input.inventory.runtimeCoverage.filter(
        (coverage) => coverage.status !== "captured"
      );

      return Promise.resolve({
        document: DreamBackfillPlanDocumentSchema.parse({
          actions: missingRuntimeCoverage.map((coverage) => ({
            actionId: `backfill:${coverage.runtime}:native-capture`,
            authoritySourceId: runtimeCoverageSourceId(coverage.runtime),
            controlledScriptRef: `joelclaw:sessions/backfill-${coverage.runtime}`,
            derivedIndexId: `${runtimeCoverageSourceId(coverage.runtime)}:fixture-index`,
            priority: "high" as const,
            reason:
              coverage.status === "missing"
                ? (coverage.missingReason ??
                  `${coverage.runtime} native coverage is missing.`)
                : `${coverage.runtime} coverage is ${coverage.status}.`,
            sourceFamily:
              coverage.runtime === "cloudflare"
                ? ("cloudflare-runs" as const)
                : ("agent-transcripts" as const),
            timeWindow: {
              from: "2025-09-03T00:00:00.000Z",
              to: nowIso(),
            },
          })),
          captureFixes: missingRuntimeCoverage.map((coverage) => ({
            fixId: `capture:${coverage.runtime}:relay`,
            ownerRef: "system:joelclaw",
            reasonBackfillWasNeeded:
              coverage.status === "missing"
                ? `Native ${coverage.runtime} capture was not available to the Dream relay.`
                : `Native ${coverage.runtime} capture was not trustworthy enough for Dream retrieval.`,
            targetSourceId: runtimeCoverageSourceId(coverage.runtime),
          })),
          generatedAt: nowIso(),
          healthRef: {
            artifactRef: input.healthRef,
            hash: hashJson(input.health),
            mediaType: "application/json",
          },
          inventoryRef: {
            artifactRef: input.inventoryRef,
            hash: hashJson(input.inventory),
            mediaType: "application/json",
          },
          mode: "recovery-not-normal-operation",
          redacted: true,
          runId: input.runId,
          schemaVersion: "dream.backfill-plan.v1",
          status:
            missingRuntimeCoverage.length === 0
              ? "no-backfill-needed"
              : "backfill-required",
          summary:
            missingRuntimeCoverage.length === 0
              ? "No integration fixture backfill is required."
              : "Plan recovery backfills for missing or untrusted native runtime coverage.",
          workItemId: input.workItemId,
        }),
        status: "ready",
      });
    },
    runBackfill(input: DreamMemoryRelayBackfillRunPayload) {
      return Promise.resolve({
        document: DreamBackfillRunReceiptDocumentSchema.parse({
          actionResults: input.plan.actions.map((action) => ({
            actionId: action.actionId,
            failures: [],
            indexedCount: 0,
            skippedReasons: [
              "Integration fixture does not mutate derived indexes.",
            ],
            status: "skipped",
          })),
          captureFixResults: input.plan.captureFixes.map((fix) => ({
            failures: [],
            fixId: fix.fixId,
            ownerRef: fix.ownerRef,
            repairAction:
              "Integration fixture records the capture repair candidate without mutating the capture path.",
            skippedReasons: [
              "Integration fixture does not mutate source capture adapters.",
            ],
            status: "skipped",
            targetSourceId: fix.targetSourceId,
          })),
          completedAt: nowIso(),
          planRef: {
            artifactRef: input.planRef,
            hash: hashJson(input.plan),
            mediaType: "application/json",
          },
          redacted: true,
          runId: input.runId,
          schemaVersion: "dream.backfill-run-receipt.v1",
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
