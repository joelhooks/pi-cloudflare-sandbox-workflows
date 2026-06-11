import { createActor } from "xstate";

import { hashJson, sha256Hex } from "../domain/hash.ts";
import {
  CapabilityLeaseRequestSchema,
  CapabilityLeaseReceiptSchema,
  DiscordMessageApprovalSchema,
  DiscordMessagePayloadSchema,
  DynamicWorkflowBlueprintSchema,
  GeneratedHarnessArtifactSchema,
  GeneratedHarnessDocumentSchema,
  GitHubBranchCommitApprovalSchema,
  GitHubBranchCommitPayloadSchema,
  GitHubPullRequestApprovalSchema,
  GitHubPullRequestPayloadSchema,
  LinearCommentApprovalSchema,
  LinearCommentPayloadSchema,
  DynamicWorkflowMachineDocumentSchema,
  DynamicWorkflowPlanDocumentSchema,
  AgentLaneReceiptSchema,
  PlanArtifactSchema,
  RunStepCheckpointSchema,
  SafetyEnvelopeCommandSchema,
  SafetyEnvelopeStateSchema,
  VerificationContractArtifactSchema,
  VerificationContractDocumentSchema,
  VerificationResultArtifactSchema,
  VerificationResultDocumentSchema,
  WorkflowExecutionProofArtifactSchema,
  WorkflowExecutionProofDocumentSchema,
  WorkflowEventSchema,
  WorkflowRunBlockedSchema,
  WorkflowRunReceiptSchema,
  WorkflowRunRequestSchema,
  WorkflowStatusProjectionSchema,
  WzrrdPublishApprovalSchema,
  WzrrdPublishPayloadSchema,
} from "../domain/schemas.ts";
import type {
  ArtifactWriteReceipt,
  ArtifactRef,
  AgentLaneEvidenceDraft,
  CapabilityBlocker,
  CapabilityLeaseDecision,
  CapabilityLeaseReceipt,
  ContextCapsuleRecord,
  DiscordMessagePayload,
  DiscordResource,
  DynamicWorkflowBlueprint,
  GeneratedHarnessArtifact,
  GitHubPullRequestPayload,
  DynamicWorkflowMachineArtifact,
  DynamicWorkflowMachineDocument,
  DynamicWorkflowPlanDocument,
  DynamicWorkflowStep,
  AgentLaneReceipt,
  GitHubBranchCommitDeliveryResult,
  GitHubBranchCommitPayload,
  LinearCommentPayload,
  OutputTarget,
  PinnedPackage,
  PackageMetadata,
  PlanArtifact,
  ReviewGate,
  ReviewSurfaceArtifact,
  RunStepCheckpoint,
  SafetyEnvelopeCommand,
  VerificationContractArtifact,
  VerificationContractDocument,
  VerificationResultArtifact,
  VerificationResultDocument,
  WorkflowSideEffectDeclaration,
  WorkflowExecutionProofArtifact,
  WorkflowExecutionProofDocument,
  WorkflowEvent,
  WorkflowNodeType,
  WorkflowRunRequest,
  WorkflowRunResult,
  WorkflowStatusProjection,
  WorkflowTerminalBlocker,
  WzrrdPublishPayload,
} from "../domain/schemas.ts";
import type { MemorySourceProfile } from "../domain/source-profile.ts";
import {
  workflowTraceContextForCapability,
  workflowTraceContextForLane,
} from "../domain/trace-context.ts";
import {
  createGeneratedWorkflowActor,
  dynamicWorkflowStateValue,
  renderGeneratedWorkflowMachineSource,
} from "../workflow/generated-machine.ts";
import { dynamicWorkflowSafetyEnvelopeMachine } from "../workflow/machine.ts";
import type {
  ArtifactStoreContract,
  CapabilityLeaseBrokerActorContract,
  ContextCapsuleActorContract,
  DiscordMessageCapabilityAdapter,
  DeterministicVerifierPort,
  DynamicWorkflowPlannerPort,
  AgentVerifierOutputEvidence,
  AgentVerifierLanePort,
  AgentWorkerLanePort,
  GitHubBranchCommitCapabilityAdapter,
  GitHubPullRequestCapabilityAdapter,
  LinearCommentCapabilityAdapter,
  ReviewSurfacePublisherPort,
  ReviewGateActorContract,
  PackageRegistryActorContract,
  WorkflowObservabilityPackArtifact,
  WorkflowObservabilityRecorderPort,
  WorkflowNodeAdapterPort,
  WorkflowPostExecutionArtifactRecorderBinding,
  WorkflowPostExecutionArtifactRecorderRegistration,
  WorkflowStatusProjectionPort,
  WzrrdPublishCapabilityAdapter,
  WorkflowAppContract,
} from "./ports.ts";

interface WorkflowDependencies {
  readonly artifacts: ArtifactStoreContract;
  readonly capabilityLeases: CapabilityLeaseBrokerActorContract;
  readonly contextCapsules: ContextCapsuleActorContract;
  readonly discordMessages: DiscordMessageCapabilityAdapter;
  readonly discordSecretRefs: {
    readonly dryRun: string;
    readonly send: string;
  };
  readonly githubPullRequests?: GitHubPullRequestCapabilityAdapter;
  readonly githubBranchCommits?: GitHubBranchCommitCapabilityAdapter;
  readonly githubSecretRefs?: {
    readonly createBranchCommit?: string;
    readonly createPullRequest: string;
    readonly dryRun: string;
  };
  readonly linearComments?: LinearCommentCapabilityAdapter;
  readonly linearSecretRefs?: {
    readonly createComment: string;
    readonly dryRun: string;
  };
  readonly dynamicWorkflowPlanner: DynamicWorkflowPlannerPort;
  readonly deterministicVerifier?: DeterministicVerifierPort;
  readonly agentVerifierLane?: AgentVerifierLanePort;
  readonly agentWorkerLane?: AgentWorkerLanePort;
  readonly executionMode?: "integration-test" | "production";
  readonly installedSourceProfiles?: readonly MemorySourceProfile[];
  readonly runtimeEnvironment?: WorkflowRuntimeEnvironment;
  readonly packageRegistry: PackageRegistryActorContract;
  readonly observabilityRecorder: WorkflowObservabilityRecorderPort;
  readonly postExecutionArtifactRecorders?: readonly WorkflowPostExecutionArtifactRecorderRegistration[];
  readonly reviewGate: ReviewGateActorContract;
  readonly reviewSurfacePublisher: ReviewSurfacePublisherPort;
  readonly statusProjection: WorkflowStatusProjectionPort;
  readonly workflowNodeAdapter?: WorkflowNodeAdapterPort;
  readonly wzrrdPublisher: WzrrdPublishCapabilityAdapter;
  readonly wzrrdSiteRef: string;
  readonly wzrrdSecretRefs: {
    readonly dryRun: string;
    readonly publish: string;
  };
}

interface PinnedDiscordPayload {
  readonly approvalRef: ArtifactRef | null;
  readonly dryRun: boolean;
  readonly payload: DiscordMessagePayload;
  readonly payloadRef: ArtifactRef;
  readonly resource: DiscordResource;
  readonly reviewGate: ReviewGate;
  readonly secretRef: string;
}

type SafetyEnvelopeTransition = (
  command: SafetyEnvelopeCommand,
  summary: string,
  refs?: Record<string, string>,
  terminalBlocker?: WorkflowTerminalBlocker
) => Promise<void>;

interface TerminalBlockerStepContext {
  readonly nodeType?: WorkflowNodeType;
  readonly stepId: string;
}

type BlockRun = (
  blocker: CapabilityBlocker,
  summary: string,
  stepContext?: TerminalBlockerStepContext
) => Promise<WorkflowRunResult>;

/**
 * Persist a resumable checkpoint after a generated-machine step completes
 * (M2.5 step 2). The envelope actor's persisted snapshot is captured from the
 * enclosing `run()` closure; the caller supplies the generated-machine
 * snapshot, completed step ids, and output artifact refs observed so far.
 * Idempotent by `runId` + `stepIndex` in the storage layer.
 */
type PersistRunCheckpoint = (input: {
  readonly completedStepIds: readonly string[];
  readonly generatedMachineSnapshot: unknown;
  readonly outputArtifactRefs: readonly ArtifactRef[];
  readonly stepIndex: number;
}) => Promise<void>;

type WorkflowRuntimeEnvironment =
  | {
      readonly deploymentId?: string;
      readonly platform: "cloudflare-workers";
      readonly workerName?: string;
    }
  | {
      readonly platform: "local-integration";
    };

interface DynamicExecutionSuccess {
  readonly artifactRefs: ArtifactRef[];
  readonly capabilityReceipts: CapabilityLeaseReceipt[];
  readonly completedStepIds: string[];
  readonly generatedStateSequence: string[];
  readonly reviewSummaryPath?: string;
  readonly status: "executed";
  readonly workerLaneReceipts: AgentLaneReceipt[];
}

interface DynamicExecutionBlocked {
  readonly result: WorkflowRunResult;
  readonly status: "blocked";
}

type DynamicExecutionResult = DynamicExecutionBlocked | DynamicExecutionSuccess;

type WorkflowNodeInvocationStep = Extract<
  DynamicWorkflowStep,
  { readonly kind: "workflow.node.invoke" }
>;

interface WorkflowNodeStepExecutionBlocked {
  readonly blocker: CapabilityBlocker;
  readonly status: "blocked";
}

interface DynamicVerificationSuccess {
  readonly resultArtifact?: VerificationResultArtifact;
  readonly resultDocument?: VerificationResultDocument;
  readonly status: "bypassed" | "verified";
  readonly verifierLaneReceipt?: AgentLaneReceipt;
}

interface DynamicVerificationBlocked {
  readonly result: WorkflowRunResult;
  readonly status: "blocked";
}

type DynamicVerificationResult =
  | DynamicVerificationBlocked
  | DynamicVerificationSuccess;

interface ExecutionProofCaptured {
  readonly proofArtifact: WorkflowExecutionProofArtifact;
  readonly proofDocument: WorkflowExecutionProofDocument;
  readonly status: "captured";
}

interface ExecutionProofBlocked {
  readonly result: WorkflowRunResult;
  readonly status: "blocked";
}

type ExecutionProofResult = ExecutionProofBlocked | ExecutionProofCaptured;

interface PostExecutionArtifactRecordingSuccess {
  readonly artifactRefs: readonly ArtifactRef[];
  readonly status: "recorded";
}

interface PostExecutionArtifactRecordingBlocked {
  readonly result: WorkflowRunResult;
  readonly status: "blocked";
}

type PostExecutionArtifactRecordingResult =
  | PostExecutionArtifactRecordingBlocked
  | PostExecutionArtifactRecordingSuccess;

interface VerifierOutputEvidenceLoaded {
  readonly outputEvidence: AgentVerifierOutputEvidence[];
  readonly status: "loaded";
}

interface VerifierOutputEvidenceBlocked {
  readonly blocker: CapabilityBlocker;
  readonly status: "blocked";
}

type VerifierOutputEvidenceLoadResult =
  | VerifierOutputEvidenceBlocked
  | VerifierOutputEvidenceLoaded;

interface DynamicPlanningSuccess {
  readonly blueprint: DynamicWorkflowBlueprint;
  readonly status: "planned";
}

interface DynamicPlanningBlocked {
  readonly blocker: CapabilityBlocker;
  readonly status: "blocked";
  readonly summary: string;
}

type DynamicPlanningResult = DynamicPlanningBlocked | DynamicPlanningSuccess;

interface DiscordCapabilityBindingSuccess {
  readonly blueprint: DynamicWorkflowBlueprint;
  readonly status: "bound";
}

interface DiscordCapabilityBindingBlocked {
  readonly blocker: CapabilityBlocker;
  readonly status: "blocked";
  readonly summary: string;
}

type DiscordCapabilityBindingResult =
  | DiscordCapabilityBindingBlocked
  | DiscordCapabilityBindingSuccess;

interface CapturedArtifactRefsInput {
  readonly discordPayload: PinnedDiscordPayload | null;
  readonly execution: DynamicExecutionSuccess;
  readonly executionProofArtifact: WorkflowExecutionProofArtifact;
  readonly observabilityPack: WorkflowObservabilityPackArtifact;
  readonly pinnedDynamicWorkflow: PinnedDynamicWorkflow;
  readonly pinnedPackages: readonly PinnedPackage[];
  readonly planArtifact: PlanArtifact;
  readonly postExecutionArtifactRefs: readonly ArtifactRef[];
  readonly reviewSummaryRef: ArtifactRef;
  readonly verification: DynamicVerificationSuccess;
}

interface PublishReviewSurfaceInput extends CapturedArtifactRefsInput {
  readonly artifactRefs: readonly ArtifactRef[];
  readonly eventLog: readonly WorkflowEvent[];
  readonly loadedPlan: DynamicWorkflowPlanDocument;
}

interface ReviewSurfaceDeliverySuccess {
  readonly artifactRefs: readonly ArtifactRef[];
  readonly capabilityReceipts: readonly CapabilityLeaseReceipt[];
  readonly status: "delivered";
}

interface ReviewSurfaceDeliveryBlocked {
  readonly result: WorkflowRunResult;
  readonly status: "blocked";
}

type ReviewSurfaceDeliveryResult =
  | ReviewSurfaceDeliveryBlocked
  | ReviewSurfaceDeliverySuccess;

interface GitHubReviewBranchDeliverySuccess {
  readonly artifactRefs: readonly ArtifactRef[];
  readonly branchFilePath: string;
  readonly capabilityReceipt: CapabilityLeaseReceipt;
  readonly delivery: GitHubBranchCommitDeliveryResult;
  readonly status: "delivered";
}

type GitHubReviewBranchDeliveryResult =
  | ReviewSurfaceDeliveryBlocked
  | GitHubReviewBranchDeliverySuccess;

interface GitHubDeliveryAdaptersReady {
  readonly githubBranchCommits: GitHubBranchCommitCapabilityAdapter;
  readonly githubPullRequests: GitHubPullRequestCapabilityAdapter;
  readonly status: "ready";
}

type GitHubDeliveryAdaptersResult =
  | ReviewSurfaceDeliveryBlocked
  | GitHubDeliveryAdaptersReady;

type WzrrdPrimaryDocument = NonNullable<WzrrdPublishPayload["primaryDocument"]>;

type WzrrdPrimaryDocumentResult =
  | {
      readonly primaryDocument?: WzrrdPrimaryDocument;
      readonly status: "ready";
    }
  | {
      readonly result: WorkflowRunResult;
      readonly status: "blocked";
    };

interface PinnedDynamicWorkflow {
  readonly harnessArtifact: GeneratedHarnessArtifact;
  readonly machineArtifact: DynamicWorkflowMachineArtifact;
  readonly planDocument: DynamicWorkflowPlanDocument;
  readonly plannerLaneReceipt: AgentLaneReceipt;
  readonly verificationContractArtifact: VerificationContractArtifact;
}

interface LoadedDynamicWorkflowMachine {
  readonly machine: DynamicWorkflowMachineDocument;
  readonly machineSource: string;
  readonly status: "loaded";
}

interface BlockedDynamicWorkflowMachine {
  readonly blocker: CapabilityBlocker;
  readonly status: "blocked";
}

type DynamicWorkflowMachineLoadResult =
  | BlockedDynamicWorkflowMachine
  | LoadedDynamicWorkflowMachine;

interface LoadedPinnedPlanSupportArtifacts {
  readonly harnessSource: string;
  readonly status: "loaded";
  readonly verificationContract: VerificationContractDocument;
}

interface BlockedPinnedPlanSupportArtifacts {
  readonly blocker: CapabilityBlocker;
  readonly status: "blocked";
}

type PinnedPlanSupportArtifactsLoadResult =
  | BlockedPinnedPlanSupportArtifacts
  | LoadedPinnedPlanSupportArtifacts;

type PinnedPlanExecutionPreparation =
  | {
      readonly blocker: CapabilityBlocker;
      readonly status: "blocked";
      readonly stepContext?: TerminalBlockerStepContext;
      readonly summary: string;
    }
  | {
      readonly machine: LoadedDynamicWorkflowMachine;
      readonly status: "ready";
      readonly supportArtifacts: LoadedPinnedPlanSupportArtifacts;
    };

type GeneratedWorkflowMachineState =
  DynamicWorkflowMachineDocument["xstate"]["states"][string];

interface CurrentGeneratedWorkflowDoneState {
  readonly stateValue: string;
  readonly status: "done";
}

interface CurrentGeneratedWorkflowStepState {
  readonly state: GeneratedWorkflowMachineState;
  readonly stateValue: string;
  readonly status: "step";
}

interface CurrentGeneratedWorkflowBlockedState {
  readonly blocker: CapabilityBlocker;
  readonly status: "blocked";
  readonly summary: string;
}

type CurrentGeneratedWorkflowState =
  | CurrentGeneratedWorkflowBlockedState
  | CurrentGeneratedWorkflowDoneState
  | CurrentGeneratedWorkflowStepState;

interface GeneratedWorkflowPlanStepResolved {
  readonly step: DynamicWorkflowStep;
  readonly stepId: string;
  readonly status: "resolved";
}

interface GeneratedWorkflowPlanStepBlocked {
  readonly blocker: CapabilityBlocker;
  readonly status: "blocked";
  readonly summary: string;
}

type GeneratedWorkflowPlanStepResolution =
  | GeneratedWorkflowPlanStepBlocked
  | GeneratedWorkflowPlanStepResolved;

const pickRequestedPackageIds = (
  request: WorkflowRunRequest,
  metadata: readonly { readonly packageId: string }[]
): string[] => {
  if (request.planProposal.requestedPackageIds.length > 0) {
    return request.planProposal.requestedPackageIds;
  }

  return metadata.map((packageMetadata) => packageMetadata.packageId);
};

const blocker = (
  code: CapabilityBlocker["code"],
  message: string
): CapabilityBlocker => ({
  code,
  message,
  redacted: true,
});

const resolveCurrentGeneratedWorkflowState = (input: {
  readonly machine: DynamicWorkflowMachineDocument;
  readonly rawStateValue: unknown;
}): CurrentGeneratedWorkflowState => {
  const stateValue = dynamicWorkflowStateValue(input.rawStateValue);
  if (stateValue === null) {
    return {
      blocker: blocker(
        "capability_denied",
        "Generated workflow machine produced a non-string state value."
      ),
      status: "blocked",
      summary: "Generated workflow machine state could not be interpreted.",
    };
  }

  const state = input.machine.xstate.states[stateValue];
  if (state === undefined) {
    return {
      blocker: blocker(
        "capability_denied",
        "Generated workflow machine entered an unknown state."
      ),
      status: "blocked",
      summary:
        "Generated workflow machine state was missing from its own config.",
    };
  }

  if (state.type === "final") {
    if (stateValue === "done") {
      return { stateValue, status: "done" };
    }

    return {
      blocker: blocker(
        "capability_denied",
        "Generated workflow machine reached a blocked terminal state."
      ),
      status: "blocked",
      summary: "Generated workflow machine blocked execution.",
    };
  }

  return { state, stateValue, status: "step" };
};

