import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { Bash } from "just-bash";
import { createActor } from "xstate";
import type { ActorRefFrom, SnapshotFrom } from "xstate";

import { sandboxWorkflowMachine } from "./machine.ts";
import type { RunEvent } from "./machine.ts";
import {
  PrototypeSnapshotResumeReceiptSchema,
  VerificationResultSchema,
} from "./schema.ts";
import type {
  PrototypeSnapshotResumeReceipt,
  VerificationResult,
  WorkflowEventReceipt,
} from "./schema.ts";

type Snapshot = SnapshotFrom<typeof sandboxWorkflowMachine>;
type WorkflowActor = ActorRefFrom<typeof sandboxWorkflowMachine>;

const dryRun = process.argv.includes("--dry-run");
const repoRoot = resolve(import.meta.dirname, "../../..");
const outDir = resolve(repoRoot, "prototypes/sandbox-workflow-spike/out");
const latestRunPath = resolve(outDir, "latest-run.json");
const resumeReceiptPath = resolve(outDir, "latest-resume-receipt.json");
const snapshotPath = resolve(outDir, "latest-persisted-snapshot.json");
const expectedResumeState = "committingReaderOutputs";

const printSnapshot = (label: string, snapshot: Snapshot) => {
  const state = JSON.stringify(snapshot.value);
  const { context } = snapshot;
  console.log(`${label}: ${state}`);
  console.log(
    JSON.stringify(
      {
        artifactRefs: context.artifactRefs,
        authLeaseRef: context.authLeaseRef,
        capsuleId: context.capsuleId,
        captureStatus: context.captureStatus,
        contextPackRef: context.contextPackRef,
        destroyReceipt: context.destroyReceipt,
        error: context.error,
        harnessRef: context.harnessRef,
        laneReceipts: context.laneReceipts,
        machineRef: context.machineRef,
        planRef: context.planRef,
        runId: context.runId,
        sandboxId: context.sandboxId,
        sandboxRole: context.sandboxRole,
        verificationContractRef: context.verificationContractRef,
        verificationResult: context.verificationResult,
        warnings: context.warnings,
        wzrrdPageRef: context.wzrrdPageRef,
      },
      null,
      2
    )
  );
};

const buildDryVerification = () =>
  VerificationResultSchema.parse({
    blockingFailures: [],
    checkedArtifacts: [
      "artifacts/report.md",
      "artifacts/sources.json",
      "run/verification-contract.json",
    ],
    checks: [
      {
        criterionId: "required-reader-artifacts",
        evidence: [
          "artifacts/report.md",
          "artifacts/sources.json",
          "artifacts/context-pack/pack.json",
        ],
        severity: "blocking",
        status: "verified",
        summary:
          "All required reader artifacts exist in the just-bash simulation.",
      },
      {
        criterionId: "source-citation-coverage",
        evidence: ["- claim [source:anthropic-dynamic-workflows-blog]"],
        severity: "blocking",
        status: "verified",
        summary: "Every source-backed bullet cites a known source id.",
      },
    ],
    contractRef: "run/verification-contract.json",
    generatedAt: new Date().toISOString(),
    schemaVersion: "verification-result.v1",
    status: "verified",
    verifier: {
      kind: "fixed-prototype-verifier",
      notes: "Dry-run result produced by just-bash simulation.",
    },
    warnings: [],
  });

const buildDryEventPlan = (
  simulatedFiles: string[],
  verification: VerificationResult
): { postRestoreEvents: RunEvent[]; preRestoreEvents: RunEvent[] } => ({
  postRestoreEvents: [
    {
      artifactRefs: [
        "artifact:artifacts/report.md@reader",
        "artifact:artifacts/sources.json@reader",
      ],
      commitSha: "reader-dry-commit",
      type: "READER_OUTPUTS_COMMITTED",
    },
    {
      artifactRefs: [
        "artifact:artifacts/verification/result.json",
        "artifact:artifacts/verification/report.md",
      ],
      result: verification,
      type: "VERIFIER_RUN_COMPLETE",
    },
    {
      artifactRefs: [
        "artifact:artifacts/verification/result.json@verifier",
        "artifact:artifacts/wzrrd/review.html@verifier",
      ],
      commitSha: "verifier-dry-commit",
      type: "VERIFIER_OUTPUTS_COMMITTED",
    },
    { status: "verified", type: "VERIFICATION_ACCEPTED" },
    { ref: "wzrrd:research-claude-workflows:dry-run", type: "WZRRD_PUBLISHED" },
    {
      receipt: "destroy:dry-run-reader-verifier:ok",
      type: "SANDBOX_DESTROYED",
    },
    { type: "CAPTURED" },
  ],
  preRestoreEvents: [
    { runId: "prototype-run-0001", type: "START" },
    {
      capsuleId: "capsule:research-claude-workflows",
      type: "CAPSULE_RESOLVED",
    },
    {
      ref: "context-pack:research-claude-workflows@0.1.0-real-prototype",
      type: "CONTEXT_PACK_PINNED",
    },
    {
      artifactRefs: simulatedFiles.map((file) => `artifact:${file}`),
      harnessRef: "workflows/harness.js",
      machineRef: "workflows/machine.ts",
      planRef: "run/plan.json",
      type: "PLAN_COMMITTED",
      verificationContractRef: "run/verification-contract.json",
    },
    { ref: "lease:piCodexAuth:dry-run", type: "AUTH_LEASE_MINTED" },
    {
      role: "reader",
      sandboxId: "sandbox:dry-run-reader-verifier",
      type: "SANDBOX_READY",
    },
    {
      artifactRefs: [
        "artifact:artifacts/report.md",
        "artifact:artifacts/sources.json",
        "artifact:artifacts/context-pack/pack.json",
      ],
      type: "READER_RUN_COMPLETE",
    },
  ],
});

