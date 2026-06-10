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
} from "../../cartridges/dream-memory-fabric/schemas.ts";
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
} from "../../cartridges/dream-memory-fabric/schemas.ts";
import type {
  DreamMemoryBackfillPort,
  DreamMemoryCapturePort,
  DreamMemoryCorrelationPort,
  DreamMemoryFabricPort,
  DreamMemoryRetrievalPort,
  DreamMemorySignalPort,
} from "../../cartridges/dream-memory-fabric/workflow-node-adapter.ts";
import type {
  ArtifactStoreContract,
  CapabilityLeaseBrokerActorContract,
  ContextCapsuleActorContract,
  DiscordMessageCapabilityAdapter,
  DynamicWorkflowPlannerPort,
  GitHubBranchCommitCapabilityAdapter,
  GitHubPullRequestCapabilityAdapter,
  LinearCommentCapabilityAdapter,
  ReviewGateActorContract,
  PackageRegistryActorContract,
  WzrrdPublishCapabilityAdapter,
  WorkflowStatusProjectionPort,
} from "../application/ports.ts";
import { hashJson, sha256Hex } from "../domain/hash.ts";
import {
  ArtifactWriteReceiptSchema,
  CapabilityLeaseReceiptSchema,
  CapabilityLeaseSchema,
  ContextCapsuleRecordSchema,
  DiscordDeliveryResultSchema,
  DiscordMessagePayloadSchema,
  DynamicWorkflowBlueprintSchema,
  GitHubBranchCommitDeliveryResultSchema,
  GitHubBranchCommitPayloadSchema,
  GitHubPullRequestDeliveryResultSchema,
  GitHubPullRequestPayloadSchema,
  LinearCommentDeliveryResultSchema,
  LinearCommentPayloadSchema,
  PackageMetadataSchema,
  PinnedPackageSchema,
  ReviewSummaryDocumentSchema,
  WzrrdPublishDeliveryResultSchema,
  WzrrdPublishPayloadSchema,
  WorkflowStatusProjectionSchema,
} from "../domain/schemas.ts";
import type {
  Actor,
  ArtifactRef,
  CapabilityDenialCode,
  CapabilityLease,
  CapabilityLeaseDecision,
  CapabilityLeaseReceipt,
  CapabilityLeaseRequest,
  ContextCapsuleRecord,
  DiscordDeliveryResult,
  DiscordMessagePayload,
  DynamicWorkflowStep,
  GitHubBranchCommitDeliveryResult,
  GitHubBranchCommitPayload,
  GitHubPullRequestDeliveryResult,
  GitHubPullRequestPayload,
  LinearCommentDeliveryResult,
  LinearCommentPayload,
  PackageMetadata,
  PinnedPackage,
  WorkflowEvent,
  WorkflowStatusProjection,
  WzrrdPublishDeliveryResult,
  WzrrdPublishPayload,
} from "../domain/schemas.ts";
import { workflowTraceContextForLane } from "../domain/trace-context.ts";

type DreamCorrelationGraphNode = DreamCorrelationGraphDocument["nodes"][number];
type DreamCorrelationGraphEdge = DreamCorrelationGraphDocument["edges"][number];

interface MemoryArtifactRecord {
  readonly kind: "json" | "text";
  readonly mediaType: string;
  readonly value: unknown;
}

export interface MemoryArtifactStore extends ArtifactStoreContract {
  readonly records: Map<ArtifactRef, MemoryArtifactRecord>;
  readonly setJson: (artifactRef: ArtifactRef, value: unknown) => void;
  readonly setText: (
    artifactRef: ArtifactRef,
    value: string,
    mediaType?: string
  ) => void;
}

export interface MemoryContextCapsuleActor extends ContextCapsuleActorContract {
  readonly capsules: Map<string, ContextCapsuleRecord>;
  readonly events: Map<string, WorkflowEvent[]>;
}

export interface MemoryWorkflowStatusProjectionStore extends WorkflowStatusProjectionPort {
  readonly latest: Map<string, WorkflowStatusProjection>;
  readonly records: Map<string, WorkflowStatusProjection[]>;
}

const nowIso = (): string => new Date().toISOString();

const artifactRefFor = (
  namespace: string,
  runId: string,
  path: string
): ArtifactRef => `artifact://${namespace}/runs/${runId}/${path}`;

const denied = (
  code: CapabilityDenialCode,
  message: string
): CapabilityLeaseDecision => ({
  blocker: {
    code,
    message,
    redacted: true,
  },
  status: "denied",
});

const discordStepId = "notify-review-channel";

const safeStateName = (value: string): string =>
  value.replaceAll(/[^A-Za-z0-9_]/gu, "_");

const generatedStepStateName = (index: number, stepId: string): string =>
  `step_${index}_${safeStateName(stepId)}`;

