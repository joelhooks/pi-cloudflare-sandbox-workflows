import { setTimeout as sleep } from "node:timers/promises";

import { describe, expect, it, test } from "vitest";

import type {
  AgentWorkerLanePort,
  ArtifactStoreContract,
  WorkflowNodeAdapterPort,
  WorkflowPostExecutionArtifactRecorderPort,
} from "../../src/app/application/ports.ts";
import {
  PlannerBlueprintContractError,
  StaleDriveGenerationError,
} from "../../src/app/application/ports.ts";
import { WorkflowApp } from "../../src/app/application/workflow-app.ts";
import { hashJson, sha256Hex } from "../../src/app/domain/hash.ts";
import {
  AgentLaneReceiptSchema,
  WorkflowDriveLaneDispatchSchema,
  WorkflowDriveLaneStatusReceiptSchema,
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
  RunStepCheckpointSchema,
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
  CapabilityBlocker,
  DynamicWorkflowBlueprint,
  DynamicWorkflowStep,
  WorkflowDriveLaneDispatch,
  WorkflowRunDriveResult,
  WorkflowStatusProjection,
} from "../../src/app/domain/schemas.ts";
import {
  MemorySourcePackDispositionSchema,
  MemorySourceProfileSchema,
} from "../../src/app/domain/source-profile.ts";
import type { MemorySourceProfile } from "../../src/app/domain/source-profile.ts";
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
  createMemoryGeneratedWorkflowProofRecorder,
  MemoryGeneratedWorkflowProofDocumentSchema,
  verifyMemoryGeneratedWorkflow,
} from "../../src/app/workflow-nodes/generated-workflow-proof.ts";
import { buildWorkflowHitlReportAuditProofCheck } from "../../src/cartridges/memory-fabric/hitl-report-audit-proof-check.ts";
import {
  createIntegrationTestMemoryCorrelationAdapter,
  createIntegrationTestMemoryFabricAdapter,
  createIntegrationTestMemoryRetrievalAdapter,
} from "../../src/cartridges/memory-fabric/integration-test-adapters.ts";
import {
  MemoryCaptureReceiptDocumentSchema,
  MemoryCorrelationGraphDocumentSchema,
  MemoryHitlDecisionDocumentSchema,
  MemoryHitlDecisionWorkflowSeedDocumentSchema,
  MemoryHitlFollowUpRunRequestDocumentSchema,
  WorkflowHitlReportDocumentSchema,
  MemoryHydrationDocumentSchema,
  MemorySearchDocumentSchema,
  MemoryRefinementProposalDocumentSchema,
  MemorySignalDocumentSchema,
} from "../../src/cartridges/memory-fabric/schemas.ts";
import { dreamTranscriptReviewSourceProfile } from "../../src/cartridges/memory-fabric/source-profile.ts";
import { createMemoryFabricWorkflowNodeAdapter } from "../../src/cartridges/memory-fabric/workflow-node-adapter.ts";
import { createLifecycleFaithfulArtifactsRemote } from "./lifecycle-faithful-fakes.ts";
import {
  buildIntegrationTestDreamRunRequest,
  buildIntegrationTestRunRequest,
  integrationTestMemoryWorkflowPackageMetadata,
  integrationTestPackageMetadata,
} from "./workflow-app-fixtures.ts";

const memoryWorkflowPackageRef =
  integrationTestMemoryWorkflowPackageMetadata.latestArtifactRef;

