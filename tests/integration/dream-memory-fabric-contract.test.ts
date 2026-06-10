import { describe, expect, it } from "vitest";

import { DynamicWorkflowStepSchema } from "../../src/app/domain/schemas.ts";
import {
  MemorySourcePackDispositionSchema,
  MemorySourceProfileSchema,
} from "../../src/app/domain/source-profile.ts";
import {
  memoryFabricPackageSeedTemplate,
  memoryFabricPackageMetadata,
} from "../../src/cartridges/memory-fabric/package-seed.ts";
import {
  MemoryCaptureReceiptDocumentSchema,
  MemoryCorrelationGraphDocumentSchema,
  MemoryHitlDecisionDocumentSchema,
  MemoryHitlFollowUpRunRequestDocumentSchema,
  MemoryHitlDecisionWorkflowSeedDocumentSchema,
  WorkflowHitlReportDocumentSchema,
  MemoryHydrationDocumentSchema,
  MemoryRelayEndpointCatalogSchema,
  MemoryRelayRequestEnvelopeSchema,
  MemorySearchDocumentSchema,
  MemoryRefinementProposalDocumentSchema,
  MemorySignalDocumentSchema,
} from "../../src/cartridges/memory-fabric/schemas.ts";
import { dreamTranscriptReviewSourceProfile } from "../../src/cartridges/memory-fabric/source-profile.ts";

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

