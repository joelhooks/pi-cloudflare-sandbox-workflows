import { describe, expect, it } from "vitest";

import type { WorkflowNodeAdapterPort } from "../../src/app/application/ports.ts";
import { WorkflowApp } from "../../src/app/application/workflow-app.ts";
import { hashJson, sha256Hex } from "../../src/app/domain/hash.ts";
import {
  AgentLaneReceiptSchema,
  DiscordDeliveryResultSchema,
  DiscordMessageApprovalSchema,
  DynamicWorkflowBlueprintSchema,
  DynamicWorkflowMachineDocumentSchema,
  DynamicWorkflowPlanDocumentSchema,
  DynamicWorkflowStepSchema,
  ArtifactRefSchema,
  GitHubBranchCommitDeliveryResultSchema,
  GitHubBranchCommitPayloadSchema,
  GitHubPullRequestDeliveryResultSchema,
  GitHubPullRequestPayloadSchema,
  LinearCommentDeliveryResultSchema,
  LinearCommentPayloadSchema,
  WorkflowObservabilityPackSchema,
  WorkflowCartridgeInvocationProofDocumentSchema,
  WorkflowExecutionProofDocumentSchema,
  ReviewSurfaceDocumentSchema,
  VerificationContractDocumentSchema,
  VerificationResultDocumentSchema,
  WzrrdPublishApprovalSchema,
  WzrrdPublishDeliveryResultSchema,
  WzrrdPublishPayloadSchema,
} from "../../src/app/domain/schemas.ts";
import type {
  AgentLaneReceipt,
  ArtifactRef,
  DynamicWorkflowBlueprint,
  DynamicWorkflowStep,
} from "../../src/app/domain/schemas.ts";
import { createCloudflareArtifactsObservabilityRecorder } from "../../src/app/infrastructure/cloudflare-artifacts-observability-recorder.ts";
import { createCloudflareArtifactsReviewSurfacePublisher } from "../../src/app/infrastructure/cloudflare-artifacts-review-surface.ts";
import { createArtifactEvidenceDeterministicVerifier } from "../../src/app/infrastructure/deterministic-verifier.ts";
import {
  createDryRunDiscordMessageAdapter,
  createDryRunGitHubBranchCommitAdapter,
  createDryRunGitHubPullRequestAdapter,
  createDryRunLinearCommentAdapter,
  createDryRunWzrrdPublishAdapter,
  createIntegrationTestDynamicWorkflowPlanner,
  createMemoryArtifactStore,
  createMemoryContextCapsuleActor,
  createMemoryPackageRegistryActor,
  createMemoryReviewGateActor,
  createMemoryWorkflowStatusProjectionStore,
  createPolicyCapabilityLeaseBroker,
} from "../../src/app/infrastructure/memory-adapters.ts";
import { createArtifactBackedWorkflowCartridgeAdapter } from "../../src/app/workflow-nodes/artifact-backed-cartridge-adapter.ts";
import {
  createDreamGeneratedWorkflowProofRecorder,
  verifyDreamGeneratedWorkflow,
} from "../../src/cartridges/dream-memory-fabric/generated-workflow-proof.ts";
import {
  createIntegrationTestDreamMemoryCorrelationAdapter,
  createIntegrationTestDreamMemoryFabricAdapter,
  createIntegrationTestDreamMemoryRetrievalAdapter,
} from "../../src/cartridges/dream-memory-fabric/integration-test-adapters.ts";
import {
  DreamBackfillPlanDocumentSchema,
  DreamBackfillRunReceiptDocumentSchema,
  DreamCaptureReceiptDocumentSchema,
  DreamCorrelationGraphDocumentSchema,
  DreamGeneratedWorkflowProofDocumentSchema,
  DreamHitlDecisionDocumentSchema,
  DreamHitlDecisionWorkflowSeedDocumentSchema,
  DreamHitlFollowUpRunRequestDocumentSchema,
  DreamHitlReportDocumentSchema,
  DreamHydrationDocumentSchema,
  DreamMemorySearchDocumentSchema,
  DreamRefinementProposalDocumentSchema,
  DreamSignalDocumentSchema,
  DreamSourceHealthDocumentSchema,
  DreamSourceInventoryDocumentSchema,
  DreamSourcePackDispositionSchema,
} from "../../src/cartridges/dream-memory-fabric/schemas.ts";
import { dreamTranscriptReviewSourceProfile } from "../../src/cartridges/dream-memory-fabric/source-profile.ts";
import { createDreamMemoryFabricWorkflowNodeAdapter } from "../../src/cartridges/dream-memory-fabric/workflow-node-adapter.ts";
import {
  buildIntegrationTestDreamRunRequest,
  buildIntegrationTestRunRequest,
  integrationTestDreamWorkflowPackageMetadata,
  integrationTestPackageMetadata,
} from "./workflow-app-fixtures.ts";

const dreamWorkflowPackageRef =
  integrationTestDreamWorkflowPackageMetadata.latestArtifactRef;

const dreamIntegrationPackages = [
  ...integrationTestPackageMetadata,
  integrationTestDreamWorkflowPackageMetadata,
];

const requireArtifactRef = (
  name: string,
  artifactRef: ArtifactRef | undefined
): ArtifactRef => {
  if (artifactRef === undefined) {
    throw new Error(`Expected artifact ref: ${name}.`);
  }

  return ArtifactRefSchema.parse(artifactRef);
};

const requireArtifactRefList = (
  name: string,
  refs: readonly (ArtifactRef | undefined)[]
): readonly ArtifactRef[] =>
  refs.map((artifactRef, index) =>
    requireArtifactRef(`${name}:${index}`, artifactRef)
  );

const withTokenCostAccountingFixture = (
  receipt: AgentLaneReceipt,
  index: number
): AgentLaneReceipt => {
  const inputTokens = 1000 + index * 100;
  const outputTokens = 200 + index * 10;

  return AgentLaneReceiptSchema.parse({
    ...receipt,
    tokenCostAccounting: {
      costEstimate: index + 1,
      currency: "USD",
      inputTokens,
      outputTokens,
      redacted: true,
      source: "integration-test-fixture",
      tokenCount: inputTokens + outputTokens,
    },
  });
};

const runWorkflow = async (
  options: { readonly tokenCostAccountingFixture?: boolean } = {}
) => {
  const artifacts = createMemoryArtifactStore("workflow-app-integration");
  const artifactObservabilityRecorder =
    createCloudflareArtifactsObservabilityRecorder({
      artifacts,
      now: () => "2026-06-08T23:59:30.000Z",
    });
  const statusProjection = createMemoryWorkflowStatusProjectionStore();
  const observabilityCaptureCalls: {
    readonly runId: string;
    readonly workerLaneCount: number;
  }[] = [];
  const workflow = new WorkflowApp({
    artifacts,
    capabilityLeases: createPolicyCapabilityLeaseBroker(artifacts, {
      discordSecretRef: "secretref:discord-bot",
      policyId: "discord-message-policy",
    }),
    contextCapsules: createMemoryContextCapsuleActor(),
    discordMessages: createDryRunDiscordMessageAdapter(),
    discordSecretRefs: {
      dryRun: "secretref:discord-dry-run",
      send: "secretref:discord-bot",
    },
    dynamicWorkflowPlanner: createIntegrationTestDynamicWorkflowPlanner(),
    executionMode: "integration-test",
    observabilityRecorder: {
      async capturePack(input) {
        observabilityCaptureCalls.push({
          runId: input.plan.runId,
          workerLaneCount: input.workerLaneReceipts.length,
        });

        return await artifactObservabilityRecorder.capturePack(
          options.tokenCostAccountingFixture === true
            ? {
                ...input,
                plannerLaneReceipt: withTokenCostAccountingFixture(
                  input.plannerLaneReceipt,
                  0
                ),
                workerLaneReceipts: input.workerLaneReceipts.map(
                  (receipt, index) =>
                    withTokenCostAccountingFixture(receipt, index + 1)
                ),
              }
            : input
        );
      },
    },
    packageRegistry: createMemoryPackageRegistryActor(
      integrationTestPackageMetadata
    ),
    reviewGate: createMemoryReviewGateActor(artifacts),
    reviewSurfacePublisher: createCloudflareArtifactsReviewSurfacePublisher({
      artifacts,
      now: () => "2026-06-08T23:59:00.000Z",
    }),
    statusProjection,
    wzrrdPublisher: createDryRunWzrrdPublishAdapter(),
    wzrrdSecretRefs: {
      dryRun: "secretref:wzrrd-dry-run",
      publish: "secretref:wzrrd-api",
    },
    wzrrdSiteRef: "wzrrd:test",
  });

  const result = await workflow.run(buildIntegrationTestRunRequest());

  if (result.status !== "captured") {
    throw new Error(result.blocker.message);
  }

  return { artifacts, observabilityCaptureCalls, result, statusProjection };
};

const safeStateName = (value: string): string =>
  value.replaceAll(/[^A-Za-z0-9_]/gu, "_");

const generatedStepStateName = (index: number, stepId: string): string =>
  `step_${index}_${safeStateName(stepId)}`;

const machineStatesFor = (steps: readonly DynamicWorkflowStep[]) => {
  const states: Record<
    string,
    {
      readonly meta: {
        readonly stepId?: string;
        readonly stepKind?: string;
        readonly summary?: string;
      };
      readonly on: Record<string, { readonly target: string }>;
      readonly type?: "final";
    }
  > = {
    ready: {
      meta: {
        summary: "Generated dynamic workflow is ready to execute.",
      },
      on: {
        NEXT: {
          target: generatedStepStateName(0, steps[0]?.stepId ?? "missing"),
        },
      },
    },
  };

  for (const [index, step] of steps.entries()) {
    const nextStep = steps.at(index + 1);
    states[generatedStepStateName(index, step.stepId)] = {
      meta: {
        stepId: step.stepId,
        stepKind: step.kind,
        summary: step.summary,
      },
      on: {
        STEP_BLOCKED: {
          target: "blocked",
        },
        STEP_DONE: {
          target:
            nextStep === undefined
              ? "done"
              : generatedStepStateName(index + 1, nextStep.stepId),
        },
      },
    };
  }

  states["blocked"] = {
    meta: {
      summary: "Generated dynamic workflow blocked.",
    },
    on: {},
    type: "final",
  };
  states["done"] = {
    meta: {
      summary: "Generated dynamic workflow completed.",
    },
    on: {},
    type: "final",
  };

  return states;
};

const addDreamPreflightToBlueprint = (
  blueprint: DynamicWorkflowBlueprint,
  options: {
    readonly hitlDecisionInputRef?: ArtifactRef;
  } = {}
): DynamicWorkflowBlueprint => {
  const dreamCoverageHorizons = [
    ...dreamTranscriptReviewSourceProfile.timeHorizons,
  ];
  const dreamSourcePackDispositions =
    dreamTranscriptReviewSourceProfile.sourcePacks.map((pack) => {
      let capabilityKinds: string[] = [];
      let missingCapabilityKinds = [...pack.requiredCapabilityKinds];
      let status = "skipped-missing-lease";
      let reason =
        "Skipped until scoped source-pack leases are available for this generated run.";
      if (pack.selectionPolicy === "default") {
        capabilityKinds = [...pack.requiredCapabilityKinds];
        missingCapabilityKinds = [];
        status = "selected-by-default";
        reason = "Selected by the installed Dream source profile.";
      } else if (pack.selectionPolicy === "separate-workflow") {
        missingCapabilityKinds = [];
        status = "separate-workflow-candidate";
        reason =
          "Saved as a separate workflow candidate so support/comms surfaces do not alter transcript-review Dream readiness.";
      }

      return {
        capabilityKinds,
        leaseRefs: [],
        missingCapabilityKinds,
        packId: pack.packId,
        packageId: pack.packageId,
        reason,
        requiredCapabilityKinds: [...pack.requiredCapabilityKinds],
        selectionPolicy: pack.selectionPolicy,
        sourceFamilies: [...pack.sourceFamilies],
        status,
        surfaces: [...pack.surfaces],
      };
    });
  const inventoryStep = DynamicWorkflowStepSchema.parse({
    config: {
      dreamSourcePackDispositions,
      requiredMachineIds: [
        ...dreamTranscriptReviewSourceProfile.requiredMachineIds,
      ],
      requiredRuntimes: ["pi", "codex", "claude", "cloudflare"],
      sourceFamiliesExpected: [
        "agent-transcripts",
        "brain",
        "cloudflare-runs",
        "docs-pdf-brain",
        "repo-outputs",
      ],
    },
    dependsOn: [],
    kind: "workflow.node.invoke",
    nodeType: "joelclaw.dream.source-inventory",
    outputPath: "dream/source-inventory.json",
    packageRefs: [dreamWorkflowPackageRef],
    stepId: "inventory-memory-fabric",
    summary: "Inventory memory fabric sources before retrieval lanes run.",
  });
  const healthStep = DynamicWorkflowStepSchema.parse({
    config: {
      inventoryStepId: inventoryStep.stepId,
    },
    dependsOn: [inventoryStep.stepId],
    kind: "workflow.node.invoke",
    nodeType: "joelclaw.dream.source-health",
    outputPath: "dream/source-health.json",
    packageRefs: [dreamWorkflowPackageRef],
    stepId: "check-source-health",
    summary: "Check Dream source freshness and derived index health.",
  });
  const backfillStep = DynamicWorkflowStepSchema.parse({
    config: {
      healthStepId: healthStep.stepId,
      inventoryStepId: inventoryStep.stepId,
    },
    dependsOn: [inventoryStep.stepId, healthStep.stepId],
    kind: "workflow.node.invoke",
    nodeType: "joelclaw.dream.backfill-plan",
    outputPath: "dream/backfill-plan.json",
    packageRefs: [dreamWorkflowPackageRef],
    stepId: "plan-recovery-backfills",
    summary: "Plan recovery backfills for missing or stale Dream sources.",
  });
  const backfillRunStep = DynamicWorkflowStepSchema.parse({
    config: {
      planStepId: backfillStep.stepId,
    },
    dependsOn: [backfillStep.stepId],
    kind: "workflow.node.invoke",
    nodeType: "joelclaw.dream.backfill-run",
    outputPath: "dream/backfill-run-receipt.json",
    packageRefs: [dreamWorkflowPackageRef],
    stepId: "run-recovery-backfills",
    summary:
      "Execute recovery backfill through the trusted relay and emit an honest receipt.",
  });
  const captureRunStep = DynamicWorkflowStepSchema.parse({
    config: {
      sourceFamilies: ["agent-transcripts", "cloudflare-runs"],
      sourceSystem: "cloudflare-workflow-run",
    },
    dependsOn: [backfillRunStep.stepId],
    kind: "workflow.node.invoke",
    nodeType: "joelclaw.dream.capture-run",
    outputPath: "dream/capture-run.json",
    packageRefs: [dreamWorkflowPackageRef],
    stepId: "capture-dream-run",
    summary:
      "Capture a redacted run receipt through the trusted Dream memory relay.",
  });
  const signalsStep = DynamicWorkflowStepSchema.parse({
    config: {
      dreamCoverageHorizons,
      maxSignals: 3,
      query: "dynamic workflow proof across Codex Cloudflare Brain",
      sourceFamilies: ["agent-transcripts", "brain", "cloudflare-runs"],
    },
    dependsOn: [backfillRunStep.stepId, captureRunStep.stepId],
    kind: "workflow.node.invoke",
    nodeType: "joelclaw.dream.signals",
    outputPath: "dream/signals.json",
    packageRefs: [dreamWorkflowPackageRef],
    stepId: "mine-dream-signals",
    summary:
      "Mine redacted Dream signals before search and proposal synthesis.",
  });
  const searchStep = DynamicWorkflowStepSchema.parse({
    config: {
      dreamCoverageHorizons,
      maxHits: 3,
      query: "dynamic workflow proof across Codex Cloudflare Brain",
      sourceFamilies: ["agent-transcripts", "brain", "cloudflare-runs"],
    },
    dependsOn: [backfillRunStep.stepId, signalsStep.stepId],
    kind: "workflow.node.invoke",
    nodeType: "joelclaw.dream.memory-search",
    outputPath: "dream/memory-search.json",
    packageRefs: [dreamWorkflowPackageRef],
    stepId: "search-dream-memory",
    summary:
      "Search the Dream memory fabric across the selected source families.",
  });
  const hydrateStep = DynamicWorkflowStepSchema.parse({
    config: {
      maxReceipts: 2,
      searchStepId: searchStep.stepId,
    },
    dependsOn: [searchStep.stepId],
    kind: "workflow.node.invoke",
    nodeType: "joelclaw.dream.hydrate",
    outputPath: "dream/hydration.json",
    packageRefs: [dreamWorkflowPackageRef],
    stepId: "hydrate-dream-evidence",
    summary: "Hydrate redacted receipts from Dream memory search.",
  });
  const correlationStep = DynamicWorkflowStepSchema.parse({
    config: {
      hydrationStepId: hydrateStep.stepId,
      searchStepId: searchStep.stepId,
    },
    dependsOn: [searchStep.stepId, hydrateStep.stepId],
    kind: "workflow.node.invoke",
    nodeType: "joelclaw.dream.correlate",
    outputPath: "dream/correlation-graph.json",
    packageRefs: [dreamWorkflowPackageRef],
    stepId: "correlate-dream-evidence",
    summary:
      "Correlate near-term and far-term Dream evidence into a graph artifact.",
  });
  const refinementStep = DynamicWorkflowStepSchema.parse({
    config: {
      backfillRunStepId: backfillRunStep.stepId,
      correlationStepId: correlationStep.stepId,
      healthStepId: healthStep.stepId,
      hydrationStepId: hydrateStep.stepId,
      inventoryStepId: inventoryStep.stepId,
      maxProposals: 7,
      searchStepId: searchStep.stepId,
      signalsStepId: signalsStep.stepId,
    },
    dependsOn: [
      inventoryStep.stepId,
      healthStep.stepId,
      backfillRunStep.stepId,
      signalsStep.stepId,
      searchStep.stepId,
      hydrateStep.stepId,
      correlationStep.stepId,
    ],
    kind: "workflow.node.invoke",
    nodeType: "joelclaw.dream.refinement-proposals",
    outputPath: "dream/refinement-proposals.json",
    packageRefs: [dreamWorkflowPackageRef],
    stepId: "propose-dream-refinements",
    summary:
      "Turn Dream evidence into kernel, package, workflow, schema, and capture refinement proposals.",
  });
  const reportStep = DynamicWorkflowStepSchema.parse({
    config: {
      backfillPlanStepId: backfillStep.stepId,
      backfillRunStepId: backfillRunStep.stepId,
      correlationStepId: correlationStep.stepId,
      dynamicGenerationProofLevel: "generated-machine",
      healthStepId: healthStep.stepId,
      hydrationStepId: hydrateStep.stepId,
      inventoryStepId: inventoryStep.stepId,
      refinementProposalStepId: refinementStep.stepId,
      searchStepId: searchStep.stepId,
      title: "This dream found work to do.",
    },
    dependsOn: [
      inventoryStep.stepId,
      healthStep.stepId,
      backfillStep.stepId,
      backfillRunStep.stepId,
      searchStep.stepId,
      hydrateStep.stepId,
      correlationStep.stepId,
      refinementStep.stepId,
    ],
    kind: "workflow.node.invoke",
    nodeType: "joelclaw.dream.hitl-report",
    outputPath: "dream/hitl-report.json",
    packageRefs: [dreamWorkflowPackageRef],
    stepId: "render-dream-hitl-report",
    summary: "Render the canonical Dream HITL report artifact.",
  });
  const hitlDecisionSeedStep = DynamicWorkflowStepSchema.parse({
    config: {},
    dependsOn: [reportStep.stepId],
    inputRefs:
      options.hitlDecisionInputRef === undefined
        ? []
        : [options.hitlDecisionInputRef],
    kind: "workflow.node.invoke",
    nodeType: "joelclaw.dream.hitl-decision-seed",
    outputPath: "dream/hitl-decision-workflow-seed.json",
    packageRefs: [dreamWorkflowPackageRef],
    stepId: "seed-next-workflow-from-hitl",
    summary:
      "Turn the redacted human Dream HITL decision artifact into a next-workflow seed.",
  });
  const hitlFollowUpStep = DynamicWorkflowStepSchema.parse({
    config: {
      requestedPackageIds: [
        "badass-courses/claw-kernel",
        "joelhooks/configured-familiar-kernel",
        "workflow/dream-memory-fabric",
      ],
      seedStepId: hitlDecisionSeedStep.stepId,
    },
    dependsOn: [hitlDecisionSeedStep.stepId],
    kind: "workflow.node.invoke",
    nodeType: "joelclaw.dream.hitl-follow-up-run-request",
    outputPath: "dream/hitl-follow-up-run-request.json",
    packageRefs: [dreamWorkflowPackageRef],
    stepId: "draft-follow-up-run-request-from-hitl",
    summary:
      "Draft the next generated workflow request from accepted Dream HITL decisions without submitting it.",
  });
  const captureArtifactStep = DynamicWorkflowStepSchema.parse({
    config: {
      artifactStepId: reportStep.stepId,
      mediaType: "application/json",
      sourceFamilies: ["repo-outputs", "cloudflare-runs"],
      sourceSystem: "cloudflare-artifacts",
    },
    dependsOn: [reportStep.stepId],
    kind: "workflow.node.invoke",
    nodeType: "joelclaw.dream.capture-artifact",
    outputPath: "dream/capture-artifact.json",
    packageRefs: [dreamWorkflowPackageRef],
    stepId: "capture-dream-report-artifact",
    summary:
      "Capture the generated Dream HITL report artifact as memory fabric input.",
  });
  const steps: DynamicWorkflowStep[] = [
    inventoryStep,
    healthStep,
    backfillStep,
    backfillRunStep,
    captureRunStep,
    signalsStep,
    searchStep,
    hydrateStep,
    correlationStep,
    refinementStep,
    reportStep,
    hitlDecisionSeedStep,
    hitlFollowUpStep,
    captureArtifactStep,
  ];

  return DynamicWorkflowBlueprintSchema.parse({
    ...blueprint,
    machine: {
      ...blueprint.machine,
      stepOrder: steps.map((step) => step.stepId),
      xstate: {
        id: blueprint.machine.machineId,
        initial: "ready",
        states: machineStatesFor(steps),
      },
    },
    plan: {
      ...blueprint.plan,
      outputTarget: {
        kind: "wzrrd",
        primaryDocument: {
          artifactPath: "dream/hitl-report.mdsvx",
          mediaType: "text/mdsvx",
          publishPath: "report.mdsvx",
          template: {
            defaultExpiresIn: "24h",
            format: "mdsvx",
            noindex: true,
            rendererId: "joel/static-tufte-mdsvx-preview@0.1.0",
            templateId: "joel/tufte-mdsvx",
            version: "0.1.0",
          },
          title: "This dream found work to do.",
        },
        reviewPath: "review/summary.json",
      },
      steps,
    },
  });
};

