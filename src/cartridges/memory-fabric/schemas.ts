import { z } from "zod";

import {
  ActorSchema,
  ArtifactPinSchema,
  ArtifactRefSchema,
  DynamicWorkflowMachineArtifactSchema,
  GeneratedHarnessArtifactSchema,
  IsoDateTimeSchema,
  Sha256HexSchema,
  VerificationContractArtifactSchema,
  WorkflowRunRequestSchema,
  WorkflowTraceContextSchema,
} from "../../app/domain/schemas.ts";
import {
  MemoryCoverageHorizonSchema,
  MemoryRelayOperationSchema,
  MemoryRuntimeSchema,
  MemorySourceFamilySchema,
  MemorySourceScopeSchema,
} from "../../app/domain/source-profile.ts";

export const MemoryRelayPathSchema = z.enum([
  "/memory/capture/artifact",
  "/memory/capture/run",
  "/memory/correlate",
  "/memory/hydrate",
  "/memory/search",
  "/memory/signals",
]);

const memoryRelayPathForOperation = {
  "capture-artifact": "/memory/capture/artifact",
  "capture-run": "/memory/capture/run",
  correlate: "/memory/correlate",
  hydrate: "/memory/hydrate",
  search: "/memory/search",
  signals: "/memory/signals",
} as const satisfies Record<
  z.infer<typeof MemoryRelayOperationSchema>,
  z.infer<typeof MemoryRelayPathSchema>
>;

export const MemoryRelayRedactionPolicySchema = z.object({
  mode: z.enum(["metadata-only", "receipt-only", "redacted-evidence"]),
  noCustomerDataInPublicArtifacts: z.literal(true),
  noRawCredentials: z.literal(true),
  noRawPrivatePaths: z.literal(true),
  noRawTranscripts: z.literal(true),
});

export const MemoryRelayBudgetSchema = z.object({
  maxFiles: z.number().int().min(1).optional(),
  maxRows: z.number().int().min(1).optional(),
  maxTokens: z.number().int().min(1).optional(),
});

export const MemoryRelayTimeWindowSchema = z.object({
  from: IsoDateTimeSchema.optional(),
  label: z.string().min(1).optional(),
  to: IsoDateTimeSchema.optional(),
});

export const MemoryRelayLeaseRefSchema = z.object({
  capability: z.literal("memory.relay"),
  leaseId: z.string().min(1),
  redacted: z.literal(true),
  secretRef: z.string().min(1),
});

export const MemoryRelayLeaseReceiptSchema = MemoryRelayLeaseRefSchema.extend({
  status: z.literal("used"),
  usedAt: IsoDateTimeSchema,
});

export const MemoryRelayFollowUpLinkSchema = z.object({
  href: z.string().min(1),
  label: z.string().min(1),
  rel: z.string().min(1),
});

export const MemoryRelayRequestEnvelopeSchema = z.object({
  actor: ActorSchema,
  allowedSourceFamilies: z.array(MemorySourceFamilySchema).min(1),
  budget: MemoryRelayBudgetSchema,
  idempotencyKey: z.string().min(1),
  lease: MemoryRelayLeaseRefSchema,
  operation: MemoryRelayOperationSchema,
  payload: z.unknown(),
  purpose: z.string().min(1),
  redactionPolicy: MemoryRelayRedactionPolicySchema,
  runId: z.string().min(1),
  schemaVersion: z.literal("memory.relay.request.v1"),
  scope: MemorySourceScopeSchema,
  timeWindow: MemoryRelayTimeWindowSchema,
  traceContext: WorkflowTraceContextSchema,
  workItemId: z.string().min(1),
});

export const MemoryRelayEndpointSchema = z
  .object({
    operation: MemoryRelayOperationSchema,
    path: MemoryRelayPathSchema,
  })
  .superRefine((endpoint, context) => {
    const expectedPath = memoryRelayPathForOperation[endpoint.operation];
    if (endpoint.path !== expectedPath) {
      context.addIssue({
        code: "custom",
        message: `Memory relay operation ${endpoint.operation} must use path ${expectedPath}.`,
        path: ["path"],
      });
    }
  });

export const MemoryRelayEndpointCatalogSchema = z.object({
  endpoints: z.array(MemoryRelayEndpointSchema).min(1),
  schemaVersion: z.literal("memory.relay.endpoint-catalog.v1"),
});

