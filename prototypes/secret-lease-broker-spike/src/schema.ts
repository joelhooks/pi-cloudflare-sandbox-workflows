import { z } from "zod";

export const SecretLeaseRequestSchema = z.object({
  purpose: z.literal("mint-task-scoped-auth-json"),
  runId: z.string().min(1),
  secretRefs: z.array(z.string().min(1)).min(1),
  workItemId: z.string().min(1),
});

export const SecretMetadataSchema = z.object({
  allowedPurposes: z.array(z.string().min(1)).min(1),
  name: z.string().min(1),
  scope: z.enum(["user", "app", "session"]),
});

export const SecretLeaseRecordSchema = z.object({
  contentSha256: z.string().min(64).max(64),
  expiresAt: z.string().datetime(),
  leaseRef: z.string().min(1),
  materializedPath: z.literal("/workspace/.pi/agent/auth.json"),
  purpose: z.literal("mint-task-scoped-auth-json"),
  redacted: z.literal(true),
  runId: z.string().min(1),
  secretRef: z.string().min(1),
});

export const ApprovalBlockerSchema = z.object({
  approvalUrl: z.string().min(1),
  code: z.literal("missing_secret_approval"),
  requestedPurpose: z.string().min(1),
  secretRef: z.string().min(1),
});

export const PublicPayloadSchema = z.object({
  artifactManifest: z.object({
    files: z.array(z.string().min(1)).min(1),
    secretLeases: z.array(SecretLeaseRecordSchema),
  }),
  eventLog: z.array(
    z.object({
      event: z.string().min(1),
      leaseRef: z.string().min(1).optional(),
      secretRef: z.string().min(1).optional(),
    })
  ),
  wzrrdPayload: z.object({
    leaseRefs: z.array(z.string().min(1)),
    visibleFiles: z.array(z.string().min(1)).min(1),
  }),
});

export const SecretLeaseBrokerReceiptSchema = z.object({
  blocker: ApprovalBlockerSchema,
  checks: z
    .array(
      z.object({
        id: z.string().min(1),
        status: z.literal("passed"),
        summary: z.string().min(1),
      })
    )
    .min(1),
  lease: SecretLeaseRecordSchema,
  prototype: z.literal("secret-lease-broker-spike"),
  publicPayload: PublicPayloadSchema,
  question: z.string().min(1),
  schemaVersion: z.literal("secret-lease-broker-receipt.v1"),
});

export type ApprovalBlocker = z.infer<typeof ApprovalBlockerSchema>;
export type PublicPayload = z.infer<typeof PublicPayloadSchema>;
export type SecretLeaseBrokerReceipt = z.infer<
  typeof SecretLeaseBrokerReceiptSchema
>;
export type SecretLeaseRecord = z.infer<typeof SecretLeaseRecordSchema>;
export type SecretLeaseRequest = z.infer<typeof SecretLeaseRequestSchema>;
export type SecretMetadata = z.infer<typeof SecretMetadataSchema>;
