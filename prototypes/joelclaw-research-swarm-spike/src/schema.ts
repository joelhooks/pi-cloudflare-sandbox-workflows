import { z } from "zod";

const IdentifierSchema = z.string().min(1);
const ArtifactPathSchema = z.string().min(1);

export const SourceClassSchema = z.enum([
  "official",
  "source_repo",
  "maintainer",
  "book_or_corpus",
  "field_report",
  "local_project",
]);

export const OutputTargetSchema = z.object({
  kind: z.literal("brain_page"),
});

export const ObserverTargetSchema = z.object({
  kind: z.literal("public_event_log"),
  visibility: z.literal("public_redacted"),
});

export const ConstructiveLimitsSchema = z.object({
  maxHotSandboxLanesPerWave: z.number().int().min(1).max(256),
  maxModelSpendUsd: z.number().positive(),
  maxScoutWaves: z.number().int().min(1).max(8),
  maxTotalHotSandboxLanes: z.number().int().min(1).max(512),
  maxWallClockMinutes: z.number().int().min(1).max(240),
  maxWebSourcesPerLane: z.number().int().min(1).max(50),
  stopWhenDuplicateSources: z.boolean(),
});

export const ResearchTaskSchema = z
  .object({
    constructiveLimits: ConstructiveLimitsSchema,
    desiredOutcome: z.string().min(1),
    observerTarget: ObserverTargetSchema,
    outputTarget: OutputTargetSchema,
    requiredCoverageQuestions: z.array(z.string().min(1)).min(1),
    researchTask: z.string().min(1),
    seedQueries: z.array(z.string().min(1)).min(1),
    targetBrainPage: ArtifactPathSchema,
    workItemId: IdentifierSchema,
  })
  .strict();

export const SourcePolicySchema = z.object({
  fairUse: z.literal(true),
  publicOutputGuidance: z.string().min(1),
  sourceClasses: z.array(SourceClassSchema).min(1),
});

export const SourceRefSchema = z.object({
  claimSupport: z.array(z.string().min(1)).min(1),
  docId: z.string().min(1).optional(),
  evidencePath: z.string().min(1).optional(),
  freshness: z.string().min(1).optional(),
  headingPath: z.array(z.string()).default([]),
  sourceClass: z.string().min(1),
  title: z.string().min(1),
  url: z.string().min(1),
});

export const JoelClawHitSchema = z.object({
  chunkId: z.string().min(1),
  chunkIndex: z.number().int().optional(),
  chunkType: z.string().min(1).optional(),
  docId: z.string().min(1),
  headingPath: z.array(z.string()).default([]),
  score: z.string().optional(),
  snippet: z.string().optional(),
  title: z.string().min(1),
});

export const ScoutSearchReceiptSchema = z.object({
  found: z.number().int().min(0),
  hits: z.array(JoelClawHitSchema),
  query: z.string().min(1),
  searchedAt: z.string().datetime(),
  semantic: z.boolean(),
  url: z.string().url(),
});

export const ThemeCandidateSchema = z.object({
  coverageQuestionIds: z.array(IdentifierSchema).default([]),
  evidenceDocIds: z.array(IdentifierSchema).default([]),
  laneId: IdentifierSchema,
  researchQuestion: z.string().min(1),
  seedQueries: z.array(z.string().min(1)).min(1),
  sourceClasses: z.array(SourceClassSchema).min(1),
  sourceDensity: z.number().int().min(0),
  themeId: IdentifierSchema,
  title: z.string().min(1),
  whyThisLane: z.string().min(1),
});

export const ThemeMapSchema = z.object({
  generatedAt: z.string().datetime(),
  scoutReceipts: z.array(ScoutSearchReceiptSchema).min(1),
  themes: z.array(ThemeCandidateSchema).min(1),
});

export const ResearchEnvelopeSchema = z.object({
  constructiveLimits: ConstructiveLimitsSchema,
  desiredOutcome: z.string().min(1),
  observerTarget: ObserverTargetSchema,
  planMode: z.literal("adaptive-scout-then-hot-research"),
  requiredCoverageQuestions: z.array(z.string().min(1)).min(1),
  researchTask: z.string().min(1),
  targetBrainPage: ArtifactPathSchema,
  workItemId: IdentifierSchema,
});

export const MachineStateSchema = z.object({
  id: IdentifierSchema,
  kind: z.enum(["normal", "final"]),
  on: z.record(IdentifierSchema, IdentifierSchema).default({}),
  tags: z.array(IdentifierSchema).default([]),
});

