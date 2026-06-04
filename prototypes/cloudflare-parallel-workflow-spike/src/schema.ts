import { z } from "zod";

const IdentifierSchema = z.string().min(1);
const ArtifactPathSchema = z.string().min(1);

export const OutputTargetSchema = z.object({
  kind: z.literal("implementation_plan"),
});

export const FanInPolicySchema = z.object({
  quorum: z.number().int().positive().optional(),
  requiredLaneIds: z.array(IdentifierSchema).min(1),
  strategy: z.enum(["wait_all", "required_only", "quorum", "best_effort"]),
});

export const FailurePolicySchema = z.object({
  laneFailure: z.enum(["retry_then_degrade", "retry_then_block", "block"]),
  maxRetries: z.number().int().min(0).max(5),
});

export const ParallelSpecSchema = z
  .object({
    concurrencyCap: z.number().int().min(1).max(8),
    failurePolicy: FailurePolicySchema,
    fanIn: FanInPolicySchema,
    plannedLaneCount: z.number().int().min(2).max(16),
  })
  .refine((value) => value.plannedLaneCount > value.concurrencyCap, {
    message:
      "plannedLaneCount must exceed concurrencyCap to prove backpressure",
  });

export const JobSpecSchema = z
  .object({
    contextPackRefs: z.array(IdentifierSchema).min(1),
    outputTarget: OutputTargetSchema,
    parallel: ParallelSpecSchema,
    secretRefs: z.array(IdentifierSchema).default([]),
    task: z.string().min(1),
    verificationContract: IdentifierSchema,
    workItemId: IdentifierSchema,
  })
  .strict();

export const LaneRoleSchema = z.enum([
  "researcher",
  "scout",
  "synthesizer",
  "verifier",
]);

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
  inputRef: ArtifactPathSchema,
  laneId: IdentifierSchema,
  prompt: z.string().min(1),
  required: z.boolean(),
  role: LaneRoleSchema,
  topic: z.string().min(1),
});

export const LaneRecordSchema = LanePlanSchema.extend({
  artifactCommitSha: z.string().min(1).optional(),
  completedAt: z.string().datetime().optional(),
  outputRefs: z.array(ArtifactPathSchema),
  retryCount: z.number().int().min(0),
  sandboxId: z.string().min(1).optional(),
  startedAt: z.string().datetime().optional(),
  status: LaneStatusSchema,
});

export const MachineStateSchema = z.object({
  id: IdentifierSchema,
  kind: z.enum(["normal", "final"]),
  on: z.record(IdentifierSchema, IdentifierSchema).default({}),
  tags: z.array(IdentifierSchema).default([]),
});

export const MachineReceiptSchema = z.object({
  cancellationEvent: z.literal("CANCEL_REQUESTED"),
  concurrencyCap: z.number().int().min(1),
  contextKeys: z.array(IdentifierSchema).min(1),
  events: z.array(IdentifierSchema).min(1),
  fanIn: FanInPolicySchema,
  id: IdentifierSchema,
  initial: z.literal("planning"),
  outputDeliveryState: z.literal("deliveringOutput"),
  pattern: z.literal("fanout_synthesis"),
  receiptOnly: z.literal(false),
  states: z.array(MachineStateSchema).min(1),
  xstateVersion: z.literal("v5"),
});

