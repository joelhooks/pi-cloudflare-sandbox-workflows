import { z } from "zod";

const IdentifierSchema = z.string().min(1);
const ArtifactPathSchema = z.string().min(1);

export const RedactionClassSchema = z.enum([
  "public-safe",
  "private",
  "secret-adjacent",
]);

export const WorkflowEventSchema = z.object({
  actor: IdentifierSchema,
  artifactRefs: z.array(ArtifactPathSchema).default([]),
  event: IdentifierSchema,
  laneId: IdentifierSchema.optional(),
  message: z.string().min(1),
  redaction: RedactionClassSchema,
  runId: IdentifierSchema,
  schemaVersion: z.literal("piwf.event.v0"),
  seq: z.number().int().positive(),
  severity: z.enum(["debug", "info", "warn", "error"]),
  spanId: IdentifierSchema,
  state: IdentifierSchema,
  timestamp: z.string().datetime(),
  traceId: IdentifierSchema,
});

export const LaneStatusSchema = z.enum([
  "planned",
  "queued",
  "running",
  "committed",
  "failed",
  "retry_queued",
  "degraded",
]);

export const LanePlanSchema = z.object({
  files: z.array(ArtifactPathSchema).min(1),
  laneId: IdentifierSchema,
  prompt: z.string().min(1),
  required: z.boolean(),
  role: z.enum([
    "core-ports-and-events",
    "cloudflare-adapters",
    "dynamic-harness-runtime",
    "verifier-debugger",
    "docs-and-capture",
  ]),
});

export const GeneratedFileSchema = z.object({
  content: z.string(),
  path: ArtifactPathSchema,
});

export const LaneRecordSchema = LanePlanSchema.extend({
  artifactCommitSha: z.string().min(1).optional(),
  completedAt: z.string().datetime().optional(),
  generatedFiles: z.array(GeneratedFileSchema).default([]),
  outputRefs: z.array(ArtifactPathSchema).default([]),
  retryCount: z.number().int().min(0),
  sandboxId: z.string().min(1).optional(),
  startedAt: z.string().datetime().optional(),
  status: LaneStatusSchema,
});

export const CapabilityManifestSchema = z.object({
  allowedImports: z.array(z.string()).min(1),
  capabilities: z.array(
    z.enum([
      "emitEvent",
      "enqueueLane",
      "readArtifact",
      "writeArtifact",
      "requestSecretLease",
      "openPullRequest",
      "reportProgress",
    ])
  ),
  gitHub: z.object({
    actor: z.literal("shitratgit[bot]"),
    secretRefs: z.array(IdentifierSchema).min(1),
  }),
  schemaVersion: z.literal("capability-manifest.v0"),
});

export const GeneratedMachineSchema = z.object({
  cancellationEvent: z.literal("CANCEL_REQUESTED"),
  concurrencyCap: z.number().int().min(1),
  id: IdentifierSchema,
  initial: z.literal("planning"),
  outputTarget: z.literal("github_pr"),
  pattern: z.literal("generated-build-swarm"),
  states: z.array(
    z.object({
      id: IdentifierSchema,
      kind: z.enum(["normal", "final"]),
      on: z.record(IdentifierSchema, IdentifierSchema).default({}),
    })
  ),
  xstateVersion: z.literal("v5"),
});

export const ObservabilityContractSchema = z.object({
  packRefs: z.array(ArtifactPathSchema).min(1),
  requiredEvents: z.array(IdentifierSchema).min(1),
  schemaVersion: z.literal("observability-contract.v0"),
});

export const VerificationContractSchema = z.object({
  criteria: z.array(
    z.object({
      id: IdentifierSchema,
      severity: z.enum(["blocking", "warning"]),
      summary: z.string().min(1),
    })
  ),
  schemaVersion: z.literal("verification-contract.v0"),
});

export const PlanSchema = z.object({
  capabilityManifestRef: ArtifactPathSchema,
  concurrencyCap: z.number().int().min(1).max(5),
  generatedHarnessRef: ArtifactPathSchema,
  generatedMachineRef: ArtifactPathSchema,
  lanes: z.array(LanePlanSchema).min(2),
  observabilityContractRef: ArtifactPathSchema,
  outputTarget: z.literal("github_pr"),
  prototype: z.literal("workflow-observability-spine-spike"),
  schemaVersion: z.literal("observability-plan.v0"),
  task: z.string().min(1),
  verificationContractRef: ArtifactPathSchema,
  workItemId: IdentifierSchema,
});