const simulateWithJustBash = async () => {
  const bash = new Bash({ cwd: "/workspace" });
  await bash.exec(
    "mkdir -p run workflows artifacts/context-pack artifacts/verification artifacts/wzrrd"
  );
  await bash.exec(
    "printf '%s\n' '{\"schemaVersion\":\"plan.v1\"}' > run/plan.json"
  );
  await bash.exec(
    "printf '%s\n' 'source machine receipt' > workflows/machine.ts"
  );
  await bash.exec("printf '%s\n' 'harness receipt' > workflows/harness.js");
  await bash.exec(
    "printf '%s\n' '{\"schemaVersion\":\"verification-contract.v1\"}' > run/verification-contract.json"
  );
  await bash.exec(
    "printf '%s\n' '# report [source:anthropic-dynamic-workflows-blog]' > artifacts/report.md"
  );
  await bash.exec("printf '%s\n' '[]' > artifacts/sources.json");
  const result = await bash.exec("find run workflows artifacts -type f | sort");
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || "just-bash simulation failed");
  }

  return result.stdout.trim().split("\n").filter(Boolean);
};

const send = (
  actor: WorkflowActor,
  event: RunEvent,
  eventLog: WorkflowEventReceipt[]
) => {
  actor.send(event);
  const snapshot = actor.getSnapshot();
  eventLog.push({
    at: new Date().toISOString(),
    context: snapshot.context,
    event: event.type,
    state: snapshot.value,
    status: String(snapshot.status),
  });
  printSnapshot(`after ${event.type}`, snapshot);
};

const writeJson = async (path: string, value: unknown) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
};

const assertState = (label: string, snapshot: Snapshot, expected: string) => {
  if (snapshot.value !== expected) {
    throw new Error(
      `${label} expected ${expected}, got ${JSON.stringify(snapshot.value)}`
    );
  }
};

const main = async () => {
  let actor = createActor(sandboxWorkflowMachine);
  actor.start();
  const simulatedFiles = await simulateWithJustBash();
  const verification = buildDryVerification();
  const { postRestoreEvents, preRestoreEvents } = buildDryEventPlan(
    simulatedFiles,
    verification
  );
  const eventLog: WorkflowEventReceipt[] = [];

  printSnapshot("initial", actor.getSnapshot());
  for (const event of preRestoreEvents) {
    send(actor, event, eventLog);
  }

  const persistedAt = new Date().toISOString();
  const beforePersist = actor.getSnapshot();
  assertState("persist checkpoint", beforePersist, expectedResumeState);
  const persistedSnapshot = actor.getPersistedSnapshot();
  await writeJson(snapshotPath, persistedSnapshot);
  actor.stop();

  const restoredAt = new Date().toISOString();
  actor = createActor(sandboxWorkflowMachine, { snapshot: persistedSnapshot });
  actor.start();
  const restoredSnapshot = actor.getSnapshot();
  printSnapshot("restored from persisted snapshot", restoredSnapshot);
  assertState("restored actor", restoredSnapshot, expectedResumeState);

  for (const event of postRestoreEvents) {
    send(actor, event, eventLog);
  }

  const finalSnapshot = actor.getSnapshot();
  if (finalSnapshot.status !== "done") {
    throw new Error("Prototype did not finish in a final state.");
  }

  const receipt: PrototypeSnapshotResumeReceipt =
    PrototypeSnapshotResumeReceiptSchema.parse({
      checks: [
        {
          id: "persisted-at-checkpoint",
          status: "passed",
          summary:
            "Actor persisted with getPersistedSnapshot() while state was committingReaderOutputs.",
        },
        {
          id: "restored-at-checkpoint",
          status: "passed",
          summary:
            "createActor(machine, { snapshot }) restored the actor at committingReaderOutputs.",
        },
        {
          id: "continued-to-captured",
          status: "passed",
          summary:
            "Restored actor accepted the remaining reader commit, verifier, publish, cleanup, and capture events.",
        },
        {
          id: "event-log-kept-for-audit",
          status: "passed",
          summary:
            "Receipt preserved the sent event log separately from the operational snapshot.",
        },
      ],
      eventLog,
      final: {
        context: finalSnapshot.context,
        finishedAt: new Date().toISOString(),
        state: finalSnapshot.value,
        status: String(finalSnapshot.status),
      },
      prototype: "sandbox-workflow-spike",
      question:
        "Can the supervisor persist an XState actor snapshot mid reader/verifier run, restore it, and continue to captured?",
      runId: finalSnapshot.context.runId,
      schemaVersion: "prototype-snapshot-resume-receipt.v1",
      simulatedFiles,
      snapshot: {
        persistedAt,
        persistedSnapshot,
        persistedState: beforePersist.value,
        persistedStatus: String(beforePersist.status),
        restoredAt,
        restoredState: restoredSnapshot.value,
        restoredStatus: String(restoredSnapshot.status),
      },
    });

  await writeJson(resumeReceiptPath, receipt);
  await writeJson(latestRunPath, receipt);
  console.log(`wrote ${resumeReceiptPath}`);
  console.log(`wrote ${snapshotPath}`);
  if (!dryRun) {
    console.log(`wrote ${latestRunPath}`);
  }
};

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
