import { describe, expect, it } from "vitest";

import type {
  WorkflowNodeAdapterPort,
  WorkflowNodeInvocationStep,
} from "../../src/app/application/ports.ts";
import { WorkflowNodeTypeSchema } from "../../src/app/domain/schemas.ts";
import type {
  AgentLaneReceipt,
  ArtifactPin,
  DynamicWorkflowMachineDocument,
  DynamicWorkflowPlanDocument,
} from "../../src/app/domain/schemas.ts";
import { createMemoryArtifactStore } from "../../src/app/infrastructure/memory-adapters.ts";
import { createIntegrationTestMemoryFabricAdapter } from "../../src/cartridges/memory-fabric/integration-test-adapters.ts";
import {
  MemoryHitlDecisionDocumentSchema,
  MemoryHitlFollowUpRunRequestDocumentSchema,
  MemoryHitlDecisionWorkflowSeedDocumentSchema,
  MemoryRefinementProposalDocumentSchema,
  WorkflowHitlReportDocumentSchema,
} from "../../src/cartridges/memory-fabric/schemas.ts";
import { createMemoryFabricWorkflowNodeAdapter } from "../../src/cartridges/memory-fabric/workflow-node-adapter.ts";
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
  nodeType: WorkflowNodeTypeSchema.parse("joelclaw.memory.hitl-decision-seed"),
  outputPath: "report/hitl-decision-workflow-seed.json",
  packageRefs: ["artifact://packages/workflows/memory-fabric/refs/v1"],
  stepId: "seed-next-workflow-from-hitl",
  summary: "Turn accepted Dream HITL decisions into next workflow input.",
} satisfies WorkflowNodeInvocationStep;

const followUpStep = {
  config: {
    requestedPackageIds: [
      "workflow/memory-fabric",
      "badass-courses/claw-kernel",
    ],
    runId: "run-memory-hitl-follow-up-test",
    workItemId: "work-item:memory-hitl-follow-up-test",
  },
  dependsOn: [step.stepId],
  inputRefs: [],
  kind: "workflow.node.invoke",
  nodeType: WorkflowNodeTypeSchema.parse(
    "joelclaw.memory.hitl-follow-up-run-request"
  ),
  outputPath: "report/hitl-follow-up-run-request.json",
  packageRefs: ["artifact://packages/workflows/memory-fabric/refs/v1"],
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
    requestedPackageIds: ["workflow/memory-fabric"],
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

const decisionDocument = MemoryHitlDecisionDocumentSchema.parse({
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
        "artifact://dream-hitl-seed-test/report/hitl-report.json",
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
        sourceRefs: ["artifact://dream-hitl-seed-test/report/hitl-report.json"],
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
      "artifact://dream-hitl-seed-test/report/hitl-report.json",
      "artifact://dream-hitl-seed-test/dream/backfill-run.json",
    ],
  },
  redacted: true,
  refinementProposalRef:
    "artifact://dream-hitl-seed-test/dream/refinement-proposals.json",
  reportRef: "artifact://dream-hitl-seed-test/report/hitl-report.json",
  reviewer: {
    id: "actor:joel",
    organizationId: "org:joelhooks",
    roleIds: ["dream.reviewer"],
    sessionId: "session:dream-hitl-review",
    trustTier: "manual",
    type: "human",
  },
  runId: machine.runId,
  schemaVersion: "memory.hitl-decision.v1",
  sourceRefs: [
    "artifact://dream-hitl-seed-test/report/hitl-report.json",
    "artifact://dream-hitl-seed-test/dream/refinement-proposals.json",
  ],
  workItemId: machine.workItemId,
});