describe("Dream memory fabric domain contracts", () => {
  it("treats the Memory source profile as package data, not the generated runtime machine", () => {
    const profile = MemorySourceProfileSchema.parse(
      dreamTranscriptReviewSourceProfile
    );
    const sourceProfileExport = memoryFabricPackageSeedTemplate.exports.find(
      (exportRecord) =>
        exportRecord.exportId === "dream-transcript-review-source-profile"
    );

    expect({
      exportedKind: sourceProfileExport?.kind,
      packageId: profile.packageId,
      packageMetadataHasHitlDecisionSchema:
        memoryFabricPackageMetadata.exports.some(
          (exportRecord) =>
            exportRecord.exportId === "memory-hitl-decision-schema" &&
            exportRecord.kind === "schema"
        ),
      packageMetadataHasHitlDecisionWorkflowSeedNode:
        memoryFabricPackageMetadata.exports.some(
          (exportRecord) =>
            exportRecord.exportId === "memory-hitl-decision-workflow-seed" &&
            exportRecord.kind === "workflow-node" &&
            exportRecord.nodeType === "joelclaw.memory.hitl-decision-seed"
        ),
      packageMetadataHasHitlFollowUpRunRequestNode:
        memoryFabricPackageMetadata.exports.some(
          (exportRecord) =>
            exportRecord.exportId === "memory-hitl-follow-up-run-request" &&
            exportRecord.kind === "workflow-node" &&
            exportRecord.nodeType ===
              "joelclaw.memory.hitl-follow-up-run-request"
        ),
      packageMetadataHasProfile: memoryFabricPackageMetadata.exports.some(
        (exportRecord) => exportRecord.kind === "source-profile"
      ),
      sourceFamilies: profile.sourceFamiliesExpected,
      sourcePackIds: profile.sourcePacks.map((pack) => pack.packId),
      sourcePackPolicies: profile.sourcePacks.map(
        (pack) => pack.selectionPolicy
      ),
      workflowId: profile.workflowId,
    }).toStrictEqual({
      exportedKind: "source-profile",
      packageId: "workflow/memory-fabric",
      packageMetadataHasHitlDecisionSchema: true,
      packageMetadataHasHitlDecisionWorkflowSeedNode: true,
      packageMetadataHasHitlFollowUpRunRequestNode: true,
      packageMetadataHasProfile: true,
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
    const profile = MemorySourceProfileSchema.parse(
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

  it("rejects Memory source profiles with duplicate source-pack ids", () => {
    const profile = MemorySourceProfileSchema.parse(
      dreamTranscriptReviewSourceProfile
    );
    const firstPack = profile.sourcePacks.at(0);
    if (firstPack === undefined) {
      throw new Error("Expected Dream transcript-review profile source packs.");
    }
    const result = MemorySourceProfileSchema.safeParse({
      ...profile,
      sourcePacks: [firstPack, firstPack],
    });

    expect({
      issueMessage: result.success ? null : result.error.issues.at(0)?.message,
      success: result.success,
    }).toStrictEqual({
      issueMessage:
        "Memory source profile sourcePacks packId values must be unique.",
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
        "memory.relay",
        "github.read",
        "linear.read",
        "slack.search",
      ],
      selectionPolicy: "optional-lease",
      sourceFamilies: ["comms", "people-org-memory", "repo-outputs", "support"],
      surfaces: ["github", "linear", "slack", "org-project-graph"],
    } as const;

    const selectedWithoutLease = MemorySourcePackDispositionSchema.safeParse({
      ...baseDisposition,
      capabilityKinds: [...baseDisposition.requiredCapabilityKinds],
      status: "selected-with-lease",
    });
    const skippedWithoutMissingCapabilities =
      MemorySourcePackDispositionSchema.safeParse({
        ...baseDisposition,
        status: "skipped-missing-lease",
      });
    const skippedWithMissingCapabilities =
      MemorySourcePackDispositionSchema.safeParse({
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

  it("captures the full trusted relay contract for retrieval, correlation, and capture", () => {
    const relayRequest = MemoryRelayRequestEnvelopeSchema.parse({
      actor,
      allowedSourceFamilies: ["agent-transcripts", "brain"],
      budget: {
        maxFiles: 50,
        maxRows: 100,
        maxTokens: 25_000,
      },
      idempotencyKey: "memory-relay:run-dream-preflight:search",
      lease: {
        capability: "memory.relay",
        leaseId: "lease:memory-relay:run-dream-preflight:search",
        redacted: true,
        secretRef: "secretref:memory-relay",
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
      schemaVersion: "memory.relay.request.v1",
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
    const search = MemorySearchDocumentSchema.parse({
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
      schemaVersion: "memory.search.v1",
      workItemId: "work-item:dream-preflight",
    });
    const signals = MemorySignalDocumentSchema.parse({
      generatedAt: timestamp,
      redacted: true,
      runId: "run-dream-preflight",
      schemaVersion: "memory.signals.v1",
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
    const hydration = MemoryHydrationDocumentSchema.parse({
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
      schemaVersion: "memory.hydration.v1",
      workItemId: "work-item:dream-preflight",
    });
    const graph = MemoryCorrelationGraphDocumentSchema.parse({
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
      schemaVersion: "memory.correlation-graph.v1",
      workItemId: "work-item:dream-preflight",
    });
    const captureReceipt = MemoryCaptureReceiptDocumentSchema.parse({
      captureKind: "artifact",
      capturedAt: timestamp,
      capturedRef: artifactPin("dream/correlation-graph.json"),
      readability: "actor-private",
      redacted: true,
      runId: "run-dream-preflight",
      schemaVersion: "memory.capture-receipt.v1",
      sourceSystem: "cloudflare-artifacts",
      workItemId: "work-item:dream-preflight",
    });
    const runCaptureReceipt = MemoryCaptureReceiptDocumentSchema.parse({
      captureKind: "run",
      capturedAt: timestamp,
      capturedRef: artifactPin("dream/capture-run.json"),
      capturedRunId: "run-dream-preflight",
      readability: "actor-private",
      redacted: true,
      runId: "run-dream-preflight",
      schemaVersion: "memory.capture-receipt.v1",
      sourceSystem: "cloudflare-workflow-run",
      workItemId: "work-item:dream-preflight",
    });
    expect(() =>
      MemoryCaptureReceiptDocumentSchema.parse({
        captureKind: "run",
        capturedAt: timestamp,
        capturedRef: artifactPin("dream/capture-run-missing-id.json"),
        readability: "actor-private",
        redacted: true,
        runId: "run-dream-preflight",
        schemaVersion: "memory.capture-receipt.v1",
        sourceSystem: "cloudflare-workflow-run",
        workItemId: "work-item:dream-preflight",
      })
    ).toThrow(/capturedRunId/u);
    const endpointCatalog = MemoryRelayEndpointCatalogSchema.parse({
      endpoints: [
        {
          operation: "search",
          path: "/memory/search",
        },
        {
          operation: "capture-artifact",
          path: "/memory/capture/artifact",
        },
      ],
      schemaVersion: "memory.relay.endpoint-catalog.v1",
    });

    expect({
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
      captureReceiptReadability: "actor-private",
      capturedRunId: "run-dream-preflight",
      endpointCount: 2,
      graphEdgeRelationship: "supports_dream",
      hydrationReturnedFullTranscript: false,
      relayRequestSchema: "memory.relay.request.v1",
      searchSchema: "memory.search.v1",
      signalKind: "correction",
    });
  });

  it("captures Dream refinement proposals as next-workflow seed artifacts", () => {
    const proposals = MemoryRefinementProposalDocumentSchema.parse({
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
      schemaVersion: "memory.refinement-proposals.v1",
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
      schemaVersion: "memory.refinement-proposals.v1",
      targetKind: "kernel-memory",
    });
  });

  it("captures HITL decisions as receipts that seed the next generated workflow", () => {
    const decisions = MemoryHitlDecisionDocumentSchema.parse({
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
      schemaVersion: "memory.hitl-decision.v1",
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

    const workflowSeed = MemoryHitlDecisionWorkflowSeedDocumentSchema.parse({
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
      schemaVersion: "memory.hitl-decision-workflow-seed.v1",
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
    const followUpRunRequest = MemoryHitlFollowUpRunRequestDocumentSchema.parse(
      {
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
            requestedPackageIds: ["workflow/memory-fabric"],
            stochasticNotes: workflowSeed.nextWorkflowSeed.plannerInstructions,
          },
          runId: "run-memory-hitl-follow-up",
          workItemId: "work-item:memory-hitl-follow-up",
        },
        requestedPackageIds: ["workflow/memory-fabric"],
        requiredCapabilityKinds:
          workflowSeed.nextWorkflowSeed.requiredCapabilityKinds,
        runId: workflowSeed.runId,
        schemaVersion: "memory.hitl-follow-up-run-request.v1",
        sourceRefs: [
          "artifact://dream-preflight/run/dream/hitl-decision-workflow-seed.json",
          ...workflowSeed.sourceRefs,
        ],
        status: "drafted",
        submitted: false,
        summary:
          "Drafted the next generated workflow request from accepted Dream HITL decisions.",
        workItemId: workflowSeed.workItemId,
      }
    );

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
      followUpRequestSchemaVersion: "memory.hitl-follow-up-run-request.v1",
      followUpRequestStatus: "drafted",
      followUpSubmitted: false,
      rawTranscriptsReturned: false,
      reviewerType: "human",
      schemaVersion: "memory.hitl-decision.v1",
      updateTargets: ["brain", "workflow"],
      workflowSeedActionableDecisionCount: 1,
      workflowSeedSchemaVersion: "memory.hitl-decision-workflow-seed.v1",
      workflowSeedStatus: "ready",
    });
  });

  it("rejects no-action HITL follow-up requests with actionable decisions", () => {
    const result = MemoryHitlFollowUpRunRequestDocumentSchema.safeParse({
      actionableDecisionCount: 1,
      artifactUpdateTargets: [],
      decisionWorkflowSeedRef:
        "artifact://dream-preflight/run/dream/hitl-decision-workflow-seed.json",
      generatedAt: timestamp,
      redacted: true,
      requestedPackageIds: ["workflow/memory-fabric"],
      requiredCapabilityKinds: [],
      runId: "run-memory-hitl-follow-up",
      schemaVersion: "memory.hitl-follow-up-run-request.v1",
      sourceRefs: [
        "artifact://dream-preflight/run/dream/hitl-decision-workflow-seed.json",
      ],
      status: "no-actionable-decisions",
      submitted: false,
      summary: "No follow-up workflow request was drafted.",
      workItemId: "work-item:memory-hitl-follow-up",
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
    const result = MemoryHitlDecisionDocumentSchema.safeParse({
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
      schemaVersion: "memory.hitl-decision.v1",
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
    const reportDefinitionOfDoneAudit = {
      generatedAt: timestamp,
      items: [
        {
          evidenceRefs: ["node:joelclaw.memory.hitl-report"],
          requirement:
            "Dream report is emitted by the installed Dream workflow cartridge/package.",
          requirementId: "dream-cartridge-package",
          status: "captured",
          summary:
            "`joelclaw.memory.hitl-report` produced the JSON/MDSvX report as a cartridge-owned workflow node.",
        },
        {
          requirement:
            "Cloudflare leases memory/search/hydration/backfill capabilities through the trusted relay.",
          requirementId: "worker-facing-relay-capability-lease",
          status: "not-proven",
          summary:
            "Relay lease sidecars are verified by memory.generated-workflow-proof.v1, not the report schema fixture.",
        },
        {
          requirement:
            "Dream is submitted to and executed by the deployed Cloudflare workflow app.",
          requirementId: "live-cloudflare-execution",
          status: "not-proven",
          summary:
            "The report schema fixture is not a Cloudflare execution receipt.",
        },
        {
          evidenceRefs: [
            "artifact://dream-preflight/runs/run-dream-preflight/workflows/machine.config.json",
            "artifact://dream-preflight/runs/run-dream-preflight/workflows/machine.ts",
            "artifact://dream-preflight/runs/run-dream-preflight/workflows/harness.json",
          ],
          requirement:
            "A real planner generates and pins workflow.xstate-machine.v1 plus generated harness/source/hash artifacts.",
          requirementId: "generated-machine-and-harness",
          status: "captured",
          summary:
            "Generated machine, source, and harness refs are hash-pinned.",
        },
        {
          requirement:
            "Dream runs T-shaped across timeline, machines, runtimes, source families, hydration, and correlation.",
          requirementId: "t-shaped-memory-coverage",
          status: "not-proven",
          summary:
            "The schema fixture does not include source inventory, hydration, or correlation coverage.",
        },
        {
          requirement:
            "Dream emits actionable dreams and refinement proposals for kernel/package/workflow/schema/access/report changes.",
          requirementId: "dreams-and-refinement-proposals",
          status: "not-proven",
          summary:
            "The schema fixture has a dream card but no refinement proposal artifact.",
        },
        {
          requirement:
            "Accepted dreams produce HITL decision, workflow seed, and follow-up run request artifacts that feed the next generated workflow.",
          requirementId: "hitl-refinement-loop",
          status: "not-proven",
          summary:
            "The report contract emits the HITL decision contract; seed/follow-up artifacts are separate workflow nodes.",
        },
        {
          requirement:
            "The Cloudflare Dream workflow publishes the canonical Tufte/MDSvX Wzrrd HITL report through a leased side effect.",
          requirementId: "workflow-owned-wzrrd-output",
          status: "not-proven",
          summary:
            "The report schema fixture does not prove leased Wzrrd publication.",
        },
        {
          requirement:
            "Public artifacts remain redacted: no raw credentials, raw private paths, or raw transcripts.",
          requirementId: "public-private-redaction-boundary",
          status: "captured",
          summary: "The report contract requires rawTranscriptsReturned=false.",
        },
      ],
      redacted: true,
      runId: "run-dream-preflight",
      schemaVersion: "workflow.hitl-report.definition-of-done-audit.v1",
      status: "not-proven",
      summary: {
        blockedCount: 0,
        capturedCount: 3,
        missingCount: 0,
        notProvenCount: 6,
        totalCount: 9,
      },
    } as const;
    const report = WorkflowHitlReportDocumentSchema.parse({
      definitionOfDoneAudit: reportDefinitionOfDoneAudit,
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
        contractRef: "contract://workflow/memory-fabric/hitl-decision.v1",
        decisionSchemaVersion: "memory.hitl-decision.v1",
        exportId: "memory-hitl-decision-schema",
        nextWorkflowSeedRequiredFor: ["accept", "turn-into-work"],
        sourceRefs: [
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
      schemaVersion: "workflow.hitl-report.v1",
      sectionOrder: [
        "run-context",
        "actual-dreams",
        "what-to-do",
        "actionable-line-items",
        "proof",
        "technical-appendix",
      ],
      sourceRefs: [
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
      auditRequirementIds: report.definitionOfDoneAudit.items.map(
        (item) => item.requirementId
      ),
      auditStatus: report.definitionOfDoneAudit.status,
      auditSummary: report.definitionOfDoneAudit.summary,
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
      auditRequirementIds: [
        "dream-cartridge-package",
        "worker-facing-relay-capability-lease",
        "live-cloudflare-execution",
        "generated-machine-and-harness",
        "t-shaped-memory-coverage",
        "dreams-and-refinement-proposals",
        "hitl-refinement-loop",
        "workflow-owned-wzrrd-output",
        "public-private-redaction-boundary",
      ],
      auditStatus: "not-proven",
      auditSummary: {
        blockedCount: 0,
        capturedCount: 3,
        missingCount: 0,
        notProvenCount: 6,
        totalCount: 9,
      },
      decisionContract: {
        artifactPath: "dream/hitl-decision.json",
        contractRef: "contract://workflow/memory-fabric/hitl-decision.v1",
        decisionSchemaVersion: "memory.hitl-decision.v1",
        exportId: "memory-hitl-decision-schema",
        nextWorkflowSeedRequiredFor: ["accept", "turn-into-work"],
        sourceRefs: [
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

  it("allows generated workflows to include Dream retrieval states", () => {
    const steps = [
      DynamicWorkflowStepSchema.parse({
        config: {
          maxHits: 10,
          query: "dream workflow",
          sourceFamilies: ["agent-transcripts", "brain"],
        },
        kind: "workflow.node.invoke",
        nodeType: "joelclaw.memory.search",
        outputPath: "dream/memory-search.json",
        stepId: "search-memory-fabric",
        summary: "Search redacted Dream memory evidence across horizons.",
      }),
      DynamicWorkflowStepSchema.parse({
        config: {
          searchStepId: "search-memory-fabric",
        },
        dependsOn: ["search-memory-fabric"],
        kind: "workflow.node.invoke",
        nodeType: "joelclaw.memory.hydrate",
        outputPath: "dream/hydration.json",
        stepId: "hydrate-receipts",
        summary: "Hydrate redacted receipts without raw transcripts.",
      }),
      DynamicWorkflowStepSchema.parse({
        config: {
          hydrationStepId: "hydrate-receipts",
          searchStepId: "search-memory-fabric",
        },
        dependsOn: ["hydrate-receipts"],
        kind: "workflow.node.invoke",
        nodeType: "joelclaw.memory.correlate",
        outputPath: "dream/correlation-graph.json",
        stepId: "correlate-evidence",
        summary: "Correlate hydrated evidence into a source-backed graph.",
      }),
    ];

    expect(steps.map((step) => step.kind)).toStrictEqual([
      "workflow.node.invoke",
      "workflow.node.invoke",
      "workflow.node.invoke",
    ]);
    expect(
      steps.map((step) =>
        step.kind === "workflow.node.invoke" ? step.nodeType : null
      )
    ).toStrictEqual([
      "joelclaw.memory.search",
      "joelclaw.memory.hydrate",
      "joelclaw.memory.correlate",
    ]);
  });
});
