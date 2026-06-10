import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
/* eslint-disable func-style, import/consistent-type-specifier-style, no-shadow, no-use-before-define */

import { createActor } from "xstate";

import { buildDreamArtifactBundle } from "./artifact-files.ts";
import { createLocalArtifactRepo } from "./local-artifact.ts";
import { dreamWorkflowMachine } from "./machine.ts";
import {
  AccessRefSchema,
  CandidateCoreMemorySchema,
  ComponentPackSchema,
  DeploymentDesiredStateSchema,
  DreamEventSchema,
  DreamLocalReceiptSchema,
  DreamManifestSchema,
  FlowRatificationSchema,
  GraphEdgeSchema,
  GraphNodeSchema,
  MemoryPackSchema,
  ReceiptSchema,
  WorkflowPlanSchema,
} from "./schema.ts";
import type { Receipt } from "./schema.ts";
import { captureGitManifestSnapshot, fileReceipt } from "./snapshot.ts";

const repoRoot = resolve(process.cwd());
const sourceRepoPath = resolve(
  process.env["DREAM_SOURCE_REPO"] ?? "/Users/joel/Code/joelhooks/dark-wizard"
);
const outRoot = resolve(
  process.env["DREAM_OUT_DIR"] ?? "prototypes/shitrat-dream-workflow-spike/out"
);
const focus = process.env["DREAM_FOCUS"] ?? "shitrat-system-operating-graph";
const runId =
  process.env["DREAM_RUN_ID"] ??
  `dream-system-graph-${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`;

const createdAt = new Date().toISOString();
const snapshot = captureGitManifestSnapshot({
  repoPath: sourceRepoPath,
  snapshotId: `shitrat-snapshot-${runId}`,
});
const receipts = buildReceipts(repoRoot);
const bundle = buildDreamArtifactBundle({
  createdAt,
  focus,
  receipts,
  runId,
  snapshot,
  sourceRepoPath,
});

validateBundle(bundle);

const actor = createActor(dreamWorkflowMachine, {
  input: { runId },
});
actor.start();
actor.send({ type: "START_EXPLORING" });
for (const phase of bundle.workflowPlan.phases) {
  actor.send({ phaseId: phase.phaseId, type: "STOCHASTIC_PHASE_RECORDED" });
}
actor.send({
  candidateCount: bundle.candidates.length,
  graphNodeCount: bundle.nodes.length,
  type: "REVIEW_READY",
  workflowLaneCount: bundle.workflowPlan.lanes.length,
});
actor.send({ type: "CAPTURE" });

const finalState = actor.getSnapshot().value;
if (finalState !== "captured") {
  throw new Error(`dream safety envelope ended in ${String(finalState)}`);
}

const artifactRepoPath = join(outRoot, "artifacts", runId);
const commit = createLocalArtifactRepo({
  files: bundle.files,
  message: `dream: ${focus} (${runId})`,
  repoPath: artifactRepoPath,
});
const receipt = DreamLocalReceiptSchema.parse({
  artifactCommits: [commit],
  artifactRepoPath,
  candidateCount: bundle.candidates.length,
  finalState,
  graphNodeCount: bundle.nodes.length,
  runId,
  sourceRepoPath,
  workflowLaneCount: bundle.workflowPlan.lanes.length,
});

mkdirSync(outRoot, { recursive: true });
writeFileSync(
  join(outRoot, "latest-receipt.json"),
  `${JSON.stringify(receipt, null, 2)}\n`
);
console.log(JSON.stringify(receipt, null, 2));

function buildReceipts(root: string): Receipt[] {
  return [
    fileReceipt({
      id: "operating-graph-artifacts-doc",
      label: "ShitRat operating graph artifact design",
      locator: join(root, "docs/shitrat-operating-graph-artifacts.md"),
    }),
    fileReceipt({
      id: "dynamic-workflow-machine-doc",
      label: "Dynamic workflow machine design",
      locator: join(root, "docs/dynamic-workflow-machine.md"),
    }),
    fileReceipt({
      id: "sandbox-brain-project-note",
      label: "Pi sandbox workflows Brain note",
      locator: join(root, ".brain/projects/pi-sandbox-workflows.svx"),
    }),
    fileReceipt({
      id: "memory-distillation-dreams-note",
      label: "Private Memory Distillation Dreams note",
      locator:
        "/Users/joel/Code/joelhooks/dark-wizard/.brain/resources/memory-distillation-dreams.svx",
      note: "Private source pointer only; artifact stores hash and locator for local prototype receipt.",
    }),
  ].map((receipt) => ReceiptSchema.parse(receipt));
}

function validateBundle(bundleToValidate: typeof bundle): void {
  DreamManifestSchema.parse(bundleToValidate.manifest);
  WorkflowPlanSchema.parse(bundleToValidate.workflowPlan);
  for (const candidate of bundleToValidate.candidates) {
    CandidateCoreMemorySchema.parse(candidate);
  }
  for (const ratification of bundleToValidate.flowRatifications) {
    FlowRatificationSchema.parse(ratification);
  }
  for (const node of bundleToValidate.nodes) {
    GraphNodeSchema.parse(node);
  }
  for (const edge of bundleToValidate.edges) {
    GraphEdgeSchema.parse(edge);
  }
  for (const component of bundleToValidate.components) {
    ComponentPackSchema.parse(component);
  }
  for (const access of bundleToValidate.access) {
    AccessRefSchema.parse(access);
  }
  for (const memory of bundleToValidate.memory) {
    MemoryPackSchema.parse(memory);
  }
  for (const deployment of bundleToValidate.deployments) {
    DeploymentDesiredStateSchema.parse(deployment);
  }
  for (const event of bundleToValidate.events) {
    DreamEventSchema.parse(event);
  }
}