const createGeneratedWorkflowMachineStates = (
  steps: readonly DynamicWorkflowStep[]
) => {
  const states: Record<
    string,
    {
      readonly meta: {
        readonly stepId?: string;
        readonly stepKind?: string;
        readonly summary?: string;
      };
      readonly on: Record<string, { readonly target: string }>;
      readonly type?: "final";
    }
  > = {
    ready: {
      meta: {
        summary: "Generated dynamic workflow is ready to execute.",
      },
      on: {
        NEXT: {
          target: generatedStepStateName(0, steps[0]?.stepId ?? "missing"),
        },
      },
    },
  };

  for (const [index, step] of steps.entries()) {
    const nextStep = steps.at(index + 1);
    const nextTarget =
      nextStep === undefined
        ? "done"
        : generatedStepStateName(index + 1, nextStep.stepId);
    states[generatedStepStateName(index, step.stepId)] = {
      meta: {
        stepId: step.stepId,
        stepKind: step.kind,
        summary: step.summary,
      },
      on: {
        STEP_BLOCKED: {
          target: "blocked",
        },
        STEP_DONE: {
          target: nextTarget,
        },
      },
    };
  }

  states["blocked"] = {
    meta: {
      summary: "Generated dynamic workflow blocked.",
    },
    on: {},
    type: "final",
  };
  states["done"] = {
    meta: {
      summary: "Generated dynamic workflow completed.",
    },
    on: {},
    type: "final",
  };

  return states;
};

export const createMemoryArtifactStore = (
  namespace = "workflow-app"
): MemoryArtifactStore => {
  const records = new Map<ArtifactRef, MemoryArtifactRecord>();
  const setJson = (artifactRef: ArtifactRef, value: unknown): void => {
    records.set(artifactRef, {
      kind: "json",
      mediaType: "application/json",
      value,
    });
  };
  const setText = (
    artifactRef: ArtifactRef,
    value: string,
    mediaType = "text/plain"
  ): void => {
    records.set(artifactRef, { kind: "text", mediaType, value });
  };

  return {
    artifactRef(input) {
      return artifactRefFor(namespace, input.runId, input.path);
    },
    readJson(input) {
      const record = records.get(input.artifactRef);
      if (record === undefined) {
        return Promise.reject(
          new Error(`Artifact not found: ${input.artifactRef}`)
        );
      }

      if (record.kind !== "json" || record.mediaType !== "application/json") {
        return Promise.reject(
          new TypeError(`JSON artifact not found: ${input.artifactRef}`)
        );
      }

      return Promise.resolve(record.value);
    },
    readText(input) {
      const record = records.get(input.artifactRef);
      if (
        record === undefined ||
        record.kind !== "text" ||
        typeof record.value !== "string"
      ) {
        return Promise.reject(
          new TypeError(`Text artifact not found: ${input.artifactRef}`)
        );
      }

      return Promise.resolve(record.value);
    },
    records,
    setJson,
    setText,
    writeJson(input) {
      const artifactRef = artifactRefFor(namespace, input.runId, input.path);
      const receipt = ArtifactWriteReceiptSchema.parse({
        artifactRef,
        contentHash: hashJson(input.value),
        mediaType: "application/json",
        redacted: input.redacted,
      });
      setJson(artifactRef, input.value);

      return Promise.resolve(receipt);
    },
    writeText(input) {
      const artifactRef = artifactRefFor(namespace, input.runId, input.path);
      const receipt = ArtifactWriteReceiptSchema.parse({
        artifactRef,
        contentHash: sha256Hex(input.value),
        mediaType: input.mediaType,
        redacted: input.redacted,
      });
      setText(artifactRef, input.value, input.mediaType);

      return Promise.resolve(receipt);
    },
  };
};

export const createMemoryContextCapsuleActor =
  (): MemoryContextCapsuleActor => {
    const capsules = new Map<string, ContextCapsuleRecord>();
    const events = new Map<string, WorkflowEvent[]>();

    return {
      appendEvent(input) {
        const existing = events.get(input.workItemId) ?? [];
        events.set(input.workItemId, [...existing, input.event]);

        return Promise.resolve();
      },
      capsules,
      events,
      resolve(input) {
        const existing = capsules.get(input.workItemId);
        if (existing !== undefined) {
          const updated = ContextCapsuleRecordSchema.parse({
            ...existing,
            latestRunId: input.runId,
          });
          capsules.set(input.workItemId, updated);

          return Promise.resolve(updated);
        }

        const created = ContextCapsuleRecordSchema.parse({
          capsuleId: `capsule:${input.workItemId}`,
          createdAt: nowIso(),
          latestRunId: input.runId,
          pinnedPackageRefs: [],
          workItemId: input.workItemId,
        });
        capsules.set(input.workItemId, created);

        return Promise.resolve(created);
      },
    };
  };

export const createMemoryWorkflowStatusProjectionStore =
  (): MemoryWorkflowStatusProjectionStore => {
    const latest = new Map<string, WorkflowStatusProjection>();
    const records = new Map<string, WorkflowStatusProjection[]>();

    return {
      latest,
      record(input) {
        const projection = WorkflowStatusProjectionSchema.parse(
          input.projection
        );
        latest.set(projection.runId, projection);
        records.set(projection.runId, [
          ...(records.get(projection.runId) ?? []),
          projection,
        ]);

        return Promise.resolve();
      },
      records,
    };
  };