const MemoryRelayResponseBaseSchema = z.object({
  followUpLinks: z.array(MemoryRelayFollowUpLinkSchema).default([]),
  leaseReceipt: MemoryRelayLeaseReceiptSchema,
  missingSources: z.array(z.string().min(1)).default([]),
  operation: MemoryRelayOperationSchema,
  redacted: z.literal(true),
  runId: z.string().min(1),
  schemaVersion: z.literal("memory.relay.response.v1"),
  workItemId: z.string().min(1),
});

export const memoryRelayResponseEnvelopeSchema = <TDocument extends z.ZodType>(
  documentSchema: TDocument
) =>
  MemoryRelayResponseBaseSchema.extend({
    document: documentSchema,
  });

export const MemoryReceiptRefSchema = z.object({
  artifactRef: ArtifactRefSchema.optional(),
  family: MemorySourceFamilySchema,
  hash: Sha256HexSchema.optional(),
  receiptId: z.string().min(1),
  redactedLocator: z.string().min(1).optional(),
  runtime: MemoryRuntimeSchema.optional(),
  sourceId: z.string().min(1),
  timestamp: IsoDateTimeSchema.optional(),
});

export const MemorySearchHitSchema = z.object({
  horizon: MemoryCoverageHorizonSchema,
  receipts: z.array(MemoryReceiptRefSchema).min(1),
  redactedExcerpt: z.string().min(1).optional(),
  score: z.number().min(0),
  summary: z.string().min(1),
});

export const MemorySearchDocumentSchema = z.object({
  generatedAt: IsoDateTimeSchema,
  hits: z.array(MemorySearchHitSchema).default([]),
  query: z.string().min(1),
  redacted: z.literal(true),
  runId: z.string().min(1),
  schemaVersion: z.literal("memory.search.v1"),
  skippedSources: z.array(z.string().min(1)).default([]),
  workItemId: z.string().min(1),
});

export const MemoryRelaySearchPayloadSchema = z.object({
  actor: ActorSchema,
  maxHits: z.number().int().min(1).max(100).default(10),
  query: z.string().min(1),
  runId: z.string().min(1),
  sourceFamilies: z.array(MemorySourceFamilySchema).min(1).optional(),
  workItemId: z.string().min(1),
});

const MemoryRelayCaptureBasePayloadSchema = z.object({
  actor: ActorSchema,
  readability: z
    .enum(["actor-private", "org-private", "public"])
    .default("actor-private"),
  runId: z.string().min(1),
  sourceFamilies: z.array(MemorySourceFamilySchema).min(1).optional(),
  sourceSystem: z.string().min(1),
  workItemId: z.string().min(1),
});

export const MemoryRelayCaptureArtifactPayloadSchema =
  MemoryRelayCaptureBasePayloadSchema.extend({
    capturedRef: ArtifactPinSchema,
  });

export const MemoryRelayCaptureRunPayloadSchema =
  MemoryRelayCaptureBasePayloadSchema.extend({
    capturedRef: ArtifactPinSchema.optional(),
    targetRunId: z.string().min(1).optional(),
  });

export const MemorySignalKindSchema = z.enum([
  "agent-failure",
  "correction",
  "decision",
  "friction",
  "preference",
  "workflow-pattern",
]);

export const MemorySignalDocumentSchema = z.object({
  generatedAt: IsoDateTimeSchema,
  redacted: z.literal(true),
  runId: z.string().min(1),
  schemaVersion: z.literal("memory.signals.v1"),
  signals: z
    .array(
      z.object({
        confidence: z.number().min(0).max(1),
        kind: MemorySignalKindSchema,
        rating: z.number().int().min(1).max(5),
        reasoning: z.string().min(1),
        receipts: z.array(MemoryReceiptRefSchema).min(1),
        signalId: z.string().min(1),
        summary: z.string().min(1),
      })
    )
    .default([]),
  workItemId: z.string().min(1),
});

export const MemoryRelaySignalsPayloadSchema = z.object({
  actor: ActorSchema,
  maxSignals: z.number().int().min(1).max(100).default(10),
  query: z.string().min(1),
  runId: z.string().min(1),
  signalKinds: z.array(MemorySignalKindSchema).min(1).optional(),
  sourceFamilies: z.array(MemorySourceFamilySchema).min(1).optional(),
  workItemId: z.string().min(1),
});