/**
 * The output path whose committed artifact ref the two-factor resume check
 * verifies for a completed step. Only `workflow.node.invoke` and
 * `research.review` steps commit a primary output ref during execution (the
 * value stored in `artifactRefsByStepId`); a `review.summary` step merely
 * reserves a path for the later review gate, and the discord capability step
 * commits no output, so both return `undefined` and rely on the
 * `completedStepIds` factor alone.
 */
const primaryOutputPathForStep = (
  step: DynamicWorkflowStep
): string | undefined => {
  if (step.kind === "workflow.node.invoke" || step.kind === "research.review") {
    return step.outputPath;
  }

  return undefined;
};

const resolveGeneratedWorkflowPlanStep = (input: {
  readonly state: GeneratedWorkflowMachineState;
  readonly stepById: ReadonlyMap<string, DynamicWorkflowStep>;
}): GeneratedWorkflowPlanStepResolution => {
  const { stepId } = input.state.meta;
  if (stepId === undefined) {
    return {
      blocker: blocker(
        "capability_denied",
        "Generated workflow machine state does not identify a plan step."
      ),
      status: "blocked",
      summary: "Generated workflow machine state was not executable.",
    };
  }

  const step = input.stepById.get(stepId);
  if (step === undefined) {
    return {
      blocker: blocker(
        "capability_denied",
        "Generated workflow machine referenced an unknown plan step."
      ),
      status: "blocked",
      summary: "Generated workflow machine referenced missing plan data.",
    };
  }

  return { status: "resolved", step, stepId };
};

const safeArtifactPathSegment = (value: string): string =>
  value.replaceAll(/[^A-Za-z0-9_.-]/gu, "_");

const hasApprovedGitHubRealDelivery = (request: WorkflowRunRequest): boolean =>
  request.actor.roleIds.includes("github.branch.commit") &&
  request.actor.roleIds.includes("github.pr.create");

const hasApprovedLinearRealDelivery = (request: WorkflowRunRequest): boolean =>
  request.actor.roleIds.includes("linear.comment.create");

const githubPullRequestUrlEventMetadata = (
  delivery: object
): Record<string, string> =>
  "pullRequestUrl" in delivery && typeof delivery.pullRequestUrl === "string"
    ? { pullRequestUrl: delivery.pullRequestUrl }
    : {};

const isRealAgentLaneReceipt = (receipt: AgentLaneReceipt): boolean =>
  receipt.realAgent && receipt.runtime !== "integration-test";

interface StepStateMapReady {
  readonly status: "ready";
  readonly stepStateById: Map<string, string>;
}

interface StepStateMapBlocked {
  readonly blocker: CapabilityBlocker;
  readonly status: "blocked";
}

type StepStateMapResult = StepStateMapBlocked | StepStateMapReady;

const validateGeneratedMachineBinding = (
  plan: DynamicWorkflowPlanDocument,
  machine: DynamicWorkflowMachineDocument
): CapabilityBlocker | null => {
  if (machine.runId !== plan.runId || machine.workItemId !== plan.workItemId) {
    return blocker(
      "payload_hash_mismatch",
      "Generated workflow machine is not bound to the loaded plan run."
    );
  }

  if (machine.machineId !== plan.machine.machineId) {
    return blocker(
      "payload_hash_mismatch",
      "Generated workflow machine id does not match the plan artifact."
    );
  }

  return null;
};

const validateGeneratedMachineTransitionTargets = (
  machine: DynamicWorkflowMachineDocument
): CapabilityBlocker | null => {
  for (const state of Object.values(machine.xstate.states)) {
    for (const transition of Object.values(state.on)) {
      if (machine.xstate.states[transition.target] === undefined) {
        return blocker(
          "capability_denied",
          "Generated XState machine references a missing transition target."
        );
      }
    }
  }

  return null;
};

const validateGeneratedMachineStepReferences = (
  plan: DynamicWorkflowPlanDocument,
  machine: DynamicWorkflowMachineDocument
): CapabilityBlocker | null => {
  const planStepIds = new Set(plan.steps.map((step) => step.stepId));
  const machineStepIds = new Set(machine.stepOrder);
  if (
    planStepIds.size !== plan.steps.length ||
    machineStepIds.size !== machine.stepOrder.length ||
    planStepIds.size !== machineStepIds.size
  ) {
    return blocker(
      "capability_denied",
      "Generated workflow machine and plan step ids are not one-to-one."
    );
  }

  for (const stepId of machine.stepOrder) {
    if (!planStepIds.has(stepId)) {
      return blocker(
        "capability_denied",
        "Generated workflow machine references a step missing from the plan."
      );
    }
  }

  for (const state of Object.values(machine.xstate.states)) {
    if (
      state.meta.stepId !== undefined &&
      !planStepIds.has(state.meta.stepId)
    ) {
      return blocker(
        "capability_denied",
        "Generated XState state references a step missing from the plan."
      );
    }
  }

  return null;
};

const buildGeneratedMachineStepStateMap = (
  machine: DynamicWorkflowMachineDocument
): StepStateMapResult => {
  const stepStateById = new Map<string, string>();
  for (const [stateName, state] of Object.entries(machine.xstate.states)) {
    if (state.meta.stepId === undefined) {
      continue;
    }

    if (stepStateById.has(state.meta.stepId)) {
      return {
        blocker: blocker(
          "capability_denied",
          "Generated XState machine has duplicate executable states for a plan step."
        ),
        status: "blocked",
      };
    }

    stepStateById.set(state.meta.stepId, stateName);
  }

  return { status: "ready", stepStateById };
};

const validateGeneratedMachineStartupProtocol = (
  machine: DynamicWorkflowMachineDocument
): CapabilityBlocker | null => {
  const initialState = machine.xstate.states[machine.xstate.initial];
  if (initialState === undefined) {
    return blocker(
      "capability_denied",
      "Generated XState machine initial state is missing."
    );
  }

  if (
    initialState.type === "final" ||
    machine.xstate.initial === "done" ||
    machine.xstate.initial === "blocked"
  ) {
    return blocker(
      "capability_denied",
      "Generated XState initial state must not be a terminal done or blocked state."
    );
  }

  if (initialState.meta.stepId !== undefined) {
    return blocker(
      "capability_denied",
      "Generated XState initial state must be a ready state, not an executable step."
    );
  }

  const initialTarget = initialState.on["NEXT"]?.target;
  if (initialTarget === undefined) {
    return blocker(
      "capability_denied",
      "Generated XState initial state must transition to the first step on NEXT."
    );
  }

  const firstStepId = machine.stepOrder.at(0);
  const firstState = machine.xstate.states[initialTarget];
  if (
    firstStepId === undefined ||
    firstState === undefined ||
    firstState.meta.stepId !== firstStepId
  ) {
    return blocker(
      "capability_denied",
      "Generated XState initial NEXT transition must target the first planned step."
    );
  }

  return null;
};

const validateGeneratedMachineTerminalStates = (
  machine: DynamicWorkflowMachineDocument
): CapabilityBlocker | null => {
  const doneState = machine.xstate.states["done"];
  if (doneState?.type !== "final") {
    return blocker(
      "capability_denied",
      "Generated XState machine must include a done final state."
    );
  }

  const blockedState = machine.xstate.states["blocked"];
  if (blockedState?.type !== "final") {
    return blocker(
      "capability_denied",
      "Generated XState machine must include a blocked final state."
    );
  }

  return null;
};

const validateGeneratedMachineStepTransitions = (
  machine: DynamicWorkflowMachineDocument,
  stepStateById: Map<string, string>
): CapabilityBlocker | null => {
  for (const [index, stepId] of machine.stepOrder.entries()) {
    const stateName = stepStateById.get(stepId);
    if (stateName === undefined) {
      return blocker(
        "capability_denied",
        "Generated XState machine has no executable state for a plan step."
      );
    }

    const state = machine.xstate.states[stateName];
    if (state === undefined) {
      return blocker(
        "capability_denied",
        "Generated XState machine has no executable state for a plan step."
      );
    }

    if (state.type === "final") {
      return blocker(
        "capability_denied",
        "Generated XState executable step states must not be terminal."
      );
    }

    if (state.on["STEP_BLOCKED"]?.target !== "blocked") {
      return blocker(
        "capability_denied",
        "Generated XState executable step states must transition to blocked on STEP_BLOCKED."
      );
    }

    const stepDoneTarget = state.on["STEP_DONE"]?.target;
    if (stepDoneTarget === undefined) {
      return blocker(
        "capability_denied",
        "Generated XState executable step states must transition on STEP_DONE."
      );
    }

    const nextStepId = machine.stepOrder.at(index + 1);
    if (nextStepId === undefined) {
      if (stepDoneTarget !== "done") {
        return blocker(
          "capability_denied",
          "Generated XState final executable step must transition to done on STEP_DONE."
        );
      }
      continue;
    }

    const nextState = machine.xstate.states[stepDoneTarget];
    if (nextState?.meta.stepId !== nextStepId) {
      return blocker(
        "capability_denied",
        "Generated XState STEP_DONE transition must target the next planned step."
      );
    }
  }

  return null;
};

const validateGeneratedMachineAgainstPlan = (
  plan: DynamicWorkflowPlanDocument,
  machine: DynamicWorkflowMachineDocument
): CapabilityBlocker | null => {
  const checks = [
    validateGeneratedMachineBinding(plan, machine),
    validateGeneratedMachineTransitionTargets(machine),
    validateGeneratedMachineStepReferences(plan, machine),
    validateGeneratedMachineStartupProtocol(machine),
    validateGeneratedMachineTerminalStates(machine),
  ];
  const failedCheck = checks.find((check) => check !== null);
  if (failedCheck !== undefined) {
    return failedCheck;
  }

  const stepStateMap = buildGeneratedMachineStepStateMap(machine);
  if (stepStateMap.status === "blocked") {
    return stepStateMap.blocker;
  }

  return validateGeneratedMachineStepTransitions(
    machine,
    stepStateMap.stepStateById
  );
};

const dynamicStepOutputPath = (step: DynamicWorkflowStep): string | null => {
  if (step.kind === "capability.discord.message") {
    return null;
  }

  return step.outputPath;
};

const outputTargetPath = (outputTarget: OutputTarget): string | null => {
  if (outputTarget.kind === "artifact-only") {
    return outputTarget.path;
  }

  if (outputTarget.kind === "wzrrd") {
    return outputTarget.reviewPath;
  }

  return null;
};

const discordResourceMatchesPinnedPayload = (
  resource: DiscordResource,
  pinnedPayload: PinnedDiscordPayload
): boolean =>
  resource.channelRef === pinnedPayload.resource.channelRef &&
  resource.serverRef === pinnedPayload.resource.serverRef;

const validatePinnedDiscordCapabilityFields = (input: {
  readonly dryRun: boolean;
  readonly payloadHash: string;
  readonly payloadRef: ArtifactRef;
  readonly resource: DiscordResource;
  readonly reviewGate: ReviewGate;
  readonly secretRef: string;
  readonly pinnedPayload: PinnedDiscordPayload;
}): CapabilityBlocker | null => {
  if (input.payloadHash !== input.pinnedPayload.payload.bodyHash) {
    return blocker(
      "payload_hash_mismatch",
      "Generated Discord side effect payload hash did not match the server-pinned payload."
    );
  }

  if (input.payloadRef !== input.pinnedPayload.payloadRef) {
    return blocker(
      "capability_denied",
      "Generated Discord side effect payload artifact did not match the server-pinned payload."
    );
  }

  if (
    !discordResourceMatchesPinnedPayload(input.resource, input.pinnedPayload)
  ) {
    return blocker(
      "resource_scope_denied",
      "Generated Discord side effect resource did not match the server-pinned target."
    );
  }

  if (input.dryRun !== input.pinnedPayload.dryRun) {
    return blocker(
      "capability_denied",
      "Generated Discord side effect mode did not match the server-pinned send mode."
    );
  }

  if (input.secretRef !== input.pinnedPayload.secretRef) {
    return blocker(
      "secret_denied",
      "Generated Discord side effect secret reference did not match the server-pinned lease."
    );
  }

  if (hashJson(input.reviewGate) !== hashJson(input.pinnedPayload.reviewGate)) {
    return blocker(
      "review_required",
      "Generated Discord side effect review gate did not match the server-pinned review state."
    );
  }

  return null;
};

const rebindGeneratedDiscordStep = (
  step: DynamicWorkflowStep,
  pinnedPayload: PinnedDiscordPayload | null
):
  | { readonly status: "bound"; readonly step: DynamicWorkflowStep }
  | {
      readonly blocker: CapabilityBlocker;
      readonly status: "blocked";
      readonly summary: string;
    } => {
  if (step.kind !== "capability.discord.message") {
    return { status: "bound", step };
  }

  if (pinnedPayload === null) {
    return {
      blocker: blocker(
        "capability_denied",
        "Generated workflow declared a Discord side effect without a server-pinned Discord payload."
      ),
      status: "blocked",
      summary: "Planner output failed Discord capability binding.",
    };
  }

  const discordFieldsBlocker = validatePinnedDiscordCapabilityFields({
    dryRun: step.dryRun,
    payloadHash: step.payloadHash,
    payloadRef: step.payloadRef,
    pinnedPayload,
    resource: step.resource,
    reviewGate: step.reviewGate,
    secretRef: step.secretRef,
  });
  if (discordFieldsBlocker !== null) {
    return {
      blocker: discordFieldsBlocker,
      status: "blocked",
      summary: "Planner output failed Discord capability binding.",
    };
  }

  return {
    status: "bound",
    step: {
      ...step,
      dryRun: pinnedPayload.dryRun,
      payloadHash: pinnedPayload.payload.bodyHash,
      payloadRef: pinnedPayload.payloadRef,
      resource: pinnedPayload.resource,
      reviewGate: pinnedPayload.reviewGate,
      secretRef: pinnedPayload.secretRef,
    },
  };
};

const rebindGeneratedDiscordSideEffect = (
  sideEffect: WorkflowSideEffectDeclaration,
  pinnedPayload: PinnedDiscordPayload | null
):
  | {
      readonly sideEffect: WorkflowSideEffectDeclaration;
      readonly status: "bound";
    }
  | {
      readonly blocker: CapabilityBlocker;
      readonly status: "blocked";
      readonly summary: string;
    } => {
  if (sideEffect.capability !== "discord.message.send") {
    return { sideEffect, status: "bound" };
  }

  if (pinnedPayload === null) {
    return {
      blocker: blocker(
        "capability_denied",
        "Generated workflow declared a Discord side effect without a server-pinned Discord payload."
      ),
      status: "blocked",
      summary: "Planner output failed Discord side-effect binding.",
    };
  }

  if (sideEffect.resource.kind !== "discord.channel") {
    return {
      blocker: blocker(
        "resource_scope_denied",
        "Generated Discord side effect resource was not a Discord channel."
      ),
      status: "blocked",
      summary: "Planner output failed Discord side-effect binding.",
    };
  }

  const discordFieldsBlocker = validatePinnedDiscordCapabilityFields({
    dryRun: sideEffect.dryRun,
    payloadHash: sideEffect.payloadHash,
    payloadRef: sideEffect.payloadRef,
    pinnedPayload,
    resource: sideEffect.resource,
    reviewGate: sideEffect.reviewGate,
    secretRef: sideEffect.secretRef,
  });
  if (discordFieldsBlocker !== null) {
    return {
      blocker: discordFieldsBlocker,
      status: "blocked",
      summary: "Planner output failed Discord side-effect binding.",
    };
  }

  return {
    sideEffect: {
      ...sideEffect,
      dryRun: pinnedPayload.dryRun,
      payloadHash: pinnedPayload.payload.bodyHash,
      payloadRef: pinnedPayload.payloadRef,
      resource: pinnedPayload.resource,
      reviewGate: pinnedPayload.reviewGate,
      secretRef: pinnedPayload.secretRef,
    },
    status: "bound",
  };
};

const bindGeneratedDiscordCapabilities = (input: {
  readonly blueprint: DynamicWorkflowBlueprint;
  readonly pinnedPayload: PinnedDiscordPayload | null;
}): DiscordCapabilityBindingResult => {
  const steps: DynamicWorkflowStep[] = [];
  for (const step of input.blueprint.plan.steps) {
    const boundStep = rebindGeneratedDiscordStep(step, input.pinnedPayload);
    if (boundStep.status === "blocked") {
      return boundStep;
    }
    steps.push(boundStep.step);
  }

  const sideEffects: WorkflowSideEffectDeclaration[] = [];
  for (const sideEffect of input.blueprint.plan.sideEffects) {
    const boundSideEffect = rebindGeneratedDiscordSideEffect(
      sideEffect,
      input.pinnedPayload
    );
    if (boundSideEffect.status === "blocked") {
      return boundSideEffect;
    }
    sideEffects.push(boundSideEffect.sideEffect);
  }

  return {
    blueprint: DynamicWorkflowBlueprintSchema.parse({
      ...input.blueprint,
      plan: {
        ...input.blueprint.plan,
        sideEffects,
        steps,
      },
    }),
    status: "bound",
  };
};

const validateVerificationContractOutputPath = (
  plan: {
    readonly outputTarget: OutputTarget;
    readonly steps: readonly DynamicWorkflowStep[];
  },
  verificationContract: VerificationContractDocument
): CapabilityBlocker | null => {
  for (const step of plan.steps) {
    const stepOutputPath = dynamicStepOutputPath(step);
    if (
      stepOutputPath !== null &&
      verificationContract.outputPath === stepOutputPath
    ) {
      return blocker(
        "capability_denied",
        `Verification contract outputPath must not collide with dynamic step outputPath: ${stepOutputPath}.`
      );
    }
  }

  const targetPath = outputTargetPath(plan.outputTarget);
  if (targetPath !== null && verificationContract.outputPath === targetPath) {
    return blocker(
      "capability_denied",
      `Verification contract outputPath must not collide with output target path: ${targetPath}.`
    );
  }

  return null;
};

export class WorkflowApp implements WorkflowAppContract {
  readonly appName = "workflow-app" as const;

  private readonly dependencies: WorkflowDependencies;

  constructor(dependencies: WorkflowDependencies) {
    this.dependencies = dependencies;
  }

  private isIntegrationTestMode(): boolean {
    return this.dependencies.executionMode === "integration-test";
  }