export const MachineReceiptSchema = z.object({
  approvalRequiredBefore: z.literal("admittingResearchLanes"),
  cancellationEvent: z.literal("CANCEL_REQUESTED"),
  contextKeys: z.array(IdentifierSchema).min(1),
  events: z.array(IdentifierSchema).min(1),
  id: IdentifierSchema,
  initial: z.literal("preparingPrelaunch"),
  pattern: z.literal("adaptive_research_swarm"),
  receiptOnly: z.literal(false),
  states: z.array(MachineStateSchema).min(1),
  xstateVersion: z.literal("v5"),
});

export const HarnessStepSchema = z.object({
  id: IdentifierSchema,
  inputs: z.array(ArtifactPathSchema).default([]),
  kind: z.enum([
    "prepare-prelaunch",
    "scout-joelclaw",
    "map-themes",
    "render-review",
    "operator-approval",
    "commit-plan-artifacts",
    "enqueue-hot-research-lanes",
    "run-sandbox-research-lane",
    "fan-in",
    "synthesize-brain-page",
    "verify-brain-page",
    "publish-observer",
    "render-brain-page",
    "cleanup",
  ]),
  outputs: z.array(ArtifactPathSchema).default([]),
  policy: z.array(IdentifierSchema).default([]),
});

export const HarnessPlanSchema = z.object({
  executionSubstrate: z.literal(
    "cloudflare-worker-durable-object-queue-sandbox-artifacts"
  ),
  generatedCodeRuntime: z.literal("none"),
  steps: z.array(HarnessStepSchema).min(1),
});

export const VerificationCriterionSchema = z.object({
  id: IdentifierSchema,
  severity: z.enum(["warning", "blocking"]),
  summary: z.string().min(1),
  type: z.enum([
    "claim-source-support",
    "source-class-policy",
    "fair-use-attribution",
    "freshness-check",
    "brain-render-check",
    "public-observer-redaction",
    "cleanup-receipts",
  ]),
});

export const VerificationContractSchema = z.object({
  criteria: z.array(VerificationCriterionSchema).min(1),
  id: IdentifierSchema,
  statusPolicy: z.object({
    blocked: z.literal("blocked"),
    verified: z.literal("verified"),
    warnings: z.literal("warnings"),
  }),
});

export const ArtifactHashBundleSchema = z.object({
  harnessSha256: z.string().min(64),
  machineSha256: z.string().min(64),
  researchEnvelopeSha256: z.string().min(64),
  sourcePolicySha256: z.string().min(64),
  verificationContractSha256: z.string().min(64),
});

export const OperatorApprovalSchema = z.object({
  approvedArtifacts: ArtifactHashBundleSchema,
  decidedAt: z.string().datetime().optional(),
  decidedBy: z.literal("operator").optional(),
  decision: z.enum(["pending", "approved", "edit_requested", "rejected"]),
  notes: z.string().optional(),
});

export const LaneStatusSchema = z.enum([
  "queued",
  "running",
  "committed",
  "retry_queued",
  "failed",
  "degraded",
]);

export const LaneRecordSchema = ThemeCandidateSchema.extend({
  artifactCommitSha: z.string().min(1).optional(),
  completedAt: z.string().datetime().optional(),
  model: z.string().min(1).optional(),
  outputRefs: z.array(ArtifactPathSchema),
  reportContent: z.string().optional(),
  retryCount: z.number().int().min(0),
  runtime: z
    .enum(["pi-agent", "pi-agent-internet-research", "deterministic-node"])
    .optional(),
  sandboxId: z.string().min(1).optional(),
  sourceRefs: z.array(SourceRefSchema).optional(),
  startedAt: z.string().datetime().optional(),
  status: LaneStatusSchema,
});

export const QueueMessageSchema = z.discriminatedUnion("type", [
  z.object({
    laneId: IdentifierSchema,
    runId: IdentifierSchema,
    type: z.literal("research-lane"),
    workItemId: IdentifierSchema,
  }),
  z.object({
    runId: IdentifierSchema,
    type: z.literal("finalize"),
    workItemId: IdentifierSchema,
  }),
]);

export const VerificationResultSchema = z.object({
  blockingFailures: z.array(z.string()),
  checkedArtifacts: z.array(ArtifactPathSchema),
  generatedAt: z.string().datetime(),
  schemaVersion: z.literal("joelclaw-swarm-verification-result.v1"),
  status: z.enum(["verified", "warnings", "blocked"]),
  warnings: z.array(z.string()),
});

export const OutputDeliveryReceiptSchema = z.object({
  brainPageRef: ArtifactPathSchema,
  deliveredAt: z.string().datetime(),
  outputRefs: z.array(ArtifactPathSchema).min(1),
  publicObserverUrl: z.string().url(),
  targetKind: z.literal("brain_page"),
});

