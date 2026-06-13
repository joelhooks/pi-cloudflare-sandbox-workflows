import {
  AiHeroSupportSweepHydrationDocumentSchema,
  AiHeroSupportSweepIndexHealthDocumentSchema,
  AiHeroSupportSweepInventoryDocumentSchema,
  AiHeroSupportSweepSignalSearchDocumentSchema,
} from "./schemas.ts";
import type {
  AiHeroSupportSweepReceipt,
  AiHeroSupportSweepSearchAxis,
  AiHeroSupportSweepSignal,
} from "./schemas.ts";
import { aiHeroSupportSweepSourceRoots } from "./source-profile.ts";
import { aiHeroSupportSweepReceiptFor } from "./workflow-node-adapter.ts";
import type { AiHeroSupportSweepDataPort } from "./workflow-node-adapter.ts";

const nowIso = (): string => new Date().toISOString();

const receiptFor = (input: {
  readonly family: AiHeroSupportSweepReceipt["family"];
  readonly runId: string;
  readonly sourceId: string;
  readonly suffix: string;
}): AiHeroSupportSweepReceipt =>
  aiHeroSupportSweepReceiptFor({
    family: input.family,
    receiptId: `receipt:integration:${input.family}:${input.suffix}`,
    runId: input.runId,
    sourceId: input.sourceId,
    timestamp: nowIso(),
  });

const axisRating = (axis: AiHeroSupportSweepSearchAxis): number => {
  if (axis === "issue") {
    return 9;
  }

  if (axis === "account") {
    return 8;
  }

  if (axis === "course-product") {
    return 7;
  }

  return 6;
};