  private shouldRecordIntegrationTestWorkerReceipts(): boolean {
    return (
      this.dependencies.executionMode === "integration-test" &&
      this.dependencies.agentWorkerLane === undefined
    );
  }

  private recordStatusProjection(input: {
    readonly capsule: ContextCapsuleRecord | null;
    readonly event: WorkflowEvent;
    readonly eventCount: number;
    readonly planArtifact: PlanArtifact | null;
    readonly request: WorkflowRunRequest;
    readonly terminalBlocker?: WorkflowTerminalBlocker;
  }): Promise<void> {
    const projection: WorkflowStatusProjection =
      WorkflowStatusProjectionSchema.parse({
        actorId: input.request.actor.id,
        capsuleId:
          input.capsule?.capsuleId ?? `capsule:${input.request.workItemId}`,
        currentState: input.event.state,
        eventCount: input.eventCount,
        lastEvent: input.event,
        ...(input.planArtifact === null
          ? {}
          : { planArtifact: input.planArtifact }),
        redacted: true,
        runId: input.request.runId,
        schemaVersion: "workflow.status-projection.v1",
        ...(input.terminalBlocker === undefined
          ? {}
          : { terminalBlocker: input.terminalBlocker }),
        updatedAt: input.event.at,
        workItemId: input.request.workItemId,
      });

    return this.dependencies.statusProjection.record({ projection });
  }

  private async proposeDynamicWorkflowBlueprint(input: {
    readonly discordPayload: PinnedDiscordPayload | null;
    readonly packageMetadata: readonly PackageMetadata[];
    readonly pinnedPackages: readonly PinnedPackage[];
    readonly request: WorkflowRunRequest;
  }): Promise<DynamicPlanningResult> {
    try {
      const blueprint = DynamicWorkflowBlueprintSchema.parse(
        await this.dependencies.dynamicWorkflowPlanner.proposePlan({
          actor: input.request.actor,
          availablePackages: input.packageMetadata,
          ...(input.discordPayload === null
            ? {}
            : {
                notification: {
                  dryRun: input.discordPayload.dryRun,
                  payloadHash: input.discordPayload.payload.bodyHash,
                  payloadRef: input.discordPayload.payloadRef,
                  resource: input.discordPayload.resource,
                  reviewGate: input.discordPayload.reviewGate,
                  secretRef: input.discordPayload.secretRef,
                },
              }),
          pinnedPackages: input.pinnedPackages,
          proposal: input.request.planProposal,
          runId: input.request.runId,
          workItemId: input.request.workItemId,
        })
      );
      const discordCapabilityBinding = bindGeneratedDiscordCapabilities({
        blueprint,
        pinnedPayload: input.discordPayload,
      });
      if (discordCapabilityBinding.status === "blocked") {
        return {
          blocker: discordCapabilityBinding.blocker,
          status: "blocked",
          summary: discordCapabilityBinding.summary,
        };
      }

      const verificationOutputPathBlocker =
        validateVerificationContractOutputPath(
          discordCapabilityBinding.blueprint.plan,
          discordCapabilityBinding.blueprint.verificationContract
        );
      if (verificationOutputPathBlocker !== null) {
        return {
          blocker: verificationOutputPathBlocker,
          status: "blocked",
          summary: "Planner output failed dynamic workflow validation.",
        };
      }

      return {
        blueprint: discordCapabilityBinding.blueprint,
        status: "planned",
      };
    } catch (error) {
      return {
        blocker: blocker(
          "adapter_unavailable",
          `Dynamic workflow planner failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        ),
        status: "blocked",
        summary: "Planner lane adapter failed.",
      };
    }
  }

  async run(input: WorkflowRunRequest): Promise<WorkflowRunResult> {
    const request = WorkflowRunRequestSchema.parse(input);
    const eventLog: WorkflowEvent[] = [];
    const actor = createActor(dynamicWorkflowSafetyEnvelopeMachine);
    let projectionCapsule: ContextCapsuleRecord | null = null;
    let projectionPlanArtifact: PlanArtifact | null = null;
    actor.start();

    const transition: SafetyEnvelopeTransition = async (
      command,
      summary,
      refs,
      terminalBlocker
    ) => {
      const parsedCommand = SafetyEnvelopeCommandSchema.parse(command);
      actor.send(parsedCommand);
      const state = SafetyEnvelopeStateSchema.parse(actor.getSnapshot().value);
      const event = WorkflowEventSchema.parse({
        at: new Date().toISOString(),
        refs: refs ?? {},
        state,
        summary,
      });
      eventLog.push(event);
      await this.dependencies.contextCapsules.appendEvent({
        event,
        workItemId: request.workItemId,
      });
      await this.recordStatusProjection({
        capsule: projectionCapsule,
        event,
        eventCount: eventLog.length,
        planArtifact: projectionPlanArtifact,
        request,
        ...(terminalBlocker === undefined ? {} : { terminalBlocker }),
      });
    };

    const block: BlockRun = async (blockedBy, summary, stepContext) => {
      const terminalBlocker: WorkflowTerminalBlocker = {
        code: blockedBy.code,
        message: blockedBy.message,
        ...(stepContext?.nodeType === undefined
          ? {}
          : { nodeType: stepContext.nodeType }),
        redacted: true,
        ...(stepContext?.stepId === undefined
          ? {}
          : { stepId: stepContext.stepId }),
      };
      await transition(
        { blocker: blockedBy, type: "BLOCK" },
        summary,
        {},
        terminalBlocker
      );
      return WorkflowRunBlockedSchema.parse({
        blocker: blockedBy,
        eventLog,
        runId: request.runId,
        status: "blocked",
      });
    };

    const persistCheckpoint: PersistRunCheckpoint = async (checkpointInput) => {
      const checkpoint = RunStepCheckpointSchema.parse({
        completedStepIds: [...checkpointInput.completedStepIds],
        envelopeSnapshot: actor.getPersistedSnapshot(),
        generatedMachineSnapshot: checkpointInput.generatedMachineSnapshot,
        outputArtifactRefs: [...checkpointInput.outputArtifactRefs],
        persistedAt: new Date().toISOString(),
        runId: request.runId,
        schemaVersion: "workflow.run-step-checkpoint.v1",
        stepIndex: checkpointInput.stepIndex,
        workItemId: request.workItemId,
      });
      await this.dependencies.contextCapsules.persistCheckpoint({
        checkpoint,
        workItemId: request.workItemId,
      });
    };

    await transition({ type: "START" }, "Run request accepted.");

    const capsule = await this.dependencies.contextCapsules.resolve({
      runId: request.runId,
      workItemId: request.workItemId,
    });
    projectionCapsule = capsule;
    await transition(
      { type: "CAPSULE_RESOLVED" },
      "Context capsule resolved.",
      { capsuleId: capsule.capsuleId }
    );

    let packageMetadata: PackageMetadata[];
    try {
      packageMetadata =
        await this.dependencies.packageRegistry.discoverMetadata({
          actor: request.actor,
        });
    } catch (error) {
      return await block(
        blocker(
          "stale_package",
          `Package metadata discovery failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        ),
        "Package metadata discovery failed."
      );
    }
    await transition(
      { type: "PACKAGE_METADATA_DISCOVERED" },
      "Package metadata discovered before mount.",
      { packageCount: String(packageMetadata.length) }
    );

    const requestedPackageIds = pickRequestedPackageIds(
      request,
      packageMetadata
    );
    await transition(
      { type: "ENTITLEMENTS_ACCEPTED" },
      "Package entitlement check accepted requested package metadata.",
      { requestedPackageCount: String(requestedPackageIds.length) }
    );

    const pinResult = await this.dependencies.packageRegistry.pinPackages({
      actor: request.actor,
      packageIds: requestedPackageIds,
    });
    if (pinResult.status === "blocked") {
      return await block(pinResult.blocker, "Package pinning blocked.");
    }

    await transition(
      { type: "PACKAGES_PINNED" },
      "Packages pinned as Artifact refs.",
      {
        pinnedPackageCount: String(pinResult.pinnedPackages.length),
      }
    );

    const discordPayload = await this.pinDiscordPayload(request);
    const planning = await this.proposeDynamicWorkflowBlueprint({
      discordPayload,
      packageMetadata,
      pinnedPackages: pinResult.pinnedPackages,
      request,
    });
    if (planning.status === "blocked") {
      return await block(planning.blocker, planning.summary);
    }
    const { blueprint } = planning;
    if (
      !this.isIntegrationTestMode() &&
      (!blueprint.plannerLane.realAgent ||
        blueprint.plannerLane.runtime === "integration-test")
    ) {
      return await block(
        blocker(
          "adapter_unavailable",
          "Production workflow planning requires a real planner agent lane."
        ),
        "Planner lane was not a real agent execution."
      );
    }

    const pinnedDynamicWorkflow = await this.pinDynamicWorkflowBlueprint({
      blueprint,
      request,
    });
    const { planDocument } = pinnedDynamicWorkflow;

    await transition(
      { type: "DYNAMIC_WORKFLOW_PLANNED" },
      "Stochastic planner produced a generated XState workflow machine and dynamic plan.",
      {
        machineRef: planDocument.machine.sourceArtifactRef,
        planId: planDocument.planId,
        planner: planDocument.planner.source,
        stepCount: String(planDocument.steps.length),
      }
    );

    const planWrite = await this.dependencies.artifacts.writeJson({
      path: "run/plan.json",
      redacted: true,
      runId: request.runId,
      value: planDocument,
    });
    const planArtifact = PlanArtifactSchema.parse({
      artifactRef: planWrite.artifactRef,
      hash: planWrite.contentHash,
      pinnedAt: planDocument.createdAt,
      runId: request.runId,
    });
    projectionPlanArtifact = planArtifact;
    await transition({ type: "PLAN_PINNED" }, "Dynamic plan artifact pinned.", {
      planHash: planArtifact.hash,
      planRef: planArtifact.artifactRef,
    });

    const loadedPlan = DynamicWorkflowPlanDocumentSchema.parse(
      await this.dependencies.artifacts.readJson({
        artifactRef: planArtifact.artifactRef,
      })
    );
    if (hashJson(loadedPlan) !== planArtifact.hash) {
      return await block(
        blocker(
          "payload_hash_mismatch",
          "Pinned plan hash changed before execution."
        ),
        "Pinned dynamic plan hash check failed."
      );
    }

    const preparedPlan = await this.preparePinnedPlanExecution({ loadedPlan });
    if (preparedPlan.status === "blocked") {
      return await block(
        preparedPlan.blocker,
        preparedPlan.summary,
        preparedPlan.stepContext
      );
    }
    const loadedMachine = preparedPlan.machine;
    const loadedSupportArtifacts = preparedPlan.supportArtifacts;

    await transition(
      { type: "PINNED_DYNAMIC_WORKFLOW_LOADED" },
      "Execution loaded the pinned generated XState workflow machine and dynamic plan.",
      {
        harnessHash: loadedPlan.harness.hash,
        harnessRef: loadedPlan.harness.artifactRef,
        machineHash: loadedPlan.machine.hash,
        machineRef: loadedPlan.machine.artifactRef,
        machineSourceHash: loadedPlan.machine.sourceHash,
        machineSourceRef: loadedPlan.machine.sourceArtifactRef,
        verificationContractHash: loadedPlan.verificationContract.hash,
        verificationContractRef: loadedPlan.verificationContract.artifactRef,
      }
    );

    // M2.5 step 3 (resume): a checkpoint from a prior, evicted invocation of
    // this run lets the generated-workflow loop continue from its last trusted
    // step instead of re-walking. A fresh run has none, so this is `null` and
    // execution starts from the top — byte-identical to the pre-resume path.
    const resumeCheckpoint =
      await this.dependencies.contextCapsules.loadLatestCheckpoint({
        runId: request.runId,
        workItemId: request.workItemId,
      });

    const execution = await this.executeDynamicWorkflow({
      block,
      loadedPlan,
      machine: loadedMachine.machine,
      persistCheckpoint,
      request,
      resumeCheckpoint,
      transition,
    });
    if (execution.status === "blocked") {
      return execution.result;
    }

    const observabilityPack =
      await this.dependencies.observabilityRecorder.capturePack({
        capabilityReceipts: execution.capabilityReceipts,
        eventLog,
        executionArtifactRefs: execution.artifactRefs,
        plan: loadedPlan,
        planArtifact,
        plannerLaneReceipt: pinnedDynamicWorkflow.plannerLaneReceipt,
        workerLaneReceipts: execution.workerLaneReceipts,
      });

    const verification = await this.verifyDynamicWorkflow({
      block,
      execution,
      loadedPlan,
      observabilityPack,
      transition,
      verificationContract: loadedSupportArtifacts.verificationContract,
    });
    if (verification.status === "blocked") {
      return verification.result;
    }

    const executionProof = await this.captureExecutionProof({
      block,
      eventLog,
      execution,
      loadedPlan,
      planArtifact,
      verification,
    });
    if (executionProof.status === "blocked") {
      return executionProof.result;
    }

    const postExecutionArtifacts = await this.recordPostExecutionArtifacts({
      block,
      executionProof,
      loadedMachine,
      loadedPlan,
      loadedSupportArtifacts,
      planArtifact,
      request,
    });
    if (postExecutionArtifacts.status === "blocked") {
      return postExecutionArtifacts.result;
    }
    const postExecutionArtifactRefs = postExecutionArtifacts.artifactRefs;

    await transition({ type: "RECEIPTS_RECORDED" }, "Run receipts recorded.", {
      ...(execution.capabilityReceipts.length === 0
        ? {}
        : {
            capabilityReceiptRefs: execution.capabilityReceipts
              .map((receipt) => receipt.receiptRef)
              .join(","),
          }),
      ...(verification.resultArtifact === undefined
        ? {}
        : {
            verificationResultRef: verification.resultArtifact.artifactRef,
          }),
      executionProofRef: executionProof.proofArtifact.artifactRef,
      ...(postExecutionArtifactRefs.length === 0
        ? {}
        : { postExecutionArtifactRefs: postExecutionArtifactRefs.join(",") }),
    });

    const reviewSummary = await this.dependencies.reviewGate.summarize({
      capabilityReceipts: execution.capabilityReceipts,
      eventLog,
      ...(execution.reviewSummaryPath === undefined
        ? {}
        : { outputPath: execution.reviewSummaryPath }),
      runId: request.runId,
      stepArtifactRefs: [
        ...execution.artifactRefs,
        ...postExecutionArtifactRefs,
        ...(verification.resultArtifact === undefined
          ? []
          : [verification.resultArtifact.artifactRef]),
      ],
    });
    const capturedArtifactRefs = WorkflowApp.buildCapturedArtifactRefs({
      discordPayload,
      execution,
      executionProofArtifact: executionProof.proofArtifact,
      observabilityPack,
      pinnedDynamicWorkflow,
      pinnedPackages: pinResult.pinnedPackages,
      planArtifact,
      postExecutionArtifactRefs,
      reviewSummaryRef: reviewSummary.artifactRef,
      verification,
    });
    const reviewSurfaceArtifact = await this.publishReviewSurface({
      artifactRefs: capturedArtifactRefs,
      discordPayload,
      eventLog,
      execution,
      executionProofArtifact: executionProof.proofArtifact,
      loadedPlan,
      observabilityPack,
      pinnedDynamicWorkflow,
      pinnedPackages: pinResult.pinnedPackages,
      planArtifact,
      postExecutionArtifactRefs,
      reviewSummaryRef: reviewSummary.artifactRef,
      verification,
    });

    return await this.finalizeRunReceipt({
      block,
      capsule,
      capturedArtifactRefs,
      eventLog,
      execution,
      executionProofArtifact: executionProof.proofArtifact,
      loadedPlan,
      pinnedDynamicWorkflow,
      pinnedPackages: pinResult.pinnedPackages,
      planArtifact,
      request,
      reviewSummaryRef: reviewSummary.artifactRef,
      reviewSurfaceArtifact,
      transition,
      verification,
    });
  }

  /**
   * Runs only the recorders whose declared binding matches the run request's
   * source profile. A run without a source profile, or with a profile no
   * recorder is bound to, runs zero recorders; whether that is acceptable is
   * profile data, enforced fail-closed in recordPostExecutionArtifacts.
   */
  private static selectPostExecutionArtifactRecorders(input: {
    readonly registrations: readonly WorkflowPostExecutionArtifactRecorderRegistration[];
    readonly sourceProfileId: string | undefined;
  }): readonly WorkflowPostExecutionArtifactRecorderRegistration[] {
    const { sourceProfileId } = input;
    if (sourceProfileId === undefined) {
      return [];
    }

    const bindingMatches = (
      binding: WorkflowPostExecutionArtifactRecorderBinding
    ): boolean =>
      binding.kind === "profile-id"
        ? binding.profileId === sourceProfileId
        : binding.matchesProfileId(sourceProfileId);

    return input.registrations.filter((registration) =>
      bindingMatches(registration.binding)
    );
  }

  private async recordPostExecutionArtifacts(input: {
    readonly block: BlockRun;
    readonly executionProof: ExecutionProofCaptured;
    readonly loadedMachine: LoadedDynamicWorkflowMachine;
    readonly loadedPlan: DynamicWorkflowPlanDocument;
    readonly loadedSupportArtifacts: LoadedPinnedPlanSupportArtifacts;
    readonly planArtifact: PlanArtifact;
    readonly request: WorkflowRunRequest;
  }): Promise<PostExecutionArtifactRecordingResult> {
    const artifactRefs: ArtifactRef[] = [];
    const { sourceProfileId } = input.request.planProposal;
    const selectedRecorders = WorkflowApp.selectPostExecutionArtifactRecorders({
      registrations: this.dependencies.postExecutionArtifactRecorders ?? [],
      sourceProfileId,
    });
    const installedSourceProfile =
      sourceProfileId === undefined
        ? undefined
        : (this.dependencies.installedSourceProfiles ?? []).find(
            (profile) => profile.profileId === sourceProfileId
          );
    if (
      installedSourceProfile !== undefined &&
      installedSourceProfile.requiresGeneratedWorkflowProof &&
      selectedRecorders.length === 0
    ) {
      return {
        result: await input.block(
          {
            code: "capability_denied",
            message: `Installed source profile "${installedSourceProfile.profileId}" requires generated workflow proof recording, but no registered post-execution recorder binding matched it.`,
            redacted: true,
          },
          "Proof-required source profile has no matching post-execution recorder."
        ),
        status: "blocked",
      };
    }

    for (const { recorder } of selectedRecorders) {
      const recordResult = await recorder.record({
        executionProofArtifact: input.executionProof.proofArtifact,
        executionProofDocument: input.executionProof.proofDocument,
        harnessArtifact: input.loadedPlan.harness,
        harnessSource: input.loadedSupportArtifacts.harnessSource,
        machine: input.loadedMachine.machine,
        machineArtifact: input.loadedPlan.machine,
        machineSource: input.loadedMachine.machineSource,
        plan: input.loadedPlan,
        planArtifact: input.planArtifact,
      });
      if (recordResult.status === "blocked") {
        return {
          result: await input.block(
            recordResult.blocker,
            "Post-execution artifact recorder blocked capture."
          ),
          status: "blocked",
        };
      }

      artifactRefs.push(...recordResult.artifactRefs);
    }

    return {
      artifactRefs,
      status: "recorded",
    };
  }

