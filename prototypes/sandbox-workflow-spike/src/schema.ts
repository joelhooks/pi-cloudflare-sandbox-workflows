import { z } from "zod";

const ArtifactPathSchema = z.string().min(1).meta({
  description: "Repo-relative artifact path.",
});

const ArtifactRefSchema = z.string().min(1).meta({
  description: "Human-readable artifact reference.",
});

export const LaneRoleSchema = z.enum([
  "reader",
  "verifier",
  "worker",
  "supervisor",
]);

export const VerificationStatusSchema = z.enum([
  "verified",
  "warnings",
  "blocked",
]);

export const VerificationSeveritySchema = z.enum(["warning", "blocking"]);

export const VerificationCriterionSchema = z.object({
  artifacts: z.array(ArtifactPathSchema).min(1),
  description: z.string().min(1),
  id: z.string().min(1),
  severity: VerificationSeveritySchema,
  type: z.enum(["source-citation-coverage", "artifact-presence"]),
});

export const VerificationContractSchema = z.object({
  criteria: z.array(VerificationCriterionSchema).min(1),
  description: z.string().min(1),
  evidence: z.object({
    reportRef: ArtifactPathSchema,
    sourcesRef: ArtifactPathSchema,
  }),
  id: z.string().min(1),
  schemaVersion: z.literal("verification-contract.v1"),
  statusPolicy: z.object({
    blockingStatus: z.literal("blocked"),
    verifiedStatus: z.literal("verified"),
    warningStatus: z.literal("warnings"),
  }),
  title: z.string().min(1),
});

export const VerificationCheckSchema = z.object({
  criterionId: z.string().min(1),
  evidence: z.array(z.string()).default([]),
  severity: VerificationSeveritySchema,
  status: VerificationStatusSchema,
  summary: z.string().min(1),
});

export const VerificationResultSchema = z.object({
  blockingFailures: z.array(z.string()),
  checkedArtifacts: z.array(ArtifactPathSchema),
  checks: z.array(VerificationCheckSchema),
  contractRef: ArtifactPathSchema,
  generatedAt: z.string().datetime(),
  schemaVersion: z.literal("verification-result.v1"),
  status: VerificationStatusSchema,
  verifier: z.object({
    kind: z.literal("fixed-prototype-verifier"),
    notes: z.string().min(1),
  }),
  warnings: z.array(z.string()),
});

export const LanePlanSchema = z.object({
  dependsOn: z.array(z.string()).default([]),
  id: z.string().min(1),
  outputs: z.array(ArtifactPathSchema).min(1),
  role: LaneRoleSchema,
});

export const PlanSchema = z.object({
  artifactRepoName: z.string().min(1),
  artifacts: z.object({
    harness: ArtifactPathSchema,
    machine: ArtifactPathSchema,
    manifest: ArtifactPathSchema,
    plan: ArtifactPathSchema,
    verificationContract: ArtifactPathSchema,
    verificationReport: ArtifactPathSchema,
    verificationResult: ArtifactPathSchema,
    wzrrdPage: ArtifactPathSchema,
  }),
  capsuleId: z.string().min(1),
  contextPackRef: ArtifactRefSchema,
  generatedAt: z.string().datetime(),
  lanes: z.array(LanePlanSchema).min(1),
  model: z.string().min(1),
  pattern: z.literal("reader-verifier"),
  planPhase: z.object({
    executor: z.literal("fixed-prototype-reader-verifier"),
    generatedMachineRuntime: z.literal("receipt-only"),
    pinnedBeforeSandbox: z.literal(true),
  }),
  policies: z.object({
    captureWarnings: z.boolean(),
    cleanup: z.literal("destroy-sandbox"),
    concurrencyCap: z.number().int().min(1).max(16),
  }),
  runId: z.string().min(1),
  schemaVersion: z.literal("plan.v1"),
  task: z.string().min(1),
});

export const RunManifestSchema = z.object({
  artifactRepoName: z.string().min(1),
  capsuleId: z.string().min(1),
  contextPackRef: ArtifactRefSchema,
  harnessRef: ArtifactPathSchema,
  machineRef: ArtifactPathSchema,
  model: z.string().min(1),
  planRef: ArtifactPathSchema,
  runId: z.string().min(1),
  schemaVersion: z.literal("run-manifest.v1"),
  sourceSeedRef: ArtifactPathSchema,
  task: z.string().min(1),
  verificationContractRef: ArtifactPathSchema,
});

export const WorkflowEventReceiptSchema = z.object({
  at: z.string().datetime(),
  context: z.unknown(),
  event: z.string().min(1),
  state: z.unknown(),
  status: z.string().min(1),
});

export const PrototypeSnapshotResumeReceiptSchema = z.object({
  checks: z
    .array(
      z.object({
        id: z.string().min(1),
        status: z.literal("passed"),
        summary: z.string().min(1),
      })
    )
    .min(1),
  eventLog: z.array(WorkflowEventReceiptSchema).min(1),
  final: z.object({
    context: z.unknown(),
    finishedAt: z.string().datetime(),
    state: z.unknown(),
    status: z.string().min(1),
  }),
  prototype: z.literal("sandbox-workflow-spike"),
  question: z.string().min(1),
  runId: z.string().min(1),
  schemaVersion: z.literal("prototype-snapshot-resume-receipt.v1"),
  simulatedFiles: z.array(ArtifactPathSchema).min(1),
  snapshot: z.object({
    persistedAt: z.string().datetime(),
    persistedSnapshot: z.unknown(),
    persistedState: z.unknown(),
    persistedStatus: z.string().min(1),
    restoredAt: z.string().datetime(),
    restoredState: z.unknown(),
    restoredStatus: z.string().min(1),
  }),
});

export const WzrrdPublishResultSchema = z.object({
  bytes: z.number().int().nonnegative(),
  claimUrl: z.string().url().optional(),
  createdAt: z.string().datetime().optional(),
  deleteAfter: z.string().datetime().optional(),
  expiresAt: z.string().datetime().optional(),
  fileCount: z.number().int().nonnegative().optional(),
  indexing: z.string().optional(),
  lifecycle: z.string().optional(),
  slug: z.string().min(1),
  source: z.string().optional(),
  status: z.string().optional(),
  updatedAt: z.string().datetime(),
  url: z.string().url(),
});

export type LanePlan = z.infer<typeof LanePlanSchema>;
export type Plan = z.infer<typeof PlanSchema>;
export type PrototypeSnapshotResumeReceipt = z.infer<
  typeof PrototypeSnapshotResumeReceiptSchema
>;
export type RunManifest = z.infer<typeof RunManifestSchema>;
export type VerificationContract = z.infer<typeof VerificationContractSchema>;
export type VerificationResult = z.infer<typeof VerificationResultSchema>;
export type WorkflowEventReceipt = z.infer<typeof WorkflowEventReceiptSchema>;
export type WzrrdPublishResult = z.infer<typeof WzrrdPublishResultSchema>;
