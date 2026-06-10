import { describe, expect, it } from "vitest";

import { sha256Hex } from "../../src/app/domain/hash.ts";
import {
  CapabilityLeaseReceiptSchema,
  ReviewSummaryDocumentSchema,
  WorkflowEventSchema,
} from "../../src/app/domain/schemas.ts";
import type {
  ArtifactRef,
  CapabilityLeaseReceipt,
  WorkflowEvent,
} from "../../src/app/domain/schemas.ts";
import { workflowTraceContextForCapability } from "../../src/app/domain/trace-context.ts";
import { createCloudflareReviewGateActor } from "../../src/app/infrastructure/cloudflare-review-gate-actor.ts";
import { createMemoryArtifactStore } from "../../src/app/infrastructure/memory-adapters.ts";

type D1QueryValue = null | number | string;

interface D1Operation {
  readonly query: string;
  readonly values: readonly D1QueryValue[];
}

interface FakeD1Statement {
  bind(...boundValues: D1QueryValue[]): FakeD1Statement;
  run(): Promise<{ readonly success: true }>;
}

const createFakeD1 = () => {
  const operations: D1Operation[] = [];

  return {
    d1: {
      prepare(query: string) {
        const statementFor = (
          values: readonly D1QueryValue[] = []
        ): FakeD1Statement => ({
          bind(...boundValues: D1QueryValue[]) {
            return statementFor(boundValues);
          },
          run() {
            operations.push({ query, values });

            return Promise.resolve({ success: true });
          },
        });

        return statementFor();
      },
    },
    operations,
  };
};

const runId = "run-review-gate-integration";
const capabilityReceiptRef =
  `artifact://review-gate/runs/${runId}/receipts/discord-capability.json` as ArtifactRef;
const capabilityPayloadRef =
  `artifact://review-gate/runs/${runId}/payloads/discord-message.json` as ArtifactRef;
const stepArtifactRef =
  `artifact://review-gate/runs/${runId}/outputs/research-review.json` as ArtifactRef;

const buildCapabilityReceipt = (): CapabilityLeaseReceipt =>
  CapabilityLeaseReceiptSchema.parse({
    capability: "discord.message.send",
    channelRef: "discord:channel:123456789012345678",
    delivery: {
      channelRef: "discord:channel:123456789012345678",
      dryRun: true,
      messageId: "dry-run:review-gate",
      payloadHash: sha256Hex("review gate message"),
      redacted: true,
      serverRef: "discord:server:987654321098765432",
      status: "dry-run",
    },
    dryRun: true,
    leaseId: `lease:discord.message.send:${runId}`,
    payloadHash: sha256Hex("review gate message"),
    payloadRef: capabilityPayloadRef,
    policyId: "discord-message-policy",
    receiptRef: capabilityReceiptRef,
    redacted: true,
    resource: {
      channelRef: "discord:channel:123456789012345678",
      kind: "discord.channel",
      serverRef: "discord:server:987654321098765432",
    },
    reviewGate: {
      mode: "dry-run-exempt",
      reason: "Review gate integration test dry-run.",
    },
    runId,
    secretRef: "secretref:discord-dry-run",
    traceContext: workflowTraceContextForCapability({
      capability: "discord.message.send",
      runId,
      stepId: "test:review-gate",
    }),
  });

const buildEventLog = (): WorkflowEvent[] => [
  WorkflowEventSchema.parse({
    at: "2026-06-08T23:58:00.000Z",
    refs: {
      planRef: `artifact://review-gate/runs/${runId}/run/plan.json`,
    },
    state: "recordingReceipts",
    summary: "Run receipts recorded.",
  }),
];

describe("Cloudflare review gate actor", () => {
  it("writes a typed review summary and mirrors it to review gate control rows", async () => {
    const artifacts = createMemoryArtifactStore("review-gate");
    const fakeD1 = createFakeD1();
    const reviewGate = createCloudflareReviewGateActor({
      artifacts,
      d1: fakeD1.d1,
      now: () => "2026-06-08T23:59:00.000Z",
    });

    const receipt = await reviewGate.summarize({
      capabilityReceipts: [buildCapabilityReceipt()],
      eventLog: buildEventLog(),
      outputPath: "review/summary.json",
      runId,
      stepArtifactRefs: [stepArtifactRef],
    });
    const summary = ReviewSummaryDocumentSchema.parse(
      await artifacts.readJson({ artifactRef: receipt.artifactRef })
    );

    expect({
      d1OperationKinds: fakeD1.operations.map((operation) =>
        operation.query.includes("review_gates")
          ? "review-gate"
          : operation.values[2]
      ),
      receiptRef: receipt.artifactRef,
      summary: {
        capabilityReceiptRefs: summary.capabilityReceiptRefs,
        eventCount: summary.eventCount,
        finalStateBeforeCapture: summary.finalStateBeforeCapture,
        redacted: summary.redacted,
        reviewId: summary.reviewId,
        schemaVersion: summary.schemaVersion,
        status: summary.status,
        stepArtifactRefs: summary.stepArtifactRefs,
      },
    }).toStrictEqual({
      d1OperationKinds: ["review-gate", "review-summary"],
      receiptRef: artifacts.artifactRef({
        path: "review/summary.json",
        runId,
      }),
      summary: {
        capabilityReceiptRefs: [capabilityReceiptRef],
        eventCount: 1,
        finalStateBeforeCapture: "recordingReceipts",
        redacted: true,
        reviewId: `review:${runId}:summary`,
        schemaVersion: "workflow.review-summary.v1",
        status: "summary-captured",
        stepArtifactRefs: [stepArtifactRef],
      },
    });
  });
});