const refinementProposalDocument = MemoryRefinementProposalDocumentSchema.parse(
  {
    generatedAt: at,
    nextWorkflowSeed: {
      plannerInstructions: [
        "Use accepted refinement proposals as constraints for the next generated workflow.",
        "Keep generated follow-up work reviewable until a human accepts it.",
      ],
      proposalIds: [
        "proposal:kernel-memory:generated-machine-proof",
        "proposal:capture-ingest-fix:runtime-capture",
      ],
      requiredCapabilityKinds: ["brain.update.review"],
      sourceRefs: [
        "artifact://dream-hitl-seed-test/report/hitl-report.json",
        "artifact://dream-hitl-seed-test/dream/refinement-proposals.json",
      ],
    },
    proposalCount: 2,
    proposals: [
      {
        proposalId: "proposal:kernel-memory:generated-machine-proof",
        proposedNextStep:
          "Draft a Brain/package constraint that requires generated-machine proof before Dream follow-up work is trusted.",
        rating: 9,
        reasoning:
          "The generated report cites the pinned machine, harness, and report proof.",
        receipts: [
          {
            family: "agent-transcripts",
            hash,
            receiptId: "receipt:generated-machine-proof",
            redacted: true,
            sourceId: "source:joelclaw-sessions",
          },
        ],
        recommendation: "accept",
        sourceRefs: ["artifact://dream-hitl-seed-test/report/hitl-report.json"],
        summary:
          "Promote generated-machine proof as a durable Dream constraint.",
        targetKind: "kernel-memory",
        title: "Promote generated-machine proof memory",
      },
      {
        proposalId: "proposal:capture-ingest-fix:runtime-capture",
        proposedNextStep:
          "Draft follow-up workflow repair work for recurring capture-ingest gaps.",
        rating: 10,
        reasoning:
          "The generated report found recurring capture gaps in the redacted transcript receipts.",
        receipts: [
          {
            family: "agent-transcripts",
            hash,
            receiptId: "receipt:capture-ingest-fix",
            redacted: true,
            sourceId: "source:joelclaw-sessions",
          },
        ],
        recommendation: "turn-into-work",
        sourceRefs: [
          "artifact://dream-hitl-seed-test/dream/refinement-proposals.json",
        ],
        summary: "Turn recurring capture gaps into workflow repair work.",
        targetKind: "capture-ingest-fix",
        title: "Repair Dream capture ingest",
      },
    ],
    reasoningMode: "agentic",
    redacted: true,
    runId: machine.runId,
    schemaVersion: "memory.refinement-proposals.v1",
    sourceRefs: [
      "artifact://dream-hitl-seed-test/report/hitl-report.json",
      "artifact://dream-hitl-seed-test/dream/refinement-proposals.json",
    ],
    workItemId: machine.workItemId,
  }
);

const reportDocument = WorkflowHitlReportDocumentSchema.parse({
  definitionOfDoneAudit: {
    generatedAt: at,
    items: [
      {
        evidenceRefs: [
          "artifact://dream-hitl-seed-test/report/hitl-report.json",
        ],
        requirement:
          "The generated Dream report remains redacted and source-backed.",
        requirementId: "redacted-source-backed-report",
        status: "captured",
        summary: "The fixture report keeps rawTranscriptsReturned=false.",
      },
    ],
    redacted: true,
    runId: machine.runId,
    schemaVersion: "workflow.hitl-report.definition-of-done-audit.v1",
    status: "captured",
    summary: {
      blockedCount: 0,
      capturedCount: 1,
      missingCount: 0,
      notProvenCount: 0,
      totalCount: 1,
    },
  },
  expiresIn: "24h",
  findingCount: 1,
  findings: [
    {
      rating: 9,
      reasoning:
        "The report has generated-machine proof and redacted source receipts.",
      receipts: [
        {
          family: "agent-transcripts",
          hash,
          receiptId: "receipt:generated-machine-proof",
          redacted: true,
          sourceId: "source:joelclaw-sessions",
        },
      ],
      recommendation:
        "Draft follow-up work from the proposals, but keep it unsubmitted.",
      summary: "This dream found work to do.",
      title: "Generated Dream report needs follow-up drafts",
    },
  ],
  generatedAt: at,
  hitlDecisionContract: {
    artifactPath: "report/hitl-decision.json",
    contractRef: "contract://workflow/memory-fabric/hitl-decision.v1",
    decisionSchemaVersion: "memory.hitl-decision.v1",
    exportId: "memory-hitl-decision-schema",
    nextWorkflowSeedRequiredFor: ["accept", "turn-into-work"],
    sourceRefs: [
      "artifact://dream-hitl-seed-test/report/hitl-report.json",
      "artifact://dream-hitl-seed-test/dream/refinement-proposals.json",
    ],
    targetKinds: ["finding-card", "refinement-proposal"],
  },
  mdsvx: "# This dream found work to do.\n\n## The actual findings\n",
  noindex: true,
  proof: {
    dynamicGenerationProofLevel: "generated-machine",
    generatedArtifacts: {
      harness: plan.harness,
      machine: plan.machine,
      plan: {
        planId: plan.planId,
        planner: plan.planner,
        stepCount: plan.steps.length,
      },
      verificationContract: plan.verificationContract,
    },
    rawTranscriptsReturned: false,
    stateMachineFigure: {
      aspectRatio: "3:5",
      component: "D2",
      machineBinding: {
        machineArtifactHash: plan.machine.hash,
        machineArtifactRef: plan.machine.artifactRef,
        machineId: plan.machine.machineId,
        machineSourceArtifactRef: plan.machine.sourceArtifactRef,
        machineSourceHash: plan.machine.sourceHash,
        status: "bound-to-generated-machine",
      },
      machineId: plan.machine.machineId,
      source: "seed -> done: STEP_DONE",
      sourceHash: hash,
      sourceKind: "generated-xstate-machine",
      stateCount: 2,
      transitionCount: 1,
    },
  },
  receiptCount: 1,
  redacted: true,
  refinementProposalCount: 2,
  refinementProposalRef:
    "artifact://dream-hitl-seed-test/dream/refinement-proposals.json",
  refinementProposals: refinementProposalDocument.proposals,
  refinementReasoningMode: "agentic",
  runId: machine.runId,
  schemaVersion: "workflow.hitl-report.v1",
  sectionOrder: [
    "run-context",
    "actual-findings",
    "what-to-do",
    "actionable-line-items",
    "proof",
    "technical-appendix",
  ],
  sourceRefs: [
    "artifact://dream-hitl-seed-test/report/hitl-report.json",
    "artifact://dream-hitl-seed-test/dream/refinement-proposals.json",
  ],
  template: {
    defaultExpiresIn: "24h",
    format: "mdsvx",
    noindex: true,
    templateId: "joel/tufte-mdsvx",
    version: "0.1.0",
  },
  title: "This dream found work to do.",
  workItemId: machine.workItemId,
});