export const createMemoryPackageRegistryActor = (
  metadata: readonly PackageMetadata[]
): PackageRegistryActorContract => {
  const packageMetadata = metadata.map((packageRecord) =>
    PackageMetadataSchema.parse(packageRecord)
  );

  return {
    discoverMetadata(input: { readonly actor: Actor }) {
      if (input.actor.organizationId.length === 0) {
        return Promise.resolve([]);
      }

      return Promise.resolve(packageMetadata);
    },
    pinPackages(input: {
      readonly actor: Actor;
      readonly packageIds: readonly string[];
    }) {
      const requested = new Set(input.packageIds);
      const selected = packageMetadata.filter((packageRecord) =>
        requested.has(packageRecord.packageId)
      );
      if (selected.length !== input.packageIds.length) {
        return Promise.resolve({
          blocker: {
            code: "entitlement_missing",
            message:
              "One or more requested packages are not discoverable for this actor.",
            redacted: true,
          },
          status: "blocked",
        } as const);
      }

      const pinnedPackages: PinnedPackage[] = selected.map((packageRecord) =>
        PinnedPackageSchema.parse({
          artifactRef: packageRecord.latestArtifactRef,
          fileHashes: {
            "package.json": sha256Hex(
              `${packageRecord.packageId}@${packageRecord.latestVersion}`
            ),
          },
          manifestHash: hashJson(packageRecord),
          metadata: packageRecord,
          pinnedAt: nowIso(),
          version: packageRecord.latestVersion,
        })
      );

      return Promise.resolve({
        pinnedPackages,
        status: "pinned",
      } as const);
    },
  };
};

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

export const createIntegrationTestDynamicWorkflowPlanner =
  (): DynamicWorkflowPlannerPort => ({
    proposePlan(input) {
      const nonce = crypto.randomUUID();
      const createdAt = nowIso();
      const researchStepId = "research-review";
      const reviewStepId = "review-summary";
      const pinnedPackageRefs = input.pinnedPackages.map(
        (packageRecord) => packageRecord.artifactRef
      );
      const planner = {
        kind: "stochastic" as const,
        nonce,
        source: "integration-test-dynamic-workflow-planner",
      };
      const sideEffects =
        input.notification === undefined
          ? []
          : [
              {
                capability: "discord.message.send" as const,
                dryRun: input.notification.dryRun,
                payloadHash: input.notification.payloadHash,
                payloadRef: input.notification.payloadRef,
                resource: input.notification.resource,
                reviewGate: input.notification.reviewGate,
                secretRef: input.notification.secretRef,
                stepId: discordStepId,
              },
            ];
      const steps: DynamicWorkflowStep[] = [
        {
          dependsOn: [],
          kind: "research.review",
          outputPath: "outputs/research-review.json",
          packageRefs: pinnedPackageRefs,
          stepId: researchStepId,
          summary:
            "Run source-grounded research/review using the pinned packages.",
        },
      ];
      if (input.notification !== undefined) {
        steps.push({
          dependsOn: [researchStepId],
          dryRun: input.notification.dryRun,
          kind: "capability.discord.message",
          payloadHash: input.notification.payloadHash,
          payloadRef: input.notification.payloadRef,
          resource: input.notification.resource,
          reviewGate: input.notification.reviewGate,
          secretRef: input.notification.secretRef,
          stepId: discordStepId,
          summary:
            "Notify the review Discord channel through a leased capability.",
        });
      }
      steps.push({
        dependsOn:
          input.notification === undefined
            ? [researchStepId]
            : [researchStepId, discordStepId],
        kind: "review.summary",
        outputPath: "review/summary.json",
        stepId: reviewStepId,
        summary:
          "Capture the run summary, dynamic step receipts, and capability receipts.",
      });
      const machineId = `machine:${input.runId}:${sha256Hex(`${input.proposal.intent}:${nonce}`).slice(0, 12)}`;
      const harnessId = `harness:${input.runId}:${sha256Hex(`${machineId}:harness`).slice(0, 12)}`;
      const contractId = `verification:${input.runId}:${sha256Hex(`${machineId}:verification`).slice(0, 12)}`;
      const plannerLaneId = `lane:planner:${input.runId}`;
      const promptText = [
        "# Integration Test Planner Prompt",
        "",
        "This is an integration-test prompt fixture, not a real Pi or Think agent prompt.",
        "",
        `Intent: ${input.proposal.intent}`,
        `Requested packages: ${input.proposal.requestedPackageIds.join(", ")}`,
        `Available packages: ${input.availablePackages.map((packageRecord) => packageRecord.packageId).join(", ")}`,
        `Pinned package refs: ${pinnedPackageRefs.join(", ")}`,
        "",
        "Required output: DynamicWorkflowBlueprint with generated XState machine, generated harness, verification contract, output target, side-effect declarations, and lane evidence.",
      ].join("\n");
      const harnessSource = [
        'import type { DynamicWorkflowPlanDocument } from "../domain/schemas.ts";',
        "",
        `export const harnessId = ${JSON.stringify(harnessId)};`,
        "",
        "export const executeDynamicHarness = async (input: {",
        "  readonly plan: DynamicWorkflowPlanDocument;",
        "}) => {",
        "  return {",
        "    harnessId,",
        "    planId: input.plan.planId,",
        "    stepIds: input.plan.steps.map((step) => step.stepId),",
        '    warning: "integration-test harness source; real app runs agent lanes in sandboxes",',
        "  };",
        "};",
        "",
      ].join("\n");

      return Promise.resolve(
        DynamicWorkflowBlueprintSchema.parse({
          harness: {
            createdAt,
            entrypoint: "workflows/harness.ts",
            harnessId,
            language: "typescript",
            planner,
            runId: input.runId,
            schemaVersion: "workflow.generated-harness.v1",
            source: harnessSource,
            workItemId: input.workItemId,
          },
          machine: {
            createdAt,
            machineId,
            planner,
            runId: input.runId,
            schemaVersion: "workflow.xstate-machine.v1",
            stepOrder: steps.map((step) => step.stepId),
            workItemId: input.workItemId,
            xstate: {
              id: machineId,
              initial: "ready",
              states: createGeneratedWorkflowMachineStates(steps),
            },
          },
          plan: {
            actor: input.actor,
            createdAt,
            outputTarget: {
              kind: "artifact-only",
              path: "review/summary.json",
            },
            pinnedPackages: input.pinnedPackages,
            planId: `plan:${input.runId}:${sha256Hex(`${input.proposal.intent}:${nonce}`).slice(0, 12)}`,
            planner,
            proposal: {
              intent: input.proposal.intent,
              requestedPackageIds: input.proposal.requestedPackageIds,
              stochasticNotes: input.proposal.stochasticNotes,
            },
            runId: input.runId,
            safety: {
              capabilityLeasesRequired: true,
              durableState: "artifacts-d1-do-r2-only",
              scratchOnly: true,
            },
            schemaVersion: "workflow.dynamic-plan.v1",
            sideEffects,
            steps,
            workItemId: input.workItemId,
          },
          plannerLane: {
            completedAt: createdAt,
            kind: "planner",
            laneId: plannerLaneId,
            outputRefs: [],
            prompt: {
              mediaType: "text/markdown",
              path: "lanes/planner/prompt.md",
              redacted: true,
              value: promptText,
            },
            realAgent: false,
            redacted: true,
            runtime: "integration-test",
            startedAt: createdAt,
            status: "completed",
            traceContext: workflowTraceContextForLane({
              laneId: plannerLaneId,
              runId: input.runId,
            }),
            transcript: {
              mediaType: "text/markdown",
              path: "lanes/planner/transcript.md",
              redacted: true,
              value: [
                "# Integration Test Planner Transcript",
                "",
                "No real Pi or Think agent was invoked.",
                "The memory adapter constructed the blueprint in process.",
                "",
                `Machine id: ${machineId}`,
                `Harness id: ${harnessId}`,
                `Verification contract id: ${contractId}`,
              ].join("\n"),
            },
          },
          verificationContract: {
            checks: [
              {
                checkId: "integration-test-receipts-visible",
                evidenceRequired:
                  "Run receipt must expose integration-test planner and worker lane receipts.",
                severity: "warning",
                summary:
                  "Integration-test execution must not masquerade as real agent execution.",
              },
            ],
            contractId,
            createdAt,
            outputPath: "artifacts/verification/result.json",
            runId: input.runId,
            schemaVersion: "workflow.verification-contract.v1",
            verifier: {
              kind: "deterministic",
              source: "integration-test-verifier-contract-not-executed",
            },
            workItemId: input.workItemId,
          },
        })
      );
    },
  });

