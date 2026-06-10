import { describe, expect, it } from "vitest";

import type {
  WorkflowNodeAdapterPort,
  WorkflowNodeInvocationStep,
} from "../../src/app/application/ports.ts";
import type {
  AgentLaneReceipt,
  ArtifactPin,
  DynamicWorkflowMachineDocument,
  DynamicWorkflowPlanDocument,
} from "../../src/app/domain/schemas.ts";
import { createMemoryArtifactStore } from "../../src/app/infrastructure/memory-adapters.ts";
import { createIntegrationTestDreamMemoryFabricAdapter } from "../../src/cartridges/dream-memory-fabric/integration-test-adapters.ts";
import {
  DreamHitlDecisionDocumentSchema,
  DreamHitlFollowUpRunRequestDocumentSchema,
  DreamHitlDecisionWorkflowSeedDocumentSchema,
} from "../../src/cartridges/dream-memory-fabric/schemas.ts";
import { createDreamMemoryFabricWorkflowNodeAdapter } from "../../src/cartridges/dream-memory-fabric/workflow-node-adapter.ts";
import { integrationTestActor } from "./workflow-app-fixtures.ts";

const at = "2026-06-10T08:00:00.000Z";
const hash = "1".repeat(64);
const mediaType = "application/json";

const artifactPin = (path: string): ArtifactPin => ({
  artifactRef: `artifact://dream-hitl-seed-test/${path}`,
  hash,
  mediaType,
});

const plannerLane = {
  kind: "planner",
  laneId: "lane:planner",
  outputPins: [],
  outputRefs: [],
  prompt: artifactPin("planner/prompt.txt"),
  realAgent: false,
  receiptRef: "artifact://dream-hitl-seed-test/planner/receipt.json",
  redacted: true,
  runtime: "integration-test",
  startedAt: at,
  status: "completed",
  transcript: artifactPin("planner/transcript.jsonl"),
} satisfies AgentLaneReceipt;

const step = {
  config: {},
  dependsOn: [],
  inputRefs: [],
  kind: "workflow.node.invoke",
  nodeType: "joelclaw.dream.hitl-decision-seed",
  outputPath: "dream/hitl-decision-workflow-seed.json",
  packageRefs: ["artifact://packages/workflows/dream-memory-fabric/refs/v1"],
  stepId: "seed-next-workflow-from-hitl",
  summary: "Turn accepted Dream HITL decisions into next workflow input.",
} satisfies WorkflowNodeInvocationStep;

const followUpStep = {
  config: {
    requestedPackageIds: [
      "workflow/dream-memory-fabric",
      "badass-courses/claw-kernel",
    ],
    runId: "run-dream-hitl-follow-up-test",
    workItemId: "work-item:dream-hitl-follow-up-test",
  },
  dependsOn: [step.stepId],
  inputRefs: [],
  kind: "workflow.node.invoke",
  nodeType: "joelclaw.dream.hitl-follow-up-run-request",
  outputPath: "dream/hitl-follow-up-run-request.json",
  packageRefs: ["artifact://packages/workflows/dream-memory-fabric/refs/v1"],
  stepId: "draft-follow-up-run-request-from-hitl",
  summary: "Draft the next generated workflow request from Dream HITL seed.",
} satisfies WorkflowNodeInvocationStep;

const machine = {
  createdAt: at,
  machineId: "machine:dream-hitl-seed-test",
  planner: {
    kind: "stochastic",
    nonce: "nonce:dream-hitl-seed-test",
    source: "integration-test",
  },
  runId: "run-dream-hitl-seed-test",
  schemaVersion: "workflow.xstate-machine.v1",
  stepOrder: [step.stepId],
  workItemId: "work-item:dream-hitl-seed-test",
  xstate: {
    id: "dream-hitl-seed-test",
    initial: "seed",
    states: {
      done: {
        meta: {},
        on: {},
        type: "final",
      },
      seed: {
        meta: {
          stepId: step.stepId,
          stepKind: step.kind,
          summary: step.summary,
        },
        on: {
          STEP_DONE: {
            target: "done",
          },
        },
      },
    },
  },
} satisfies DynamicWorkflowMachineDocument;

const plan = {
  actor: integrationTestActor,
  createdAt: at,
  harness: {
    artifactRef: "artifact://dream-hitl-seed-test/workflows/harness.ts",
    entrypoint: "workflows/harness.ts",
    harnessId: "harness:dream-hitl-seed-test",
    hash,
    language: "typescript",
  },
  machine: {
    artifactRef:
      "artifact://dream-hitl-seed-test/workflows/machine.config.json",
    hash,
    machineId: machine.machineId,
    sourceArtifactRef: "artifact://dream-hitl-seed-test/workflows/machine.ts",
    sourceHash: hash,
  },
  outputTarget: {
    kind: "artifact-only",
    path: "review/summary.json",
  },
  pinnedPackages: [],
  planId: "plan:dream-hitl-seed-test",
  planner: machine.planner,
  plannerLane,
  proposal: {
    intent:
      "Use human Dream HITL decisions as constraints for the next generated workflow.",
    requestedPackageIds: ["workflow/dream-memory-fabric"],
    stochasticNotes: [
      "The HITL decision seed node is package-backed and must not be runner logic.",
    ],
  },
  runId: machine.runId,
  safety: {
    capabilityLeasesRequired: true,
    durableState: "artifacts-d1-do-r2-only",
    scratchOnly: true,
  },
  schemaVersion: "workflow.dynamic-plan.v1",
  sideEffects: [],
  steps: [step],
  verificationContract: {
    artifactRef:
      "artifact://dream-hitl-seed-test/run/verification-contract.json",
    contractId: "contract:dream-hitl-seed-test",
    hash,
    mediaType,
  },
  workItemId: machine.workItemId,
} satisfies DynamicWorkflowPlanDocument;

