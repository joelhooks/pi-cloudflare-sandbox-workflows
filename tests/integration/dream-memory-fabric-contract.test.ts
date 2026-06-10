import { describe, expect, it } from "vitest";

import { DynamicWorkflowStepSchema } from "../../src/app/domain/schemas.ts";
import {
  dreamMemoryFabricPackageSeedTemplate,
  dreamMemoryFabricPackageMetadata,
} from "../../src/cartridges/dream-memory-fabric/package-seed.ts";
import {
  DreamBackfillRunReceiptDocumentSchema,
  DreamBackfillPlanDocumentSchema,
  DreamCaptureReceiptDocumentSchema,
  DreamCorrelationGraphDocumentSchema,
  DreamHitlDecisionDocumentSchema,
  DreamHitlFollowUpRunRequestDocumentSchema,
  DreamHitlDecisionWorkflowSeedDocumentSchema,
  DreamHitlReportDocumentSchema,
  DreamHydrationDocumentSchema,
  DreamMemoryRelayEndpointCatalogSchema,
  DreamMemoryRelayRequestEnvelopeSchema,
  DreamMemorySearchDocumentSchema,
  DreamRefinementProposalDocumentSchema,
  DreamRuntimeCoverageSchema,
  DreamSourceProfileSchema,
  DreamSignalDocumentSchema,
  DreamSourcePackDispositionSchema,
  DreamSourceHealthDocumentSchema,
  DreamSourceInventoryDocumentSchema,
} from "../../src/cartridges/dream-memory-fabric/schemas.ts";
import { dreamTranscriptReviewSourceProfile } from "../../src/cartridges/dream-memory-fabric/source-profile.ts";

const timestamp = "2026-06-09T18:00:00.000Z";
const hash = "a".repeat(64);

const actor = {
  id: "actor:dream-planner",
  organizationId: "org:joelhooks",
  roleIds: ["dream.operator"],
  sessionId: "session:dream-preflight-test",
  trustTier: "reviewed",
  type: "agent",
} as const;

const scope = {
  organizationId: "org:joelhooks",
  projectId: "project:system-dreaming",
} as const;

const artifactPin = (path: string) => ({
  artifactRef: `artifact://dream-preflight/run/${path}`,
  hash,
  mediaType: "application/json",
});

const receiptRef = {
  artifactRef: "artifact://dream-preflight/run/receipts/pi.json",
  family: "agent-transcripts",
  hash,
  receiptId: "receipt:pi:1",
  redactedLocator: "redacted://pi-native-jsonl",
  runtime: "pi",
  sourceId: "source:pi-transcripts",
  timestamp,
} as const;

const source = (input: {
  readonly family:
    | "agent-transcripts"
    | "brain"
    | "cloudflare-runs"
    | "docs-pdf-brain";
  readonly label: string;
  readonly sourceId: string;
}) => ({
  adapter: {
    checkedAt: timestamp,
    health: "healthy",
    port: `MemoryInventoryPort:${input.sourceId}`,
  },
  authority: {
    count: 12,
    locatorHash: hash,
    redactedLocator: `redacted://${input.sourceId}`,
    sourceSystem: input.sourceId,
  },
  blindSpots: [],
  derivedIndexes: [
    {
      authorityCount: 12,
      derivedCount: 12,
      freshnessCheckedAt: timestamp,
      indexId: `${input.sourceId}:typesense`,
      indexKind: "typesense",
      status: "fresh",
    },
  ],
  family: input.family,
  freshness: {
    earliestAt: "2025-09-03T00:00:00.000Z",
    indexedAt: timestamp,
    latestAt: timestamp,
  },
  label: input.label,
  privacyTier: "private",
  scope,
  sourceId: input.sourceId,
});

const validInventory = () => ({
  actor,
  blindSpots: [
    "Claude local capture is missing and must not be hidden by Pi proxy hits.",
  ],
  generatedAt: timestamp,
  redacted: true,
  requiredRuntimes: ["pi", "codex", "claude", "cloudflare"],
  runId: "run-dream-preflight",
  runtimeCoverage: [
    {
      horizonCounts: [
        {
          earliestAt: "2025-09-03T00:00:00.000Z",
          hitCount: 42,
          horizon: "all-time",
          hydrationCount: 4,
          latestAt: timestamp,
          queryCount: 8,
        },
      ],
      nativeProof: {
        evidenceRefs: ["artifact://dream-preflight/run/pi/native-proof.json"],
        redactedLocator: "redacted://pi-native-jsonl",
        sourceId: "source:pi-transcripts",
      },
      runtime: "pi",
      sourceNative: true,
      status: "captured",
    },
    {
      falsePositiveReason:
        "Search hits came from Pi paths that mentioned Codex, not native ~/.codex/sessions paths.",
      horizonCounts: [],
      runtime: "codex",
      sourceNative: false,
      status: "false-positive",
    },
    {
      horizonCounts: [],
      missingReason:
        "No Claude capture state or native Claude transcript index was available to the relay.",
      runtime: "claude",
      sourceNative: false,
      status: "missing",
    },
    {
      horizonCounts: [
        {
          hitCount: 6,
          horizon: "7d",
          hydrationCount: 2,
          latestAt: timestamp,
          queryCount: 3,
        },
      ],
      nativeProof: {
        evidenceRefs: [
          "artifact://dream-preflight/run/cloudflare/event-stream.json",
        ],
        redactedLocator: "redacted://cloudflare-workflow-events",
        sourceId: "source:cloudflare-runs",
      },
      runtime: "cloudflare",
      sourceNative: true,
      status: "captured",
    },
  ],
  schemaVersion: "dream.source-inventory.v1",
  scope,
  sourceFamiliesExpected: [
    "agent-transcripts",
    "brain",
    "cloudflare-runs",
    "docs-pdf-brain",
    "repo-outputs",
  ],
  sources: [
    source({
      family: "agent-transcripts",
      label: "Native Pi transcripts",
      sourceId: "source:pi-transcripts",
    }),
    source({
      family: "agent-transcripts",
      label: "Native Codex transcripts",
      sourceId: "source:codex-transcripts",
    }),
    source({
      family: "brain",
      label: "Project Brain roots",
      sourceId: "source:brain-roots",
    }),
    source({
      family: "cloudflare-runs",
      label: "Cloudflare workflow outputs",
      sourceId: "source:cloudflare-runs",
    }),
    source({
      family: "docs-pdf-brain",
      label: "JoelClaw docs API",
      sourceId: "source:joelclaw-docs",
    }),
  ],
  summary:
    "Dream source inventory reports native coverage, false positives, and missing runtimes before retrieval.",
  workItemId: "work-item:dream-preflight",
});