interface MemoryCapabilityLeasePolicy {
  readonly discordSecretRef: string;
  readonly githubBranchCommitSecretRef?: string;
  readonly githubPullRequestSecretRef?: string;
  readonly linearCommentSecretRef?: string;
  readonly policyId: string;
  readonly wzrrdSecretRef?: string;
}

const policyIdForCapability = (input: {
  readonly basePolicyId: string;
  readonly capability: CapabilityLeaseRequest["capability"];
}): string => {
  if (input.capability === "wzrrd.site.publish") {
    return `${input.basePolicyId}:wzrrd`;
  }

  if (input.capability === "github.pull-request.create") {
    return `${input.basePolicyId}:github-pr`;
  }

  if (input.capability === "github.branch.commit") {
    return `${input.basePolicyId}:github-branch`;
  }

  if (input.capability === "linear.comment.create") {
    return `${input.basePolicyId}:linear-comment`;
  }

  return input.basePolicyId;
};

const validateMemorySecretPolicy = (input: {
  readonly policy: MemoryCapabilityLeasePolicy;
  readonly request: CapabilityLeaseRequest;
}): CapabilityLeaseDecision | null => {
  if (input.request.dryRun) {
    return null;
  }

  if (
    input.request.capability === "discord.message.send" &&
    input.request.secretRef !== input.policy.discordSecretRef
  ) {
    return denied(
      "secret_denied",
      "Discord send requires the trusted Discord bot secret reference."
    );
  }

  if (
    input.request.capability === "wzrrd.site.publish" &&
    input.request.secretRef !== input.policy.wzrrdSecretRef
  ) {
    return denied(
      "secret_denied",
      "Wzrrd publish requires the trusted Wzrrd secret reference."
    );
  }

  if (
    input.request.capability === "github.pull-request.create" &&
    input.request.secretRef !== input.policy.githubPullRequestSecretRef
  ) {
    return denied(
      "secret_denied",
      "GitHub pull request creation requires the trusted GitHub secret reference."
    );
  }

  if (
    input.request.capability === "github.branch.commit" &&
    input.request.secretRef !== input.policy.githubBranchCommitSecretRef
  ) {
    return denied(
      "secret_denied",
      "GitHub branch commit requires the trusted GitHub branch secret reference."
    );
  }

  if (
    input.request.capability === "linear.comment.create" &&
    input.request.secretRef !== input.policy.linearCommentSecretRef
  ) {
    return denied(
      "secret_denied",
      "Linear comment creation requires the trusted Linear secret reference."
    );
  }

  return null;
};

