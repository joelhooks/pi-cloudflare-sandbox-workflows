import { z } from "zod";

export const VerificationStatusSchema = z.enum([
  "verified",
  "warnings",
  "blocked",
  "needs_human_review",
]);

export const ReviewDecisionSchema = z.enum(["approved", "rejected"]);

export const ReviewPayloadSchema = z.object({
  artifactRefs: z.object({
    eventLog: z.literal("run/events.json"),
    machine: z.literal("workflows/machine.ts"),
    plan: z.literal("run/plan.json"),
    report: z.literal("artifacts/report.md"),
    sourceMap: z.literal("artifacts/sources.json"),
    verificationResult: z.literal("artifacts/verification/result.json"),
  }),
  reviewUrl: z.string().url(),
  runId: z.string().min(1),
  verificationStatus: VerificationStatusSchema,
});

export const HumanReviewRecordSchema = z.object({
  decidedAt: z.string().datetime(),
  decision: ReviewDecisionSchema,
  reviewer: z.string().min(1),
  runId: z.string().min(1),
});

export const ReviewGateReceiptSchema = z.object({
  checks: z
    .array(
      z.object({
        id: z.string().min(1),
        status: z.literal("passed"),
        summary: z.string().min(1),
      })
    )
    .min(1),
  humanReview: z.object({
    approvedState: z.literal("accepted"),
    pendingState: z.literal("pending_human_review"),
    rejectedState: z.literal("rejected"),
  }),
  payload: ReviewPayloadSchema,
  prototype: z.literal("review-gate-spike"),
  question: z.string().min(1),
  schemaVersion: z.literal("review-gate-receipt.v1"),
  statusMatrix: z.record(
    VerificationStatusSchema,
    z.enum([
      "accepted",
      "accepted_with_warnings",
      "blocked",
      "pending_human_review",
    ])
  ),
});

export type HumanReviewRecord = z.infer<typeof HumanReviewRecordSchema>;
export type ReviewGateReceipt = z.infer<typeof ReviewGateReceiptSchema>;
export type ReviewPayload = z.infer<typeof ReviewPayloadSchema>;
export type VerificationStatus = z.infer<typeof VerificationStatusSchema>;