export const MemoryHydrationDocumentSchema = z.object({
  generatedAt: IsoDateTimeSchema,
  hydrated: z
    .array(
      z.object({
        evidenceRef: ArtifactRefSchema.optional(),
        fullTranscriptReturned: z.literal(false),
        receipt: MemoryReceiptRefSchema,
        redactedExcerpt: z.string().min(1).optional(),
        summary: z.string().min(1),
      })
    )
    .default([]),
  redacted: z.literal(true),
  runId: z.string().min(1),
  schemaVersion: z.literal("memory.hydration.v1"),
  workItemId: z.string().min(1),
});

export const MemoryRelayHydrationPayloadSchema = z.object({
  actor: ActorSchema,
  receipts: z.array(MemoryReceiptRefSchema).min(1),
  runId: z.string().min(1),
  workItemId: z.string().min(1),
});

export const MemoryRelayCorrelationPayloadSchema = z.object({
  actor: ActorSchema,
  hydration: MemoryHydrationDocumentSchema,
  hydrationRef: ArtifactRefSchema,
  runId: z.string().min(1),
  search: MemorySearchDocumentSchema,
  searchRef: ArtifactRefSchema,
  workItemId: z.string().min(1),
});

export const MemoryRefinementProposalTargetKindSchema = z.enum([
  "capability-lease",
  "capture-ingest-fix",
  "dynamic-workflow-pattern",
  "kernel-memory",
  "package-boundary",
  "report-node-improvement",
  "schema-change",
  "workflow-node-plugin",
]);

export const MemoryRefinementProposalRecommendationSchema = z.enum([
  "accept",
  "hold",
  "reject",
  "turn-into-work",
]);

export const MemoryRefinementProposalSchema = z.object({
  proposalId: z.string().min(1),
  proposedNextStep: z.string().min(1),
  rating: z.number().int().min(1).max(10),
  reasoning: z.string().min(1),
  receipts: z.array(MemoryReceiptRefSchema).default([]),
  recommendation: MemoryRefinementProposalRecommendationSchema,
  sourceRefs: z.array(ArtifactRefSchema).min(1),
  summary: z.string().min(1),
  targetKind: MemoryRefinementProposalTargetKindSchema,
  title: z.string().min(1),
});

export const MemoryRefinementProposalDocumentSchema = z.object({
  generatedAt: IsoDateTimeSchema,
  nextWorkflowSeed: z.object({
    plannerInstructions: z.array(z.string().min(1)).min(1),
    proposalIds: z.array(z.string().min(1)).default([]),
    requiredCapabilityKinds: z.array(z.string().min(1)).default([]),
    sourceRefs: z.array(ArtifactRefSchema).min(1),
  }),
  proposalCount: z.number().int().min(0),
  proposals: z.array(MemoryRefinementProposalSchema).default([]),
  redacted: z.literal(true),
  runId: z.string().min(1),
  schemaVersion: z.literal("memory.refinement-proposals.v1"),
  sourceRefs: z.array(ArtifactRefSchema).min(1),
  workItemId: z.string().min(1),
});

export const MemoryHitlDecisionTargetKindSchema = z.enum([
  "dream-card",
  "refinement-proposal",
]);

export const MemoryHitlDecisionArtifactUpdateTargetKindSchema = z.enum([
  "brain",
  "capability-lease",
  "package",
  "report",
  "schema",
  "workflow",
]);

export const MemoryHitlDecisionSchema = z.object({
  decision: MemoryRefinementProposalRecommendationSchema,
  decisionId: z.string().min(1),
  rating: z.number().int().min(1).max(10),
  reasoning: z.string().min(1),
  receiptTrail: z.array(MemoryReceiptRefSchema).default([]),
  recommendation: z.string().min(1),
  reviewedAt: IsoDateTimeSchema,
  sourceRefs: z.array(ArtifactRefSchema).min(1),
  summary: z.string().min(1),
  targetId: z.string().min(1),
  targetKind: MemoryHitlDecisionTargetKindSchema,
  targetTitle: z.string().min(1),
});

export const MemoryHitlDecisionArtifactUpdateTargetSchema = z.object({
  sourceRefs: z.array(ArtifactRefSchema).min(1),
  summary: z.string().min(1),
  targetKind: MemoryHitlDecisionArtifactUpdateTargetKindSchema,
});

export const MemoryHitlDecisionNextWorkflowSeedSchema = z.object({
  artifactUpdateTargets: z
    .array(MemoryHitlDecisionArtifactUpdateTargetSchema)
    .default([]),
  decisionIds: z.array(z.string().min(1)).default([]),
  plannerInstructions: z.array(z.string().min(1)).default([]),
  requiredCapabilityKinds: z.array(z.string().min(1)).default([]),
  sourceRefs: z.array(ArtifactRefSchema).default([]),
});