  private async captureExecutionProof(input: {
    readonly block: BlockRun;
    readonly eventLog: readonly WorkflowEvent[];
    readonly execution: DynamicExecutionSuccess;
    readonly loadedPlan: DynamicWorkflowPlanDocument;
    readonly planArtifact: PlanArtifact;
    readonly verification: DynamicVerificationSuccess;
  }): Promise<ExecutionProofResult> {
    const proofId = `execution-proof:${input.loadedPlan.runId}`;
    const verificationResultRef =
      input.verification.resultArtifact?.artifactRef;
    const verifierLaneReceiptRef =
      input.verification.verifierLaneReceipt?.receiptRef;
    const baseProof = {
      completedStepIds: input.execution.completedStepIds,
      eventCount: input.eventLog.length,
      eventLogHash: hashJson(input.eventLog),
      generatedAt: new Date().toISOString(),
      generatedStateSequence: input.execution.generatedStateSequence,
      harnessArtifact: input.loadedPlan.harness,
      leaseIds: input.execution.capabilityReceipts.map(
        (receipt) => receipt.leaseId
      ),
      machineArtifact: input.loadedPlan.machine,
      planArtifact: input.planArtifact,
      proofId,
      redacted: true,
      runId: input.loadedPlan.runId,
      schemaVersion: "workflow.execution-proof.v1",
      ...(verificationResultRef === undefined ? {} : { verificationResultRef }),
      ...(verifierLaneReceiptRef === undefined
        ? {}
        : { verifierLaneReceiptRef }),
      workItemId: input.loadedPlan.workItemId,
      workerLaneReceiptRefs: input.execution.workerLaneReceipts.map(
        (receipt) => receipt.receiptRef
      ),
      workflowNodeOutputRefs: input.execution.artifactRefs,
    } as const;
    const runtimeEnvironment =
      this.dependencies.runtimeEnvironment ??
      (this.isIntegrationTestMode()
        ? ({ platform: "local-integration" } as const)
        : null);

    if (runtimeEnvironment?.platform !== "cloudflare-workers") {
      if (!this.isIntegrationTestMode()) {
        const result = await input.block(
          blocker(
            "adapter_unavailable",
            "Production execution proof requires a Cloudflare Workers runtime environment receipt."
          ),
          "Cloudflare execution proof could not be captured."
        );
        return { result, status: "blocked" };
      }

      const document = WorkflowExecutionProofDocumentSchema.parse({
        ...baseProof,
        platform: "local-integration",
        reason:
          "Integration-test run executed the generated machine locally and cannot prove Cloudflare execution.",
        requiredProof: [
          "cloudflare-workers-runtime-environment",
          "cloudflare-run-id-or-event-log",
          "generated-machine-hash",
          "generated-harness-hash",
          "verifier-result-artifact",
          "real-agent-lane-receipts",
          "capability-lease-receipts",
        ],
        status: "not-proven-local-integration",
      });
      const write = await this.dependencies.artifacts.writeJson({
        path: "run/execution-proof.json",
        redacted: true,
        runId: input.loadedPlan.runId,
        value: document,
      });

      return {
        proofArtifact: WorkflowExecutionProofArtifactSchema.parse({
          artifactRef: write.artifactRef,
          hash: write.contentHash,
          mediaType: write.mediaType,
          proofId,
          status: document.status,
        }),
        proofDocument: document,
        status: "captured",
      };
    }

    const missingProof = [
      verificationResultRef === undefined
        ? "verification-result-artifact"
        : null,
      isRealAgentLaneReceipt(input.loadedPlan.plannerLane)
        ? null
        : "real-planner-lane-receipt",
      input.execution.workerLaneReceipts.every(isRealAgentLaneReceipt)
        ? null
        : "real-worker-lane-receipts",
      input.verification.verifierLaneReceipt !== undefined &&
      !isRealAgentLaneReceipt(input.verification.verifierLaneReceipt)
        ? "real-verifier-lane-receipt"
        : null,
      input.eventLog.some(
        (event) =>
          event.state === "recordingReceipts" &&
          event.refs["verificationResultRef"] !== undefined
      )
        ? null
        : "verified-workflow-event",
    ].filter((item): item is string => item !== null);

    if (missingProof.length > 0 || verificationResultRef === undefined) {
      const result = await input.block(
        blocker(
          "capability_denied",
          `Cloudflare execution proof is missing required evidence: ${missingProof.join(", ")}.`
        ),
        "Cloudflare execution proof failed validation."
      );
      return { result, status: "blocked" };
    }

    const document = WorkflowExecutionProofDocumentSchema.parse({
      ...baseProof,
      cloudflare: {
        ...(runtimeEnvironment.deploymentId === undefined
          ? {}
          : { deploymentId: runtimeEnvironment.deploymentId }),
        platform: "cloudflare-workers",
        ...(runtimeEnvironment.workerName === undefined
          ? {}
          : { workerName: runtimeEnvironment.workerName }),
      },
      platform: "cloudflare-workers",
      status: "cloudflare-generated-machine-executed",
      verificationResultRef,
    });
    const write = await this.dependencies.artifacts.writeJson({
      path: "run/execution-proof.json",
      redacted: true,
      runId: input.loadedPlan.runId,
      value: document,
    });

    return {
      proofArtifact: WorkflowExecutionProofArtifactSchema.parse({
        artifactRef: write.artifactRef,
        hash: write.contentHash,
        mediaType: write.mediaType,
        proofId,
        status: document.status,
      }),
      proofDocument: document,
      status: "captured",
    };
  }

  private async finalizeRunReceipt(input: {
    readonly block: BlockRun;
    readonly capsule: ContextCapsuleRecord;
    readonly capturedArtifactRefs: readonly ArtifactRef[];
    readonly eventLog: readonly WorkflowEvent[];
    readonly execution: DynamicExecutionSuccess;
    readonly executionProofArtifact: WorkflowExecutionProofArtifact;
    readonly loadedPlan: DynamicWorkflowPlanDocument;
    readonly pinnedDynamicWorkflow: PinnedDynamicWorkflow;
    readonly pinnedPackages: readonly PinnedPackage[];
    readonly planArtifact: PlanArtifact;
    readonly request: WorkflowRunRequest;
    readonly reviewSummaryRef: ArtifactRef;
    readonly reviewSurfaceArtifact: ReviewSurfaceArtifact;
    readonly transition: SafetyEnvelopeTransition;
    readonly verification: DynamicVerificationSuccess;
  }): Promise<WorkflowRunResult> {
    const reviewSurfaceDelivery = await this.deliverReviewSurface({
      block: input.block,
      loadedPlan: input.loadedPlan,
      request: input.request,
      reviewSurfaceArtifact: input.reviewSurfaceArtifact,
      transition: input.transition,
    });
    if (reviewSurfaceDelivery.status === "blocked") {
      return reviewSurfaceDelivery.result;
    }
    const finalArtifactRefs = [
      ...input.capturedArtifactRefs,
      input.reviewSurfaceArtifact.artifactRef,
      ...reviewSurfaceDelivery.artifactRefs,
    ];
    const finalCapabilityReceipts = [
      ...input.execution.capabilityReceipts,
      ...reviewSurfaceDelivery.capabilityReceipts,
    ];
    await input.transition(
      { type: "REVIEW_SUMMARIZED" },
      "Review summary, final review surface, and review-surface delivery receipts captured.",
      {
        ...(reviewSurfaceDelivery.capabilityReceipts.length === 0
          ? {}
          : {
              reviewSurfaceDeliveryReceiptRefs:
                reviewSurfaceDelivery.capabilityReceipts
                  .map((receipt) => receipt.receiptRef)
                  .join(","),
            }),
        reviewSummaryRef: input.reviewSummaryRef,
        reviewSurfaceRef: input.reviewSurfaceArtifact.artifactRef,
      }
    );

    return WorkflowRunReceiptSchema.parse({
      artifactRefs: finalArtifactRefs,
      capabilityReceipts: finalCapabilityReceipts,
      capsule: {
        ...input.capsule,
        pinnedPackageRefs: input.pinnedPackages.map(
          (packageRef) => packageRef.artifactRef
        ),
      },
      eventLog: input.eventLog,
      executionProofArtifact: input.executionProofArtifact,
      harnessArtifact: input.pinnedDynamicWorkflow.harnessArtifact,
      machineArtifact: input.pinnedDynamicWorkflow.machineArtifact,
      planArtifact: input.planArtifact,
      plannerLaneReceipt: input.pinnedDynamicWorkflow.plannerLaneReceipt,
      reviewSummaryRef: input.reviewSummaryRef,
      reviewSurfaceArtifact: input.reviewSurfaceArtifact,
      runId: input.request.runId,
      status: "captured",
      verificationContractArtifact:
        input.pinnedDynamicWorkflow.verificationContractArtifact,
      ...(input.verification.resultArtifact === undefined
        ? {}
        : { verificationResultArtifact: input.verification.resultArtifact }),
      ...(input.verification.verifierLaneReceipt === undefined
        ? {}
        : { verifierLaneReceipt: input.verification.verifierLaneReceipt }),
      workerLaneReceipts: input.execution.workerLaneReceipts,
    });
  }

  private static buildCapturedArtifactRefs(
    input: CapturedArtifactRefsInput
  ): ArtifactRef[] {
    return [
      ...input.pinnedPackages.map((packageRef) => packageRef.artifactRef),
      ...(input.discordPayload === null
        ? []
        : [
            input.discordPayload.payloadRef,
            ...(input.discordPayload.approvalRef === null
              ? []
              : [input.discordPayload.approvalRef]),
          ]),
      input.pinnedDynamicWorkflow.plannerLaneReceipt.prompt.artifactRef,
      input.pinnedDynamicWorkflow.plannerLaneReceipt.transcript.artifactRef,
      input.pinnedDynamicWorkflow.plannerLaneReceipt.receiptRef,
      ...(input.pinnedDynamicWorkflow.plannerLaneReceipt.packageMounts ===
      undefined
        ? []
        : [
            input.pinnedDynamicWorkflow.plannerLaneReceipt.packageMounts
              .artifactRef,
          ]),
      input.pinnedDynamicWorkflow.machineArtifact.artifactRef,
      input.pinnedDynamicWorkflow.machineArtifact.sourceArtifactRef,
      input.pinnedDynamicWorkflow.harnessArtifact.artifactRef,
      input.pinnedDynamicWorkflow.verificationContractArtifact.artifactRef,
      input.executionProofArtifact.artifactRef,
      input.planArtifact.artifactRef,
      ...input.postExecutionArtifactRefs,
      input.observabilityPack.artifact.artifactRef,
      ...input.observabilityPack.document.telemetrySinks.flatMap((receipt) =>
        receipt.artifactRef === undefined ? [] : [receipt.artifactRef]
      ),
      ...input.execution.artifactRefs,
      ...input.execution.workerLaneReceipts.flatMap((receipt) => [
        receipt.prompt.artifactRef,
        receipt.transcript.artifactRef,
        receipt.receiptRef,
        ...(receipt.packageMounts === undefined
          ? []
          : [receipt.packageMounts.artifactRef]),
      ]),
      ...(input.verification.verifierLaneReceipt === undefined
        ? []
        : [
            input.verification.verifierLaneReceipt.prompt.artifactRef,
            input.verification.verifierLaneReceipt.transcript.artifactRef,
            input.verification.verifierLaneReceipt.receiptRef,
            ...(input.verification.verifierLaneReceipt.packageMounts ===
            undefined
              ? []
              : [
                  input.verification.verifierLaneReceipt.packageMounts
                    .artifactRef,
                ]),
          ]),
      ...(input.verification.resultArtifact === undefined
        ? []
        : [input.verification.resultArtifact.artifactRef]),
      ...input.execution.capabilityReceipts.map(
        (receipt) => receipt.receiptRef
      ),
      input.reviewSummaryRef,
    ];
  }

  private publishReviewSurface(
    input: PublishReviewSurfaceInput
  ): Promise<ReviewSurfaceArtifact> {
    return this.dependencies.reviewSurfacePublisher.publish({
      artifactRefs: input.artifactRefs,
      capabilityReceipts: input.execution.capabilityReceipts,
      eventLog: input.eventLog,
      executionProofArtifact: input.executionProofArtifact,
      outputTarget: input.loadedPlan.outputTarget,
      plan: input.loadedPlan,
      planArtifact: input.planArtifact,
      plannerLaneReceipt: input.pinnedDynamicWorkflow.plannerLaneReceipt,
      reviewSummaryRef: input.reviewSummaryRef,
      ...(input.verification.resultArtifact === undefined
        ? {}
        : { verificationResultArtifact: input.verification.resultArtifact }),
      ...(input.verification.verifierLaneReceipt === undefined
        ? {}
        : { verifierLaneReceipt: input.verification.verifierLaneReceipt }),
      workerLaneReceipts: input.execution.workerLaneReceipts,
    });
  }

  private async deliverReviewSurface(input: {
    readonly block: BlockRun;
    readonly loadedPlan: DynamicWorkflowPlanDocument;
    readonly request: WorkflowRunRequest;
    readonly reviewSurfaceArtifact: ReviewSurfaceArtifact;
    readonly transition: SafetyEnvelopeTransition;
  }): Promise<ReviewSurfaceDeliveryResult> {
    if (input.loadedPlan.outputTarget.kind === "wzrrd") {
      return await this.deliverWzrrdReviewSurface(input);
    }

    if (input.loadedPlan.outputTarget.kind === "github-pr") {
      return await this.deliverGitHubReviewSurface(input);
    }

    if (input.loadedPlan.outputTarget.kind === "linear") {
      return await this.deliverLinearReviewSurface(input);
    }

    return {
      artifactRefs: [],
      capabilityReceipts: [],
      status: "delivered",
    };
  }

  private async deliverLinearReviewSurface(input: {
    readonly block: BlockRun;
    readonly loadedPlan: DynamicWorkflowPlanDocument;
    readonly request: WorkflowRunRequest;
    readonly reviewSurfaceArtifact: ReviewSurfaceArtifact;
    readonly transition: SafetyEnvelopeTransition;
  }): Promise<ReviewSurfaceDeliveryResult> {
    if (input.loadedPlan.outputTarget.kind !== "linear") {
      return {
        artifactRefs: [],
        capabilityReceipts: [],
        status: "delivered",
      };
    }

    if (this.dependencies.linearComments === undefined) {
      const result = await input.block(
        blocker(
          "adapter_unavailable",
          "Linear review-surface delivery requires a configured Linear comment adapter."
        ),
        "Linear review-surface delivery adapter is not configured."
      );
      return { result, status: "blocked" };
    }

    const { issueRef } = input.loadedPlan.outputTarget;
    const secretRefs = this.dependencies.linearSecretRefs ?? {
      createComment: "secretref:linear-api",
      dryRun: "secretref:linear-dry-run",
    };
    const dryRun = !hasApprovedLinearRealDelivery(input.request);
    const body = [
      `# Review surface for ${input.request.runId}`,
      "",
      "This Linear comment delivery was requested by the generated workflow output target and executed through a capability lease.",
      "",
      `Run: ${input.request.runId}`,
      `Work item: ${input.request.workItemId}`,
      `Review surface artifact: ${input.reviewSurfaceArtifact.artifactRef}`,
      `Review surface hash: ${input.reviewSurfaceArtifact.hash}`,
    ].join("\n");
    const payload: LinearCommentPayload = LinearCommentPayloadSchema.parse({
      body,
      bodyHash: sha256Hex(body),
      issueRef,
      redacted: true,
      reviewSurface: {
        artifactRef: input.reviewSurfaceArtifact.artifactRef,
        hash: input.reviewSurfaceArtifact.hash,
        kind: input.reviewSurfaceArtifact.kind,
        surfaceId: input.reviewSurfaceArtifact.surfaceId,
      },
      runId: input.request.runId,
      schemaVersion: "linear.comment-payload.v1",
      workItemId: input.request.workItemId,
    });
    const payloadHash = hashJson(payload);
    const payloadWrite = await this.dependencies.artifacts.writeJson({
      path: "payloads/linear-comment.json",
      redacted: true,
      runId: input.request.runId,
      value: payload,
    });
    const approvalWrite = dryRun
      ? null
      : await this.dependencies.artifacts.writeJson({
          path: "review/linear-comment-approval.json",
          redacted: true,
          runId: input.request.runId,
          value: LinearCommentApprovalSchema.parse({
            actorId: input.request.actor.id,
            approvedAt: new Date().toISOString(),
            dryRun: false,
            payloadHash,
            payloadRef: payloadWrite.artifactRef,
            redacted: true,
            runId: input.request.runId,
            schemaVersion: "workflow.linear-comment-approval.v1",
            summary:
              "Actor role linear.comment.create approved Linear review-surface comment creation for this run.",
            workItemId: input.request.workItemId,
          }),
        });
    const reviewGate: ReviewGate =
      approvalWrite === null
        ? {
            mode: "dry-run-exempt",
            reason:
              "Dry-run Linear comment delivery still leases the capability but does not create a comment.",
          }
        : {
            approvalRef: approvalWrite.artifactRef,
            mode: "approved",
            reviewerActorId: input.request.actor.id,
          };
    const secretRef = dryRun ? secretRefs.dryRun : secretRefs.createComment;

    await input.transition(
      { type: "CAPABILITY_LEASE_REQUESTED" },
      "Review surface requested a Linear comment capability lease.",
      {
        capability: "linear.comment.create",
        dryRun: String(dryRun),
        issueRef,
        payloadRef: payloadWrite.artifactRef,
        reviewSurfaceRef: input.reviewSurfaceArtifact.artifactRef,
      }
    );

    const leaseDecision = await this.dependencies.capabilityLeases.requestLease(
      CapabilityLeaseRequestSchema.parse({
        actor: input.request.actor,
        capability: "linear.comment.create",
        dryRun,
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        payloadHash,
        payloadRef: payloadWrite.artifactRef,
        receiptSink: this.dependencies.artifacts.artifactRef({
          path: "receipts/linear-comment-capability.json",
          runId: input.request.runId,
        }),
        resource: {
          issueRef,
          kind: "linear.issue",
        },
        reviewGate,
        runId: input.request.runId,
        secretRef,
        stepId: "review-surface:linear-comment",
        traceContext: workflowTraceContextForCapability({
          capability: "linear.comment.create",
          runId: input.request.runId,
          stepId: "review-surface:linear-comment",
        }),
        workItemId: input.request.workItemId,
      })
    );
    if (leaseDecision.status === "denied") {
      const result = await input.block(
        leaseDecision.blocker,
        "Linear review-surface delivery lease denied."
      );
      return { result, status: "blocked" };
    }

    await input.transition(
      { type: "LEASE_ISSUED" },
      "Linear review-surface delivery lease issued.",
      {
        dryRun: String(leaseDecision.lease.dryRun),
        issueRef,
        leaseId: leaseDecision.lease.leaseId,
      }
    );

    const delivery = await this.dependencies.linearComments.execute({
      lease: leaseDecision.lease,
      payload,
    });
    if (delivery.status === "blocked") {
      const result = await input.block(
        delivery.blocker,
        "Linear review-surface delivery adapter blocked execution."
      );
      return { result, status: "blocked" };
    }

    const capabilityReceipt =
      await this.dependencies.capabilityLeases.recordLinearCommentExecution({
        delivery,
        lease: leaseDecision.lease,
      });
    const parsedReceipt = CapabilityLeaseReceiptSchema.parse(capabilityReceipt);
    await input.transition(
      { type: "CAPABILITY_EXECUTED" },
      "Linear review-surface delivery capability executed through adapter.",
      {
        deliveryStatus: delivery.status,
        issueRef,
        receiptRef: parsedReceipt.receiptRef,
        ...(delivery.status === "commented"
          ? { commentUrl: delivery.commentUrl }
          : {}),
      }
    );

    return {
      artifactRefs: [
        payloadWrite.artifactRef,
        ...(approvalWrite === null ? [] : [approvalWrite.artifactRef]),
        parsedReceipt.receiptRef,
      ],
      capabilityReceipts: [parsedReceipt],
      status: "delivered",
    };
  }