describe("Dream memory fabric domain contracts", () => {
  it("treats the Dream source profile as package data, not the generated runtime machine", () => {
    const profile = DreamSourceProfileSchema.parse(
      dreamTranscriptReviewSourceProfile
    );
    const sourceProfileExport =
      dreamMemoryFabricPackageSeedTemplate.exports.find(
        (exportRecord) =>
          exportRecord.exportId === "dream-transcript-review-source-profile"
      );

    expect({
      exportedKind: sourceProfileExport?.kind,
      packageId: profile.packageId,
      packageMetadataHasHitlDecisionSchema:
        dreamMemoryFabricPackageMetadata.exports.some(
          (exportRecord) =>
            exportRecord.exportId === "dream-hitl-decision-schema" &&
            exportRecord.kind === "schema"
        ),
      packageMetadataHasHitlDecisionWorkflowSeedNode:
        dreamMemoryFabricPackageMetadata.exports.some(
          (exportRecord) =>
            exportRecord.exportId === "dream-hitl-decision-workflow-seed" &&
            exportRecord.kind === "workflow-node" &&
            exportRecord.nodeType === "joelclaw.dream.hitl-decision-seed"
        ),
      packageMetadataHasHitlFollowUpRunRequestNode:
        dreamMemoryFabricPackageMetadata.exports.some(
          (exportRecord) =>
            exportRecord.exportId === "dream-hitl-follow-up-run-request" &&
            exportRecord.kind === "workflow-node" &&
            exportRecord.nodeType ===
              "joelclaw.dream.hitl-follow-up-run-request"
        ),
      packageMetadataHasProfile: dreamMemoryFabricPackageMetadata.exports.some(
        (exportRecord) => exportRecord.kind === "source-profile"
      ),
      requiredMachines: profile.requiredMachineIds,
      sourceFamilies: profile.sourceFamiliesExpected,
      sourcePackIds: profile.sourcePacks.map((pack) => pack.packId),
      sourcePackPolicies: profile.sourcePacks.map(
        (pack) => pack.selectionPolicy
      ),
      workflowId: profile.workflowId,
    }).toStrictEqual({
      exportedKind: "source-profile",
      packageId: "workflow/dream-memory-fabric",
      packageMetadataHasHitlDecisionSchema: true,
      packageMetadataHasHitlDecisionWorkflowSeedNode: true,
      packageMetadataHasHitlFollowUpRunRequestNode: true,
      packageMetadataHasProfile: true,
      requiredMachines: ["blaine", "panda", "flagg", "cloudflare"],
      sourceFamilies: [
        "agent-transcripts",
        "brain",
        "cloudflare-runs",
        "docs-pdf-brain",
        "repo-outputs",
      ],
      sourcePackIds: [
        "source-pack:joelhooks:work-graph",
        "source-pack:badass-courses:aihero-support-sweep",
      ],
      sourcePackPolicies: ["optional-lease", "separate-workflow"],
      workflowId: "dream.memory-fabric",
    });
  });

  it("advertises optional leased source packs without expanding required Dream readiness", () => {
    const profile = DreamSourceProfileSchema.parse(
      dreamTranscriptReviewSourceProfile
    );
    const workGraphPack = profile.sourcePacks.find(
      (pack) => pack.packId === "source-pack:joelhooks:work-graph"
    );
    const aiheroPack = profile.sourcePacks.find(
      (pack) =>
        pack.packId === "source-pack:badass-courses:aihero-support-sweep"
    );

    expect({
      aiheroPolicy: aiheroPack?.selectionPolicy,
      optionalSurfaces: workGraphPack?.surfaces,
      requiredFamilies: profile.sourceFamiliesExpected,
      workGraphFamilies: workGraphPack?.sourceFamilies,
    }).toStrictEqual({
      aiheroPolicy: "separate-workflow",
      optionalSurfaces: ["github", "linear", "slack", "org-project-graph"],
      requiredFamilies: [
        "agent-transcripts",
        "brain",
        "cloudflare-runs",
        "docs-pdf-brain",
        "repo-outputs",
      ],
      workGraphFamilies: [
        "comms",
        "people-org-memory",
        "repo-outputs",
        "support",
      ],
    });
  });

  it("rejects Dream source profiles with duplicate source-pack ids", () => {
    const profile = DreamSourceProfileSchema.parse(
      dreamTranscriptReviewSourceProfile
    );
    const firstPack = profile.sourcePacks.at(0);
    if (firstPack === undefined) {
      throw new Error("Expected Dream transcript-review profile source packs.");
    }
    const result = DreamSourceProfileSchema.safeParse({
      ...profile,
      sourcePacks: [firstPack, firstPack],
    });

    expect({
      issueMessage: result.success ? null : result.error.issues.at(0)?.message,
      success: result.success,
    }).toStrictEqual({
      issueMessage:
        "Dream source profile sourcePacks packId values must be unique.",
      success: false,
    });
  });

  it("requires source pack dispositions to carry lease or missing-capability proof", () => {
    const baseDisposition = {
      capabilityKinds: [],
      leaseRefs: [],
      missingCapabilityKinds: [],
      packId: "source-pack:joelhooks:work-graph",
      packageId: "source-pack/joelhooks-work-graph",
      reason: "Generated planner disposition for optional source pack.",
      requiredCapabilityKinds: [
        "dream.memory.relay",
        "github.read",
        "linear.read",
        "slack.search",
      ],
      selectionPolicy: "optional-lease",
      sourceFamilies: ["comms", "people-org-memory", "repo-outputs", "support"],
      surfaces: ["github", "linear", "slack", "org-project-graph"],
    } as const;

    const selectedWithoutLease = DreamSourcePackDispositionSchema.safeParse({
      ...baseDisposition,
      capabilityKinds: [...baseDisposition.requiredCapabilityKinds],
      status: "selected-with-lease",
    });
    const skippedWithoutMissingCapabilities =
      DreamSourcePackDispositionSchema.safeParse({
        ...baseDisposition,
        status: "skipped-missing-lease",
      });
    const skippedWithMissingCapabilities =
      DreamSourcePackDispositionSchema.safeParse({
        ...baseDisposition,
        missingCapabilityKinds: [...baseDisposition.requiredCapabilityKinds],
        status: "skipped-missing-lease",
      });

    expect({
      selectedWithoutLease: selectedWithoutLease.success,
      skippedWithMissingCapabilities: skippedWithMissingCapabilities.success,
      skippedWithoutMissingCapabilities:
        skippedWithoutMissingCapabilities.success,
    }).toStrictEqual({
      selectedWithoutLease: false,
      skippedWithMissingCapabilities: true,
      skippedWithoutMissingCapabilities: false,
    });
  });

  it("captures source inventory without pretending false or missing runtime coverage is real", () => {
    const parsed = DreamSourceInventoryDocumentSchema.parse(validInventory());

    expect({
      codexStatus: parsed.runtimeCoverage.find(
        (coverage) => coverage.runtime === "codex"
      )?.status,
      requiredRuntimes: parsed.requiredRuntimes,
      schemaVersion: parsed.schemaVersion,
      sourceCount: parsed.sources.length,
    }).toStrictEqual({
      codexStatus: "false-positive",
      requiredRuntimes: ["pi", "codex", "claude", "cloudflare"],
      schemaVersion: "dream.source-inventory.v1",
      sourceCount: 5,
    });
  });

  it("rejects captured runtime coverage without native source proof", () => {
    const result = DreamRuntimeCoverageSchema.safeParse({
      horizonCounts: [],
      runtime: "codex",
      sourceNative: false,
      status: "captured",
    });

    expect({
      issueMessage: result.success ? null : result.error.issues.at(0)?.message,
      success: result.success,
    }).toStrictEqual({
      issueMessage: "Captured runtime coverage requires native source proof.",
      success: false,
    });
  });

  it("rejects inventory that omits a required runtime coverage finding", () => {
    const inventory = validInventory();
    const result = DreamSourceInventoryDocumentSchema.safeParse({
      ...inventory,
      runtimeCoverage: inventory.runtimeCoverage.filter(
        (coverage) => coverage.runtime !== "cloudflare"
      ),
    });

    expect({
      issueMessage: result.success ? null : result.error.issues.at(0)?.message,
      success: result.success,
    }).toStrictEqual({
      issueMessage:
        "Dream source inventory must explicitly report every required runtime.",
      success: false,
    });
  });

  it("captures source health and scoped backfill as recovery, not normal operation", () => {
    const health = DreamSourceHealthDocumentSchema.parse({
      checkedAt: timestamp,
      freshnessFailures: ["source:codex-transcripts index is stale."],
      indexHealth: [
        {
          authorityCount: 250,
          derivedCount: 0,
          freshnessCheckedAt: timestamp,
          indexId: "source:codex-transcripts:typesense",
          indexKind: "typesense",
          status: "stale",
        },
      ],
      inventoryRef: artifactPin("dream/source-inventory.json"),
      redacted: true,
      runId: "run-dream-preflight",
      schemaVersion: "dream.source-health.v1",
      status: "degraded",
      summary:
        "Health check found stale Codex derived index while authority still exists.",
      workItemId: "work-item:dream-preflight",
    });
    const backfillPlan = DreamBackfillPlanDocumentSchema.parse({
      actions: [
        {
          actionId: "backfill:codex-native-transcripts",
          authoritySourceId: "source:codex-transcripts",
          controlledScriptRef: "joelclaw:sessions/backfill-codex",
          derivedIndexId: "source:codex-transcripts:typesense",
          expectedAuthorityCount: 250,
          priority: "high",
          reason:
            "Native Codex files exist but derived index has no usable native coverage.",
          sourceFamily: "agent-transcripts",
          timeWindow: {
            from: "2025-09-03T00:00:00.000Z",
            to: timestamp,
          },
        },
      ],
      captureFixes: [
        {
          fixId: "capture:codex-to-joelclaw-runs",
          ownerRef: "system:joelclaw",
          reasonBackfillWasNeeded:
            "Codex sessions were present locally but not reliably captured as native run chunks.",
          targetSourceId: "source:codex-transcripts",
        },
      ],
      generatedAt: timestamp,
      healthRef: artifactPin("dream/source-health.json"),
      inventoryRef: artifactPin("dream/source-inventory.json"),
      mode: "recovery-not-normal-operation",
      redacted: true,
      runId: "run-dream-preflight",
      schemaVersion: "dream.backfill-plan.v1",
      status: "backfill-required",
      summary:
        "Backfill stale Codex derived index once, then fix capture so this is not normal workflow behavior.",
      workItemId: "work-item:dream-preflight",
    });

    expect({
      backfillMode: backfillPlan.mode,
      backfillStatus: backfillPlan.status,
      captureFixCount: backfillPlan.captureFixes.length,
      healthStatus: health.status,
    }).toStrictEqual({
      backfillMode: "recovery-not-normal-operation",
      backfillStatus: "backfill-required",
      captureFixCount: 1,
      healthStatus: "degraded",
    });
  });

  it("captures the full trusted relay contract for retrieval, correlation, backfill execution, and capture", () => {
    const relayRequest = DreamMemoryRelayRequestEnvelopeSchema.parse({
      actor,
      allowedSourceFamilies: ["agent-transcripts", "brain"],
      budget: {
        maxFiles: 50,
        maxRows: 100,
        maxTokens: 25_000,
      },
      idempotencyKey: "dream-memory-relay:run-dream-preflight:search",
      lease: {
        capability: "dream.memory.relay",
        leaseId: "lease:dream-memory-relay:run-dream-preflight:search",
        redacted: true,
        secretRef: "secretref:dream-memory-relay",
      },
      operation: "search",
      payload: {
        query: "repeated corrections around dynamic workflows",
      },
      purpose:
        "Search redacted Dream memory evidence without exposing raw transcripts.",
      redactionPolicy: {
        mode: "redacted-evidence",
        noCustomerDataInPublicArtifacts: true,
        noRawCredentials: true,
        noRawPrivatePaths: true,
        noRawTranscripts: true,
      },
      runId: "run-dream-preflight",
      schemaVersion: "dream.memory-relay.request.v1",
      scope,
      timeWindow: {
        label: "all-time",
      },
      traceContext: {
        parentSpanId: "span:run-dream-preflight:workflow",
        redacted: true,
        spanId: "span:run-dream-preflight:capability:search",
        traceId: "trace:run-dream-preflight",
      },
      workItemId: "work-item:dream-preflight",
    });
    const search = DreamMemorySearchDocumentSchema.parse({
      generatedAt: timestamp,
      hits: [
        {
          horizon: "all-time",
          receipts: [receiptRef],
          redactedExcerpt: "Dynamic workflows must show generated proof.",
          score: 0.91,
          summary:
            "Older memory reinforces the need for generated-machine proof.",
        },
      ],
      query: "dynamic workflow proof",
      redacted: true,
      runId: "run-dream-preflight",
      schemaVersion: "dream.memory-search.v1",
      workItemId: "work-item:dream-preflight",
    });
    const signals = DreamSignalDocumentSchema.parse({
      generatedAt: timestamp,
      redacted: true,
      runId: "run-dream-preflight",
      schemaVersion: "dream.signals.v1",
      signals: [
        {
          confidence: 0.8,
          kind: "correction",
          rating: 5,
          reasoning:
            "The same correction appears across recent and older receipts.",
          receipts: [receiptRef],
          signalId: "signal:dynamic-workflow-proof",
          summary: "Do not substitute deterministic scripts for dynamic proof.",
        },
      ],
      workItemId: "work-item:dream-preflight",
    });
    const hydration = DreamHydrationDocumentSchema.parse({
      generatedAt: timestamp,
      hydrated: [
        {
          fullTranscriptReturned: false,
          receipt: receiptRef,
          redactedExcerpt:
            "A report may not claim Cloudflare execution without proof.",
          summary: "Private transcript stayed behind the relay boundary.",
        },
      ],
      redacted: true,
      runId: "run-dream-preflight",
      schemaVersion: "dream.hydration.v1",
      workItemId: "work-item:dream-preflight",
    });
    const graph = DreamCorrelationGraphDocumentSchema.parse({
      edges: [
        {
          edgeId: "edge:signal-to-memory",
          evidence: [receiptRef],
          fromNodeId: "signal:dynamic-workflow-proof",
          relationship: "supports_dream",
          toNodeId: "memory:generated-machine-proof",
        },
      ],
      generatedAt: timestamp,
      nodes: [
        {
          label: "Dynamic workflow proof correction",
          nodeId: "signal:dynamic-workflow-proof",
          nodeType: "event",
          redacted: true,
        },
        {
          label: "Generated machine proof memory",
          nodeId: "memory:generated-machine-proof",
          nodeType: "memory",
          redacted: true,
        },
      ],
      redacted: true,
      runId: "run-dream-preflight",
      schemaVersion: "dream.correlation-graph.v1",
      workItemId: "work-item:dream-preflight",
    });
    const backfillReceipt = DreamBackfillRunReceiptDocumentSchema.parse({
      actionResults: [
        {
          actionId: "backfill:codex-native",
          indexedCount: 0,
          skippedReasons: ["Native Codex source not leased in this test."],
          status: "skipped",
        },
      ],
      completedAt: timestamp,
      planRef: artifactPin("dream/backfill-plan.json"),
      redacted: true,
      runId: "run-dream-preflight",
      schemaVersion: "dream.backfill-run-receipt.v1",
      workItemId: "work-item:dream-preflight",
    });
    const captureReceipt = DreamCaptureReceiptDocumentSchema.parse({
      captureKind: "artifact",
      capturedAt: timestamp,
      capturedRef: artifactPin("dream/correlation-graph.json"),
      readability: "actor-private",
      redacted: true,
      runId: "run-dream-preflight",
      schemaVersion: "dream.capture-receipt.v1",
      sourceSystem: "cloudflare-artifacts",
      workItemId: "work-item:dream-preflight",
    });
    const runCaptureReceipt = DreamCaptureReceiptDocumentSchema.parse({
      captureKind: "run",
      capturedAt: timestamp,
      capturedRef: artifactPin("dream/capture-run.json"),
      capturedRunId: "run-dream-preflight",
      readability: "actor-private",
      redacted: true,
      runId: "run-dream-preflight",
      schemaVersion: "dream.capture-receipt.v1",
      sourceSystem: "cloudflare-workflow-run",
      workItemId: "work-item:dream-preflight",
    });
    expect(() =>
      DreamCaptureReceiptDocumentSchema.parse({
        captureKind: "run",
        capturedAt: timestamp,
        capturedRef: artifactPin("dream/capture-run-missing-id.json"),
        readability: "actor-private",
        redacted: true,
        runId: "run-dream-preflight",
        schemaVersion: "dream.capture-receipt.v1",
        sourceSystem: "cloudflare-workflow-run",
        workItemId: "work-item:dream-preflight",
      })
    ).toThrow(/capturedRunId/u);
    const endpointCatalog = DreamMemoryRelayEndpointCatalogSchema.parse({
      endpoints: [
        {
          operation: "inventory",
          path: "/memory/inventory",
        },
        {
          operation: "search",
          path: "/memory/search",
        },
        {
          operation: "capture-artifact",
          path: "/memory/capture/artifact",
        },
      ],
      schemaVersion: "dream.memory-relay.endpoint-catalog.v1",
    });

    expect({
      backfillReceiptSchema: backfillReceipt.schemaVersion,
      captureReceiptReadability: captureReceipt.readability,
      capturedRunId:
        runCaptureReceipt.captureKind === "run"
          ? runCaptureReceipt.capturedRunId
          : null,
      endpointCount: endpointCatalog.endpoints.length,
      graphEdgeRelationship: graph.edges.at(0)?.relationship,
      hydrationReturnedFullTranscript:
        hydration.hydrated.at(0)?.fullTranscriptReturned,
      relayRequestSchema: relayRequest.schemaVersion,
      searchSchema: search.schemaVersion,
      signalKind: signals.signals.at(0)?.kind,
    }).toStrictEqual({
      backfillReceiptSchema: "dream.backfill-run-receipt.v1",
      captureReceiptReadability: "actor-private",
      capturedRunId: "run-dream-preflight",
      endpointCount: 3,
      graphEdgeRelationship: "supports_dream",
      hydrationReturnedFullTranscript: false,
      relayRequestSchema: "dream.memory-relay.request.v1",
      searchSchema: "dream.memory-search.v1",
      signalKind: "correction",
    });
  });

  it("captures Dream refinement proposals as next-workflow seed artifacts", () => {
    const proposals = DreamRefinementProposalDocumentSchema.parse({
      generatedAt: timestamp,
      nextWorkflowSeed: {
        plannerInstructions: [
          "Use accepted proposals as constraints for the next generated workflow.",
          "Follow sourceRefs and receipts before updating Brain or packages.",
        ],
        proposalIds: ["proposal:kernel-memory:1"],
        requiredCapabilityKinds: ["brain.update.review"],
        sourceRefs: [
          "artifact://dream-preflight/run/dream/memory-search.json",
          "artifact://dream-preflight/run/dream/hydration.json",
        ],
      },
      proposalCount: 1,
      proposals: [
        {
          proposalId: "proposal:kernel-memory:1",
          proposedNextStep:
            "Promote the accepted claim into the appropriate Brain/kernel artifact with receipt refs.",
          rating: 9,
          reasoning:
            "The proposal has hydrated evidence and should be reviewed as a kernel memory candidate.",
          receipts: [receiptRef],
          recommendation: "accept",
          sourceRefs: [
            "artifact://dream-preflight/run/dream/memory-search.json",
            "artifact://dream-preflight/run/dream/hydration.json",
          ],
          summary:
            "Generated-machine proof keeps recurring as a durable operating constraint.",
          targetKind: "kernel-memory",
          title: "Promote generated-machine proof memory",
        },
      ],
      redacted: true,
      runId: "run-dream-preflight",
      schemaVersion: "dream.refinement-proposals.v1",
      sourceRefs: [
        "artifact://dream-preflight/run/dream/memory-search.json",
        "artifact://dream-preflight/run/dream/hydration.json",
      ],
      workItemId: "work-item:dream-preflight",
    });

    expect({
      nextWorkflowSeedProposalIds: proposals.nextWorkflowSeed.proposalIds,
      proposalCount: proposals.proposalCount,
      rawTranscriptsReturned:
        JSON.stringify(proposals).includes("full transcript"),
      recommendation: proposals.proposals.at(0)?.recommendation,
      schemaVersion: proposals.schemaVersion,
      targetKind: proposals.proposals.at(0)?.targetKind,
    }).toStrictEqual({
      nextWorkflowSeedProposalIds: ["proposal:kernel-memory:1"],
      proposalCount: 1,
      rawTranscriptsReturned: false,
      recommendation: "accept",
      schemaVersion: "dream.refinement-proposals.v1",
      targetKind: "kernel-memory",
    });
  });

  it("captures HITL decisions as receipts that seed the next generated workflow", () => {
    const decisions = DreamHitlDecisionDocumentSchema.parse({
      decisionCount: 2,
      decisions: [
        {
          decision: "accept",
          decisionId: "decision:dream:generated-machine-proof",
          rating: 9,
          reasoning:
            "The report has generated-machine proof, redacted hydration, and enough source refs to promote the finding.",
          receiptTrail: [receiptRef],
          recommendation:
            "Update the Brain/kernel package contract and require this constraint in the next generated Dream workflow.",
          reviewedAt: timestamp,
          sourceRefs: [
            "artifact://dream-preflight/run/dream/hitl-report.json",
            "artifact://dream-preflight/run/dream/refinement-proposals.json",
          ],
          summary:
            "Generated-machine proof should become a durable Dream workflow constraint.",
          targetId: "proposal:kernel-memory:1",
          targetKind: "refinement-proposal",
          targetTitle: "Promote generated-machine proof memory",
        },
        {
          decision: "hold",
          decisionId: "decision:dream:optional-slack-pack",
          rating: 5,
          reasoning:
            "The optional source pack needs a scoped Slack lease before it can be included honestly.",
          receiptTrail: [],
          recommendation:
            "Keep it linked as an optional source-pack candidate until the lease exists.",
          reviewedAt: timestamp,
          sourceRefs: [
            "artifact://dream-preflight/run/dream/source-inventory.json",
          ],
          summary:
            "Optional Slack work-graph coverage is not ready for the transcript-review Dream.",
          targetId: "dream-card:optional-source-packs",
          targetKind: "dream-card",
          targetTitle: "Optional source packs need leases",
        },
      ],
      generatedAt: timestamp,
      nextWorkflowSeed: {
        artifactUpdateTargets: [
          {
            sourceRefs: [
              "artifact://dream-preflight/run/dream/hitl-report.json",
              "artifact://dream-preflight/run/dream/refinement-proposals.json",
            ],
            summary:
              "Update Dream Brain/package constraints with generated-machine proof requirements.",
            targetKind: "brain",
          },
          {
            sourceRefs: [
              "artifact://dream-preflight/run/dream/refinement-proposals.json",
            ],
            summary:
              "Feed accepted proof constraints into the next generated workflow plan.",
            targetKind: "workflow",
          },
        ],
        decisionIds: ["decision:dream:generated-machine-proof"],
        plannerInstructions: [
          "Treat accepted HITL decisions as constraints for the next generated workflow.",
          "Do not include held decisions until their capability leases exist.",
        ],
        requiredCapabilityKinds: ["brain.update.review"],
        sourceRefs: [
          "artifact://dream-preflight/run/dream/hitl-report.json",
          "artifact://dream-preflight/run/dream/refinement-proposals.json",
        ],
      },
      redacted: true,
      refinementProposalRef:
        "artifact://dream-preflight/run/dream/refinement-proposals.json",
      reportRef: "artifact://dream-preflight/run/dream/hitl-report.json",
      reviewer: {
        id: "actor:joel",
        organizationId: "org:joelhooks",
        roleIds: ["dream.reviewer"],
        sessionId: "session:dream-hitl-review",
        trustTier: "manual",
        type: "human",
      },
      runId: "run-dream-preflight",
      schemaVersion: "dream.hitl-decision.v1",
      sourceRefs: [
        "artifact://dream-preflight/run/dream/hitl-report.json",
        "artifact://dream-preflight/run/dream/refinement-proposals.json",
      ],
      workItemId: "work-item:dream-preflight",
    });
    const acceptedDecision = decisions.decisions.at(0);
    if (acceptedDecision === undefined) {
      throw new Error("Expected accepted decision.");
    }

    const workflowSeed = DreamHitlDecisionWorkflowSeedDocumentSchema.parse({
      acceptedDecisionIds: ["decision:dream:generated-machine-proof"],
      actionableDecisionCount: 1,
      actionableDecisions: [acceptedDecision],
      decisionRef: "artifact://dream-preflight/run/dream/hitl-decision.json",
      generatedAt: timestamp,
      heldDecisionIds: ["decision:dream:optional-slack-pack"],
      nextWorkflowSeed: decisions.nextWorkflowSeed,
      redacted: true,
      refinementProposalRef:
        "artifact://dream-preflight/run/dream/refinement-proposals.json",
      rejectedDecisionIds: [],
      reportRef: decisions.reportRef,
      runId: decisions.runId,
      schemaVersion: "dream.hitl-decision-workflow-seed.v1",
      sourceRefs: [
        "artifact://dream-preflight/run/dream/hitl-decision.json",
        "artifact://dream-preflight/run/dream/hitl-report.json",
        "artifact://dream-preflight/run/dream/refinement-proposals.json",
      ],
      status: "ready",
      summary:
        "HITL accepted one Dream decision and turned it into next workflow input.",
      workItemDecisionIds: [],
      workItemId: decisions.workItemId,
    });
    const followUpRunRequest = DreamHitlFollowUpRunRequestDocumentSchema.parse({
      actionableDecisionCount: workflowSeed.actionableDecisionCount,
      artifactUpdateTargets:
        workflowSeed.nextWorkflowSeed.artifactUpdateTargets,
      decisionWorkflowSeedRef:
        "artifact://dream-preflight/run/dream/hitl-decision-workflow-seed.json",
      generatedAt: timestamp,
      redacted: true,
      request: {
        actor: decisions.reviewer,
        planProposal: {
          intent:
            "Run follow-up Dream refinement work from accepted HITL decisions.",
          requestedPackageIds: ["workflow/dream-memory-fabric"],
          stochasticNotes: workflowSeed.nextWorkflowSeed.plannerInstructions,
        },
        runId: "run-dream-hitl-follow-up",
        workItemId: "work-item:dream-hitl-follow-up",
      },
      requestedPackageIds: ["workflow/dream-memory-fabric"],
      requiredCapabilityKinds:
        workflowSeed.nextWorkflowSeed.requiredCapabilityKinds,
      runId: workflowSeed.runId,
      schemaVersion: "dream.hitl-follow-up-run-request.v1",
      sourceRefs: [
        "artifact://dream-preflight/run/dream/hitl-decision-workflow-seed.json",
        ...workflowSeed.sourceRefs,
      ],
      status: "drafted",
      submitted: false,
      summary:
        "Drafted the next generated workflow request from accepted Dream HITL decisions.",
      workItemId: workflowSeed.workItemId,
    });

    expect({
      actionableSeedIds: decisions.nextWorkflowSeed.decisionIds,
      decisionCount: decisions.decisionCount,
      followUpRequestSchemaVersion: followUpRunRequest.schemaVersion,
      followUpRequestStatus: followUpRunRequest.status,
      followUpSubmitted: followUpRunRequest.submitted,
      rawTranscriptsReturned:
        JSON.stringify(decisions).includes("full transcript"),
      reviewerType: decisions.reviewer.type,
      schemaVersion: decisions.schemaVersion,
      updateTargets: decisions.nextWorkflowSeed.artifactUpdateTargets.map(
        (target) => target.targetKind
      ),
      workflowSeedActionableDecisionCount: workflowSeed.actionableDecisionCount,
      workflowSeedSchemaVersion: workflowSeed.schemaVersion,
      workflowSeedStatus: workflowSeed.status,
    }).toStrictEqual({
      actionableSeedIds: ["decision:dream:generated-machine-proof"],
      decisionCount: 2,
      followUpRequestSchemaVersion: "dream.hitl-follow-up-run-request.v1",
      followUpRequestStatus: "drafted",
      followUpSubmitted: false,
      rawTranscriptsReturned: false,
      reviewerType: "human",
      schemaVersion: "dream.hitl-decision.v1",
      updateTargets: ["brain", "workflow"],
      workflowSeedActionableDecisionCount: 1,
      workflowSeedSchemaVersion: "dream.hitl-decision-workflow-seed.v1",
      workflowSeedStatus: "ready",
    });
  });

  it("rejects no-action HITL follow-up requests with actionable decisions", () => {
    const result = DreamHitlFollowUpRunRequestDocumentSchema.safeParse({
      actionableDecisionCount: 1,
      artifactUpdateTargets: [],
      decisionWorkflowSeedRef:
        "artifact://dream-preflight/run/dream/hitl-decision-workflow-seed.json",
      generatedAt: timestamp,
      redacted: true,
      requestedPackageIds: ["workflow/dream-memory-fabric"],
      requiredCapabilityKinds: [],
      runId: "run-dream-hitl-follow-up",
      schemaVersion: "dream.hitl-follow-up-run-request.v1",
      sourceRefs: [
        "artifact://dream-preflight/run/dream/hitl-decision-workflow-seed.json",
      ],
      status: "no-actionable-decisions",
      submitted: false,
      summary: "No follow-up workflow request was drafted.",
      workItemId: "work-item:dream-hitl-follow-up",
    });

    expect({
      issueMessage: result.success ? null : result.error.issues.at(0)?.message,
      issuePath: result.success ? null : result.error.issues.at(0)?.path,
      success: result.success,
    }).toStrictEqual({
      issueMessage:
        "No-actionable-decisions follow-up artifacts must have actionableDecisionCount === 0.",
      issuePath: ["actionableDecisionCount"],
      success: false,
    });
  });

  it("rejects accepted HITL decisions that do not feed the next workflow seed", () => {
    const result = DreamHitlDecisionDocumentSchema.safeParse({
      decisionCount: 1,
      decisions: [
        {
          decision: "accept",
          decisionId: "decision:dream:missing-seed",
          rating: 8,
          reasoning:
            "This decision accepts work, but the next workflow seed is empty.",
          recommendation:
            "This should fail because acceptance without a seed becomes a dead-end report.",
          reviewedAt: timestamp,
          sourceRefs: ["artifact://dream-preflight/run/dream/hitl-report.json"],
          summary: "Accepted Dream decision with no seed.",
          targetId: "proposal:workflow:1",
          targetKind: "refinement-proposal",
          targetTitle: "Missing seed",
        },
      ],
      generatedAt: timestamp,
      nextWorkflowSeed: {},
      redacted: true,
      reportRef: "artifact://dream-preflight/run/dream/hitl-report.json",
      reviewer: {
        id: "actor:joel",
        organizationId: "org:joelhooks",
        roleIds: ["dream.reviewer"],
        sessionId: "session:dream-hitl-review",
        trustTier: "manual",
        type: "human",
      },
      runId: "run-dream-preflight",
      schemaVersion: "dream.hitl-decision.v1",
      sourceRefs: ["artifact://dream-preflight/run/dream/hitl-report.json"],
      workItemId: "work-item:dream-preflight",
    });

    expect(result.success).toBeFalsy();
    if (result.success) {
      throw new Error("Expected accepted HITL decision without seed to fail.");
    }
    expect(result.error.issues.map((issue) => issue.message)).toStrictEqual([
      "Accepted or work-conversion decisions must feed the next workflow seed.",
      "Accepted or work-conversion decisions require planner instructions for the next generated workflow.",
      "Accepted or work-conversion decisions require source refs for the next generated workflow.",
      "Accepted or work-conversion decisions require Brain/package/workflow artifact update targets.",
    ]);
  });

  it("captures the Dream HITL report as a redacted MDSvX artifact contract", () => {
    const report = DreamHitlReportDocumentSchema.parse({
      dreamCount: 1,
      dreams: [
        {
          rating: 9,
          reasoning:
            "The memory search hit has matching redacted hydration and can be reviewed without raw transcripts.",
          receipts: [receiptRef],
          recommendation:
            "Promote this to .brain only after the human reviewer accepts the receipt trail.",
          summary:
            "Generated workflow proof keeps recurring across the Dream memory fabric.",
          title: "Generated workflow proof needs human review",
        },
      ],
      expiresIn: "24h",
      generatedAt: timestamp,
      hitlDecisionContract: {
        artifactPath: "dream/hitl-decision.json",
        contractRef: "contract://workflow/dream-memory-fabric/hitl-decision.v1",
        decisionSchemaVersion: "dream.hitl-decision.v1",
        exportId: "dream-hitl-decision-schema",
        nextWorkflowSeedRequiredFor: ["accept", "turn-into-work"],
        sourceRefs: [
          "artifact://dream-preflight/run/dream/source-inventory.json",
          "artifact://dream-preflight/run/dream/source-health.json",
          "artifact://dream-preflight/run/dream/backfill-plan.json",
          "artifact://dream-preflight/run/dream/backfill-run-receipt.json",
          "artifact://dream-preflight/run/dream/memory-search.json",
          "artifact://dream-preflight/run/dream/hydration.json",
          "artifact://dream-preflight/run/dream/correlation-graph.json",
        ],
        targetKinds: ["dream-card", "refinement-proposal"],
      },
      mdsvx:
        "# Dream review\n\n## Run context\n\n## The actual dreams\n\n## What to do with these dreams\n\n## Actionable line items\n\n## Proof\n\n```d2\nsource -> report\n```\n\n## Technical appendix",
      noindex: true,
      proof: {
        dynamicGenerationProofLevel: "generated-machine",
        generatedArtifacts: {
          harness: {
            artifactRef:
              "artifact://dream-preflight/runs/run-dream-preflight/workflows/harness.json",
            entrypoint: "workflows/harness.ts",
            harnessId: "harness:run-dream-preflight",
            hash: "b".repeat(64),
            language: "typescript",
          },
          machine: {
            artifactRef:
              "artifact://dream-preflight/runs/run-dream-preflight/workflows/machine.config.json",
            hash: "a".repeat(64),
            machineId: "machine:run-dream-preflight",
            sourceArtifactRef:
              "artifact://dream-preflight/runs/run-dream-preflight/workflows/machine.ts",
            sourceHash: "c".repeat(64),
          },
          plan: {
            planId: "plan:run-dream-preflight",
            planner: {
              kind: "stochastic",
              nonce: "nonce:dream-preflight",
              source: "pi-agent-cli",
            },
            stepCount: 8,
          },
          verificationContract: {
            artifactRef:
              "artifact://dream-preflight/runs/run-dream-preflight/workflows/verification-contract.json",
            contractId: "verification:run-dream-preflight",
            hash: "d".repeat(64),
            mediaType: "application/json",
          },
        },
        rawTranscriptsReturned: false,
        stateMachineFigure: {
          aspectRatio: "3:5",
          component: "D2",
          machineBinding: {
            machineArtifactHash: "a".repeat(64),
            machineArtifactRef:
              "artifact://dream-preflight/runs/run-dream-preflight/workflows/machine.config.json",
            machineId: "machine:run-dream-preflight",
            machineSourceArtifactRef:
              "artifact://dream-preflight/runs/run-dream-preflight/workflows/machine.ts",
            machineSourceHash: "c".repeat(64),
            status: "bound-to-generated-machine",
          },
          machineId: "machine:run-dream-preflight",
          source: "s0 -> s1: NEXT",
          sourceHash: "e".repeat(64),
          sourceKind: "generated-xstate-machine",
          stateCount: 8,
          transitionCount: 9,
        },
      },
      receiptCount: 1,
      redacted: true,
      runId: "run-dream-preflight",
      schemaVersion: "dream.hitl-report.v1",
      sectionOrder: [
        "run-context",
        "actual-dreams",
        "what-to-do",
        "actionable-line-items",
        "proof",
        "technical-appendix",
      ],
      sourceRefs: [
        "artifact://dream-preflight/run/dream/source-inventory.json",
        "artifact://dream-preflight/run/dream/source-health.json",
        "artifact://dream-preflight/run/dream/backfill-plan.json",
        "artifact://dream-preflight/run/dream/backfill-run-receipt.json",
        "artifact://dream-preflight/run/dream/memory-search.json",
        "artifact://dream-preflight/run/dream/hydration.json",
        "artifact://dream-preflight/run/dream/correlation-graph.json",
      ],
      template: {
        defaultExpiresIn: "24h",
        format: "mdsvx",
        noindex: true,
        templateId: "joel/tufte-mdsvx",
        version: "0.1.0",
      },
      title: "Dream review",
      workItemId: "work-item:dream-preflight",
    });

    expect({
      decisionContract: report.hitlDecisionContract,
      dreamCount: report.dreamCount,
      machineRef: report.proof.generatedArtifacts.machine.artifactRef,
      mdsvxHasD2: report.mdsvx.includes("```d2"),
      proofLevel: report.proof.dynamicGenerationProofLevel,
      rawTranscriptsReturned: report.proof.rawTranscriptsReturned,
      sectionOrder: report.sectionOrder,
      stateMachineSourceHash: report.proof.stateMachineFigure.sourceHash,
      stateMachineSourceKind: report.proof.stateMachineFigure.sourceKind,
      template: `${report.template.templateId}@${report.template.version}`,
    }).toStrictEqual({
      decisionContract: {
        artifactPath: "dream/hitl-decision.json",
        contractRef: "contract://workflow/dream-memory-fabric/hitl-decision.v1",
        decisionSchemaVersion: "dream.hitl-decision.v1",
        exportId: "dream-hitl-decision-schema",
        nextWorkflowSeedRequiredFor: ["accept", "turn-into-work"],
        sourceRefs: [
          "artifact://dream-preflight/run/dream/source-inventory.json",
          "artifact://dream-preflight/run/dream/source-health.json",
          "artifact://dream-preflight/run/dream/backfill-plan.json",
          "artifact://dream-preflight/run/dream/backfill-run-receipt.json",
          "artifact://dream-preflight/run/dream/memory-search.json",
          "artifact://dream-preflight/run/dream/hydration.json",
          "artifact://dream-preflight/run/dream/correlation-graph.json",
        ],
        targetKinds: ["dream-card", "refinement-proposal"],
      },
      dreamCount: 1,
      machineRef:
        "artifact://dream-preflight/runs/run-dream-preflight/workflows/machine.config.json",
      mdsvxHasD2: true,
      proofLevel: "generated-machine",
      rawTranscriptsReturned: false,
      sectionOrder: [
        "run-context",
        "actual-dreams",
        "what-to-do",
        "actionable-line-items",
        "proof",
        "technical-appendix",
      ],
      stateMachineSourceHash: "e".repeat(64),
      stateMachineSourceKind: "generated-xstate-machine",
      template: "joel/tufte-mdsvx@0.1.0",
    });
  });

  it("allows generated workflows to include Dream preflight states before retrieval", () => {
    const steps = [
      DynamicWorkflowStepSchema.parse({
        config: {
          requiredRuntimes: ["pi", "codex", "claude", "cloudflare"],
          sourceFamiliesExpected: [
            "agent-transcripts",
            "brain",
            "cloudflare-runs",
            "docs-pdf-brain",
          ],
        },
        kind: "workflow.node.invoke",
        nodeType: "joelclaw.dream.source-inventory",
        outputPath: "dream/source-inventory.json",
        stepId: "inventory-memory-fabric",
        summary:
          "Inventory memory fabric sources before any retrieval lane runs.",
      }),
      DynamicWorkflowStepSchema.parse({
        config: {
          inventoryStepId: "inventory-memory-fabric",
        },
        dependsOn: ["inventory-memory-fabric"],
        kind: "workflow.node.invoke",
        nodeType: "joelclaw.dream.source-health",
        outputPath: "dream/source-health.json",
        stepId: "check-source-health",
        summary:
          "Check source freshness and derived index health before retrieval.",
      }),
      DynamicWorkflowStepSchema.parse({
        config: {
          healthStepId: "check-source-health",
          inventoryStepId: "inventory-memory-fabric",
        },
        dependsOn: ["check-source-health"],
        kind: "workflow.node.invoke",
        nodeType: "joelclaw.dream.backfill-plan",
        outputPath: "dream/backfill-plan.json",
        stepId: "plan-recovery-backfills",
        summary:
          "Plan scoped recovery backfills and capture fixes for stale sources.",
      }),
      DynamicWorkflowStepSchema.parse({
        config: {
          planStepId: "plan-recovery-backfills",
        },
        dependsOn: ["plan-recovery-backfills"],
        kind: "workflow.node.invoke",
        nodeType: "joelclaw.dream.backfill-run",
        outputPath: "dream/backfill-run-receipt.json",
        stepId: "run-recovery-backfills",
        summary:
          "Execute recovery backfill through a leased relay and emit a receipt.",
      }),
    ];

    expect(steps.map((step) => step.kind)).toStrictEqual([
      "workflow.node.invoke",
      "workflow.node.invoke",
      "workflow.node.invoke",
      "workflow.node.invoke",
    ]);
    expect(
      steps.map((step) =>
        step.kind === "workflow.node.invoke" ? step.nodeType : null
      )
    ).toStrictEqual([
      "joelclaw.dream.source-inventory",
      "joelclaw.dream.source-health",
      "joelclaw.dream.backfill-plan",
      "joelclaw.dream.backfill-run",
    ]);
  });
});