export const MemoryHitlDecisionDocumentSchema = z
  .object({
    decisionCount: z.number().int().min(0),
    decisions: z.array(MemoryHitlDecisionSchema).default([]),
    generatedAt: IsoDateTimeSchema,
    nextWorkflowSeed: MemoryHitlDecisionNextWorkflowSeedSchema,
    redacted: z.literal(true),
    refinementProposalRef: ArtifactRefSchema.optional(),
    reportRef: ArtifactRefSchema,
    reviewer: ActorSchema,
    runId: z.string().min(1),
    schemaVersion: z.literal("memory.hitl-decision.v1"),
    sourceRefs: z.array(ArtifactRefSchema).min(1),
    workItemId: z.string().min(1),
  })
  .superRefine((document, context) => {
    if (document.decisionCount !== document.decisions.length) {
      context.addIssue({
        code: "custom",
        message: "decisionCount must match decisions.length.",
        path: ["decisionCount"],
      });
    }

    const actionableDecisions = document.decisions.filter(
      (decision) =>
        decision.decision === "accept" || decision.decision === "turn-into-work"
    );

    if (actionableDecisions.length === 0) {
      if (document.nextWorkflowSeed.decisionIds.length > 0) {
        context.addIssue({
          code: "custom",
          message:
            "nextWorkflowSeed.decisionIds must be empty when no decision is accepted or turned into work.",
          path: ["nextWorkflowSeed", "decisionIds"],
        });
      }
      if (document.nextWorkflowSeed.artifactUpdateTargets.length > 0) {
        context.addIssue({
          code: "custom",
          message:
            "nextWorkflowSeed.artifactUpdateTargets must be empty when no decision is accepted or turned into work.",
          path: ["nextWorkflowSeed", "artifactUpdateTargets"],
        });
      }
      return;
    }

    const seededDecisionIds = new Set(document.nextWorkflowSeed.decisionIds);
    for (const decision of actionableDecisions) {
      if (!seededDecisionIds.has(decision.decisionId)) {
        context.addIssue({
          code: "custom",
          message:
            "Accepted or work-conversion decisions must feed the next workflow seed.",
          path: ["nextWorkflowSeed", "decisionIds"],
        });
      }
    }

    if (document.nextWorkflowSeed.plannerInstructions.length === 0) {
      context.addIssue({
        code: "custom",
        message:
          "Accepted or work-conversion decisions require planner instructions for the next generated workflow.",
        path: ["nextWorkflowSeed", "plannerInstructions"],
      });
    }

    if (document.nextWorkflowSeed.sourceRefs.length === 0) {
      context.addIssue({
        code: "custom",
        message:
          "Accepted or work-conversion decisions require source refs for the next generated workflow.",
        path: ["nextWorkflowSeed", "sourceRefs"],
      });
    }

    if (document.nextWorkflowSeed.artifactUpdateTargets.length === 0) {
      context.addIssue({
        code: "custom",
        message:
          "Accepted or work-conversion decisions require Brain/package/workflow artifact update targets.",
        path: ["nextWorkflowSeed", "artifactUpdateTargets"],
      });
    }
  });

export const MemoryHitlDecisionWorkflowSeedStatusSchema = z.enum([
  "no-actionable-decisions",
  "ready",
]);