  private async resolveWzrrdPrimaryDocument(input: {
    readonly block: BlockRun;
    readonly loadedPlan: DynamicWorkflowPlanDocument;
    readonly request: WorkflowRunRequest;
  }): Promise<WzrrdPrimaryDocumentResult> {
    if (
      input.loadedPlan.outputTarget.kind !== "wzrrd" ||
      input.loadedPlan.outputTarget.primaryDocument === undefined
    ) {
      return { status: "ready" };
    }

    const { primaryDocument } = input.loadedPlan.outputTarget;
    const artifactRef = this.dependencies.artifacts.artifactRef({
      path: primaryDocument.artifactPath,
      runId: input.request.runId,
    });

    try {
      const content = await this.dependencies.artifacts.readText({
        artifactRef,
      });

      return {
        primaryDocument: {
          artifactRef,
          hash: sha256Hex(content),
          mediaType: primaryDocument.mediaType,
          path: primaryDocument.publishPath,
          ...(primaryDocument.template === undefined
            ? {}
            : { template: primaryDocument.template }),
          title: primaryDocument.title,
        },
        status: "ready",
      };
    } catch {
      return {
        result: await input.block(
          blocker(
            "stale_package",
            "Wzrrd primary document artifact could not be loaded before publication."
          ),
          "Wzrrd primary document resolution failed."
        ),
        status: "blocked",
      };
    }
  }

  private async deliverWzrrdReviewSurface(input: {
    readonly block: BlockRun;
    readonly loadedPlan: DynamicWorkflowPlanDocument;
    readonly request: WorkflowRunRequest;
    readonly reviewSurfaceArtifact: ReviewSurfaceArtifact;
    readonly transition: SafetyEnvelopeTransition;
  }): Promise<ReviewSurfaceDeliveryResult> {
    if (input.loadedPlan.outputTarget.kind !== "wzrrd") {
      return {
        artifactRefs: [],
        capabilityReceipts: [],
        status: "delivered",
      };
    }

    const primaryDocument = await this.resolveWzrrdPrimaryDocument({
      block: input.block,
      loadedPlan: input.loadedPlan,
      request: input.request,
    });
    if (primaryDocument.status === "blocked") {
      return { result: primaryDocument.result, status: "blocked" };
    }

    const slug = safeArtifactPathSegment(input.request.runId).toLowerCase();
    const payload: WzrrdPublishPayload = WzrrdPublishPayloadSchema.parse({
      ...(primaryDocument.primaryDocument === undefined
        ? {}
        : { primaryDocument: primaryDocument.primaryDocument }),
      redacted: true,
      reviewSurface: {
        artifactRef: input.reviewSurfaceArtifact.artifactRef,
        hash: input.reviewSurfaceArtifact.hash,
        kind: input.reviewSurfaceArtifact.kind,
        surfaceId: input.reviewSurfaceArtifact.surfaceId,
      },
      runId: input.request.runId,
      schemaVersion: "wzrrd.publish-payload.v1",
      slug,
      title: `Review surface for ${input.request.runId}`,
      workItemId: input.request.workItemId,
    });
    const payloadHash = hashJson(payload);
    const payloadWrite = await this.dependencies.artifacts.writeJson({
      path: "payloads/wzrrd-publish.json",
      redacted: true,
      runId: input.request.runId,
      value: payload,
    });
    const publishApproved =
      input.request.actor.roleIds.includes("wzrrd.publish");
    const approvalWrite = publishApproved
      ? await this.dependencies.artifacts.writeJson({
          path: "review/wzrrd-publish-approval.json",
          redacted: true,
          runId: input.request.runId,
          value: WzrrdPublishApprovalSchema.parse({
            actorId: input.request.actor.id,
            approvedAt: new Date().toISOString(),
            dryRun: false,
            payloadHash,
            payloadRef: payloadWrite.artifactRef,
            redacted: true,
            runId: input.request.runId,
            schemaVersion: "workflow.wzrrd-publish-approval.v1",
            summary:
              "Actor role wzrrd.publish approved public Wzrrd review-surface publication for this run.",
            workItemId: input.request.workItemId,
          }),
        })
      : null;
    const dryRun = approvalWrite === null;
    const reviewGate: ReviewGate =
      approvalWrite === null
        ? {
            mode: "dry-run-exempt",
            reason:
              "Dry-run Wzrrd publication still leases the capability but does not publish public content.",
          }
        : {
            approvalRef: approvalWrite.artifactRef,
            mode: "approved",
            reviewerActorId: input.request.actor.id,
          };
    const secretRef =
      approvalWrite === null
        ? this.dependencies.wzrrdSecretRefs.dryRun
        : this.dependencies.wzrrdSecretRefs.publish;

    await input.transition(
      { type: "CAPABILITY_LEASE_REQUESTED" },
      "Review surface requested a Wzrrd publish capability lease.",
      {
        capability: "wzrrd.site.publish",
        dryRun: String(dryRun),
        payloadRef: payloadWrite.artifactRef,
        reviewSurfaceRef: input.reviewSurfaceArtifact.artifactRef,
        slug,
      }
    );

    const leaseDecision = await this.dependencies.capabilityLeases.requestLease(
      CapabilityLeaseRequestSchema.parse({
        actor: input.request.actor,
        capability: "wzrrd.site.publish",
        dryRun,
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        payloadHash,
        payloadRef: payloadWrite.artifactRef,
        receiptSink: this.dependencies.artifacts.artifactRef({
          path: "receipts/wzrrd-capability.json",
          runId: input.request.runId,
        }),
        resource: {
          kind: "wzrrd.site",
          siteRef: this.dependencies.wzrrdSiteRef,
          slug,
        },
        reviewGate,
        runId: input.request.runId,
        secretRef,
        stepId: "review-surface:wzrrd",
        traceContext: workflowTraceContextForCapability({
          capability: "wzrrd.site.publish",
          runId: input.request.runId,
          stepId: "review-surface:wzrrd",
        }),
        workItemId: input.request.workItemId,
      })
    );
    if (leaseDecision.status === "denied") {
      const result = await input.block(
        leaseDecision.blocker,
        "Wzrrd review-surface delivery lease denied."
      );
      return { result, status: "blocked" };
    }

    await input.transition(
      { type: "LEASE_ISSUED" },
      "Wzrrd review-surface delivery lease issued.",
      {
        dryRun: String(leaseDecision.lease.dryRun),
        leaseId: leaseDecision.lease.leaseId,
        slug,
      }
    );

    const delivery = await this.dependencies.wzrrdPublisher.execute({
      lease: leaseDecision.lease,
      payload,
    });
    if (delivery.status === "blocked") {
      const result = await input.block(
        delivery.blocker,
        "Wzrrd review-surface delivery adapter blocked execution."
      );
      return { result, status: "blocked" };
    }

    const capabilityReceipt =
      await this.dependencies.capabilityLeases.recordWzrrdExecution({
        delivery,
        lease: leaseDecision.lease,
      });
    const parsedReceipt = CapabilityLeaseReceiptSchema.parse(capabilityReceipt);
    await input.transition(
      { type: "CAPABILITY_EXECUTED" },
      "Wzrrd review-surface delivery capability executed through adapter.",
      {
        deliveryStatus: delivery.status,
        receiptRef: parsedReceipt.receiptRef,
        slug,
        ...(delivery.url === undefined ? {} : { url: delivery.url }),
      }
    );

    return {
      artifactRefs: [
        payloadWrite.artifactRef,
        ...(approvalWrite === null ? [] : [approvalWrite.artifactRef]),
        parsedReceipt.receiptRef,
      ],
      capabilityReceipts: [parsedReceipt],
      status: "delivered",
    };
  }

  private async resolveGitHubDeliveryAdapters(input: {
    readonly block: BlockRun;
  }): Promise<GitHubDeliveryAdaptersResult> {
    const { githubBranchCommits, githubPullRequests } = this.dependencies;
    if (githubPullRequests === undefined) {
      const result = await input.block(
        blocker(
          "adapter_unavailable",
          "GitHub pull request delivery requires a configured GitHub adapter."
        ),
        "GitHub review-surface delivery adapter is not configured."
      );
      return { result, status: "blocked" };
    }
    if (githubBranchCommits === undefined) {
      const result = await input.block(
        blocker(
          "adapter_unavailable",
          "GitHub pull request delivery requires a configured GitHub branch commit adapter."
        ),
        "GitHub branch commit adapter is not configured."
      );
      return { result, status: "blocked" };
    }

    return {
      githubBranchCommits,
      githubPullRequests,
      status: "ready",
    };
  }

  private async deliverGitHubReviewBranch(input: {
    readonly baseBranch: string;
    readonly block: BlockRun;
    readonly dryRun: boolean;
    readonly githubBranchCommits: GitHubBranchCommitCapabilityAdapter;
    readonly headBranch: string;
    readonly repositoryRef: string;
    readonly request: WorkflowRunRequest;
    readonly reviewSurfaceArtifact: ReviewSurfaceArtifact;
    readonly secretRefs: {
      readonly createBranchCommit: string;
      readonly dryRun: string;
    };
    readonly transition: SafetyEnvelopeTransition;
  }): Promise<GitHubReviewBranchDeliveryResult> {
    const branchFile = {
      content: [
        `# Review surface for ${input.request.runId}`,
        "",
        "This file was written by the workflow app through a scoped GitHub branch commit capability lease before pull request creation.",
        "",
        `Run: ${input.request.runId}`,
        `Work item: ${input.request.workItemId}`,
        `Review surface artifact: ${input.reviewSurfaceArtifact.artifactRef}`,
        `Review surface hash: ${input.reviewSurfaceArtifact.hash}`,
      ].join("\n"),
      mediaType: "text/markdown",
      path: `workflow-reviews/${safeArtifactPathSegment(input.request.runId)}/review-surface.md`,
      redacted: true as const,
    };
    const payload: GitHubBranchCommitPayload =
      GitHubBranchCommitPayloadSchema.parse({
        baseBranch: input.baseBranch,
        commitMessage: `Capture review surface for ${input.request.runId}`,
        files: [
          {
            ...branchFile,
            contentHash: sha256Hex(branchFile.content),
          },
        ],
        headBranch: input.headBranch,
        redacted: true,
        repositoryRef: input.repositoryRef,
        reviewSurface: {
          artifactRef: input.reviewSurfaceArtifact.artifactRef,
          hash: input.reviewSurfaceArtifact.hash,
          kind: input.reviewSurfaceArtifact.kind,
          surfaceId: input.reviewSurfaceArtifact.surfaceId,
        },
        runId: input.request.runId,
        schemaVersion: "github.branch-commit-payload.v1",
        workItemId: input.request.workItemId,
      });
    const payloadHash = hashJson(payload);
    const payloadWrite = await this.dependencies.artifacts.writeJson({
      path: "payloads/github-branch-commit.json",
      redacted: true,
      runId: input.request.runId,
      value: payload,
    });
    const approvalWrite = input.dryRun
      ? null
      : await this.dependencies.artifacts.writeJson({
          path: "review/github-branch-commit-approval.json",
          redacted: true,
          runId: input.request.runId,
          value: GitHubBranchCommitApprovalSchema.parse({
            actorId: input.request.actor.id,
            approvedAt: new Date().toISOString(),
            dryRun: false,
            payloadHash,
            payloadRef: payloadWrite.artifactRef,
            redacted: true,
            runId: input.request.runId,
            schemaVersion: "workflow.github-branch-commit-approval.v1",
            summary:
              "Actor roles github.branch.commit and github.pr.create approved GitHub branch commit before PR creation for this run.",
            workItemId: input.request.workItemId,
          }),
        });
    const reviewGate: ReviewGate =
      approvalWrite === null
        ? {
            mode: "dry-run-exempt",
            reason:
              "Dry-run GitHub branch commit still leases the capability but does not write a branch.",
          }
        : {
            approvalRef: approvalWrite.artifactRef,
            mode: "approved",
            reviewerActorId: input.request.actor.id,
          };
    const secretRef = input.dryRun
      ? input.secretRefs.dryRun
      : input.secretRefs.createBranchCommit;

    await input.transition(
      { type: "CAPABILITY_LEASE_REQUESTED" },
      "Review surface requested a GitHub branch commit capability lease.",
      {
        baseBranch: input.baseBranch,
        capability: "github.branch.commit",
        dryRun: String(input.dryRun),
        filePath: branchFile.path,
        headBranch: input.headBranch,
        payloadRef: payloadWrite.artifactRef,
        repositoryRef: input.repositoryRef,
        reviewSurfaceRef: input.reviewSurfaceArtifact.artifactRef,
      }
    );

    const leaseDecision = await this.dependencies.capabilityLeases.requestLease(
      CapabilityLeaseRequestSchema.parse({
        actor: input.request.actor,
        capability: "github.branch.commit",
        dryRun: input.dryRun,
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        payloadHash,
        payloadRef: payloadWrite.artifactRef,
        receiptSink: this.dependencies.artifacts.artifactRef({
          path: "receipts/github-branch-commit-capability.json",
          runId: input.request.runId,
        }),
        resource: {
          baseBranch: input.baseBranch,
          headBranch: input.headBranch,
          kind: "github.repository",
          repositoryRef: input.repositoryRef,
        },
        reviewGate,
        runId: input.request.runId,
        secretRef,
        stepId: "review-surface:github-branch",
        traceContext: workflowTraceContextForCapability({
          capability: "github.branch.commit",
          runId: input.request.runId,
          stepId: "review-surface:github-branch",
        }),
        workItemId: input.request.workItemId,
      })
    );
    if (leaseDecision.status === "denied") {
      const result = await input.block(
        leaseDecision.blocker,
        "GitHub branch commit lease denied."
      );
      return { result, status: "blocked" };
    }

    await input.transition(
      { type: "LEASE_ISSUED" },
      "GitHub branch commit lease issued.",
      {
        dryRun: String(leaseDecision.lease.dryRun),
        headBranch: input.headBranch,
        leaseId: leaseDecision.lease.leaseId,
        repositoryRef: input.repositoryRef,
      }
    );

    const delivery = await input.githubBranchCommits.execute({
      lease: leaseDecision.lease,
      payload,
    });
    if (delivery.status === "blocked") {
      const result = await input.block(
        delivery.blocker,
        "GitHub branch commit adapter blocked execution."
      );
      return { result, status: "blocked" };
    }

    const capabilityReceipt =
      await this.dependencies.capabilityLeases.recordGitHubBranchCommitExecution(
        {
          delivery,
          lease: leaseDecision.lease,
        }
      );
    const parsedReceipt = CapabilityLeaseReceiptSchema.parse(capabilityReceipt);
    await input.transition(
      { type: "CAPABILITY_EXECUTED" },
      "GitHub branch commit capability executed through adapter.",
      {
        deliveryStatus: delivery.status,
        headBranch: input.headBranch,
        receiptRef: parsedReceipt.receiptRef,
        repositoryRef: input.repositoryRef,
        ...(delivery.status === "committed"
          ? { commitSha: delivery.commitSha }
          : {}),
      }
    );

    return {
      artifactRefs: [
        payloadWrite.artifactRef,
        ...(approvalWrite === null ? [] : [approvalWrite.artifactRef]),
        parsedReceipt.receiptRef,
      ],
      branchFilePath: branchFile.path,
      capabilityReceipt: parsedReceipt,
      delivery,
      status: "delivered",
    };
  }