const decisionDocument = DreamHitlDecisionDocumentSchema.parse({
  decisionCount: 2,
  decisions: [
    {
      decision: "accept",
      decisionId: "decision:dream:generated-machine-proof",
      rating: 9,
      reasoning:
        "The report has enough generated-machine and hydration proof to promote this constraint.",
      recommendation:
        "Update Brain/package constraints and feed this into the next generated workflow.",
      reviewedAt: at,
      sourceRefs: [
        "artifact://dream-hitl-seed-test/dream/hitl-report.json",
        "artifact://dream-hitl-seed-test/dream/refinement-proposals.json",
      ],
      summary: "Generated-machine proof should be a durable Dream constraint.",
      targetId: "proposal:kernel-memory:1",
      targetKind: "refinement-proposal",
      targetTitle: "Promote generated-machine proof memory",
    },
    {
      decision: "turn-into-work",
      decisionId: "decision:dream:capture-ingest-fix",
      rating: 10,
      reasoning:
        "Backfill is recovery, so the next workflow needs an explicit ingest-repair item.",
      recommendation:
        "Create follow-up work to repair capture before future Dream runs.",
      reviewedAt: at,
      sourceRefs: ["artifact://dream-hitl-seed-test/dream/backfill-run.json"],
      summary: "Turn recurring backfill into capture-ingest repair work.",
      targetId: "proposal:capture-ingest-fix:1",
      targetKind: "refinement-proposal",
      targetTitle: "Repair Dream capture path",
    },
  ],
  generatedAt: at,
  nextWorkflowSeed: {
    artifactUpdateTargets: [
      {
        sourceRefs: ["artifact://dream-hitl-seed-test/dream/hitl-report.json"],
        summary: "Update Brain with the accepted generated-machine proof rule.",
        targetKind: "brain",
      },
      {
        sourceRefs: ["artifact://dream-hitl-seed-test/dream/backfill-run.json"],
        summary:
          "Turn recurring backfill into package or adapter ingest-repair work.",
        targetKind: "workflow",
      },
    ],
    decisionIds: [
      "decision:dream:generated-machine-proof",
      "decision:dream:capture-ingest-fix",
    ],
    plannerInstructions: [
      "Treat accepted Dream decisions as constraints for the next generated workflow.",
      "Turn work-conversion decisions into explicit workflow/package update items.",
    ],
    requiredCapabilityKinds: ["brain.update.review"],
    sourceRefs: [
      "artifact://dream-hitl-seed-test/dream/hitl-report.json",
      "artifact://dream-hitl-seed-test/dream/backfill-run.json",
    ],
  },
  redacted: true,
  refinementProposalRef:
    "artifact://dream-hitl-seed-test/dream/refinement-proposals.json",
  reportRef: "artifact://dream-hitl-seed-test/dream/hitl-report.json",
  reviewer: {
    id: "actor:joel",
    organizationId: "org:joelhooks",
    roleIds: ["dream.reviewer"],
    sessionId: "session:dream-hitl-review",
    trustTier: "manual",
    type: "human",
  },
  runId: machine.runId,
  schemaVersion: "dream.hitl-decision.v1",
  sourceRefs: [
    "artifact://dream-hitl-seed-test/dream/hitl-report.json",
    "artifact://dream-hitl-seed-test/dream/refinement-proposals.json",
  ],
  workItemId: machine.workItemId,
});