describe("Dream HITL decision workflow-seed node", () => {
  it("turns accepted HITL decisions into a next-workflow seed artifact", async () => {
    const artifacts = createMemoryArtifactStore("dream-hitl-seed-node");
    const decisionWrite = await artifacts.writeJson({
      path: "report/hitl-decision.json",
      redacted: true,
      runId: machine.runId,
      value: decisionDocument,
    });
    const adapter = createMemoryFabricWorkflowNodeAdapter({
      artifacts,
      memoryCapture: createIntegrationTestMemoryFabricAdapter(),
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

    const seed = MemoryHitlDecisionWorkflowSeedDocumentSchema.parse(
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
      schemaVersion: "memory.hitl-decision-workflow-seed.v1",
      status: "ready",
      workItemDecisionIds: ["decision:dream:capture-ingest-fix"],
    });
  });

  it("derives a generated draft seed from the report when no human decision artifact exists", async () => {
    const artifacts = createMemoryArtifactStore("dream-hitl-generated-draft");
    const refinementStep = {
      config: {},
      dependsOn: [],
      inputRefs: [],
      kind: "workflow.node.invoke",
      nodeType: WorkflowNodeTypeSchema.parse(
        "joelclaw.memory.refinement-proposals"
      ),
      outputPath: "dream/refinement-proposals.json",
      packageRefs: ["artifact://packages/workflows/memory-fabric/refs/v1"],
      stepId: "propose-dream-refinements",
      summary: "Propose source-backed Dream refinements.",
    } satisfies WorkflowNodeInvocationStep;
    const reportStep = {
      config: {},
      dependsOn: [refinementStep.stepId],
      inputRefs: [],
      kind: "workflow.node.invoke",
      nodeType: WorkflowNodeTypeSchema.parse("joelclaw.memory.hitl-report"),
      outputPath: "report/hitl-report.mdsvx",
      packageRefs: ["artifact://packages/workflows/memory-fabric/refs/v1"],
      stepId: "render-memory-hitl-report",
      summary: "Render the Dream HITL report.",
    } satisfies WorkflowNodeInvocationStep;
    const generatedSeedStep = {
      ...step,
      config: {
        decisionRef: artifacts.artifactRef({
          path: "report/hitl-decision.json",
          runId: machine.runId,
        }),
      },
      dependsOn: [reportStep.stepId],
      inputRefs: [],
    } satisfies WorkflowNodeInvocationStep;
    const generatedPlan = {
      ...plan,
      steps: [refinementStep, reportStep, generatedSeedStep],
    } satisfies DynamicWorkflowPlanDocument;
    const refinementWrite = await artifacts.writeJson({
      path: refinementStep.outputPath,
      redacted: true,
      runId: machine.runId,
      value: refinementProposalDocument,
    });
    const reportJsonWrite = await artifacts.writeJson({
      path: "report/hitl-report.json",
      redacted: true,
      runId: machine.runId,
      value: reportDocument,
    });
    const reportMdsvxWrite = await artifacts.writeText({
      mediaType: "text/mdsvx",
      path: reportStep.outputPath,
      redacted: true,
      runId: machine.runId,
      value: reportDocument.mdsvx,
    });
    const adapter = createMemoryFabricWorkflowNodeAdapter({
      artifacts,
      memoryCapture: createIntegrationTestMemoryFabricAdapter(),
    });

    const seedResult = await adapter.execute({
      actor: integrationTestActor,
      completedStepArtifactRefs: {
        [refinementStep.stepId]: refinementWrite.artifactRef,
        [reportStep.stepId]: reportMdsvxWrite.artifactRef,
      },
      dependencyArtifactRefs: {
        [reportStep.stepId]: reportMdsvxWrite.artifactRef,
      },
      machine,
      plan: generatedPlan,
      step: {
        ...generatedSeedStep,
        inputRefs: [reportMdsvxWrite.artifactRef],
      },
    });
    if (seedResult.status === "blocked") {
      throw new Error(seedResult.blocker.message);
    }
    const seedRef = seedResult.outputRefs.at(0);
    const draftDecisionRef = seedResult.outputRefs.at(1);
    if (seedRef === undefined || draftDecisionRef === undefined) {
      throw new Error("Expected seed and generated draft decision refs.");
    }

    const seed = MemoryHitlDecisionWorkflowSeedDocumentSchema.parse(
      await artifacts.readJson({ artifactRef: seedRef })
    );
    const draftDecision = MemoryHitlDecisionDocumentSchema.parse(
      await artifacts.readJson({ artifactRef: draftDecisionRef })
    );
    const followUpResult = await adapter.execute({
      actor: integrationTestActor,
      completedStepArtifactRefs: {
        [generatedSeedStep.stepId]: seedRef,
      },
      dependencyArtifactRefs: {},
      machine,
      plan: generatedPlan,
      step: {
        ...followUpStep,
        inputRefs: [],
      },
    });
    if (followUpResult.status === "blocked") {
      throw new Error(followUpResult.blocker.message);
    }
    const followUpRef = followUpResult.outputRefs.at(0);
    if (followUpRef === undefined) {
      throw new Error("Expected follow-up run request ref.");
    }
    const followUp = MemoryHitlFollowUpRunRequestDocumentSchema.parse(
      await artifacts.readJson({ artifactRef: followUpRef })
    );

    expect({
      acceptedDecisionIds: seed.acceptedDecisionIds,
      actionableDecisionCount: seed.actionableDecisionCount,
      decisionRef: seed.decisionRef,
      decisionSource: seed.decisionSource,
      draftDecisionCount: draftDecision.decisionCount,
      draftDecisionReviewerType: draftDecision.reviewer.type,
      draftRecommendationMarksDraft:
        draftDecision.decisions
          .at(0)
          ?.recommendation.includes("DRAFT, not human-approved") ?? false,
      draftReportRef: draftDecision.reportRef,
      followUpMentionsGeneratedDraft:
        followUp.request?.planProposal.stochasticNotes.some((note) =>
          note.includes("generated draft")
        ) ?? false,
      followUpStatus: followUp.status,
      outputRefs: seedResult.outputRefs,
      submitted: followUp.submitted,
      workItemDecisionIds: seed.workItemDecisionIds,
    }).toStrictEqual({
      acceptedDecisionIds: [
        "decision:draft:proposal-kernel-memory-generated-machine",
      ],
      actionableDecisionCount: 2,
      decisionRef: draftDecisionRef,
      decisionSource: "generated-draft",
      draftDecisionCount: 2,
      draftDecisionReviewerType: "agent",
      draftRecommendationMarksDraft: true,
      draftReportRef: reportJsonWrite.artifactRef,
      followUpMentionsGeneratedDraft: true,
      followUpStatus: "drafted",
      outputRefs: [
        "artifact://dream-hitl-generated-draft/runs/run-dream-hitl-seed-test/report/hitl-decision-workflow-seed.json",
        "artifact://dream-hitl-generated-draft/runs/run-dream-hitl-seed-test/report/hitl-decision-workflow-seed.generated-draft-decision.json",
      ],
      submitted: false,
      workItemDecisionIds: [
        "decision:draft:proposal-capture-ingest-fix-runtime-capt",
      ],
    });
  });

  it("drafts a follow-up run request from the HITL workflow seed without submitting it", async () => {
    const artifacts = createMemoryArtifactStore("memory-hitl-follow-up-node");
    const seedDocument = MemoryHitlDecisionWorkflowSeedDocumentSchema.parse({
      acceptedDecisionIds: ["decision:dream:generated-machine-proof"],
      actionableDecisionCount: 2,
      actionableDecisions: decisionDocument.decisions,
      decisionRef: "artifact://dream-hitl-seed-test/report/hitl-decision.json",
      generatedAt: at,
      heldDecisionIds: [],
      nextWorkflowSeed: decisionDocument.nextWorkflowSeed,
      redacted: true,
      refinementProposalRef:
        "artifact://dream-hitl-seed-test/dream/refinement-proposals.json",
      rejectedDecisionIds: [],
      reportRef: decisionDocument.reportRef,
      runId: machine.runId,
      schemaVersion: "memory.hitl-decision-workflow-seed.v1",
      sourceRefs: [
        "artifact://dream-hitl-seed-test/report/hitl-decision.json",
        "artifact://dream-hitl-seed-test/report/hitl-report.json",
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
      path: "report/hitl-decision-workflow-seed.json",
      redacted: true,
      runId: machine.runId,
      value: seedDocument,
    });
    const adapter = createMemoryFabricWorkflowNodeAdapter({
      artifacts,
      memoryCapture: createIntegrationTestMemoryFabricAdapter(),
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

    const followUp = MemoryHitlFollowUpRunRequestDocumentSchema.parse(
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
      requestRunId: "run-memory-hitl-follow-up-test",
      requestWorkItemId: "work-item:memory-hitl-follow-up-test",
      requestedPackageIds: [
        "workflow/memory-fabric",
        "badass-courses/claw-kernel",
      ],
      schemaVersion: "memory.hitl-follow-up-run-request.v1",
      status: "drafted",
      submitted: false,
      usesPlannerInstruction: true,
    });
  });

  it("ignores non-seed follow-up input refs and falls back to the completed HITL seed step", async () => {
    const artifacts = createMemoryArtifactStore(
      "memory-hitl-follow-up-upstream-seed"
    );
    const seedDocument = MemoryHitlDecisionWorkflowSeedDocumentSchema.parse({
      acceptedDecisionIds: ["decision:dream:generated-machine-proof"],
      actionableDecisionCount: 2,
      actionableDecisions: decisionDocument.decisions,
      decisionRef: "artifact://dream-hitl-seed-test/report/hitl-decision.json",
      generatedAt: at,
      heldDecisionIds: [],
      nextWorkflowSeed: decisionDocument.nextWorkflowSeed,
      redacted: true,
      refinementProposalRef:
        "artifact://dream-hitl-seed-test/dream/refinement-proposals.json",
      rejectedDecisionIds: [],
      reportRef: decisionDocument.reportRef,
      runId: machine.runId,
      schemaVersion: "memory.hitl-decision-workflow-seed.v1",
      sourceRefs: [
        "artifact://dream-hitl-seed-test/report/hitl-decision.json",
        "artifact://dream-hitl-seed-test/report/hitl-report.json",
      ],
      status: "ready",
      summary:
        "HITL accepted one Dream decision and turned one decision into work.",
      workItemDecisionIds: ["decision:dream:capture-ingest-fix"],
      workItemId: machine.workItemId,
    });
    const seedWrite = await artifacts.writeJson({
      path: "report/hitl-decision-workflow-seed.json",
      redacted: true,
      runId: machine.runId,
      value: seedDocument,
    });
    const adapter = createMemoryFabricWorkflowNodeAdapter({
      artifacts,
      memoryCapture: createIntegrationTestMemoryFabricAdapter(),
    });
    const result = await adapter.execute({
      actor: integrationTestActor,
      completedStepArtifactRefs: {
        [step.stepId]: seedWrite.artifactRef,
      },
      dependencyArtifactRefs: {},
      machine,
      plan,
      step: {
        ...followUpStep,
        inputRefs: [
          "artifact://dream-hitl-seed-test/runs/run-dream-hitl-seed-test/report/hitl-report.mdsvx",
        ],
      },
    });
    if (result.status === "blocked") {
      throw new Error(result.blocker.message);
    }

    const requestRef = result.outputRefs.at(0);
    if (requestRef === undefined) {
      throw new Error("Expected HITL follow-up run request output ref.");
    }
    const followUp = MemoryHitlFollowUpRunRequestDocumentSchema.parse(
      await artifacts.readJson({ artifactRef: requestRef })
    );

    expect({
      decisionWorkflowSeedRef: followUp.decisionWorkflowSeedRef,
      requestRunId: followUp.request?.runId,
      schemaVersion: followUp.schemaVersion,
      status: followUp.status,
    }).toStrictEqual({
      decisionWorkflowSeedRef: seedWrite.artifactRef,
      requestRunId: "run-memory-hitl-follow-up-test",
      schemaVersion: "memory.hitl-follow-up-run-request.v1",
      status: "drafted",
    });
  });
});