export const MemoryHitlDecisionWorkflowSeedDocumentSchema = z
  .object({
    acceptedDecisionIds: z.array(z.string().min(1)).default([]),
    actionableDecisionCount: z.number().int().min(0),
    actionableDecisions: z.array(MemoryHitlDecisionSchema).default([]),
    decisionRef: ArtifactRefSchema,
    generatedAt: IsoDateTimeSchema,
    heldDecisionIds: z.array(z.string().min(1)).default([]),
    nextWorkflowSeed: MemoryHitlDecisionNextWorkflowSeedSchema,
    redacted: z.literal(true),
    refinementProposalRef: ArtifactRefSchema.optional(),
    rejectedDecisionIds: z.array(z.string().min(1)).default([]),
    reportRef: ArtifactRefSchema,
    runId: z.string().min(1),
    schemaVersion: z.literal("memory.hitl-decision-workflow-seed.v1"),
    sourceRefs: z.array(ArtifactRefSchema).min(1),
    status: MemoryHitlDecisionWorkflowSeedStatusSchema,
    summary: z.string().min(1),
    workItemDecisionIds: z.array(z.string().min(1)).default([]),
    workItemId: z.string().min(1),
  })
  .superRefine((document, context) => {
    if (
      document.actionableDecisionCount !== document.actionableDecisions.length
    ) {
      context.addIssue({
        code: "custom",
        message:
          "actionableDecisionCount must match actionableDecisions.length.",
        path: ["actionableDecisionCount"],
      });
    }

    if (document.status === "ready" && document.actionableDecisionCount === 0) {
      context.addIssue({
        code: "custom",
        message:
          "Ready HITL decision workflow seeds require at least one actionable decision.",
        path: ["status"],
      });
    }

    if (
      document.status === "no-actionable-decisions" &&
      document.actionableDecisionCount > 0
    ) {
      context.addIssue({
        code: "custom",
        message:
          "No-actionable-decisions HITL workflow seeds cannot include actionable decisions.",
        path: ["status"],
      });
    }

    if (
      document.status === "ready" &&
      document.nextWorkflowSeed.plannerInstructions.length === 0
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Ready HITL decision workflow seeds require planner instructions.",
        path: ["nextWorkflowSeed", "plannerInstructions"],
      });
    }

    if (
      document.status === "ready" &&
      document.nextWorkflowSeed.artifactUpdateTargets.length === 0
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Ready HITL decision workflow seeds require artifact update targets.",
        path: ["nextWorkflowSeed", "artifactUpdateTargets"],
      });
    }
  });

export const MemoryHitlFollowUpRunRequestStatusSchema = z.enum([
  "drafted",
  "no-actionable-decisions",
]);

export const MemoryHitlFollowUpRunRequestDocumentSchema = z
  .object({
    actionableDecisionCount: z.number().int().min(0),
    artifactUpdateTargets: z
      .array(MemoryHitlDecisionArtifactUpdateTargetSchema)
      .default([]),
    decisionWorkflowSeedRef: ArtifactRefSchema,
    generatedAt: IsoDateTimeSchema,
    redacted: z.literal(true),
    request: WorkflowRunRequestSchema.optional(),
    requestedPackageIds: z.array(z.string().min(1)).default([]),
    requiredCapabilityKinds: z.array(z.string().min(1)).default([]),
    runId: z.string().min(1),
    schemaVersion: z.literal("memory.hitl-follow-up-run-request.v1"),
    sourceRefs: z.array(ArtifactRefSchema).min(1),
    status: MemoryHitlFollowUpRunRequestStatusSchema,
    submitted: z.literal(false),
    summary: z.string().min(1),
    workItemId: z.string().min(1),
  })
  .superRefine((document, context) => {
    if (document.status === "drafted" && document.request === undefined) {
      context.addIssue({
        code: "custom",
        message: "Drafted follow-up run request artifacts require request.",
        path: ["request"],
      });
    }

    if (
      document.status === "no-actionable-decisions" &&
      document.request !== undefined
    ) {
      context.addIssue({
        code: "custom",
        message:
          "No-actionable-decisions follow-up artifacts cannot include a run request.",
        path: ["request"],
      });
    }

    if (
      document.status === "no-actionable-decisions" &&
      document.actionableDecisionCount !== 0
    ) {
      context.addIssue({
        code: "custom",
        message:
          "No-actionable-decisions follow-up artifacts must have actionableDecisionCount === 0.",
        path: ["actionableDecisionCount"],
      });
    }

    if (
      document.status === "drafted" &&
      document.actionableDecisionCount === 0
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Drafted follow-up run requests require at least one actionable decision.",
        path: ["actionableDecisionCount"],
      });
    }

    if (
      document.status === "drafted" &&
      document.artifactUpdateTargets.length === 0
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Drafted follow-up run requests require artifact update targets.",
        path: ["artifactUpdateTargets"],
      });
    }
  });

export const WORKFLOW_HITL_REPORT_SECTION_ORDER = [
  "run-context",
  "actual-dreams",
  "what-to-do",
  "actionable-line-items",
  "proof",
  "technical-appendix",
] as const;

export const WorkflowHitlReportProofLevelSchema = z.enum([
  "generated-machine",
  "plan-derived",
  "static-fallback",
]);

export const WorkflowHitlReportSectionIdSchema = z.enum(
  WORKFLOW_HITL_REPORT_SECTION_ORDER
);

export const WorkflowHitlReportSectionOrderSchema = z.tuple([
  z.literal("run-context"),
  z.literal("actual-dreams"),
  z.literal("what-to-do"),
  z.literal("actionable-line-items"),
  z.literal("proof"),
  z.literal("technical-appendix"),
]);