describe("Dream HITL decision workflow-seed node", () => {
  it("turns accepted HITL decisions into a next-workflow seed artifact", async () => {
    const artifacts = createMemoryArtifactStore("dream-hitl-seed-node");
    const decisionWrite = await artifacts.writeJson({
      path: "dream/hitl-decision.json",
      redacted: true,
      runId: machine.runId,
      value: decisionDocument,
    });
    const adapter = createDreamMemoryFabricWorkflowNodeAdapter({
      artifacts,
      dreamMemoryFabric: createIntegrationTestDreamMemoryFabricAdapter(),
    });
    const executeInput = {
      actor: integrationTestActor,
      dependencyArtifactRefs: {},
      machine,
      plan,
      step: {
        ...step,
        inputRefs: [decisionWrite.artifactRef],
      },
    } satisfies Parameters<WorkflowNodeAdapterPort["execute"]>[0];

    const result = await adapter.execute(executeInput);
    if (result.status === "blocked") {
      throw new Error(result.blocker.message);
    }
    const seedRef = result.outputRefs.at(0);
    if (seedRef === undefined) {
      throw new Error("Expected HITL decision workflow seed output ref.");
    }

    const seed = DreamHitlDecisionWorkflowSeedDocumentSchema.parse(
      await artifacts.readJson({ artifactRef: seedRef })
    );

    expect({
      acceptedDecisionIds: seed.acceptedDecisionIds,
      actionableDecisionCount: seed.actionableDecisionCount,
      nextWorkflowSeedDecisionIds: seed.nextWorkflowSeed.decisionIds,
      outputRefCount: result.outputRefs.length,
      requiredCapabilities: seed.nextWorkflowSeed.requiredCapabilityKinds,
      schemaVersion: seed.schemaVersion,
      status: seed.status,
      workItemDecisionIds: seed.workItemDecisionIds,
    }).toStrictEqual({
      acceptedDecisionIds: ["decision:dream:generated-machine-proof"],
      actionableDecisionCount: 2,
      nextWorkflowSeedDecisionIds: [
        "decision:dream:generated-machine-proof",
        "decision:dream:capture-ingest-fix",
      ],
      outputRefCount: 1,
      requiredCapabilities: ["brain.update.review"],
      schemaVersion: "dream.hitl-decision-workflow-seed.v1",
      status: "ready",
      workItemDecisionIds: ["decision:dream:capture-ingest-fix"],
    });
  });

  it("drafts a follow-up run request from the HITL workflow seed without submitting it", async () => {
    const artifacts = createMemoryArtifactStore("dream-hitl-follow-up-node");
    const seedDocument = DreamHitlDecisionWorkflowSeedDocumentSchema.parse({
      acceptedDecisionIds: ["decision:dream:generated-machine-proof"],
      actionableDecisionCount: 2,
      actionableDecisions: decisionDocument.decisions,
      decisionRef: "artifact://dream-hitl-seed-test/dream/hitl-decision.json",
      generatedAt: at,
      heldDecisionIds: [],
      nextWorkflowSeed: decisionDocument.nextWorkflowSeed,
      redacted: true,
      refinementProposalRef:
        "artifact://dream-hitl-seed-test/dream/refinement-proposals.json",
      rejectedDecisionIds: [],
      reportRef: decisionDocument.reportRef,
      runId: machine.runId,
      schemaVersion: "dream.hitl-decision-workflow-seed.v1",
      sourceRefs: [
        "artifact://dream-hitl-seed-test/dream/hitl-decision.json",
        "artifact://dream-hitl-seed-test/dream/hitl-report.json",
        "artifact://dream-hitl-seed-test/dream/refinement-proposals.json",
        "artifact://dream-hitl-seed-test/dream/backfill-run.json",
      ],
      status: "ready",
      summary:
        "HITL accepted one Dream decision and turned one decision into work.",
      workItemDecisionIds: ["decision:dream:capture-ingest-fix"],
      workItemId: machine.workItemId,
    });
    const seedWrite = await artifacts.writeJson({
      path: "dream/hitl-decision-workflow-seed.json",
      redacted: true,
      runId: machine.runId,
      value: seedDocument,
    });
    const adapter = createDreamMemoryFabricWorkflowNodeAdapter({
      artifacts,
      dreamMemoryFabric: createIntegrationTestDreamMemoryFabricAdapter(),
    });
    const executeInput = {
      actor: integrationTestActor,
      dependencyArtifactRefs: {},
      machine,
      plan,
      step: {
        ...followUpStep,
        inputRefs: [seedWrite.artifactRef],
      },
    } satisfies Parameters<WorkflowNodeAdapterPort["execute"]>[0];

    const result = await adapter.execute(executeInput);
    if (result.status === "blocked") {
      throw new Error(result.blocker.message);
    }
    const requestRef = result.outputRefs.at(0);
    if (requestRef === undefined) {
      throw new Error("Expected HITL follow-up run request output ref.");
    }

    const followUp = DreamHitlFollowUpRunRequestDocumentSchema.parse(
      await artifacts.readJson({ artifactRef: requestRef })
    );

    expect({
      actionableDecisionCount: followUp.actionableDecisionCount,
      outputRefCount: result.outputRefs.length,
      requestRunId: followUp.request?.runId,
      requestWorkItemId: followUp.request?.workItemId,
      requestedPackageIds: followUp.requestedPackageIds,
      schemaVersion: followUp.schemaVersion,
      status: followUp.status,
      submitted: followUp.submitted,
      usesPlannerInstruction:
        followUp.request?.planProposal.stochasticNotes.includes(
          "Treat accepted Dream decisions as constraints for the next generated workflow."
        ) ?? false,
    }).toStrictEqual({
      actionableDecisionCount: 2,
      outputRefCount: 1,
      requestRunId: "run-dream-hitl-follow-up-test",
      requestWorkItemId: "work-item:dream-hitl-follow-up-test",
      requestedPackageIds: [
        "workflow/dream-memory-fabric",
        "badass-courses/claw-kernel",
      ],
      schemaVersion: "dream.hitl-follow-up-run-request.v1",
      status: "drafted",
      submitted: false,
      usesPlannerInstruction: true,
    });
  });
});