const integrationTestDreamHitlDecisionDocument = (input: {
  readonly backfillRunRef: ArtifactRef;
  readonly refinementProposalRef: ArtifactRef;
  readonly reportRef: ArtifactRef;
  readonly runId: string;
  readonly workItemId: string;
}) =>
  DreamHitlDecisionDocumentSchema.parse({
    decisionCount: 2,
    decisions: [
      {
        decision: "accept",
        decisionId: "decision:dream:generated-machine-proof",
        rating: 9,
        reasoning:
          "The Dream report has enough generated-machine proof to promote this as a durable workflow constraint.",
        recommendation:
          "Capture the generated-machine proof requirement in Brain/package workflow constraints.",
        reviewedAt: "2026-06-09T21:20:00.000Z",
        sourceRefs: [input.reportRef, input.refinementProposalRef],
        summary:
          "Generated-machine proof should be required for Dream follow-up work.",
        targetId: "proposal:dynamic-workflow-pattern:generated-machine-proof",
        targetKind: "refinement-proposal",
        targetTitle: "Require generated-machine proof for Dream work",
      },
      {
        decision: "turn-into-work",
        decisionId: "decision:dream:capture-ingest-fix",
        rating: 10,
        reasoning:
          "Recovery backfill is useful, but recurring backfill means ingest is still broken and needs follow-up work.",
        recommendation:
          "Draft a generated workflow request that turns the capture-ingest repair into reviewed Brain/package/workflow updates.",
        reviewedAt: "2026-06-09T21:20:00.000Z",
        sourceRefs: [input.backfillRunRef, input.refinementProposalRef],
        summary:
          "Turn the Dream capture/backfill gap into a follow-up workflow.",
        targetId: "proposal:capture-ingest-fix:runtime-capture",
        targetKind: "refinement-proposal",
        targetTitle: "Repair Dream capture ingest",
      },
    ],
    generatedAt: "2026-06-09T21:20:00.000Z",
    nextWorkflowSeed: {
      artifactUpdateTargets: [
        {
          sourceRefs: [input.reportRef],
          summary:
            "Update Brain with the generated-machine proof requirement for Dream follow-up work.",
          targetKind: "brain",
        },
        {
          sourceRefs: [input.backfillRunRef, input.refinementProposalRef],
          summary:
            "Turn capture-ingest repair into package/workflow update artifacts.",
          targetKind: "workflow",
        },
      ],
      decisionIds: [
        "decision:dream:generated-machine-proof",
        "decision:dream:capture-ingest-fix",
      ],
      plannerInstructions: [
        "Treat accepted Dream HITL decisions as constraints for the next generated workflow.",
        "Turn work-conversion decisions into explicit package, Brain, schema, or workflow artifact updates.",
        "Keep follow-up execution as generated workflow artifacts until side-effect capability leases are reviewed.",
      ],
      requiredCapabilityKinds: ["brain.update.review"],
      sourceRefs: [
        input.reportRef,
        input.backfillRunRef,
        input.refinementProposalRef,
      ],
    },
    redacted: true,
    refinementProposalRef: input.refinementProposalRef,
    reportRef: input.reportRef,
    reviewer: {
      id: "actor:joel",
      organizationId: "org:joelhooks",
      roleIds: ["dream.reviewer"],
      sessionId: "session:dream-hitl-review",
      trustTier: "manual",
      type: "human",
    },
    runId: input.runId,
    schemaVersion: "dream.hitl-decision.v1",
    sourceRefs: [
      input.reportRef,
      input.backfillRunRef,
      input.refinementProposalRef,
    ],
    workItemId: input.workItemId,
  });

const addWorkflowNodeToBlueprint = (
  blueprint: DynamicWorkflowBlueprint
): DynamicWorkflowBlueprint => {
  const researchStep = blueprint.plan.steps.at(0);
  const notifyStep = blueprint.plan.steps.at(1);
  const reviewStep = blueprint.plan.steps.at(2);
  if (
    researchStep === undefined ||
    notifyStep === undefined ||
    reviewStep === undefined
  ) {
    throw new Error("Fixture planner returned too few steps.");
  }

  const nodeStep = DynamicWorkflowStepSchema.parse({
    config: {
      reportStyle: "tufte-smoke",
    },
    dependsOn: [],
    inputRefs: [],
    kind: "workflow.node.invoke",
    nodeType: "com.joelclaw.integration-fixture",
    outputPath: "nodes/integration-fixture-output.json",
    packageRefs: [
      "artifact://packages/workflows/research-review-discord/refs/v1",
    ],
    stepId: "invoke-integration-node",
    summary: "Invoke a package-provided workflow node.",
  });
  const steps: DynamicWorkflowStep[] = [
    nodeStep,
    {
      ...researchStep,
      dependsOn: [nodeStep.stepId],
    },
    {
      ...notifyStep,
      dependsOn: [researchStep.stepId],
    },
    {
      ...reviewStep,
      dependsOn: [researchStep.stepId, notifyStep.stepId],
    },
  ];

  return DynamicWorkflowBlueprintSchema.parse({
    ...blueprint,
    machine: {
      ...blueprint.machine,
      stepOrder: steps.map((step) => step.stepId),
      xstate: {
        id: blueprint.machine.machineId,
        initial: "ready",
        states: machineStatesFor(steps),
      },
    },
    plan: {
      ...blueprint.plan,
      steps,
    },
  });
};