export const WorkflowHitlReportTemplateSchema = z.object({
  defaultExpiresIn: z.literal("24h"),
  format: z.literal("mdsvx"),
  noindex: z.literal(true),
  templateId: z.literal("joel/tufte-mdsvx"),
  version: z.literal("0.1.0"),
});

export const WorkflowHitlReportStateMachineFigureSchema = z.object({
  aspectRatio: z.string().min(1),
  component: z.literal("D2"),
  machineBinding: z.object({
    machineArtifactHash: Sha256HexSchema,
    machineArtifactRef: ArtifactRefSchema,
    machineId: z.string().min(1),
    machineSourceArtifactRef: ArtifactRefSchema,
    machineSourceHash: Sha256HexSchema,
    status: z.literal("bound-to-generated-machine"),
  }),
  machineId: z.string().min(1),
  source: z.string().min(1),
  sourceHash: Sha256HexSchema,
  sourceKind: z.literal("generated-xstate-machine"),
  stateCount: z.number().int().min(1),
  transitionCount: z.number().int().min(0),
});

export const WorkflowHitlReportGeneratedArtifactsSchema = z.object({
  harness: GeneratedHarnessArtifactSchema,
  machine: DynamicWorkflowMachineArtifactSchema,
  plan: z.object({
    planId: z.string().min(1),
    planner: z.object({
      kind: z.literal("stochastic"),
      nonce: z.string().min(1),
      source: z.string().min(1),
    }),
    stepCount: z.number().int().min(1),
  }),
  verificationContract: VerificationContractArtifactSchema,
});

export const WorkflowHitlReportDefinitionOfDoneAuditItemSchema = z.object({
  blockerRefs: z.array(z.string().min(1)).default([]),
  evidenceRefs: z.array(z.string().min(1)).default([]),
  requirement: z.string().min(1),
  requirementId: z.string().min(1),
  status: z.enum(["blocked", "captured", "missing", "not-proven"]),
  summary: z.string().min(1),
});

export const WorkflowHitlReportDefinitionOfDoneAuditSchema = z.object({
  generatedAt: IsoDateTimeSchema,
  items: z.array(WorkflowHitlReportDefinitionOfDoneAuditItemSchema).min(1),
  redacted: z.literal(true),
  runId: z.string().min(1),
  schemaVersion: z.literal("workflow.hitl-report.definition-of-done-audit.v1"),
  status: z.enum(["blocked", "captured", "not-proven"]),
  summary: z.object({
    blockedCount: z.number().int().min(0),
    capturedCount: z.number().int().min(0),
    missingCount: z.number().int().min(0),
    notProvenCount: z.number().int().min(0),
    totalCount: z.number().int().min(1),
  }),
});

export const WorkflowHitlReportCardSchema = z.object({
  rating: z.number().int().min(1).max(10),
  reasoning: z.string().min(1),
  receipts: z.array(MemoryReceiptRefSchema).min(1),
  recommendation: z.string().min(1),
  summary: z.string().min(1),
  title: z.string().min(1),
});

export const MemoryHitlDecisionContractSchema = z.object({
  artifactPath: z.literal("dream/hitl-decision.json"),
  contractRef: z.literal("contract://workflow/memory-fabric/hitl-decision.v1"),
  decisionSchemaVersion: z.literal("memory.hitl-decision.v1"),
  exportId: z.literal("memory-hitl-decision-schema"),
  nextWorkflowSeedRequiredFor: z.tuple([
    z.literal("accept"),
    z.literal("turn-into-work"),
  ]),
  sourceRefs: z.array(ArtifactRefSchema).min(1),
  targetKinds: z.tuple([
    z.literal("dream-card"),
    z.literal("refinement-proposal"),
  ]),
});

