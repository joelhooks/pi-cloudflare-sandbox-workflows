import { z } from "zod";

export const ActorSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["agent", "broker", "human", "system"]),
});

export const CapabilityIdSchema = z.literal("github.openPullRequest");

export const CheckSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["passed", "failed"]),
  summary: z.string().min(1),
});

export const GeneratedFileSchema = z.object({
  content: z.string(),
  path: z.string().min(1),
});

export const ResolvedFilesPayloadSchema = z.object({
  files: z.array(GeneratedFileSchema).min(1),
  filesRef: z.string().min(1),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/u),
});

export const CapabilityBlockerSchema = z.object({
  approvalRef: z.string().min(1).optional(),
  code: z.enum([
    "capability_denied",
    "missing_secret_approval",
    "payload_hash_mismatch",
    "policy_not_found",
    "secret_unavailable",
  ]),
  message: z.string().min(1),
  redacted: z.literal(true),
});

export const CapabilityLeaseRequestSchema = z.object({
  actor: ActorSchema,
  branch: z.string().min(1),
  capability: CapabilityIdSchema,
  expiresInSeconds: z.number().int().positive().max(3600),
  filesRef: z.string().min(1),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/u),
  prBodyHash: z.string().regex(/^[a-f0-9]{64}$/u),
  prTitle: z.string().min(1),
  repo: z.string().min(1),
  runId: z.string().min(1),
  secretRef: z.string().min(1),
  workItemId: z.string().min(1),
});

export const CapabilityPolicyDecisionSchema = z.discriminatedUnion("status", [
  z.object({
    expiresAt: z.string().datetime(),
    policyId: z.string().min(1),
    status: z.literal("approved"),
  }),
  z.object({
    blocker: CapabilityBlockerSchema,
    policyId: z.string().min(1).optional(),
    status: z.literal("denied"),
  }),
]);

export const CapabilityLeaseReceiptSchema = z.object({
  actor: ActorSchema,
  branch: z.string().min(1),
  capability: CapabilityIdSchema,
  capabilityRef: z.string().min(1),
  checks: z.array(CheckSchema).min(1),
  commitSha: z.string().min(7),
  expiresAt: z.string().datetime(),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/u),
  policyId: z.string().min(1),
  prUrl: z.string().url(),
  redacted: z.literal(true),
  repo: z.string().min(1),
  runId: z.string().min(1),
  secretRef: z.string().min(1),
});

export const CapabilityLeaseResultSchema = z.discriminatedUnion("status", [
  z.object({
    blocker: CapabilityBlockerSchema,
    status: z.literal("blocked"),
  }),
  z.object({
    receipt: CapabilityLeaseReceiptSchema,
    status: z.literal("executed"),
  }),
]);

export const OpenPullRequestCapabilityPayloadSchema = z.object({
  branch: z.string().min(1),
  files: z.array(GeneratedFileSchema).min(1),
  filesRef: z.string().min(1),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/u),
  prBody: z.string().min(1),
  prBodyHash: z.string().regex(/^[a-f0-9]{64}$/u),
  prTitle: z.string().min(1),
  repo: z.string().min(1),
  runId: z.string().min(1),
});

export const PullRequestReceiptSchema = z.object({
  actor: z.literal("shitratgit[bot]"),
  branch: z.string().min(1),
  commitSha: z.string().min(7),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/u),
  prNumber: z.number().int().positive(),
  prUrl: z.string().url(),
  repo: z.string().min(1),
});

export const SecretMaterialUseRequestSchema = z.object({
  capability: CapabilityIdSchema,
  policyId: z.string().min(1),
  purpose: z.literal("execute-payload-bound-capability"),
  runId: z.string().min(1),
  secretRef: z.string().min(1),
});

export type Actor = z.infer<typeof ActorSchema>;
export type CapabilityBlocker = z.infer<typeof CapabilityBlockerSchema>;
export type CapabilityLeaseReceipt = z.infer<
  typeof CapabilityLeaseReceiptSchema
>;
export type CapabilityLeaseRequest = z.infer<
  typeof CapabilityLeaseRequestSchema
>;
export type CapabilityLeaseResult = z.infer<typeof CapabilityLeaseResultSchema>;
export type CapabilityPolicyDecision = z.infer<
  typeof CapabilityPolicyDecisionSchema
>;
export type GeneratedFile = z.infer<typeof GeneratedFileSchema>;
export type OpenPullRequestCapabilityPayload = z.infer<
  typeof OpenPullRequestCapabilityPayloadSchema
>;
export type PullRequestReceipt = z.infer<typeof PullRequestReceiptSchema>;
export type ResolvedFilesPayload = z.infer<typeof ResolvedFilesPayloadSchema>;
export type SecretMaterialUseRequest = z.infer<
  typeof SecretMaterialUseRequestSchema
>;