export const QueueMessageSchema = z.discriminatedUnion("type", [
  z.object({
    runId: IdentifierSchema,
    type: z.literal("supervisor"),
    workItemId: IdentifierSchema,
  }),
  z.object({
    laneId: IdentifierSchema,
    runId: IdentifierSchema,
    type: z.literal("lane"),
    workItemId: IdentifierSchema,
  }),
  z.object({
    runId: IdentifierSchema,
    type: z.literal("finalize"),
    workItemId: IdentifierSchema,
  }),
]);

export const ObservabilityPackSchema = z.object({
  agentSummary: ArtifactPathSchema,
  costSummary: ArtifactPathSchema,
  events: ArtifactPathSchema,
  metricsSummary: ArtifactPathSchema,
  redactionPolicy: ArtifactPathSchema,
  status: ArtifactPathSchema,
  traceSummary: ArtifactPathSchema,
});

export const DebuggerDiagnosisSchema = z.object({
  canExplainRun: z.boolean(),
  currentState: IdentifierSchema,
  missingEvidence: z.array(z.string()),
  nextSafeAction: z.string().min(1),
  riskNotes: z.array(z.string()),
  summary: z.string().min(1),
});

export const VerificationResultSchema = z.object({
  blockingFailures: z.array(z.string()),
  checkedArtifacts: z.array(ArtifactPathSchema),
  debuggerDiagnosis: DebuggerDiagnosisSchema,
  generatedAt: z.string().datetime(),
  schemaVersion: z.literal("observability-verification-result.v0"),
  status: z.enum(["verified", "warnings", "blocked"]),
  warnings: z.array(z.string()),
});

export const CapsuleRecordSchema = z.object({
  activeLaneIds: z.array(IdentifierSchema),
  artifactRemote: z.string().url(),
  artifactRepoName: IdentifierSchema,
  blockedReason: z.string().min(1).optional(),
  capsuleId: IdentifierSchema,
  cleanupReceipts: z.array(z.string()),
  completedAt: z.string().datetime().optional(),
  currentState: IdentifierSchema,
  eventLog: z.array(WorkflowEventSchema),
  finalReceipt: z.unknown().optional(),
  generatedFiles: z.array(GeneratedFileSchema).default([]),
  harnessCommitSha: z.string().min(1).optional(),
  lanes: z.record(IdentifierSchema, LaneRecordSchema),
  maxObservedActiveLanes: z.number().int().min(0),
  observabilityPack: ObservabilityPackSchema.optional(),
  planCommitSha: z.string().min(1),
  pr: z
    .object({
      branch: z.string().min(1),
      number: z.number().int().positive().optional(),
      url: z.string().url().optional(),
    })
    .optional(),
  runId: IdentifierSchema,
  startedAt: z.string().datetime(),
  status: z.enum([
    "planning",
    "supervising",
    "running_lanes",
    "finalizing",
    "captured",
    "blocked",
    "cancelled",
  ]),
  verifierResult: VerificationResultSchema.optional(),
  workItemId: IdentifierSchema,
});

export const FinalReceiptSchema = z.object({
  artifactRemote: z.string().url(),
  artifactsRepo: IdentifierSchema,
  capsuleId: IdentifierSchema,
  checks: z.array(
    z.object({
      id: IdentifierSchema,
      status: z.enum(["passed", "failed"]),
      summary: z.string().min(1),
    })
  ),
  cleanupReceipts: z.array(z.string()).min(1),
  generatedFiles: z.array(GeneratedFileSchema).min(1),
  generatedHarnessRef: ArtifactPathSchema,
  generatedMachineRef: ArtifactPathSchema,
  maxObservedActiveLanes: z.number().int().min(1),
  observabilityPack: ObservabilityPackSchema,
  outputTarget: z.literal("github_pr"),
  planCommitSha: z.string().min(1),
  prototype: z.literal("workflow-observability-spine-spike"),
  runId: IdentifierSchema,
  schemaVersion: z.literal("workflow-observability-spine-receipt.v0"),
  totalPlannedLanes: z.number().int().min(2),
  verifierResult: VerificationResultSchema,
});

export type CapsuleRecord = z.infer<typeof CapsuleRecordSchema>;
export type FinalReceipt = z.infer<typeof FinalReceiptSchema>;
export type GeneratedFile = z.infer<typeof GeneratedFileSchema>;
export type LanePlan = z.infer<typeof LanePlanSchema>;
export type LaneRecord = z.infer<typeof LaneRecordSchema>;
export type Plan = z.infer<typeof PlanSchema>;
export type QueueMessage = z.infer<typeof QueueMessageSchema>;
export type VerificationResult = z.infer<typeof VerificationResultSchema>;
export type WorkflowEvent = z.infer<typeof WorkflowEventSchema>;