export const WorkflowHitlReportDocumentSchema = z.object({
  definitionOfDoneAudit: WorkflowHitlReportDefinitionOfDoneAuditSchema,
  dreamCount: z.number().int().min(0),
  dreams: z.array(WorkflowHitlReportCardSchema).default([]),
  expiresIn: z.literal("24h"),
  generatedAt: IsoDateTimeSchema,
  hitlDecisionContract: MemoryHitlDecisionContractSchema,
  mdsvx: z.string().min(1),
  noindex: z.literal(true),
  proof: z.object({
    dynamicGenerationProofLevel: WorkflowHitlReportProofLevelSchema,
    generatedArtifacts: WorkflowHitlReportGeneratedArtifactsSchema,
    rawTranscriptsReturned: z.literal(false),
    stateMachineFigure: WorkflowHitlReportStateMachineFigureSchema,
  }),
  receiptCount: z.number().int().min(0),
  redacted: z.literal(true),
  refinementProposalCount: z.number().int().min(0).default(0),
  refinementProposalRef: ArtifactRefSchema.optional(),
  refinementProposals: z.array(MemoryRefinementProposalSchema).default([]),
  runId: z.string().min(1),
  schemaVersion: z.literal("workflow.hitl-report.v1"),
  sectionOrder: WorkflowHitlReportSectionOrderSchema,
  sourceRefs: z.array(ArtifactRefSchema).min(1),
  template: WorkflowHitlReportTemplateSchema,
  title: z.string().min(1),
  workItemId: z.string().min(1),
});

export const MemoryCorrelationGraphDocumentSchema = z.object({
  edges: z
    .array(
      z.object({
        edgeId: z.string().min(1),
        evidence: z.array(MemoryReceiptRefSchema).min(1),
        fromNodeId: z.string().min(1),
        relationship: z.enum([
          "belongs_to_org",
          "belongs_to_project",
          "contradicts_memory",
          "corrected_by",
          "eligible_for_backfill",
          "mentions_person",
          "produced_artifact",
          "reported_by",
          "repeats_pattern",
          "requires_hydration",
          "supports_dream",
        ]),
        toNodeId: z.string().min(1),
      })
    )
    .default([]),
  generatedAt: IsoDateTimeSchema,
  nodes: z
    .array(
      z.object({
        label: z.string().min(1),
        nodeId: z.string().min(1),
        nodeType: z.enum([
          "actor",
          "artifact",
          "event",
          "memory",
          "org",
          "project",
          "source",
        ]),
        redacted: z.literal(true),
      })
    )
    .default([]),
  redacted: z.literal(true),
  runId: z.string().min(1),
  schemaVersion: z.literal("memory.correlation-graph.v1"),
  workItemId: z.string().min(1),
});

const MemoryCaptureReceiptBaseDocumentSchema = z.object({
  captureKind: z.enum(["artifact", "run"]),
  capturedAt: IsoDateTimeSchema,
  capturedRef: ArtifactPinSchema,
  readability: z.enum(["actor-private", "org-private", "public"]),
  redacted: z.literal(true),
  runId: z.string().min(1),
  schemaVersion: z.literal("memory.capture-receipt.v1"),
  sourceSystem: z.string().min(1),
  workItemId: z.string().min(1),
});

export const MemoryCaptureReceiptDocumentSchema = z.discriminatedUnion(
  "captureKind",
  [
    MemoryCaptureReceiptBaseDocumentSchema.extend({
      captureKind: z.literal("artifact"),
    }),
    MemoryCaptureReceiptBaseDocumentSchema.extend({
      captureKind: z.literal("run"),
      capturedRunId: z.string().min(1),
    }),
  ]
);

export type MemoryCaptureReceiptDocument = z.infer<
  typeof MemoryCaptureReceiptDocumentSchema
>;
export type MemoryCorrelationGraphDocument = z.infer<
  typeof MemoryCorrelationGraphDocumentSchema
>;
export type MemoryHydrationDocument = z.infer<
  typeof MemoryHydrationDocumentSchema
>;
export type WorkflowHitlReportCard = z.infer<
  typeof WorkflowHitlReportCardSchema
>;
export type MemoryHitlDecisionContract = z.infer<
  typeof MemoryHitlDecisionContractSchema
>;
export type WorkflowHitlReportDocument = z.infer<
  typeof WorkflowHitlReportDocumentSchema
>;
export type WorkflowHitlReportDefinitionOfDoneAudit = z.infer<
  typeof WorkflowHitlReportDefinitionOfDoneAuditSchema
>;
export type WorkflowHitlReportDefinitionOfDoneAuditItem = z.infer<
  typeof WorkflowHitlReportDefinitionOfDoneAuditItemSchema
>;
export type WorkflowHitlReportGeneratedArtifacts = z.infer<
  typeof WorkflowHitlReportGeneratedArtifactsSchema
>;
export type WorkflowHitlReportProofLevel = z.infer<
  typeof WorkflowHitlReportProofLevelSchema
>;
export type WorkflowHitlReportSectionId = z.infer<
  typeof WorkflowHitlReportSectionIdSchema
>;
export type WorkflowHitlReportStateMachineFigure = z.infer<
  typeof WorkflowHitlReportStateMachineFigureSchema