export const HarnessStepSchema = z.object({
  id: IdentifierSchema,
  inputs: z.array(ArtifactPathSchema).default([]),
  kind: z.enum([
    "plan",
    "commit-plan-artifacts",
    "enqueue-lanes",
    "admit-lane",
    "run-sandbox-lane",
    "fan-in",
    "synthesize",
    "verify",
    "deliver-output",
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

export const VerificationContractSchema = z.object({
  criteria: z.array(
    z.object({
      id: IdentifierSchema,
      severity: z.enum(["warning", "blocking"]),
      summary: z.string().min(1),
      type: z.enum([
        "lane-output-presence",
        "synthesis-presence",
        "fan-in-policy",
        "verification-report-presence",
      ]),
    })
  ),
  id: IdentifierSchema,
  statusPolicy: z.object({
    blocked: z.literal("blocked"),
    verified: z.literal("verified"),
    warnings: z.literal("warnings"),
  }),
});

export const PolicyCheckSchema = z.object({
  id: IdentifierSchema,
  status: z.enum(["passed", "failed"]),
  summary: z.string().min(1),
});

export const ParallelPlanSchema = z.object({
  generatedAt: z.string().datetime(),
  harness: HarnessPlanSchema,
  jobSpec: JobSpecSchema,
  lanes: z.array(LanePlanSchema).min(2),
  machine: MachineReceiptSchema,
  outputTarget: OutputTargetSchema,
  pattern: z.literal("fanout_synthesis"),
  policyChecks: z.array(PolicyCheckSchema).min(1),
  schemaVersion: z.literal("parallel-plan.v1"),
  verification: VerificationContractSchema,
});

export const QueueMessageSchema = z.discriminatedUnion("type", [
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

export const VerificationResultSchema = z.object({
  blockingFailures: z.array(z.string()),
  checkedArtifacts: z.array(ArtifactPathSchema),
  generatedAt: z.string().datetime(),
  schemaVersion: z.literal("parallel-verification-result.v1"),
  status: z.enum(["verified", "warnings", "blocked"]),
  warnings: z.array(z.string()),
});

export const OutputDeliveryReceiptSchema = z.object({
  deliveredAt: z.string().datetime(),
  outputRefs: z.array(ArtifactPathSchema).min(1),
  targetKind: z.literal("implementation_plan"),
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
  plan: ParallelPlanSchema,
  planCommitSha: z.string().min(1),
  runId: IdentifierSchema,
  startedAt: z.string().datetime().optional(),
  status: z.enum([
    "idle",
    "planning",
    "running",
    "synthesizing",
    "verifying",
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

export const FinalReceiptSchema = z.object({
  artifactRemote: z.string().url(),
  artifactsRepo: IdentifierSchema,
  capsuleId: IdentifierSchema,
  checks: z.array(PolicyCheckSchema).min(1),
  cleanupReceipts: z.array(z.string()).min(1),
  concurrencyCap: z.number().int().min(1),
  deployedWorkerUrl: z.string().url(),
  finalState: z.literal("captured"),
  generatedHarnessRef: ArtifactPathSchema,
  generatedMachineRef: ArtifactPathSchema,
  laneReceipts: z.array(LaneRecordSchema).min(1),
  maxObservedActiveLanes: z.number().int().min(1),
  outputTargetReceipt: OutputDeliveryReceiptSchema,
  planCommitSha: z.string().min(1),
  prototype: z.literal("cloudflare-parallel-workflow-spike"),
  runId: IdentifierSchema,
  schemaVersion: z.literal("cloudflare-parallel-workflow-receipt.v1"),
  synthesisCommitSha: z.string().min(1),
  totalPlannedLanes: z.number().int().min(2),
  verifierResult: VerificationResultSchema,
});

export type CapsuleRecord = z.infer<typeof CapsuleRecordSchema>;
export type FinalReceipt = z.infer<typeof FinalReceiptSchema>;
export type HarnessPlan = z.infer<typeof HarnessPlanSchema>;
export type JobSpec = z.infer<typeof JobSpecSchema>;
export type LanePlan = z.infer<typeof LanePlanSchema>;
export type QueueMessage = z.infer<typeof QueueMessageSchema>;
export type LaneRecord = z.infer<typeof LaneRecordSchema>;
export type MachineReceipt = z.infer<typeof MachineReceiptSchema>;
export type ParallelPlan = z.infer<typeof ParallelPlanSchema>;
export type PolicyCheck = z.infer<typeof PolicyCheckSchema>;
export type VerificationResult = z.infer<typeof VerificationResultSchema>;