const validateMemoryLeasePayload = async (input: {
  readonly artifactStore: ArtifactStoreContract;
  readonly request: CapabilityLeaseRequest;
}): Promise<CapabilityLeaseDecision | null> => {
  let payloadArtifact: unknown;
  try {
    payloadArtifact = await input.artifactStore.readJson({
      artifactRef: input.request.payloadRef,
    });
  } catch {
    return denied(
      "stale_package",
      "Capability lease payload artifact could not be read from the artifact store."
    );
  }

  if (input.request.capability === "discord.message.send") {
    const payload = DiscordMessagePayloadSchema.safeParse(payloadArtifact);
    if (
      !payload.success ||
      sha256Hex(payload.data.body) !== input.request.payloadHash
    ) {
      return denied(
        "payload_hash_mismatch",
        "Discord message payload hash does not match the pinned payload artifact."
      );
    }

    return null;
  }

  if (input.request.capability === "github.pull-request.create") {
    const payload = GitHubPullRequestPayloadSchema.safeParse(payloadArtifact);
    if (
      !payload.success ||
      hashJson(payload.data) !== input.request.payloadHash
    ) {
      return denied(
        "payload_hash_mismatch",
        "GitHub pull request payload hash does not match the pinned payload artifact."
      );
    }

    return null;
  }

  if (input.request.capability === "github.branch.commit") {
    const payload = GitHubBranchCommitPayloadSchema.safeParse(payloadArtifact);
    if (
      !payload.success ||
      hashJson(payload.data) !== input.request.payloadHash
    ) {
      return denied(
        "payload_hash_mismatch",
        "GitHub branch commit payload hash does not match the pinned payload artifact."
      );
    }

    return null;
  }

  if (input.request.capability === "linear.comment.create") {
    const payload = LinearCommentPayloadSchema.safeParse(payloadArtifact);
    if (
      !payload.success ||
      hashJson(payload.data) !== input.request.payloadHash
    ) {
      return denied(
        "payload_hash_mismatch",
        "Linear comment payload hash does not match the pinned payload artifact."
      );
    }

    return null;
  }

  const payload = WzrrdPublishPayloadSchema.safeParse(payloadArtifact);
  if (
    !payload.success ||
    hashJson(payload.data) !== input.request.payloadHash
  ) {
    return denied(
      "payload_hash_mismatch",
      "Wzrrd publish payload hash does not match the pinned payload artifact."
    );
  }

  return null;
};