const dreamIntegrationPackages = [
  ...integrationTestPackageMetadata,
  integrationTestMemoryWorkflowPackageMetadata,
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
  const contextCapsules = createMemoryContextCapsuleActor();
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
    contextCapsules,
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

  return {
    artifacts,
    contextCapsules,
    observabilityCaptureCalls,
    result,
    statusProjection,
  };
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
  const memoryCoverageHorizons = [
    ...dreamTranscriptReviewSourceProfile.timeHorizons,
  ];
  const memorySourcePackDispositions =
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
        reason = "Selected by the installed Memory source profile.";
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
  const captureRunStep = DynamicWorkflowStepSchema.parse({
    config: {
      memorySourcePackDispositions,
      sourceFamilies: ["agent-transcripts", "cloudflare-runs"],
      sourceSystem: "cloudflare-workflow-run",
    },
    dependsOn: [],
    kind: "workflow.node.invoke",
    nodeType: "joelclaw.memory.capture-run",
    outputPath: "dream/capture-run.json",
    packageRefs: [memoryWorkflowPackageRef],
    stepId: "capture-dream-run",
    summary: "Capture a redacted run receipt through the trusted Memory relay.",
  });
  const signalsStep = DynamicWorkflowStepSchema.parse({
    config: {
      maxSignals: 3,
      memoryCoverageHorizons,
      query: "dynamic workflow proof across Codex Cloudflare Brain",
      sourceFamilies: ["agent-transcripts", "brain", "cloudflare-runs"],
    },
    dependsOn: [captureRunStep.stepId],
    kind: "workflow.node.invoke",
    nodeType: "joelclaw.memory.signals",
    outputPath: "dream/signals.json",
    packageRefs: [memoryWorkflowPackageRef],
    stepId: "mine-memory-signals",
    summary:
      "Mine redacted Dream signals before search and proposal synthesis.",
  });
  const searchStep = DynamicWorkflowStepSchema.parse({
    config: {
      maxHits: 3,
      memoryCoverageHorizons,
      query: "dynamic workflow proof across Codex Cloudflare Brain",
      sourceFamilies: ["agent-transcripts", "brain", "cloudflare-runs"],
    },
    dependsOn: [signalsStep.stepId],
    kind: "workflow.node.invoke",
    nodeType: "joelclaw.memory.search",
    outputPath: "dream/memory-search.json",
    packageRefs: [memoryWorkflowPackageRef],
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
    nodeType: "joelclaw.memory.hydrate",
    outputPath: "dream/hydration.json",
    packageRefs: [memoryWorkflowPackageRef],
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
    nodeType: "joelclaw.memory.correlate",
    outputPath: "dream/correlation-graph.json",
    packageRefs: [memoryWorkflowPackageRef],
    stepId: "correlate-dream-evidence",
    summary:
      "Correlate near-term and far-term Dream evidence into a graph artifact.",
  });
  const refinementStep = DynamicWorkflowStepSchema.parse({
    config: {
      correlationStepId: correlationStep.stepId,
      hydrationStepId: hydrateStep.stepId,
      maxProposals: 7,
      searchStepId: searchStep.stepId,
      signalsStepId: signalsStep.stepId,
    },
    dependsOn: [
      signalsStep.stepId,
      searchStep.stepId,
      hydrateStep.stepId,
      correlationStep.stepId,
    ],
    kind: "workflow.node.invoke",
    nodeType: "joelclaw.memory.refinement-proposals",
    outputPath: "dream/refinement-proposals.json",
    packageRefs: [memoryWorkflowPackageRef],
    stepId: "propose-dream-refinements",
    summary:
      "Turn Dream evidence into kernel, package, workflow, schema, and capture refinement proposals.",
  });
  const reportStep = DynamicWorkflowStepSchema.parse({
    config: {
      correlationStepId: correlationStep.stepId,
      dynamicGenerationProofLevel: "generated-machine",
      hydrationStepId: hydrateStep.stepId,
      refinementProposalStepId: refinementStep.stepId,
      searchStepId: searchStep.stepId,
      title: "This dream found work to do.",
    },
    dependsOn: [
      searchStep.stepId,
      hydrateStep.stepId,
      correlationStep.stepId,
      refinementStep.stepId,
    ],
    kind: "workflow.node.invoke",
    nodeType: "joelclaw.memory.hitl-report",
    outputPath: "report/hitl-report.json",
    packageRefs: [memoryWorkflowPackageRef],
    stepId: "render-memory-hitl-report",
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
    nodeType: "joelclaw.memory.hitl-decision-seed",
    outputPath: "report/hitl-decision-workflow-seed.json",
    packageRefs: [memoryWorkflowPackageRef],
    stepId: "seed-next-workflow-from-hitl",
    summary:
      "Turn the redacted human Dream HITL decision artifact into a next-workflow seed.",
  });
  const hitlFollowUpStep = DynamicWorkflowStepSchema.parse({
    config: {
      requestedPackageIds: [
        "badass-courses/claw-kernel",
        "joelhooks/configured-familiar-kernel",
        "workflow/memory-fabric",
      ],
      seedStepId: hitlDecisionSeedStep.stepId,
    },
    dependsOn: [hitlDecisionSeedStep.stepId],
    kind: "workflow.node.invoke",
    nodeType: "joelclaw.memory.hitl-follow-up-run-request",
    outputPath: "report/hitl-follow-up-run-request.json",
    packageRefs: [memoryWorkflowPackageRef],
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
    nodeType: "joelclaw.memory.capture-artifact",
    outputPath: "dream/capture-artifact.json",
    packageRefs: [memoryWorkflowPackageRef],
    stepId: "capture-dream-report-artifact",
    summary:
      "Capture the generated Dream HITL report artifact as memory fabric input.",
  });
  const steps: DynamicWorkflowStep[] = [
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
          artifactPath: "report/hitl-report.mdsvx",
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

const integrationTestMemoryHitlDecisionDocument = (input: {
  readonly captureRunRef: ArtifactRef;
  readonly refinementProposalRef: ArtifactRef;
  readonly reportRef: ArtifactRef;
  readonly runId: string;
  readonly workItemId: string;
}) =>
  MemoryHitlDecisionDocumentSchema.parse({
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
          "Recurring capture gaps mean ingest is still broken and needs follow-up work in the separate repair workflow.",
        recommendation:
          "Draft a generated workflow request that turns the capture-ingest repair into reviewed Brain/package/workflow updates.",
        reviewedAt: "2026-06-09T21:20:00.000Z",
        sourceRefs: [input.captureRunRef, input.refinementProposalRef],
        summary: "Turn the Dream capture gap into a follow-up repair workflow.",
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
          sourceRefs: [input.captureRunRef, input.refinementProposalRef],
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
        input.captureRunRef,
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
    schemaVersion: "memory.hitl-decision.v1",
    sourceRefs: [
      input.reportRef,
      input.captureRunRef,
      input.refinementProposalRef,
    ],
    workItemId: input.workItemId,
  });

const effectCoverageStatusFor = (
  proof: ReturnType<typeof verifyMemoryGeneratedWorkflow>
): string | undefined =>
  proof.checks.find((check) => check.checkId === "plan:profile-effect-coverage")
    ?.status;

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

/**
 * Runs the plain (non-memory-fabric) integration workflow with the
 * memory-fabric proof recorder registered under its dream-profile binding plus
 * an observing recorder bound by profile-id predicate. Recorder selection must
 * come from the run request's source profile, never from running everything.
 * The dream binding's profile id can be drifted to simulate a mismatched
 * recorder registration, and installed source profiles drive the fail-closed
 * proof-recorder requirement.
 */
const runWorkflowWithProfileBoundRecorders = async (input: {
  readonly dreamRecorderBindingProfileId?: string;
  readonly installedSourceProfiles?: readonly MemorySourceProfile[];
  readonly sourceProfileId?: string;
  readonly storeName: string;
}) => {
  const artifacts = createMemoryArtifactStore(input.storeName);
  const recordedLabels: string[] = [];
  const observingRecorder = (
    label: string
  ): WorkflowPostExecutionArtifactRecorderPort => ({
    async record(recordInput) {
      recordedLabels.push(label);
      const write = await artifacts.writeJson({
        path: `recorders/${label}.json`,
        redacted: true,
        runId: recordInput.plan.runId,
        value: { label, redacted: true, runId: recordInput.plan.runId },
      });

      return { artifactRefs: [write.artifactRef], status: "recorded" };
    },
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
    dynamicWorkflowPlanner: createIntegrationTestDynamicWorkflowPlanner(),
    executionMode: "integration-test",
    ...(input.installedSourceProfiles === undefined
      ? {}
      : { installedSourceProfiles: input.installedSourceProfiles }),
    observabilityRecorder: createCloudflareArtifactsObservabilityRecorder({
      artifacts,
    }),
    packageRegistry: createMemoryPackageRegistryActor(
      integrationTestPackageMetadata
    ),
    postExecutionArtifactRecorders: [
      {
        binding: {
          kind: "profile-id",
          packageId: dreamTranscriptReviewSourceProfile.packageId,
          profileId:
            input.dreamRecorderBindingProfileId ??
            dreamTranscriptReviewSourceProfile.profileId,
        },
        recorder: createMemoryGeneratedWorkflowProofRecorder({
          artifacts,
          expectedPackageRef: memoryWorkflowPackageRef,
          expectedSourceProfile: dreamTranscriptReviewSourceProfile,
          expectedSourceProfileExportId:
            "dream-transcript-review-source-profile",
        }),
      },
      {
        binding: {
          kind: "profile-id-predicate",
          matchesProfileId: (profileId) =>
            profileId.startsWith("badass-courses/"),
          packageId: "workflow/aihero-support-sweep",
        },
        recorder: observingRecorder("support-sweep-proof"),
      },
    ],
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
    planProposal: {
      ...request.planProposal,
      ...(input.sourceProfileId === undefined
        ? {}
        : { sourceProfileId: input.sourceProfileId }),
    },
  });

  return { recordedLabels, result };
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
    const proof = verifyMemoryGeneratedWorkflow({
      executionProof,
      executionProofRef: result.executionProofArtifact.artifactRef,
      expectedPackageRef: memoryWorkflowPackageRef,
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
    const statusProjection = createMemoryWorkflowStatusProjectionStore();
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
      statusProjection,
      wzrrdPublisher: createDryRunWzrrdPublishAdapter(),
      wzrrdSecretRefs: {
        dryRun: "secretref:wzrrd-dry-run",
        publish: "secretref:wzrrd-api",
      },
      wzrrdSiteRef: "wzrrd:test",
    });

    const result = await workflow.run(buildIntegrationTestRunRequest());
    const latestProjection = statusProjection.latest.get(result.runId);

    expect({
      blocker: result.status === "blocked" ? result.blocker : undefined,
      lastSummary: result.eventLog.at(-1)?.summary,
      projectionState: latestProjection?.currentState,
      projectionTerminalBlocker: latestProjection?.terminalBlocker,
      status: result.status,
    }).toStrictEqual({
      blocker: {
        code: "capability_denied",
        message:
          "Verification contract outputPath must not collide with dynamic step outputPath: review/summary.json.",
        redacted: true,
      },
      lastSummary: "Planner output failed dynamic workflow validation.",
      projectionState: "blocked",
      projectionTerminalBlocker: {
        code: "capability_denied",
        message:
          "Verification contract outputPath must not collide with dynamic step outputPath: review/summary.json.",
        redacted: true,
      },
      status: "blocked",
    });
  });

  // Wound #27: the planner lane RAN and pinned an output; the output just was
  // not a blueprint. That is a DETERMINISTIC content miss — re-driving the same
  // prompt re-produces the same wrong shape forever. The carrier used to flatten
  // it into the transient `adapter_unavailable`, which blind-re-drove for ~40
  // minutes. A typed PlannerBlueprintContractError must surface as the
  // deterministic `planner_output_invalid` carrying the present/missing keys, so
  // the operator status endpoint reads the real cause instead of a guess.
  it("blocks a deterministic planner-output contract miss as planner_output_invalid (not adapter_unavailable)", async () => {
    const artifacts = createMemoryArtifactStore(
      "workflow-app-planner-output-contract-miss"
    );
    const statusProjection = createMemoryWorkflowStatusProjectionStore();
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
        // Hostile double: pi ran-and-returned schema-invalid output. The adapter
        // would have diagnosed exactly this — present `result`, all four required
        // top-level keys missing — and thrown the typed contract error.
        proposePlan() {
          return Promise.reject(
            new PlannerBlueprintContractError({
              issuePaths: [
                "machine",
                "harness",
                "plan",
                "verificationContract",
              ],
              missingKeys: [
                "machine",
                "harness",
                "plan",
                "verificationContract",
              ],
              presentKeys: ["result"],
              runId: "run-planner-output-contract-miss",
              stage: "planner-output",
              workItemId: "work-planner-output-contract-miss",
            })
          );
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
      statusProjection,
      wzrrdPublisher: createDryRunWzrrdPublishAdapter(),
      wzrrdSecretRefs: {
        dryRun: "secretref:wzrrd-dry-run",
        publish: "secretref:wzrrd-api",
      },
      wzrrdSiteRef: "wzrrd:test",
    });

    const result = await workflow.run(buildIntegrationTestRunRequest());
    const latestProjection = statusProjection.latest.get(result.runId);
    const blocker = result.status === "blocked" ? result.blocker : undefined;

    // The block must NAME what pi emitted vs what the contract required (the
    // diagnostic discarded by the old blanket adapter_unavailable), classify the
    // failure as the DETERMINISTIC planner_output_invalid, and the status
    // endpoint's terminalBlocker.code must agree.
    expect({
      blockerCode: blocker?.code,
      namesDeterministic: blocker?.message.includes("deterministic") ?? false,
      namesMissingKeys:
        blocker?.message.includes(
          "missing required keys [machine, harness, plan, verificationContract]"
        ) ?? false,
      namesPresentKeys:
        blocker?.message.includes("present top-level keys [result]") ?? false,
      status: result.status,
      terminalBlockerCode: latestProjection?.terminalBlocker?.code,
    }).toStrictEqual({
      blockerCode: "planner_output_invalid",
      namesDeterministic: true,
      namesMissingKeys: true,
      namesPresentKeys: true,
      status: "blocked",
      terminalBlockerCode: "planner_output_invalid",
    });
  });

  // The discriminator must NOT over-reach: a genuine transport outage (the
  // planner adapter could not reach the sandbox at all) is still transient and
  // must stay `adapter_unavailable` so the supervisor may legitimately re-drive.
  it("keeps a generic planner transport failure classified as adapter_unavailable", async () => {
    const artifacts = createMemoryArtifactStore(
      "workflow-app-planner-transport-outage"
    );
    const statusProjection = createMemoryWorkflowStatusProjectionStore();
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
        proposePlan() {
          return Promise.reject(
            new Error("sandbox dispatch failed: connection reset")
          );
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
      statusProjection,
      wzrrdPublisher: createDryRunWzrrdPublishAdapter(),
      wzrrdSecretRefs: {
        dryRun: "secretref:wzrrd-dry-run",
        publish: "secretref:wzrrd-api",
      },
      wzrrdSiteRef: "wzrrd:test",
    });

    const result = await workflow.run(buildIntegrationTestRunRequest());
    const blocker = result.status === "blocked" ? result.blocker : undefined;

    expect(result.status).toBe("blocked");
    expect(blocker?.code).toBe("adapter_unavailable");
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

  it("blocks generated machines whose initial state is the done final state", async () => {
    const artifacts = createMemoryArtifactStore(
      "workflow-app-skip-to-done-machine"
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
          const firstStep = blueprint.plan.steps.at(0);
          if (firstStep === undefined) {
            throw new Error("Fixture planner returned no steps.");
          }

          const states = machineStatesFor(blueprint.plan.steps);
          const doneState = states["done"];
          if (doneState === undefined) {
            throw new Error("Fixture machine states are missing done.");
          }

          states["done"] = {
            ...doneState,
            on: {
              NEXT: {
                target: generatedStepStateName(0, firstStep.stepId),
              },
            },
          };

          return DynamicWorkflowBlueprintSchema.parse({
            ...blueprint,
            machine: {
              ...blueprint.machine,
              xstate: {
                id: blueprint.machine.machineId,
                initial: "done",
                states,
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
          "Generated XState initial state must not be a terminal done or blocked state.",
        redacted: true,
      },
      lastSummary: "Pinned generated workflow machine failed validation.",
      status: "blocked",
    });
  });

  it("captures generated machines that execute every planned step", async () => {
    const { artifacts, result } = await runWorkflow();

    const loadedPlan = DynamicWorkflowPlanDocumentSchema.parse(
      await artifacts.readJson({
        artifactRef: result.planArtifact.artifactRef,
      })
    );
    const executionProof = WorkflowExecutionProofDocumentSchema.parse(
      await artifacts.readJson({
        artifactRef: result.executionProofArtifact.artifactRef,
      })
    );

    expect({
      completedStepIds: executionProof.completedStepIds,
      status: result.status,
    }).toStrictEqual({
      completedStepIds: loadedPlan.steps.map((step) => step.stepId),
      status: "captured",
    });
  });

  it("blocks generated machines that reach done after executing only a subset of planned steps", async () => {
    const artifacts = createMemoryArtifactStore(
      "workflow-app-skip-to-done-tripwire"
    );
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
    const seeded = await workflow.run(request);
    if (seeded.status !== "captured") {
      throw new Error(seeded.blocker.message);
    }

    const loadedPlan = DynamicWorkflowPlanDocumentSchema.parse(
      await artifacts.readJson({
        artifactRef: seeded.planArtifact.artifactRef,
      })
    );
    const machine = DynamicWorkflowMachineDocumentSchema.parse(
      await artifacts.readJson({
        artifactRef: seeded.machineArtifact.artifactRef,
      })
    );
    const firstStep = loadedPlan.steps.at(0);
    if (firstStep === undefined) {
      throw new Error("Pinned plan returned no steps.");
    }

    const subsetMachine = DynamicWorkflowMachineDocumentSchema.parse({
      ...machine,
      xstate: {
        id: machine.xstate.id,
        initial: "ready",
        states: {
          blocked: {
            meta: { summary: "Generated dynamic workflow blocked." },
            on: {},
            type: "final",
          },
          done: {
            meta: { summary: "Generated dynamic workflow completed." },
            on: {},
            type: "final",
          },
          firstStepOnly: {
            meta: {
              stepId: firstStep.stepId,
              stepKind: firstStep.kind,
              summary: firstStep.summary,
            },
            on: {
              STEP_BLOCKED: { target: "blocked" },
              STEP_DONE: { target: "done" },
            },
          },
          ready: {
            meta: {
              summary: "Generated dynamic workflow is ready to execute.",
            },
            on: { NEXT: { target: "firstStepOnly" } },
          },
        },
      },
    });
    const blockCalls: {
      readonly blockedBy: CapabilityBlocker;
      readonly summary: string;
    }[] = [];
    const transitionCommands: string[] = [];
    // oxlint-disable-next-line typescript/dot-notation -- Drive the private execution loop directly to prove the completion tripwire fires even if a future validator gap admits a skip-to-done machine.
    const execution = await workflow["executeDynamicWorkflow"]({
      admitDynamicNodeAttempt: () => Promise.resolve({ status: "accepted" }),
      block: (blockedBy, summary) => {
        blockCalls.push({ blockedBy, summary });

        return Promise.resolve({
          blocker: blockedBy,
          eventLog: [],
          runId: request.runId,
          status: "blocked" as const,
        });
      },
      loadDriveLaneDispatch: () => null,
      loadedPlan,
      machine: subsetMachine,
      persistCheckpoint: () => Promise.resolve(),
      recordDriveLaneDispatch: () => Promise.resolve(),
      recordDriveLaneStatus: () => Promise.resolve(),
      request,
      transition: (command) => {
        transitionCommands.push(command.type);

        return Promise.resolve();
      },
    });

    expect({
      blockCalls,
      capturedTransitions: transitionCommands.filter(
        (commandType) => commandType === "DYNAMIC_WORKFLOW_COMPLETED"
      ),
      executedStepTransitions: transitionCommands.filter(
        (commandType) => commandType === "DYNAMIC_STEP_EXECUTED"
      ),
      resultStatus:
        execution.status === "blocked"
          ? execution.result.status
          : execution.status,
    }).toStrictEqual({
      blockCalls: [
        {
          blockedBy: {
            code: "capability_denied",
            message:
              "Generated workflow machine reached done without executing every planned step.",
            redacted: true,
          },
          summary:
            "Generated workflow machine completed without executing the full pinned plan.",
        },
      ],
      capturedTransitions: [],
      executedStepTransitions: ["DYNAMIC_STEP_EXECUTED"],
      resultStatus: "blocked",
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
      path: "report/hitl-decision.json",
      runId: request.runId,
    });
    await artifacts.writeJson({
      path: "report/hitl-decision.json",
      redacted: true,
      runId: request.runId,
      value: integrationTestMemoryHitlDecisionDocument({
        captureRunRef: artifacts.artifactRef({
          path: "dream/capture-run.json",
          runId: request.runId,
        }),
        refinementProposalRef: artifacts.artifactRef({
          path: "dream/refinement-proposals.json",
          runId: request.runId,
        }),
        reportRef: artifacts.artifactRef({
          path: "report/hitl-report.json",
          runId: request.runId,
        }),
        runId: request.runId,
        workItemId: request.workItemId,
      }),
    });
    let verifierOutputEvidence: readonly {
      readonly artifactRef: ArtifactRef;
      readonly text: string;
    }[] = [];
    const workflow = new WorkflowApp({
      agentVerifierLane: {
        laneKind: "verifier",
        runtime: "pi-agent-cli",
        async verify(input) {
          verifierOutputEvidence = input.outputEvidence.map((evidence) => ({
            artifactRef: evidence.artifactRef,
            text: evidence.text,
          }));
          const resultDocument = VerificationResultDocumentSchema.parse({
            checkedAt: "2026-06-09T21:20:00.000Z",
            contractId: input.contract.contractId,
            failures: [],
            resultId: `verification-result:${input.plan.runId}`,
            runId: input.plan.runId,
            schemaVersion: "workflow.verification-result.v1",
            status: "accepted",
            verifierLaneId: `lane:verifier:${input.plan.runId}`,
          });
          const resultWrite = await artifacts.writeJson({
            path: input.contract.outputPath,
            redacted: true,
            runId: input.plan.runId,
            value: resultDocument,
          });
          const promptWrite = await artifacts.writeText({
            mediaType: "text/markdown",
            path: "lanes/verifier/prompt.md",
            redacted: true,
            runId: input.plan.runId,
            value: "# Stub verifier prompt\n",
          });
          const transcriptWrite = await artifacts.writeText({
            mediaType: "text/markdown",
            path: "lanes/verifier/transcript.md",
            redacted: true,
            runId: input.plan.runId,
            value: "# Stub verifier transcript\n",
          });
          const receiptRef = artifacts.artifactRef({
            path: "receipts/verifier-lane.json",
            runId: input.plan.runId,
          });
          const receipt = AgentLaneReceiptSchema.parse({
            artifactCommitSha: "commit-dream-verifier-evidence",
            authLease: {
              expiresAt: "2026-06-09T21:35:00.000Z",
              issuedAt: "2026-06-09T21:20:00.000Z",
              leaseId: `lease:pi-agent-auth:${input.plan.runId}:verifier`,
              redacted: true,
              runId: input.plan.runId,
              scope: "pi-agent-auth-json",
              secretRef: "secretref:pi-agent-auth-json",
              workItemId: input.plan.workItemId,
            },
            completedAt: "2026-06-09T21:20:01.000Z",
            kind: "verifier",
            laneId: `lane:verifier:${input.plan.runId}`,
            outputPins: [
              {
                artifactRef: resultWrite.artifactRef,
                hash: resultWrite.contentHash,
                mediaType: resultWrite.mediaType,
              },
            ],
            outputRefs: [resultWrite.artifactRef],
            prompt: {
              artifactRef: promptWrite.artifactRef,
              hash: promptWrite.contentHash,
              mediaType: promptWrite.mediaType,
            },
            realAgent: true,
            receiptRef,
            redacted: true,
            runtime: "pi-agent-cli",
            startedAt: "2026-06-09T21:20:00.000Z",
            status: "completed",
            traceContext: {
              redacted: true,
              spanId: `span:${input.plan.runId}:verifier`,
              traceId: `trace:${input.plan.runId}`,
            },
            transcript: {
              artifactRef: transcriptWrite.artifactRef,
              hash: transcriptWrite.contentHash,
              mediaType: transcriptWrite.mediaType,
            },
          });
          await artifacts.writeJson({
            path: "receipts/verifier-lane.json",
            redacted: true,
            runId: input.plan.runId,
            value: receipt,
          });

          return {
            result: {
              artifactRef: resultWrite.artifactRef,
              hash: resultWrite.contentHash,
              mediaType: "application/json" as const,
              resultId: resultDocument.resultId,
            },
            resultDocument,
            verifierLaneReceipt: receipt,
          };
        },
      },
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
          const blueprint = addDreamPreflightToBlueprint(
            await planner.proposePlan(input),
            {
              hitlDecisionInputRef,
            }
          );

          return DynamicWorkflowBlueprintSchema.parse({
            ...blueprint,
            verificationContract: {
              ...blueprint.verificationContract,
              verifier: {
                kind: "agent-lane",
                runtime: "pi-agent-cli",
              },
            },
          });
        },
      },
      executionMode: "integration-test",
      installedSourceProfiles: [dreamTranscriptReviewSourceProfile],
      observabilityRecorder: createCloudflareArtifactsObservabilityRecorder({
        artifacts,
      }),
      packageRegistry: createMemoryPackageRegistryActor(
        dreamIntegrationPackages
      ),
      postExecutionArtifactRecorders: [
        {
          binding: {
            kind: "profile-id",
            packageId: dreamTranscriptReviewSourceProfile.packageId,
            profileId: dreamTranscriptReviewSourceProfile.profileId,
          },
          recorder: createMemoryGeneratedWorkflowProofRecorder({
            artifacts,
            buildAdditionalProofChecks: async ({ executionProof }) => [
              await buildWorkflowHitlReportAuditProofCheck({
                artifacts,
                executionProof,
              }),
            ],
            expectedPackageRef: memoryWorkflowPackageRef,
            expectedSourceProfile: dreamTranscriptReviewSourceProfile,
            expectedSourceProfileExportId:
              "dream-transcript-review-source-profile",
            now: () => "2026-06-09T21:30:00.000Z",
          }),
        },
      ],
      reviewGate: createMemoryReviewGateActor(artifacts),
      reviewSurfacePublisher: createCloudflareArtifactsReviewSurfacePublisher({
        artifacts,
      }),
      statusProjection: createMemoryWorkflowStatusProjectionStore(),
      workflowNodeAdapter: createArtifactBackedWorkflowCartridgeAdapter({
        artifacts,
        delegate: createMemoryFabricWorkflowNodeAdapter({
          artifacts,
          memoryCapture: createIntegrationTestMemoryFabricAdapter(),
          memoryCorrelation: createIntegrationTestMemoryCorrelationAdapter(),
          memoryRetrieval: createIntegrationTestMemoryRetrievalAdapter(),
          memorySignals: createIntegrationTestMemoryRetrievalAdapter(),
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
      artifactRef.endsWith("/report/hitl-report.json")
    );
    const reportMdsvxRef = result.artifactRefs.find((artifactRef) =>
      artifactRef.endsWith("/report/hitl-report.mdsvx")
    );
    const hitlDecisionSeedRef = result.artifactRefs.find((artifactRef) =>
      artifactRef.endsWith("/report/hitl-decision-workflow-seed.json")
    );
    const hitlFollowUpRef = result.artifactRefs.find((artifactRef) =>
      artifactRef.endsWith("/report/hitl-follow-up-run-request.json")
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
        "capture-dream-run",
        "mine-memory-signals",
        "search-dream-memory",
        "hydrate-dream-evidence",
        "correlate-dream-evidence",
        "propose-dream-refinements",
        "render-memory-hitl-report",
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
      captureArtifactRef: requireArtifactRef(
        "captureArtifactRef",
        captureArtifactRef
      ),
      captureRunRef: requireArtifactRef("captureRunRef", captureRunRef),
      correlationRef: requireArtifactRef("correlationRef", correlationRef),
      hitlDecisionInputRef,
      hitlDecisionSeedRef: requireArtifactRef(
        "hitlDecisionSeedRef",
        hitlDecisionSeedRef
      ),
      hitlFollowUpRef: requireArtifactRef("hitlFollowUpRef", hitlFollowUpRef),
      hydrationRef: requireArtifactRef("hydrationRef", hydrationRef),
      refinementRef: requireArtifactRef("refinementRef", refinementRef),
      reportMdsvxRef: requireArtifactRef("reportMdsvxRef", reportMdsvxRef),
      reportRef: requireArtifactRef("reportRef", reportRef),
      searchRef: requireArtifactRef("searchRef", searchRef),
      signalsRef: requireArtifactRef("signalsRef", signalsRef),
      wzrrdPayloadRef: requireArtifactRef("wzrrdPayloadRef", wzrrdPayloadRef),
    };

    const captureRun = MemoryCaptureReceiptDocumentSchema.parse(
      await artifacts.readJson({ artifactRef: dreamRefs.captureRunRef })
    );
    const signals = MemorySignalDocumentSchema.parse(
      await artifacts.readJson({ artifactRef: dreamRefs.signalsRef })
    );
    const search = MemorySearchDocumentSchema.parse(
      await artifacts.readJson({ artifactRef: dreamRefs.searchRef })
    );
    const hydration = MemoryHydrationDocumentSchema.parse(
      await artifacts.readJson({ artifactRef: dreamRefs.hydrationRef })
    );
    const correlation = MemoryCorrelationGraphDocumentSchema.parse(
      await artifacts.readJson({ artifactRef: dreamRefs.correlationRef })
    );
    const refinement = MemoryRefinementProposalDocumentSchema.parse(
      await artifacts.readJson({ artifactRef: dreamRefs.refinementRef })
    );
    const report = WorkflowHitlReportDocumentSchema.parse(
      await artifacts.readJson({ artifactRef: dreamRefs.reportRef })
    );
    const hitlDecisionSeed = MemoryHitlDecisionWorkflowSeedDocumentSchema.parse(
      await artifacts.readJson({ artifactRef: dreamRefs.hitlDecisionSeedRef })
    );
    const hitlFollowUp = MemoryHitlFollowUpRunRequestDocumentSchema.parse(
      await artifacts.readJson({ artifactRef: dreamRefs.hitlFollowUpRef })
    );
    const captureArtifact = MemoryCaptureReceiptDocumentSchema.parse(
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
      artifactRef.endsWith("/memory/generated-workflow-proof.json")
    );
    if (generatedWorkflowProofRef === undefined) {
      throw new Error("Expected Dream generated workflow proof artifact.");
    }
    const generatedWorkflowProof =
      MemoryGeneratedWorkflowProofDocumentSchema.parse(
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
    const cloudflareProofWithoutRelaySidecars = verifyMemoryGeneratedWorkflow({
      executionProof: cloudflareExecutionProofWithoutRelaySidecars,
      executionProofRef: result.executionProofArtifact.artifactRef,
      expectedPackageRef: memoryWorkflowPackageRef,
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
    const proofWithoutSourceProfile = verifyMemoryGeneratedWorkflow({
      executionProof,
      executionProofRef: result.executionProofArtifact.artifactRef,
      expectedPackageRef: memoryWorkflowPackageRef,
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
              ([key]) => key !== "memoryCoverageHorizons"
            )
          ),
        };
      }),
    });
    const proofWithoutHorizonCoverage = verifyMemoryGeneratedWorkflow({
      executionProof,
      executionProofRef: result.executionProofArtifact.artifactRef,
      expectedPackageRef: memoryWorkflowPackageRef,
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
                ([key]) => key !== "memorySourcePackDispositions"
              )
            ),
          };
        }),
      });
    const proofWithoutSourcePackDispositions = verifyMemoryGeneratedWorkflow({
      executionProof,
      executionProofRef: result.executionProofArtifact.artifactRef,
      expectedPackageRef: memoryWorkflowPackageRef,
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
            !Array.isArray(step.config["memorySourcePackDispositions"])
          ) {
            return step;
          }

          const dispositions = MemorySourcePackDispositionSchema.array().parse(
            step.config["memorySourcePackDispositions"]
          );

          return {
            ...step,
            config: {
              ...step.config,
              memorySourcePackDispositions: dispositions.map((disposition) => {
                if (disposition.packId !== "source-pack:joelhooks:work-graph") {
                  return disposition;
                }

                return {
                  ...disposition,
                  capabilityKinds: [
                    "memory.relay",
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
    const proofWithUnleasedSourcePackSelected = verifyMemoryGeneratedWorkflow({
      executionProof,
      executionProofRef: result.executionProofArtifact.artifactRef,
      expectedPackageRef: memoryWorkflowPackageRef,
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
    const combinedSignalsPlan = DynamicWorkflowPlanDocumentSchema.parse({
      ...plan,
      steps: plan.steps.flatMap((step) => {
        if (step.stepId === "mine-memory-signals") {
          return [];
        }

        if (
          step.kind === "workflow.node.invoke" &&
          step.stepId === "capture-dream-run"
        ) {
          return [
            {
              ...step,
              config: {
                ...step.config,
                memoryEffects: ["signals"],
              },
            },
          ];
        }

        return [step];
      }),
    });
    const missingSignalsPlan = DynamicWorkflowPlanDocumentSchema.parse({
      ...plan,
      steps: plan.steps.filter((step) => step.stepId !== "mine-memory-signals"),
    });
    const machineWithoutSignals = DynamicWorkflowMachineDocumentSchema.parse({
      ...machine,
      stepOrder: machine.stepOrder.filter(
        (stepId) => stepId !== "mine-memory-signals"
      ),
      xstate: {
        ...machine.xstate,
        states: Object.fromEntries(
          Object.entries(machine.xstate.states).filter(
            ([, state]) => state.meta.stepId !== "mine-memory-signals"
          )
        ),
      },
    });
    const executionProofWithoutSignals =
      WorkflowExecutionProofDocumentSchema.parse({
        ...executionProof,
        completedStepIds: executionProof.completedStepIds.filter(
          (stepId) => stepId !== "mine-memory-signals"
        ),
        machineArtifact: {
          ...executionProof.machineArtifact,
          hash: hashJson(machineWithoutSignals),
        },
      });
    const combinedEffectProof = verifyMemoryGeneratedWorkflow({
      executionProof: executionProofWithoutSignals,
      executionProofRef: result.executionProofArtifact.artifactRef,
      expectedPackageRef: memoryWorkflowPackageRef,
      expectedSourceProfile: dreamTranscriptReviewSourceProfile,
      expectedSourceProfileExportId: "dream-transcript-review-source-profile",
      generatedAt: "2026-06-09T21:47:00.000Z",
      harnessArtifact: result.harnessArtifact,
      harnessSource: await artifacts.readText({
        artifactRef: result.harnessArtifact.artifactRef,
      }),
      machine: machineWithoutSignals,
      machineArtifact: {
        ...result.machineArtifact,
        hash: hashJson(machineWithoutSignals),
      },
      machineSource: await artifacts.readText({
        artifactRef: result.machineArtifact.sourceArtifactRef,
      }),
      plan: combinedSignalsPlan,
      planArtifact: {
        ...result.planArtifact,
        hash: hashJson(combinedSignalsPlan),
      },
    });
    const missingSignalsEffectProof = verifyMemoryGeneratedWorkflow({
      executionProof: executionProofWithoutSignals,
      executionProofRef: result.executionProofArtifact.artifactRef,
      expectedPackageRef: memoryWorkflowPackageRef,
      expectedSourceProfile: dreamTranscriptReviewSourceProfile,
      expectedSourceProfileExportId: "dream-transcript-review-source-profile",
      generatedAt: "2026-06-09T21:48:00.000Z",
      harnessArtifact: result.harnessArtifact,
      harnessSource: await artifacts.readText({
        artifactRef: result.harnessArtifact.artifactRef,
      }),
      machine: machineWithoutSignals,
      machineArtifact: {
        ...result.machineArtifact,
        hash: hashJson(machineWithoutSignals),
      },
      machineSource: await artifacts.readText({
        artifactRef: result.machineArtifact.sourceArtifactRef,
      }),
      plan: missingSignalsPlan,
      planArtifact: {
        ...result.planArtifact,
        hash: hashJson(missingSignalsPlan),
      },
    });
    const executionReceiptEvidence = verifierOutputEvidence.find((evidence) =>
      evidence.artifactRef.endsWith(
        "/run/generated-workflow-execution-receipt.json"
      )
    );
    const executionReceiptText = executionReceiptEvidence?.text ?? "";

    expect({
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
      executionProofRelayLeaseRefs:
        executionProof.workflowNodeOutputRefs.filter((artifactRef) =>
          artifactRef.includes("/memory/relay-lease-receipts/")
        ),
      executionProofStatus: executionProof.status,
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
        hitlFollowUp.request?.runId.startsWith("run-memory-hitl-follow-up-") ??
        false,
      hitlFollowUpRequestWorkItemIdStartsWith:
        hitlFollowUp.request?.workItemId.startsWith(
          "work-item:memory-hitl-follow-up:"
        ) ?? false,
      hitlFollowUpRequestedPackageIds: hitlFollowUp.requestedPackageIds,
      hitlFollowUpRequiredCapabilityKinds: hitlFollowUp.requiredCapabilityKinds,
      hitlFollowUpSchemaVersion: hitlFollowUp.schemaVersion,
      hitlFollowUpStatus: hitlFollowUp.status,
      hitlFollowUpSubmitted: hitlFollowUp.submitted,
      hydratedReceiptCount: hydration.hydrated.length,
      memoryGeneratedProofArtifactRef: generatedWorkflowProofRef.endsWith(
        "/memory/generated-workflow-proof.json"
      ),
      memoryGeneratedProofCheckIds: generatedWorkflowProof.checks.map(
        (check) => check.checkId
      ),
      memoryGeneratedProofEffectCoverage: generatedWorkflowProof.effectCoverage,
      memoryGeneratedProofFailures: generatedWorkflowProof.failures,
      memoryGeneratedProofHorizonCoverage:
        generatedWorkflowProof.horizonCoverage,
      memoryGeneratedProofNodeTypes: generatedWorkflowProof.nodeTypes,
      memoryGeneratedProofRawTranscriptsReturned:
        generatedWorkflowProof.rawTranscriptsReturned,
      memoryGeneratedProofRelayLeaseRefs:
        generatedWorkflowProof.relayLeaseReceiptRefs,
      memoryGeneratedProofReportAuditCheck: generatedWorkflowProof.checks.find(
        (check) => check.checkId === "report:definition-of-done-audit"
      ),
      memoryGeneratedProofSourcePackDisposition:
        generatedWorkflowProof.sourcePackDisposition,
      memoryGeneratedProofSourceProfile: generatedWorkflowProof.sourceProfile,
      memoryGeneratedProofStatus: generatedWorkflowProof.status,
      memoryGeneratedProofStepCount: generatedWorkflowProof.stepCount,
      missingSignalsEffectProofFailedChecks: missingSignalsEffectProof.checks
        .filter((check) => check.status === "failed")
        .map((check) => check.checkId),
      missingSignalsEffectProofStatus: missingSignalsEffectProof.status,
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
      reportFindingCount: report.findingCount,
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
      reportMdsvxIncludesDynamicProof: report.mdsvx.includes(
        "## Dynamic generation proof"
      ),
      reportMdsvxIncludesFindingsFirst: report.mdsvx.includes(
        "## The actual findings"
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
        "memory.hitl-decision.v1"
      ),
      reportMdsvxIncludesRefinement: report.mdsvx.includes(
        "Refinement proposals emitted: 4."
      ),
      reportMdsvxIncludesReportNode: report.mdsvx.includes("## Report node"),
      reportMdsvxIncludesReportStandard:
        report.mdsvx.includes("## Report standard"),
      reportMdsvxIncludesRunCoverage: report.mdsvx.includes("## Run coverage"),
      reportMdsvxIncludesWhatDidNotHappen: report.mdsvx.includes(
        "## What did not happen"
      ),
      reportMdsvxNoCandidateReview: !report.mdsvx.includes("Candidate review"),
      reportMdsvxPutsFindingsBeforeProof:
        report.mdsvx.indexOf("## The actual findings") <
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
          report.proof.stateMachineFigure.source.includes("capture-dream-run"),
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
      verifierEvidenceRefsIncludeDreamOutputs: [
        dreamRefs.searchRef,
        dreamRefs.reportRef,
        dreamRefs.hitlDecisionSeedRef,
        dreamRefs.hitlFollowUpRef,
      ].every((artifactRef) =>
        verifierOutputEvidence.some(
          (evidence) => evidence.artifactRef === artifactRef
        )
      ),
      verifierEvidenceTextIncludesDreamSchemas: [
        "memory.search.v1",
        "workflow.hitl-report.v1",
        "memory.hitl-decision-workflow-seed.v1",
        "memory.hitl-follow-up-run-request.v1",
      ].every((schemaVersion) =>
        verifierOutputEvidence.some((evidence) =>
          evidence.text.includes(schemaVersion)
        )
      ),
      verifierGeneratedWorkflowExecutionReceipt: {
        advancedWithNext: executionReceiptText.includes(
          '"advancedWith": "NEXT"'
        ),
        allPlanStepsCompleted: executionReceiptText.includes(
          '"allPlanStepsCompleted": true'
        ),
        artifactRef: executionReceiptEvidence?.artifactRef,
        completionEventStepDone: executionReceiptText.includes(
          '"completionEvent": "STEP_DONE"'
        ),
        includesAllPlanStepIds: plan.steps.every((step) =>
          executionReceiptText.includes(JSON.stringify(step.stepId))
        ),
        reachedDone: executionReceiptText.includes('"reachedDone": true'),
        schemaVersion: executionReceiptText.includes(
          "workflow.generated-machine-execution-receipt.v1"
        ),
        startStateReady: executionReceiptText.includes('"startState": "ready"'),
        surface: executionReceiptText.includes(
          "local-integration-generated-machine-supervisor"
        ),
      },
      wzrrdPrimaryDocument: wzrrdPayload.primaryDocument,
    }).toStrictEqual({
      captureArtifactKind: "artifact",
      captureArtifactRef: dreamRefs.reportRef,
      captureArtifactSourceSystem: "cloudflare-artifacts",
      captureRunCapturedRunId: result.runId,
      captureRunKind: "run",
      captureRunRef: `artifact://integration-memory/runs/${result.runId}/capture/run.json`,
      captureRunSourceSystem: "cloudflare-workflow-run",
      cartridgeProofs: [
        {
          nodeType: "joelclaw.memory.capture-run",
          packageId: "workflow/memory-fabric",
          packageRef: memoryWorkflowPackageRef,
          status: "verified",
          verification: {
            exportMatched: true,
            nodeTypeMatched: true,
            packagePinned: true,
            sideEffectsRequireLeases: true,
          },
        },
        {
          nodeType: "joelclaw.memory.signals",
          packageId: "workflow/memory-fabric",
          packageRef: memoryWorkflowPackageRef,
          status: "verified",
          verification: {
            exportMatched: true,
            nodeTypeMatched: true,
            packagePinned: true,
            sideEffectsRequireLeases: true,
          },
        },
        {
          nodeType: "joelclaw.memory.search",
          packageId: "workflow/memory-fabric",
          packageRef: memoryWorkflowPackageRef,
          status: "verified",
          verification: {
            exportMatched: true,
            nodeTypeMatched: true,
            packagePinned: true,
            sideEffectsRequireLeases: true,
          },
        },
        {
          nodeType: "joelclaw.memory.hydrate",
          packageId: "workflow/memory-fabric",
          packageRef: memoryWorkflowPackageRef,
          status: "verified",
          verification: {
            exportMatched: true,
            nodeTypeMatched: true,
            packagePinned: true,
            sideEffectsRequireLeases: true,
          },
        },
        {
          nodeType: "joelclaw.memory.correlate",
          packageId: "workflow/memory-fabric",
          packageRef: memoryWorkflowPackageRef,
          status: "verified",
          verification: {
            exportMatched: true,
            nodeTypeMatched: true,
            packagePinned: true,
            sideEffectsRequireLeases: true,
          },
        },
        {
          nodeType: "joelclaw.memory.refinement-proposals",
          packageId: "workflow/memory-fabric",
          packageRef: memoryWorkflowPackageRef,
          status: "verified",
          verification: {
            exportMatched: true,
            nodeTypeMatched: true,
            packagePinned: true,
            sideEffectsRequireLeases: true,
          },
        },
        {
          nodeType: "joelclaw.memory.hitl-report",
          packageId: "workflow/memory-fabric",
          packageRef: memoryWorkflowPackageRef,
          status: "verified",
          verification: {
            exportMatched: true,
            nodeTypeMatched: true,
            packagePinned: true,
            sideEffectsRequireLeases: true,
          },
        },
        {
          nodeType: "joelclaw.memory.hitl-decision-seed",
          packageId: "workflow/memory-fabric",
          packageRef: memoryWorkflowPackageRef,
          status: "verified",
          verification: {
            exportMatched: true,
            nodeTypeMatched: true,
            packagePinned: true,
            sideEffectsRequireLeases: true,
          },
        },
        {
          nodeType: "joelclaw.memory.hitl-follow-up-run-request",
          packageId: "workflow/memory-fabric",
          packageRef: memoryWorkflowPackageRef,
          status: "verified",
          verification: {
            exportMatched: true,
            nodeTypeMatched: true,
            packagePinned: true,
            sideEffectsRequireLeases: true,
          },
        },
        {
          nodeType: "joelclaw.memory.capture-artifact",
          packageId: "workflow/memory-fabric",
          packageRef: memoryWorkflowPackageRef,
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
        "capture-artifact",
        "capture-run",
        "correlate",
        "hitl-decision-seed",
        "hitl-follow-up-run-request",
        "hitl-report",
        "hydrate",
        "refinement-proposals",
        "search",
        "signals",
      ],
      combinedEffectProofStatus: "verified",
      combinedEffectProofStepCount: 9,
      completedStepIds: [
        "capture-dream-run",
        "mine-memory-signals",
        "search-dream-memory",
        "hydrate-dream-evidence",
        "correlate-dream-evidence",
        "propose-dream-refinements",
        "render-memory-hitl-report",
        "seed-next-workflow-from-hitl",
        "draft-follow-up-run-request-from-hitl",
        "capture-dream-report-artifact",
      ],
      correlationEdgeCount: 5,
      correlationNodeCount: 7,
      correlationSchemaVersion: "memory.correlation-graph.v1",
      executionProofRelayLeaseRefs: [],
      executionProofStatus: "not-proven-local-integration",
      hitlDecisionSeedAcceptedDecisionIds: [
        "decision:dream:generated-machine-proof",
      ],
      hitlDecisionSeedActionableDecisionCount: 2,
      hitlDecisionSeedDecisionRef: dreamRefs.hitlDecisionInputRef,
      hitlDecisionSeedRequiredCapabilities: ["brain.update.review"],
      hitlDecisionSeedSchemaVersion: "memory.hitl-decision-workflow-seed.v1",
      hitlDecisionSeedSourceRefs: [
        dreamRefs.hitlDecisionInputRef,
        dreamRefs.reportRef,
        dreamRefs.refinementRef,
        dreamRefs.captureRunRef,
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
        "workflow/memory-fabric",
      ],
      hitlFollowUpRequiredCapabilityKinds: ["brain.update.review"],
      hitlFollowUpSchemaVersion: "memory.hitl-follow-up-run-request.v1",
      hitlFollowUpStatus: "drafted",
      hitlFollowUpSubmitted: false,
      hydratedReceiptCount: 2,
      memoryGeneratedProofArtifactRef: true,
      memoryGeneratedProofCheckIds: [
        "plan:hash-pinned",
        "machine:hash-pinned",
        "harness:hash-pinned",
        "plan:profile-effect-coverage",
        "plan:horizon-coverage",
        "plan:source-profile-bound",
        "plan:source-pack-disposition",
        "machine:step-order-bound",
        "execution:generated-machine-sequence",
        "execution:relay-lease-sidecars",
        "execution:no-raw-transcripts",
        "report:definition-of-done-audit",
      ],
      memoryGeneratedProofEffectCoverage: {
        coveredEffects: [
          "capture-artifact",
          "capture-run",
          "correlate",
          "hitl-decision-seed",
          "hitl-follow-up-run-request",
          "hitl-report",
          "hydrate",
          "refinement-proposals",
          "search",
          "signals",
        ],
        requiredEffects: [
          "capture-artifact",
          "capture-run",
          "correlate",
          "hitl-decision-seed",
          "hitl-follow-up-run-request",
          "hitl-report",
          "hydrate",
          "refinement-proposals",
          "search",
          "signals",
        ],
      },
      memoryGeneratedProofFailures: [],
      memoryGeneratedProofHorizonCoverage: {
        coveredHorizons: ["24h", "7d", "30d", "quarter", "all-time"],
        requiredHorizons: ["24h", "7d", "30d", "quarter", "all-time"],
      },
      memoryGeneratedProofNodeTypes: [
        "joelclaw.memory.capture-run",
        "joelclaw.memory.signals",
        "joelclaw.memory.search",
        "joelclaw.memory.hydrate",
        "joelclaw.memory.correlate",
        "joelclaw.memory.refinement-proposals",
        "joelclaw.memory.hitl-report",
        "joelclaw.memory.hitl-decision-seed",
        "joelclaw.memory.hitl-follow-up-run-request",
        "joelclaw.memory.capture-artifact",
      ],
      memoryGeneratedProofRawTranscriptsReturned: false,
      memoryGeneratedProofRelayLeaseRefs: [],
      memoryGeneratedProofReportAuditCheck: {
        checkId: "report:definition-of-done-audit",
        evidenceRefs: [dreamRefs.reportRef],
        status: "passed",
        summary: `Workflow HITL report ${dreamRefs.reportRef} carries not-proven definition-of-done audit without overclaiming post-report gates.`,
      },
      memoryGeneratedProofSourcePackDisposition: {
        dispositionCount: 2,
        dispositions: [
          {
            capabilityKinds: [],
            leaseRefs: [],
            missingCapabilityKinds: [
              "memory.relay",
              "github.read",
              "linear.read",
              "slack.search",
            ],
            packId: "source-pack:joelhooks:work-graph",
            packageId: "source-pack/joelhooks-work-graph",
            reason:
              "Skipped until scoped source-pack leases are available for this generated run.",
            requiredCapabilityKinds: [
              "memory.relay",
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
              "memory.relay",
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
      memoryGeneratedProofSourceProfile: {
        allowedRelayOperations: [
          "capture-run",
          "capture-artifact",
          "signals",
          "search",
          "hydrate",
          "correlate",
        ],
        hash: hashJson(dreamTranscriptReviewSourceProfile),
        packageExportId: "dream-transcript-review-source-profile",
        packageId: "workflow/memory-fabric",
        profileId: "joelhooks/dream-transcript-review",
        requiredOutputEffects: [
          "refinement-proposals",
          "hitl-decision-seed",
          "hitl-follow-up-run-request",
          "hitl-report",
        ],
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
        workflowId: "dream.transcript-review",
      },
      memoryGeneratedProofStatus: "verified",
      memoryGeneratedProofStepCount: 10,
      missingSignalsEffectProofFailedChecks: ["plan:profile-effect-coverage"],
      missingSignalsEffectProofStatus: "failed",
      proofWithUnleasedSourcePackSelectedFailedChecks: [],
      proofWithUnleasedSourcePackSelectedStatus: "verified",
      proofWithoutHorizonCoverageFailedChecks: ["plan:horizon-coverage"],
      proofWithoutHorizonCoverageStatus: "failed",
      proofWithoutSourcePackDispositionsFailedChecks: [],
      proofWithoutSourcePackDispositionsStatus: "verified",
      proofWithoutSourceProfileFailedChecks: ["plan:source-profile-bound"],
      proofWithoutSourceProfileStatus: "failed",
      refinementNextWorkflowProposalIds: [
        "proposal:dynamic-workflow-pattern:signal:1:signal-integration-workflow-pattern",
        "proposal:dynamic-workflow-pattern:1:integration-memory-search-found-agent-tr",
        "proposal:kernel-memory:2:integration-memory-search-found-brain-ev",
        "proposal:dynamic-workflow-pattern:3:integration-memory-search-found-cloudfla",
      ],
      refinementProposalCount: 4,
      refinementRecommendationKinds: [
        "dynamic-workflow-pattern:turn-into-work",
        "dynamic-workflow-pattern:accept",
        "kernel-memory:accept",
        "dynamic-workflow-pattern:turn-into-work",
      ],
      refinementSourceRefs: [
        dreamRefs.signalsRef,
        dreamRefs.searchRef,
        dreamRefs.hydrationRef,
        dreamRefs.correlationRef,
      ],
      reportDefinitionOfDoneAuditItems: [
        "workflow-cartridge-package:captured",
        "worker-facing-relay-capability-lease:not-proven",
        "live-cloudflare-execution:not-proven",
        "generated-machine-and-harness:captured",
        "t-shaped-memory-coverage:captured",
        "findings-and-refinement-proposals:captured",
        "hitl-refinement-loop:not-proven",
        "workflow-owned-wzrrd-output:not-proven",
        "public-private-redaction-boundary:captured",
      ],
      reportDefinitionOfDoneAuditStatus: "not-proven",
      reportDefinitionOfDoneAuditSummary: {
        blockedCount: 0,
        capturedCount: 5,
        missingCount: 0,
        notProvenCount: 4,
        totalCount: 9,
      },
      reportFindingCount: 3,
      reportHitlDecisionContract: {
        artifactPath: "report/hitl-decision.json",
        contractRef: "contract://workflow/memory-fabric/hitl-decision.v1",
        decisionSchemaVersion: "memory.hitl-decision.v1",
        exportId: "memory-hitl-decision-schema",
        nextWorkflowSeedRequiredFor: ["accept", "turn-into-work"],
        sourceRefs: [
          dreamRefs.searchRef,
          dreamRefs.hydrationRef,
          dreamRefs.correlationRef,
          dreamRefs.refinementRef,
        ],
        targetKinds: ["finding-card", "refinement-proposal"],
      },
      reportMdsvxIncludesAccessAdapter: true,
      reportMdsvxIncludesD2: true,
      reportMdsvxIncludesD2Fig: true,
      reportMdsvxIncludesD2FigAspectRatio: true,
      reportMdsvxIncludesDefinitionAudit: true,
      reportMdsvxIncludesDynamicProof: true,
      reportMdsvxIncludesFindingsFirst: true,
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
      reportMdsvxPutsFindingsBeforeProof: true,
      reportMdsvxRefPublished: dreamRefs.reportMdsvxRef,
      reportMdsvxSourceMatchesJson: true,
      reportProofGeneratedArtifacts: {
        harness: result.harnessArtifact,
        machine: result.machineArtifact,
        plan: {
          planId: plan.planId,
          planner: plan.planner,
          stepCount: 10,
        },
        verificationContract: result.verificationContractArtifact,
      },
      reportProofLevel: "generated-machine",
      reportRawTranscriptsReturned: false,
      reportRefinementProposalCount: 4,
      reportRefinementProposalRef: dreamRefs.refinementRef,
      reportSectionOrder: [
        "run-context",
        "actual-findings",
        "what-to-do",
        "actionable-line-items",
        "proof",
        "technical-appendix",
      ],
      reportSourceRefs: [
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
        stateCount: 13,
        transitionCount: 21,
      },
      reportTemplate: "joel/tufte-mdsvx@0.1.0",
      searchHitCount: 3,
      searchReceiptFamilies: ["agent-transcripts", "brain", "cloudflare-runs"],
      signalKinds: ["workflow-pattern"],
      signalReceiptFamilies: ["agent-transcripts"],
      verifierEvidenceRefsIncludeDreamOutputs: true,
      verifierEvidenceTextIncludesDreamSchemas: true,
      verifierGeneratedWorkflowExecutionReceipt: {
        advancedWithNext: true,
        allPlanStepsCompleted: true,
        artifactRef: artifacts.artifactRef({
          path: "run/generated-workflow-execution-receipt.json",
          runId: result.runId,
        }),
        completionEventStepDone: true,
        includesAllPlanStepIds: true,
        reachedDone: true,
        schemaVersion: true,
        startStateReady: true,
        surface: true,
      },
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

  it("checks effect coverage against the run profile's declared effects, not memory-fabric constants", async () => {
    const artifacts = createMemoryArtifactStore(
      "workflow-app-profile-declared-effects"
    );
    const planner = createIntegrationTestDynamicWorkflowPlanner();
    const request = buildIntegrationTestDreamRunRequest();
    const hitlDecisionInputRef = artifacts.artifactRef({
      path: "report/hitl-decision.json",
      runId: request.runId,
    });
    await artifacts.writeJson({
      path: "report/hitl-decision.json",
      redacted: true,
      runId: request.runId,
      value: integrationTestMemoryHitlDecisionDocument({
        captureRunRef: artifacts.artifactRef({
          path: "dream/capture-run.json",
          runId: request.runId,
        }),
        refinementProposalRef: artifacts.artifactRef({
          path: "dream/refinement-proposals.json",
          runId: request.runId,
        }),
        reportRef: artifacts.artifactRef({
          path: "report/hitl-report.json",
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
      reviewGate: createMemoryReviewGateActor(artifacts),
      reviewSurfacePublisher: createCloudflareArtifactsReviewSurfacePublisher({
        artifacts,
      }),
      statusProjection: createMemoryWorkflowStatusProjectionStore(),
      workflowNodeAdapter: createArtifactBackedWorkflowCartridgeAdapter({
        artifacts,
        delegate: createMemoryFabricWorkflowNodeAdapter({
          artifacts,
          memoryCapture: createIntegrationTestMemoryFabricAdapter(),
          memoryCorrelation: createIntegrationTestMemoryCorrelationAdapter(),
          memoryRetrieval: createIntegrationTestMemoryRetrievalAdapter(),
          memorySignals: createIntegrationTestMemoryRetrievalAdapter(),
        }),
        now: () => "2026-06-10T09:00:00.000Z",
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

    const plan = DynamicWorkflowPlanDocumentSchema.parse(
      await artifacts.readJson({ artifactRef: result.planArtifact.artifactRef })
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
    const machineSource = await artifacts.readText({
      artifactRef: result.machineArtifact.sourceArtifactRef,
    });
    const harnessSource = await artifacts.readText({
      artifactRef: result.harnessArtifact.artifactRef,
    });
    const supportSweepSourceProfile = MemorySourceProfileSchema.parse({
      allowedRelayOperations: ["search", "hydrate"],
      defaultQuery: "aihero support sweep",
      outputBoundary: {
        noCustomerDataInPublicArtifacts: true,
        noRawCredentials: true,
        noRawPrivatePaths: true,
        noRawTranscripts: true,
      },
      packageId: "workflow/memory-fabric",
      profileId: "badass-courses/aihero-support-sweep",
      purpose:
        "Sweep support threads across surfaces and digest them for review.",
      requiredOutputEffects: ["support-digest"],
      requiredRuntimes: ["cloudflare"],
      schemaVersion: "memory.source-profile.v1",
      sourceFamiliesExpected: ["support"],
      sourcePacks: [],
      timeHorizons: ["7d"],
      title: "AIHero Support Sweep",
      workflowId: "aihero.support-sweep",
    });
    const planWithSupportDigest = DynamicWorkflowPlanDocumentSchema.parse({
      ...plan,
      steps: plan.steps.map((step) =>
        step.kind === "workflow.node.invoke" &&
        step.stepId === "render-memory-hitl-report"
          ? {
              ...step,
              config: {
                ...step.config,
                memoryEffects: ["support-digest"],
              },
            }
          : step
      ),
    });
    const verifyAgainstSupportProfile = (
      planForProof: typeof plan
    ): ReturnType<typeof verifyMemoryGeneratedWorkflow> =>
      verifyMemoryGeneratedWorkflow({
        executionProof,
        executionProofRef: result.executionProofArtifact.artifactRef,
        expectedPackageRef: memoryWorkflowPackageRef,
        expectedSourceProfile: supportSweepSourceProfile,
        expectedSourceProfileExportId: "dream-transcript-review-source-profile",
        generatedAt: "2026-06-10T09:30:00.000Z",
        harnessArtifact: result.harnessArtifact,
        harnessSource,
        machine,
        machineArtifact: result.machineArtifact,
        machineSource,
        plan: planForProof,
        planArtifact: {
          ...result.planArtifact,
          hash: hashJson(planForProof),
        },
      });
    const proofCoveringItsEffects = verifyAgainstSupportProfile(
      planWithSupportDigest
    );
    const proofMissingItsEffects = verifyAgainstSupportProfile(plan);

    expect({
      coverageWithDeclaredEffect: effectCoverageStatusFor(
        proofCoveringItsEffects
      ),
      coverageWithoutDeclaredEffect: effectCoverageStatusFor(
        proofMissingItsEffects
      ),
      malformedEffectIdAccepted: MemorySourceProfileSchema.safeParse({
        ...supportSweepSourceProfile,
        requiredOutputEffects: ["Support_Digest"],
      }).success,
      requiredEffects: proofCoveringItsEffects.effectCoverage.requiredEffects,
    }).toStrictEqual({
      coverageWithDeclaredEffect: "passed",
      coverageWithoutDeclaredEffect: "failed",
      malformedEffectIdAccepted: false,
      requiredEffects: ["hydrate", "search", "support-digest"],
    });
  });

  it("runs only post-execution recorders bound to the run's source profile", async () => {
    const { recordedLabels, result } =
      await runWorkflowWithProfileBoundRecorders({
        sourceProfileId: "badass-courses/aihero-support-sweep",
        storeName: "workflow-app-recorder-profile-binding",
      });
    if (result.status !== "captured") {
      throw new Error(result.blocker.message);
    }

    expect({
      memoryProofRecorded: result.artifactRefs.some((artifactRef) =>
        artifactRef.endsWith("/memory/generated-workflow-proof.json")
      ),
      recordedLabels,
      status: result.status,
      supportSweepReceiptRecorded: result.artifactRefs.some((artifactRef) =>
        artifactRef.endsWith("/recorders/support-sweep-proof.json")
      ),
    }).toStrictEqual({
      memoryProofRecorded: false,
      recordedLabels: ["support-sweep-proof"],
      status: "captured",
      supportSweepReceiptRecorded: true,
    });
  });

  it("runs zero post-execution recorders when the run request declares no source profile", async () => {
    const { recordedLabels, result } =
      await runWorkflowWithProfileBoundRecorders({
        storeName: "workflow-app-recorder-no-profile",
      });
    if (result.status !== "captured") {
      throw new Error(result.blocker.message);
    }

    expect({
      memoryProofRecorded: result.artifactRefs.some((artifactRef) =>
        artifactRef.endsWith("/memory/generated-workflow-proof.json")
      ),
      recordedLabels,
      status: result.status,
    }).toStrictEqual({
      memoryProofRecorded: false,
      recordedLabels: [],
      status: "captured",
    });
  });

  it("blocks a proof-required source profile whose recorder binding mismatches", async () => {
    const { recordedLabels, result } =
      await runWorkflowWithProfileBoundRecorders({
        dreamRecorderBindingProfileId: `${dreamTranscriptReviewSourceProfile.profileId}-drifted`,
        installedSourceProfiles: [dreamTranscriptReviewSourceProfile],
        sourceProfileId: dreamTranscriptReviewSourceProfile.profileId,
        storeName: "workflow-app-recorder-required-mismatch",
      });
    if (result.status !== "blocked") {
      throw new Error("Expected the mismatched-recorder run to block.");
    }

    expect({
      blockerCode: result.blocker.code,
      blockerMessage: result.blocker.message,
      recordedLabels,
      status: result.status,
    }).toStrictEqual({
      blockerCode: "capability_denied",
      blockerMessage: `Installed source profile "${dreamTranscriptReviewSourceProfile.profileId}" requires generated workflow proof recording, but no registered post-execution recorder binding matched it.`,
      recordedLabels: [],
      status: "blocked",
    });
  });

  it("captures a recorder-free run whose installed source profile does not require generated workflow proof", async () => {
    const dataOnlySourceProfile: MemorySourceProfile =
      MemorySourceProfileSchema.parse({
        allowedRelayOperations: ["search", "hydrate"],
        defaultQuery: "aihero support sweep",
        outputBoundary: {
          noCustomerDataInPublicArtifacts: true,
          noRawCredentials: true,
          noRawPrivatePaths: true,
          noRawTranscripts: true,
        },
        packageId: "workflow/memory-fabric",
        profileId: "skill-recordings/aihero-support-sweep-data-only",
        purpose:
          "Sweep support threads across surfaces and digest them for review.",
        requiredOutputEffects: ["support-digest"],
        requiredRuntimes: ["cloudflare"],
        schemaVersion: "memory.source-profile.v1",
        sourceFamiliesExpected: ["support"],
        sourcePacks: [],
        timeHorizons: ["7d"],
        title: "AIHero Support Sweep Data Only",
        workflowId: "aihero.support-sweep",
      });
    const { recordedLabels, result } =
      await runWorkflowWithProfileBoundRecorders({
        installedSourceProfiles: [dataOnlySourceProfile],
        sourceProfileId: dataOnlySourceProfile.profileId,
        storeName: "workflow-app-recorder-data-only-profile",
      });
    if (result.status !== "captured") {
      throw new Error(result.blocker.message);
    }

    expect({
      memoryProofRecorded: result.artifactRefs.some((artifactRef) =>
        artifactRef.endsWith("/memory/generated-workflow-proof.json")
      ),
      recordedLabels,
      requiresGeneratedWorkflowProof:
        dataOnlySourceProfile.requiresGeneratedWorkflowProof,
      status: result.status,
    }).toStrictEqual({
      memoryProofRecorded: false,
      recordedLabels: [],
      requiresGeneratedWorkflowProof: false,
      status: "captured",
    });
  });

  it("rejects binary media types for Dream artifact capture nodes", async () => {
    const artifacts = createMemoryArtifactStore(
      "workflow-app-dream-binary-capture"
    );
    const memoryFabric = createIntegrationTestMemoryFabricAdapter();
    const adapter = createMemoryFabricWorkflowNodeAdapter({
      artifacts,
      memoryCapture: memoryFabric,
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
      nodeType: "joelclaw.memory.capture-artifact",
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
      "Memory capture artifact mediaType must be application/json or a supported text media type."
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

  const buildDreamValidationWorkflow = (input: {
    readonly artifactStore: string;
    readonly mutateStepConfig?: (step: {
      readonly config: Record<string, unknown>;
      readonly nodeType: string;
      readonly stepId: string;
    }) => Record<string, unknown> | null;
  }) => {
    const artifacts = createMemoryArtifactStore(input.artifactStore);
    const planner = createIntegrationTestDynamicWorkflowPlanner();
    const request = buildIntegrationTestDreamRunRequest();
    const hitlDecisionInputRef = artifacts.artifactRef({
      path: "report/hitl-decision.json",
      runId: request.runId,
    });
    const statusProjection = createMemoryWorkflowStatusProjectionStore();
    const writeHitlDecision = artifacts.writeJson({
      path: "report/hitl-decision.json",
      redacted: true,
      runId: request.runId,
      value: integrationTestMemoryHitlDecisionDocument({
        captureRunRef: artifacts.artifactRef({
          path: "dream/capture-run.json",
          runId: request.runId,
        }),
        refinementProposalRef: artifacts.artifactRef({
          path: "dream/refinement-proposals.json",
          runId: request.runId,
        }),
        reportRef: artifacts.artifactRef({
          path: "report/hitl-report.json",
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
        async proposePlan(plannerInput) {
          const blueprint = addDreamPreflightToBlueprint(
            await planner.proposePlan(plannerInput),
            { hitlDecisionInputRef }
          );
          if (input.mutateStepConfig === undefined) {
            return blueprint;
          }

          return DynamicWorkflowBlueprintSchema.parse({
            ...blueprint,
            plan: {
              ...blueprint.plan,
              steps: blueprint.plan.steps.map((step) => {
                if (step.kind !== "workflow.node.invoke") {
                  return step;
                }
                const nextConfig = input.mutateStepConfig?.({
                  config: step.config,
                  nodeType: step.nodeType,
                  stepId: step.stepId,
                });

                return nextConfig === null || nextConfig === undefined
                  ? step
                  : { ...step, config: nextConfig };
              }),
            },
          });
        },
      },
      executionMode: "integration-test",
      installedSourceProfiles: [dreamTranscriptReviewSourceProfile],
      observabilityRecorder: createCloudflareArtifactsObservabilityRecorder({
        artifacts,
      }),
      packageRegistry: createMemoryPackageRegistryActor(
        dreamIntegrationPackages
      ),
      postExecutionArtifactRecorders: [
        {
          binding: {
            kind: "profile-id",
            packageId: dreamTranscriptReviewSourceProfile.packageId,
            profileId: dreamTranscriptReviewSourceProfile.profileId,
          },
          recorder: createMemoryGeneratedWorkflowProofRecorder({
            artifacts,
            buildAdditionalProofChecks: async ({ executionProof }) => [
              await buildWorkflowHitlReportAuditProofCheck({
                artifacts,
                executionProof,
              }),
            ],
            expectedPackageRef: memoryWorkflowPackageRef,
            expectedSourceProfile: dreamTranscriptReviewSourceProfile,
            expectedSourceProfileExportId:
              "dream-transcript-review-source-profile",
            now: () => "2026-06-10T10:30:00.000Z",
          }),
        },
      ],
      reviewGate: createMemoryReviewGateActor(artifacts),
      reviewSurfacePublisher: createCloudflareArtifactsReviewSurfacePublisher({
        artifacts,
      }),
      statusProjection,
      workflowNodeAdapter: createArtifactBackedWorkflowCartridgeAdapter({
        artifacts,
        delegate: createMemoryFabricWorkflowNodeAdapter({
          artifacts,
          memoryCapture: createIntegrationTestMemoryFabricAdapter(),
          memoryCorrelation: createIntegrationTestMemoryCorrelationAdapter(),
          memoryRetrieval: createIntegrationTestMemoryRetrievalAdapter(),
          memorySignals: createIntegrationTestMemoryRetrievalAdapter(),
        }),
        now: () => "2026-06-10T10:00:00.000Z",
      }),
      wzrrdPublisher: createDryRunWzrrdPublishAdapter(),
      wzrrdSecretRefs: {
        dryRun: "secretref:wzrrd-dry-run",
        publish: "secretref:wzrrd-api",
      },
      wzrrdSiteRef: "wzrrd:test",
    });

    return {
      artifacts,
      request,
      statusProjection,
      workflow,
      writeHitlDecision,
    };
  };

  it("blocks an unrepairable plan node config at plan-load time before any node executes and surfaces it via status", async () => {
    const harness = buildDreamValidationWorkflow({
      artifactStore: "workflow-app-validate-block",
      // A wrong-TYPE maxHits (a string) is genuinely unrepairable: the budget
      // clamp passes non-numbers through, so the number schema rejects it and the
      // run blocks fail-fast. (An over-budget NUMBER is clamped now, not blocked.)
      mutateStepConfig: (step) =>
        step.stepId === "search-dream-memory"
          ? { ...step.config, maxHits: "lots" }
          : null,
    });
    await harness.writeHitlDecision;

    const result = await harness.workflow.run(harness.request);

    if (result.status !== "blocked") {
      throw new Error(`expected blocked run, got ${result.status}`);
    }
    // The blocker names step + field; the executor never ran (fail-fast).
    expect(result.blocker.message).toMatch(
      /search-dream-memory.*config\.maxHits/u
    );

    // Fail-fast: the run blocked before any node executed, so no node output
    // artifact (e.g. the search artifact) was ever written.
    const searchArtifactRef = harness.artifacts.artifactRef({
      path: "dream/memory-search.json",
      runId: harness.request.runId,
    });
    await expect(
      harness.artifacts.readJson({ artifactRef: searchArtifactRef })
    ).rejects.toThrow(/artifact/iu);

    // Stage 1 observability: the terminal blocker is visible via the status
    // projection, naming exactly which node + field failed.
    const projection = harness.statusProjection.latest.get(
      harness.request.runId
    );
    expect(projection?.terminalBlocker).toStrictEqual({
      code: "plan_node_config_invalid",
      message: result.blocker.message,
      nodeType: "joelclaw.memory.search",
      redacted: true,
      stepId: "search-dream-memory",
    });
  });

  it("passes validation and executes a fully leashable plan (out-of-enum signalKinds is repaired, not blocked)", async () => {
    const harness = buildDreamValidationWorkflow({
      artifactStore: "workflow-app-validate-leashable",
      // The classic planner miss: an out-of-enum signalKind. The leash drops it,
      // so validation must pass and the run must execute to captured.
      mutateStepConfig: (step) =>
        step.stepId === "mine-memory-signals"
          ? {
              ...step.config,
              signalKinds: ["workflow", "workflow-pattern", "correction"],
            }
          : null,
    });
    await harness.writeHitlDecision;

    const result = await harness.workflow.run(harness.request);

    if (result.status !== "captured") {
      throw new Error(result.blocker.message);
    }
    expect(result.status).toBe("captured");
    const projection = harness.statusProjection.latest.get(
      harness.request.runId
    );
    expect(projection?.terminalBlocker).toBeUndefined();
  });
});

describe("workflow run-step checkpoints (M2.5)", () => {
  it("persists one resumable checkpoint per executed generated-machine step", async () => {
    const { artifacts, contextCapsules, result } = await runWorkflow();
    const plan = DynamicWorkflowPlanDocumentSchema.parse(
      await artifacts.readJson({ artifactRef: result.planArtifact.artifactRef })
    );
    const checkpoints = [...contextCapsules.checkpoints.values()]
      .map((checkpoint) => RunStepCheckpointSchema.parse(checkpoint))
      .toSorted((left, right) => left.stepIndex - right.stepIndex);

    expect({
      // One checkpoint per pinned plan step: the run reached "captured", so every
      // executable step crossed its STEP_DONE boundary and persisted once.
      checkpointCount: checkpoints.length,
      // Each step's checkpoint accretes one more completed step id than the last.
      completedStepIdCounts: checkpoints.map(
        (checkpoint) => checkpoint.completedStepIds.length
      ),
      // Both XState actors are retained: every checkpoint carries a non-empty
      // envelope snapshot AND a non-empty generated-machine snapshot.
      everyCheckpointHasBothSnapshots: checkpoints.every(
        (checkpoint) =>
          checkpoint.envelopeSnapshot !== undefined &&
          checkpoint.generatedMachineSnapshot !== undefined
      ),
      identity: checkpoints.map((checkpoint) => ({
        runId: checkpoint.runId,
        schemaVersion: checkpoint.schemaVersion,
        workItemId: checkpoint.workItemId,
      })),
      // The two-factor skip check needs resolvable output refs. The fixture's
      // research/review step is the only one that emits a primary output ref, so
      // every checkpoint surfaces exactly that one (cumulative) ref.
      outputRefCounts: checkpoints.map(
        (checkpoint) => checkpoint.outputArtifactRefs.length
      ),
      stepIndexes: checkpoints.map((checkpoint) => checkpoint.stepIndex),
      uniqueOutputRefCount: new Set(
        checkpoints.flatMap((checkpoint) => checkpoint.outputArtifactRefs)
      ).size,
    }).toStrictEqual({
      checkpointCount: plan.steps.length,
      completedStepIdCounts: [1, 2, 3],
      everyCheckpointHasBothSnapshots: true,
      identity: checkpoints.map(() => ({
        runId: result.runId,
        schemaVersion: "workflow.run-step-checkpoint.v1",
        workItemId: result.capsule.workItemId,
      })),
      outputRefCounts: [1, 1, 1],
      stepIndexes: [0, 1, 2],
      uniqueOutputRefCount: 1,
    });
  });

  it("re-persisting the same step is a stable idempotent overwrite", async () => {
    const { contextCapsules, result } = await runWorkflow();
    const finalCheckpoint = RunStepCheckpointSchema.parse(
      contextCapsules.checkpoints.get(`${result.runId}:2`)
    );
    const before = contextCapsules.checkpoints.size;

    await contextCapsules.persistCheckpoint({
      checkpoint: finalCheckpoint,
      workItemId: result.capsule.workItemId,
    });

    // Overwrite by runId+stepIndex: no new slot, and the stored snapshot is
    // byte-identical to the original persist.
    expect(contextCapsules.checkpoints.size).toBe(before);
    expect(
      RunStepCheckpointSchema.parse(
        contextCapsules.checkpoints.get(`${result.runId}:2`)
      )
    ).toStrictEqual(finalCheckpoint);
  });
});

// Build a workflow over shared artifact + capsule stores so a seeded full run
// and a later resumed `executeDynamicWorkflow` invocation share the same durable
// state (checkpoints + committed output artifacts) the resume reads.
const buildResumableWorkflow = (
  namespace: string,
  dynamicWorkflowPlanner: ReturnType<
    typeof createIntegrationTestDynamicWorkflowPlanner
  > = createIntegrationTestDynamicWorkflowPlanner(),
  options: {
    readonly agentWorkerLane?: AgentWorkerLanePort;
    readonly createAgentWorkerLane?: (
      artifacts: ReturnType<typeof createMemoryArtifactStore>
    ) => AgentWorkerLanePort;
    readonly deterministicVerifier?: boolean;
  } = {}
) => {
  const artifacts = createMemoryArtifactStore(namespace);
  const contextCapsules = createMemoryContextCapsuleActor();
  const statusProjection = createMemoryWorkflowStatusProjectionStore();
  const agentWorkerLane =
    options.agentWorkerLane ?? options.createAgentWorkerLane?.(artifacts);
  const workflow = new WorkflowApp({
    ...(agentWorkerLane === undefined ? {} : { agentWorkerLane }),
    artifacts,
    capabilityLeases: createPolicyCapabilityLeaseBroker(artifacts, {
      discordSecretRef: "secretref:discord-bot",
      policyId: "discord-message-policy",
    }),
    contextCapsules,
    discordMessages: createDryRunDiscordMessageAdapter(),
    discordSecretRefs: {
      dryRun: "secretref:discord-dry-run",
      send: "secretref:discord-bot",
    },
    dynamicWorkflowPlanner,
    ...(options.deterministicVerifier === true
      ? {
          deterministicVerifier: createArtifactEvidenceDeterministicVerifier({
            artifacts,
          }),
        }
      : {}),
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
    statusProjection,
    wzrrdPublisher: createDryRunWzrrdPublishAdapter(),
    wzrrdSecretRefs: {
      dryRun: "secretref:wzrrd-dry-run",
      publish: "secretref:wzrrd-api",
    },
    wzrrdSiteRef: "wzrrd:test",
  });

  return { artifacts, contextCapsules, statusProjection, workflow };
};

// Seed a complete run, then load the pinned (deterministic-per-run) plan +
// machine so a resumed invocation can rehydrate the very machine the seeded run
// executed.
const seedResumableRun = async (
  rig: ReturnType<typeof buildResumableWorkflow>
) => {
  const request = buildIntegrationTestRunRequest();
  const seeded = await rig.workflow.run(request);
  if (seeded.status !== "captured") {
    throw new Error(seeded.blocker.message);
  }

  const loadedPlan = DynamicWorkflowPlanDocumentSchema.parse(
    await rig.artifacts.readJson({
      artifactRef: seeded.planArtifact.artifactRef,
    })
  );
  const machine = DynamicWorkflowMachineDocumentSchema.parse(
    await rig.artifacts.readJson({
      artifactRef: seeded.machineArtifact.artifactRef,
    })
  );

  return { loadedPlan, machine, request, seeded };
};

// Drive the durable execution loop directly with an injected resume checkpoint,
// mirroring how a fresh DO invocation would re-enter the loop after eviction.
// `transition`/`block`/`persistCheckpoint` are inert sinks — resume correctness
// is observable in the returned execution result.
const resumeExecution = (
  rig: ReturnType<typeof buildResumableWorkflow>,
  input: {
    readonly loadedPlan: ReturnType<
      typeof DynamicWorkflowPlanDocumentSchema.parse
    >;
    readonly machine: ReturnType<
      typeof DynamicWorkflowMachineDocumentSchema.parse
    >;
    readonly request: ReturnType<typeof buildIntegrationTestRunRequest>;
    readonly resumeCheckpoint: ReturnType<typeof RunStepCheckpointSchema.parse>;
  }
) =>
  // oxlint-disable-next-line typescript/dot-notation -- Drive the private durable execution loop directly to prove alarm-style resume continues from a checkpoint without re-firing completed steps.
  rig.workflow["executeDynamicWorkflow"]({
    admitDynamicNodeAttempt: () => Promise.resolve({ status: "accepted" }),
    block: (blockedBy) =>
      Promise.resolve({
        blocker: blockedBy,
        eventLog: [],
        runId: input.request.runId,
        status: "blocked" as const,
      }),
    loadDriveLaneDispatch: () => null,
    loadedPlan: input.loadedPlan,
    machine: input.machine,
    persistCheckpoint: () => Promise.resolve(),
    recordDriveLaneDispatch: () => Promise.resolve(),
    recordDriveLaneStatus: () => Promise.resolve(),
    request: input.request,
    resumeCheckpoint: input.resumeCheckpoint,
    transition: () => Promise.resolve(),
  });

const resumedWorkerLaneStepIds = (
  receipts: readonly AgentLaneReceipt[]
): string[] =>
  receipts.map((receipt) => receipt.laneId.split(":").at(-1) ?? "");

describe("workflow run resume from checkpoint (M2.5)", () => {
  it("resumes from a mid-run checkpoint without re-firing completed steps", async () => {
    const rig = buildResumableWorkflow("workflow-app-resume-skip");
    const { loadedPlan, machine, request } = await seedResumableRun(rig);

    // Checkpoint after the discord capability step (index 1): research-review
    // and discord are both already done; only review-summary remains.
    const midCheckpoint = RunStepCheckpointSchema.parse(
      rig.contextCapsules.checkpoints.get(`${request.runId}:1`)
    );

    const execution = await resumeExecution(rig, {
      loadedPlan,
      machine,
      request,
      resumeCheckpoint: midCheckpoint,
    });
    if (execution.status !== "executed") {
      throw new Error(
        `Expected resumed execution to complete, got ${execution.status}.`
      );
    }

    expect({
      // The two already-done steps did not re-fire: their prior receipts are
      // RESTORED from the checkpoint (so the finishing envelope sees the full
      // accounting) rather than re-issued, so the discord capability receipt
      // appears exactly once and the research-review worker lane appears exactly
      // once — a re-fire would duplicate them.
      capabilityReceiptCount: execution.capabilityReceipts.length,
      // The full plan is still accounted as complete after resume.
      completedStepIds: [...execution.completedStepIds].toSorted(),
      researchReviewLaneCount: resumedWorkerLaneStepIds(
        execution.workerLaneReceipts
      ).filter((stepId) => stepId === "research-review").length,
    }).toStrictEqual({
      capabilityReceiptCount: 1,
      completedStepIds: loadedPlan.steps.map((step) => step.stepId).toSorted(),
      researchReviewLaneCount: 1,
    });
  });

  it("re-runs a half-fired step whose output ref is missing", async () => {
    const rig = buildResumableWorkflow("workflow-app-resume-halffired");
    const { loadedPlan, machine, request } = await seedResumableRun(rig);

    // Resume from the checkpoint written after research-review's STEP_DONE
    // (index 0) but evict its committed output artifact — the half-fired case:
    // the step is in `completedStepIds` yet its ref no longer resolves.
    const firstCheckpoint = RunStepCheckpointSchema.parse(
      rig.contextCapsules.checkpoints.get(`${request.runId}:0`)
    );
    const researchOutputRef = rig.artifacts.artifactRef({
      path: "outputs/research-review.json",
      runId: request.runId,
    });
    expect(rig.artifacts.records.delete(researchOutputRef)).toBeTruthy();

    const execution = await resumeExecution(rig, {
      loadedPlan,
      machine,
      request,
      resumeCheckpoint: firstCheckpoint,
    });
    if (execution.status !== "executed") {
      throw new Error(
        `Expected re-run execution to complete, got ${execution.status}.`
      );
    }

    expect({
      // Two-factor skip fell back to a fresh actor, so research-review re-ran
      // (its worker lane appears) and every step is complete again.
      completedStepIds: [...execution.completedStepIds].toSorted(),
      reRanResearchReview: resumedWorkerLaneStepIds(
        execution.workerLaneReceipts
      ).includes("research-review"),
      // The content-addressed output ref is committed again by the safe re-run.
      researchOutputRecommitted: rig.artifacts.records.has(researchOutputRef),
    }).toStrictEqual({
      completedStepIds: loadedPlan.steps.map((step) => step.stepId).toSorted(),
      reRanResearchReview: true,
      researchOutputRecommitted: true,
    });
  });

  it("a no-crash full run is byte-identical with resume wiring present", async () => {
    // Resume reads `loadLatestCheckpoint` at the top of execution; a fresh run
    // has no prior checkpoint, so the happy path must be unchanged. Prove it by
    // running a clean full run end to end through the resume-wired loop.
    const rig = buildResumableWorkflow("workflow-app-resume-noop");
    const { seeded } = await seedResumableRun(rig);

    expect({
      status: seeded.status,
      // The reaped/clean run still produced one checkpoint per plan step.
      stepCheckpointCount: [...rig.contextCapsules.checkpoints.keys()].filter(
        (key) => key.startsWith(`${seeded.runId}:`)
      ).length,
    }).toStrictEqual({
      status: "captured",
      stepCheckpointCount: 3,
    });
  });
});

/**
 * Drive a run in single-step mode (one dynamic node per call) until it reaches a
 * terminal status, mirroring how the DO alarm re-drives the SAME durable state on
 * each fire. Returns the ordered drive results so a test can assert the run
 * advanced exactly one node per drive (paused stepIndex increments) and the last
 * drive folded the finishing envelope into a terminal `captured`.
 */
const driveRunOneNodePerCall = async (
  rig: ReturnType<typeof buildResumableWorkflow>,
  request: ReturnType<typeof buildIntegrationTestRunRequest>,
  maxDrives = 16
): Promise<WorkflowRunDriveResult[]> => {
  const drives: WorkflowRunDriveResult[] = [];
  for (let count = 0; count < maxDrives; count += 1) {
    // eslint-disable-next-line no-await-in-loop -- each drive must complete and
    // persist its checkpoint before the next drive resumes from it.
    const result = await rig.workflow.run(request, {
      driveMode: "single-step",
    });
    drives.push(result);
    if (result.status !== "paused") {
      return drives;
    }
  }
  throw new Error(
    `Single-step drive did not reach terminal within ${maxDrives} drives.`
  );
};

const createAsyncWorkerLaneHarness = (input: {
  readonly artifacts: ReturnType<typeof createMemoryArtifactStore>;
  readonly deadline?: string;
  // Simulate a live Cloudflare container whose getProcess RPC REJECTS (evicted /
  // recycled container) instead of returning a status — the throwing-poll wound.
  readonly pollThrows?: boolean;
  readonly processStatuses?: (
    | "starting"
    | "running"
    | "completed"
    | "failed"
    | "killed"
    | "error"
    | "not_found"
  )[];
}) => {
  const cleanups: string[] = [];
  const dispatches: WorkflowDriveLaneDispatch[] = [];
  const polls: string[] = [];
  let processCounter = 0;
  const processStatuses = [...(input.processStatuses ?? ["running"])];
  const lane: AgentWorkerLanePort = {
    cleanupStep(cleanupInput) {
      cleanups.push(`${cleanupInput.reason}:${cleanupInput.dispatch.laneId}`);
      return Promise.resolve();
    },
    dispatchStep(dispatchInput) {
      processCounter += 1;
      const outputRef = input.artifacts.artifactRef({
        path: dispatchInput.step.outputPath,
        runId: dispatchInput.plan.runId,
      });
      const dispatch = WorkflowDriveLaneDispatchSchema.parse({
        deadline:
          input.deadline ?? new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        dispatchKey: `${dispatchInput.nodeIndex}:${dispatchInput.step.stepId}`,
        dispatchedAt: "2026-06-12T23:00:00.000Z",
        expectedOutputArtifactRefs: [outputRef],
        expectedReceiptArtifactRef: input.artifacts.artifactRef({
          path: `receipts/worker-${dispatchInput.step.stepId}-lane.json`,
          runId: dispatchInput.plan.runId,
        }),
        kind: "worker",
        laneAuthLeaseId: `lease:async-worker:${dispatchInput.plan.runId}`,
        laneId: `lane:worker:${dispatchInput.plan.runId}:${dispatchInput.step.stepId}`,
        nodeIndex: dispatchInput.nodeIndex,
        processId: `process-${processCounter}`,
        promptArtifactRef: input.artifacts.artifactRef({
          path: `lanes/${dispatchInput.step.stepId}/prompt.md`,
          runId: dispatchInput.plan.runId,
        }),
        runId: dispatchInput.plan.runId,
        sandboxId: `sandbox-${dispatchInput.plan.runId}`,
        schemaVersion: "workflow.drive-lane-dispatch.v1",
        status: "lane-dispatched",
        stepId: dispatchInput.step.stepId,
        workItemId: dispatchInput.plan.workItemId,
      });
      dispatches.push(dispatch);

      return Promise.resolve(dispatch);
    },
    laneKind: "worker",
    pollStep(pollInput) {
      if (input.pollThrows === true) {
        polls.push(`throw:${pollInput.dispatch.laneId}`);

        return Promise.reject(
          new Error("getProcess RPC failed: sandbox container unavailable")
        );
      }
      const status =
        processStatuses.shift() ?? processStatuses.at(-1) ?? "running";
      polls.push(`${status}:${pollInput.dispatch.laneId}`);

      return Promise.resolve(
        WorkflowDriveLaneStatusReceiptSchema.parse({
          checkedAt: new Date().toISOString(),
          dispatchKey: pollInput.dispatch.dispatchKey,
          kind: pollInput.dispatch.kind,
          laneId: pollInput.dispatch.laneId,
          nodeIndex: pollInput.dispatch.nodeIndex,
          processId: pollInput.dispatch.processId,
          runId: pollInput.dispatch.runId,
          sandboxId: pollInput.dispatch.sandboxId,
          schemaVersion: "workflow.drive-lane-status.v1",
          status,
          stepId: pollInput.dispatch.stepId,
          workItemId: pollInput.dispatch.workItemId,
        })
      );
    },
    async readStepReceipt(readInput) {
      try {
        const receipt = AgentLaneReceiptSchema.parse(
          await input.artifacts.readJson({
            artifactRef: readInput.dispatch.expectedReceiptArtifactRef,
          })
        );

        return {
          outputRefs: receipt.outputRefs,
          receipt,
        };
      } catch {
        return null;
      }
    },
    runStep() {
      throw new Error("blocking worker lane should not be used");
    },
    runtime: "pi-agent-cli",
  };
  const writeCompletedReceipt = (
    dispatch = dispatches[0]
  ): AgentLaneReceipt => {
    if (dispatch === undefined) {
      throw new Error("No async worker lane dispatch exists.");
    }
    const [outputRef] = dispatch.expectedOutputArtifactRefs;
    if (outputRef === undefined) {
      throw new Error("Async dispatch did not declare an output artifact ref.");
    }
    const output = {
      redacted: true,
      runId: dispatch.runId,
      stepId: dispatch.stepId,
      summary: "Async worker lane completed from Artifacts receipt.",
    };
    input.artifacts.setJson(outputRef, output);
    const receipt = AgentLaneReceiptSchema.parse({
      authLease: {
        expiresAt: "2026-06-13T00:00:00.000Z",
        issuedAt: "2026-06-12T23:00:00.000Z",
        leaseId: dispatch.laneAuthLeaseId,
        redacted: true,
        runId: dispatch.runId,
        scope: "pi-agent-auth-json",
        secretRef: "secretref:pi-agent-auth-json",
        workItemId: dispatch.workItemId,
      },
      completedAt: "2026-06-12T23:01:00.000Z",
      kind: "worker",
      laneId: dispatch.laneId,
      outputPins: [
        {
          artifactRef: outputRef,
          hash: hashJson(output),
          mediaType: "application/json",
        },
      ],
      outputRefs: [outputRef],
      prompt: {
        artifactRef: dispatch.promptArtifactRef,
        hash: sha256Hex("async worker prompt"),
        mediaType: "text/markdown",
      },
      realAgent: true,
      receiptRef: dispatch.expectedReceiptArtifactRef,
      redacted: true,
      runtime: "pi-agent-cli",
      sandboxRef: `cloudflare-sandbox:${dispatch.sandboxId}`,
      startedAt: dispatch.dispatchedAt,
      status: "completed",
      traceContext: {
        redacted: true,
        spanId: `span:${dispatch.runId}:async-worker`,
        traceId: `trace:${dispatch.runId}`,
      },
      transcript: {
        artifactRef: input.artifacts.artifactRef({
          path: `lanes/${dispatch.stepId}/transcript.md`,
          runId: dispatch.runId,
        }),
        hash: sha256Hex("async worker transcript"),
        mediaType: "text/markdown",
      },
    });
    input.artifacts.setJson(dispatch.expectedReceiptArtifactRef, receipt);

    return receipt;
  };

  return {
    cleanups,
    dispatches,
    lane,
    polls,
    writeCompletedReceipt,
  };
};

const driveOneAdmittedSingleStep = async (
  rig: ReturnType<typeof buildResumableWorkflow>,
  request: ReturnType<typeof buildIntegrationTestRunRequest>
): Promise<WorkflowRunDriveResult> => {
  const admission = await rig.contextCapsules.admitDrive({
    runId: request.runId,
    workItemId: request.workItemId,
  });

  return await rig.workflow.run(request, {
    driveGeneration: admission.driveGeneration,
    driveMode: "single-step",
  });
};

describe("workflow single-step drive (one node per alarm)", () => {
  it("dispatches an async worker lane once, polls, then advances from the Artifacts receipt", async () => {
    let plannerInvocations = 0;
    const planner = createIntegrationTestDynamicWorkflowPlanner();
    let asyncLane: ReturnType<typeof createAsyncWorkerLaneHarness> | undefined;
    const rig = buildResumableWorkflow(
      "workflow-app-async-lane-dispatch-poll-advance",
      {
        async proposePlan(input) {
          plannerInvocations += 1;

          return await planner.proposePlan(input);
        },
      },
      {
        createAgentWorkerLane(artifacts) {
          asyncLane = createAsyncWorkerLaneHarness({
            artifacts,
            processStatuses: ["running"],
          });

          return asyncLane.lane;
        },
      }
    );
    if (asyncLane === undefined) {
      throw new Error("Async lane harness was not created.");
    }
    const request = buildIntegrationTestRunRequest();

    const dispatched = await driveOneAdmittedSingleStep(rig, request);
    const polled = await driveOneAdmittedSingleStep(rig, request);
    asyncLane.writeCompletedReceipt();
    const advanced = await driveOneAdmittedSingleStep(rig, request);
    const checkpointCountAfterAdvance = [
      ...rig.contextCapsules.checkpoints.keys(),
    ].filter((key) => key.startsWith(`${request.runId}:`)).length;
    const remaining = await driveRunOneNodePerCall(rig, request);
    const terminal = remaining.at(-1);
    const ledger = rig.contextCapsules.driveLedgers.get(
      `${request.workItemId}:${request.runId}`
    );

    expect({
      advancedStatus: advanced.status,
      checkpointCountAfterAdvance,
      cleanupReasons: asyncLane.cleanups,
      dispatchCount: asyncLane.dispatches.length,
      dispatchLaneRecordsAfterAdvance: Object.keys(
        ledger?.laneDispatches ?? {}
      ),
      dispatchedStatus: dispatched.status,
      plannerInvocations,
      pollCount: asyncLane.polls.length,
      polledStatus: polled.status,
      terminalBlocker:
        terminal?.status === "blocked" ? terminal.blocker.message : null,
      terminalStatus: terminal?.status,
    }).toStrictEqual({
      advancedStatus: "paused",
      checkpointCountAfterAdvance: 1,
      cleanupReasons: [`completed:${asyncLane.dispatches[0]?.laneId}`],
      dispatchCount: 1,
      dispatchLaneRecordsAfterAdvance: [],
      dispatchedStatus: "paused",
      plannerInvocations: 1,
      pollCount: 1,
      polledStatus: "paused",
      terminalBlocker: null,
      terminalStatus: "captured",
    });
  });

  it("keeps polling a dispatched async worker lane while the receipt is missing", async () => {
    let asyncLane: ReturnType<typeof createAsyncWorkerLaneHarness> | undefined;
    const rig = buildResumableWorkflow(
      "workflow-app-async-lane-missing-receipt",
      createIntegrationTestDynamicWorkflowPlanner(),
      {
        createAgentWorkerLane(artifacts) {
          asyncLane = createAsyncWorkerLaneHarness({
            artifacts,
            processStatuses: ["starting", "running"],
          });

          return asyncLane.lane;
        },
      }
    );
    if (asyncLane === undefined) {
      throw new Error("Async lane harness was not created.");
    }
    const request = buildIntegrationTestRunRequest();

    await driveOneAdmittedSingleStep(rig, request);
    const firstPoll = await driveOneAdmittedSingleStep(rig, request);
    const secondPoll = await driveOneAdmittedSingleStep(rig, request);
    const checkpointCount = [...rig.contextCapsules.checkpoints.keys()].filter(
      (key) => key.startsWith(`${request.runId}:`)
    ).length;

    expect({
      checkpointCount,
      dispatchCount: asyncLane.dispatches.length,
      firstPollStatus: firstPoll.status,
      pollStatuses: asyncLane.polls.map((poll) => poll.split(":")[0]),
      secondPollStatus: secondPoll.status,
    }).toStrictEqual({
      checkpointCount: 0,
      dispatchCount: 1,
      firstPollStatus: "paused",
      pollStatuses: ["starting", "running"],
      secondPollStatus: "paused",
    });
  });

  it("advances from a late async worker lane receipt after earlier paused polls", async () => {
    let asyncLane: ReturnType<typeof createAsyncWorkerLaneHarness> | undefined;
    const rig = buildResumableWorkflow(
      "workflow-app-async-lane-late-receipt",
      createIntegrationTestDynamicWorkflowPlanner(),
      {
        createAgentWorkerLane(artifacts) {
          asyncLane = createAsyncWorkerLaneHarness({
            artifacts,
            processStatuses: ["running", "running"],
          });

          return asyncLane.lane;
        },
      }
    );
    if (asyncLane === undefined) {
      throw new Error("Async lane harness was not created.");
    }
    const request = buildIntegrationTestRunRequest();

    await driveOneAdmittedSingleStep(rig, request);
    await driveOneAdmittedSingleStep(rig, request);
    asyncLane.writeCompletedReceipt();
    const advanced = await driveOneAdmittedSingleStep(rig, request);

    expect({
      advancedStatus: advanced.status,
      checkpointCount: [...rig.contextCapsules.checkpoints.keys()].filter(
        (key) => key.startsWith(`${request.runId}:`)
      ).length,
      dispatchCount: asyncLane.dispatches.length,
      pollCount: asyncLane.polls.length,
    }).toStrictEqual({
      advancedStatus: "paused",
      checkpointCount: 1,
      dispatchCount: 1,
      pollCount: 1,
    });
  });

  it("blocks when an async worker lane process fails before a receipt is recoverable", async () => {
    let asyncLane: ReturnType<typeof createAsyncWorkerLaneHarness> | undefined;
    const rig = buildResumableWorkflow(
      "workflow-app-async-lane-failed-process",
      createIntegrationTestDynamicWorkflowPlanner(),
      {
        createAgentWorkerLane(artifacts) {
          asyncLane = createAsyncWorkerLaneHarness({
            artifacts,
            processStatuses: ["failed"],
          });

          return asyncLane.lane;
        },
      }
    );
    if (asyncLane === undefined) {
      throw new Error("Async lane harness was not created.");
    }
    const request = buildIntegrationTestRunRequest();

    await driveOneAdmittedSingleStep(rig, request);
    const blocked = await driveOneAdmittedSingleStep(rig, request);
    if (blocked.status !== "blocked") {
      throw new Error(`Expected blocked, got ${blocked.status}.`);
    }

    expect({
      blocker: blocked.blocker,
      cleanupReasons: asyncLane.cleanups,
      projectionBlocker: rig.statusProjection.latest.get(request.runId)
        ?.terminalBlocker,
    }).toStrictEqual({
      blocker: {
        code: "capability_denied",
        message: `Async worker lane ${asyncLane.dispatches[0]?.laneId} ended with process status failed.`,
        redacted: true,
      },
      cleanupReasons: [`failed:${asyncLane.dispatches[0]?.laneId}`],
      projectionBlocker: {
        code: "capability_denied",
        message: `Async worker lane ${asyncLane.dispatches[0]?.laneId} ended with process status failed.`,
        redacted: true,
        stepId: "research-review",
      },
    });
  });

  it("blocks when getProcess returns null past the async worker lane deadline", async () => {
    let asyncLane: ReturnType<typeof createAsyncWorkerLaneHarness> | undefined;
    const rig = buildResumableWorkflow(
      "workflow-app-async-lane-null-deadline",
      createIntegrationTestDynamicWorkflowPlanner(),
      {
        createAgentWorkerLane(artifacts) {
          asyncLane = createAsyncWorkerLaneHarness({
            artifacts,
            deadline: "2000-01-01T00:00:00.000Z",
            processStatuses: ["not_found"],
          });

          return asyncLane.lane;
        },
      }
    );
    if (asyncLane === undefined) {
      throw new Error("Async lane harness was not created.");
    }
    const request = buildIntegrationTestRunRequest();

    await driveOneAdmittedSingleStep(rig, request);
    const blocked = await driveOneAdmittedSingleStep(rig, request);
    if (blocked.status !== "blocked") {
      throw new Error(`Expected blocked, got ${blocked.status}.`);
    }

    expect({
      blockerCode: blocked.blocker.code,
      cleanupReasons: asyncLane.cleanups,
      dispatchCount: asyncLane.dispatches.length,
      pollStatuses: asyncLane.polls.map((poll) => poll.split(":")[0]),
    }).toStrictEqual({
      blockerCode: "capability_denied",
      cleanupReasons: [`timed-out:${asyncLane.dispatches[0]?.laneId}`],
      dispatchCount: 1,
      pollStatuses: ["not_found"],
    });
  });

  it("blocks when an async worker lane is still running past its deadline", async () => {
    // Chaos regression for the 4h-zombie wound: a sandbox container evicted or
    // recycled mid-synthesis hands back a stale `running` process handle that
    // never advances. Before the fix, the deadline guard only reaped
    // `not_found`/`completed`, so `running` past deadline fell through to
    // `paused` and the reaper re-paused it every cycle forever. The deadline —
    // not the process status — is the source of truth for "the lane is dead."
    let asyncLane: ReturnType<typeof createAsyncWorkerLaneHarness> | undefined;
    const rig = buildResumableWorkflow(
      "workflow-app-async-lane-running-past-deadline",
      createIntegrationTestDynamicWorkflowPlanner(),
      {
        createAgentWorkerLane(artifacts) {
          asyncLane = createAsyncWorkerLaneHarness({
            artifacts,
            deadline: "2000-01-01T00:00:00.000Z",
            processStatuses: ["running"],
          });

          return asyncLane.lane;
        },
      }
    );
    if (asyncLane === undefined) {
      throw new Error("Async lane harness was not created.");
    }
    const request = buildIntegrationTestRunRequest();

    await driveOneAdmittedSingleStep(rig, request);
    const blocked = await driveOneAdmittedSingleStep(rig, request);
    if (blocked.status !== "blocked") {
      throw new Error(`Expected blocked, got ${blocked.status}.`);
    }

    expect({
      blockerCode: blocked.blocker.code,
      cleanupReasons: asyncLane.cleanups,
      dispatchCount: asyncLane.dispatches.length,
      pollStatuses: asyncLane.polls.map((poll) => poll.split(":")[0]),
    }).toStrictEqual({
      blockerCode: "capability_denied",
      cleanupReasons: [`timed-out:${asyncLane.dispatches[0]?.laneId}`],
      dispatchCount: 1,
      pollStatuses: ["running"],
    });
  });

  it("blocks when the async worker lane poll throws past its deadline", async () => {
    // Chaos regression for the throwing-poll wound (eighth carrier wound):
    // pollStep hits a live Cloudflare container (getProcess RPC). An evicted or
    // recycled container makes that call REJECT — or returns a payload that
    // fails schema parse — rather than handing back a status. Before the fix the
    // unguarded throw aborted the drive before the deadline guard, so the reaper
    // re-paused the node every alarm FOREVER (observed: a 2h+ zombie on the
    // first research.review node of a live dream run). Same class as the
    // running-past-deadline wound, reached via a throwing poll instead of a
    // stale `running` status — the deadline, not the poll outcome, decides.
    let asyncLane: ReturnType<typeof createAsyncWorkerLaneHarness> | undefined;
    const rig = buildResumableWorkflow(
      "workflow-app-async-lane-poll-throws-past-deadline",
      createIntegrationTestDynamicWorkflowPlanner(),
      {
        createAgentWorkerLane(artifacts) {
          asyncLane = createAsyncWorkerLaneHarness({
            artifacts,
            deadline: "2000-01-01T00:00:00.000Z",
            pollThrows: true,
          });

          return asyncLane.lane;
        },
      }
    );
    if (asyncLane === undefined) {
      throw new Error("Async lane harness was not created.");
    }
    const request = buildIntegrationTestRunRequest();

    await driveOneAdmittedSingleStep(rig, request);
    const blocked = await driveOneAdmittedSingleStep(rig, request);
    if (blocked.status !== "blocked") {
      throw new Error(`Expected blocked, got ${blocked.status}.`);
    }

    expect({
      blockerCode: blocked.blocker.code,
      cleanupReasons: asyncLane.cleanups,
      dispatchCount: asyncLane.dispatches.length,
      pollAttempts: asyncLane.polls.map((poll) => poll.split(":")[0]),
    }).toStrictEqual({
      blockerCode: "capability_denied",
      cleanupReasons: [`timed-out:${asyncLane.dispatches[0]?.laneId}`],
      dispatchCount: 1,
      pollAttempts: ["throw"],
    });
  });

  it("pauses and retries when the async worker lane poll throws before its deadline", async () => {
    // The deadline-dominates fix must NOT turn a transient poll failure into a
    // premature block: before the deadline a throwing poll pauses, and the next
    // drive re-polls the same persisted dispatch. (Past the deadline it blocks —
    // see the test above.) Two paused drives, one dispatch, two throwing polls.
    let asyncLane: ReturnType<typeof createAsyncWorkerLaneHarness> | undefined;
    const rig = buildResumableWorkflow(
      "workflow-app-async-lane-poll-throws-before-deadline",
      createIntegrationTestDynamicWorkflowPlanner(),
      {
        createAgentWorkerLane(artifacts) {
          asyncLane = createAsyncWorkerLaneHarness({
            artifacts,
            deadline: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
            pollThrows: true,
          });

          return asyncLane.lane;
        },
      }
    );
    if (asyncLane === undefined) {
      throw new Error("Async lane harness was not created.");
    }
    const request = buildIntegrationTestRunRequest();

    await driveOneAdmittedSingleStep(rig, request);
    const firstPoll = await driveOneAdmittedSingleStep(rig, request);
    const secondPoll = await driveOneAdmittedSingleStep(rig, request);

    expect({
      cleanupReasons: asyncLane.cleanups,
      dispatchCount: asyncLane.dispatches.length,
      firstPollStatus: firstPoll.status,
      pollAttempts: asyncLane.polls.map((poll) => poll.split(":")[0]),
      secondPollStatus: secondPoll.status,
    }).toStrictEqual({
      cleanupReasons: [],
      dispatchCount: 1,
      firstPollStatus: "paused",
      pollAttempts: ["throw", "throw"],
      secondPollStatus: "paused",
    });
  });

  it("advances from an Artifacts receipt even when the process handle is gone", async () => {
    let asyncLane: ReturnType<typeof createAsyncWorkerLaneHarness> | undefined;
    const rig = buildResumableWorkflow(
      "workflow-app-async-lane-receipt-wins",
      createIntegrationTestDynamicWorkflowPlanner(),
      {
        createAgentWorkerLane(artifacts) {
          asyncLane = createAsyncWorkerLaneHarness({
            artifacts,
            processStatuses: ["not_found"],
          });

          return asyncLane.lane;
        },
      }
    );
    if (asyncLane === undefined) {
      throw new Error("Async lane harness was not created.");
    }
    const request = buildIntegrationTestRunRequest();

    await driveOneAdmittedSingleStep(rig, request);
    asyncLane.writeCompletedReceipt();
    const advanced = await driveOneAdmittedSingleStep(rig, request);

    expect({
      advancedStatus: advanced.status,
      checkpointCount: [...rig.contextCapsules.checkpoints.keys()].filter(
        (key) => key.startsWith(`${request.runId}:`)
      ).length,
      dispatchCount: asyncLane.dispatches.length,
      pollCount: asyncLane.polls.length,
    }).toStrictEqual({
      advancedStatus: "paused",
      checkpointCount: 1,
      dispatchCount: 1,
      pollCount: 0,
    });
  });

  it("advances exactly one dynamic node per drive and reaches captured in N drives", async () => {
    const rig = buildResumableWorkflow("workflow-app-single-step");
    const request = buildIntegrationTestRunRequest();

    const drives = await driveRunOneNodePerCall(rig, request);
    const terminal = drives.at(-1);
    const paused = drives.slice(0, -1);

    expect({
      // The default plan has three dynamic nodes; three drives terminate it (the
      // last node's drive folds in the finishing envelope), so two pauses precede
      // the terminal captured.
      driveStatuses: drives.map((drive) => drive.status),
      // Each pause advanced the checkpoint by exactly one step index — one node
      // per drive, no skips, no double-steps.
      pausedStepIndexes: paused.map((drive) =>
        drive.status === "paused" ? drive.stepIndex : -1
      ),
      terminalStatus: terminal?.status,
    }).toStrictEqual({
      driveStatuses: ["paused", "paused", "captured"],
      pausedStepIndexes: [0, 1],
      terminalStatus: "captured",
    });
  });

  it("a single-step driven run reaches captured with the same receipts as whole-run mode", async () => {
    const wholeRunRig = buildResumableWorkflow(
      "workflow-app-single-step-whole"
    );
    const wholeRun = await wholeRunRig.workflow.run(
      buildIntegrationTestRunRequest()
    );
    if (wholeRun.status !== "captured") {
      throw new Error(wholeRun.blocker.message);
    }

    const singleStepRig = buildResumableWorkflow(
      "workflow-app-single-step-step"
    );
    const singleStepDrives = await driveRunOneNodePerCall(
      singleStepRig,
      buildIntegrationTestRunRequest()
    );
    const singleStep = singleStepDrives.at(-1);
    if (singleStep === undefined || singleStep.status !== "captured") {
      throw new Error(
        `Expected single-step drive to capture, got ${singleStep?.status}.`
      );
    }

    expect({
      // The single-step drive captured the same set of step output artifacts and
      // the same review surface shape as the one-shot whole-run.
      artifactRefCount: singleStep.artifactRefs.length,
      capabilityReceiptCount: singleStep.capabilityReceipts.length,
      status: singleStep.status,
      // One checkpoint per plan step was persisted across the drives — proof the
      // run walked the full pinned plan one node at a time.
      stepCheckpointCount: [
        ...singleStepRig.contextCapsules.checkpoints.keys(),
      ].filter((key) => key.startsWith(`${singleStep.runId}:`)).length,
      workerLaneReceiptCount: singleStep.workerLaneReceipts.length,
    }).toStrictEqual({
      artifactRefCount: wholeRun.artifactRefs.length,
      capabilityReceiptCount: wholeRun.capabilityReceipts.length,
      status: "captured" as const,
      stepCheckpointCount: 3,
      workerLaneReceiptCount: wholeRun.workerLaneReceipts.length,
    });
  });

  it("re-drives the same run to captured without re-invoking the one-shot planner lane", async () => {
    // A real Pi planner lane is a one-shot agent execution: the admission
    // controller refuses to replay an already-completed lane (it throws). The DO
    // alarm re-drives the SAME durable state on every fire, so a run that planned
    // on its first drive must reconstruct the pinned plan from `run/plan.json` on
    // every subsequent drive — never calling the planner again.
    let plannerInvocations = 0;
    const planner = createIntegrationTestDynamicWorkflowPlanner();
    const rig = buildResumableWorkflow("workflow-app-planner-idempotent", {
      async proposePlan(input) {
        plannerInvocations += 1;

        return await planner.proposePlan(input);
      },
    });
    const request = buildIntegrationTestRunRequest();

    const drives = await driveRunOneNodePerCall(rig, request);
    const terminal = drives.at(-1);

    expect({
      // Three drives walk the run to terminal (paused, paused, captured)...
      driveStatuses: drives.map((drive) => drive.status),
      // ...but the one-shot planner lane fires exactly once across all of them.
      // Before the plan-reload fix this was 3 (one re-invocation per drive),
      // which surfaced as `adapter_unavailable` on the second real-agent drive.
      plannerInvocations,
      terminalStatus: terminal?.status,
    }).toStrictEqual({
      driveStatuses: ["paused", "paused", "captured"],
      plannerInvocations: 1,
      terminalStatus: "captured",
    });
  });

  it("uses the drive ledger to skip completed phases and resume at the next phase", async () => {
    let plannerInvocations = 0;
    const planner = createIntegrationTestDynamicWorkflowPlanner();
    const rig = buildResumableWorkflow(
      "workflow-app-drive-ledger-redrive",
      {
        async proposePlan(input) {
          plannerInvocations += 1;

          const blueprint = await planner.proposePlan(input);

          return DynamicWorkflowBlueprintSchema.parse({
            ...blueprint,
            verificationContract: {
              ...blueprint.verificationContract,
              verifier: {
                kind: "deterministic",
                source: "builtin:artifact-evidence-integrity.v1",
              },
            },
          });
        },
      },
      { deterministicVerifier: true }
    );
    const request = buildIntegrationTestRunRequest();
    const firstAdmission = await rig.contextCapsules.admitDrive({
      runId: request.runId,
      workItemId: request.workItemId,
    });
    const seeded = await rig.workflow.run(request, {
      driveGeneration: firstAdmission.driveGeneration,
      driveMode: "whole-run",
    });
    if (seeded.status !== "captured") {
      throw new Error(
        seeded.status === "blocked"
          ? seeded.blocker.message
          : `Expected seeded run to capture, got ${seeded.status}.`
      );
    }

    const ledgerKey = `${request.workItemId}:${request.runId}`;
    const ledger = rig.contextCapsules.driveLedgers.get(ledgerKey);
    const planPhase = ledger?.phases["plan-pinned"];
    const executionPhase = ledger?.phases["execution-completed"];
    if (
      ledger === undefined ||
      planPhase === undefined ||
      executionPhase === undefined
    ) {
      throw new Error("Seeded run did not record plan and execution phases.");
    }
    rig.contextCapsules.driveLedgers.set(ledgerKey, {
      ...ledger,
      phases: {
        "execution-completed": executionPhase,
        "plan-pinned": planPhase,
      },
      updatedAt: new Date().toISOString(),
    });

    const freshWorkflow = new WorkflowApp({
      artifacts: rig.artifacts,
      capabilityLeases: createPolicyCapabilityLeaseBroker(rig.artifacts, {
        discordSecretRef: "secretref:discord-bot",
        policyId: "discord-message-policy",
      }),
      contextCapsules: rig.contextCapsules,
      deterministicVerifier: createArtifactEvidenceDeterministicVerifier({
        artifacts: rig.artifacts,
      }),
      discordMessages: createDryRunDiscordMessageAdapter(),
      discordSecretRefs: {
        dryRun: "secretref:discord-dry-run",
        send: "secretref:discord-bot",
      },
      dynamicWorkflowPlanner: {
        proposePlan() {
          throw new Error("planner replayed despite plan-pinned ledger phase");
        },
      },
      executionMode: "integration-test",
      observabilityRecorder: createCloudflareArtifactsObservabilityRecorder({
        artifacts: rig.artifacts,
      }),
      packageRegistry: createMemoryPackageRegistryActor(
        integrationTestPackageMetadata
      ),
      reviewGate: createMemoryReviewGateActor(rig.artifacts),
      reviewSurfacePublisher: createCloudflareArtifactsReviewSurfacePublisher({
        artifacts: rig.artifacts,
      }),
      statusProjection: createMemoryWorkflowStatusProjectionStore(),
      wzrrdPublisher: createDryRunWzrrdPublishAdapter(),
      wzrrdSecretRefs: {
        dryRun: "secretref:wzrrd-dry-run",
        publish: "secretref:wzrrd-api",
      },
      wzrrdSiteRef: "wzrrd:test",
    });
    const redriveAdmission = await rig.contextCapsules.admitDrive({
      runId: request.runId,
      workItemId: request.workItemId,
    });

    const redrive = await freshWorkflow.run(request, {
      driveGeneration: redriveAdmission.driveGeneration,
      driveMode: "whole-run",
    });

    expect({
      plannerInvocations,
      recordedPhases: Object.keys(
        rig.contextCapsules.driveLedgers.get(ledgerKey)?.phases ?? {}
      ).toSorted(),
      redriveDynamicStepEvents: redrive.eventLog.filter(
        (event) =>
          event.summary ===
          "Dynamic research/review step executed from the pinned plan."
      ).length,
      redriveStatus: redrive.status,
    }).toStrictEqual({
      plannerInvocations: 1,
      recordedPhases: [
        "capture-completed",
        "execution-completed",
        "plan-pinned",
        "verification-completed",
      ],
      redriveDynamicStepEvents: 0,
      redriveStatus: "captured",
    });
  });
});

type SafetyEnvelopeState = WorkflowStatusProjection["currentState"];

const createCrashOnceStatusProjection = (
  base: ReturnType<typeof createMemoryWorkflowStatusProjectionStore>,
  input: {
    readonly crashState: SafetyEnvelopeState;
    readonly onCrash: (state: SafetyEnvelopeState) => void;
  }
): ReturnType<typeof createMemoryWorkflowStatusProjectionStore> => ({
  latest: base.latest,
  async record(recordInput) {
    await base.record(recordInput);
    if (recordInput.projection.currentState === input.crashState) {
      input.onCrash(input.crashState);
      throw new Error(
        `simulated durable object eviction after ${input.crashState}`
      );
    }
  },
  records: base.records,
});

const createLifecycleFaithfulDreamWorkflow = (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly contextCapsules: ReturnType<typeof createMemoryContextCapsuleActor>;
  readonly indefinitelyPendingStepIds?: ReadonlySet<string>;
  readonly nodeExecutions: string[];
  readonly onPlan: () => void;
  readonly statusProjection: ReturnType<
    typeof createMemoryWorkflowStatusProjectionStore
  >;
  readonly zombieNodeMaxAttempts?: number;
}): WorkflowApp => {
  const planner = createIntegrationTestDynamicWorkflowPlanner();
  const workflowNodeAdapter: WorkflowNodeAdapterPort = {
    async execute(nodeInput) {
      input.nodeExecutions.push(nodeInput.step.stepId);
      if (
        input.indefinitelyPendingStepIds?.has(nodeInput.step.stepId) === true
      ) {
        return await Promise.race<never>([]);
      }

      return await createArtifactBackedWorkflowCartridgeAdapter({
        artifacts: input.artifacts,
        delegate: createMemoryFabricWorkflowNodeAdapter({
          artifacts: input.artifacts,
          memoryCapture: createIntegrationTestMemoryFabricAdapter(),
          memoryCorrelation: createIntegrationTestMemoryCorrelationAdapter(),
          memoryRetrieval: createIntegrationTestMemoryRetrievalAdapter(),
          memorySignals: createIntegrationTestMemoryRetrievalAdapter(),
        }),
        now: () => "2026-06-12T22:00:00.000Z",
      }).execute(nodeInput);
    },
  };

  return new WorkflowApp({
    artifacts: input.artifacts,
    capabilityLeases: createPolicyCapabilityLeaseBroker(input.artifacts, {
      discordSecretRef: "secretref:discord-bot",
      policyId: "discord-message-policy",
    }),
    contextCapsules: input.contextCapsules,
    discordMessages: createDryRunDiscordMessageAdapter(),
    discordSecretRefs: {
      dryRun: "secretref:discord-dry-run",
      send: "secretref:discord-bot",
    },
    dynamicWorkflowPlanner: {
      async proposePlan(planInput) {
        input.onPlan();
        return addDreamPreflightToBlueprint(
          await planner.proposePlan(planInput)
        );
      },
    },
    executionMode: "integration-test",
    installedSourceProfiles: [dreamTranscriptReviewSourceProfile],
    observabilityRecorder: createCloudflareArtifactsObservabilityRecorder({
      artifacts: input.artifacts,
    }),
    packageRegistry: createMemoryPackageRegistryActor(dreamIntegrationPackages),
    postExecutionArtifactRecorders: [
      {
        binding: {
          kind: "profile-id",
          packageId: dreamTranscriptReviewSourceProfile.packageId,
          profileId: dreamTranscriptReviewSourceProfile.profileId,
        },
        recorder: createMemoryGeneratedWorkflowProofRecorder({
          artifacts: input.artifacts,
          buildAdditionalProofChecks: async ({ executionProof }) => [
            await buildWorkflowHitlReportAuditProofCheck({
              artifacts: input.artifacts,
              executionProof,
            }),
          ],
          expectedPackageRef: memoryWorkflowPackageRef,
          expectedSourceProfile: dreamTranscriptReviewSourceProfile,
          expectedSourceProfileExportId:
            "dream-transcript-review-source-profile",
          now: () => "2026-06-12T22:30:00.000Z",
        }),
      },
    ],
    reviewGate: createMemoryReviewGateActor(input.artifacts),
    reviewSurfacePublisher: createCloudflareArtifactsReviewSurfacePublisher({
      artifacts: input.artifacts,
    }),
    statusProjection: input.statusProjection,
    workflowNodeAdapter,
    ...(input.zombieNodeMaxAttempts === undefined
      ? {}
      : { zombieNodeMaxAttempts: input.zombieNodeMaxAttempts }),
    wzrrdPublisher: createDryRunWzrrdPublishAdapter(),
    wzrrdSecretRefs: {
      dryRun: "secretref:wzrrd-dry-run",
      publish: "secretref:wzrrd-api",
    },
    wzrrdSiteRef: "wzrrd:test",
  });
};

const driveLifecycleDream = async (input: {
  readonly crashState?: SafetyEnvelopeState;
  readonly namespace: string;
}): Promise<{
  readonly driveStatuses: string[];
  readonly nodeExecutions: string[];
  readonly plannerInvocations: number;
  readonly remote: ReturnType<typeof createLifecycleFaithfulArtifactsRemote>;
  readonly result: WorkflowRunDriveResult;
}> => {
  const remote = createLifecycleFaithfulArtifactsRemote(input.namespace);
  const contextCapsules = createMemoryContextCapsuleActor();
  const baseStatusProjection = createMemoryWorkflowStatusProjectionStore();
  const request = buildIntegrationTestDreamRunRequest();
  const driveStatuses: string[] = [];
  const nodeExecutions: string[] = [];
  let crashed = false;
  let plannerInvocations = 0;
  const markCrashed = (): void => {
    crashed = true;
  };
  const countPlannerInvocation = (): void => {
    plannerInvocations += 1;
  };

  for (let driveIndex = 0; driveIndex < 32; driveIndex += 1) {
    const artifacts = remote.createDriveStore({
      driveId: `drive-${driveIndex}`,
      seedFromRemote: driveIndex > 0,
    });
    const shouldCrash =
      input.crashState !== undefined && !crashed
        ? createCrashOnceStatusProjection(baseStatusProjection, {
            crashState: input.crashState,
            onCrash: markCrashed,
          })
        : baseStatusProjection;
    const workflow = createLifecycleFaithfulDreamWorkflow({
      artifacts,
      contextCapsules,
      nodeExecutions,
      onPlan: countPlannerInvocation,
      statusProjection: shouldCrash,
    });

    try {
      // eslint-disable-next-line no-await-in-loop -- each simulated alarm must persist remote/checkpoint state before the next fresh drive.
      const result = await workflow.run(request, { driveMode: "single-step" });
      driveStatuses.push(result.status);
      if (result.status !== "paused") {
        return {
          driveStatuses,
          nodeExecutions,
          plannerInvocations,
          remote,
          result,
        };
      }
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          error.message.startsWith("simulated durable object eviction after ")
        )
      ) {
        throw error;
      }
      driveStatuses.push(`evicted:${input.crashState ?? "unknown"}`);
    }
  }

  throw new Error("Lifecycle-faithful Dream drive did not reach terminal.");
};

const waitForNodeAttemptCount = async (input: {
  readonly contextCapsules: ReturnType<typeof createMemoryContextCapsuleActor>;
  readonly expectedAttemptCount: number;
  readonly nodeIndex: number;
  readonly request: ReturnType<typeof buildIntegrationTestDreamRunRequest>;
}): Promise<void> => {
  const ledgerKey = `${input.request.workItemId}:${input.request.runId}`;
  for (let poll = 0; poll < 25; poll += 1) {
    const actual =
      input.contextCapsules.driveLedgers.get(ledgerKey)?.nodeAttempts[
        String(input.nodeIndex)
      ]?.attemptCount ?? 0;
    if (actual === input.expectedAttemptCount) {
      return;
    }

    // eslint-disable-next-line no-await-in-loop -- polling a pending simulated drive until its pre-dispatch ledger write lands.
    await sleep(0);
  }

  throw new Error(
    `Expected node ${input.nodeIndex} attempt count ${input.expectedAttemptCount}.`
  );
};

describe("workflow lifecycle-faithful chaos resume", () => {
  it("reproduces the run-17 wound shape: a fresh worktree must seed from the shared remote", async () => {
    const remote = createLifecycleFaithfulArtifactsRemote(
      "workflow-app-run17-wound"
    );
    const firstDrive = remote.createDriveStore({
      driveId: "first-drive",
      seedFromRemote: false,
    });
    const runId = "run-redrive-worktree";
    await firstDrive.writeJson({
      path: "run/plan.json",
      redacted: true,
      runId,
      value: { planned: true, schemaVersion: "test.plan.v1" },
    });
    const artifactRef = firstDrive.artifactRef({
      path: "run/plan.json",
      runId,
    });
    const unseededRedrive = remote.createDriveStore({
      driveId: "unseeded-redrive",
      seedFromRemote: false,
    });
    const seededRedrive = remote.createDriveStore({
      driveId: "seeded-redrive",
      seedFromRemote: true,
    });

    await expect(
      unseededRedrive.readJson({ artifactRef })
    ).rejects.toMatchObject({ code: "ENOENT" });

    await expect(
      seededRedrive.readJson({ artifactRef })
    ).resolves.toStrictEqual({ planned: true, schemaVersion: "test.plan.v1" });
    expect(remote.cloneHistory).toStrictEqual([
      { driveId: "first-drive", recordCount: 0, seedFromRemote: false },
      { driveId: "unseeded-redrive", recordCount: 0, seedFromRemote: false },
      { driveId: "seeded-redrive", recordCount: 1, seedFromRemote: true },
    ]);
  });

  it("blocks a first Dream node that repeatedly exceeds the single-invocation budget while healthy drives still capture", async () => {
    const maxAttempts = 3;
    const stuckStepId = "capture-dream-run";
    const stuckRemote = createLifecycleFaithfulArtifactsRemote(
      "workflow-app-dream-chaos-zombie-node"
    );
    const stuckContextCapsules = createMemoryContextCapsuleActor();
    const stuckStatusProjection = createMemoryWorkflowStatusProjectionStore();
    const stuckRequest = buildIntegrationTestDreamRunRequest();
    const stuckNodeExecutions: string[] = [];
    const pendingDrives: Promise<WorkflowRunDriveResult>[] = [];
    let stuckPlannerInvocations = 0;
    const countStuckPlan = (): void => {
      stuckPlannerInvocations += 1;
    };

    for (let driveIndex = 0; driveIndex < maxAttempts; driveIndex += 1) {
      const workflow = createLifecycleFaithfulDreamWorkflow({
        artifacts: stuckRemote.createDriveStore({
          driveId: `stuck-drive-${driveIndex}`,
          seedFromRemote: driveIndex > 0,
        }),
        contextCapsules: stuckContextCapsules,
        indefinitelyPendingStepIds: new Set([stuckStepId]),
        nodeExecutions: stuckNodeExecutions,
        onPlan: countStuckPlan,
        statusProjection: stuckStatusProjection,
        zombieNodeMaxAttempts: maxAttempts,
      });
      const admission = await stuckContextCapsules.admitDrive({
        runId: stuckRequest.runId,
        workItemId: stuckRequest.workItemId,
      });

      pendingDrives.push(
        workflow.run(stuckRequest, {
          driveGeneration: admission.driveGeneration,
          driveMode: "single-step",
        })
      );
      await waitForNodeAttemptCount({
        contextCapsules: stuckContextCapsules,
        expectedAttemptCount: driveIndex + 1,
        nodeIndex: 0,
        request: stuckRequest,
      });
    }

    const blockingWorkflow = createLifecycleFaithfulDreamWorkflow({
      artifacts: stuckRemote.createDriveStore({
        driveId: "stuck-drive-blocking",
        seedFromRemote: true,
      }),
      contextCapsules: stuckContextCapsules,
      indefinitelyPendingStepIds: new Set([stuckStepId]),
      nodeExecutions: stuckNodeExecutions,
      onPlan: countStuckPlan,
      statusProjection: stuckStatusProjection,
      zombieNodeMaxAttempts: maxAttempts,
    });
    const blockingAdmission = await stuckContextCapsules.admitDrive({
      runId: stuckRequest.runId,
      workItemId: stuckRequest.workItemId,
    });
    const blocked = await blockingWorkflow.run(stuckRequest, {
      driveGeneration: blockingAdmission.driveGeneration,
      driveMode: "single-step",
    });
    if (blocked.status !== "blocked") {
      throw new Error(`Expected zombie drive to block, got ${blocked.status}.`);
    }

    const healthyRemote = createLifecycleFaithfulArtifactsRemote(
      "workflow-app-dream-chaos-zombie-node-healthy"
    );
    const healthyContextCapsules = createMemoryContextCapsuleActor();
    const healthyStatusProjection = createMemoryWorkflowStatusProjectionStore();
    const healthyRequest = buildIntegrationTestDreamRunRequest();
    const healthyNodeExecutions: string[] = [];
    const healthyDriveStatuses: string[] = [];
    let healthyResult: WorkflowRunDriveResult | null = null;
    for (let driveIndex = 0; driveIndex < 16; driveIndex += 1) {
      const workflow = createLifecycleFaithfulDreamWorkflow({
        artifacts: healthyRemote.createDriveStore({
          driveId: `healthy-drive-${driveIndex}`,
          seedFromRemote: driveIndex > 0,
        }),
        contextCapsules: healthyContextCapsules,
        nodeExecutions: healthyNodeExecutions,
        onPlan: () => {},
        statusProjection: healthyStatusProjection,
        zombieNodeMaxAttempts: maxAttempts,
      });
      const admission = await healthyContextCapsules.admitDrive({
        runId: healthyRequest.runId,
        workItemId: healthyRequest.workItemId,
      });

      // eslint-disable-next-line no-await-in-loop -- each simulated alarm must finish one checkpoint before the next drive resumes.
      const result = await workflow.run(healthyRequest, {
        driveGeneration: admission.driveGeneration,
        driveMode: "single-step",
      });
      healthyDriveStatuses.push(result.status);
      if (result.status !== "paused") {
        healthyResult = result;
        break;
      }
    }
    if (healthyResult === null) {
      throw new Error("Healthy single-step Dream run did not reach terminal.");
    }

    const stuckLedger = stuckContextCapsules.driveLedgers.get(
      `${stuckRequest.workItemId}:${stuckRequest.runId}`
    );
    const healthyLedger = healthyContextCapsules.driveLedgers.get(
      `${healthyRequest.workItemId}:${healthyRequest.runId}`
    );
    expect({
      blockedMessage: blocked.blocker.message,
      blockedProjection: stuckStatusProjection.latest.get(stuckRequest.runId)
        ?.terminalBlocker,
      healthyCheckpointCount: [
        ...healthyContextCapsules.checkpoints.keys(),
      ].filter((key) => key.startsWith(`${healthyRequest.runId}:`)).length,
      healthyNodeAttemptsRemaining: Object.keys(
        healthyLedger?.nodeAttempts ?? {}
      ),
      healthyStatuses: healthyDriveStatuses,
      healthyTerminalStatus: healthyResult.status,
      pendingDriveCount: pendingDrives.length,
      stuckCheckpointCount: [...stuckContextCapsules.checkpoints.keys()].filter(
        (key) => key.startsWith(`${stuckRequest.runId}:`)
      ).length,
      stuckNodeAttempts: stuckLedger?.nodeAttempts["0"]?.attemptCount,
      stuckNodeExecutions,
      stuckPlannerInvocations,
    }).toStrictEqual({
      blockedMessage:
        "dynamic node 0 exceeded single-invocation budget after 3 drive attempts",
      blockedProjection: {
        code: "capability_denied",
        message:
          "dynamic node 0 exceeded single-invocation budget after 3 drive attempts",
        nodeType: "joelclaw.memory.capture-run",
        redacted: true,
        stepId: stuckStepId,
      },
      healthyCheckpointCount: 10,
      healthyNodeAttemptsRemaining: [],
      healthyStatuses: [
        "paused",
        "paused",
        "paused",
        "paused",
        "paused",
        "paused",
        "paused",
        "paused",
        "paused",
        "captured",
      ],
      healthyTerminalStatus: "captured",
      pendingDriveCount: maxAttempts,
      stuckCheckpointCount: 0,
      stuckNodeAttempts: maxAttempts,
      stuckNodeExecutions: [stuckStepId, stuckStepId, stuckStepId],
      stuckPlannerInvocations: 1,
    });
  });

  it("kills after every Dream node boundary with fresh per-drive worktrees and captures exactly once", async () => {
    const outcome = await driveLifecycleDream({
      namespace: "workflow-app-dream-chaos-node-boundaries",
    });
    const nodeExecutionCounts = Object.fromEntries(
      [...new Set(outcome.nodeExecutions)].map((stepId) => [
        stepId,
        outcome.nodeExecutions.filter((executed) => executed === stepId).length,
      ])
    );

    expect({
      driveStatuses: outcome.driveStatuses,
      everyDriveAfterFirstSeeded: outcome.remote.cloneHistory
        .slice(1)
        .every((entry) => entry.seedFromRemote && entry.recordCount > 0),
      nodeExecutionCounts,
      plannerInvocations: outcome.plannerInvocations,
      terminalBlocker:
        outcome.result.status === "blocked"
          ? outcome.result.blocker.message
          : null,
      terminalStatus: outcome.result.status,
    }).toStrictEqual({
      driveStatuses: [
        "paused",
        "paused",
        "paused",
        "paused",
        "paused",
        "paused",
        "paused",
        "paused",
        "paused",
        "captured",
      ],
      everyDriveAfterFirstSeeded: true,
      nodeExecutionCounts: {
        "capture-dream-report-artifact": 1,
        "capture-dream-run": 1,
        "correlate-dream-evidence": 1,
        "draft-follow-up-run-request-from-hitl": 1,
        "hydrate-dream-evidence": 1,
        "mine-memory-signals": 1,
        "propose-dream-refinements": 1,
        "render-memory-hitl-report": 1,
        "search-dream-memory": 1,
        "seed-next-workflow-from-hitl": 1,
      },
      plannerInvocations: 1,
      terminalBlocker: null,
      terminalStatus: "captured",
    });
  });

  it.each([
    ["after submit/admission", "resolvingCapsule"],
    ["after plan pinned", "loadingPinnedDynamicWorkflow"],
    ["after verification", "recordingReceipts"],
    ["before capture finalize", "captured"],
  ] satisfies readonly (readonly [string, SafetyEnvelopeState])[])(
    "redrives to captured after eviction %s",
    async (_label, crashState) => {
      const outcome = await driveLifecycleDream({
        crashState,
        namespace: `workflow-app-dream-chaos-${crashState}`,
      });

      expect({
        duplicateReceiptKeys: [...outcome.remote.remoteRecords.keys()].filter(
          (artifactRef) =>
            artifactRef.includes("/receipts/") ||
            artifactRef.includes("/review/")
        ).length,
        evicted: outcome.driveStatuses.includes(`evicted:${crashState}`),
        plannerInvocations: outcome.plannerInvocations,
        terminalBlocker:
          outcome.result.status === "blocked"
            ? outcome.result.blocker.message
            : null,
        terminalStatus: outcome.result.status,
      }).toStrictEqual({
        duplicateReceiptKeys: new Set(
          [...outcome.remote.remoteRecords.keys()].filter(
            (artifactRef) =>
              artifactRef.includes("/receipts/") ||
              artifactRef.includes("/review/")
          )
        ).size,
        evicted: true,
        plannerInvocations: 1,
        terminalBlocker: null,
        terminalStatus: "captured",
      });
    }
  );

  test("rejects a stale drive stomping captured status", async () => {
    const remote = createLifecycleFaithfulArtifactsRemote(
      "workflow-app-stale-drive-fencing"
    );
    const contextCapsules = createMemoryContextCapsuleActor();
    const statusProjection = createMemoryWorkflowStatusProjectionStore();
    const request = buildIntegrationTestDreamRunRequest();
    const nodeExecutions: string[] = [];

    // Drive A admits first, then hangs; drive B admits, making A stale.
    const staleAdmission = await contextCapsules.admitDrive({
      runId: request.runId,
      workItemId: request.workItemId,
    });
    const activeAdmission = await contextCapsules.admitDrive({
      runId: request.runId,
      workItemId: request.workItemId,
    });
    const activeWorkflow = createLifecycleFaithfulDreamWorkflow({
      artifacts: remote.createDriveStore({
        driveId: "drive-active",
        seedFromRemote: false,
      }),
      contextCapsules,
      nodeExecutions,
      onPlan: () => {},
      statusProjection,
    });
    const activeResult = await activeWorkflow.run(request, {
      driveGeneration: activeAdmission.driveGeneration,
      driveMode: "whole-run",
    });
    expect(activeResult.status).toBe("captured");

    // Drive A wakes up on a fresh worktree and tries to write.
    const staleWorkflow = createLifecycleFaithfulDreamWorkflow({
      artifacts: remote.createDriveStore({
        driveId: "drive-stale",
        seedFromRemote: true,
      }),
      contextCapsules,
      nodeExecutions,
      onPlan: () => {
        throw new Error("stale drive must not replan");
      },
      statusProjection,
    });

    await expect(
      staleWorkflow.run(request, {
        driveGeneration: staleAdmission.driveGeneration,
        driveMode: "whole-run",
      })
    ).rejects.toBeInstanceOf(StaleDriveGenerationError);

    const ledger = contextCapsules.driveLedgers.get(
      `${request.workItemId}:${request.runId}`
    );
    expect({
      capturePhaseGeneration:
        ledger?.phases["capture-completed"]?.driveGeneration,
      latestProjectionState: statusProjection.latest.get(request.runId)
        ?.currentState,
      projectionStompedByStaleDrive: (
        statusProjection.records.get(request.runId) ?? []
      ).some(
        (projection) =>
          projection.driveGeneration === staleAdmission.driveGeneration
      ),
    }).toStrictEqual({
      capturePhaseGeneration: activeAdmission.driveGeneration,
      latestProjectionState: "captured",
      projectionStompedByStaleDrive: false,
    });
  });
});