  private async deliverGitHubReviewSurface(input: {
    readonly block: BlockRun;
    readonly loadedPlan: DynamicWorkflowPlanDocument;
    readonly request: WorkflowRunRequest;
    readonly reviewSurfaceArtifact: ReviewSurfaceArtifact;
    readonly transition: SafetyEnvelopeTransition;
  }): Promise<ReviewSurfaceDeliveryResult> {
    if (input.loadedPlan.outputTarget.kind !== "github-pr") {
      return {
        artifactRefs: [],
        capabilityReceipts: [],
        status: "delivered",
      };
    }

    const adapters = await this.resolveGitHubDeliveryAdapters({
      block: input.block,
    });
    if (adapters.status === "blocked") {
      return adapters;
    }

    const { baseBranch } = input.loadedPlan.outputTarget;
    const headBranch = input.loadedPlan.outputTarget.branchName;
    const { repositoryRef } = input.loadedPlan.outputTarget;
    const configuredGitHubSecretRefs = this.dependencies.githubSecretRefs;
    const secretRefs = {
      createBranchCommit:
        configuredGitHubSecretRefs?.createBranchCommit ??
        configuredGitHubSecretRefs?.createPullRequest ??
        "secretref:github-branch-commit",
      createPullRequest:
        configuredGitHubSecretRefs?.createPullRequest ?? "secretref:github-pr",
      dryRun: configuredGitHubSecretRefs?.dryRun ?? "secretref:github-dry-run",
    };
    const dryRun = !hasApprovedGitHubRealDelivery(input.request);
    const branchDelivery = await this.deliverGitHubReviewBranch({
      baseBranch,
      block: input.block,
      dryRun,
      githubBranchCommits: adapters.githubBranchCommits,
      headBranch,
      repositoryRef,
      request: input.request,
      reviewSurfaceArtifact: input.reviewSurfaceArtifact,
      secretRefs: {
        createBranchCommit: secretRefs.createBranchCommit,
        dryRun: secretRefs.dryRun,
      },
      transition: input.transition,
    });
    if (branchDelivery.status === "blocked") {
      return branchDelivery;
    }

    const body = [
      `# Review surface for ${input.request.runId}`,
      "",
      "This PR delivery was requested by the generated workflow output target and executed through a capability lease.",
      "",
      `Run: ${input.request.runId}`,
      `Work item: ${input.request.workItemId}`,
      `Review surface artifact: ${input.reviewSurfaceArtifact.artifactRef}`,
      `Review surface hash: ${input.reviewSurfaceArtifact.hash}`,
      `Branch commit delivery: ${branchDelivery.delivery.status}`,
      `Branch commit receipt: ${branchDelivery.capabilityReceipt.receiptRef}`,
      `Branch review file: ${branchDelivery.branchFilePath}`,
      ...(branchDelivery.delivery.status === "committed"
        ? [`Branch commit SHA: ${branchDelivery.delivery.commitSha}`]
        : []),
    ].join("\n");
    const payload: GitHubPullRequestPayload =
      GitHubPullRequestPayloadSchema.parse({
        baseBranch,
        body,
        bodyHash: sha256Hex(body),
        headBranch,
        redacted: true,
        repositoryRef,
        reviewSurface: {
          artifactRef: input.reviewSurfaceArtifact.artifactRef,
          hash: input.reviewSurfaceArtifact.hash,
          kind: input.reviewSurfaceArtifact.kind,
          surfaceId: input.reviewSurfaceArtifact.surfaceId,
        },
        runId: input.request.runId,
        schemaVersion: "github.pull-request-payload.v1",
        title: `Review surface for ${input.request.runId}`,
        workItemId: input.request.workItemId,
      });
    const payloadHash = hashJson(payload);
    const payloadWrite = await this.dependencies.artifacts.writeJson({
      path: "payloads/github-pr.json",
      redacted: true,
      runId: input.request.runId,
      value: payload,
    });
    const approvalWrite = dryRun
      ? null
      : await this.dependencies.artifacts.writeJson({
          path: "review/github-pr-approval.json",
          redacted: true,
          runId: input.request.runId,
          value: GitHubPullRequestApprovalSchema.parse({
            actorId: input.request.actor.id,
            approvedAt: new Date().toISOString(),
            dryRun: false,
            payloadHash,
            payloadRef: payloadWrite.artifactRef,
            redacted: true,
            runId: input.request.runId,
            schemaVersion: "workflow.github-pr-approval.v1",
            summary:
              "Actor roles github.branch.commit and github.pr.create approved GitHub pull request creation for this run.",
            workItemId: input.request.workItemId,
          }),
        });
    const reviewGate: ReviewGate =
      approvalWrite === null
        ? {
            mode: "dry-run-exempt",
            reason:
              "Dry-run GitHub pull request delivery still leases the capability but does not create a pull request.",
          }
        : {
            approvalRef: approvalWrite.artifactRef,
            mode: "approved",
            reviewerActorId: input.request.actor.id,
          };
    const secretRef = dryRun ? secretRefs.dryRun : secretRefs.createPullRequest;

    await input.transition(
      { type: "CAPABILITY_LEASE_REQUESTED" },
      "Review surface requested a GitHub pull request capability lease.",
      {
        baseBranch,
        capability: "github.pull-request.create",
        dryRun: String(dryRun),
        headBranch,
        payloadRef: payloadWrite.artifactRef,
        repositoryRef,
        reviewSurfaceRef: input.reviewSurfaceArtifact.artifactRef,
      }
    );

    const leaseDecision = await this.dependencies.capabilityLeases.requestLease(
      CapabilityLeaseRequestSchema.parse({
        actor: input.request.actor,
        capability: "github.pull-request.create",
        dryRun,
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        payloadHash,
        payloadRef: payloadWrite.artifactRef,
        receiptSink: this.dependencies.artifacts.artifactRef({
          path: "receipts/github-pr-capability.json",
          runId: input.request.runId,
        }),
        resource: {
          baseBranch,
          headBranch,
          kind: "github.repository",
          repositoryRef,
        },
        reviewGate,
        runId: input.request.runId,
        secretRef,
        stepId: "review-surface:github-pr",
        traceContext: workflowTraceContextForCapability({
          capability: "github.pull-request.create",
          runId: input.request.runId,
          stepId: "review-surface:github-pr",
        }),
        workItemId: input.request.workItemId,
      })
    );
    if (leaseDecision.status === "denied") {
      const result = await input.block(
        leaseDecision.blocker,
        "GitHub review-surface delivery lease denied."
      );
      return { result, status: "blocked" };
    }

    await input.transition(
      { type: "LEASE_ISSUED" },
      "GitHub review-surface delivery lease issued.",
      {
        dryRun: String(leaseDecision.lease.dryRun),
        headBranch,
        leaseId: leaseDecision.lease.leaseId,
        repositoryRef,
      }
    );

    const delivery = await adapters.githubPullRequests.execute({
      lease: leaseDecision.lease,
      payload,
    });
    if (delivery.status === "blocked") {
      const result = await input.block(
        delivery.blocker,
        "GitHub review-surface delivery adapter blocked execution."
      );
      return { result, status: "blocked" };
    }

    const capabilityReceipt =
      await this.dependencies.capabilityLeases.recordGitHubPullRequestExecution(
        {
          delivery,
          lease: leaseDecision.lease,
        }
      );
    const parsedReceipt = CapabilityLeaseReceiptSchema.parse(capabilityReceipt);
    await input.transition(
      { type: "CAPABILITY_EXECUTED" },
      "GitHub review-surface delivery capability executed through adapter.",
      {
        deliveryStatus: delivery.status,
        receiptRef: parsedReceipt.receiptRef,
        repositoryRef,
        ...githubPullRequestUrlEventMetadata(delivery),
      }
    );

    return {
      artifactRefs: [
        ...branchDelivery.artifactRefs,
        payloadWrite.artifactRef,
        ...(approvalWrite === null ? [] : [approvalWrite.artifactRef]),
        parsedReceipt.receiptRef,
      ],
      capabilityReceipts: [branchDelivery.capabilityReceipt, parsedReceipt],
      status: "delivered",
    };
  }

  /**
   * Load and validate everything the pinned plan needs before the first node
   * runs: the generated machine, the support artifacts (harness +
   * verification contract), and — fail-fast (conformance: validate) — every
   * `workflow.node.invoke` step's `config`. Returning one blocked/ready result
   * keeps `run` to a single guard instead of three. On any failure the run
   * blocks with the precise blocker (and, for a node-config miss, the offending
   * stepId/nodeType so GET status surfaces which node + field failed).
   */
  private async preparePinnedPlanExecution(input: {
    readonly loadedPlan: DynamicWorkflowPlanDocument;
  }): Promise<PinnedPlanExecutionPreparation> {
    const loadedMachine = await this.loadPinnedDynamicWorkflowMachine({
      loadedPlan: input.loadedPlan,
    });
    if (loadedMachine.status === "blocked") {
      return {
        blocker: loadedMachine.blocker,
        status: "blocked",
        summary: "Pinned generated workflow machine failed validation.",
      };
    }

    const supportArtifacts = await this.loadPinnedPlanSupportArtifacts({
      loadedPlan: input.loadedPlan,
    });
    if (supportArtifacts.status === "blocked") {
      return {
        blocker: supportArtifacts.blocker,
        status: "blocked",
        summary:
          "Pinned generated harness or verification contract failed validation.",
      };
    }

    const nodeConfigBlock = this.validatePinnedPlanNodeConfigs(
      input.loadedPlan
    );
    if (nodeConfigBlock !== null) {
      return {
        blocker: nodeConfigBlock.blocker,
        status: "blocked",
        stepContext: nodeConfigBlock.stepContext,
        summary:
          "Pinned plan node config failed fail-fast validation before execution.",
      };
    }

    return { machine: loadedMachine, status: "ready", supportArtifacts };
  }

  /**
   * Fail-fast plan-config validation (conformance: validate). Ask the
   * workflow-node adapter to validate every `workflow.node.invoke` step's
   * `config` against the same registry schema the adapter parses against at
   * execution — so this runs AFTER the leash and a repairable config passes;
   * only a genuinely unrepairable one fails. Returns the first failing step's
   * blocker plus its stepId/nodeType (so the terminal blocker is legible), or
   * `null` when every config conforms / no validator is configured — the
   * executor still enforces config at dispatch.
   */
  private validatePinnedPlanNodeConfigs(
    loadedPlan: DynamicWorkflowPlanDocument
  ): {
    readonly blocker: CapabilityBlocker;
    readonly stepContext: TerminalBlockerStepContext;
  } | null {
    const { workflowNodeAdapter } = this.dependencies;
    if (workflowNodeAdapter?.validatePlanNodeConfig === undefined) {
      return null;
    }

    for (const step of loadedPlan.steps) {
      if (step.kind !== "workflow.node.invoke") {
        continue;
      }

      const configBlocker = workflowNodeAdapter.validatePlanNodeConfig({
        step,
      });
      if (configBlocker !== null) {
        return {
          blocker: configBlocker,
          stepContext: { nodeType: step.nodeType, stepId: step.stepId },
        };
      }
    }

    return null;
  }

  private async loadPinnedDynamicWorkflowMachine(input: {
    readonly loadedPlan: DynamicWorkflowPlanDocument;
  }): Promise<DynamicWorkflowMachineLoadResult> {
    let machineArtifact: unknown;
    let machineSource: string;
    try {
      machineArtifact = await this.dependencies.artifacts.readJson({
        artifactRef: input.loadedPlan.machine.artifactRef,
      });
      machineSource = await this.dependencies.artifacts.readText({
        artifactRef: input.loadedPlan.machine.sourceArtifactRef,
      });
    } catch {
      return {
        blocker: blocker(
          "stale_package",
          "Pinned generated workflow machine artifact could not be loaded."
        ),
        status: "blocked",
      };
    }

    const parsedMachine =
      DynamicWorkflowMachineDocumentSchema.safeParse(machineArtifact);
    if (!parsedMachine.success) {
      return {
        blocker: blocker(
          "payload_hash_mismatch",
          "Pinned generated workflow machine artifact failed schema validation."
        ),
        status: "blocked",
      };
    }

    if (hashJson(parsedMachine.data) !== input.loadedPlan.machine.hash) {
      return {
        blocker: blocker(
          "payload_hash_mismatch",
          "Pinned generated workflow machine hash changed before execution."
        ),
        status: "blocked",
      };
    }

    if (sha256Hex(machineSource) !== input.loadedPlan.machine.sourceHash) {
      return {
        blocker: blocker(
          "payload_hash_mismatch",
          "Pinned generated workflow machine source hash changed before execution."
        ),
        status: "blocked",
      };
    }

    const validationBlocker = validateGeneratedMachineAgainstPlan(
      input.loadedPlan,
      parsedMachine.data
    );
    if (validationBlocker !== null) {
      return {
        blocker: validationBlocker,
        status: "blocked",
      };
    }

    return {
      machine: parsedMachine.data,
      machineSource,
      status: "loaded",
    };
  }

  private async loadPinnedPlanSupportArtifacts(input: {
    readonly loadedPlan: DynamicWorkflowPlanDocument;
  }): Promise<PinnedPlanSupportArtifactsLoadResult> {
    let harnessSource: string;
    let verificationContract: unknown;
    try {
      harnessSource = await this.dependencies.artifacts.readText({
        artifactRef: input.loadedPlan.harness.artifactRef,
      });
      verificationContract = await this.dependencies.artifacts.readJson({
        artifactRef: input.loadedPlan.verificationContract.artifactRef,
      });
    } catch {
      return {
        blocker: blocker(
          "stale_package",
          "Pinned generated harness or verification contract could not be loaded."
        ),
        status: "blocked",
      };
    }

    if (sha256Hex(harnessSource) !== input.loadedPlan.harness.hash) {
      return {
        blocker: blocker(
          "payload_hash_mismatch",
          "Pinned generated harness hash changed before execution."
        ),
        status: "blocked",
      };
    }

    const parsedContract =
      VerificationContractDocumentSchema.safeParse(verificationContract);
    if (!parsedContract.success) {
      return {
        blocker: blocker(
          "payload_hash_mismatch",
          "Pinned verification contract artifact failed schema validation."
        ),
        status: "blocked",
      };
    }

    if (
      hashJson(parsedContract.data) !==
      input.loadedPlan.verificationContract.hash
    ) {
      return {
        blocker: blocker(
          "payload_hash_mismatch",
          "Pinned verification contract hash changed before execution."
        ),
        status: "blocked",
      };
    }

    const verificationOutputPathBlocker =
      validateVerificationContractOutputPath(
        input.loadedPlan,
        parsedContract.data
      );
    if (verificationOutputPathBlocker !== null) {
      return {
        blocker: verificationOutputPathBlocker,
        status: "blocked",
      };
    }

    return {
      harnessSource,
      status: "loaded",
      verificationContract: parsedContract.data,
    };
  }

  private async pinDynamicWorkflowBlueprint(input: {
    readonly blueprint: DynamicWorkflowBlueprint;
    readonly request: WorkflowRunRequest;
  }): Promise<PinnedDynamicWorkflow> {
    const machine = DynamicWorkflowMachineDocumentSchema.parse(
      input.blueprint.machine
    );
    const harness = GeneratedHarnessDocumentSchema.parse(
      input.blueprint.harness
    );
    const verificationContract = VerificationContractDocumentSchema.parse(
      input.blueprint.verificationContract
    );
    const machineSource = renderGeneratedWorkflowMachineSource(machine);
    const machineWrite = await this.dependencies.artifacts.writeJson({
      path: "workflows/machine.config.json",
      redacted: true,
      runId: input.request.runId,
      value: machine,
    });
    const machineSourceWrite = await this.dependencies.artifacts.writeText({
      mediaType: "text/typescript",
      path: "workflows/machine.ts",
      redacted: true,
      runId: input.request.runId,
      value: machineSource,
    });
    const machineArtifact: DynamicWorkflowMachineArtifact = {
      artifactRef: machineWrite.artifactRef,
      hash: machineWrite.contentHash,
      machineId: machine.machineId,
      sourceArtifactRef: machineSourceWrite.artifactRef,
      sourceHash: machineSourceWrite.contentHash,
    };
    const harnessWrite = await this.dependencies.artifacts.writeText({
      mediaType: "text/typescript",
      path: harness.entrypoint,
      redacted: true,
      runId: input.request.runId,
      value: harness.source,
    });
    const harnessArtifact = GeneratedHarnessArtifactSchema.parse({
      artifactRef: harnessWrite.artifactRef,
      entrypoint: harness.entrypoint,
      harnessId: harness.harnessId,
      hash: harnessWrite.contentHash,
      language: harness.language,
    });
    const verificationContractWrite =
      await this.dependencies.artifacts.writeJson({
        path: "run/verification-contract.json",
        redacted: true,
        runId: input.request.runId,
        value: verificationContract,
      });
    const verificationContractArtifact =
      VerificationContractArtifactSchema.parse({
        artifactRef: verificationContractWrite.artifactRef,
        contractId: verificationContract.contractId,
        hash: verificationContractWrite.contentHash,
        mediaType: "application/json",
      });
    const plannerLaneReceipt = await this.pinAgentLaneEvidenceDraft({
      draft: {
        ...input.blueprint.plannerLane,
        outputRefs: [
          ...input.blueprint.plannerLane.outputRefs,
          machineArtifact.artifactRef,
          machineArtifact.sourceArtifactRef,
          harnessArtifact.artifactRef,
          verificationContractArtifact.artifactRef,
        ],
      },
      receiptPath: "receipts/planner-lane.json",
      runId: input.request.runId,
    });

    return {
      harnessArtifact,
      machineArtifact,
      planDocument: DynamicWorkflowPlanDocumentSchema.parse({
        ...input.blueprint.plan,
        harness: harnessArtifact,
        machine: machineArtifact,
        plannerLane: plannerLaneReceipt,
        verificationContract: verificationContractArtifact,
      }),
      plannerLaneReceipt,
      verificationContractArtifact,
    };
  }

  private async pinAgentLaneEvidenceDraft(input: {
    readonly draft: AgentLaneEvidenceDraft;
    readonly receiptPath: string;
    readonly runId: string;
  }): Promise<AgentLaneReceipt> {
    const promptWrite = await this.dependencies.artifacts.writeText({
      mediaType: input.draft.prompt.mediaType,
      path: input.draft.prompt.path,
      redacted: input.draft.prompt.redacted,
      runId: input.runId,
      value: input.draft.prompt.value,
    });
    const transcriptWrite = await this.dependencies.artifacts.writeText({
      mediaType: input.draft.transcript.mediaType,
      path: input.draft.transcript.path,
      redacted: input.draft.transcript.redacted,
      runId: input.runId,
      value: input.draft.transcript.value,
    });
    const receipt = AgentLaneReceiptSchema.parse({
      ...(input.draft.artifactCommitSha === undefined
        ? {}
        : { artifactCommitSha: input.draft.artifactCommitSha }),
      ...(input.draft.authLease === undefined
        ? {}
        : { authLease: input.draft.authLease }),
      ...(input.draft.completedAt === undefined
        ? {}
        : { completedAt: input.draft.completedAt }),
      kind: input.draft.kind,
      laneId: input.draft.laneId,
      outputPins: input.draft.outputPins,
      outputRefs: input.draft.outputRefs,
      ...(input.draft.packageMounts === undefined
        ? {}
        : { packageMounts: input.draft.packageMounts }),
      prompt: {
        artifactRef: promptWrite.artifactRef,
        hash: promptWrite.contentHash,
        mediaType: promptWrite.mediaType,
      },
      realAgent: input.draft.realAgent,
      receiptRef: this.dependencies.artifacts.artifactRef({
        path: input.receiptPath,
        runId: input.runId,
      }),
      redacted: true,
      runtime: input.draft.runtime,
      ...(input.draft.sandboxAccounting === undefined
        ? {}
        : { sandboxAccounting: input.draft.sandboxAccounting }),
      ...(input.draft.sandboxRef === undefined
        ? {}
        : { sandboxRef: input.draft.sandboxRef }),
      startedAt: input.draft.startedAt,
      status: input.draft.status,
      ...(input.draft.tokenCostAccounting === undefined
        ? {}
        : { tokenCostAccounting: input.draft.tokenCostAccounting }),
      ...(input.draft.traceContext === undefined
        ? {}
        : { traceContext: input.draft.traceContext }),
      transcript: {
        artifactRef: transcriptWrite.artifactRef,
        hash: transcriptWrite.contentHash,
        mediaType: transcriptWrite.mediaType,
      },
    });
    await this.dependencies.artifacts.writeJson({
      path: input.receiptPath,
      redacted: true,
      runId: input.runId,
      value: receipt,
    });

    return receipt;
  }

