import { z } from "zod";

export const WorkRequestSchema = z.object({
  contextPackRefs: z.array(z.string().min(1)).min(1),
  secretRefs: z.array(z.string().min(1)).default([]),
  task: z.string().min(1),
  verificationContract: z.string().min(1),
  workItemId: z.string().min(1),
});

export const ArtifactRepoHandleSchema = z.object({
  defaultBranch: z.literal("main"),
  ref: z.string().min(1),
  repoName: z.string().min(1),
});

export const SandboxRunHandleSchema = z.object({
  destroyReceipt: z.string().min(1).optional(),
  destroyedAt: z.string().datetime().optional(),
  runId: z.string().min(1),
  sandboxId: z.string().min(1),
  status: z.enum(["running", "destroyed"]),
});

export const SecretLeaseRecordSchema = z.object({
  leaseRef: z.string().min(1),
  materializedPath: z.literal("/workspace/.pi/agent/auth.json"),
  secretRef: z.string().min(1),
});

export const WzrrdReviewRefSchema = z.object({
  source: z.string().min(1),
  url: z.string().url(),
});

export const EventRecordSchema = z.object({
  at: z.string().datetime(),
  context: z.unknown(),
  event: z.string().min(1),
  state: z.unknown(),
  status: z.string().min(1),
});

export const CapsuleRecordSchema = z.object({
  activeRunId: z.string().min(1).optional(),
  artifactRepo: ArtifactRepoHandleSchema.optional(),
  capsuleId: z.string().min(1),
  contextPackRefs: z.array(z.string().min(1)).default([]),
  eventLog: z.array(EventRecordSchema).default([]),
  latestRunId: z.string().min(1).optional(),
  sandbox: SandboxRunHandleSchema.optional(),
  secretLeases: z.array(SecretLeaseRecordSchema).default([]),
  snapshot: z.unknown().optional(),
  status: z.string().min(1),
  task: z.string().min(1).optional(),
  verificationContract: z.string().min(1).optional(),
  workItemId: z.string().min(1),
  wzrrd: WzrrdReviewRefSchema.optional(),
});

export const CapsuleSupervisorReceiptSchema = z.object({
  cancellation: z.object({
    cancelState: z.literal("cancelled"),
    destroyReceipt: z.string().min(1),
    ignoredWorkEventState: z.literal("cancelled"),
    sandboxStatus: z.literal("destroyed"),
    workItemId: z.string().min(1),
  }),
  checks: z
    .array(
      z.object({
        id: z.string().min(1),
        status: z.literal("passed"),
        summary: z.string().min(1),
      })
    )
    .min(1),
  prototype: z.literal("capsule-supervisor-spike"),
  question: z.string().min(1),
  schemaVersion: z.literal("capsule-supervisor-receipt.v1"),
  success: z.object({
    capsuleId: z.string().min(1),
    eventLogLength: z.number().int().min(1),
    finalState: z.literal("captured"),
    restoredState: z.string().min(1),
    sandboxId: z.string().min(1),
    workItemId: z.string().min(1),
  }),
});

export type ArtifactRepoHandle = z.infer<typeof ArtifactRepoHandleSchema>;
export type CapsuleRecord = z.infer<typeof CapsuleRecordSchema>;
export type CapsuleSupervisorReceipt = z.infer<
  typeof CapsuleSupervisorReceiptSchema
>;
export type EventRecord = z.infer<typeof EventRecordSchema>;
export type SandboxRunHandle = z.infer<typeof SandboxRunHandleSchema>;
export type SecretLeaseRecord = z.infer<typeof SecretLeaseRecordSchema>;
export type WorkRequest = z.infer<typeof WorkRequestSchema>;
export type WzrrdReviewRef = z.infer<typeof WzrrdReviewRefSchema>;