export const createPolicyCapabilityLeaseBroker = (
  artifactStore: ArtifactStoreContract,
  policy: MemoryCapabilityLeasePolicy
): CapabilityLeaseBrokerActorContract => ({
  async recordDiscordExecution(input: {
    readonly delivery: DiscordDeliveryResult;
    readonly lease: CapabilityLease;
  }): Promise<CapabilityLeaseReceipt> {
    if (
      input.lease.capability !== "discord.message.send" ||
      input.lease.resource.kind !== "discord.channel"
    ) {
      throw new Error("Discord execution requires a Discord message lease.");
    }
    const delivery = DiscordDeliveryResultSchema.parse(input.delivery);
    const writeReceipt = await artifactStore.writeJson({
      path: "receipts/discord-capability.json",
      redacted: true,
      runId: input.lease.runId,
      value: {
        delivery,
        leaseId: input.lease.leaseId,
        payloadHash: input.lease.payloadHash,
        redacted: true,
      },
    });

    return CapabilityLeaseReceiptSchema.parse({
      capability: input.lease.capability,
      channelRef: input.lease.resource.channelRef,
      delivery,
      dryRun: input.lease.dryRun,
      leaseId: input.lease.leaseId,
      payloadHash: input.lease.payloadHash,
      payloadRef: input.lease.payloadRef,
      policyId: input.lease.policyId,
      receiptRef: writeReceipt.artifactRef,
      redacted: true,
      resource: input.lease.resource,
      reviewGate: input.lease.reviewGate,
      runId: input.lease.runId,
      secretRef: input.lease.secretRef,
      traceContext: input.lease.traceContext,
    });
  },
  async recordGitHubBranchCommitExecution(input: {
    readonly delivery: GitHubBranchCommitDeliveryResult;
    readonly lease: CapabilityLease;
  }): Promise<CapabilityLeaseReceipt> {
    if (
      input.lease.capability !== "github.branch.commit" ||
      input.lease.resource.kind !== "github.repository"
    ) {
      throw new Error(
        "GitHub execution requires a GitHub branch commit lease."
      );
    }
    const delivery = GitHubBranchCommitDeliveryResultSchema.parse(
      input.delivery
    );
    const writeReceipt = await artifactStore.writeJson({
      path: "receipts/github-branch-commit-capability.json",
      redacted: true,
      runId: input.lease.runId,
      value: {
        delivery,
        leaseId: input.lease.leaseId,
        payloadHash: input.lease.payloadHash,
        redacted: true,
      },
    });

    return CapabilityLeaseReceiptSchema.parse({
      capability: input.lease.capability,
      delivery,
      dryRun: input.lease.dryRun,
      leaseId: input.lease.leaseId,
      payloadHash: input.lease.payloadHash,
      payloadRef: input.lease.payloadRef,
      policyId: input.lease.policyId,
      receiptRef: writeReceipt.artifactRef,
      redacted: true,
      resource: input.lease.resource,
      reviewGate: input.lease.reviewGate,
      runId: input.lease.runId,
      secretRef: input.lease.secretRef,
      traceContext: input.lease.traceContext,
    });
  },
  async recordGitHubPullRequestExecution(input: {
    readonly delivery: GitHubPullRequestDeliveryResult;
    readonly lease: CapabilityLease;
  }): Promise<CapabilityLeaseReceipt> {
    if (
      input.lease.capability !== "github.pull-request.create" ||
      input.lease.resource.kind !== "github.repository"
    ) {
      throw new Error("GitHub execution requires a GitHub pull request lease.");
    }
    const delivery = GitHubPullRequestDeliveryResultSchema.parse(
      input.delivery
    );
    const writeReceipt = await artifactStore.writeJson({
      path: "receipts/github-pr-capability.json",
      redacted: true,
      runId: input.lease.runId,
      value: {
        delivery,
        leaseId: input.lease.leaseId,
        payloadHash: input.lease.payloadHash,
        redacted: true,
      },
    });

    return CapabilityLeaseReceiptSchema.parse({
      capability: input.lease.capability,
      delivery,
      dryRun: input.lease.dryRun,
      leaseId: input.lease.leaseId,
      payloadHash: input.lease.payloadHash,
      payloadRef: input.lease.payloadRef,
      policyId: input.lease.policyId,
      receiptRef: writeReceipt.artifactRef,
      redacted: true,
      resource: input.lease.resource,
      reviewGate: input.lease.reviewGate,
      runId: input.lease.runId,
      secretRef: input.lease.secretRef,
      traceContext: input.lease.traceContext,
    });
  },
  async recordLinearCommentExecution(input: {
    readonly delivery: LinearCommentDeliveryResult;
    readonly lease: CapabilityLease;
  }): Promise<CapabilityLeaseReceipt> {
    if (
      input.lease.capability !== "linear.comment.create" ||
      input.lease.resource.kind !== "linear.issue"
    ) {
      throw new Error("Linear execution requires a Linear comment lease.");
    }
    const delivery = LinearCommentDeliveryResultSchema.parse(input.delivery);
    const writeReceipt = await artifactStore.writeJson({
      path: "receipts/linear-comment-capability.json",
      redacted: true,
      runId: input.lease.runId,
      value: {
        delivery,
        leaseId: input.lease.leaseId,
        payloadHash: input.lease.payloadHash,
        redacted: true,
      },
    });

    return CapabilityLeaseReceiptSchema.parse({
      capability: input.lease.capability,
      delivery,
      dryRun: input.lease.dryRun,
      leaseId: input.lease.leaseId,
      payloadHash: input.lease.payloadHash,
      payloadRef: input.lease.payloadRef,
      policyId: input.lease.policyId,
      receiptRef: writeReceipt.artifactRef,
      redacted: true,
      resource: input.lease.resource,
      reviewGate: input.lease.reviewGate,
      runId: input.lease.runId,
      secretRef: input.lease.secretRef,
      traceContext: input.lease.traceContext,
    });
  },
  async recordWzrrdExecution(input: {
    readonly delivery: WzrrdPublishDeliveryResult;
    readonly lease: CapabilityLease;
  }): Promise<CapabilityLeaseReceipt> {
    if (
      input.lease.capability !== "wzrrd.site.publish" ||
      input.lease.resource.kind !== "wzrrd.site"
    ) {
      throw new Error("Wzrrd execution requires a Wzrrd publish lease.");
    }
    const delivery = WzrrdPublishDeliveryResultSchema.parse(input.delivery);
    const writeReceipt = await artifactStore.writeJson({
      path: "receipts/wzrrd-capability.json",
      redacted: true,
      runId: input.lease.runId,
      value: {
        delivery,
        leaseId: input.lease.leaseId,
        payloadHash: input.lease.payloadHash,
        redacted: true,
      },
    });

    return CapabilityLeaseReceiptSchema.parse({
      capability: input.lease.capability,
      delivery,
      dryRun: input.lease.dryRun,
      leaseId: input.lease.leaseId,
      payloadHash: input.lease.payloadHash,
      payloadRef: input.lease.payloadRef,
      policyId: input.lease.policyId,
      receiptRef: writeReceipt.artifactRef,
      redacted: true,
      resource: input.lease.resource,
      reviewGate: input.lease.reviewGate,
      runId: input.lease.runId,
      secretRef: input.lease.secretRef,
      traceContext: input.lease.traceContext,
    });
  },
  async requestLease(
    input: CapabilityLeaseRequest
  ): Promise<CapabilityLeaseDecision> {
    if (input.actor.id.length === 0) {
      return denied("missing_auth", "Actor identity is required.");
    }

    if (!input.dryRun && input.reviewGate.mode !== "approved") {
      const code: CapabilityDenialCode =
        input.reviewGate.mode === "rejected"
          ? "review_rejected"
          : "review_required";
      return denied(
        code,
        `${input.capability} requires review approval unless dry-run.`
      );
    }

    const secretDecision = validateMemorySecretPolicy({
      policy,
      request: input,
    });
    if (secretDecision !== null) {
      return secretDecision;
    }

    const payloadDecision = await validateMemoryLeasePayload({
      artifactStore,
      request: input,
    });
    if (payloadDecision !== null) {
      return payloadDecision;
    }

    const lease = CapabilityLeaseSchema.parse({
      actor: input.actor,
      capability: input.capability,
      capabilityRef: `capability:${input.capability}:${input.runId}`,
      dryRun: input.dryRun,
      expiresAt: input.expiresAt,
      leaseId: `lease:${input.capability}:${input.runId}`,
      payloadHash: input.payloadHash,
      payloadRef: input.payloadRef,
      policyId: policyIdForCapability({
        basePolicyId: policy.policyId,
        capability: input.capability,
      }),
      receiptSink: input.receiptSink,
      redacted: true,
      resource: input.resource,
      reviewGate: input.reviewGate,
      rollbackRef: input.rollbackRef,
      runId: input.runId,
      secretRef: input.secretRef,
      traceContext: input.traceContext,
      workItemId: input.workItemId,
    });

    return { lease, status: "issued" };
  },
});