describe("workflow app integration contract", () => {
  it("pins the package-first dynamic plan", async () => {
    const { artifacts, result } = await runWorkflow();
    const dynamicPlan = DynamicWorkflowPlanDocumentSchema.parse(
      await artifacts.readJson({ artifactRef: result.planArtifact.artifactRef })
    );

    expect(dynamicPlan.schemaVersion).toBe("workflow.dynamic-plan.v1");
    expect(dynamicPlan.pinnedPackages).toHaveLength(
      integrationTestPackageMetadata.length
    );
    expect(dynamicPlan.sideEffects).toHaveLength(1);
    expect(dynamicPlan.steps.map((step) => step.kind)).toStrictEqual([
      "research.review",
      "capability.discord.message",
      "review.summary",
    ]);
  });

  it("pins generated machine, harness, and verification contract artifacts", async () => {
    const { artifacts, result } = await runWorkflow();
    const generatedMachine = DynamicWorkflowMachineDocumentSchema.parse(
      await artifacts.readJson({
        artifactRef: result.machineArtifact.artifactRef,
      })
    );
    const generatedMachineSource = await artifacts.readText({
      artifactRef: result.machineArtifact.sourceArtifactRef,
    });
    const generatedHarnessSource = await artifacts.readText({
      artifactRef: result.harnessArtifact.artifactRef,
    });
    const verificationContract = VerificationContractDocumentSchema.parse(
      await artifacts.readJson({
        artifactRef: result.verificationContractArtifact.artifactRef,
      })
    );
    const executionProof = WorkflowExecutionProofDocumentSchema.parse(
      await artifacts.readJson({
        artifactRef: result.executionProofArtifact.artifactRef,
      })
    );

    expect({
      executionProofStatus: executionProof.status,
      generatedHarnessIncludesEntrypoint: generatedHarnessSource.includes(
        "executeDynamicHarness"
      ),
      generatedMachineIncludesDoneState: Object.keys(
        generatedMachine.xstate.states
      ).includes("done"),
      generatedMachineSchemaVersion: generatedMachine.schemaVersion,
      generatedMachineSourceIncludesXState: generatedMachineSource.includes(
        "setup({}).createMachine("
      ),
      verificationContractSchemaVersion: verificationContract.schemaVersion,
    }).toStrictEqual({
      executionProofStatus: "not-proven-local-integration",
      generatedHarnessIncludesEntrypoint: true,
      generatedMachineIncludesDoneState: true,
      generatedMachineSchemaVersion: "workflow.xstate-machine.v1",
      generatedMachineSourceIncludesXState: true,
      verificationContractSchemaVersion: "workflow.verification-contract.v1",
    });
  });

  it("rejects legacy generic step chains as Dream generated-workflow proof", async () => {
    const { artifacts, result } = await runWorkflow();
    const plan = DynamicWorkflowPlanDocumentSchema.parse(
      await artifacts.readJson({
        artifactRef: result.planArtifact.artifactRef,
      })
    );
    const machine = DynamicWorkflowMachineDocumentSchema.parse(
      await artifacts.readJson({
        artifactRef: result.machineArtifact.artifactRef,
      })
    );
    const executionProof = WorkflowExecutionProofDocumentSchema.parse(
      await artifacts.readJson({
        artifactRef: result.executionProofArtifact.artifactRef,
      })
    );
    const proof = verifyDreamGeneratedWorkflow({
      executionProof,
      executionProofRef: result.executionProofArtifact.artifactRef,
      expectedPackageRef: dreamWorkflowPackageRef,
      expectedSourceProfile: dreamTranscriptReviewSourceProfile,
      expectedSourceProfileExportId: "dream-transcript-review-source-profile",
      generatedAt: "2026-06-09T21:30:00.000Z",
      harnessArtifact: result.harnessArtifact,
      harnessSource: await artifacts.readText({
        artifactRef: result.harnessArtifact.artifactRef,
      }),
      machine,
      machineArtifact: result.machineArtifact,
      machineSource: await artifacts.readText({
        artifactRef: result.machineArtifact.sourceArtifactRef,
      }),
      plan,
      planArtifact: result.planArtifact,
    });

    expect({
      failedCheckIds: proof.checks
        .filter((check) => check.status === "failed")
        .map((check) => check.checkId),
      status: proof.status,
      stepKinds: plan.steps.map((step) => step.kind),
    }).toStrictEqual({
      failedCheckIds: [
        "plan:profile-effect-coverage",
        "plan:horizon-coverage",
        "plan:source-profile-bound",
        "plan:source-pack-disposition",
        "plan:runtime-source-coverage",
      ],
      status: "failed",
      stepKinds: [
        "research.review",
        "capability.discord.message",
        "review.summary",
      ],
    });
  });

  it("records integration-test lane receipts without claiming real agents", async () => {
    const { result } = await runWorkflow();

    expect({
      plannerRealAgent: result.plannerLaneReceipt.realAgent,
      plannerRuntime: result.plannerLaneReceipt.runtime,
      plannerTraceId: result.plannerLaneReceipt.traceContext?.traceId,
      workerRealAgents: result.workerLaneReceipts.map(
        (receipt) => receipt.realAgent
      ),
      workerRuntimes: result.workerLaneReceipts.map(
        (receipt) => receipt.runtime
      ),
      workerTraceIds: result.workerLaneReceipts.map(
        (receipt) => receipt.traceContext?.traceId
      ),
    }).toStrictEqual({
      plannerRealAgent: false,
      plannerRuntime: "integration-test",
      plannerTraceId: `trace:${result.runId}`,
      workerRealAgents: [false, false, false],
      workerRuntimes: [
        "integration-test",
        "integration-test",
        "integration-test",
      ],
      workerTraceIds: result.workerLaneReceipts.map(
        () => `trace:${result.runId}`
      ),
    });
  });

  it("leases the dry-run capability and records verifier bypass explicitly", async () => {
    const { result } = await runWorkflow();
    const capabilityReceipt = result.capabilityReceipts.at(0);

    expect(capabilityReceipt?.capability).toBe("discord.message.send");
    expect(capabilityReceipt?.delivery.status).toBe("dry-run");
    expect(result.verificationResultArtifact).toBeUndefined();
    expect(result.verifierLaneReceipt).toBeUndefined();
    expect(result.eventLog).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: "verifyingDynamicWorkflow",
        }),
        expect.objectContaining({
          summary:
            "Integration-test path bypassed verifier execution; no verification result artifact was captured.",
        }),
      ])
    );
  });

  it("runs a plan-selected deterministic verifier against pinned evidence", async () => {
    const artifacts = createMemoryArtifactStore(
      "workflow-app-deterministic-verifier"
    );
    const planner = createIntegrationTestDynamicWorkflowPlanner();
    const workflow = new WorkflowApp({
      agentWorkerLane: {
        laneKind: "worker",
        async runStep(input) {
          if (!("outputPath" in input.step)) {
            throw new Error(
              "Deterministic verifier test worker only supports output steps."
            );
          }

          const completedAt = "2026-06-09T11:59:30.000Z";
          const laneId = `lane:worker:${input.plan.runId}:${input.step.stepId}`;
          const outputValue = {
            planId: input.plan.planId,
            redacted: true,
            result:
              "Real-lane-shaped worker output for deterministic verifier coverage.",
            runId: input.plan.runId,
            stepId: input.step.stepId,
          };
          const outputWrite = await artifacts.writeJson({
            path: input.step.outputPath,
            redacted: true,
            runId: input.plan.runId,
            value: outputValue,
          });
          const promptWrite = await artifacts.writeText({
            mediaType: "text/markdown",
            path: `lanes/${input.step.stepId}/prompt.md`,
            redacted: true,
            runId: input.plan.runId,
            value: `# Worker Prompt\n\nRun ${input.plan.runId} step ${input.step.stepId}.`,
          });
          const transcriptWrite = await artifacts.writeText({
            mediaType: "text/markdown",
            path: `lanes/${input.step.stepId}/transcript.md`,
            redacted: true,
            runId: input.plan.runId,
            value: `# Worker Transcript\n\nWrote ${outputWrite.artifactRef}.`,
          });
          const receiptRef = artifacts.artifactRef({
            path: `receipts/worker-${input.step.stepId}-lane.json`,
            runId: input.plan.runId,
          });
          const receipt = AgentLaneReceiptSchema.parse({
            artifactCommitSha: "commit-deterministic-worker",
            authLease: {
              expiresAt: "2026-06-09T12:30:00.000Z",
              issuedAt: "2026-06-09T11:59:00.000Z",
              leaseId: `lease:pi-auth:${input.plan.runId}`,
              redacted: true,
              runId: input.plan.runId,
              scope: "pi-agent-auth-json",
              secretRef: "secretref:pi-auth",
              workItemId: input.plan.workItemId,
            },
            completedAt,
            kind: "worker",
            laneId,
            outputPins: [
              {
                artifactRef: outputWrite.artifactRef,
                hash: sha256Hex(JSON.stringify(outputValue, null, 2)),
                mediaType: outputWrite.mediaType,
              },
            ],
            outputRefs: [outputWrite.artifactRef],
            prompt: {
              artifactRef: promptWrite.artifactRef,
              hash: promptWrite.contentHash,
              mediaType: promptWrite.mediaType,
            },
            realAgent: true,
            receiptRef,
            redacted: true,
            runtime: "pi-agent-cli",
            startedAt: completedAt,
            status: "completed",
            traceContext: {
              redacted: true,
              spanId: `span:${input.plan.runId}:worker:${input.step.stepId}`,
              traceId: `trace:${input.plan.runId}`,
            },
            transcript: {
              artifactRef: transcriptWrite.artifactRef,
              hash: transcriptWrite.contentHash,
              mediaType: transcriptWrite.mediaType,
            },
          });
          await artifacts.writeJson({
            path: `receipts/worker-${input.step.stepId}-lane.json`,
            redacted: true,
            runId: input.plan.runId,
            value: receipt,
          });

          return {
            outputRefs: [outputWrite.artifactRef],
            receipt,
          };
        },
        runtime: "pi-agent-cli",
      },
      artifacts,
      capabilityLeases: createPolicyCapabilityLeaseBroker(artifacts, {
        discordSecretRef: "secretref:discord-bot",
        policyId: "discord-message-policy",
      }),
      contextCapsules: createMemoryContextCapsuleActor(),
      deterministicVerifier: createArtifactEvidenceDeterministicVerifier({
        artifacts,
        now: () => "2026-06-09T12:00:00.000Z",
      }),
      discordMessages: createDryRunDiscordMessageAdapter(),
      discordSecretRefs: {
        dryRun: "secretref:discord-dry-run",
        send: "secretref:discord-bot",
      },
      dynamicWorkflowPlanner: {
        async proposePlan(input) {
          const blueprint = await planner.proposePlan(input);

          return DynamicWorkflowBlueprintSchema.parse({
            ...blueprint,
            verificationContract: {
              ...blueprint.verificationContract,
              checks: [
                {
                  checkId: "deterministic-output-evidence-present",
                  evidenceRequired:
                    "Pinned worker output evidence must be available.",
                  severity: "blocking",
                  summary:
                    "The deterministic verifier must inspect pinned worker output evidence.",
                },
                {
                  checkId: "deterministic-output-evidence-hashes-match",
                  evidenceRequired:
                    "Every evidence snapshot hash must match its pinned receipt.",
                  severity: "blocking",
                  summary:
                    "Evidence snapshots must be bound to their pinned hashes.",
                },
                {
                  checkId: "deterministic-side-effect-receipts-cover-plan",
                  evidenceRequired:
                    "Declared side effects must be covered by capability lease receipts.",
                  severity: "blocking",
                  summary:
                    "Side effects remain lease-backed during deterministic verification.",
                },
                {
                  checkId: "deterministic-observability-pack-present",
                  evidenceRequired:
                    "The workflow observability pack must be included as verifier evidence.",
                  severity: "blocking",
                  summary:
                    "Runtime observability remains part of the verifier evidence set.",
                },
              ],
              verifier: {
                kind: "deterministic",
                source: "builtin:artifact-evidence-integrity.v1",
              },
            },
          });
        },
      },
      executionMode: "integration-test",
      observabilityRecorder: createCloudflareArtifactsObservabilityRecorder({
        artifacts,
      }),
      packageRegistry: createMemoryPackageRegistryActor(
        integrationTestPackageMetadata
      ),
      reviewGate: createMemoryReviewGateActor(artifacts),
      reviewSurfacePublisher: createCloudflareArtifactsReviewSurfacePublisher({
        artifacts,
      }),
      statusProjection: createMemoryWorkflowStatusProjectionStore(),
      wzrrdPublisher: createDryRunWzrrdPublishAdapter(),
      wzrrdSecretRefs: {
        dryRun: "secretref:wzrrd-dry-run",
        publish: "secretref:wzrrd-api",
      },
      wzrrdSiteRef: "wzrrd:test",
    });

    const result = await workflow.run(buildIntegrationTestRunRequest());
    if (result.status !== "captured") {
      throw new Error(result.blocker.message);
    }
    const verificationResult = VerificationResultDocumentSchema.parse(
      await artifacts.readJson({
        artifactRef: result.verificationResultArtifact?.artifactRef ?? "",
      })
    );
    const reviewSurface = ReviewSurfaceDocumentSchema.parse(
      await artifacts.readJson({
        artifactRef: result.reviewSurfaceArtifact.artifactRef,
      })
    );

    expect(result.verificationResultArtifact?.artifactRef).toContain(
      "/artifacts/verification/result.json"
    );
    expect({
      deterministicSummary: result.eventLog.find(
        (event) => event.state === "recordingReceipts"
      )?.summary,
      resultCheckedAt: verificationResult.checkedAt,
      resultFailures: verificationResult.failures,
      resultStatus: verificationResult.status,
      verifierLaneReceipt: result.verifierLaneReceipt,
      workflowChainMissingIds:
        reviewSurface.definitionOfDone.workflowChain.requirements
          .filter((requirement) => requirement.status === "missing")
          .map((requirement) => requirement.requirementId),
    }).toStrictEqual({
      deterministicSummary:
        "Deterministic verifier accepted the pinned dynamic workflow outputs.",
      resultCheckedAt: "2026-06-09T12:00:00.000Z",
      resultFailures: [],
      resultStatus: "accepted",
      verifierLaneReceipt: undefined,
      workflowChainMissingIds: ["pi-planner-lane"],
    });
  });

  it("projects live workflow status into the status projection port", async () => {
    const { result, statusProjection } = await runWorkflow();
    const latest = statusProjection.latest.get(result.runId);

    expect({
      eventCount: latest?.eventCount,
      latestPlanRef: latest?.planArtifact?.artifactRef,
      latestState: latest?.currentState,
      projectedStates: statusProjection.records
        .get(result.runId)
        ?.map((projection) => projection.currentState),
      runId: latest?.runId,
    }).toStrictEqual({
      eventCount: result.eventLog.length,
      latestPlanRef: result.planArtifact.artifactRef,
      latestState: "captured",
      projectedStates: result.eventLog.map((event) => event.state),
      runId: result.runId,
    });
  });

  it("publishes a typed final review surface with the receipt chain", async () => {
    const { artifacts, observabilityCaptureCalls, result } =
      await runWorkflow();
    const observabilityPackRef = result.artifactRefs.find((artifactRef) =>
      artifactRef.endsWith("/run/observability-pack.json")
    );
    if (observabilityPackRef === undefined) {
      throw new Error(
        "Expected workflow result to include observability pack."
      );
    }
    const observabilityPack = WorkflowObservabilityPackSchema.parse(
      await artifacts.readJson({ artifactRef: observabilityPackRef })
    );
    const telemetrySinkArtifactRef =
      observabilityPack.telemetrySinks.at(0)?.artifactRef;
    const telemetrySinkJsonl =
      telemetrySinkArtifactRef === undefined
        ? null
        : await artifacts.readText({ artifactRef: telemetrySinkArtifactRef });
    const reviewSurface = ReviewSurfaceDocumentSchema.parse(
      await artifacts.readJson({
        artifactRef: result.reviewSurfaceArtifact.artifactRef,
      })
    );

    expect({
      capabilityReceiptRefs: reviewSurface.capabilityReceipts.map(
        (receipt) => receipt.receiptRef
      ),
      capabilityReceiptTraceContexts: result.capabilityReceipts.map(
        (receipt) => receipt.traceContext
      ),
      executionProofRef:
        reviewSurface.generatedArtifacts.executionProof.artifactRef,
      harnessRef: reviewSurface.generatedArtifacts.harness.artifactRef,
      inRunArtifacts: result.artifactRefs.includes(
        result.reviewSurfaceArtifact.artifactRef
      ),
      kind: result.reviewSurfaceArtifact.kind,
      machineRef: reviewSurface.generatedArtifacts.machine.artifactRef,
      observabilityDefinitionFields:
        reviewSurface.definitionOfDone.observability.requiredStructuredLogFields
          .filter(
            (field) =>
              ["runId", "workItemId", "laneId", "leaseId", "traceId"].includes(
                field
              ) || ["projectionSink", "projectionStatus"].includes(field)
          )
          .toSorted(),
      observabilityDefinitionRedaction:
        reviewSurface.definitionOfDone.observability.redactionPolicy,
      observabilityDefinitionSignals:
        reviewSurface.definitionOfDone.observability.requiredSignals
          .filter((signal) =>
            [
              "agent-readable-observability-pack",
              "status-projection",
              "structured-high-cardinality-logs",
            ].includes(signal)
          )
          .toSorted(),
      observabilityDefinitionStatus:
        reviewSurface.definitionOfDone.observability.status,
      observabilityPackHasPlannerReceipt:
        observabilityPack.artifactRefs.includes(
          result.plannerLaneReceipt.receiptRef
        ),
      observabilityPackHasRunId:
        observabilityPack.highCardinalityFields.includes("runId"),
      observabilityPackHasStatusProjectionSignal:
        observabilityPack.requiredSignals.includes("status-projection"),
      observabilityPackHasStructuredLogs:
        observabilityPack.requiredSignals.includes(
          "structured-high-cardinality-logs"
        ),
      observabilityPackLogCountPositive: observabilityPack.logs.length > 0,
      observabilityPackProjectionLatest:
        observabilityPack.statusProjection.latest.currentState,
      observabilityPackProjectionSink: observabilityPack.statusProjection.sink,
      observabilityPackSandboxAccountingStatus:
        observabilityPack.metrics.sandboxAccountingStatus,
      observabilityPackStructuredLogSinkStatus:
        observabilityPack.metrics.structuredLogSinkStatus,
      observabilityPackTelemetrySinkKinds: observabilityPack.telemetrySinks.map(
        (receipt) => receipt.sink.kind
      ),
      observabilityPackTokenCostStatus:
        observabilityPack.metrics.tokenCostAccountingStatus,
      observabilityPackTracePropagationStatus:
        observabilityPack.metrics.tracePropagationStatus,
      observabilityPackTraceSpanCountPositive:
        observabilityPack.metrics.traceSpanCount > 0,
      observabilityRecorderCall: observabilityCaptureCalls.at(0),
      packageIds: reviewSurface.packages.map(
        (packageRecord) => packageRecord.packageId
      ),
      planRef: reviewSurface.plan.artifactRef,
      plannerTranscriptRef:
        reviewSurface.laneReceipts.planner.transcript.artifactRef,
      proposalReconciliationMissingIds:
        reviewSurface.definitionOfDone.reconciliation.requirements
          .filter((requirement) => requirement.status === "missing")
          .map((requirement) => requirement.requirementId),
      proposalReconciliationRequirementIds:
        reviewSurface.definitionOfDone.reconciliation.requirements.map(
          (requirement) => requirement.requirementId
        ),
      proposalReconciliationStatus:
        reviewSurface.definitionOfDone.reconciliation.status,
      redactedRefsIncludePlannerReceipt:
        reviewSurface.redactedArtifactRefs.includes(
          result.plannerLaneReceipt.receiptRef
        ),
      redactedRefsIncludeReviewSummary:
        reviewSurface.redactedArtifactRefs.includes(result.reviewSummaryRef),
      resultIncludesTelemetrySink:
        telemetrySinkArtifactRef === undefined
          ? false
          : result.artifactRefs.includes(telemetrySinkArtifactRef),
      reviewSummaryRef: reviewSurface.reviewSummaryRef,
      schemaVersion: reviewSurface.schemaVersion,
      spanIdsFromCapabilityReceipts: observabilityPack.logs
        .filter((log) => log.eventName === "workflow.capability.receipt")
        .map((log) => log.fields["spanId"]),
      spanIdsFromLaneReceipts: observabilityPack.logs
        .filter((log) => log.eventName === "workflow.lane.receipt")
        .map((log) => log.fields["spanId"]),
      telemetrySinkJsonlHasWorkflowState:
        telemetrySinkJsonl?.includes("workflow.state.resolvingCapsule") ??
        false,
      workflowChainMissingIds:
        reviewSurface.definitionOfDone.workflowChain.requirements
          .filter((requirement) => requirement.status === "missing")
          .map((requirement) => requirement.requirementId),
      workflowChainStatus: reviewSurface.definitionOfDone.workflowChain.status,
    }).toStrictEqual({
      capabilityReceiptRefs: result.capabilityReceipts.map(
        (receipt) => receipt.receiptRef
      ),
      capabilityReceiptTraceContexts: result.capabilityReceipts.map(
        (receipt) => receipt.traceContext
      ),
      executionProofRef: result.executionProofArtifact.artifactRef,
      harnessRef: result.harnessArtifact.artifactRef,
      inRunArtifacts: true,
      kind: "artifact-review",
      machineRef: result.machineArtifact.artifactRef,
      observabilityDefinitionFields: [
        "laneId",
        "leaseId",
        "projectionSink",
        "projectionStatus",
        "runId",
        "traceId",
        "workItemId",
      ],
      observabilityDefinitionRedaction:
        "no-secrets-no-raw-auth-no-token-bearing-refs",
      observabilityDefinitionSignals: [
        "agent-readable-observability-pack",
        "status-projection",
        "structured-high-cardinality-logs",
      ],
      observabilityDefinitionStatus: "required",
      observabilityPackHasPlannerReceipt: true,
      observabilityPackHasRunId: true,
      observabilityPackHasStatusProjectionSignal: true,
      observabilityPackHasStructuredLogs: true,
      observabilityPackLogCountPositive: true,
      observabilityPackProjectionLatest: "verifyingDynamicWorkflow",
      observabilityPackProjectionSink: {
        description:
          "WorkflowStatusProjectionPort records are mirrored into the Cloudflare D1 runs table by run_id while the deployed control plane advances the run.",
        kind: "cloudflare-d1-runs",
        runId: result.runId,
        table: "runs",
      },
      observabilityPackSandboxAccountingStatus: "not-yet-instrumented",
      observabilityPackStructuredLogSinkStatus: "captured",
      observabilityPackTelemetrySinkKinds: ["artifact-jsonl"],
      observabilityPackTokenCostStatus: "not-yet-instrumented",
      observabilityPackTracePropagationStatus: "captured",
      observabilityPackTraceSpanCountPositive: true,
      observabilityRecorderCall: {
        runId: result.runId,
        workerLaneCount: result.workerLaneReceipts.length,
      },
      packageIds: integrationTestPackageMetadata.map(
        (packageRecord) => packageRecord.packageId
      ),
      planRef: result.planArtifact.artifactRef,
      plannerTranscriptRef: result.plannerLaneReceipt.transcript.artifactRef,
      proposalReconciliationMissingIds: [
        "cloudflare-execution-proof",
        "real-pi-agent-lanes",
        "receipt-backed-review-surface",
      ],
      proposalReconciliationRequirementIds: [
        "package-first-saved-primitive",
        "artifact-backed-package-pinning",
        "entitlement-and-trust-policy",
        "generated-xstate-dynamic-workflow",
        "cloudflare-execution-proof",
        "real-pi-agent-lanes",
        "capability-leased-side-effects",
        "receipt-backed-review-surface",
        "observability-redaction-envelope",
      ],
      proposalReconciliationStatus: "linked",
      redactedRefsIncludePlannerReceipt: true,
      redactedRefsIncludeReviewSummary: true,
      resultIncludesTelemetrySink: true,
      reviewSummaryRef: result.reviewSummaryRef,
      schemaVersion: "workflow.review-surface.v1",
      spanIdsFromCapabilityReceipts: result.capabilityReceipts.map(
        (receipt) => receipt.traceContext.spanId
      ),
      spanIdsFromLaneReceipts: [
        result.plannerLaneReceipt,
        ...result.workerLaneReceipts,
      ].map((receipt) => receipt.traceContext?.spanId),
      telemetrySinkJsonlHasWorkflowState: true,
      workflowChainMissingIds: [
        "pi-planner-lane",
        "pi-worker-lanes",
        "verifier-lane",
      ],
      workflowChainStatus: "incomplete",
    });
  });

  it("captures token and cost accounting from typed lane receipts", async () => {
    const { artifacts, result } = await runWorkflow({
      tokenCostAccountingFixture: true,
    });
    const observabilityPackRef = result.artifactRefs.find((artifactRef) =>
      artifactRef.endsWith("/run/observability-pack.json")
    );
    if (observabilityPackRef === undefined) {
      throw new Error(
        "Expected workflow result to include observability pack."
      );
    }
    const observabilityPack = WorkflowObservabilityPackSchema.parse(
      await artifacts.readJson({ artifactRef: observabilityPackRef })
    );
    const laneReceipts = [
      observabilityPack.laneReceipts.planner,
      ...observabilityPack.laneReceipts.workers,
    ];
    const laneLogs = observabilityPack.logs.filter(
      (log) => log.eventName === "workflow.lane.receipt"
    );

    expect({
      laneLogAccounting: laneLogs.map((log) => ({
        costEstimate: log.fields["costEstimate"],
        laneId: log.fields["laneId"],
        tokenCount: log.fields["tokenCount"],
      })),
      metricCostEstimate: observabilityPack.metrics.tokenCostEstimate,
      metricTokenCount: observabilityPack.metrics.tokenCount,
      sources: laneReceipts.map(
        (receipt) => receipt.tokenCostAccounting?.source
      ),
      status: observabilityPack.metrics.tokenCostAccountingStatus,
    }).toStrictEqual({
      laneLogAccounting: laneReceipts.map((receipt) => ({
        costEstimate: receipt.tokenCostAccounting?.costEstimate,
        laneId: receipt.laneId,
        tokenCount: receipt.tokenCostAccounting?.tokenCount,
      })),
      metricCostEstimate: laneReceipts.reduce(
        (total, receipt) =>
          total + (receipt.tokenCostAccounting?.costEstimate ?? 0),
        0
      ),
      metricTokenCount: laneReceipts.reduce(
        (total, receipt) =>
          total + (receipt.tokenCostAccounting?.tokenCount ?? 0),
        0
      ),
      sources: laneReceipts.map(() => "integration-test-fixture"),
      status: "captured",
    });
  });

  it("leases Wzrrd review-surface delivery for Wzrrd output targets", async () => {
    const artifacts = createMemoryArtifactStore("workflow-app-wzrrd-delivery");
    const planner = createIntegrationTestDynamicWorkflowPlanner();
    const workflow = new WorkflowApp({
      artifacts,
      capabilityLeases: createPolicyCapabilityLeaseBroker(artifacts, {
        discordSecretRef: "secretref:discord-bot",
        policyId: "workflow-capability-policy",
        wzrrdSecretRef: "secretref:wzrrd-api",
      }),
      contextCapsules: createMemoryContextCapsuleActor(),
      discordMessages: createDryRunDiscordMessageAdapter(),
      discordSecretRefs: {
        dryRun: "secretref:discord-dry-run",
        send: "secretref:discord-bot",
      },
      dynamicWorkflowPlanner: {
        async proposePlan(input) {
          const blueprint = await planner.proposePlan(input);

          return DynamicWorkflowBlueprintSchema.parse({
            ...blueprint,
            plan: {
              ...blueprint.plan,
              outputTarget: {
                kind: "wzrrd",
                reviewPath: "review/summary.json",
              },
            },
          });
        },
      },
      executionMode: "integration-test",
      observabilityRecorder: createCloudflareArtifactsObservabilityRecorder({
        artifacts,
      }),
      packageRegistry: createMemoryPackageRegistryActor(
        dreamIntegrationPackages
      ),
      reviewGate: createMemoryReviewGateActor(artifacts),
      reviewSurfacePublisher: createCloudflareArtifactsReviewSurfacePublisher({
        artifacts,
      }),
      statusProjection: createMemoryWorkflowStatusProjectionStore(),
      wzrrdPublisher: createDryRunWzrrdPublishAdapter(),
      wzrrdSecretRefs: {
        dryRun: "secretref:wzrrd-dry-run",
        publish: "secretref:wzrrd-api",
      },
      wzrrdSiteRef: "wzrrd:test",
    });

    const result = await workflow.run(buildIntegrationTestRunRequest());
    if (result.status !== "captured") {
      throw new Error(result.blocker.message);
    }
    const wzrrdPayloadRef = result.artifactRefs.find((artifactRef) =>
      artifactRef.endsWith("/payloads/wzrrd-publish.json")
    );
    if (wzrrdPayloadRef === undefined) {
      throw new Error("Expected run receipt to include Wzrrd publish payload.");
    }
    const wzrrdPayload = WzrrdPublishPayloadSchema.parse(
      await artifacts.readJson({ artifactRef: wzrrdPayloadRef })
    );
    const wzrrdReceipt = result.capabilityReceipts.find(
      (receipt) => receipt.capability === "wzrrd.site.publish"
    );

    expect({
      capabilities: result.capabilityReceipts.map(
        (receipt) => receipt.capability
      ),
      eventStates: result.eventLog
        .map((event) => event.state)
        .filter((state) =>
          [
            "summarizingReview",
            "requestingReviewSurfaceDeliveryLease",
            "executingReviewSurfaceDelivery",
            "captured",
          ].includes(state)
        ),
      payloadReviewSurfaceRef: wzrrdPayload.reviewSurface.artifactRef,
      receiptDeliveryStatus: wzrrdReceipt?.delivery.status,
      receiptResource: wzrrdReceipt?.resource,
      reviewSurfaceKind: result.reviewSurfaceArtifact.kind,
      wzrrdReceiptInArtifacts:
        wzrrdReceipt === undefined
          ? false
          : result.artifactRefs.includes(wzrrdReceipt.receiptRef),
    }).toStrictEqual({
      capabilities: ["discord.message.send", "wzrrd.site.publish"],
      eventStates: [
        "summarizingReview",
        "requestingReviewSurfaceDeliveryLease",
        "executingReviewSurfaceDelivery",
        "summarizingReview",
        "captured",
      ],
      payloadReviewSurfaceRef: result.reviewSurfaceArtifact.artifactRef,
      receiptDeliveryStatus: "dry-run",
      receiptResource: {
        kind: "wzrrd.site",
        siteRef: "wzrrd:test",
        slug: result.runId.toLowerCase(),
      },
      reviewSurfaceKind: "wzrrd",
      wzrrdReceiptInArtifacts: true,
    });
  });

  it("leases Linear comment review-surface delivery for Linear output targets", async () => {
    const artifacts = createMemoryArtifactStore("workflow-app-linear-delivery");
    const planner = createIntegrationTestDynamicWorkflowPlanner();
    const workflow = new WorkflowApp({
      artifacts,
      capabilityLeases: createPolicyCapabilityLeaseBroker(artifacts, {
        discordSecretRef: "secretref:discord-bot",
        linearCommentSecretRef: "secretref:linear-api",
        policyId: "workflow-capability-policy",
        wzrrdSecretRef: "secretref:wzrrd-api",
      }),
      contextCapsules: createMemoryContextCapsuleActor(),
      discordMessages: createDryRunDiscordMessageAdapter(),
      discordSecretRefs: {
        dryRun: "secretref:discord-dry-run",
        send: "secretref:discord-bot",
      },
      dynamicWorkflowPlanner: {
        async proposePlan(input) {
          const blueprint = await planner.proposePlan(input);

          return DynamicWorkflowBlueprintSchema.parse({
            ...blueprint,
            plan: {
              ...blueprint.plan,
              outputTarget: {
                issueRef: "PIWF-123",
                kind: "linear",
              },
            },
          });
        },
      },
      executionMode: "integration-test",
      linearComments: createDryRunLinearCommentAdapter(),
      linearSecretRefs: {
        createComment: "secretref:linear-api",
        dryRun: "secretref:linear-dry-run",
      },
      observabilityRecorder: createCloudflareArtifactsObservabilityRecorder({
        artifacts,
      }),
      packageRegistry: createMemoryPackageRegistryActor(
        dreamIntegrationPackages
      ),
      reviewGate: createMemoryReviewGateActor(artifacts),
      reviewSurfacePublisher: createCloudflareArtifactsReviewSurfacePublisher({
        artifacts,
      }),
      statusProjection: createMemoryWorkflowStatusProjectionStore(),
      wzrrdPublisher: createDryRunWzrrdPublishAdapter(),
      wzrrdSecretRefs: {
        dryRun: "secretref:wzrrd-dry-run",
        publish: "secretref:wzrrd-api",
      },
      wzrrdSiteRef: "wzrrd:test",
    });

    const result = await workflow.run(buildIntegrationTestRunRequest());
    if (result.status !== "captured") {
      throw new Error(result.blocker.message);
    }
    const linearPayloadRef = result.artifactRefs.find((artifactRef) =>
      artifactRef.endsWith("/payloads/linear-comment.json")
    );
    if (linearPayloadRef === undefined) {
      throw new Error(
        "Expected run receipt to include Linear comment payload."
      );
    }
    const linearPayload = LinearCommentPayloadSchema.parse(
      await artifacts.readJson({ artifactRef: linearPayloadRef })
    );
    const linearReceipt = result.capabilityReceipts.find(
      (receipt) => receipt.capability === "linear.comment.create"
    );

    expect({
      capabilities: result.capabilityReceipts.map(
        (receipt) => receipt.capability
      ),
      eventStates: result.eventLog
        .map((event) => event.state)
        .filter((state) =>
          [
            "summarizingReview",
            "requestingReviewSurfaceDeliveryLease",
            "executingReviewSurfaceDelivery",
            "captured",
          ].includes(state)
        ),
      linearReceiptInArtifacts:
        linearReceipt === undefined
          ? false
          : result.artifactRefs.includes(linearReceipt.receiptRef),
      payloadReviewSurfaceRef: linearPayload.reviewSurface.artifactRef,
      receiptDeliveryStatus: linearReceipt?.delivery.status,
      receiptResource: linearReceipt?.resource,
      reviewSurfaceKind: result.reviewSurfaceArtifact.kind,
    }).toStrictEqual({
      capabilities: ["discord.message.send", "linear.comment.create"],
      eventStates: [
        "summarizingReview",
        "requestingReviewSurfaceDeliveryLease",
        "executingReviewSurfaceDelivery",
        "summarizingReview",
        "captured",
      ],
      linearReceiptInArtifacts: true,
      payloadReviewSurfaceRef: result.reviewSurfaceArtifact.artifactRef,
      receiptDeliveryStatus: "dry-run",
      receiptResource: {
        issueRef: "PIWF-123",
        kind: "linear.issue",
      },
      reviewSurfaceKind: "linear",
    });
  });

  it("records approval before creating real Linear review-surface comments", async () => {
    const artifacts = createMemoryArtifactStore(
      "workflow-app-linear-commented-delivery"
    );
    const planner = createIntegrationTestDynamicWorkflowPlanner();
    const linearAdapterCalls: {
      readonly dryRun: boolean;
      readonly reviewGateMode: string;
      readonly secretRef: string;
    }[] = [];
    const workflow = new WorkflowApp({
      artifacts,
      capabilityLeases: createPolicyCapabilityLeaseBroker(artifacts, {
        discordSecretRef: "secretref:discord-bot",
        linearCommentSecretRef: "secretref:linear-api",
        policyId: "workflow-capability-policy",
        wzrrdSecretRef: "secretref:wzrrd-api",
      }),
      contextCapsules: createMemoryContextCapsuleActor(),
      discordMessages: createDryRunDiscordMessageAdapter(),
      discordSecretRefs: {
        dryRun: "secretref:discord-dry-run",
        send: "secretref:discord-bot",
      },
      dynamicWorkflowPlanner: {
        async proposePlan(input) {
          const blueprint = await planner.proposePlan(input);

          return DynamicWorkflowBlueprintSchema.parse({
            ...blueprint,
            plan: {
              ...blueprint.plan,
              outputTarget: {
                issueRef: "PIWF-123",
                kind: "linear",
              },
            },
          });
        },
      },
      executionMode: "integration-test",
      linearComments: {
        execute(input) {
          linearAdapterCalls.push({
            dryRun: input.lease.dryRun,
            reviewGateMode: input.lease.reviewGate.mode,
            secretRef: input.lease.secretRef,
          });

          return Promise.resolve(
            LinearCommentDeliveryResultSchema.parse({
              commentId: "linear-comment-uuid",
              commentUrl:
                "https://linear.app/joelhooks/issue/PIWF-123/test#comment-linear-comment-uuid",
              commentedAt: "2026-06-08T23:59:10.000Z",
              dryRun: false,
              issueRef: input.payload.issueRef,
              payloadHash: hashJson(input.payload),
              redacted: true,
              status: "commented",
            })
          );
        },
      },
      linearSecretRefs: {
        createComment: "secretref:linear-api",
        dryRun: "secretref:linear-dry-run",
      },
      observabilityRecorder: createCloudflareArtifactsObservabilityRecorder({
        artifacts,
      }),
      packageRegistry: createMemoryPackageRegistryActor(
        dreamIntegrationPackages
      ),
      reviewGate: createMemoryReviewGateActor(artifacts),
      reviewSurfacePublisher: createCloudflareArtifactsReviewSurfacePublisher({
        artifacts,
      }),
      statusProjection: createMemoryWorkflowStatusProjectionStore(),
      wzrrdPublisher: createDryRunWzrrdPublishAdapter(),
      wzrrdSecretRefs: {
        dryRun: "secretref:wzrrd-dry-run",
        publish: "secretref:wzrrd-api",
      },
      wzrrdSiteRef: "wzrrd:test",
    });

    const request = buildIntegrationTestRunRequest();
    const result = await workflow.run({
      ...request,
      actor: {
        ...request.actor,
        roleIds: [...request.actor.roleIds, "linear.comment.create"],
      },
    });
    if (result.status !== "captured") {
      throw new Error(result.blocker.message);
    }
    const linearPayloadRef = result.artifactRefs.find((artifactRef) =>
      artifactRef.endsWith("/payloads/linear-comment.json")
    );
    const approvalRef = result.artifactRefs.find((artifactRef) =>
      artifactRef.endsWith("/review/linear-comment-approval.json")
    );
    if (linearPayloadRef === undefined || approvalRef === undefined) {
      throw new Error(
        "Expected run receipt to include Linear payload and approval."
      );
    }
    const linearPayload = LinearCommentPayloadSchema.parse(
      await artifacts.readJson({ artifactRef: linearPayloadRef })
    );
    const linearReceipt = result.capabilityReceipts.find(
      (receipt) => receipt.capability === "linear.comment.create"
    );

    expect({
      adapterCalls: linearAdapterCalls,
      approvalPayloadHash: hashJson(linearPayload),
      deliveryStatus: linearReceipt?.delivery.status,
      linearReceiptInArtifacts:
        linearReceipt === undefined
          ? false
          : result.artifactRefs.includes(linearReceipt.receiptRef),
      receiptDryRun: linearReceipt?.dryRun,
      receiptReviewGate: linearReceipt?.reviewGate,
      receiptSecretRef: linearReceipt?.secretRef,
    }).toStrictEqual({
      adapterCalls: [
        {
          dryRun: false,
          reviewGateMode: "approved",
          secretRef: "secretref:linear-api",
        },
      ],
      approvalPayloadHash: hashJson(linearPayload),
      deliveryStatus: "commented",
      linearReceiptInArtifacts: true,
      receiptDryRun: false,
      receiptReviewGate: {
        approvalRef,
        mode: "approved",
        reviewerActorId: request.actor.id,
      },
      receiptSecretRef: "secretref:linear-api",
    });
  });

  it("leases GitHub PR review-surface delivery for GitHub output targets", async () => {
    const artifacts = createMemoryArtifactStore("workflow-app-github-delivery");
    const planner = createIntegrationTestDynamicWorkflowPlanner();
    const workflow = new WorkflowApp({
      artifacts,
      capabilityLeases: createPolicyCapabilityLeaseBroker(artifacts, {
        discordSecretRef: "secretref:discord-bot",
        githubBranchCommitSecretRef: "secretref:github-branch-commit",
        githubPullRequestSecretRef: "secretref:github-pr",
        policyId: "workflow-capability-policy",
        wzrrdSecretRef: "secretref:wzrrd-api",
      }),
      contextCapsules: createMemoryContextCapsuleActor(),
      discordMessages: createDryRunDiscordMessageAdapter(),
      discordSecretRefs: {
        dryRun: "secretref:discord-dry-run",
        send: "secretref:discord-bot",
      },
      dynamicWorkflowPlanner: {
        async proposePlan(input) {
          const blueprint = await planner.proposePlan(input);

          return DynamicWorkflowBlueprintSchema.parse({
            ...blueprint,
            plan: {
              ...blueprint.plan,
              outputTarget: {
                baseBranch: "main",
                branchName: `workflow/${input.runId}`,
                kind: "github-pr",
                repositoryRef: "joelhooks/pi-cloudflare-sandbox-workflows",
              },
            },
          });
        },
      },
      executionMode: "integration-test",
      githubBranchCommits: createDryRunGitHubBranchCommitAdapter(),
      githubPullRequests: createDryRunGitHubPullRequestAdapter(),
      githubSecretRefs: {
        createBranchCommit: "secretref:github-branch-commit",
        createPullRequest: "secretref:github-pr",
        dryRun: "secretref:github-dry-run",
      },
      observabilityRecorder: createCloudflareArtifactsObservabilityRecorder({
        artifacts,
      }),
      packageRegistry: createMemoryPackageRegistryActor(
        integrationTestPackageMetadata
      ),
      reviewGate: createMemoryReviewGateActor(artifacts),
      reviewSurfacePublisher: createCloudflareArtifactsReviewSurfacePublisher({
        artifacts,
      }),
      statusProjection: createMemoryWorkflowStatusProjectionStore(),
      wzrrdPublisher: createDryRunWzrrdPublishAdapter(),
      wzrrdSecretRefs: {
        dryRun: "secretref:wzrrd-dry-run",
        publish: "secretref:wzrrd-api",
      },
      wzrrdSiteRef: "wzrrd:test",
    });

    const result = await workflow.run(buildIntegrationTestRunRequest());
    if (result.status !== "captured") {
      throw new Error(result.blocker.message);
    }
    const githubPayloadRef = result.artifactRefs.find((artifactRef) =>
      artifactRef.endsWith("/payloads/github-pr.json")
    );
    if (githubPayloadRef === undefined) {
      throw new Error("Expected run receipt to include GitHub PR payload.");
    }
    const githubBranchPayloadRef = result.artifactRefs.find((artifactRef) =>
      artifactRef.endsWith("/payloads/github-branch-commit.json")
    );
    if (githubBranchPayloadRef === undefined) {
      throw new Error(
        "Expected run receipt to include GitHub branch commit payload."
      );
    }
    const githubPayload = GitHubPullRequestPayloadSchema.parse(
      await artifacts.readJson({ artifactRef: githubPayloadRef })
    );
    const githubBranchPayload = GitHubBranchCommitPayloadSchema.parse(
      await artifacts.readJson({ artifactRef: githubBranchPayloadRef })
    );
    const githubBranchReceipt = result.capabilityReceipts.find(
      (receipt) => receipt.capability === "github.branch.commit"
    );
    const githubReceipt = result.capabilityReceipts.find(
      (receipt) => receipt.capability === "github.pull-request.create"
    );

    expect({
      branchPayloadFilePath: githubBranchPayload.files[0]?.path,
      branchReceiptDeliveryStatus: githubBranchReceipt?.delivery.status,
      branchReceiptInArtifacts:
        githubBranchReceipt === undefined
          ? false
          : result.artifactRefs.includes(githubBranchReceipt.receiptRef),
      capabilities: result.capabilityReceipts.map(
        (receipt) => receipt.capability
      ),
      eventStates: result.eventLog
        .map((event) => event.state)
        .filter((state) =>
          [
            "summarizingReview",
            "requestingReviewSurfaceDeliveryLease",
            "executingReviewSurfaceDelivery",
            "captured",
          ].includes(state)
        ),
      githubReceiptInArtifacts:
        githubReceipt === undefined
          ? false
          : result.artifactRefs.includes(githubReceipt.receiptRef),
      payloadReviewSurfaceRef: githubPayload.reviewSurface.artifactRef,
      receiptDeliveryStatus: githubReceipt?.delivery.status,
      receiptResource: githubReceipt?.resource,
      reviewSurfaceKind: result.reviewSurfaceArtifact.kind,
    }).toStrictEqual({
      branchPayloadFilePath: `workflow-reviews/${result.runId}/review-surface.md`,
      branchReceiptDeliveryStatus: "dry-run",
      branchReceiptInArtifacts: true,
      capabilities: [
        "discord.message.send",
        "github.branch.commit",
        "github.pull-request.create",
      ],
      eventStates: [
        "summarizingReview",
        "requestingReviewSurfaceDeliveryLease",
        "executingReviewSurfaceDelivery",
        "summarizingReview",
        "requestingReviewSurfaceDeliveryLease",
        "executingReviewSurfaceDelivery",
        "summarizingReview",
        "captured",
      ],
      githubReceiptInArtifacts: true,
      payloadReviewSurfaceRef: result.reviewSurfaceArtifact.artifactRef,
      receiptDeliveryStatus: "dry-run",
      receiptResource: {
        baseBranch: "main",
        headBranch: `workflow/${result.runId}`,
        kind: "github.repository",
        repositoryRef: "joelhooks/pi-cloudflare-sandbox-workflows",
      },
      reviewSurfaceKind: "github-pr",
    });
  });

  it("commits the review branch before opening approved GitHub PRs", async () => {
    const artifacts = createMemoryArtifactStore(
      "workflow-app-github-real-path"
    );
    const planner = createIntegrationTestDynamicWorkflowPlanner();
    const branchCalls: {
      readonly dryRun: boolean;
      readonly reviewGateMode: string;
      readonly secretRef: string;
    }[] = [];
    const pullRequestCalls: {
      readonly dryRun: boolean;
      readonly reviewGateMode: string;
      readonly secretRef: string;
    }[] = [];
    const workflow = new WorkflowApp({
      artifacts,
      capabilityLeases: createPolicyCapabilityLeaseBroker(artifacts, {
        discordSecretRef: "secretref:discord-bot",
        githubBranchCommitSecretRef: "secretref:github-branch-commit",
        githubPullRequestSecretRef: "secretref:github-pr",
        policyId: "workflow-capability-policy",
        wzrrdSecretRef: "secretref:wzrrd-api",
      }),
      contextCapsules: createMemoryContextCapsuleActor(),
      discordMessages: createDryRunDiscordMessageAdapter(),
      discordSecretRefs: {
        dryRun: "secretref:discord-dry-run",
        send: "secretref:discord-bot",
      },
      dynamicWorkflowPlanner: {
        async proposePlan(input) {
          const blueprint = await planner.proposePlan(input);

          return DynamicWorkflowBlueprintSchema.parse({
            ...blueprint,
            plan: {
              ...blueprint.plan,
              outputTarget: {
                baseBranch: "main",
                branchName: `workflow/${input.runId}`,
                kind: "github-pr",
                repositoryRef: "joelhooks/pi-cloudflare-sandbox-workflows",
              },
            },
          });
        },
      },
      executionMode: "integration-test",
      githubBranchCommits: {
        execute(input) {
          branchCalls.push({
            dryRun: input.lease.dryRun,
            reviewGateMode: input.lease.reviewGate.mode,
            secretRef: input.lease.secretRef,
          });

          return Promise.resolve(
            GitHubBranchCommitDeliveryResultSchema.parse({
              baseBranch: input.payload.baseBranch,
              commitSha: "abc123branchcommit",
              commitUrl:
                "https://github.com/joelhooks/pi-cloudflare-sandbox-workflows/commit/abc123branchcommit",
              committedAt: "2026-06-09T07:00:00.000Z",
              dryRun: false,
              fileCount: input.payload.files.length,
              headBranch: input.payload.headBranch,
              payloadHash: hashJson(input.payload),
              redacted: true,
              repositoryRef: input.payload.repositoryRef,
              status: "committed",
            })
          );
        },
      },
      githubPullRequests: {
        execute(input) {
          pullRequestCalls.push({
            dryRun: input.lease.dryRun,
            reviewGateMode: input.lease.reviewGate.mode,
            secretRef: input.lease.secretRef,
          });

          return Promise.resolve(
            GitHubPullRequestDeliveryResultSchema.parse({
              baseBranch: input.payload.baseBranch,
              dryRun: false,
              headBranch: input.payload.headBranch,
              openedAt: "2026-06-09T07:00:10.000Z",
              payloadHash: hashJson(input.payload),
              pullRequestNumber: 42,
              pullRequestUrl:
                "https://github.com/joelhooks/pi-cloudflare-sandbox-workflows/pull/42",
              redacted: true,
              repositoryRef: input.payload.repositoryRef,
              status: "opened",
            })
          );
        },
      },
      githubSecretRefs: {
        createBranchCommit: "secretref:github-branch-commit",
        createPullRequest: "secretref:github-pr",
        dryRun: "secretref:github-dry-run",
      },
      observabilityRecorder: createCloudflareArtifactsObservabilityRecorder({
        artifacts,
      }),
      packageRegistry: createMemoryPackageRegistryActor(
        integrationTestPackageMetadata
      ),
      reviewGate: createMemoryReviewGateActor(artifacts),
      reviewSurfacePublisher: createCloudflareArtifactsReviewSurfacePublisher({
        artifacts,
      }),
      statusProjection: createMemoryWorkflowStatusProjectionStore(),
      wzrrdPublisher: createDryRunWzrrdPublishAdapter(),
      wzrrdSecretRefs: {
        dryRun: "secretref:wzrrd-dry-run",
        publish: "secretref:wzrrd-api",
      },
      wzrrdSiteRef: "wzrrd:test",
    });
    const request = buildIntegrationTestRunRequest();
    const result = await workflow.run({
      ...request,
      actor: {
        ...request.actor,
        roleIds: [
          ...request.actor.roleIds,
          "github.branch.commit",
          "github.pr.create",
        ],
      },
    });
    if (result.status !== "captured") {
      throw new Error(result.blocker.message);
    }

    expect({
      branchCalls,
      capabilities: result.capabilityReceipts.map(
        (receipt) => receipt.capability
      ),
      deliveries: result.capabilityReceipts.map((receipt) => ({
        capability: receipt.capability,
        status: receipt.delivery.status,
      })),
      pullRequestCalls,
    }).toStrictEqual({
      branchCalls: [
        {
          dryRun: false,
          reviewGateMode: "approved",
          secretRef: "secretref:github-branch-commit",
        },
      ],
      capabilities: [
        "discord.message.send",
        "github.branch.commit",
        "github.pull-request.create",
      ],
      deliveries: [
        { capability: "discord.message.send", status: "dry-run" },
        { capability: "github.branch.commit", status: "committed" },
        { capability: "github.pull-request.create", status: "opened" },
      ],
      pullRequestCalls: [
        {
          dryRun: false,
          reviewGateMode: "approved",
          secretRef: "secretref:github-pr",
        },
      ],
    });
  });

  it("publishes Wzrrd review surfaces when the actor has the Wzrrd publish role", async () => {
    const artifacts = createMemoryArtifactStore(
      "workflow-app-wzrrd-published-delivery"
    );
    const planner = createIntegrationTestDynamicWorkflowPlanner();
    const wzrrdAdapterCalls: {
      readonly dryRun: boolean;
      readonly reviewGateMode: string;
      readonly secretRef: string;
    }[] = [];
    const workflow = new WorkflowApp({
      artifacts,
      capabilityLeases: createPolicyCapabilityLeaseBroker(artifacts, {
        discordSecretRef: "secretref:discord-bot",
        policyId: "workflow-capability-policy",
        wzrrdSecretRef: "secretref:wzrrd-api",
      }),
      contextCapsules: createMemoryContextCapsuleActor(),
      discordMessages: createDryRunDiscordMessageAdapter(),
      discordSecretRefs: {
        dryRun: "secretref:discord-dry-run",
        send: "secretref:discord-bot",
      },
      dynamicWorkflowPlanner: {
        async proposePlan(input) {
          const blueprint = await planner.proposePlan(input);

          return DynamicWorkflowBlueprintSchema.parse({
            ...blueprint,
            plan: {
              ...blueprint.plan,
              outputTarget: {
                kind: "wzrrd",
                reviewPath: "review/summary.json",
              },
            },
          });
        },
      },
      executionMode: "integration-test",
      observabilityRecorder: createCloudflareArtifactsObservabilityRecorder({
        artifacts,
      }),
      packageRegistry: createMemoryPackageRegistryActor(
        integrationTestPackageMetadata
      ),
      reviewGate: createMemoryReviewGateActor(artifacts),
      reviewSurfacePublisher: createCloudflareArtifactsReviewSurfacePublisher({
        artifacts,
      }),
      statusProjection: createMemoryWorkflowStatusProjectionStore(),
      wzrrdPublisher: {
        execute(input) {
          wzrrdAdapterCalls.push({
            dryRun: input.lease.dryRun,
            reviewGateMode: input.lease.reviewGate.mode,
            secretRef: input.lease.secretRef,
          });

          return Promise.resolve(
            WzrrdPublishDeliveryResultSchema.parse({
              dryRun: false,
              payloadHash: hashJson(input.payload),
              publishedAt: "2026-06-08T23:59:00.000Z",
              redacted: true,
              reviewSurfaceRef: input.payload.reviewSurface.artifactRef,
              slug: input.payload.slug,
              status: "published",
              url: `https://${input.payload.slug}.wzrrd.sh/`,
            })
          );
        },
      },
      wzrrdSecretRefs: {
        dryRun: "secretref:wzrrd-dry-run",
        publish: "secretref:wzrrd-api",
      },
      wzrrdSiteRef: "wzrrd:test",
    });
    const request = buildIntegrationTestRunRequest();

    const result = await workflow.run({
      ...request,
      actor: {
        ...request.actor,
        roleIds: [...request.actor.roleIds, "wzrrd.publish"],
      },
    });
    if (result.status !== "captured") {
      throw new Error(result.blocker.message);
    }
    const wzrrdPayloadRef = result.artifactRefs.find((artifactRef) =>
      artifactRef.endsWith("/payloads/wzrrd-publish.json")
    );
    const approvalRef = result.artifactRefs.find((artifactRef) =>
      artifactRef.endsWith("/review/wzrrd-publish-approval.json")
    );
    if (wzrrdPayloadRef === undefined || approvalRef === undefined) {
      throw new Error(
        "Expected run receipt to include Wzrrd payload and approval artifacts."
      );
    }
    const wzrrdPayload = WzrrdPublishPayloadSchema.parse(
      await artifacts.readJson({ artifactRef: wzrrdPayloadRef })
    );
    const approval = WzrrdPublishApprovalSchema.parse(
      await artifacts.readJson({ artifactRef: approvalRef })
    );
    const wzrrdReceipt = result.capabilityReceipts.find(
      (receipt) => receipt.capability === "wzrrd.site.publish"
    );

    expect({
      adapterCalls: wzrrdAdapterCalls,
      approvalPayloadHash: approval.payloadHash,
      approvalRef,
      deliveryStatus: wzrrdReceipt?.delivery.status,
      deliveryUrl:
        wzrrdReceipt?.delivery.status === "published"
          ? wzrrdReceipt.delivery.url
          : null,
      receiptDryRun: wzrrdReceipt?.dryRun,
      receiptReviewGate: wzrrdReceipt?.reviewGate,
      receiptSecretRef: wzrrdReceipt?.secretRef,
      wzrrdReceiptInArtifacts:
        wzrrdReceipt === undefined
          ? false
          : result.artifactRefs.includes(wzrrdReceipt.receiptRef),
    }).toStrictEqual({
      adapterCalls: [
        {
          dryRun: false,
          reviewGateMode: "approved",
          secretRef: "secretref:wzrrd-api",
        },
      ],
      approvalPayloadHash: hashJson(wzrrdPayload),
      approvalRef,
      deliveryStatus: "published",
      deliveryUrl: `https://${wzrrdPayload.slug}.wzrrd.sh/`,
      receiptDryRun: false,
      receiptReviewGate: {
        approvalRef,
        mode: "approved",
        reviewerActorId: request.actor.id,
      },
      receiptSecretRef: "secretref:wzrrd-api",
      wzrrdReceiptInArtifacts: true,
    });
  });

  it("writes a typed Discord approval artifact before real message sends", async () => {
    const artifacts = createMemoryArtifactStore(
      "workflow-app-discord-approved-delivery"
    );
    const discordAdapterCalls: {
      readonly dryRun: boolean;
      readonly reviewGateMode: string;
      readonly secretRef: string;
    }[] = [];
    const workflow = new WorkflowApp({
      artifacts,
      capabilityLeases: createPolicyCapabilityLeaseBroker(artifacts, {
        discordSecretRef: "secretref:discord-bot",
        policyId: "discord-message-policy",
      }),
      contextCapsules: createMemoryContextCapsuleActor(),
      discordMessages: {
        execute(input) {
          if (input.lease.resource.kind !== "discord.channel") {
            throw new Error("Expected a Discord channel lease.");
          }

          discordAdapterCalls.push({
            dryRun: input.lease.dryRun,
            reviewGateMode: input.lease.reviewGate.mode,
            secretRef: input.lease.secretRef,
          });

          return Promise.resolve(
            DiscordDeliveryResultSchema.parse({
              channelRef: input.lease.resource.channelRef,
              dryRun: false,
              messageId: `message:${input.lease.runId}`,
              payloadHash: input.lease.payloadHash,
              redacted: true,
              serverRef: input.lease.resource.serverRef,
              status: "sent",
            })
          );
        },
      },
      discordSecretRefs: {
        dryRun: "secretref:discord-dry-run",
        send: "secretref:discord-bot",
      },
      dynamicWorkflowPlanner: createIntegrationTestDynamicWorkflowPlanner(),
      executionMode: "integration-test",
      observabilityRecorder: createCloudflareArtifactsObservabilityRecorder({
        artifacts,
      }),
      packageRegistry: createMemoryPackageRegistryActor(
        integrationTestPackageMetadata
      ),
      reviewGate: createMemoryReviewGateActor(artifacts),
      reviewSurfacePublisher: createCloudflareArtifactsReviewSurfacePublisher({
        artifacts,
      }),
      statusProjection: createMemoryWorkflowStatusProjectionStore(),
      wzrrdPublisher: createDryRunWzrrdPublishAdapter(),
      wzrrdSecretRefs: {
        dryRun: "secretref:wzrrd-dry-run",
        publish: "secretref:wzrrd-api",
      },
      wzrrdSiteRef: "wzrrd:test",
    });
    const request = buildIntegrationTestRunRequest();

    const result = await workflow.run({
      ...request,
      actor: {
        ...request.actor,
        roleIds: [...request.actor.roleIds, "discord.send"],
      },
      planProposal: {
        ...request.planProposal,
        discordMessage: {
          body: "Workflow captured with a real leased Discord send.",
          channelRef: "discord:channel:1513235597022462185",
          dryRun: false,
          serverRef: "discord:dm:operator",
        },
      },
    });
    if (result.status !== "captured") {
      throw new Error(result.blocker.message);
    }
    const approvalRef = result.artifactRefs.find((artifactRef) =>
      artifactRef.endsWith("/review/discord-message-approval.json")
    );
    const discordReceipt = result.capabilityReceipts.find(
      (receipt) => receipt.capability === "discord.message.send"
    );
    if (approvalRef === undefined) {
      throw new Error(
        "Expected run receipt to include a Discord message approval artifact."
      );
    }
    const approval = DiscordMessageApprovalSchema.parse(
      await artifacts.readJson({ artifactRef: approvalRef })
    );

    expect({
      adapterCalls: discordAdapterCalls,
      approvalPayloadHash: approval.payloadHash,
      approvalRef,
      deliveryStatus: discordReceipt?.delivery.status,
      receiptDryRun: discordReceipt?.dryRun,
      receiptReviewGate: discordReceipt?.reviewGate,
      receiptSecretRef: discordReceipt?.secretRef,
    }).toStrictEqual({
      adapterCalls: [
        {
          dryRun: false,
          reviewGateMode: "approved",
          secretRef: "secretref:discord-bot",
        },
      ],
      approvalPayloadHash: discordReceipt?.payloadHash,
      approvalRef,
      deliveryStatus: "sent",
      receiptDryRun: false,
      receiptReviewGate: {
        approvalRef,
        mode: "approved",
        reviewerActorId: request.actor.id,
      },
      receiptSecretRef: "secretref:discord-bot",
    });
  });

  it("blocks generated Discord side effects that mutate server-pinned lease fields", async () => {
    const artifacts = createMemoryArtifactStore(
      "workflow-app-discord-planner-lease-spoof"
    );
    const planner = createIntegrationTestDynamicWorkflowPlanner();
    const workflow = new WorkflowApp({
      artifacts,
      capabilityLeases: createPolicyCapabilityLeaseBroker(artifacts, {
        discordSecretRef: "secretref:discord-bot",
        policyId: "discord-message-policy",
      }),
      contextCapsules: createMemoryContextCapsuleActor(),
      discordMessages: {
        execute() {
          throw new Error(
            "Discord adapter must not execute when generated lease fields are spoofed."
          );
        },
      },
      discordSecretRefs: {
        dryRun: "secretref:discord-dry-run",
        send: "secretref:discord-bot",
      },
      dynamicWorkflowPlanner: {
        async proposePlan(input) {
          const blueprint = await planner.proposePlan(input);
          const spoofedResource = {
            channelRef: "discord:channel:spoofed",
            kind: "discord.channel" as const,
            serverRef: "discord:server:spoofed",
          };

          return DynamicWorkflowBlueprintSchema.parse({
            ...blueprint,
            plan: {
              ...blueprint.plan,
              sideEffects: blueprint.plan.sideEffects.map((sideEffect) =>
                sideEffect.capability === "discord.message.send"
                  ? {
                      ...sideEffect,
                      resource: spoofedResource,
                      secretRef: "secretref:spoofed",
                    }
                  : sideEffect
              ),
              steps: blueprint.plan.steps.map((step) =>
                step.kind === "capability.discord.message"
                  ? {
                      ...step,
                      resource: spoofedResource,
                      secretRef: "secretref:spoofed",
                    }
                  : step
              ),
            },
          });
        },
      },
      executionMode: "integration-test",
      observabilityRecorder: createCloudflareArtifactsObservabilityRecorder({
        artifacts,
      }),
      packageRegistry: createMemoryPackageRegistryActor(
        integrationTestPackageMetadata
      ),
      reviewGate: createMemoryReviewGateActor(artifacts),
      reviewSurfacePublisher: createCloudflareArtifactsReviewSurfacePublisher({
        artifacts,
      }),
      statusProjection: createMemoryWorkflowStatusProjectionStore(),
      wzrrdPublisher: createDryRunWzrrdPublishAdapter(),
      wzrrdSecretRefs: {
        dryRun: "secretref:wzrrd-dry-run",
        publish: "secretref:wzrrd-api",
      },
      wzrrdSiteRef: "wzrrd:test",
    });

    const result = await workflow.run(buildIntegrationTestRunRequest());

    expect(result).toMatchObject({
      blocker: {
        code: "resource_scope_denied",
      },
      status: "blocked",
    });
  });

  it("blocks verifier result paths that collide with generated step outputs", async () => {
    const artifacts = createMemoryArtifactStore(
      "workflow-app-verifier-output-collision"
    );
    const planner = createIntegrationTestDynamicWorkflowPlanner();
    const workflow = new WorkflowApp({
      artifacts,
      capabilityLeases: createPolicyCapabilityLeaseBroker(artifacts, {
        discordSecretRef: "secretref:discord-bot",
        policyId: "discord-message-policy",
      }),
      contextCapsules: createMemoryContextCapsuleActor(),
      discordMessages: createDryRunDiscordMessageAdapter(),
      discordSecretRefs: {
        dryRun: "secretref:discord-dry-run",
        send: "secretref:discord-bot",
      },
      dynamicWorkflowPlanner: {
        async proposePlan(input) {
          const blueprint = await planner.proposePlan(input);

          return DynamicWorkflowBlueprintSchema.parse({
            ...blueprint,
            verificationContract: {
              ...blueprint.verificationContract,
              outputPath: "review/summary.json",
            },
          });
        },
      },
      executionMode: "integration-test",
      observabilityRecorder: createCloudflareArtifactsObservabilityRecorder({
        artifacts,
      }),
      packageRegistry: createMemoryPackageRegistryActor(
        integrationTestPackageMetadata
      ),
      reviewGate: createMemoryReviewGateActor(artifacts),
      reviewSurfacePublisher: createCloudflareArtifactsReviewSurfacePublisher({
        artifacts,
      }),
      statusProjection: createMemoryWorkflowStatusProjectionStore(),
      wzrrdPublisher: createDryRunWzrrdPublishAdapter(),
      wzrrdSecretRefs: {
        dryRun: "secretref:wzrrd-dry-run",
        publish: "secretref:wzrrd-api",
      },
      wzrrdSiteRef: "wzrrd:test",
    });

    const result = await workflow.run(buildIntegrationTestRunRequest());

    expect({
      blocker: result.status === "blocked" ? result.blocker : undefined,
      lastSummary: result.eventLog.at(-1)?.summary,
      status: result.status,
    }).toStrictEqual({
      blocker: {
        code: "capability_denied",
        message:
          "Verification contract outputPath must not collide with dynamic step outputPath: review/summary.json.",
        redacted: true,
      },
      lastSummary: "Planner output failed dynamic workflow validation.",
      status: "blocked",
    });
  });

  it("blocks schema-valid generated machines that violate the executor event protocol", async () => {
    const artifacts = createMemoryArtifactStore(
      "workflow-app-invalid-machine-protocol"
    );
    const planner = createIntegrationTestDynamicWorkflowPlanner();
    const workflow = new WorkflowApp({
      artifacts,
      capabilityLeases: createPolicyCapabilityLeaseBroker(artifacts, {
        discordSecretRef: "secretref:discord-bot",
        policyId: "discord-message-policy",
      }),
      contextCapsules: createMemoryContextCapsuleActor(),
      discordMessages: createDryRunDiscordMessageAdapter(),
      discordSecretRefs: {
        dryRun: "secretref:discord-dry-run",
        send: "secretref:discord-bot",
      },
      dynamicWorkflowPlanner: {
        async proposePlan(input) {
          const blueprint = await planner.proposePlan(input);
          const researchStep = blueprint.plan.steps.at(0);
          const notifyStep = blueprint.plan.steps.at(1);
          const reviewStep = blueprint.plan.steps.at(2);
          if (
            researchStep === undefined ||
            notifyStep === undefined ||
            reviewStep === undefined
          ) {
            throw new Error("Fixture planner returned too few steps.");
          }

          return DynamicWorkflowBlueprintSchema.parse({
            ...blueprint,
            machine: {
              ...blueprint.machine,
              xstate: {
                id: blueprint.machine.machineId,
                initial: "researchReview",
                states: {
                  notifyReviewChannel: {
                    meta: {
                      stepId: notifyStep.stepId,
                      stepKind: notifyStep.kind,
                      summary: notifyStep.summary,
                    },
                    on: {
                      NEXT: {
                        target: "reviewSummary",
                      },
                    },
                  },
                  researchReview: {
                    meta: {
                      stepId: researchStep.stepId,
                      stepKind: researchStep.kind,
                      summary: researchStep.summary,
                    },
                    on: {
                      NEXT: {
                        target: "notifyReviewChannel",
                      },
                    },
                  },
                  reviewSummary: {
                    meta: {
                      stepId: reviewStep.stepId,
                      stepKind: reviewStep.kind,
                      summary: reviewStep.summary,
                    },
                    on: {},
                    type: "final",
                  },
                },
              },
            },
          });
        },
      },
      executionMode: "integration-test",
      observabilityRecorder: createCloudflareArtifactsObservabilityRecorder({
        artifacts,
      }),
      packageRegistry: createMemoryPackageRegistryActor(
        integrationTestPackageMetadata
      ),
      reviewGate: createMemoryReviewGateActor(artifacts),
      reviewSurfacePublisher: createCloudflareArtifactsReviewSurfacePublisher({
        artifacts,
      }),
      statusProjection: createMemoryWorkflowStatusProjectionStore(),
      wzrrdPublisher: createDryRunWzrrdPublishAdapter(),
      wzrrdSecretRefs: {
        dryRun: "secretref:wzrrd-dry-run",
        publish: "secretref:wzrrd-api",
      },
      wzrrdSiteRef: "wzrrd:test",
    });

    const result = await workflow.run(buildIntegrationTestRunRequest());

    expect({
      blocker: result.status === "blocked" ? result.blocker : undefined,
      lastSummary: result.eventLog.at(-1)?.summary,
      status: result.status,
    }).toStrictEqual({
      blocker: {
        code: "capability_denied",
        message:
          "Generated XState initial state must be a ready state, not an executable step.",
        redacted: true,
      },
      lastSummary: "Pinned generated workflow machine failed validation.",
      status: "blocked",
    });
  });

  it("blocks generated workflow node invocations until a node adapter is configured", async () => {
    const artifacts = createMemoryArtifactStore("workflow-app-node-no-adapter");
    const planner = createIntegrationTestDynamicWorkflowPlanner();
    const workflow = new WorkflowApp({
      artifacts,
      capabilityLeases: createPolicyCapabilityLeaseBroker(artifacts, {
        discordSecretRef: "secretref:discord-bot",
        policyId: "discord-message-policy",
      }),
      contextCapsules: createMemoryContextCapsuleActor(),
      discordMessages: createDryRunDiscordMessageAdapter(),
      discordSecretRefs: {
        dryRun: "secretref:discord-dry-run",
        send: "secretref:discord-bot",
      },
      dynamicWorkflowPlanner: {
        async proposePlan(input) {
          return addWorkflowNodeToBlueprint(await planner.proposePlan(input));
        },
      },
      executionMode: "integration-test",
      observabilityRecorder: createCloudflareArtifactsObservabilityRecorder({
        artifacts,
      }),
      packageRegistry: createMemoryPackageRegistryActor(
        integrationTestPackageMetadata
      ),
      reviewGate: createMemoryReviewGateActor(artifacts),
      reviewSurfacePublisher: createCloudflareArtifactsReviewSurfacePublisher({
        artifacts,
      }),
      statusProjection: createMemoryWorkflowStatusProjectionStore(),
      wzrrdPublisher: createDryRunWzrrdPublishAdapter(),
      wzrrdSecretRefs: {
        dryRun: "secretref:wzrrd-dry-run",
        publish: "secretref:wzrrd-api",
      },
      wzrrdSiteRef: "wzrrd:test",
    });

    const result = await workflow.run(buildIntegrationTestRunRequest());

    expect({
      blocker: result.status === "blocked" ? result.blocker : undefined,
      lastSummary: result.eventLog.at(-1)?.summary,
      status: result.status,
    }).toStrictEqual({
      blocker: {
        code: "adapter_unavailable",
        message: "Workflow node adapter is not configured.",
        redacted: true,
      },
      lastSummary: "Workflow node adapter step failed.",
      status: "blocked",
    });
  });

  it("executes generated workflow node invocations through a package-style node adapter", async () => {
    const artifacts = createMemoryArtifactStore("workflow-app-node-adapter");
    const planner = createIntegrationTestDynamicWorkflowPlanner();
    const delegateWorkflowNodeAdapter: WorkflowNodeAdapterPort = {
      async execute(input) {
        const write = await artifacts.writeJson({
          path: input.step.outputPath,
          redacted: true,
          runId: input.plan.runId,
          value: {
            dependencyArtifactRefs: input.dependencyArtifactRefs,
            nodeType: input.step.nodeType,
            redacted: true,
            runId: input.plan.runId,
            schemaVersion: "workflow.node-fixture-output.v1",
            stepId: input.step.stepId,
            workItemId: input.plan.workItemId,
          },
        });

        return {
          outputRefs: [write.artifactRef],
          status: "executed",
        };
      },
    };
    const workflowNodeAdapter = createArtifactBackedWorkflowCartridgeAdapter({
      artifacts,
      delegate: delegateWorkflowNodeAdapter,
      now: () => "2026-06-09T20:00:00.000Z",
    });
    const workflow = new WorkflowApp({
      artifacts,
      capabilityLeases: createPolicyCapabilityLeaseBroker(artifacts, {
        discordSecretRef: "secretref:discord-bot",
        policyId: "discord-message-policy",
      }),
      contextCapsules: createMemoryContextCapsuleActor(),
      discordMessages: createDryRunDiscordMessageAdapter(),
      discordSecretRefs: {
        dryRun: "secretref:discord-dry-run",
        send: "secretref:discord-bot",
      },
      dynamicWorkflowPlanner: {
        async proposePlan(input) {
          return addWorkflowNodeToBlueprint(await planner.proposePlan(input));
        },
      },
      executionMode: "integration-test",
      observabilityRecorder: createCloudflareArtifactsObservabilityRecorder({
        artifacts,
      }),
      packageRegistry: createMemoryPackageRegistryActor(
        integrationTestPackageMetadata
      ),
      reviewGate: createMemoryReviewGateActor(artifacts),
      reviewSurfacePublisher: createCloudflareArtifactsReviewSurfacePublisher({
        artifacts,
      }),
      statusProjection: createMemoryWorkflowStatusProjectionStore(),
      workflowNodeAdapter,
      wzrrdPublisher: createDryRunWzrrdPublishAdapter(),
      wzrrdSecretRefs: {
        dryRun: "secretref:wzrrd-dry-run",
        publish: "secretref:wzrrd-api",
      },
      wzrrdSiteRef: "wzrrd:test",
    });

    const result = await workflow.run(buildIntegrationTestRunRequest());
    if (result.status !== "captured") {
      throw new Error(result.blocker.message);
    }

    const nodeOutputRef = result.artifactRefs.find((artifactRef) =>
      artifactRef.endsWith("/nodes/integration-fixture-output.json")
    );
    if (nodeOutputRef === undefined) {
      throw new Error("Expected workflow node output artifact.");
    }
    const cartridgeProofRef = result.artifactRefs.find((artifactRef) =>
      artifactRef.endsWith(
        "/run/workflow-node-cartridges/invoke-integration-node.json"
      )
    );
    if (cartridgeProofRef === undefined) {
      throw new Error("Expected workflow cartridge proof artifact.");
    }
    const nodeOutput = await artifacts.readJson({ artifactRef: nodeOutputRef });
    const cartridgeProof = WorkflowCartridgeInvocationProofDocumentSchema.parse(
      await artifacts.readJson({ artifactRef: cartridgeProofRef })
    );
    const executionProof = WorkflowExecutionProofDocumentSchema.parse(
      await artifacts.readJson({
        artifactRef: result.executionProofArtifact.artifactRef,
      })
    );

    expect({
      cartridgeProof: {
        contractRef: cartridgeProof.contractRef,
        exportId: cartridgeProof.exportId,
        nodeType: cartridgeProof.nodeType,
        packageId: cartridgeProof.packageId,
        packageRef: cartridgeProof.packageRef,
        schemaVersion: cartridgeProof.schemaVersion,
        status: cartridgeProof.status,
        verification: cartridgeProof.verification,
        verifiedAt: cartridgeProof.verifiedAt,
      },
      completedStepIds: executionProof.completedStepIds,
      executionProofStatus: executionProof.status,
      nodeOutput,
    }).toStrictEqual({
      cartridgeProof: {
        contractRef: "contract://workflow/nodes/integration-fixture.v1",
        exportId: "integration-fixture-node",
        nodeType: "com.joelclaw.integration-fixture",
        packageId: "workflow/research-review-discord",
        packageRef:
          "artifact://packages/workflows/research-review-discord/refs/v1",
        schemaVersion: "workflow.cartridge-invocation-proof.v1",
        status: "verified",
        verification: {
          exportMatched: true,
          nodeTypeMatched: true,
          packagePinned: true,
          sideEffectsRequireLeases: true,
        },
        verifiedAt: "2026-06-09T20:00:00.000Z",
      },
      completedStepIds: [
        "invoke-integration-node",
        "research-review",
        "notify-review-channel",
        "review-summary",
      ],
      executionProofStatus: "not-proven-local-integration",
      nodeOutput: {
        dependencyArtifactRefs: {},
        nodeType: "com.joelclaw.integration-fixture",
        redacted: true,
        runId: result.runId,
        schemaVersion: "workflow.node-fixture-output.v1",
        stepId: "invoke-integration-node",
        workItemId: "work-item:integration-test-research-review",
      },
    });
  });

  it("blocks generated Dream preflight steps until an executor adapter exists", async () => {
    const artifacts = createMemoryArtifactStore(
      "workflow-app-dream-step-no-adapter"
    );
    const planner = createIntegrationTestDynamicWorkflowPlanner();
    const workflow = new WorkflowApp({
      artifacts,
      capabilityLeases: createPolicyCapabilityLeaseBroker(artifacts, {
        discordSecretRef: "secretref:discord-bot",
        policyId: "discord-message-policy",
      }),
      contextCapsules: createMemoryContextCapsuleActor(),
      discordMessages: createDryRunDiscordMessageAdapter(),
      discordSecretRefs: {
        dryRun: "secretref:discord-dry-run",
        send: "secretref:discord-bot",
      },
      dynamicWorkflowPlanner: {
        async proposePlan(input) {
          return addDreamPreflightToBlueprint(await planner.proposePlan(input));
        },
      },
      executionMode: "integration-test",
      observabilityRecorder: createCloudflareArtifactsObservabilityRecorder({
        artifacts,
      }),
      packageRegistry: createMemoryPackageRegistryActor(
        integrationTestPackageMetadata
      ),
      reviewGate: createMemoryReviewGateActor(artifacts),
      reviewSurfacePublisher: createCloudflareArtifactsReviewSurfacePublisher({
        artifacts,
      }),
      statusProjection: createMemoryWorkflowStatusProjectionStore(),
      wzrrdPublisher: createDryRunWzrrdPublishAdapter(),
      wzrrdSecretRefs: {
        dryRun: "secretref:wzrrd-dry-run",
        publish: "secretref:wzrrd-api",
      },
      wzrrdSiteRef: "wzrrd:test",
    });

    const result = await workflow.run(buildIntegrationTestRunRequest());

    expect({
      blocker: result.status === "blocked" ? result.blocker : undefined,
      lastSummary: result.eventLog.at(-1)?.summary,
      status: result.status,
    }).toStrictEqual({
      blocker: {
        code: "adapter_unavailable",
        message: "Workflow node adapter is not configured.",
        redacted: true,
      },
      lastSummary: "Workflow node adapter step failed.",
      status: "blocked",
    });
  });

  it("executes generated Dream preflight steps through the configured memory fabric adapter", async () => {
    const artifacts = createMemoryArtifactStore(
      "workflow-app-dream-step-adapter"
    );
    const planner = createIntegrationTestDynamicWorkflowPlanner();
    const request = buildIntegrationTestDreamRunRequest();
    const hitlDecisionInputRef = artifacts.artifactRef({
      path: "dream/hitl-decision.json",
      runId: request.runId,
    });
    await artifacts.writeJson({
      path: "dream/hitl-decision.json",
      redacted: true,
      runId: request.runId,
      value: integrationTestDreamHitlDecisionDocument({
        backfillRunRef: artifacts.artifactRef({
          path: "dream/backfill-run-receipt.json",
          runId: request.runId,
        }),
        refinementProposalRef: artifacts.artifactRef({
          path: "dream/refinement-proposals.json",
          runId: request.runId,
        }),
        reportRef: artifacts.artifactRef({
          path: "dream/hitl-report.json",
          runId: request.runId,
        }),
        runId: request.runId,
        workItemId: request.workItemId,
      }),
    });
    const workflow = new WorkflowApp({
      artifacts,
      capabilityLeases: createPolicyCapabilityLeaseBroker(artifacts, {
        discordSecretRef: "secretref:discord-bot",
        policyId: "discord-message-policy",
      }),
      contextCapsules: createMemoryContextCapsuleActor(),
      discordMessages: createDryRunDiscordMessageAdapter(),
      discordSecretRefs: {
        dryRun: "secretref:discord-dry-run",
        send: "secretref:discord-bot",
      },
      dynamicWorkflowPlanner: {
        async proposePlan(input) {
          return addDreamPreflightToBlueprint(
            await planner.proposePlan(input),
            {
              hitlDecisionInputRef,
            }
          );
        },
      },
      executionMode: "integration-test",
      observabilityRecorder: createCloudflareArtifactsObservabilityRecorder({
        artifacts,
      }),
      packageRegistry: createMemoryPackageRegistryActor(
        dreamIntegrationPackages
      ),
      postExecutionArtifactRecorders: [
        createDreamGeneratedWorkflowProofRecorder({
          artifacts,
          expectedPackageRef: dreamWorkflowPackageRef,
          expectedSourceProfile: dreamTranscriptReviewSourceProfile,
          expectedSourceProfileExportId:
            "dream-transcript-review-source-profile",
          now: () => "2026-06-09T21:30:00.000Z",
        }),
      ],
      reviewGate: createMemoryReviewGateActor(artifacts),
      reviewSurfacePublisher: createCloudflareArtifactsReviewSurfacePublisher({
        artifacts,
      }),
      statusProjection: createMemoryWorkflowStatusProjectionStore(),
      workflowNodeAdapter: createArtifactBackedWorkflowCartridgeAdapter({
        artifacts,
        delegate: createDreamMemoryFabricWorkflowNodeAdapter({
          artifacts,
          dreamMemoryBackfill: createIntegrationTestDreamMemoryFabricAdapter(),
          dreamMemoryCapture: createIntegrationTestDreamMemoryFabricAdapter(),
          dreamMemoryCorrelation:
            createIntegrationTestDreamMemoryCorrelationAdapter(),
          dreamMemoryFabric: createIntegrationTestDreamMemoryFabricAdapter(),
          dreamMemoryRetrieval:
            createIntegrationTestDreamMemoryRetrievalAdapter(),
          dreamMemorySignals:
            createIntegrationTestDreamMemoryRetrievalAdapter(),
        }),
        now: () => "2026-06-09T21:00:00.000Z",
      }),
      wzrrdPublisher: createDryRunWzrrdPublishAdapter(),
      wzrrdSecretRefs: {
        dryRun: "secretref:wzrrd-dry-run",
        publish: "secretref:wzrrd-api",
      },
      wzrrdSiteRef: "wzrrd:test",
    });

    const result = await workflow.run(request);
    if (result.status !== "captured") {
      throw new Error(result.blocker.message);
    }

    const inventoryRef = result.artifactRefs.find((artifactRef) =>
      artifactRef.endsWith("/dream/source-inventory.json")
    );
    const healthRef = result.artifactRefs.find((artifactRef) =>
      artifactRef.endsWith("/dream/source-health.json")
    );
    const backfillRef = result.artifactRefs.find((artifactRef) =>
      artifactRef.endsWith("/dream/backfill-plan.json")
    );
    const backfillRunRef = result.artifactRefs.find((artifactRef) =>
      artifactRef.endsWith("/dream/backfill-run-receipt.json")
    );
    const captureRunRef = result.artifactRefs.find((artifactRef) =>
      artifactRef.endsWith("/dream/capture-run.json")
    );
    const signalsRef = result.artifactRefs.find((artifactRef) =>
      artifactRef.endsWith("/dream/signals.json")
    );
    const searchRef = result.artifactRefs.find((artifactRef) =>
      artifactRef.endsWith("/dream/memory-search.json")
    );
    const hydrationRef = result.artifactRefs.find((artifactRef) =>
      artifactRef.endsWith("/dream/hydration.json")
    );
    const correlationRef = result.artifactRefs.find((artifactRef) =>
      artifactRef.endsWith("/dream/correlation-graph.json")
    );
    const refinementRef = result.artifactRefs.find((artifactRef) =>
      artifactRef.endsWith("/dream/refinement-proposals.json")
    );
    const reportRef = result.artifactRefs.find((artifactRef) =>
      artifactRef.endsWith("/dream/hitl-report.json")
    );
    const reportMdsvxRef = result.artifactRefs.find((artifactRef) =>
      artifactRef.endsWith("/dream/hitl-report.mdsvx")
    );
    const hitlDecisionSeedRef = result.artifactRefs.find((artifactRef) =>
      artifactRef.endsWith("/dream/hitl-decision-workflow-seed.json")
    );
    const hitlFollowUpRef = result.artifactRefs.find((artifactRef) =>
      artifactRef.endsWith("/dream/hitl-follow-up-run-request.json")
    );
    const captureArtifactRef = result.artifactRefs.find((artifactRef) =>
      artifactRef.endsWith("/dream/capture-artifact.json")
    );
    const wzrrdPayloadRef = result.artifactRefs.find((artifactRef) =>
      artifactRef.endsWith("/payloads/wzrrd-publish.json")
    );
    const cartridgeProofRefs = requireArtifactRefList(
      "cartridge proofs",
      [
        "inventory-memory-fabric",
        "check-source-health",
        "plan-recovery-backfills",
        "run-recovery-backfills",
        "capture-dream-run",
        "mine-dream-signals",
        "search-dream-memory",
        "hydrate-dream-evidence",
        "correlate-dream-evidence",
        "propose-dream-refinements",
        "render-dream-hitl-report",
        "seed-next-workflow-from-hitl",
        "draft-follow-up-run-request-from-hitl",
        "capture-dream-report-artifact",
      ].map((stepId) =>
        result.artifactRefs.find((artifactRef) =>
          artifactRef.endsWith(`/run/workflow-node-cartridges/${stepId}.json`)
        )
      )
    );
    const dreamRefs = {
      backfillRef: requireArtifactRef("backfillRef", backfillRef),
      backfillRunRef: requireArtifactRef("backfillRunRef", backfillRunRef),
      captureArtifactRef: requireArtifactRef(
        "captureArtifactRef",
        captureArtifactRef
      ),
      captureRunRef: requireArtifactRef("captureRunRef", captureRunRef),
      correlationRef: requireArtifactRef("correlationRef", correlationRef),
      healthRef: requireArtifactRef("healthRef", healthRef),
      hitlDecisionInputRef,
      hitlDecisionSeedRef: requireArtifactRef(
        "hitlDecisionSeedRef",
        hitlDecisionSeedRef
      ),
      hitlFollowUpRef: requireArtifactRef("hitlFollowUpRef", hitlFollowUpRef),
      hydrationRef: requireArtifactRef("hydrationRef", hydrationRef),
      inventoryRef: requireArtifactRef("inventoryRef", inventoryRef),
      refinementRef: requireArtifactRef("refinementRef", refinementRef),
      reportMdsvxRef: requireArtifactRef("reportMdsvxRef", reportMdsvxRef),
      reportRef: requireArtifactRef("reportRef", reportRef),
      searchRef: requireArtifactRef("searchRef", searchRef),
      signalsRef: requireArtifactRef("signalsRef", signalsRef),
      wzrrdPayloadRef: requireArtifactRef("wzrrdPayloadRef", wzrrdPayloadRef),
    };

    const inventory = DreamSourceInventoryDocumentSchema.parse(
      await artifacts.readJson({ artifactRef: dreamRefs.inventoryRef })
    );
    const health = DreamSourceHealthDocumentSchema.parse(
      await artifacts.readJson({ artifactRef: dreamRefs.healthRef })
    );
    const backfill = DreamBackfillPlanDocumentSchema.parse(
      await artifacts.readJson({ artifactRef: dreamRefs.backfillRef })
    );
    const backfillRun = DreamBackfillRunReceiptDocumentSchema.parse(
      await artifacts.readJson({ artifactRef: dreamRefs.backfillRunRef })
    );
    const captureRun = DreamCaptureReceiptDocumentSchema.parse(
      await artifacts.readJson({ artifactRef: dreamRefs.captureRunRef })
    );
    const signals = DreamSignalDocumentSchema.parse(
      await artifacts.readJson({ artifactRef: dreamRefs.signalsRef })
    );
    const search = DreamMemorySearchDocumentSchema.parse(
      await artifacts.readJson({ artifactRef: dreamRefs.searchRef })
    );
    const hydration = DreamHydrationDocumentSchema.parse(
      await artifacts.readJson({ artifactRef: dreamRefs.hydrationRef })
    );
    const correlation = DreamCorrelationGraphDocumentSchema.parse(
      await artifacts.readJson({ artifactRef: dreamRefs.correlationRef })
    );
    const refinement = DreamRefinementProposalDocumentSchema.parse(
      await artifacts.readJson({ artifactRef: dreamRefs.refinementRef })
    );
    const report = DreamHitlReportDocumentSchema.parse(
      await artifacts.readJson({ artifactRef: dreamRefs.reportRef })
    );
    const hitlDecisionSeed = DreamHitlDecisionWorkflowSeedDocumentSchema.parse(
      await artifacts.readJson({ artifactRef: dreamRefs.hitlDecisionSeedRef })
    );
    const hitlFollowUp = DreamHitlFollowUpRunRequestDocumentSchema.parse(
      await artifacts.readJson({ artifactRef: dreamRefs.hitlFollowUpRef })
    );
    const captureArtifact = DreamCaptureReceiptDocumentSchema.parse(
      await artifacts.readJson({ artifactRef: dreamRefs.captureArtifactRef })
    );
    const reportMdsvx = await artifacts.readText({
      artifactRef: dreamRefs.reportMdsvxRef,
    });
    const wzrrdPayload = WzrrdPublishPayloadSchema.parse(
      await artifacts.readJson({ artifactRef: dreamRefs.wzrrdPayloadRef })
    );
    const cartridgeProofs = [];
    for (const artifactRef of cartridgeProofRefs) {
      if (artifactRef === undefined) {
        throw new Error("Expected Dream cartridge proof ref.");
      }
      cartridgeProofs.push(
        WorkflowCartridgeInvocationProofDocumentSchema.parse(
          artifacts.records.get(artifactRef)?.value
        )
      );
    }
    const executionProof = WorkflowExecutionProofDocumentSchema.parse(
      await artifacts.readJson({
        artifactRef: result.executionProofArtifact.artifactRef,
      })
    );
    const generatedWorkflowProofRef = result.artifactRefs.find((artifactRef) =>
      artifactRef.endsWith("/dream/generated-workflow-proof.json")
    );
    if (generatedWorkflowProofRef === undefined) {
      throw new Error("Expected Dream generated workflow proof artifact.");
    }
    const generatedWorkflowProof =
      DreamGeneratedWorkflowProofDocumentSchema.parse(
        await artifacts.readJson({
          artifactRef: generatedWorkflowProofRef,
        })
      );
    const plan = DynamicWorkflowPlanDocumentSchema.parse(
      await artifacts.readJson({
        artifactRef: result.planArtifact.artifactRef,
      })
    );
    const machine = DynamicWorkflowMachineDocumentSchema.parse(
      await artifacts.readJson({
        artifactRef: result.machineArtifact.artifactRef,
      })
    );
    const cloudflareExecutionProofWithoutRelaySidecars =
      WorkflowExecutionProofDocumentSchema.parse({
        ...executionProof,
        cloudflare: {
          platform: "cloudflare-workers",
          workerName: "pi-sandbox-workflows-test",
        },
        platform: "cloudflare-workers",
        status: "cloudflare-generated-machine-executed",
        verificationResultRef: `artifact://workflow-app-dream-step-adapter/runs/${result.runId}/verification-result.json`,
      });
    const cloudflareProofWithoutRelaySidecars = verifyDreamGeneratedWorkflow({
      executionProof: cloudflareExecutionProofWithoutRelaySidecars,
      executionProofRef: result.executionProofArtifact.artifactRef,
      expectedPackageRef: dreamWorkflowPackageRef,
      expectedSourceProfile: dreamTranscriptReviewSourceProfile,
      expectedSourceProfileExportId: "dream-transcript-review-source-profile",
      generatedAt: "2026-06-09T21:45:00.000Z",
      harnessArtifact: result.harnessArtifact,
      harnessSource: await artifacts.readText({
        artifactRef: result.harnessArtifact.artifactRef,
      }),
      machine,
      machineArtifact: result.machineArtifact,
      machineSource: await artifacts.readText({
        artifactRef: result.machineArtifact.sourceArtifactRef,
      }),
      plan,
      planArtifact: result.planArtifact,
    });
    const planWithoutSourceProfile = DynamicWorkflowPlanDocumentSchema.parse({
      ...plan,
      proposal: {
        ...plan.proposal,
        stochasticNotes: [],
      },
    });
    const proofWithoutSourceProfile = verifyDreamGeneratedWorkflow({
      executionProof,
      executionProofRef: result.executionProofArtifact.artifactRef,
      expectedPackageRef: dreamWorkflowPackageRef,
      expectedSourceProfile: dreamTranscriptReviewSourceProfile,
      expectedSourceProfileExportId: "dream-transcript-review-source-profile",
      generatedAt: "2026-06-09T21:46:00.000Z",
      harnessArtifact: result.harnessArtifact,
      harnessSource: await artifacts.readText({
        artifactRef: result.harnessArtifact.artifactRef,
      }),
      machine,
      machineArtifact: result.machineArtifact,
      machineSource: await artifacts.readText({
        artifactRef: result.machineArtifact.sourceArtifactRef,
      }),
      plan: planWithoutSourceProfile,
      planArtifact: {
        ...result.planArtifact,
        hash: hashJson(planWithoutSourceProfile),
      },
    });
    const planWithoutHorizonCoverage = DynamicWorkflowPlanDocumentSchema.parse({
      ...plan,
      steps: plan.steps.map((step) => {
        if (step.kind !== "workflow.node.invoke") {
          return step;
        }

        return {
          ...step,
          config: Object.fromEntries(
            Object.entries(step.config).filter(
              ([key]) => key !== "dreamCoverageHorizons"
            )
          ),
        };
      }),
    });
    const proofWithoutHorizonCoverage = verifyDreamGeneratedWorkflow({
      executionProof,
      executionProofRef: result.executionProofArtifact.artifactRef,
      expectedPackageRef: dreamWorkflowPackageRef,
      expectedSourceProfile: dreamTranscriptReviewSourceProfile,
      expectedSourceProfileExportId: "dream-transcript-review-source-profile",
      generatedAt: "2026-06-09T21:46:30.000Z",
      harnessArtifact: result.harnessArtifact,
      harnessSource: await artifacts.readText({
        artifactRef: result.harnessArtifact.artifactRef,
      }),
      machine,
      machineArtifact: result.machineArtifact,
      machineSource: await artifacts.readText({
        artifactRef: result.machineArtifact.sourceArtifactRef,
      }),
      plan: planWithoutHorizonCoverage,
      planArtifact: {
        ...result.planArtifact,
        hash: hashJson(planWithoutHorizonCoverage),
      },
    });
    const planWithoutSourcePackDispositions =
      DynamicWorkflowPlanDocumentSchema.parse({
        ...plan,
        steps: plan.steps.map((step) => {
          if (step.kind !== "workflow.node.invoke") {
            return step;
          }

          return {
            ...step,
            config: Object.fromEntries(
              Object.entries(step.config).filter(
                ([key]) => key !== "dreamSourcePackDispositions"
              )
            ),
          };
        }),
      });
    const proofWithoutSourcePackDispositions = verifyDreamGeneratedWorkflow({
      executionProof,
      executionProofRef: result.executionProofArtifact.artifactRef,
      expectedPackageRef: dreamWorkflowPackageRef,
      expectedSourceProfile: dreamTranscriptReviewSourceProfile,
      expectedSourceProfileExportId: "dream-transcript-review-source-profile",
      generatedAt: "2026-06-09T21:46:45.000Z",
      harnessArtifact: result.harnessArtifact,
      harnessSource: await artifacts.readText({
        artifactRef: result.harnessArtifact.artifactRef,
      }),
      machine,
      machineArtifact: result.machineArtifact,
      machineSource: await artifacts.readText({
        artifactRef: result.machineArtifact.sourceArtifactRef,
      }),
      plan: planWithoutSourcePackDispositions,
      planArtifact: {
        ...result.planArtifact,
        hash: hashJson(planWithoutSourcePackDispositions),
      },
    });
    const planWithUnleasedSourcePackSelected =
      DynamicWorkflowPlanDocumentSchema.parse({
        ...plan,
        steps: plan.steps.map((step) => {
          if (
            step.kind !== "workflow.node.invoke" ||
            !Array.isArray(step.config["dreamSourcePackDispositions"])
          ) {
            return step;
          }

          const dispositions = DreamSourcePackDispositionSchema.array().parse(
            step.config["dreamSourcePackDispositions"]
          );

          return {
            ...step,
            config: {
              ...step.config,
              dreamSourcePackDispositions: dispositions.map((disposition) => {
                if (disposition.packId !== "source-pack:joelhooks:work-graph") {
                  return disposition;
                }

                return {
                  ...disposition,
                  capabilityKinds: [
                    "dream.memory.relay",
                    "github.read",
                    "linear.read",
                    "slack.search",
                  ],
                  leaseRefs: [],
                  missingCapabilityKinds: [],
                  status: "selected-with-lease",
                };
              }),
            },
          };
        }),
      });
    const proofWithUnleasedSourcePackSelected = verifyDreamGeneratedWorkflow({
      executionProof,
      executionProofRef: result.executionProofArtifact.artifactRef,
      expectedPackageRef: dreamWorkflowPackageRef,
      expectedSourceProfile: dreamTranscriptReviewSourceProfile,
      expectedSourceProfileExportId: "dream-transcript-review-source-profile",
      generatedAt: "2026-06-09T21:46:50.000Z",
      harnessArtifact: result.harnessArtifact,
      harnessSource: await artifacts.readText({
        artifactRef: result.harnessArtifact.artifactRef,
      }),
      machine,
      machineArtifact: result.machineArtifact,
      machineSource: await artifacts.readText({
        artifactRef: result.machineArtifact.sourceArtifactRef,
      }),
      plan: planWithUnleasedSourcePackSelected,
      planArtifact: {
        ...result.planArtifact,
        hash: hashJson(planWithUnleasedSourcePackSelected),
      },
    });
    const planWithoutRuntimeSourceCoverage =
      DynamicWorkflowPlanDocumentSchema.parse({
        ...plan,
        steps: plan.steps.map((step) => {
          if (
            step.kind !== "workflow.node.invoke" ||
            step.nodeType !== "joelclaw.dream.source-inventory"
          ) {
            return step;
          }

          return {
            ...step,
            config: Object.fromEntries(
              Object.entries(step.config).filter(
                ([key]) => key !== "requiredMachineIds"
              )
            ),
          };
        }),
      });
    const proofWithoutRuntimeSourceCoverage = verifyDreamGeneratedWorkflow({
      executionProof,
      executionProofRef: result.executionProofArtifact.artifactRef,
      expectedPackageRef: dreamWorkflowPackageRef,
      expectedSourceProfile: dreamTranscriptReviewSourceProfile,
      expectedSourceProfileExportId: "dream-transcript-review-source-profile",
      generatedAt: "2026-06-09T21:46:55.000Z",
      harnessArtifact: result.harnessArtifact,
      harnessSource: await artifacts.readText({
        artifactRef: result.harnessArtifact.artifactRef,
      }),
      machine,
      machineArtifact: result.machineArtifact,
      machineSource: await artifacts.readText({
        artifactRef: result.machineArtifact.sourceArtifactRef,
      }),
      plan: planWithoutRuntimeSourceCoverage,
      planArtifact: {
        ...result.planArtifact,
        hash: hashJson(planWithoutRuntimeSourceCoverage),
      },
    });
    const combinedBackfillPlan = DynamicWorkflowPlanDocumentSchema.parse({
      ...plan,
      steps: plan.steps.flatMap((step) => {
        if (step.stepId === "run-recovery-backfills") {
          return [];
        }

        if (
          step.kind === "workflow.node.invoke" &&
          step.stepId === "plan-recovery-backfills"
        ) {
          return [
            {
              ...step,
              config: {
                ...step.config,
                dreamEffects: ["backfill-plan", "backfill-run"],
              },
            },
          ];
        }

        return [step];
      }),
    });
    const missingBackfillRunPlan = DynamicWorkflowPlanDocumentSchema.parse({
      ...plan,
      steps: plan.steps.filter(
        (step) => step.stepId !== "run-recovery-backfills"
      ),
    });
    const machineWithoutBackfillRun =
      DynamicWorkflowMachineDocumentSchema.parse({
        ...machine,
        stepOrder: machine.stepOrder.filter(
          (stepId) => stepId !== "run-recovery-backfills"
        ),
        xstate: {
          ...machine.xstate,
          states: Object.fromEntries(
            Object.entries(machine.xstate.states).filter(
              ([, state]) => state.meta.stepId !== "run-recovery-backfills"
            )
          ),
        },
      });
    const executionProofWithoutBackfillRun =
      WorkflowExecutionProofDocumentSchema.parse({
        ...executionProof,
        completedStepIds: executionProof.completedStepIds.filter(
          (stepId) => stepId !== "run-recovery-backfills"
        ),
        machineArtifact: {
          ...executionProof.machineArtifact,
          hash: hashJson(machineWithoutBackfillRun),
        },
      });
    const combinedEffectProof = verifyDreamGeneratedWorkflow({
      executionProof: executionProofWithoutBackfillRun,
      executionProofRef: result.executionProofArtifact.artifactRef,
      expectedPackageRef: dreamWorkflowPackageRef,
      expectedSourceProfile: dreamTranscriptReviewSourceProfile,
      expectedSourceProfileExportId: "dream-transcript-review-source-profile",
      generatedAt: "2026-06-09T21:47:00.000Z",
      harnessArtifact: result.harnessArtifact,
      harnessSource: await artifacts.readText({
        artifactRef: result.harnessArtifact.artifactRef,
      }),
      machine: machineWithoutBackfillRun,
      machineArtifact: {
        ...result.machineArtifact,
        hash: hashJson(machineWithoutBackfillRun),
      },
      machineSource: await artifacts.readText({
        artifactRef: result.machineArtifact.sourceArtifactRef,
      }),
      plan: combinedBackfillPlan,
      planArtifact: {
        ...result.planArtifact,
        hash: hashJson(combinedBackfillPlan),
      },
    });
    const missingBackfillRunEffectProof = verifyDreamGeneratedWorkflow({
      executionProof: executionProofWithoutBackfillRun,
      executionProofRef: result.executionProofArtifact.artifactRef,
      expectedPackageRef: dreamWorkflowPackageRef,
      expectedSourceProfile: dreamTranscriptReviewSourceProfile,
      expectedSourceProfileExportId: "dream-transcript-review-source-profile",
      generatedAt: "2026-06-09T21:48:00.000Z",
      harnessArtifact: result.harnessArtifact,
      harnessSource: await artifacts.readText({
        artifactRef: result.harnessArtifact.artifactRef,
      }),
      machine: machineWithoutBackfillRun,
      machineArtifact: {
        ...result.machineArtifact,
        hash: hashJson(machineWithoutBackfillRun),
      },
      machineSource: await artifacts.readText({
        artifactRef: result.machineArtifact.sourceArtifactRef,
      }),
      plan: missingBackfillRunPlan,
      planArtifact: {
        ...result.planArtifact,
        hash: hashJson(missingBackfillRunPlan),
      },
    });

    expect({
      backfillMode: backfill.mode,
      backfillRunCaptureFixStatuses: backfillRun.captureFixResults.map(
        (captureFix) => captureFix.status
      ),
      backfillRunPlanRef: backfillRun.planRef.artifactRef,
      backfillRunStatuses: backfillRun.actionResults.map(
        (action) => action.status
      ),
      backfillStatus: backfill.status,
      captureArtifactKind: captureArtifact.captureKind,
      captureArtifactRef: captureArtifact.capturedRef.artifactRef,
      captureArtifactSourceSystem: captureArtifact.sourceSystem,
      captureRunCapturedRunId:
        captureRun.captureKind === "run" ? captureRun.capturedRunId : null,
      captureRunKind: captureRun.captureKind,
      captureRunRef: captureRun.capturedRef.artifactRef,
      captureRunSourceSystem: captureRun.sourceSystem,
      cartridgeProofs: cartridgeProofs.map((proof) => ({
        nodeType: proof.nodeType,
        packageId: proof.packageId,
        packageRef: proof.packageRef,
        status: proof.status,
        verification: proof.verification,
      })),
      cloudflareProofWithoutRelaySidecarsFailedChecks:
        cloudflareProofWithoutRelaySidecars.checks
          .filter((check) => check.status === "failed")
          .map((check) => check.checkId),
      cloudflareProofWithoutRelaySidecarsStatus:
        cloudflareProofWithoutRelaySidecars.status,
      combinedEffectProofCoveredEffects:
        combinedEffectProof.effectCoverage.coveredEffects,
      combinedEffectProofStatus: combinedEffectProof.status,
      combinedEffectProofStepCount: combinedEffectProof.stepCount,
      completedStepIds: executionProof.completedStepIds,
      correlationEdgeCount: correlation.edges.length,
      correlationNodeCount: correlation.nodes.length,
      correlationSchemaVersion: correlation.schemaVersion,
      dreamGeneratedProofArtifactRef: generatedWorkflowProofRef.endsWith(
        "/dream/generated-workflow-proof.json"
      ),
      dreamGeneratedProofCheckIds: generatedWorkflowProof.checks.map(
        (check) => check.checkId
      ),
      dreamGeneratedProofEffectCoverage: generatedWorkflowProof.effectCoverage,
      dreamGeneratedProofFailures: generatedWorkflowProof.failures,
      dreamGeneratedProofHorizonCoverage:
        generatedWorkflowProof.horizonCoverage,
      dreamGeneratedProofNodeTypes: generatedWorkflowProof.nodeTypes,
      dreamGeneratedProofRawTranscriptsReturned:
        generatedWorkflowProof.rawTranscriptsReturned,
      dreamGeneratedProofRelayLeaseRefs:
        generatedWorkflowProof.relayLeaseReceiptRefs,
      dreamGeneratedProofReportAuditCheck: generatedWorkflowProof.checks.find(
        (check) => check.checkId === "report:definition-of-done-audit"
      ),
      dreamGeneratedProofRuntimeSourceCoverage:
        generatedWorkflowProof.runtimeSourceCoverage,
      dreamGeneratedProofSourcePackDisposition:
        generatedWorkflowProof.sourcePackDisposition,
      dreamGeneratedProofSourceProfile: generatedWorkflowProof.sourceProfile,
      dreamGeneratedProofStatus: generatedWorkflowProof.status,
      dreamGeneratedProofStepCount: generatedWorkflowProof.stepCount,
      executionProofRelayLeaseRefs:
        executionProof.workflowNodeOutputRefs.filter((artifactRef) =>
          artifactRef.includes("/dream/relay-lease-receipts/")
        ),
      executionProofStatus: executionProof.status,
      healthInventoryRef: health.inventoryRef.artifactRef,
      healthStatus: health.status,
      hitlDecisionSeedAcceptedDecisionIds: hitlDecisionSeed.acceptedDecisionIds,
      hitlDecisionSeedActionableDecisionCount:
        hitlDecisionSeed.actionableDecisionCount,
      hitlDecisionSeedDecisionRef: hitlDecisionSeed.decisionRef,
      hitlDecisionSeedRequiredCapabilities:
        hitlDecisionSeed.nextWorkflowSeed.requiredCapabilityKinds,
      hitlDecisionSeedSchemaVersion: hitlDecisionSeed.schemaVersion,
      hitlDecisionSeedSourceRefs: hitlDecisionSeed.sourceRefs,
      hitlDecisionSeedStatus: hitlDecisionSeed.status,
      hitlDecisionSeedWorkItemDecisionIds: hitlDecisionSeed.workItemDecisionIds,
      hitlFollowUpActionableDecisionCount: hitlFollowUp.actionableDecisionCount,
      hitlFollowUpDecisionWorkflowSeedRef: hitlFollowUp.decisionWorkflowSeedRef,
      hitlFollowUpRequestRunIdStartsWith:
        hitlFollowUp.request?.runId.startsWith("run-dream-hitl-follow-up-") ??
        false,
      hitlFollowUpRequestWorkItemIdStartsWith:
        hitlFollowUp.request?.workItemId.startsWith(
          "work-item:dream-hitl-follow-up:"
        ) ?? false,
      hitlFollowUpRequestedPackageIds: hitlFollowUp.requestedPackageIds,
      hitlFollowUpRequiredCapabilityKinds: hitlFollowUp.requiredCapabilityKinds,
      hitlFollowUpSchemaVersion: hitlFollowUp.schemaVersion,
      hitlFollowUpStatus: hitlFollowUp.status,
      hitlFollowUpSubmitted: hitlFollowUp.submitted,
      hydratedReceiptCount: hydration.hydrated.length,
      inventoryRuntimeStatuses: inventory.runtimeCoverage.map(
        (coverage) => `${coverage.runtime}:${coverage.status}`
      ),
      missingBackfillRunEffectProofFailedChecks:
        missingBackfillRunEffectProof.checks
          .filter((check) => check.status === "failed")
          .map((check) => check.checkId),
      missingBackfillRunEffectProofStatus: missingBackfillRunEffectProof.status,
      plannedBackfillActions: backfill.actions.map((action) => action.actionId),
      proofWithUnleasedSourcePackSelectedFailedChecks:
        proofWithUnleasedSourcePackSelected.checks
          .filter((check) => check.status === "failed")
          .map((check) => check.checkId),
      proofWithUnleasedSourcePackSelectedStatus:
        proofWithUnleasedSourcePackSelected.status,
      proofWithoutHorizonCoverageFailedChecks:
        proofWithoutHorizonCoverage.checks
          .filter((check) => check.status === "failed")
          .map((check) => check.checkId),
      proofWithoutHorizonCoverageStatus: proofWithoutHorizonCoverage.status,
      proofWithoutRuntimeSourceCoverageFailedChecks:
        proofWithoutRuntimeSourceCoverage.checks
          .filter((check) => check.status === "failed")
          .map((check) => check.checkId),
      proofWithoutRuntimeSourceCoverageStatus:
        proofWithoutRuntimeSourceCoverage.status,
      proofWithoutSourcePackDispositionsFailedChecks:
        proofWithoutSourcePackDispositions.checks
          .filter((check) => check.status === "failed")
          .map((check) => check.checkId),
      proofWithoutSourcePackDispositionsStatus:
        proofWithoutSourcePackDispositions.status,
      proofWithoutSourceProfileFailedChecks: proofWithoutSourceProfile.checks
        .filter((check) => check.status === "failed")
        .map((check) => check.checkId),
      proofWithoutSourceProfileStatus: proofWithoutSourceProfile.status,
      refinementNextWorkflowProposalIds:
        refinement.nextWorkflowSeed.proposalIds,
      refinementProposalCount: refinement.proposalCount,
      refinementRecommendationKinds: refinement.proposals.map(
        (proposal) => `${proposal.targetKind}:${proposal.recommendation}`
      ),
      refinementSourceRefs: refinement.sourceRefs,
      reportDefinitionOfDoneAuditItems: report.definitionOfDoneAudit.items.map(
        (item) => `${item.requirementId}:${item.status}`
      ),
      reportDefinitionOfDoneAuditStatus: report.definitionOfDoneAudit.status,
      reportDefinitionOfDoneAuditSummary: report.definitionOfDoneAudit.summary,
      reportDreamCount: report.dreamCount,
      reportHitlDecisionContract: report.hitlDecisionContract,
      reportMdsvxIncludesAccessAdapter: report.mdsvx.includes(
        "## Access adapter shape"
      ),
      reportMdsvxIncludesD2: report.mdsvx.includes("```d2"),
      reportMdsvxIncludesD2Fig: report.mdsvx.includes("<D2Fig"),
      reportMdsvxIncludesD2FigAspectRatio: report.mdsvx.includes(
        `aspectRatio="${report.proof.stateMachineFigure.aspectRatio}"`
      ),
      reportMdsvxIncludesDefinitionAudit: report.mdsvx.includes(
        "## Definition of done audit"
      ),
      reportMdsvxIncludesDreamsFirst: report.mdsvx.includes(
        "## The actual dreams"
      ),
      reportMdsvxIncludesDynamicProof: report.mdsvx.includes(
        "## Dynamic generation proof"
      ),
      reportMdsvxIncludesGeneratedHarnessRef: report.mdsvx.includes(
        result.harnessArtifact.artifactRef
      ),
      reportMdsvxIncludesGeneratedMachineRef: report.mdsvx.includes(
        result.machineArtifact.artifactRef
      ),
      reportMdsvxIncludesGeneratedMachineSourceRef: report.mdsvx.includes(
        result.machineArtifact.sourceArtifactRef
      ),
      reportMdsvxIncludesHitlDecisionContract: report.mdsvx.includes(
        "dream.hitl-decision.v1"
      ),
      reportMdsvxIncludesRefinement: report.mdsvx.includes(
        "Refinement proposals emitted: 7."
      ),
      reportMdsvxIncludesReportNode: report.mdsvx.includes("## Report node"),
      reportMdsvxIncludesReportStandard:
        report.mdsvx.includes("## Report standard"),
      reportMdsvxIncludesRunCoverage: report.mdsvx.includes("## Run coverage"),
      reportMdsvxIncludesWhatDidNotHappen: report.mdsvx.includes(
        "## What did not happen"
      ),
      reportMdsvxNoCandidateReview: !report.mdsvx.includes("Candidate review"),
      reportMdsvxPutsDreamsBeforeProof:
        report.mdsvx.indexOf("## The actual dreams") <
        report.mdsvx.indexOf("## Dynamic generation proof"),
      reportMdsvxRefPublished: wzrrdPayload.primaryDocument?.artifactRef,
      reportMdsvxSourceMatchesJson: reportMdsvx === report.mdsvx,
      reportProofGeneratedArtifacts: report.proof.generatedArtifacts,
      reportProofLevel: report.proof.dynamicGenerationProofLevel,
      reportRawTranscriptsReturned: report.proof.rawTranscriptsReturned,
      reportRefinementProposalCount: report.refinementProposalCount,
      reportRefinementProposalRef: report.refinementProposalRef,
      reportSectionOrder: report.sectionOrder,
      reportSourceRefs: report.sourceRefs,
      reportStateMachineFigure: {
        aspectRatio: report.proof.stateMachineFigure.aspectRatio,
        machineBinding: report.proof.stateMachineFigure.machineBinding,
        machineId: report.proof.stateMachineFigure.machineId,
        sourceHasFirstDreamStep:
          report.proof.stateMachineFigure.source.includes(
            "inventory-memory-fabric"
          ),
        sourceHasStaticDreamLabel:
          report.proof.stateMachineFigure.source.includes("Source inventory"),
        sourceHashMatches:
          report.proof.stateMachineFigure.sourceHash ===
          sha256Hex(report.proof.stateMachineFigure.source),
        sourceKind: report.proof.stateMachineFigure.sourceKind,
        stateCount: report.proof.stateMachineFigure.stateCount,
        transitionCount: report.proof.stateMachineFigure.transitionCount,
      },
      reportTemplate: `${report.template.templateId}@${report.template.version}`,
      searchHitCount: search.hits.length,
      searchReceiptFamilies: search.hits.flatMap((hit) =>
        hit.receipts.map((receipt) => receipt.family)
      ),
      signalKinds: signals.signals.map((signal) => signal.kind),
      signalReceiptFamilies: signals.signals.flatMap((signal) =>
        signal.receipts.map((receipt) => receipt.family)
      ),
      wzrrdPrimaryDocument: wzrrdPayload.primaryDocument,
    }).toStrictEqual({
      backfillMode: "recovery-not-normal-operation",
      backfillRunCaptureFixStatuses: ["skipped"],
      backfillRunPlanRef: dreamRefs.backfillRef,
      backfillRunStatuses: ["skipped"],
      backfillStatus: "backfill-required",
      captureArtifactKind: "artifact",
      captureArtifactRef: dreamRefs.reportRef,
      captureArtifactSourceSystem: "cloudflare-artifacts",
      captureRunCapturedRunId: result.runId,
      captureRunKind: "run",
      captureRunRef: `artifact://integration-dream/runs/${result.runId}/capture/run.json`,
      captureRunSourceSystem: "cloudflare-workflow-run",
      cartridgeProofs: [
        {
          nodeType: "joelclaw.dream.source-inventory",
          packageId: "workflow/dream-memory-fabric",
          packageRef: dreamWorkflowPackageRef,
          status: "verified",
          verification: {
            exportMatched: true,
            nodeTypeMatched: true,
            packagePinned: true,
            sideEffectsRequireLeases: true,
          },
        },
        {
          nodeType: "joelclaw.dream.source-health",
          packageId: "workflow/dream-memory-fabric",
          packageRef: dreamWorkflowPackageRef,
          status: "verified",
          verification: {
            exportMatched: true,
            nodeTypeMatched: true,
            packagePinned: true,
            sideEffectsRequireLeases: true,
          },
        },
        {
          nodeType: "joelclaw.dream.backfill-plan",
          packageId: "workflow/dream-memory-fabric",
          packageRef: dreamWorkflowPackageRef,
          status: "verified",
          verification: {
            exportMatched: true,
            nodeTypeMatched: true,
            packagePinned: true,
            sideEffectsRequireLeases: true,
          },
        },
        {
          nodeType: "joelclaw.dream.backfill-run",
          packageId: "workflow/dream-memory-fabric",
          packageRef: dreamWorkflowPackageRef,
          status: "verified",
          verification: {
            exportMatched: true,
            nodeTypeMatched: true,
            packagePinned: true,
            sideEffectsRequireLeases: true,
          },
        },
        {
          nodeType: "joelclaw.dream.capture-run",
          packageId: "workflow/dream-memory-fabric",
          packageRef: dreamWorkflowPackageRef,
          status: "verified",
          verification: {
            exportMatched: true,
            nodeTypeMatched: true,
            packagePinned: true,
            sideEffectsRequireLeases: true,
          },
        },
        {
          nodeType: "joelclaw.dream.signals",
          packageId: "workflow/dream-memory-fabric",
          packageRef: dreamWorkflowPackageRef,
          status: "verified",
          verification: {
            exportMatched: true,
            nodeTypeMatched: true,
            packagePinned: true,
            sideEffectsRequireLeases: true,
          },
        },
        {
          nodeType: "joelclaw.dream.memory-search",
          packageId: "workflow/dream-memory-fabric",
          packageRef: dreamWorkflowPackageRef,
          status: "verified",
          verification: {
            exportMatched: true,
            nodeTypeMatched: true,
            packagePinned: true,
            sideEffectsRequireLeases: true,
          },
        },
        {
          nodeType: "joelclaw.dream.hydrate",
          packageId: "workflow/dream-memory-fabric",
          packageRef: dreamWorkflowPackageRef,
          status: "verified",
          verification: {
            exportMatched: true,
            nodeTypeMatched: true,
            packagePinned: true,
            sideEffectsRequireLeases: true,
          },
        },
        {
          nodeType: "joelclaw.dream.correlate",
          packageId: "workflow/dream-memory-fabric",
          packageRef: dreamWorkflowPackageRef,
          status: "verified",
          verification: {
            exportMatched: true,
            nodeTypeMatched: true,
            packagePinned: true,
            sideEffectsRequireLeases: true,
          },
        },
        {
          nodeType: "joelclaw.dream.refinement-proposals",
          packageId: "workflow/dream-memory-fabric",
          packageRef: dreamWorkflowPackageRef,
          status: "verified",
          verification: {
            exportMatched: true,
            nodeTypeMatched: true,
            packagePinned: true,
            sideEffectsRequireLeases: true,
          },
        },
        {
          nodeType: "joelclaw.dream.hitl-report",
          packageId: "workflow/dream-memory-fabric",
          packageRef: dreamWorkflowPackageRef,
          status: "verified",
          verification: {
            exportMatched: true,
            nodeTypeMatched: true,
            packagePinned: true,
            sideEffectsRequireLeases: true,
          },
        },
        {
          nodeType: "joelclaw.dream.hitl-decision-seed",
          packageId: "workflow/dream-memory-fabric",
          packageRef: dreamWorkflowPackageRef,
          status: "verified",
          verification: {
            exportMatched: true,
            nodeTypeMatched: true,
            packagePinned: true,
            sideEffectsRequireLeases: true,
          },
        },
        {
          nodeType: "joelclaw.dream.hitl-follow-up-run-request",
          packageId: "workflow/dream-memory-fabric",
          packageRef: dreamWorkflowPackageRef,
          status: "verified",
          verification: {
            exportMatched: true,
            nodeTypeMatched: true,
            packagePinned: true,
            sideEffectsRequireLeases: true,
          },
        },
        {
          nodeType: "joelclaw.dream.capture-artifact",
          packageId: "workflow/dream-memory-fabric",
          packageRef: dreamWorkflowPackageRef,
          status: "verified",
          verification: {
            exportMatched: true,
            nodeTypeMatched: true,
            packagePinned: true,
            sideEffectsRequireLeases: true,
          },
        },
      ],
      cloudflareProofWithoutRelaySidecarsFailedChecks: [
        "execution:relay-lease-sidecars",
      ],
      cloudflareProofWithoutRelaySidecarsStatus: "failed",
      combinedEffectProofCoveredEffects: [
        "backfill-plan",
        "backfill-run",
        "capture-artifact",
        "capture-run",
        "correlate",
        "hitl-decision-seed",
        "hitl-follow-up-run-request",
        "hitl-report",
        "hydrate",
        "inventory",
        "refinement-proposals",
        "search",
        "signals",
        "source-health",
      ],
      combinedEffectProofStatus: "verified",
      combinedEffectProofStepCount: 13,
      completedStepIds: [
        "inventory-memory-fabric",
        "check-source-health",
        "plan-recovery-backfills",
        "run-recovery-backfills",
        "capture-dream-run",
        "mine-dream-signals",
        "search-dream-memory",
        "hydrate-dream-evidence",
        "correlate-dream-evidence",
        "propose-dream-refinements",
        "render-dream-hitl-report",
        "seed-next-workflow-from-hitl",
        "draft-follow-up-run-request-from-hitl",
        "capture-dream-report-artifact",
      ],
      correlationEdgeCount: 5,
      correlationNodeCount: 7,
      correlationSchemaVersion: "dream.correlation-graph.v1",
      dreamGeneratedProofArtifactRef: true,
      dreamGeneratedProofCheckIds: [
        "plan:hash-pinned",
        "machine:hash-pinned",
        "harness:hash-pinned",
        "plan:profile-effect-coverage",
        "plan:horizon-coverage",
        "plan:source-profile-bound",
        "plan:source-pack-disposition",
        "plan:runtime-source-coverage",
        "machine:step-order-bound",
        "execution:generated-machine-sequence",
        "execution:relay-lease-sidecars",
        "execution:no-raw-transcripts",
        "report:definition-of-done-audit",
      ],
      dreamGeneratedProofEffectCoverage: {
        coveredEffects: [
          "backfill-plan",
          "backfill-run",
          "capture-artifact",
          "capture-run",
          "correlate",
          "hitl-decision-seed",
          "hitl-follow-up-run-request",
          "hitl-report",
          "hydrate",
          "inventory",
          "refinement-proposals",
          "search",
          "signals",
          "source-health",
        ],
        requiredEffects: [
          "backfill-plan",
          "backfill-run",
          "capture-artifact",
          "capture-run",
          "correlate",
          "hitl-decision-seed",
          "hitl-follow-up-run-request",
          "hitl-report",
          "hydrate",
          "inventory",
          "refinement-proposals",
          "search",
          "signals",
          "source-health",
        ],
      },
      dreamGeneratedProofFailures: [],
      dreamGeneratedProofHorizonCoverage: {
        coveredHorizons: ["24h", "7d", "30d", "quarter", "all-time"],
        requiredHorizons: ["24h", "7d", "30d", "quarter", "all-time"],
      },
      dreamGeneratedProofNodeTypes: [
        "joelclaw.dream.source-inventory",
        "joelclaw.dream.source-health",
        "joelclaw.dream.backfill-plan",
        "joelclaw.dream.backfill-run",
        "joelclaw.dream.capture-run",
        "joelclaw.dream.signals",
        "joelclaw.dream.memory-search",
        "joelclaw.dream.hydrate",
        "joelclaw.dream.correlate",
        "joelclaw.dream.refinement-proposals",
        "joelclaw.dream.hitl-report",
        "joelclaw.dream.hitl-decision-seed",
        "joelclaw.dream.hitl-follow-up-run-request",
        "joelclaw.dream.capture-artifact",
      ],
      dreamGeneratedProofRawTranscriptsReturned: false,
      dreamGeneratedProofRelayLeaseRefs: [],
      dreamGeneratedProofReportAuditCheck: {
        checkId: "report:definition-of-done-audit",
        evidenceRefs: [dreamRefs.reportRef],
        status: "passed",
        summary: `Dream HITL report ${dreamRefs.reportRef} carries not-proven definition-of-done audit without overclaiming post-report gates.`,
      },
      dreamGeneratedProofRuntimeSourceCoverage: {
        declaredMachineIds: ["blaine", "panda", "flagg", "cloudflare"],
        declaredRuntimes: ["pi", "codex", "claude", "cloudflare"],
        declaredSourceFamilies: [
          "agent-transcripts",
          "brain",
          "cloudflare-runs",
          "docs-pdf-brain",
          "repo-outputs",
        ],
        inventoryStepIds: ["inventory-memory-fabric"],
        requiredMachineIds: ["blaine", "panda", "flagg", "cloudflare"],
        requiredRuntimes: ["pi", "codex", "claude", "cloudflare"],
        requiredSourceFamilies: [
          "agent-transcripts",
          "brain",
          "cloudflare-runs",
          "docs-pdf-brain",
          "repo-outputs",
        ],
      },
      dreamGeneratedProofSourcePackDisposition: {
        dispositionCount: 2,
        dispositions: [
          {
            capabilityKinds: [],
            leaseRefs: [],
            missingCapabilityKinds: [
              "dream.memory.relay",
              "github.read",
              "linear.read",
              "slack.search",
            ],
            packId: "source-pack:joelhooks:work-graph",
            packageId: "source-pack/joelhooks-work-graph",
            reason:
              "Skipped until scoped source-pack leases are available for this generated run.",
            requiredCapabilityKinds: [
              "dream.memory.relay",
              "github.read",
              "linear.read",
              "slack.search",
            ],
            selectionPolicy: "optional-lease",
            sourceFamilies: [
              "comms",
              "people-org-memory",
              "repo-outputs",
              "support",
            ],
            status: "skipped-missing-lease",
            surfaces: ["github", "linear", "slack", "org-project-graph"],
          },
          {
            capabilityKinds: [],
            leaseRefs: [],
            missingCapabilityKinds: [],
            packId: "source-pack:badass-courses:aihero-support-sweep",
            packageId: "workflow/aihero-support-sweep",
            reason:
              "Saved as a separate workflow candidate so support/comms surfaces do not alter transcript-review Dream readiness.",
            requiredCapabilityKinds: [
              "dream.memory.relay",
              "front.read",
              "slack.search",
              "support.review",
            ],
            selectionPolicy: "separate-workflow",
            sourceFamilies: ["brain", "comms", "people-org-memory", "support"],
            status: "separate-workflow-candidate",
            surfaces: ["brain", "front", "slack", "org-project-graph"],
          },
        ],
        expectedPackIds: [
          "source-pack:joelhooks:work-graph",
          "source-pack:badass-courses:aihero-support-sweep",
        ],
        missingPackIds: [],
        unexpectedPackIds: [],
      },
      dreamGeneratedProofSourceProfile: {
        allowedRelayOperations: [
          "inventory",
          "source-health",
          "backfill-plan",
          "backfill-run",
          "capture-run",
          "capture-artifact",
          "signals",
          "search",
          "hydrate",
          "correlate",
        ],
        hash: hashJson(dreamTranscriptReviewSourceProfile),
        packageExportId: "dream-transcript-review-source-profile",
        packageId: "workflow/dream-memory-fabric",
        profileId: "joelhooks/dream-transcript-review",
        requiredMachineIds: ["blaine", "panda", "flagg", "cloudflare"],
        requiredRuntimes: ["pi", "codex", "claude", "cloudflare"],
        sourceFamiliesExpected: [
          "agent-transcripts",
          "brain",
          "cloudflare-runs",
          "docs-pdf-brain",
          "repo-outputs",
        ],
        sourcePacks: dreamTranscriptReviewSourceProfile.sourcePacks,
        timeHorizons: ["24h", "7d", "30d", "quarter", "all-time"],
        workflowId: "dream.memory-fabric",
      },
      dreamGeneratedProofStatus: "verified",
      dreamGeneratedProofStepCount: 14,
      executionProofRelayLeaseRefs: [],
      executionProofStatus: "not-proven-local-integration",
      healthInventoryRef: dreamRefs.inventoryRef,
      healthStatus: "degraded",
      hitlDecisionSeedAcceptedDecisionIds: [
        "decision:dream:generated-machine-proof",
      ],
      hitlDecisionSeedActionableDecisionCount: 2,
      hitlDecisionSeedDecisionRef: dreamRefs.hitlDecisionInputRef,
      hitlDecisionSeedRequiredCapabilities: ["brain.update.review"],
      hitlDecisionSeedSchemaVersion: "dream.hitl-decision-workflow-seed.v1",
      hitlDecisionSeedSourceRefs: [
        dreamRefs.hitlDecisionInputRef,
        dreamRefs.reportRef,
        dreamRefs.refinementRef,
        dreamRefs.backfillRunRef,
      ],
      hitlDecisionSeedStatus: "ready",
      hitlDecisionSeedWorkItemDecisionIds: [
        "decision:dream:capture-ingest-fix",
      ],
      hitlFollowUpActionableDecisionCount: 2,
      hitlFollowUpDecisionWorkflowSeedRef: dreamRefs.hitlDecisionSeedRef,
      hitlFollowUpRequestRunIdStartsWith: true,
      hitlFollowUpRequestWorkItemIdStartsWith: true,
      hitlFollowUpRequestedPackageIds: [
        "badass-courses/claw-kernel",
        "joelhooks/configured-familiar-kernel",
        "workflow/dream-memory-fabric",
      ],
      hitlFollowUpRequiredCapabilityKinds: ["brain.update.review"],
      hitlFollowUpSchemaVersion: "dream.hitl-follow-up-run-request.v1",
      hitlFollowUpStatus: "drafted",
      hitlFollowUpSubmitted: false,
      hydratedReceiptCount: 2,
      inventoryRuntimeStatuses: [
        "pi:captured",
        "codex:captured",
        "claude:missing",
        "cloudflare:captured",
      ],
      missingBackfillRunEffectProofFailedChecks: [
        "plan:profile-effect-coverage",
      ],
      missingBackfillRunEffectProofStatus: "failed",
      plannedBackfillActions: ["backfill:claude:native-capture"],
      proofWithUnleasedSourcePackSelectedFailedChecks: [
        "plan:source-pack-disposition",
      ],
      proofWithUnleasedSourcePackSelectedStatus: "failed",
      proofWithoutHorizonCoverageFailedChecks: ["plan:horizon-coverage"],
      proofWithoutHorizonCoverageStatus: "failed",
      proofWithoutRuntimeSourceCoverageFailedChecks: [
        "plan:runtime-source-coverage",
      ],
      proofWithoutRuntimeSourceCoverageStatus: "failed",
      proofWithoutSourcePackDispositionsFailedChecks: [
        "plan:source-pack-disposition",
      ],
      proofWithoutSourcePackDispositionsStatus: "failed",
      proofWithoutSourceProfileFailedChecks: ["plan:source-profile-bound"],
      proofWithoutSourceProfileStatus: "failed",
      refinementNextWorkflowProposalIds: [
        "proposal:capture-ingest-fix:runtime:claude",
        "proposal:dynamic-workflow-pattern:signal:1:signal-integration-workflow-pattern",
        "proposal:dynamic-workflow-pattern:1:integration-dream-search-found-agent-tra",
        "proposal:kernel-memory:2:integration-dream-search-found-brain-evi",
        "proposal:capture-ingest-fix:capture:1:capture-claude-relay",
        "proposal:dynamic-workflow-pattern:3:integration-dream-search-found-cloudflar",
        "proposal:capture-ingest-fix:backfill:1:backfill-claude-native-capture",
      ],
      refinementProposalCount: 7,
      refinementRecommendationKinds: [
        "capture-ingest-fix:turn-into-work",
        "dynamic-workflow-pattern:turn-into-work",
        "dynamic-workflow-pattern:accept",
        "kernel-memory:accept",
        "capture-ingest-fix:turn-into-work",
        "dynamic-workflow-pattern:turn-into-work",
        "capture-ingest-fix:turn-into-work",
      ],
      refinementSourceRefs: [
        dreamRefs.inventoryRef,
        dreamRefs.healthRef,
        dreamRefs.backfillRunRef,
        dreamRefs.signalsRef,
        dreamRefs.searchRef,
        dreamRefs.hydrationRef,
        dreamRefs.correlationRef,
      ],
      reportDefinitionOfDoneAuditItems: [
        "dream-cartridge-package:captured",
        "worker-facing-relay-capability-lease:not-proven",
        "live-cloudflare-execution:not-proven",
        "generated-machine-and-harness:captured",
        "t-shaped-memory-coverage:not-proven",
        "ingest-health-and-recovery-backfill:captured",
        "dreams-and-refinement-proposals:captured",
        "hitl-refinement-loop:not-proven",
        "workflow-owned-wzrrd-output:not-proven",
        "public-private-redaction-boundary:captured",
      ],
      reportDefinitionOfDoneAuditStatus: "not-proven",
      reportDefinitionOfDoneAuditSummary: {
        blockedCount: 0,
        capturedCount: 5,
        missingCount: 0,
        notProvenCount: 5,
        totalCount: 10,
      },
      reportDreamCount: 3,
      reportHitlDecisionContract: {
        artifactPath: "dream/hitl-decision.json",
        contractRef: "contract://workflow/dream-memory-fabric/hitl-decision.v1",
        decisionSchemaVersion: "dream.hitl-decision.v1",
        exportId: "dream-hitl-decision-schema",
        nextWorkflowSeedRequiredFor: ["accept", "turn-into-work"],
        sourceRefs: [
          dreamRefs.inventoryRef,
          dreamRefs.healthRef,
          dreamRefs.backfillRef,
          dreamRefs.backfillRunRef,
          dreamRefs.searchRef,
          dreamRefs.hydrationRef,
          dreamRefs.correlationRef,
          dreamRefs.refinementRef,
        ],
        targetKinds: ["dream-card", "refinement-proposal"],
      },
      reportMdsvxIncludesAccessAdapter: true,
      reportMdsvxIncludesD2: true,
      reportMdsvxIncludesD2Fig: true,
      reportMdsvxIncludesD2FigAspectRatio: true,
      reportMdsvxIncludesDefinitionAudit: true,
      reportMdsvxIncludesDreamsFirst: true,
      reportMdsvxIncludesDynamicProof: true,
      reportMdsvxIncludesGeneratedHarnessRef: true,
      reportMdsvxIncludesGeneratedMachineRef: true,
      reportMdsvxIncludesGeneratedMachineSourceRef: true,
      reportMdsvxIncludesHitlDecisionContract: true,
      reportMdsvxIncludesRefinement: true,
      reportMdsvxIncludesReportNode: true,
      reportMdsvxIncludesReportStandard: true,
      reportMdsvxIncludesRunCoverage: true,
      reportMdsvxIncludesWhatDidNotHappen: true,
      reportMdsvxNoCandidateReview: true,
      reportMdsvxPutsDreamsBeforeProof: true,
      reportMdsvxRefPublished: dreamRefs.reportMdsvxRef,
      reportMdsvxSourceMatchesJson: true,
      reportProofGeneratedArtifacts: {
        harness: result.harnessArtifact,
        machine: result.machineArtifact,
        plan: {
          planId: plan.planId,
          planner: plan.planner,
          stepCount: 14,
        },
        verificationContract: result.verificationContractArtifact,
      },
      reportProofLevel: "generated-machine",
      reportRawTranscriptsReturned: false,
      reportRefinementProposalCount: 7,
      reportRefinementProposalRef: dreamRefs.refinementRef,
      reportSectionOrder: [
        "run-context",
        "actual-dreams",
        "what-to-do",
        "actionable-line-items",
        "proof",
        "technical-appendix",
      ],
      reportSourceRefs: [
        dreamRefs.inventoryRef,
        dreamRefs.healthRef,
        dreamRefs.backfillRef,
        dreamRefs.backfillRunRef,
        dreamRefs.searchRef,
        dreamRefs.hydrationRef,
        dreamRefs.correlationRef,
        dreamRefs.refinementRef,
      ],
      reportStateMachineFigure: {
        aspectRatio: "3:5",
        machineBinding: {
          machineArtifactHash: result.machineArtifact.hash,
          machineArtifactRef: result.machineArtifact.artifactRef,
          machineId: result.machineArtifact.machineId,
          machineSourceArtifactRef: result.machineArtifact.sourceArtifactRef,
          machineSourceHash: result.machineArtifact.sourceHash,
          status: "bound-to-generated-machine",
        },
        machineId: machine.machineId,
        sourceHasFirstDreamStep: true,
        sourceHasStaticDreamLabel: false,
        sourceHashMatches: true,
        sourceKind: "generated-xstate-machine",
        stateCount: 17,
        transitionCount: 29,
      },
      reportTemplate: "joel/tufte-mdsvx@0.1.0",
      searchHitCount: 3,
      searchReceiptFamilies: ["agent-transcripts", "brain", "cloudflare-runs"],
      signalKinds: ["workflow-pattern"],
      signalReceiptFamilies: ["agent-transcripts"],
      wzrrdPrimaryDocument: {
        artifactRef: dreamRefs.reportMdsvxRef,
        hash: sha256Hex(reportMdsvx),
        mediaType: "text/mdsvx",
        path: "report.mdsvx",
        template: {
          defaultExpiresIn: "24h",
          format: "mdsvx",
          noindex: true,
          rendererId: "joel/static-tufte-mdsvx-preview@0.1.0",
          templateId: "joel/tufte-mdsvx",
          version: "0.1.0",
        },
        title: "This dream found work to do.",
      },
    });
  });

  it("rejects binary media types for Dream artifact capture nodes", async () => {
    const artifacts = createMemoryArtifactStore(
      "workflow-app-dream-binary-capture"
    );
    const memoryFabric = createIntegrationTestDreamMemoryFabricAdapter();
    const adapter = createDreamMemoryFabricWorkflowNodeAdapter({
      artifacts,
      dreamMemoryCapture: memoryFabric,
      dreamMemoryFabric: memoryFabric,
    });
    const request = buildIntegrationTestDreamRunRequest();
    const packageRegistry = createMemoryPackageRegistryActor(
      dreamIntegrationPackages
    );
    const pinnedPackageResult = await packageRegistry.pinPackages({
      actor: request.actor,
      packageIds: request.planProposal.requestedPackageIds,
    });
    if (pinnedPackageResult.status === "blocked") {
      throw new Error(pinnedPackageResult.blocker.message);
    }
    const blueprint =
      await createIntegrationTestDynamicWorkflowPlanner().proposePlan({
        actor: request.actor,
        availablePackages: dreamIntegrationPackages,
        pinnedPackages: pinnedPackageResult.pinnedPackages,
        proposal: request.planProposal,
        runId: request.runId,
        workItemId: request.workItemId,
      });
    const step = DynamicWorkflowStepSchema.parse({
      config: {
        artifactRef: `artifact://workflow-app-dream-binary-capture/runs/${request.runId}/dream/raw-video.mov`,
        mediaType: "video/quicktime",
      },
      kind: "workflow.node.invoke",
      nodeType: "joelclaw.dream.capture-artifact",
      outputPath: "dream/capture-video.json",
      stepId: "capture-video",
      summary:
        "Try to capture a binary artifact through the Dream text hash path.",
    });
    if (step.kind !== "workflow.node.invoke") {
      throw new Error("Expected workflow.node.invoke step.");
    }
    const machine = DynamicWorkflowMachineDocumentSchema.parse({
      ...blueprint.machine,
      stepOrder: [step.stepId],
      xstate: {
        ...blueprint.machine.xstate,
        states: machineStatesFor([step]),
      },
    });
    const plannerLane = AgentLaneReceiptSchema.parse({
      ...blueprint.plannerLane,
      prompt: {
        artifactRef: `artifact://workflow-app-dream-binary-capture/runs/${request.runId}/${blueprint.plannerLane.prompt.path}`,
        hash: sha256Hex(blueprint.plannerLane.prompt.value),
        mediaType: blueprint.plannerLane.prompt.mediaType,
      },
      receiptRef: `artifact://workflow-app-dream-binary-capture/runs/${request.runId}/receipts/planner-lane.json`,
      transcript: {
        artifactRef: `artifact://workflow-app-dream-binary-capture/runs/${request.runId}/${blueprint.plannerLane.transcript.path}`,
        hash: sha256Hex(blueprint.plannerLane.transcript.value),
        mediaType: blueprint.plannerLane.transcript.mediaType,
      },
    });
    const plan = DynamicWorkflowPlanDocumentSchema.parse({
      ...blueprint.plan,
      harness: {
        artifactRef: `artifact://workflow-app-dream-binary-capture/runs/${request.runId}/workflows/harness.ts`,
        entrypoint: "workflows/harness.ts",
        harnessId: blueprint.harness.harnessId,
        hash: sha256Hex(blueprint.harness.source),
        language: "typescript",
      },
      machine: {
        artifactRef: `artifact://workflow-app-dream-binary-capture/runs/${request.runId}/workflows/machine.config.json`,
        hash: hashJson(machine),
        machineId: machine.machineId,
        sourceArtifactRef: `artifact://workflow-app-dream-binary-capture/runs/${request.runId}/workflows/machine.ts`,
        sourceHash: sha256Hex("generated machine source fixture"),
      },
      plannerLane,
      steps: [step],
      verificationContract: {
        artifactRef: `artifact://workflow-app-dream-binary-capture/runs/${request.runId}/workflows/verification-contract.json`,
        contractId: blueprint.verificationContract.contractId,
        hash: hashJson(blueprint.verificationContract),
        mediaType: "application/json",
      },
    });

    const input: Parameters<WorkflowNodeAdapterPort["execute"]>[0] = {
      actor: request.actor,
      dependencyArtifactRefs: {},
      machine,
      plan,
      step,
    };

    await expect(adapter.execute(input)).rejects.toThrow(
      "Dream capture artifact mediaType must be application/json or a supported text media type."
    );
  });

  it("blocks package metadata discovery failures as receipts", async () => {
    const artifacts = createMemoryArtifactStore("workflow-app-discovery-block");
    const workflow = new WorkflowApp({
      artifacts,
      capabilityLeases: createPolicyCapabilityLeaseBroker(artifacts, {
        discordSecretRef: "secretref:discord-bot",
        policyId: "discord-message-policy",
      }),
      contextCapsules: createMemoryContextCapsuleActor(),
      discordMessages: createDryRunDiscordMessageAdapter(),
      discordSecretRefs: {
        dryRun: "secretref:discord-dry-run",
        send: "secretref:discord-bot",
      },
      dynamicWorkflowPlanner: createIntegrationTestDynamicWorkflowPlanner(),
      executionMode: "integration-test",
      observabilityRecorder: createCloudflareArtifactsObservabilityRecorder({
        artifacts,
      }),
      packageRegistry: {
        discoverMetadata: () =>
          Promise.reject(new Error("package manifest read hung")),
        pinPackages: () =>
          Promise.reject(new Error("pinPackages should not be called")),
      },
      reviewGate: createMemoryReviewGateActor(artifacts),
      reviewSurfacePublisher: createCloudflareArtifactsReviewSurfacePublisher({
        artifacts,
      }),
      statusProjection: createMemoryWorkflowStatusProjectionStore(),
      wzrrdPublisher: createDryRunWzrrdPublishAdapter(),
      wzrrdSecretRefs: {
        dryRun: "secretref:wzrrd-dry-run",
        publish: "secretref:wzrrd-api",
      },
      wzrrdSiteRef: "wzrrd:test",
    });

    const result = await workflow.run(buildIntegrationTestRunRequest());

    expect({
      blocker: result.status === "blocked" ? result.blocker : undefined,
      states: result.eventLog.map((event) => event.state),
      status: result.status,
    }).toStrictEqual({
      blocker: {
        code: "stale_package",
        message:
          "Package metadata discovery failed: package manifest read hung",
        redacted: true,
      },
      states: ["resolvingCapsule", "discoveringPackageMetadata", "blocked"],
      status: "blocked",
    });
  });

  it("blocks planner adapter failures as receipts", async () => {
    const artifacts = createMemoryArtifactStore("workflow-app-planner-block");
    const workflow = new WorkflowApp({
      artifacts,
      capabilityLeases: createPolicyCapabilityLeaseBroker(artifacts, {
        discordSecretRef: "secretref:discord-bot",
        policyId: "discord-message-policy",
      }),
      contextCapsules: createMemoryContextCapsuleActor(),
      discordMessages: createDryRunDiscordMessageAdapter(),
      discordSecretRefs: {
        dryRun: "secretref:discord-dry-run",
        send: "secretref:discord-bot",
      },
      dynamicWorkflowPlanner: {
        proposePlan: () =>
          Promise.reject(
            new Error(
              "Container failed to start due to a permanent error. Check your container configuration."
            )
          ),
      },
      executionMode: "production",
      observabilityRecorder: createCloudflareArtifactsObservabilityRecorder({
        artifacts,
      }),
      packageRegistry: createMemoryPackageRegistryActor(
        integrationTestPackageMetadata
      ),
      reviewGate: createMemoryReviewGateActor(artifacts),
      reviewSurfacePublisher: createCloudflareArtifactsReviewSurfacePublisher({
        artifacts,
      }),
      statusProjection: createMemoryWorkflowStatusProjectionStore(),
      wzrrdPublisher: createDryRunWzrrdPublishAdapter(),
      wzrrdSecretRefs: {
        dryRun: "secretref:wzrrd-dry-run",
        publish: "secretref:wzrrd-api",
      },
      wzrrdSiteRef: "wzrrd:test",
    });

    const result = await workflow.run(buildIntegrationTestRunRequest());

    expect({
      blocker: result.status === "blocked" ? result.blocker : undefined,
      lastState: result.eventLog.at(-1)?.state,
      status: result.status,
    }).toStrictEqual({
      blocker: {
        code: "adapter_unavailable",
        message:
          "Dynamic workflow planner failed: Container failed to start due to a permanent error. Check your container configuration.",
        redacted: true,
      },
      lastState: "blocked",
      status: "blocked",
    });
  });
});
