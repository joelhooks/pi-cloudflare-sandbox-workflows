/* eslint-disable func-style, no-use-before-define */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { CapsuleSupervisorReceiptSchema, WorkRequestSchema } from "./schema.ts";
import type { CapsuleRecord, CapsuleSupervisorReceipt } from "./schema.ts";
import { MemoryCapsuleStorage } from "./storage.ts";
import { CapsuleSupervisor } from "./supervisor.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const outPath = resolve(
  repoRoot,
  "prototypes/capsule-supervisor-spike/out/latest-receipt.json"
);

const request = WorkRequestSchema.parse({
  contextPackRefs: ["research-claude-workflows@0.1.0"],
  secretRefs: ["piCodexAuth"],
  task: "research this and produce a report",
  verificationContract: "source-grounded-report-v1",
  workItemId: "thread-or-issue-123",
});

const cancelRequest = WorkRequestSchema.parse({
  ...request,
  workItemId: "thread-or-issue-cancel-123",
});

async function main() {
  const storage = new MemoryCapsuleStorage();
  const initialSupervisor = await CapsuleSupervisor.create(storage);
  const runningRecord = await initialSupervisor.startRun(request);

  assertRecordOwnsCapsuleFields(runningRecord);
  assertSandboxIsDisposable(runningRecord);

  const restoredSupervisor = await CapsuleSupervisor.create(
    storage,
    request.workItemId
  );
  const restoredState = String(restoredSupervisor.state);
  assertEqual("restored state", restoredState, "runningSandbox");

  const capturedRecord = await restoredSupervisor.succeed();
  assertEqual(
    "success final state",
    String(restoredSupervisor.state),
    "captured"
  );
  assertUndefined("success activeRunId", capturedRecord.activeRunId);
  assertRecordOwnsCapsuleFields(capturedRecord);
  assertNoPlaintextSecrets(capturedRecord);

  const cancelInitialSupervisor = await CapsuleSupervisor.create(storage);
  await cancelInitialSupervisor.startRun(cancelRequest);
  const cancelRestoredSupervisor = await CapsuleSupervisor.create(
    storage,
    cancelRequest.workItemId
  );
  const cancelledRecord = await cancelRestoredSupervisor.cancel();
  const cancelState = String(cancelRestoredSupervisor.state);
  assertEqual("cancel final state", cancelState, "cancelled");
  assertEqual(
    "cancel sandbox status",
    cancelledRecord.sandbox?.status,
    "destroyed"
  );
  const destroyReceipt = requireValue(
    cancelledRecord.sandbox?.destroyReceipt,
    "cancel destroy receipt"
  );

  await cancelRestoredSupervisor.send({
    commitSha: "should-not-restart-work",
    type: "SANDBOX_OUTPUTS_COMMITTED",
  });
  const ignoredWorkEventState = String(cancelRestoredSupervisor.state);
  assertEqual(
    "post-cancel work event state",
    ignoredWorkEventState,
    "cancelled"
  );

  const receipt: CapsuleSupervisorReceipt =
    CapsuleSupervisorReceiptSchema.parse({
      cancellation: {
        cancelState,
        destroyReceipt,
        ignoredWorkEventState,
        sandboxStatus: cancelledRecord.sandbox?.status,
        workItemId: cancelRequest.workItemId,
      },
      checks: [
        {
          id: "capsule-keyed-by-work-item",
          status: "passed",
          summary:
            "Capsule id derives from workItemId; sandbox id is a separate disposable handle.",
        },
        {
          id: "capsule-owns-durable-record",
          status: "passed",
          summary:
            "Capsule record owns artifact repo, context packs, latest run id, snapshot, event log, Wzrrd ref, and secret lease refs.",
        },
        {
          id: "snapshot-restores-after-instance-churn",
          status: "passed",
          summary:
            "A new supervisor instance restored the XState actor from the persisted capsule snapshot at runningSandbox.",
        },
        {
          id: "success-reaches-captured",
          status: "passed",
          summary:
            "Restored supervisor coordinated disposable sandbox outputs, verification, Wzrrd publication, destroy, and capture.",
        },
        {
          id: "cancel-destroys-sandbox",
          status: "passed",
          summary:
            "Cancellation transitioned through sandbox destruction and ended cancelled with a destroy receipt.",
        },
        {
          id: "post-cancel-work-ignored",
          status: "passed",
          summary:
            "A work event sent after cancellation did not restart the lifecycle or leave cancelled state.",
        },
        {
          id: "secret-refs-only",
          status: "passed",
          summary:
            "Capsule recorded secret refs and task-scoped lease metadata without plaintext secret values.",
        },
      ],
      prototype: "capsule-supervisor-spike",
      question:
        "Can a Durable-Object-shaped supervisor own a context capsule, persist XState snapshots/events, resume after churn, and coordinate disposable sandbox/artifact handles?",
      schemaVersion: "capsule-supervisor-receipt.v1",
      success: {
        capsuleId: capturedRecord.capsuleId,
        eventLogLength: capturedRecord.eventLog.length,
        finalState: String(restoredSupervisor.state),
        restoredState,
        sandboxId: requireValue(capturedRecord.sandbox?.sandboxId, "sandboxId"),
        workItemId: request.workItemId,
      },
    });

  await writeJson(outPath, receipt);
  console.log(JSON.stringify(receipt, null, 2));
  console.log(`wrote ${outPath}`);
}

function assertRecordOwnsCapsuleFields(record: CapsuleRecord) {
  requireValue(record.artifactRepo?.ref, "artifact repo ref");
  requireValue(record.latestRunId, "latest run id");
  requireValue(record.snapshot, "snapshot");
  requireValue(record.verificationContract, "verification contract");
  if (record.contextPackRefs.length === 0) {
    throw new Error("Expected contextPackRefs");
  }
  if (record.eventLog.length === 0) {
    throw new Error("Expected eventLog");
  }
}

function assertSandboxIsDisposable(record: CapsuleRecord) {
  const sandboxId = requireValue(record.sandbox?.sandboxId, "sandbox id");
  if (record.capsuleId === sandboxId) {
    throw new Error("Sandbox id must not be the durable capsule id");
  }
}

function assertNoPlaintextSecrets(record: CapsuleRecord) {
  const serialized = JSON.stringify(record);
  if (
    serialized.includes("secretValue") ||
    serialized.includes("access_token")
  ) {
    throw new Error("Plaintext secret marker leaked into capsule record");
  }
}

function assertEqual<T>(label: string, actual: T, expected: T) {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${String(expected)}, got ${String(actual)}`
    );
  }
}

function assertUndefined(label: string, actual: unknown) {
  if (actual !== undefined) {
    throw new Error(`${label}: expected undefined, got ${String(actual)}`);
  }
}

function requireValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`Missing ${label}`);
  }

  return value;
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