>;
export type WorkflowHitlReportTemplate = z.infer<
  typeof WorkflowHitlReportTemplateSchema
>;
export type MemoryRelayBudget = z.infer<typeof MemoryRelayBudgetSchema>;
export type MemoryRelayEndpoint = z.infer<typeof MemoryRelayEndpointSchema>;
export type MemoryRelayEndpointCatalog = z.infer<
  typeof MemoryRelayEndpointCatalogSchema
>;
export type MemoryRelayCorrelationPayload = z.infer<
  typeof MemoryRelayCorrelationPayloadSchema
>;
export type MemoryRelayFollowUpLink = z.infer<
  typeof MemoryRelayFollowUpLinkSchema
>;
export type MemoryRelayLeaseReceipt = z.infer<
  typeof MemoryRelayLeaseReceiptSchema
>;
export type MemoryRelayLeaseRef = z.infer<typeof MemoryRelayLeaseRefSchema>;
export type MemoryRelayCaptureArtifactPayload = z.infer<
  typeof MemoryRelayCaptureArtifactPayloadSchema
>;
export type MemoryRelayCaptureRunPayload = z.infer<
  typeof MemoryRelayCaptureRunPayloadSchema
>;
export type MemoryRelayHydrationPayload = z.infer<
  typeof MemoryRelayHydrationPayloadSchema
>;
export type MemoryRelayPath = z.infer<typeof MemoryRelayPathSchema>;
export type MemoryRelayRedactionPolicy = z.infer<
  typeof MemoryRelayRedactionPolicySchema
>;
export type MemoryRelayRequestEnvelope = z.infer<
  typeof MemoryRelayRequestEnvelopeSchema
>;
export type MemoryRelaySearchPayload = z.infer<
  typeof MemoryRelaySearchPayloadSchema
>;
export type MemoryRelaySignalsPayload = z.infer<
  typeof MemoryRelaySignalsPayloadSchema
>;
export type MemoryRelayTimeWindow = z.infer<typeof MemoryRelayTimeWindowSchema>;
export type MemorySearchDocument = z.infer<typeof MemorySearchDocumentSchema>;
export type MemorySearchHit = z.infer<typeof MemorySearchHitSchema>;
export type MemoryReceiptRef = z.infer<typeof MemoryReceiptRefSchema>;
export type MemoryHitlDecision = z.infer<typeof MemoryHitlDecisionSchema>;
export type MemoryHitlDecisionArtifactUpdateTarget = z.infer<
  typeof MemoryHitlDecisionArtifactUpdateTargetSchema
>;
export type MemoryHitlDecisionArtifactUpdateTargetKind = z.infer<
  typeof MemoryHitlDecisionArtifactUpdateTargetKindSchema
>;
export type MemoryHitlDecisionDocument = z.infer<
  typeof MemoryHitlDecisionDocumentSchema
>;
export type MemoryHitlDecisionWorkflowSeedDocument = z.infer<
  typeof MemoryHitlDecisionWorkflowSeedDocumentSchema
>;
export type MemoryHitlDecisionWorkflowSeedStatus = z.infer<
  typeof MemoryHitlDecisionWorkflowSeedStatusSchema
>;
export type MemoryHitlFollowUpRunRequestDocument = z.infer<
  typeof MemoryHitlFollowUpRunRequestDocumentSchema
>;
export type MemoryHitlFollowUpRunRequestStatus = z.infer<
  typeof MemoryHitlFollowUpRunRequestStatusSchema
>;
export type MemoryHitlDecisionNextWorkflowSeed = z.infer<
  typeof MemoryHitlDecisionNextWorkflowSeedSchema
>;
export type MemoryHitlDecisionTargetKind = z.infer<
  typeof MemoryHitlDecisionTargetKindSchema
>;
export type MemoryRefinementProposal = z.infer<
  typeof MemoryRefinementProposalSchema
>;
export type MemoryRefinementProposalDocument = z.infer<
  typeof MemoryRefinementProposalDocumentSchema
>;
export type MemoryRefinementProposalRecommendation = z.infer<
  typeof MemoryRefinementProposalRecommendationSchema
>;
export type MemoryRefinementProposalTargetKind = z.infer<
  typeof MemoryRefinementProposalTargetKindSchema
>;
export type MemorySignalDocument = z.infer<typeof MemorySignalDocumentSchema>;
export type MemorySignalKind = z.infer<typeof MemorySignalKindSchema>;