export const PrelaunchPlanSchema = z.object({
  approval: OperatorApprovalSchema,
  artifacts: ArtifactHashBundleSchema,
  generatedAt: z.string().datetime(),
  harness: HarnessPlanSchema,
  machine: MachineReceiptSchema,
  researchEnvelope: ResearchEnvelopeSchema,
  reviewPagePath: ArtifactPathSchema,
  schemaVersion: z.literal("joelclaw-research-swarm-prelaunch.v1"),
  sourcePolicy: SourcePolicySchema,
  themeMap: ThemeMapSchema,
  verificationContract: VerificationContractSchema,
});

export const CapsuleRecordSchema = z.object({
  activeLaneIds: z.array(IdentifierSchema),
  artifactRemote: z.string().url(),
  artifactRepoName: IdentifierSchema,
  blockedReason: z.string().min(1).optional(),
  brainPageContent: z.string().optional(),
  capsuleId: IdentifierSchema,
  cleanupReceipts: z.array(z.string()),
  completedAt: z.string().datetime().optional(),
  currentState: IdentifierSchema,
  eventLog: z.array(
    z.object({
      at: z.string().datetime(),
      event: IdentifierSchema,
      state: IdentifierSchema,
    })
  ),
  finalReceipt: z.unknown().optional(),
  lanes: z.record(IdentifierSchema, LaneRecordSchema),
  maxObservedActiveLanes: z.number().int().min(0),
  observerPublishReceipt: z.string().optional(),
  plan: PrelaunchPlanSchema,
  planCommitSha: z.string().min(1),
  publicObserverUrl: z.string().url(),
  runId: IdentifierSchema,
  startedAt: z.string().datetime().optional(),
  status: z.enum([
    "planning",
    "running",
    "synthesizing",
    "verifying",
    "delivering",
    "captured",
    "blocked",
    "cancelled",
  ]),
  synthesisCommitSha: z.string().min(1).optional(),
  synthesisSandboxId: z.string().min(1).optional(),
  verifierCommitSha: z.string().min(1).optional(),
  verifierResult: VerificationResultSchema.optional(),
  verifierSandboxId: z.string().min(1).optional(),
  workItemId: IdentifierSchema,
});

export const PolicyCheckSchema = z.object({
  id: IdentifierSchema,
  status: z.enum(["passed", "failed"]),
  summary: z.string().min(1),
});

export const FinalReceiptSchema = z.object({
  artifactRemote: z.string().url(),
  artifactsRepo: IdentifierSchema,
  brainPageContent: z.string().min(1),
  brainPageRef: ArtifactPathSchema,
  capsuleId: IdentifierSchema,
  checks: z.array(PolicyCheckSchema).min(1),
  cleanupReceipts: z.array(z.string()).min(1),
  finalState: z.literal("captured"),
  generatedHarnessRef: ArtifactPathSchema,
  generatedMachineRef: ArtifactPathSchema,
  laneReceipts: z.array(LaneRecordSchema).min(1),
  maxObservedActiveLanes: z.number().int().min(1),
  outputTargetReceipt: OutputDeliveryReceiptSchema,
  planCommitSha: z.string().min(1),
  prototype: z.literal("joelclaw-research-swarm-spike"),
  publicObserverUrl: z.string().url(),
  runId: IdentifierSchema,
  schemaVersion: z.literal("joelclaw-research-swarm-receipt.v1"),
  synthesisCommitSha: z.string().min(1),
  totalResearchLanes: z.number().int().min(1),
  verifierResult: VerificationResultSchema,
});

export type ArtifactHashBundle = z.infer<typeof ArtifactHashBundleSchema>;
export type CapsuleRecord = z.infer<typeof CapsuleRecordSchema>;
export type FinalReceipt = z.infer<typeof FinalReceiptSchema>;
export type HarnessPlan = z.infer<typeof HarnessPlanSchema>;
export type MachineReceipt = z.infer<typeof MachineReceiptSchema>;
export type LaneRecord = z.infer<typeof LaneRecordSchema>;
export type OperatorApproval = z.infer<typeof OperatorApprovalSchema>;
export type OutputDeliveryReceipt = z.infer<typeof OutputDeliveryReceiptSchema>;
export type PolicyCheck = z.infer<typeof PolicyCheckSchema>;
export type PrelaunchPlan = z.infer<typeof PrelaunchPlanSchema>;
export type QueueMessage = z.infer<typeof QueueMessageSchema>;
export type ResearchEnvelope = z.infer<typeof ResearchEnvelopeSchema>;
export type ResearchTask = z.infer<typeof ResearchTaskSchema>;
export type ScoutSearchReceipt = z.infer<typeof ScoutSearchReceiptSchema>;
export type SourcePolicy = z.infer<typeof SourcePolicySchema>;
export type ThemeCandidate = z.infer<typeof ThemeCandidateSchema>;
export type ThemeMap = z.infer<typeof ThemeMapSchema>;
export type VerificationContract = z.infer<typeof VerificationContractSchema>;
export type VerificationResult = z.infer<typeof VerificationResultSchema>;