export const createDryRunDiscordMessageAdapter =
  (): DiscordMessageCapabilityAdapter => ({
    execute(input: {
      readonly lease: CapabilityLease;
      readonly payload: DiscordMessagePayload;
    }) {
      if (
        input.lease.capability !== "discord.message.send" ||
        input.lease.resource.kind !== "discord.channel"
      ) {
        return Promise.resolve({
          blocker: {
            code: "capability_denied",
            message:
              "Discord message adapter requires a Discord message lease.",
            redacted: true,
          },
          status: "blocked",
        } as const);
      }

      if (!input.lease.dryRun) {
        return Promise.resolve({
          blocker: {
            code: "adapter_unavailable",
            message: "Real Discord send adapter is not configured.",
            redacted: true,
          },
          status: "blocked",
        } as const);
      }

      if (input.payload.bodyHash !== input.lease.payloadHash) {
        return Promise.resolve({
          blocker: {
            code: "payload_hash_mismatch",
            message: "Discord payload no longer matches the lease.",
            redacted: true,
          },
          status: "blocked",
        } as const);
      }

      return Promise.resolve(
        DiscordDeliveryResultSchema.parse({
          channelRef: input.lease.resource.channelRef,
          dryRun: true,
          messageId: `dry-run:${input.lease.runId}`,
          payloadHash: input.lease.payloadHash,
          redacted: true,
          serverRef: input.lease.resource.serverRef,
          status: "dry-run",
        })
      );
    },
  });

export const createMemoryReviewGateActor = (
  artifactStore: ArtifactStoreContract
): ReviewGateActorContract => ({
  summarize(input) {
    const reviewId = `review:${input.runId}:summary`;

    return artifactStore.writeJson({
      path: input.outputPath ?? "review/summary.json",
      redacted: true,
      runId: input.runId,
      value: ReviewSummaryDocumentSchema.parse({
        capabilityCount: input.capabilityReceipts.length,
        capabilityReceiptRefs: input.capabilityReceipts.map(
          (receipt) => receipt.receiptRef
        ),
        eventCount: input.eventLog.length,
        eventLog: input.eventLog,
        finalStateBeforeCapture: input.eventLog.at(-1)?.state ?? "received",
        generatedAt: nowIso(),
        redacted: true,
        reviewId,
        runId: input.runId,
        schemaVersion: "workflow.review-summary.v1",
        status: "summary-captured",
        stepArtifactRefs: input.stepArtifactRefs,
      }),
    });
  },
});

export const createDryRunWzrrdPublishAdapter =
  (): WzrrdPublishCapabilityAdapter => ({
    execute(input: {
      readonly lease: CapabilityLease;
      readonly payload: WzrrdPublishPayload;
    }) {
      if (
        input.lease.capability !== "wzrrd.site.publish" ||
        input.lease.resource.kind !== "wzrrd.site"
      ) {
        return Promise.resolve({
          blocker: {
            code: "capability_denied",
            message: "Wzrrd publish adapter requires a Wzrrd publish lease.",
            redacted: true,
          },
          status: "blocked",
        } as const);
      }

      if (!input.lease.dryRun) {
        return Promise.resolve({
          blocker: {
            code: "adapter_unavailable",
            message: "Real Wzrrd publish adapter is not configured.",
            redacted: true,
          },
          status: "blocked",
        } as const);
      }

      const payloadHash = hashJson(input.payload);
      if (payloadHash !== input.lease.payloadHash) {
        return Promise.resolve({
          blocker: {
            code: "payload_hash_mismatch",
            message: "Wzrrd publish payload no longer matches the lease.",
            redacted: true,
          },
          status: "blocked",
        } as const);
      }

      return Promise.resolve(
        WzrrdPublishDeliveryResultSchema.parse({
          dryRun: true,
          payloadHash,
          redacted: true,
          reviewSurfaceRef: input.payload.reviewSurface.artifactRef,
          slug: input.payload.slug,
          status: "dry-run",
          url: `https://${input.payload.slug}.wzrrd.sh/`,
        })
      );
    },
  });

