import type {
  ArtifactStoreContract,
  ReviewGateActorContract,
} from "../application/ports.ts";
import {
  D1ReceiptRowSchema,
  D1ReviewGateRowSchema,
} from "../control-plane/d1-schema.ts";
import {
  ReviewSummaryDocumentSchema,
  WorkflowEventSchema,
} from "../domain/schemas.ts";
import type { ArtifactRef } from "../domain/schemas.ts";

type D1QueryValue = null | number | string;

interface D1RunResultLike {
  readonly success?: boolean;
}

interface D1PreparedStatementLike {
  bind(...values: D1QueryValue[]): D1PreparedStatementLike;
  run(): Promise<D1RunResultLike>;
}

interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
}

export interface CloudflareReviewGateActorConfig {
  readonly artifacts: ArtifactStoreContract;
  readonly d1: D1DatabaseLike;
  readonly now?: () => string;
}

const defaultNow = (): string => new Date().toISOString();

const safePathSegment = (value: string): string =>
  value.replaceAll(/[^A-Za-z0-9_.:-]/gu, "_");

const assertD1Write = async (
  statement: D1PreparedStatementLike,
  summary: string
): Promise<void> => {
  const result = await statement.run();
  if (result.success === false) {
    throw new Error(summary);
  }
};

const writeReviewGateRow = async (input: {
  readonly d1: D1DatabaseLike;
  readonly reviewId: string;
  readonly runId: string;
}): Promise<void> => {
  const row = D1ReviewGateRowSchema.parse({
    review_id: input.reviewId,
    run_id: input.runId,
    status: "summary-captured",
  });

  await assertD1Write(
    input.d1
      .prepare(
        `insert into review_gates (review_id, run_id, capability, resource_ref, status, approval_ref, reviewer_actor_id)
         values (?, ?, ?, ?, ?, ?, ?)
         on conflict(review_id) do update set
           status = excluded.status,
           approval_ref = excluded.approval_ref,
           reviewer_actor_id = excluded.reviewer_actor_id,
           updated_at = CURRENT_TIMESTAMP`
      )
      .bind(
        row.review_id,
        row.run_id,
        row.capability ?? null,
        row.resource_ref ?? null,
        row.status,
        row.approval_ref ?? null,
        row.reviewer_actor_id ?? null
      ),
    "Review gate row could not be persisted."
  );
};

const writeReceiptRow = async (input: {
  readonly artifactRef: ArtifactRef;
  readonly d1: D1DatabaseLike;
  readonly receiptHash: string;
  readonly receiptId: string;
  readonly runId: string;
}): Promise<void> => {
  const row = D1ReceiptRowSchema.parse({
    artifact_ref: input.artifactRef,
    receipt_hash: input.receiptHash,
    receipt_id: input.receiptId,
    receipt_kind: "review-summary",
    redacted: 1,
    run_id: input.runId,
  });

  await assertD1Write(
    input.d1
      .prepare(
        `insert into receipts (receipt_id, run_id, receipt_kind, artifact_ref, receipt_hash, redacted)
         values (?, ?, ?, ?, ?, ?)
         on conflict(receipt_id) do update set
           artifact_ref = excluded.artifact_ref,
           receipt_hash = excluded.receipt_hash,
           redacted = excluded.redacted`
      )
      .bind(
        row.receipt_id,
        row.run_id,
        row.receipt_kind,
        row.artifact_ref,
        row.receipt_hash,
        row.redacted
      ),
    "Review summary receipt row could not be persisted."
  );
};

export const createCloudflareReviewGateActor = (
  config: CloudflareReviewGateActorConfig
): ReviewGateActorContract => ({
  async summarize(input) {
    const eventLog = input.eventLog.map((event) =>
      WorkflowEventSchema.parse(event)
    );
    const reviewId = `review:${input.runId}:summary`;
    const summary = ReviewSummaryDocumentSchema.parse({
      capabilityCount: input.capabilityReceipts.length,
      capabilityReceiptRefs: input.capabilityReceipts.map(
        (receipt) => receipt.receiptRef
      ),
      eventCount: eventLog.length,
      eventLog,
      finalStateBeforeCapture: eventLog.at(-1)?.state ?? "received",
      generatedAt: config.now?.() ?? defaultNow(),
      redacted: true,
      reviewId,
      runId: input.runId,
      schemaVersion: "workflow.review-summary.v1",
      status: "summary-captured",
      stepArtifactRefs: input.stepArtifactRefs,
    });
    const writeReceipt = await config.artifacts.writeJson({
      path:
        input.outputPath ??
        `review/summaries/${safePathSegment(reviewId)}.json`,
      redacted: true,
      runId: input.runId,
      value: summary,
    });

    await writeReviewGateRow({
      d1: config.d1,
      reviewId,
      runId: input.runId,
    });
    await writeReceiptRow({
      artifactRef: writeReceipt.artifactRef,
      d1: config.d1,
      receiptHash: writeReceipt.contentHash,
      receiptId: `${reviewId}:summary`,
      runId: input.runId,
    });

    return writeReceipt;
  },
});