  private async executeWorkflowNodeStep(input: {
    readonly artifactRefsByStepId: ReadonlyMap<string, ArtifactRef>;
    readonly loadedPlan: DynamicWorkflowPlanDocument;
    readonly machine: DynamicWorkflowMachineDocument;
    readonly request: WorkflowRunRequest;
    readonly step: WorkflowNodeInvocationStep;
  }): Promise<
    | {
        readonly outputRefs: readonly ArtifactRef[];
        readonly status: "executed";
      }
    | WorkflowNodeStepExecutionBlocked
  > {
    const { workflowNodeAdapter } = this.dependencies;
    if (workflowNodeAdapter === undefined) {
      return {
        blocker: blocker(
          "adapter_unavailable",
          "Workflow node adapter is not configured."
        ),
        status: "blocked",
      };
    }

    const dependencyArtifactRefs = Object.fromEntries(
      input.step.dependsOn.flatMap((dependencyStepId) => {
        const artifactRef = input.artifactRefsByStepId.get(dependencyStepId);

        return artifactRef === undefined
          ? []
          : [[dependencyStepId, artifactRef] as const];
      })
    );

    try {
      return await workflowNodeAdapter.execute({
        actor: input.request.actor,
        dependencyArtifactRefs,
        machine: input.machine,
        plan: input.loadedPlan,
        step: input.step,
      });
    } catch (error) {
      return {
        blocker: blocker(
          "adapter_unavailable",
          `Workflow node adapter failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        ),
        status: "blocked",
      };
    }
  }

  /**
   * Decide whether a run can resume from its latest durable checkpoint (M2.5
   * step 3) using the ADR's two-factor skip check: a completed step is trusted
   * iff its id is in `completedStepIds` AND its output artifact ref resolves in
   * Artifacts (content-addressed, immutable). When every completed step that
   * declares an output passes both factors, the generated-machine actor is
   * rehydrated at the next step's boundary and the in-memory execution state is
   * rebuilt. When any completed step half-fired (in the set but its ref is
   * missing), the checkpoint is not trusted and `null` is returned so the run
   * re-executes from a fresh actor — safe because capability leases are
   * step-scoped idempotent and Artifacts commits are content-addressed no-ops.
   */
  private async resolveResumableGeneratedWorkflowCheckpoint(input: {
    readonly loadedPlan: DynamicWorkflowPlanDocument;
    readonly request: WorkflowRunRequest;
    readonly resumeCheckpoint: RunStepCheckpoint | null;
  }): Promise<null | {
    readonly artifactRefsByStepId: ReadonlyMap<string, ArtifactRef>;
    readonly completedStepIds: readonly string[];
    readonly generatedMachineSnapshot: unknown;
    readonly nextStepIndex: number;
    readonly reviewSummaryPath: string | undefined;
  }> {
    const checkpoint = input.resumeCheckpoint;
    if (checkpoint === null) {
      return null;
    }

    const stepById = new Map(
      input.loadedPlan.steps.map((step) => [step.stepId, step])
    );
    const artifactRefsByStepId = new Map<string, ArtifactRef>();
    let reviewSummaryPath: string | undefined;

    for (const stepId of checkpoint.completedStepIds) {
      const step = stepById.get(stepId);
      if (step === undefined) {
        // The checkpoint references a step the current plan no longer pins; the
        // plan changed under the run, so the checkpoint is not trustable.
        return null;
      }

      if (step.kind === "review.summary") {
        // A `review.summary` step only reserves its output path for the later
        // review gate; it commits no primary output ref during execution, so it
        // is skipped on the completedStepIds factor alone.
        reviewSummaryPath = step.outputPath;
        continue;
      }

      const outputPath = primaryOutputPathForStep(step);
      if (outputPath === undefined) {
        // Steps without a committed output (e.g. the discord capability step)
        // carry no resolvable ref; the completedStepIds factor alone governs
        // their skip, matching today's in-memory accounting.
        continue;
      }

      const expectedRef = this.dependencies.artifacts.artifactRef({
        path: outputPath,
        runId: input.request.runId,
      });
      const resolves = await this.artifactRefResolves(expectedRef);
      if (!resolves) {
        // Second factor failed: this step is in the set but its output ref is
        // missing (half-fired before the crash). Do not trust the checkpoint;
        // re-run the whole generated workflow from a fresh actor.
        return null;
      }
      artifactRefsByStepId.set(stepId, expectedRef);
    }

    return {
      artifactRefsByStepId,
      completedStepIds: [...checkpoint.completedStepIds],
      generatedMachineSnapshot: checkpoint.generatedMachineSnapshot,
      // The persisted checkpoint at index N was written after step N crossed
      // STEP_DONE, so the next checkpoint this run writes is N + 1.
      nextStepIndex: checkpoint.stepIndex + 1,
      reviewSummaryPath,
    };
  }

  /**
   * Two-factor existence probe: does an output artifact ref resolve in the store
   * today? Tries JSON then text (the only two media the workflow writes); a
   * rejection from both means the ref is unresolvable (the step half-fired).
   */
  private async artifactRefResolves(
    artifactRef: ArtifactRef
  ): Promise<boolean> {
    try {
      await this.dependencies.artifacts.readJson({ artifactRef });

      return true;
    } catch {
      try {
        await this.dependencies.artifacts.readText({ artifactRef });

        return true;
      } catch {
        return false;
      }
    }
  }

  // oxlint-disable-next-line complexity -- Generated workflow dispatch is explicit until step handlers move behind the workflow-node registry.
  private async executeDynamicWorkflow(input: {
    readonly block: BlockRun;
    readonly loadedPlan: DynamicWorkflowPlanDocument;
    readonly machine: DynamicWorkflowMachineDocument;
    readonly persistCheckpoint: PersistRunCheckpoint;
    readonly request: WorkflowRunRequest;
    readonly resumeCheckpoint?: RunStepCheckpoint | null;
    readonly transition: SafetyEnvelopeTransition;
  }): Promise<DynamicExecutionResult> {
    const artifactRefs: ArtifactRef[] = [];
    const capabilityReceipts: CapabilityLeaseReceipt[] = [];
    const completedStepIds = new Set<string>();
    const generatedStateSequence: string[] = [];
    const workerLaneReceipts: AgentLaneReceipt[] = [];
    const stepById = new Map(
      input.loadedPlan.steps.map((step) => [step.stepId, step])
    );
    const artifactRefsByStepId = new Map<string, ArtifactRef>();
    const maxTransitions = input.loadedPlan.steps.length + 2;
    let reviewSummaryPath: string | undefined;
    let workflowCompleted = false;
    let checkpointStepIndex = 0;

    // M2.5 step 3 (resume): rehydrate the generated-machine actor from the most
    // recent durable checkpoint that the two-factor skip check trusts, so an
    // evicted/re-invoked run continues from its last good boundary instead of
    // re-walking every step. `null` => no trusted checkpoint, fresh actor.
    const resumeFrom = await this.resolveResumableGeneratedWorkflowCheckpoint({
      loadedPlan: input.loadedPlan,
      request: input.request,
      resumeCheckpoint: input.resumeCheckpoint ?? null,
    });
    const workflowActor =
      resumeFrom === null
        ? createGeneratedWorkflowActor(input.machine)
        : createGeneratedWorkflowActor(input.machine, {
            snapshot: resumeFrom.generatedMachineSnapshot,
          });
    workflowActor.start();
    if (resumeFrom === null) {
      workflowActor.send({ type: "NEXT" });
    } else {
      for (const stepId of resumeFrom.completedStepIds) {
        completedStepIds.add(stepId);
      }
      for (const [stepId, artifactRef] of resumeFrom.artifactRefsByStepId) {
        artifactRefsByStepId.set(stepId, artifactRef);
        artifactRefs.push(artifactRef);
      }
      checkpointStepIndex = resumeFrom.nextStepIndex;
      // A `review.summary` step completed before the crash reserved this path
      // for the review gate; re-derive it from the plan so the resumed run keeps
      // the same terminal review surface.
      reviewSummaryPath = resumeFrom.reviewSummaryPath ?? reviewSummaryPath;
    }

    /**
     * Persist a resumable checkpoint after a generated-machine step lands its
     * STEP_DONE transition (M2.5 step 2). Snapshots the generated-machine actor
     * post-transition, the cumulative completed step ids, and every output
     * artifact ref observed so far. Idempotent by `runId` + `stepIndex`.
     */
    const checkpointAfterStepDone = async (): Promise<void> => {
      await input.persistCheckpoint({
        completedStepIds: [...completedStepIds],
        generatedMachineSnapshot: workflowActor.getPersistedSnapshot(),
        outputArtifactRefs: [...artifactRefsByStepId.values()],
        stepIndex: checkpointStepIndex,
      });
      checkpointStepIndex += 1;
    };

    for (let count = 0; count < maxTransitions; count += 1) {
      const resolvedState = resolveCurrentGeneratedWorkflowState({
        machine: input.machine,
        rawStateValue: workflowActor.getSnapshot().value,
      });
      if (resolvedState.status === "blocked") {
        const result = await input.block(
          resolvedState.blocker,
          resolvedState.summary
        );
        return { result, status: "blocked" };
      }

      generatedStateSequence.push(resolvedState.stateValue);
      if (resolvedState.status === "done") {
        workflowCompleted = true;
        break;
      }

      const resolvedStep = resolveGeneratedWorkflowPlanStep({
        state: resolvedState.state,
        stepById,
      });
      if (resolvedStep.status === "blocked") {
        const result = await input.block(
          resolvedStep.blocker,
          resolvedStep.summary
        );
        return { result, status: "blocked" };
      }

      const { step } = resolvedStep;

      const missingDependencies = step.dependsOn.filter(
        (dependencyStepId) => !completedStepIds.has(dependencyStepId)
      );
      if (missingDependencies.length > 0) {
        workflowActor.send({ type: "STEP_BLOCKED" });
        const result = await input.block(
          blocker(
            "capability_denied",
            `Dynamic workflow step has unmet dependencies: ${missingDependencies.join(", ")}.`
          ),
          "Dynamic workflow step dependency check failed.",
          { stepId: step.stepId }
        );
        return { result, status: "blocked" };
      }

      if (step.kind === "workflow.node.invoke") {
        const nodeResult = await this.executeWorkflowNodeStep({
          artifactRefsByStepId,
          loadedPlan: input.loadedPlan,
          machine: input.machine,
          request: input.request,
          step,
        });
        if (nodeResult.status === "blocked") {
          workflowActor.send({ type: "STEP_BLOCKED" });
          const result = await input.block(
            nodeResult.blocker,
            "Workflow node adapter step failed.",
            { nodeType: step.nodeType, stepId: step.stepId }
          );
          return { result, status: "blocked" };
        }

        artifactRefs.push(...nodeResult.outputRefs);
        const primaryOutputRef = nodeResult.outputRefs.at(0);
        if (primaryOutputRef !== undefined) {
          artifactRefsByStepId.set(step.stepId, primaryOutputRef);
        }
        completedStepIds.add(step.stepId);
        await input.transition(
          { type: "DYNAMIC_STEP_EXECUTED" },
          "Workflow node adapter step executed from the pinned plan.",
          {
            nodeType: step.nodeType,
            outputRefs: nodeResult.outputRefs.join(","),
            stepId: step.stepId,
          }
        );
        workflowActor.send({ type: "STEP_DONE" });
        await checkpointAfterStepDone();
        continue;
      }

      if (step.kind === "research.review") {
        const workerResult = await this.executeResearchReviewStep({
          loadedPlan: input.loadedPlan,
          machine: input.machine,
          request: input.request,
          step,
        });
        if (workerResult.status === "blocked") {
          workflowActor.send({ type: "STEP_BLOCKED" });
          const result = await input.block(
            workerResult.blocker,
            "Dynamic research/review worker lane failed.",
            { stepId: step.stepId }
          );
          return { result, status: "blocked" };
        }

        artifactRefs.push(...workerResult.outputRefs);
        const primaryOutputRef = workerResult.outputRefs.at(0);
        if (primaryOutputRef !== undefined) {
          artifactRefsByStepId.set(step.stepId, primaryOutputRef);
        }
        workerLaneReceipts.push(workerResult.receipt);
        completedStepIds.add(step.stepId);
        await input.transition(
          { type: "DYNAMIC_STEP_EXECUTED" },
          "Dynamic research/review step executed from the pinned plan.",
          {
            outputRefs: workerResult.outputRefs.join(","),
            stepId: step.stepId,
            workerLaneReceiptRef: workerResult.receipt.receiptRef,
          }
        );
        workflowActor.send({ type: "STEP_DONE" });
        await checkpointAfterStepDone();
        continue;
      }

      if (step.kind === "capability.discord.message") {
        await input.transition(
          { type: "CAPABILITY_LEASE_REQUESTED" },
          "Dynamic workflow requested a Discord message capability lease.",
          {
            capability: "discord.message.send",
            stepId: step.stepId,
          }
        );

        const payload = await this.loadDiscordPayload(step);
        if (payload.status === "blocked") {
          workflowActor.send({ type: "STEP_BLOCKED" });
          const result = await input.block(
            payload.blocker,
            "Discord payload artifact failed validation."
          );
          return { result, status: "blocked" };
        }

        const leaseDecision = await this.requestDiscordLease({
          payload: payload.payload,
          request: input.request,
          step,
        });
        if (leaseDecision.status === "denied") {
          workflowActor.send({ type: "STEP_BLOCKED" });
          const result = await input.block(
            leaseDecision.blocker,
            "Discord capability lease denied."
          );
          return { result, status: "blocked" };
        }

        await input.transition(
          { type: "LEASE_ISSUED" },
          "Discord message capability lease issued.",
          { leaseId: leaseDecision.lease.leaseId, stepId: step.stepId }
        );

        const delivery = await this.dependencies.discordMessages.execute({
          lease: leaseDecision.lease,
          payload: payload.payload,
        });
        if (delivery.status === "blocked") {
          workflowActor.send({ type: "STEP_BLOCKED" });
          const result = await input.block(
            delivery.blocker,
            "Discord adapter blocked execution."
          );
          return { result, status: "blocked" };
        }

        const capabilityReceipt =
          await this.dependencies.capabilityLeases.recordDiscordExecution({
            delivery,
            lease: leaseDecision.lease,
          });
        capabilityReceipts.push(
          CapabilityLeaseReceiptSchema.parse(capabilityReceipt)
        );
        if (this.shouldRecordIntegrationTestWorkerReceipts()) {
          workerLaneReceipts.push(
            await this.recordIntegrationTestWorkerLane({
              loadedPlan: input.loadedPlan,
              outputRefs: [capabilityReceipt.receiptRef],
              request: input.request,
              step,
            })
          );
        }
        completedStepIds.add(step.stepId);
        await input.transition(
          { type: "CAPABILITY_EXECUTED" },
          "Discord message capability executed through adapter.",
          { receiptRef: capabilityReceipt.receiptRef, stepId: step.stepId }
        );
        workflowActor.send({ type: "STEP_DONE" });
        await checkpointAfterStepDone();
        continue;
      }

      if (step.kind === "review.summary") {
        reviewSummaryPath = step.outputPath;
        if (this.shouldRecordIntegrationTestWorkerReceipts()) {
          workerLaneReceipts.push(
            await this.recordIntegrationTestWorkerLane({
              loadedPlan: input.loadedPlan,
              outputRefs: [],
              request: input.request,
              step,
            })
          );
        }
        completedStepIds.add(step.stepId);
        await input.transition(
          { type: "DYNAMIC_STEP_EXECUTED" },
          "Dynamic review summary step reserved for the review gate.",
          { outputPath: step.outputPath, stepId: step.stepId }
        );
        workflowActor.send({ type: "STEP_DONE" });
        await checkpointAfterStepDone();
        continue;
      }

      const unsupportedStep = step as { readonly kind: string };
      workflowActor.send({ type: "STEP_BLOCKED" });
      const result = await input.block(
        blocker(
          "adapter_unavailable",
          `Dynamic workflow step kind ${unsupportedStep.kind} is declared but has no executor adapter.`
        ),
        "Dynamic workflow step executor is not configured."
      );
      return { result, status: "blocked" };
    }

    if (!workflowCompleted) {
      const result = await input.block(
        blocker(
          "capability_denied",
          "Generated workflow machine did not reach its done state."
        ),
        "Generated workflow machine exceeded its transition budget."
      );
      return { result, status: "blocked" };
    }

    if (completedStepIds.size !== input.loadedPlan.steps.length) {
      const result = await input.block(
        blocker(
          "capability_denied",
          "Generated workflow machine reached done without executing every planned step."
        ),
        "Generated workflow machine completed without executing the full pinned plan."
      );
      return { result, status: "blocked" };
    }

    await input.transition(
      { type: "DYNAMIC_WORKFLOW_COMPLETED" },
      "Pinned dynamic workflow steps completed.",
      { completedStepCount: String(completedStepIds.size) }
    );

    return {
      artifactRefs,
      capabilityReceipts,
      completedStepIds: [...completedStepIds],
      generatedStateSequence,
      ...(reviewSummaryPath === undefined ? {} : { reviewSummaryPath }),
      status: "executed",
      workerLaneReceipts,
    };
  }

  private async readVerifierEvidenceText(input: {
    readonly artifactCommitSha: string;
    readonly artifactRef: ArtifactRef;
  }): Promise<string> {
    try {
      return await this.dependencies.artifacts.readText({
        artifactCommitSha: input.artifactCommitSha,
        artifactRef: input.artifactRef,
      });
    } catch {
      const value = await this.dependencies.artifacts.readJson({
        artifactCommitSha: input.artifactCommitSha,
        artifactRef: input.artifactRef,
      });

      return JSON.stringify(value, null, 2);
    }
  }

  private async loadVerifierOutputEvidence(input: {
    readonly workerLaneReceipts: readonly AgentLaneReceipt[];
  }): Promise<VerifierOutputEvidenceLoadResult> {
    const outputEvidence: AgentVerifierOutputEvidence[] = [];
    for (const receipt of input.workerLaneReceipts) {
      if (receipt.outputPins.length === 0) {
        continue;
      }

      if (receipt.artifactCommitSha === undefined) {
        return {
          blocker: blocker(
            "stale_package",
            "Worker lane output evidence is missing its pinned Artifacts commit."
          ),
          status: "blocked",
        };
      }

      for (const outputPin of receipt.outputPins) {
        try {
          outputEvidence.push({
            artifactCommitSha: receipt.artifactCommitSha,
            artifactRef: outputPin.artifactRef,
            hash: outputPin.hash,
            mediaType: outputPin.mediaType,
            text: await this.readVerifierEvidenceText({
              artifactCommitSha: receipt.artifactCommitSha,
              artifactRef: outputPin.artifactRef,
            }),
          });
        } catch {
          return {
            blocker: blocker(
              "stale_package",
              "Pinned worker lane output evidence could not be loaded for verification."
            ),
            status: "blocked",
          };
        }
      }
    }

    return { outputEvidence, status: "loaded" };
  }

  private async verifyDynamicWorkflow(input: {
    readonly block: BlockRun;
    readonly execution: DynamicExecutionSuccess;
    readonly loadedPlan: DynamicWorkflowPlanDocument;
    readonly observabilityPack: WorkflowObservabilityPackArtifact;
    readonly transition: SafetyEnvelopeTransition;
    readonly verificationContract: VerificationContractDocument;
  }): Promise<DynamicVerificationResult> {
    if (
      input.verificationContract.verifier.kind === "deterministic" &&
      this.dependencies.deterministicVerifier === undefined
    ) {
      if (this.isIntegrationTestMode()) {
        await input.transition(
          { type: "VERIFICATION_BYPASSED" },
          "Integration-test path bypassed verifier execution; no verification result artifact was captured.",
          { contractId: input.verificationContract.contractId }
        );

        return { status: "bypassed" };
      }

      const result = await input.block(
        blocker(
          "adapter_unavailable",
          "Production deterministic verification requires a deterministic verifier adapter before capture."
        ),
        "Deterministic verifier was required but unavailable."
      );
      return { result, status: "blocked" };
    }

    if (
      input.verificationContract.verifier.kind === "agent-lane" &&
      this.dependencies.agentVerifierLane === undefined
    ) {
      if (!this.isIntegrationTestMode()) {
        const result = await input.block(
          blocker(
            "adapter_unavailable",
            "Production dynamic workflow execution requires a verifier before capture."
          ),
          "Verifier lane was required but unavailable."
        );
        return { result, status: "blocked" };
      }

      await input.transition(
        { type: "VERIFICATION_BYPASSED" },
        "Integration-test path bypassed verifier execution; no verification result artifact was captured.",
        { contractId: input.verificationContract.contractId }
      );

      return { status: "bypassed" };
    }

    const outputEvidence = await this.loadVerifierOutputEvidence({
      workerLaneReceipts: input.execution.workerLaneReceipts,
    });
    if (outputEvidence.status === "blocked") {
      const result = await input.block(
        outputEvidence.blocker,
        "Verifier output evidence failed to load."
      );
      return { result, status: "blocked" };
    }
    const outputEvidenceWithObservability = [
      ...outputEvidence.outputEvidence,
      {
        artifactRef: input.observabilityPack.artifact.artifactRef,
        hash: input.observabilityPack.artifact.contentHash,
        mediaType: input.observabilityPack.artifact.mediaType,
        text: JSON.stringify(input.observabilityPack.document, null, 2),
      },
    ];
    const outputRefs = [
      ...input.execution.artifactRefs,
      input.observabilityPack.artifact.artifactRef,
    ];

    const acceptVerification = async (verification: {
      readonly result: VerificationResultArtifact;
      readonly resultDocument: VerificationResultDocument;
      readonly verifierLaneReceipt?: AgentLaneReceipt;
    }): Promise<DynamicVerificationResult> => {
      const resultArtifact = VerificationResultArtifactSchema.parse(
        verification.result
      );
      const resultDocument = VerificationResultDocumentSchema.parse(
        verification.resultDocument
      );
      if (
        resultDocument.contractId !== input.verificationContract.contractId ||
        resultDocument.runId !== input.loadedPlan.runId
      ) {
        const result = await input.block(
          blocker(
            "payload_hash_mismatch",
            "Verifier result is not bound to the pinned verification contract and run."
          ),
          "Verifier result binding failed."
        );
        return { result, status: "blocked" };
      }

      const blockingFailure = resultDocument.failures.find(
        (failure) => failure.severity === "blocking"
      );
      if (
        resultDocument.status === "blocked" ||
        blockingFailure !== undefined
      ) {
        const result = await input.block(
          blocker(
            "capability_denied",
            blockingFailure?.message ??
              "Verifier blocked capture for the pinned dynamic workflow outputs."
          ),
          "Verifier result blocked capture."
        );
        return { result, status: "blocked" };
      }

      await input.transition(
        { type: "DYNAMIC_WORKFLOW_VERIFIED" },
        verification.verifierLaneReceipt === undefined
          ? "Deterministic verifier accepted the pinned dynamic workflow outputs."
          : "Verifier lane accepted the pinned dynamic workflow outputs.",
        {
          verificationResultRef: resultArtifact.artifactRef,
          ...(verification.verifierLaneReceipt === undefined
            ? {}
            : {
                verifierLaneReceiptRef:
                  verification.verifierLaneReceipt.receiptRef,
              }),
        }
      );

      return {
        resultArtifact,
        resultDocument,
        status: "verified",
        ...(verification.verifierLaneReceipt === undefined
          ? {}
          : { verifierLaneReceipt: verification.verifierLaneReceipt }),
      };
    };

    if (input.verificationContract.verifier.kind === "deterministic") {
      const { deterministicVerifier } = this.dependencies;
      if (deterministicVerifier === undefined) {
        const result = await input.block(
          blocker(
            "adapter_unavailable",
            "Production deterministic verification requires a deterministic verifier adapter before capture."
          ),
          "Deterministic verifier was required but unavailable."
        );
        return { result, status: "blocked" };
      }

      try {
        return await acceptVerification(
          await deterministicVerifier.verify({
            capabilityReceipts: input.execution.capabilityReceipts,
            contract: input.verificationContract,
            outputEvidence: outputEvidenceWithObservability,
            outputRefs,
            plan: input.loadedPlan,
          })
        );
      } catch (error) {
        const result = await input.block(
          blocker(
            "adapter_unavailable",
            `Configured deterministic verifier adapter failed: ${error instanceof Error ? error.message : String(error)}`
          ),
          "Deterministic verifier adapter failed."
        );
        return { result, status: "blocked" };
      }
    }

    const { agentVerifierLane } = this.dependencies;
    if (agentVerifierLane === undefined) {
      const result = await input.block(
        blocker(
          "adapter_unavailable",
          "Production dynamic workflow execution requires a verifier before capture."
        ),
        "Verifier lane was required but unavailable."
      );
      return { result, status: "blocked" };
    }

    try {
      const verification = await agentVerifierLane.verify({
        capabilityReceipts: input.execution.capabilityReceipts,
        contract: input.verificationContract,
        outputEvidence: outputEvidenceWithObservability,
        outputRefs,
        plan: input.loadedPlan,
      });
      const verifierLaneReceipt = AgentLaneReceiptSchema.parse(
        verification.verifierLaneReceipt
      );
      if (
        !verifierLaneReceipt.realAgent ||
        verifierLaneReceipt.runtime === "integration-test"
      ) {
        const result = await input.block(
          blocker(
            "capability_denied",
            "Configured verifier lane returned a non-real agent receipt."
          ),
          "Verifier lane receipt failed the real-agent check."
        );
        return { result, status: "blocked" };
      }

      if (
        verifierLaneReceipt.runtime !==
        input.verificationContract.verifier.runtime
      ) {
        const result = await input.block(
          blocker(
            "capability_denied",
            "Configured verifier lane runtime does not match the pinned verification contract."
          ),
          "Verifier lane runtime failed contract validation."
        );
        return { result, status: "blocked" };
      }

      return await acceptVerification({
        result: verification.result,
        resultDocument: verification.resultDocument,
        verifierLaneReceipt,
      });
    } catch (error) {
      const result = await input.block(
        blocker(
          "adapter_unavailable",
          `Configured verifier lane adapter failed: ${error instanceof Error ? error.message : String(error)}`
        ),
        "Verifier lane adapter failed."
      );
      return { result, status: "blocked" };
    }
  }

  private async executeResearchReviewStep(input: {
    readonly loadedPlan: DynamicWorkflowPlanDocument;
    readonly machine: DynamicWorkflowMachineDocument;
    readonly request: WorkflowRunRequest;
    readonly step: Extract<
      DynamicWorkflowStep,
      { readonly kind: "research.review" }
    >;
  }): Promise<
    | {
        readonly outputRefs: ArtifactRef[];
        readonly receipt: AgentLaneReceipt;
        readonly status: "executed";
      }
    | {
        readonly blocker: CapabilityBlocker;
        readonly status: "blocked";
      }
  > {
    if (this.dependencies.agentWorkerLane !== undefined) {
      try {
        const workerResult = await this.dependencies.agentWorkerLane.runStep({
          machine: input.machine,
          plan: input.loadedPlan,
          step: input.step,
        });
        const receipt = AgentLaneReceiptSchema.parse(workerResult.receipt);
        if (!receipt.realAgent || receipt.runtime === "integration-test") {
          return {
            blocker: blocker(
              "capability_denied",
              "Configured worker lane returned a non-real agent receipt."
            ),
            status: "blocked",
          };
        }

        if (workerResult.outputRefs.length === 0) {
          return {
            blocker: blocker(
              "payload_hash_mismatch",
              "Configured worker lane did not return any output refs."
            ),
            status: "blocked",
          };
        }

        return {
          outputRefs: [...workerResult.outputRefs],
          receipt,
          status: "executed",
        };
      } catch (error) {
        return {
          blocker: blocker(
            "adapter_unavailable",
            `Configured worker lane adapter failed: ${error instanceof Error ? error.message : String(error)}`
          ),
          status: "blocked",
        };
      }
    }

    if (!this.isIntegrationTestMode()) {
      return {
        blocker: blocker(
          "adapter_unavailable",
          "Production research/review steps require a real worker agent lane."
        ),
        status: "blocked",
      };
    }

    const writeReceipt = await this.dependencies.artifacts.writeJson({
      path: input.step.outputPath,
      redacted: true,
      runId: input.request.runId,
      value: {
        intent: input.loadedPlan.proposal.intent,
        packageRefs: input.step.packageRefs,
        planId: input.loadedPlan.planId,
        planner: input.loadedPlan.planner,
        redacted: true,
        result:
          "Dynamic research/review step executed from a pinned stochastic plan.",
        runId: input.request.runId,
        stepId: input.step.stepId,
      },
    });
    const receipt = await this.recordIntegrationTestWorkerLane({
      loadedPlan: input.loadedPlan,
      outputPins: [writeReceipt],
      outputRefs: [writeReceipt.artifactRef],
      request: input.request,
      step: input.step,
    });

    return {
      outputRefs: [writeReceipt.artifactRef],
      receipt,
      status: "executed",
    };
  }

  private recordIntegrationTestWorkerLane(input: {
    readonly loadedPlan: DynamicWorkflowPlanDocument;
    readonly outputPins?: readonly ArtifactWriteReceipt[];
    readonly outputRefs: readonly ArtifactRef[];
    readonly request: WorkflowRunRequest;
    readonly step: DynamicWorkflowStep;
  }): Promise<AgentLaneReceipt> {
    const completedAt = new Date().toISOString();
    const stepPath = safeArtifactPathSegment(input.step.stepId);
    const laneId = `lane:worker:${input.request.runId}:${input.step.stepId}`;

    return this.pinAgentLaneEvidenceDraft({
      draft: {
        completedAt,
        kind: "worker",
        laneId,
        outputPins:
          input.outputPins?.map((pin) => ({
            artifactRef: pin.artifactRef,
            hash: pin.contentHash,
            mediaType: pin.mediaType,
          })) ?? [],
        outputRefs: [...input.outputRefs],
        prompt: {
          mediaType: "text/markdown",
          path: `lanes/${stepPath}/prompt.md`,
          redacted: true,
          value: [
            "# Integration Test Worker Lane",
            "",
            "This is not a real Pi or Think agent lane.",
            "",
            `Run: ${input.request.runId}`,
            `Plan: ${input.loadedPlan.planId}`,
            `Step: ${input.step.stepId}`,
            `Step kind: ${input.step.kind}`,
          ].join("\n"),
        },
        realAgent: false,
        redacted: true,
        runtime: "integration-test",
        startedAt: completedAt,
        status: "completed",
        traceContext: workflowTraceContextForLane({
          laneId,
          runId: input.request.runId,
        }),
        transcript: {
          mediaType: "text/markdown",
          path: `lanes/${stepPath}/transcript.md`,
          redacted: true,
          value: [
            "# Integration Test Worker Transcript",
            "",
            "The application executed this step locally through the integration test adapter.",
            "This receipt exists to prove artifact wiring and to prevent fake success from looking like real agent work.",
            "",
            `Output refs: ${input.outputRefs.join(", ") || "none"}`,
          ].join("\n"),
        },
      },
      receiptPath: `receipts/worker-${stepPath}-lane.json`,
      runId: input.request.runId,
    });
  }

  private async loadDiscordPayload(
    step: Extract<
      DynamicWorkflowStep,
      { readonly kind: "capability.discord.message" }
    >
  ): Promise<
    | {
        readonly payload: DiscordMessagePayload;
        readonly status: "loaded";
      }
    | {
        readonly blocker: CapabilityBlocker;
        readonly status: "blocked";
      }
  > {
    let rawPayload: unknown;
    try {
      rawPayload = await this.dependencies.artifacts.readJson({
        artifactRef: step.payloadRef,
      });
    } catch {
      return {
        blocker: blocker(
          "stale_package",
          "Discord message payload artifact could not be loaded."
        ),
        status: "blocked",
      };
    }

    const payload = DiscordMessagePayloadSchema.safeParse(rawPayload);
    if (
      !payload.success ||
      payload.data.bodyHash !== step.payloadHash ||
      payload.data.channelRef !== step.resource.channelRef ||
      payload.data.serverRef !== step.resource.serverRef
    ) {
      return {
        blocker: blocker(
          "payload_hash_mismatch",
          "Discord message payload does not match the pinned dynamic plan."
        ),
        status: "blocked",
      };
    }

    return { payload: payload.data, status: "loaded" };
  }

  private async pinDiscordPayload(
    request: WorkflowRunRequest
  ): Promise<PinnedDiscordPayload | null> {
    const message = request.planProposal.discordMessage;
    if (message === undefined) {
      return null;
    }

    const dryRun = message.dryRun ?? true;
    const bodyHash = sha256Hex(message.body);
    const payload = DiscordMessagePayloadSchema.parse({
      body: message.body,
      bodyHash,
      channelRef: message.channelRef,
      serverRef: message.serverRef,
    });
    const writeReceipt = await this.dependencies.artifacts.writeJson({
      path: "payloads/discord-message.json",
      redacted: true,
      runId: request.runId,
      value: payload,
    });
    const resource = {
      channelRef: payload.channelRef,
      kind: "discord.channel" as const,
      serverRef: payload.serverRef,
    };
    const roleApproved =
      !dryRun && request.actor.roleIds.includes("discord.send");
    const approvalWrite = roleApproved
      ? await this.dependencies.artifacts.writeJson({
          path: "review/discord-message-approval.json",
          redacted: true,
          runId: request.runId,
          value: DiscordMessageApprovalSchema.parse({
            actorId: request.actor.id,
            approvedAt: new Date().toISOString(),
            dryRun: false,
            payloadHash: bodyHash,
            payloadRef: writeReceipt.artifactRef,
            redacted: true,
            runId: request.runId,
            schemaVersion: "workflow.discord-message-approval.v1",
            summary:
              "Actor role discord.send approved a real Discord message send for this run.",
            workItemId: request.workItemId,
          }),
        })
      : null;

    return {
      approvalRef: approvalWrite?.artifactRef ?? null,
      dryRun,
      payload,
      payloadRef: writeReceipt.artifactRef,
      resource,
      reviewGate: this.buildDiscordReviewGate({
        dryRun,
        runId: request.runId,
        ...(approvalWrite === null
          ? {}
          : {
              approvalRef: approvalWrite.artifactRef,
              reviewerActorId: request.actor.id,
            }),
      }),
      secretRef: dryRun
        ? this.dependencies.discordSecretRefs.dryRun
        : this.dependencies.discordSecretRefs.send,
    };
  }

  private buildDiscordReviewGate(input: {
    readonly approvalRef?: ArtifactRef;
    readonly dryRun: boolean;
    readonly reviewerActorId?: string;
    readonly runId: string;
  }): ReviewGate {
    if (input.dryRun) {
      return {
        mode: "dry-run-exempt",
        reason:
          "Dry-run still leases the capability, but does not require human approval or secret material.",
      };
    }

    if (
      input.approvalRef !== undefined &&
      input.reviewerActorId !== undefined
    ) {
      return {
        approvalRef: input.approvalRef,
        mode: "approved",
        reviewerActorId: input.reviewerActorId,
      };
    }

    return {
      mode: "required",
      reviewRef: this.dependencies.artifacts.artifactRef({
        path: "review/discord-approval-required.json",
        runId: input.runId,
      }),
    };
  }

  private requestDiscordLease(input: {
    readonly payload: DiscordMessagePayload;
    readonly request: WorkflowRunRequest;
    readonly step: Extract<
      DynamicWorkflowStep,
      { readonly kind: "capability.discord.message" }
    >;
  }): Promise<CapabilityLeaseDecision> {
    const request = CapabilityLeaseRequestSchema.parse({
      actor: input.request.actor,
      capability: "discord.message.send",
      dryRun: input.step.dryRun,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      payloadHash: input.payload.bodyHash,
      payloadRef: input.step.payloadRef,
      receiptSink: this.dependencies.artifacts.artifactRef({
        path: "receipts/discord-capability.json",
        runId: input.request.runId,
      }),
      resource: input.step.resource,
      reviewGate: input.step.reviewGate,
      runId: input.request.runId,
      secretRef: input.step.secretRef,
      stepId: input.step.stepId,
      traceContext: workflowTraceContextForCapability({
        capability: "discord.message.send",
        runId: input.request.runId,
        stepId: input.step.stepId,
      }),
      workItemId: input.request.workItemId,
    });

    return this.dependencies.capabilityLeases.requestLease(request);
  }
}

export const assertCapabilityReceipt = (
  receipt: unknown
): CapabilityLeaseReceipt => CapabilityLeaseReceiptSchema.parse(receipt);