export const createDryRunGitHubPullRequestAdapter =
  (): GitHubPullRequestCapabilityAdapter => ({
    execute(input: {
      readonly lease: CapabilityLease;
      readonly payload: GitHubPullRequestPayload;
    }) {
      if (
        input.lease.capability !== "github.pull-request.create" ||
        input.lease.resource.kind !== "github.repository"
      ) {
        return Promise.resolve({
          blocker: {
            code: "capability_denied",
            message:
              "GitHub pull request adapter requires a GitHub pull request lease.",
            redacted: true,
          },
          status: "blocked",
        } as const);
      }

      if (!input.lease.dryRun) {
        return Promise.resolve({
          blocker: {
            code: "adapter_unavailable",
            message: "Real GitHub pull request adapter is not configured.",
            redacted: true,
          },
          status: "blocked",
        } as const);
      }

      const payloadHash = hashJson(input.payload);
      if (payloadHash !== input.lease.payloadHash) {
        return Promise.resolve({
          blocker: {
            code: "payload_hash_mismatch",
            message: "GitHub pull request payload no longer matches the lease.",
            redacted: true,
          },
          status: "blocked",
        } as const);
      }

      if (
        input.payload.repositoryRef !== input.lease.resource.repositoryRef ||
        input.payload.baseBranch !== input.lease.resource.baseBranch ||
        input.payload.headBranch !== input.lease.resource.headBranch
      ) {
        return Promise.resolve({
          blocker: {
            code: "resource_scope_denied",
            message:
              "GitHub pull request payload resource does not match the lease.",
            redacted: true,
          },
          status: "blocked",
        } as const);
      }

      const normalizedRepositoryRef = input.payload.repositoryRef.startsWith(
        "github:repo:"
      )
        ? input.payload.repositoryRef.slice("github:repo:".length)
        : input.payload.repositoryRef;

      return Promise.resolve(
        GitHubPullRequestDeliveryResultSchema.parse({
          baseBranch: input.payload.baseBranch,
          dryRun: true,
          headBranch: input.payload.headBranch,
          payloadHash,
          pullRequestUrl: `https://github.com/${normalizedRepositoryRef}/compare/${encodeURIComponent(input.payload.baseBranch)}...${encodeURIComponent(input.payload.headBranch)}?expand=1`,
          redacted: true,
          repositoryRef: input.payload.repositoryRef,
          status: "dry-run",
        })
      );
    },
  });

export const createDryRunGitHubBranchCommitAdapter =
  (): GitHubBranchCommitCapabilityAdapter => ({
    execute(input: {
      readonly lease: CapabilityLease;
      readonly payload: GitHubBranchCommitPayload;
    }) {
      if (
        input.lease.capability !== "github.branch.commit" ||
        input.lease.resource.kind !== "github.repository"
      ) {
        return Promise.resolve({
          blocker: {
            code: "capability_denied",
            message:
              "GitHub branch commit adapter requires a GitHub branch commit lease.",
            redacted: true,
          },
          status: "blocked",
        } as const);
      }

      if (!input.lease.dryRun) {
        return Promise.resolve({
          blocker: {
            code: "adapter_unavailable",
            message: "Real GitHub branch commit adapter is not configured.",
            redacted: true,
          },
          status: "blocked",
        } as const);
      }

      const payloadHash = hashJson(input.payload);
      if (payloadHash !== input.lease.payloadHash) {
        return Promise.resolve({
          blocker: {
            code: "payload_hash_mismatch",
            message:
              "GitHub branch commit payload no longer matches the lease.",
            redacted: true,
          },
          status: "blocked",
        } as const);
      }

      if (
        input.payload.repositoryRef !== input.lease.resource.repositoryRef ||
        input.payload.baseBranch !== input.lease.resource.baseBranch ||
        input.payload.headBranch !== input.lease.resource.headBranch
      ) {
        return Promise.resolve({
          blocker: {
            code: "resource_scope_denied",
            message:
              "GitHub branch commit payload resource does not match the lease.",
            redacted: true,
          },
          status: "blocked",
        } as const);
      }

      return Promise.resolve(
        GitHubBranchCommitDeliveryResultSchema.parse({
          baseBranch: input.payload.baseBranch,
          branchUrl: `https://github.com/${input.payload.repositoryRef}/tree/${encodeURIComponent(input.payload.headBranch)}`,
          dryRun: true,
          fileCount: input.payload.files.length,
          headBranch: input.payload.headBranch,
          payloadHash,
          redacted: true,
          repositoryRef: input.payload.repositoryRef,
          status: "dry-run",
        })
      );
    },
  });

export const createDryRunLinearCommentAdapter =
  (): LinearCommentCapabilityAdapter => ({
    execute(input: {
      readonly lease: CapabilityLease;
      readonly payload: LinearCommentPayload;
    }) {
      if (
        input.lease.capability !== "linear.comment.create" ||
        input.lease.resource.kind !== "linear.issue"
      ) {
        return Promise.resolve({
          blocker: {
            code: "capability_denied",
            message: "Linear comment adapter requires a Linear comment lease.",
            redacted: true,
          },
          status: "blocked",
        } as const);
      }

      if (!input.lease.dryRun) {
        return Promise.resolve({
          blocker: {
            code: "adapter_unavailable",
            message: "Real Linear comment adapter is not configured.",
            redacted: true,
          },
          status: "blocked",
        } as const);
      }

      const payloadHash = hashJson(input.payload);
      if (payloadHash !== input.lease.payloadHash) {
        return Promise.resolve({
          blocker: {
            code: "payload_hash_mismatch",
            message: "Linear comment payload no longer matches the lease.",
            redacted: true,
          },
          status: "blocked",
        } as const);
      }

      if (input.payload.issueRef !== input.lease.resource.issueRef) {
        return Promise.resolve({
          blocker: {
            code: "resource_scope_denied",
            message:
              "Linear comment payload issue does not match the leased issue resource.",
            redacted: true,
          },
          status: "blocked",
        } as const);
      }

      return Promise.resolve(
        LinearCommentDeliveryResultSchema.parse({
          dryRun: true,
          issueRef: input.lease.resource.issueRef,
          payloadHash,
          redacted: true,
          status: "dry-run",
        })
      );
    },
  });