export const createIntegrationTestAiHeroSupportSweepAdapter =
  (): AiHeroSupportSweepDataPort => ({
    checkIndexHealth(input) {
      const sourceIndexes = input.inventory.sourceRoots.map(
        (sourceRoot, index) => ({
          family: sourceRoot.family,
          lastIndexedAt: index === 1 ? undefined : nowIso(),
          recoveryOnly: true,
          sourceId: sourceRoot.sourceId,
          status: index === 1 ? ("stale" as const) : ("healthy" as const),
          summary:
            index === 1
              ? "Derived support snapshot index is stale; recovery-only backfill is planned."
              : `Derived index for ${sourceRoot.label} is healthy in the offline fake.`,
        })
      );
      const recoveryOnlyBackfillPlan = sourceIndexes.flatMap((sourceIndex) =>
        sourceIndex.status === "healthy"
          ? []
          : [
              {
                backfillId: `backfill:${sourceIndex.sourceId}`,
                reason:
                  "Offline fake models a recovery-only backfill plan for stale derived data.",
                sourceId: sourceIndex.sourceId,
                status: "planned" as const,
              },
            ]
      );

      return Promise.resolve({
        document: AiHeroSupportSweepIndexHealthDocumentSchema.parse({
          generatedAt: nowIso(),
          nodeReceipt: {
            nodeType: "aihero.support-sweep.derived-index-health",
            receiptId: `node-receipt:${input.runId}:index-health`,
            redacted: true,
            sourceReceipts: input.inventory.receipts,
            summary: `Checked ${sourceIndexes.length} derived indexes with recovery-only backfill planning.`,
          },
          receipts: input.inventory.receipts,
          recoveryOnlyBackfillPlan,
          redacted: true,
          runId: input.runId,
          schemaVersion: "aihero.support-sweep.index-health.v1",
          sourceIndexes,
          summary: `Index health checked; ${recoveryOnlyBackfillPlan.length} recovery-only backfill(s) planned.`,
          workItemId: input.workItemId,
        }),
        status: "ready",
      });
    },
    hydrateEvidence(input) {
      const selected = input.receipts.slice(0, input.maxReceipts);

      return Promise.resolve({
        document: AiHeroSupportSweepHydrationDocumentSchema.parse({
          evidence: selected.map((receipt) => ({
            customerIdentifiersReturned: false,
            evidenceRef: `artifact://aihero-support-sweep/runs/${input.runId}/redacted-evidence/${receipt.receiptId.replaceAll(/[^a-z0-9-]+/gu, "-")}.json`,
            rawSupportThreadReturned: false,
            receipt,
            redactedExcerpt:
              "Redacted support evidence: customer-private details removed; only issue shape and product context remain.",
            summary: `Hydrated redacted evidence for ${receipt.family} signal ${receipt.receiptId}.`,
          })),
          generatedAt: nowIso(),
          nodeReceipt: {
            nodeType: "aihero.support-sweep.evidence-hydration",
            receiptId: `node-receipt:${input.runId}:hydration`,
            redacted: true,
            sourceReceipts: selected,
            summary: `Hydrated ${selected.length} selected receipt(s), redaction-first.`,
          },
          receipts: selected,
          redacted: true,
          runId: input.runId,
          schemaVersion: "aihero.support-sweep.hydration.v1",
          selectedReceiptCount: selected.length,
          workItemId: input.workItemId,
        }),
        status: "ready",
      });
    },
    inventorySources(input) {
      const requestedFamilies = new Set(input.sourceFamilies);
      const sourceRoots =
        requestedFamilies.size === 0
          ? [...aiHeroSupportSweepSourceRoots]
          : aiHeroSupportSweepSourceRoots.filter((sourceRoot) =>
              requestedFamilies.has(sourceRoot.family)
            );
      const receipts = sourceRoots.map((sourceRoot) =>
        receiptFor({
          family: sourceRoot.family,
          runId: input.runId,
          sourceId: sourceRoot.sourceId,
          suffix: "inventory",
        })
      );

      return Promise.resolve({
        document: AiHeroSupportSweepInventoryDocumentSchema.parse({
          generatedAt: nowIso(),
          nodeReceipt: {
            nodeType: "aihero.support-sweep.source-inventory",
            receiptId: `node-receipt:${input.runId}:inventory`,
            redacted: true,
            sourceReceipts: receipts,
            summary: `Inventoried ${sourceRoots.length} configured AIHero source root(s).`,
          },
          receipts,
          redacted: true,
          runId: input.runId,
          schemaVersion: "aihero.support-sweep.inventory.v1",
          sourceRoots,
          summary:
            "Inventory captured customer-private source root metadata without exposing filesystem authority roots.",
          workItemId: input.workItemId,
        }),
        status: "ready",
      });
    },
    searchSignals(input) {
      const sourceRoots = input.indexHealth.sourceIndexes;
      const signals: AiHeroSupportSweepSignal[] = input.axes
        .flatMap((axis, axisIndex) =>
          sourceRoots.map((sourceIndex, sourceIndexIndex) => {
            const horizon =
              input.horizons[
                (axisIndex + sourceIndexIndex) % input.horizons.length
              ] ?? "30d";
            const receipt = receiptFor({
              family: sourceIndex.family,
              runId: input.runId,
              sourceId: sourceIndex.sourceId,
              suffix: `${axis}-${horizon}`,
            });

            return {
              axis,
              horizon,
              rating: axisRating(axis),
              receipts: [receipt],
              redactedExcerpt: `Redacted ${axis} signal over ${horizon}; no raw customer identity or support thread returned.`,
              signalId: `signal:integration:${axis}:${sourceIndex.family}:${horizon}`,
              summary: `Integration ${axis} signal found ${sourceIndex.family} evidence for ${input.query}.`,
            };
          })
        )
        .slice(0, input.maxSignals);
      const receipts = signals.flatMap((signal) => signal.receipts);

      return Promise.resolve({
        document: AiHeroSupportSweepSignalSearchDocumentSchema.parse({
          axes: input.axes,
          generatedAt: nowIso(),
          horizons: input.horizons,
          nodeReceipt: {
            nodeType: "aihero.support-sweep.signal-search",
            receiptId: `node-receipt:${input.runId}:signal-search`,
            redacted: true,
            sourceReceipts: receipts,
            summary: `Searched ${signals.length} redacted support/comms/customer signal(s).`,
          },
          query: input.query,
          receipts,
          redacted: true,
          runId: input.runId,
          schemaVersion: "aihero.support-sweep.signal-search.v1",
          signals,
          skippedSources: [],
          workItemId: input.workItemId,
        }),
        status: "ready",
      });
    },
  });
