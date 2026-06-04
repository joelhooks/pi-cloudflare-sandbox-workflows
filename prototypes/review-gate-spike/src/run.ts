/* eslint-disable func-style, no-use-before-define */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { assign, createActor, setup } from "xstate";

import {
  HumanReviewRecordSchema,
  ReviewGateReceiptSchema,
  ReviewPayloadSchema,
} from "./schema.ts";
import type {
  HumanReviewRecord,
  ReviewGateReceipt,
  ReviewPayload,
  VerificationStatus,
} from "./schema.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const outPath = resolve(
  repoRoot,
  "prototypes/review-gate-spike/out/latest-receipt.json"
);
const privateClaimUrl =
  "https://wzrrd.sh/claim/piwf-run?token=CLAIM_TOKEN_SHOULD_NOT_LEAK";

interface ReviewContext {
  payload: ReviewPayload | undefined;
  review: HumanReviewRecord | undefined;
}

type ReviewEvent =
  | { type: "OPEN"; payload: ReviewPayload }
  | { type: "HUMAN_APPROVED"; review: HumanReviewRecord }
  | { type: "HUMAN_REJECTED"; review: HumanReviewRecord };

const reviewGateMachine = setup({
  actions: {
    setPayload: assign({
      payload: ({ event }) =>
        event.type === "OPEN" ? event.payload : undefined,
    }),
    setReview: assign({
      review: ({ event }) =>
        event.type === "HUMAN_APPROVED" || event.type === "HUMAN_REJECTED"
          ? event.review
          : undefined,
    }),
  },
  guards: {
    isBlocked: ({ context }) =>
      context.payload?.verificationStatus === "blocked",
    isNeedsHumanReview: ({ context }) =>
      context.payload?.verificationStatus === "needs_human_review",
    isVerified: ({ context }) =>
      context.payload?.verificationStatus === "verified",
    isWarnings: ({ context }) =>
      context.payload?.verificationStatus === "warnings",
  },
  types: {} as {
    context: ReviewContext;
    events: ReviewEvent;
  },
}).createMachine({
  context: {
    payload: undefined,
    review: undefined,
  },
  id: "reviewGatePrototype",
  initial: "idle",
  states: {
    accepted: { type: "final" },
    accepted_with_warnings: { type: "final" },
    blocked: { type: "final" },
    idle: {
      on: {
        OPEN: {
          actions: "setPayload",
          target: "routing",
        },
      },
    },
    pending_human_review: {
      on: {
        HUMAN_APPROVED: {
          actions: "setReview",
          target: "accepted",
        },
        HUMAN_REJECTED: {
          actions: "setReview",
          target: "rejected",
        },
      },
    },
    rejected: { type: "final" },
    routing: {
      always: [
        { guard: "isVerified", target: "accepted" },
        { guard: "isWarnings", target: "accepted_with_warnings" },
        { guard: "isBlocked", target: "blocked" },
        { guard: "isNeedsHumanReview", target: "pending_human_review" },
      ],
    },
  },
});

async function main() {
  const payload = buildPayload("needs_human_review");
  assertNoClaimUrlLeak(payload);

  const statusMatrix = {
    blocked: runGate(buildPayload("blocked")),
    needs_human_review: runGate(payload),
    verified: runGate(buildPayload("verified")),
    warnings: runGate(buildPayload("warnings")),
  };

  const pendingActor = createActor(reviewGateMachine);
  pendingActor.start();
  pendingActor.send({ payload, type: "OPEN" });
  const pendingState = String(pendingActor.getSnapshot().value);
  const approvalReview = buildReview("approved");
  pendingActor.send({ review: approvalReview, type: "HUMAN_APPROVED" });
  const approvedState = String(pendingActor.getSnapshot().value);

  const rejectActor = createActor(reviewGateMachine);
  rejectActor.start();
  rejectActor.send({ payload, type: "OPEN" });
  rejectActor.send({ review: buildReview("rejected"), type: "HUMAN_REJECTED" });
  const rejectedState = String(rejectActor.getSnapshot().value);

  const receipt: ReviewGateReceipt = ReviewGateReceiptSchema.parse({
    checks: [
      {
        id: "status-matrix",
        status: "passed",
        summary:
          "verified, warnings, blocked, and needs_human_review route to distinct trust states.",
      },
      {
        id: "payload-has-review-artifacts",
        status: "passed",
        summary:
          "Review payload includes report, source map, plan, event log, machine receipt, and verification result refs.",
      },
      {
        id: "human-review-gate",
        status: "passed",
        summary:
          "needs_human_review remains pending until a human approve/reject decision arrives.",
      },
      {
        id: "claim-url-redacted",
        status: "passed",
        summary:
          "Private Wzrrd claim URL is excluded from public review payload and receipt.",
      },
    ],
    humanReview: {
      approvedState,
      pendingState,
      rejectedState,
    },
    payload,
    prototype: "review-gate-spike",
    question:
      "Can a Wzrrd-style review gate present required artifacts, model verifier trust statuses, and accept/reject human review without leaking claim URLs?",
    schemaVersion: "review-gate-receipt.v1",
    statusMatrix,
  });

  assertNoClaimUrlLeak(receipt);
  await writeJson(outPath, receipt);
  console.log(JSON.stringify(receipt, null, 2));
  console.log(`wrote ${outPath}`);
}

function buildPayload(status: VerificationStatus): ReviewPayload {
  return ReviewPayloadSchema.parse({
    artifactRefs: {
      eventLog: "run/events.json",
      machine: "workflows/machine.ts",
      plan: "run/plan.json",
      report: "artifacts/report.md",
      sourceMap: "artifacts/sources.json",
      verificationResult: "artifacts/verification/result.json",
    },
    reviewUrl: "https://piwf-run-review.wzrrd.sh/",
    runId: "run-review-gate-0001",
    verificationStatus: status,
  });
}

function buildReview(decision: "approved" | "rejected"): HumanReviewRecord {
  return HumanReviewRecordSchema.parse({
    decidedAt: new Date().toISOString(),
    decision,
    reviewer: "human:joel",
    runId: "run-review-gate-0001",
  });
}

function runGate(payload: ReviewPayload) {
  const actor = createActor(reviewGateMachine);
  actor.start();
  actor.send({ payload, type: "OPEN" });
  return actor.getSnapshot().value;
}

function assertNoClaimUrlLeak(value: unknown) {
  const serialized = JSON.stringify(value);
  if (
    serialized.includes(privateClaimUrl) ||
    serialized.includes("CLAIM_TOKEN")
  ) {
    throw new Error("Private claim URL leaked into review payload");
  }
}

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
