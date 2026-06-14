import { createActor } from "xstate";
import { z } from "zod";

import { hashJson, sha256Hex } from "../domain/hash.ts";
import { resolveKernelSkills } from "../domain/kernel-skills.ts";
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
  WorkflowDriveLedgerPhaseSchema,
  WorkflowDriveLaneDispatchSchema,
  WorkflowDriveLaneStatusReceiptSchema,
  WorkflowExecutionProofArtifactSchema,
  WorkflowExecutionProofDocumentSchema,
  WorkflowEventSchema,
  WorkflowObservabilityPackSchema,
  WorkflowRunBlockedSchema,
  WorkflowRunDriveOptionsSchema,
  WorkflowRunPausedSchema,
  WorkflowRunReceiptSchema,
  WorkflowRunRequestSchema,
  WorkflowDriveLedgerSchema,
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
  WorkflowRunDriveOptions,
  WorkflowRunDriveResult,
  WorkflowRunRequest,
  WorkflowRunResult,
  WorkflowDriveLaneDispatch,
  WorkflowDriveLaneStatusReceipt,
  WorkflowDriveNodeAttempt,
  WorkflowStatusProjection,
  WorkflowTerminalBlocker,
  WorkflowDriveLedgerPhase,
  WorkflowDriveLedgerPhaseId,
  WzrrdPublishPayload,
} from "../domain/schemas.ts";
import { primarySourceFamiliesOf } from "../domain/source-profile.ts";
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
  AgentWorkerStepResult,
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
import {
  AgentLaneIncompleteError,
  PlannerBlueprintContractError,
} from "./ports.ts";
import { DEFAULT_ZOMBIE_NODE_MAX_ATTEMPTS } from "./workflow-drive-constants.ts";

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
  readonly zombieNodeMaxAttempts?: number;
  readonly wzrrdPublisher: WzrrdPublishCapabilityAdapter;
  readonly wzrrdSiteRef: string;
  readonly wzrrdSecretRefs: {
    readonly dryRun: string;
    readonly publish: string;
  };
}

const nodeTypeForAttempt = (
  step: DynamicWorkflowStep
): WorkflowNodeType | undefined =>
  step.kind === "workflow.node.invoke" ? step.nodeType : undefined;

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
  readonly capabilityReceipts: readonly CapabilityLeaseReceipt[];
  readonly completedStepIds: readonly string[];
  readonly executionArtifactRefs: readonly ArtifactRef[];
  readonly generatedMachineSnapshot: unknown;
  readonly generatedStateSequence: readonly string[];
  readonly outputArtifactRefs: readonly ArtifactRef[];
  readonly reviewSummaryPath: string | undefined;
  readonly stepIndex: number;
  readonly workerLaneReceipts: readonly AgentLaneReceipt[];
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

/**
 * Single-step drive paused after executing exactly one dynamic node: its
 * checkpoint is persisted and more dynamic nodes remain (the generated machine is
 * not yet at `done`). `run()` lifts this into a `WorkflowRunPaused` result so the
 * DO can re-arm `alarm(now)` and resume from this checkpoint on the next alarm.
 */
interface DynamicExecutionPaused {
  readonly completedStepIds: string[];
  readonly status: "paused";
  readonly stepIndex: number;
}

type DynamicExecutionResult =
  | DynamicExecutionBlocked
  | DynamicExecutionPaused
  | DynamicExecutionSuccess;

type DynamicNodeAttemptAdmission =
  | {
      readonly status: "accepted";
    }
  | {
      readonly result: WorkflowRunResult;
      readonly status: "blocked";
    };

type AdmitDynamicNodeAttempt = (input: {
  readonly nodeIndex: number;
  readonly step: DynamicWorkflowStep;
}) => Promise<DynamicNodeAttemptAdmission>;

type LoadDriveLaneDispatch = (input: {
  readonly nodeIndex: number;
  readonly stepId: string;
}) => WorkflowDriveLaneDispatch | null;

type RecordDriveLaneDispatch = (
  dispatch: WorkflowDriveLaneDispatch
) => Promise<void>;

type RecordDriveLaneStatus = (
  statusReceipt: WorkflowDriveLaneStatusReceipt
) => Promise<void>;

const driveLaneDispatchKey = (input: {
  readonly nodeIndex: number;
  readonly stepId: string;
}): string => `${input.nodeIndex}:${input.stepId}`;

type WorkflowNodeInvocationStep = Extract<
  DynamicWorkflowStep,
  { readonly kind: "workflow.node.invoke" }
>;

interface WorkflowNodeStepExecutionBlocked {
  readonly blocker: CapabilityBlocker;
  readonly status: "blocked";
}

interface DynamicVerificationSuccess {
  readonly executionReceiptRef?: ArtifactRef;
  readonly resultArtifact?: VerificationResultArtifact;
  readonly resultDocument?: VerificationResultDocument;
  readonly status: "bypassed" | "verified";
  readonly verifierLaneReceipt?: AgentLaneReceipt;
}

interface CompletedExecutionLoadResult {
  readonly execution: DynamicExecutionSuccess;
  readonly executionReceiptEvidence: AgentVerifierOutputEvidence;
  readonly observabilityPack: WorkflowObservabilityPackArtifact;
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
  if (step.kind === "workflow.node.invoke") {
    if (
      step.nodeType === "joelclaw.memory.hitl-report" &&
      step.outputPath.endsWith(".mdsvx")
    ) {
      return `${step.outputPath.slice(0, -".mdsvx".length)}.json`;
    }

    return step.outputPath;
  }

  if (step.kind === "research.review") {
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

const isMissingArtifactReadError = (error: unknown): boolean => {
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error as { readonly code?: unknown };
    if (code === "ENOENT") {
      return true;
    }
  }

  const message = error instanceof Error ? error.message : String(error);
  return /^(Artifact|JSON artifact|Text artifact) not found:/u.test(message);
};

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

  private zombieNodeMaxAttempts(): number {
    return (
      this.dependencies.zombieNodeMaxAttempts ??
      DEFAULT_ZOMBIE_NODE_MAX_ATTEMPTS
    );
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
    readonly driveGeneration?: number;
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
        ...(input.driveGeneration === undefined
          ? {}
          : { driveGeneration: input.driveGeneration }),
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

  private recordContextCapsuleEvent(input: {
    readonly event: WorkflowEvent;
    readonly workItemId: string;
  }): void {
    void (async () => {
      try {
        await this.dependencies.contextCapsules.appendEvent(input);
      } catch (error) {
        console.warn("context capsule event append skipped", {
          error: error instanceof Error ? error.message : String(error),
          state: input.event.state,
          workItemId: input.workItemId,
        });
      }
    })();
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
      // The lane RAN and pinned an output; the output was just not a blueprint.
      // That is a DETERMINISTIC content failure — re-driving the same prompt
      // re-produces the same wrong shape forever. Classifying it as the transient
      // `adapter_unavailable` is what blind-re-drove wound #27 for ~40 minutes.
      // Name it `planner_output_invalid` and carry the present/missing keys the
      // adapter already diagnosed, so the operator status endpoint reads the
      // real cause instead of a guess.
      if (error instanceof PlannerBlueprintContractError) {
        return {
          blocker: blocker("planner_output_invalid", error.message),
          status: "blocked",
          summary: "Planner output failed the blueprint contract.",
        };
      }
      // The lane's step heartbeat proved the agent RAN (`pi-invoke`+) but the
      // lane aborted before committing any usable result — no parseable marker,
      // or an error marker. The agent's run is already burned; re-driving just
      // re-burns it. This is wound #28: that no-result lane failure flattened to
      // `adapter_unavailable` and blind-re-drove. Name it `planner_lane_incomplete`
      // so the status endpoint reads "the agent ran, the lane failed internally"
      // instead of forging a transport outage. (A lane that froze BEFORE
      // `pi-invoke` never produces this error — it stays the retryable
      // `adapter_unavailable` below.)
      if (error instanceof AgentLaneIncompleteError) {
        return {
          blocker: blocker("planner_lane_incomplete", error.message),
          status: "blocked",
          summary: "Planner agent ran but the lane committed no usable result.",
        };
      }
      // Defense-in-depth: any raw Zod parse failure escaping the planner path is
      // likewise a deterministic content miss, not a transport outage.
      if (error instanceof z.ZodError) {
        const issuePaths = [
          ...new Set(
            error.issues
              .map((issue) => issue.path.map(String).join("."))
              .filter((path) => path.length > 0)
          ),
        ].slice(0, 12);
        return {
          blocker: blocker(
            "planner_output_invalid",
            `Planner output failed dynamic workflow validation (deterministic); ` +
              `schema issue paths [${issuePaths.join(", ") || "<none>"}].`
          ),
          status: "blocked",
          summary: "Planner output failed the blueprint contract.",
        };
      }
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

  // Overloaded so the legacy no-options call still narrows over the 2-variant
  // terminal union (captured/blocked); a `single-step` drive may also `paused`.
  run(input: WorkflowRunRequest): Promise<WorkflowRunResult>;
  run(
    input: WorkflowRunRequest,
    options: WorkflowRunDriveOptions
  ): Promise<WorkflowRunDriveResult>;
  // oxlint-disable-next-line complexity -- The safety-envelope orchestration owns all phase boundaries; splitting it would hide the ledger/fencing order.
  async run(
    input: WorkflowRunRequest,
    options?: WorkflowRunDriveOptions
  ): Promise<WorkflowRunDriveResult> {
    const request = WorkflowRunRequestSchema.parse(input);
    const { driveGeneration, driveMode } = WorkflowRunDriveOptionsSchema.parse(
      options ?? {}
    );
    const eventLog: WorkflowEvent[] = [];
    const actor = createActor(dynamicWorkflowSafetyEnvelopeMachine);
    let projectionCapsule: ContextCapsuleRecord | null = null;
    let projectionPlanArtifact: PlanArtifact | null = null;
    let driveLedger =
      driveGeneration === undefined
        ? null
        : await this.dependencies.contextCapsules.loadDriveLedger({
            runId: request.runId,
            workItemId: request.workItemId,
          });
    actor.start();

    const completedPhase = (
      phaseId: WorkflowDriveLedgerPhaseId
    ): WorkflowDriveLedgerPhase | null => {
      const phase = driveLedger?.phases[phaseId];

      return phase === undefined
        ? null
        : WorkflowDriveLedgerPhaseSchema.parse(phase);
    };

    const assertActiveDrive = async (): Promise<void> => {
      if (driveGeneration === undefined) {
        return;
      }

      await this.dependencies.contextCapsules.assertActiveDriveGeneration({
        driveGeneration,
        runId: request.runId,
        workItemId: request.workItemId,
      });
    };

    const recordDrivePhaseCompletion = async (phaseInput: {
      readonly artifactCommitSha: string;
      readonly artifactHash: string;
      readonly artifactRef: ArtifactRef;
      readonly mediaType: string;
      readonly phaseId: WorkflowDriveLedgerPhaseId;
      readonly receiptKind: string;
      readonly refs?: Readonly<Record<string, string>>;
    }): Promise<void> => {
      if (driveGeneration === undefined) {
        return;
      }

      driveLedger =
        await this.dependencies.contextCapsules.recordDrivePhaseCompletion({
          driveGeneration,
          phase: {
            artifactCommitSha: phaseInput.artifactCommitSha,
            artifactHash: phaseInput.artifactHash,
            artifactRef: phaseInput.artifactRef,
            mediaType: phaseInput.mediaType,
            phaseId: phaseInput.phaseId,
            receiptKind: phaseInput.receiptKind,
            refs: phaseInput.refs ?? {},
          },
          runId: request.runId,
          workItemId: request.workItemId,
        });
    };

    const upsertLocalNodeAttempt = (
      attempt: WorkflowDriveNodeAttempt
    ): void => {
      if (driveLedger === null) {
        return;
      }

      driveLedger = WorkflowDriveLedgerSchema.parse({
        ...driveLedger,
        nodeAttempts: {
          ...driveLedger.nodeAttempts,
          [String(attempt.nodeIndex)]: attempt,
        },
        updatedAt: attempt.lastAttemptedAt,
      });
    };

    const loadDriveLaneDispatch: LoadDriveLaneDispatch = (dispatchInput) => {
      if (driveLedger === null) {
        return null;
      }

      const dispatch =
        driveLedger.laneDispatches[driveLaneDispatchKey(dispatchInput)];
      return dispatch === undefined
        ? null
        : WorkflowDriveLaneDispatchSchema.parse(dispatch);
    };

    const recordDriveLaneDispatch: RecordDriveLaneDispatch = async (
      dispatch
    ) => {
      if (driveGeneration === undefined) {
        return;
      }

      driveLedger =
        await this.dependencies.contextCapsules.recordDriveLaneDispatch({
          dispatch,
          driveGeneration,
        });
    };

    const recordDriveLaneStatus: RecordDriveLaneStatus = async (
      statusReceipt
    ) => {
      if (driveGeneration === undefined) {
        return;
      }

      driveLedger =
        await this.dependencies.contextCapsules.recordDriveLaneStatus({
          driveGeneration,
          statusReceipt,
        });
    };

    await assertActiveDrive();
    const capturedPhase = completedPhase("capture-completed");
    if (capturedPhase !== null) {
      return WorkflowRunReceiptSchema.parse(
        await this.dependencies.artifacts.readJson({
          artifactCommitSha: capturedPhase.artifactCommitSha,
          artifactRef: capturedPhase.artifactRef,
        })
      );
    }

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
      await assertActiveDrive();
      await this.recordStatusProjection({
        capsule: projectionCapsule,
        ...(driveGeneration === undefined ? {} : { driveGeneration }),
        event,
        eventCount: eventLog.length,
        planArtifact: projectionPlanArtifact,
        request,
        ...(terminalBlocker === undefined ? {} : { terminalBlocker }),
      });
      this.recordContextCapsuleEvent({
        event,
        workItemId: request.workItemId,
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

    const admitDynamicNodeAttempt: AdmitDynamicNodeAttempt = async ({
      nodeIndex,
      step,
    }) => {
      if (driveGeneration === undefined) {
        return { status: "accepted" };
      }

      const maxAttempts = this.zombieNodeMaxAttempts();
      const currentAttemptCount =
        driveLedger?.nodeAttempts[String(nodeIndex)]?.attemptCount ?? 0;
      const nodeType = nodeTypeForAttempt(step);
      if (currentAttemptCount >= maxAttempts) {
        const message = `dynamic node ${nodeIndex} exceeded single-invocation budget after ${maxAttempts} drive attempts`;
        const result = await block(
          blocker("capability_denied", message),
          "Dynamic workflow node exceeded its single-invocation budget.",
          {
            ...(nodeType === undefined ? {} : { nodeType }),
            stepId: step.stepId,
          }
        );

        return { result, status: "blocked" };
      }

      upsertLocalNodeAttempt(
        await this.dependencies.contextCapsules.recordDriveNodeAttempt({
          driveGeneration,
          nodeIndex,
          ...(nodeType === undefined ? {} : { nodeType }),
          runId: request.runId,
          stepId: step.stepId,
          workItemId: request.workItemId,
        })
      );

      return { status: "accepted" };
    };

    const persistCheckpoint: PersistRunCheckpoint = async (checkpointInput) => {
      const checkpoint = RunStepCheckpointSchema.parse({
        capabilityReceipts: [...checkpointInput.capabilityReceipts],
        completedStepIds: [...checkpointInput.completedStepIds],
        envelopeSnapshot: actor.getPersistedSnapshot(),
        executionArtifactRefs: [...checkpointInput.executionArtifactRefs],
        generatedMachineSnapshot: checkpointInput.generatedMachineSnapshot,
        generatedStateSequence: [...checkpointInput.generatedStateSequence],
        outputArtifactRefs: [...checkpointInput.outputArtifactRefs],
        persistedAt: new Date().toISOString(),
        runId: request.runId,
        schemaVersion: "workflow.run-step-checkpoint.v1",
        stepIndex: checkpointInput.stepIndex,
        workItemId: request.workItemId,
        workerLaneReceipts: [...checkpointInput.workerLaneReceipts],
        ...(checkpointInput.reviewSummaryPath === undefined
          ? {}
          : { reviewSummaryPath: checkpointInput.reviewSummaryPath }),
      });
      await this.dependencies.contextCapsules.persistCheckpoint({
        checkpoint,
        ...(driveGeneration === undefined ? {} : { driveGeneration }),
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

    // Pinned on every drive (idempotent artifact write; no planner involvement),
    // so the captured-artifact + review-surface steps downstream see the same
    // notification payload whether this is the first drive or a re-drive.
    const discordPayload = await this.pinDiscordPayload(request);

    // Idempotent across re-drives: re-planning is skipped when `run/plan.json`
    // already exists (see resolvePinnedDynamicWorkflow).
    const resolvedPlan = await this.resolvePinnedDynamicWorkflow({
      discordPayload,
      ledgerDriven: driveGeneration !== undefined,
      packageMetadata,
      pinnedPackages: pinResult.pinnedPackages,
      planLedgerPhase: completedPhase("plan-pinned"),
      recordPhaseCompletion: recordDrivePhaseCompletion,
      request,
    });
    if (resolvedPlan.status === "blocked") {
      return await block(resolvedPlan.blocker, resolvedPlan.summary);
    }
    const { loadedPlan, pinnedDynamicWorkflow, planArtifact } = resolvedPlan;

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
    projectionPlanArtifact = planArtifact;
    await transition({ type: "PLAN_PINNED" }, "Dynamic plan artifact pinned.", {
      planHash: planArtifact.hash,
      planRef: planArtifact.artifactRef,
    });

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

    const executionPhase = completedPhase("execution-completed");
    const completedExecution =
      executionPhase === null
        ? null
        : await this.loadCompletedExecutionFromLedger({
            ledgerPhase: executionPhase,
            loadedPlan,
            request,
          });
    let execution: DynamicExecutionSuccess;
    let observabilityPack: WorkflowObservabilityPackArtifact;
    let executionReceiptEvidence: AgentVerifierOutputEvidence;
    if (completedExecution === null) {
      const executionResult = await this.driveDynamicWorkflow({
        admitDynamicNodeAttempt,
        block,
        driveMode,
        loadDriveLaneDispatch,
        loadedPlan,
        machine: loadedMachine.machine,
        persistCheckpoint,
        recordDriveLaneDispatch,
        recordDriveLaneStatus,
        request,
        resumeCheckpoint,
        transition,
      });
      // Non-success drive short-circuits the finishing envelope: `blocked`
      // returns its terminal result; `paused` surfaces the non-terminal result
      // the DO re-drives on. The envelope runs only after the last node executes
      // and the machine reaches `done`.
      if (executionResult.status !== "executed") {
        return WorkflowApp.nonExecutedDriveResult(
          request,
          eventLog,
          executionResult
        );
      }
      execution = executionResult;

      observabilityPack =
        await this.dependencies.observabilityRecorder.capturePack({
          capabilityReceipts: execution.capabilityReceipts,
          eventLog,
          executionArtifactRefs: execution.artifactRefs,
          plan: loadedPlan,
          planArtifact,
          plannerLaneReceipt: pinnedDynamicWorkflow.plannerLaneReceipt,
          workerLaneReceipts: execution.workerLaneReceipts,
        });
      executionReceiptEvidence =
        await this.captureGeneratedWorkflowExecutionReceipt({
          execution,
          loadedPlan,
          machine: loadedMachine.machine,
          planArtifact,
        });
      if (
        observabilityPack.artifact.artifactCommitSha === undefined ||
        executionReceiptEvidence.artifactCommitSha === undefined
      ) {
        return await block(
          blocker(
            "receipt_persistence_failed",
            "Execution phase artifacts did not return Artifacts commit shas for the drive ledger."
          ),
          "Execution phase commit shas could not be recorded."
        );
      }
      await recordDrivePhaseCompletion({
        artifactCommitSha: observabilityPack.artifact.artifactCommitSha,
        artifactHash: observabilityPack.artifact.contentHash,
        artifactRef: observabilityPack.artifact.artifactRef,
        mediaType: observabilityPack.artifact.mediaType,
        phaseId: "execution-completed",
        receiptKind: "workflow.observability-pack.v1",
        refs: {
          executionReceiptCommitSha: executionReceiptEvidence.artifactCommitSha,
          executionReceiptHash: executionReceiptEvidence.hash,
          executionReceiptMediaType: executionReceiptEvidence.mediaType,
          executionReceiptRef: executionReceiptEvidence.artifactRef,
        },
      });
    } else {
      ({ execution } = completedExecution);
      ({ observabilityPack } = completedExecution);
      ({ executionReceiptEvidence } = completedExecution);
    }

    const verificationPhase = completedPhase("verification-completed");
    const verification = await this.verifyDynamicWorkflow({
      block,
      execution,
      executionReceiptEvidence,
      ledgerDriven: driveGeneration !== undefined,
      loadedPlan,
      machine: loadedMachine.machine,
      observabilityPack,
      planArtifact,
      transition,
      verificationContract: loadedSupportArtifacts.verificationContract,
      verificationLedgerPhase: verificationPhase,
    });
    if (verification.status === "blocked") {
      return verification.result;
    }
    if (
      verification.status === "verified" &&
      verificationPhase === null &&
      driveGeneration !== undefined
    ) {
      if (verification.resultArtifact?.artifactCommitSha === undefined) {
        return await block(
          blocker(
            "receipt_persistence_failed",
            "Verification result did not return an Artifacts commit sha for the drive ledger."
          ),
          "Verification phase commit sha could not be recorded."
        );
      }
      await recordDrivePhaseCompletion({
        artifactCommitSha: verification.resultArtifact.artifactCommitSha,
        artifactHash: verification.resultArtifact.hash,
        artifactRef: verification.resultArtifact.artifactRef,
        mediaType: verification.resultArtifact.mediaType,
        phaseId: "verification-completed",
        receiptKind: "workflow.verification-result.v1",
      });
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
        ...(verification.executionReceiptRef === undefined
          ? []
          : [verification.executionReceiptRef]),
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

    const finalResult = await this.finalizeRunReceipt({
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
    if (finalResult.status === "captured") {
      const finalReceiptWrite = await this.dependencies.artifacts.writeJson({
        path: "run/final-receipt.json",
        redacted: true,
        runId: request.runId,
        value: finalResult,
      });
      if (finalReceiptWrite.artifactCommitSha === undefined) {
        return await block(
          blocker(
            "receipt_persistence_failed",
            "Final run receipt did not return an Artifacts commit sha for the drive ledger."
          ),
          "Capture phase commit sha could not be recorded."
        );
      }
      await recordDrivePhaseCompletion({
        artifactCommitSha: finalReceiptWrite.artifactCommitSha,
        artifactHash: finalReceiptWrite.contentHash,
        artifactRef: finalReceiptWrite.artifactRef,
        mediaType: finalReceiptWrite.mediaType,
        phaseId: "capture-completed",
        receiptKind: "workflow.run-receipt.v1",
      });
    }

    return finalResult;
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
    const runtimeEnvironment = this.workflowRuntimeEnvironment();

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
      ...(input.verification.executionReceiptRef === undefined
        ? []
        : [input.verification.executionReceiptRef]),
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

  /**
   * Resolve the pinned dynamic workflow for a drive, reconstructing it from a
   * prior `run/plan.json` when one exists and only invoking the one-shot planner
   * lane on the first drive.
   *
   * The CARRIER fix: {@link run} re-creates the outer safety envelope fresh on
   * every drive and has no terminal short-circuit, so a re-drive (DO alarm
   * re-fire, or single-step pause-and-rearm) re-enters from the top. Routing the
   * planner phase through {@link loadExistingPinnedPlan} makes it idempotent — a
   * re-drive rebuilds the {@link PinnedDynamicWorkflow} from the embedded
   * artifacts in the pinned plan (machine, harness, verification contract,
   * planner-lane receipt all live inside `planDocument`) instead of re-running
   * the ~213s planner, which previously tripped the lane's `already-completed`
   * admission guard and surfaced as a spurious `adapter_unavailable` block.
   */
  private async resolvePinnedDynamicWorkflow(input: {
    readonly discordPayload: PinnedDiscordPayload | null;
    readonly ledgerDriven: boolean;
    readonly packageMetadata: readonly PackageMetadata[];
    readonly planLedgerPhase: WorkflowDriveLedgerPhase | null;
    readonly pinnedPackages: readonly PinnedPackage[];
    readonly recordPhaseCompletion: (input: {
      readonly artifactCommitSha: string;
      readonly artifactHash: string;
      readonly artifactRef: ArtifactRef;
      readonly mediaType: string;
      readonly phaseId: WorkflowDriveLedgerPhaseId;
      readonly receiptKind: string;
      readonly refs?: Readonly<Record<string, string>>;
    }) => Promise<void>;
    readonly request: WorkflowRunRequest;
  }): Promise<
    | {
        readonly blocker: CapabilityBlocker;
        readonly status: "blocked";
        readonly summary: string;
      }
    | {
        readonly loadedPlan: DynamicWorkflowPlanDocument;
        readonly pinnedDynamicWorkflow: PinnedDynamicWorkflow;
        readonly planArtifact: PlanArtifact;
        readonly status: "resolved";
      }
  > {
    let existingPinnedPlan: {
      readonly planArtifact: PlanArtifact;
      readonly planDocument: DynamicWorkflowPlanDocument;
    } | null = null;
    if (input.planLedgerPhase !== null) {
      existingPinnedPlan = await this.loadExistingPinnedPlan(
        input.request.runId,
        input.planLedgerPhase.artifactCommitSha
      );
    } else if (!input.ledgerDriven) {
      existingPinnedPlan = await this.loadExistingPinnedPlan(
        input.request.runId
      );
    }
    if (existingPinnedPlan !== null) {
      const { planArtifact, planDocument: loadedPlan } = existingPinnedPlan;
      return {
        loadedPlan,
        pinnedDynamicWorkflow: {
          harnessArtifact: loadedPlan.harness,
          machineArtifact: loadedPlan.machine,
          planDocument: loadedPlan,
          plannerLaneReceipt: loadedPlan.plannerLane,
          verificationContractArtifact: loadedPlan.verificationContract,
        },
        planArtifact,
        status: "resolved",
      };
    }

    const planning = await this.proposeDynamicWorkflowBlueprint({
      discordPayload: input.discordPayload,
      packageMetadata: input.packageMetadata,
      pinnedPackages: input.pinnedPackages,
      request: input.request,
    });
    if (planning.status === "blocked") {
      return {
        blocker: planning.blocker,
        status: "blocked",
        summary: planning.summary,
      };
    }
    const { blueprint } = planning;
    if (
      !this.isIntegrationTestMode() &&
      (!blueprint.plannerLane.realAgent ||
        blueprint.plannerLane.runtime === "integration-test")
    ) {
      return {
        blocker: blocker(
          "adapter_unavailable",
          "Production workflow planning requires a real planner agent lane."
        ),
        status: "blocked",
        summary: "Planner lane was not a real agent execution.",
      };
    }

    const pinnedDynamicWorkflow = await this.pinDynamicWorkflowBlueprint({
      blueprint,
      request: input.request,
    });
    const { planDocument } = pinnedDynamicWorkflow;
    const planWrite = await this.dependencies.artifacts.writeJson({
      path: "run/plan.json",
      redacted: true,
      runId: input.request.runId,
      value: planDocument,
    });
    if (planWrite.artifactCommitSha === undefined) {
      return {
        blocker: blocker(
          "receipt_persistence_failed",
          "Pinned plan write did not return an Artifacts commit sha for the drive ledger."
        ),
        status: "blocked",
        summary: "Pinned dynamic plan commit could not be recorded.",
      };
    }
    const planArtifact = PlanArtifactSchema.parse({
      artifactRef: planWrite.artifactRef,
      hash: planWrite.contentHash,
      pinnedAt: planDocument.createdAt,
      runId: input.request.runId,
    });
    await input.recordPhaseCompletion({
      artifactCommitSha: planWrite.artifactCommitSha,
      artifactHash: planWrite.contentHash,
      artifactRef: planWrite.artifactRef,
      mediaType: planWrite.mediaType,
      phaseId: "plan-pinned",
      receiptKind: "workflow.dynamic-plan.v1",
    });
    const loadedPlan = DynamicWorkflowPlanDocumentSchema.parse(
      await this.dependencies.artifacts.readJson({
        artifactRef: planArtifact.artifactRef,
      })
    );
    if (hashJson(loadedPlan) !== planArtifact.hash) {
      return {
        blocker: blocker(
          "payload_hash_mismatch",
          "Pinned plan hash changed before execution."
        ),
        status: "blocked",
        summary: "Pinned dynamic plan hash check failed.",
      };
    }

    return {
      loadedPlan,
      pinnedDynamicWorkflow,
      planArtifact,
      status: "resolved",
    };
  }

  /**
   * Recover a previously pinned dynamic plan for a run, or `null` when none
   * exists yet. Used by {@link resolvePinnedDynamicWorkflow} to make the planner
   * phase idempotent across re-drives: the first invocation pins `run/plan.json`;
   * any later drive of the same run loads it here instead of re-invoking the
   * one-shot planner lane.
   *
   * A missing artifact resolves to `null` (treated as "no pinned plan") for the
   * first drive. Other read failures must propagate; turning clone/auth/network
   * failures into "no pinned plan" silently replays the one-shot planner lane.
   */
  private async loadExistingPinnedPlan(
    runId: string,
    artifactCommitSha?: string
  ): Promise<{
    readonly planArtifact: PlanArtifact;
    readonly planDocument: DynamicWorkflowPlanDocument;
  } | null> {
    const artifactRef = this.dependencies.artifacts.artifactRef({
      path: "run/plan.json",
      runId,
    });
    let raw: unknown;
    try {
      raw =
        artifactCommitSha === undefined
          ? await this.dependencies.artifacts.readJson({ artifactRef })
          : await this.dependencies.artifacts.readJson({
              artifactCommitSha,
              artifactRef,
            });
    } catch (error) {
      if (
        artifactCommitSha !== undefined ||
        !isMissingArtifactReadError(error)
      ) {
        throw error;
      }

      return null;
    }
    const planDocument = DynamicWorkflowPlanDocumentSchema.parse(raw);
    const planArtifact = PlanArtifactSchema.parse({
      artifactRef,
      hash: hashJson(planDocument),
      pinnedAt: planDocument.createdAt,
      runId,
    });
    return { planArtifact, planDocument };
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

    // Deterministic criticality backstop: derive the primary source families
    // from the run's INSTALLED profile, not from planner-provided config. The
    // report node unions these with any config-provided families, so a dead
    // primary source cannot masquerade as a dream even if the stochastic planner
    // omits the field (the "contract, not a caveat" requirement).
    const profileSourceProfileId = input.request.planProposal.sourceProfileId;
    const installedSourceProfile =
      profileSourceProfileId === undefined
        ? undefined
        : (this.dependencies.installedSourceProfiles ?? []).find(
            (profile) => profile.profileId === profileSourceProfileId
          );
    const profilePrimarySourceFamilies =
      installedSourceProfile === undefined
        ? []
        : primarySourceFamiliesOf(installedSourceProfile);

    try {
      return await workflowNodeAdapter.execute({
        actor: input.request.actor,
        completedStepArtifactRefs: Object.fromEntries(
          input.artifactRefsByStepId
        ),
        dependencyArtifactRefs,
        machine: input.machine,
        plan: input.loadedPlan,
        primarySourceFamilies: profilePrimarySourceFamilies,
        // Resolve the run's pinned kernel skills the SAME way the planner prompt
        // does (resolveKernelSkills over the pinned packages), so an agentic
        // analytical node reasons over the same workflow-design / analysis skill
        // content the planner used. The plan carries the pinned packages with
        // full metadata, so no extra store read is needed; a run with no kernel
        // skills resolves to `[]`.
        resolvedKernelSkills: resolveKernelSkills(
          input.loadedPlan.pinnedPackages
        ),
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
    readonly capabilityReceipts: readonly CapabilityLeaseReceipt[];
    readonly completedStepIds: readonly string[];
    readonly executionArtifactRefs: readonly ArtifactRef[];
    readonly generatedMachineSnapshot: unknown;
    readonly generatedStateSequence: readonly string[];
    readonly nextStepIndex: number;
    readonly reviewSummaryPath: string | undefined;
    readonly workerLaneReceipts: readonly AgentLaneReceipt[];
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
      // Restore the cumulative execution accounting so the resumed finishing
      // envelope (verify -> receipts -> summarize -> captured) surfaces the same
      // receipts and artifact set as a whole-run; receipts issued in a prior
      // drive are not re-collected on resume, so they live in the checkpoint.
      capabilityReceipts: [...checkpoint.capabilityReceipts],
      completedStepIds: [...checkpoint.completedStepIds],
      executionArtifactRefs: [...checkpoint.executionArtifactRefs],
      generatedMachineSnapshot: checkpoint.generatedMachineSnapshot,
      generatedStateSequence: [...checkpoint.generatedStateSequence],
      // The persisted checkpoint at index N was written after step N crossed
      // STEP_DONE, so the next checkpoint this run writes is N + 1.
      nextStepIndex: checkpoint.stepIndex + 1,
      // Prefer the path re-derived from the current plan's review.summary step;
      // fall back to the persisted path so a resume before that step still keeps
      // the terminal review surface stable.
      reviewSummaryPath: reviewSummaryPath ?? checkpoint.reviewSummaryPath,
      workerLaneReceipts: [...checkpoint.workerLaneReceipts],
    };
  }

  /**
   * Run the dynamic-node loop honoring the requested drive mode. `single-step`
   * (FIX: one node per alarm) bounds the loop to exactly one not-yet-completed
   * dynamic node and pauses if more remain; `whole-run` leaves the budget
   * unbounded so the legacy single-invocation walk is byte-identical. Kept as a
   * thin wrapper so `run()` neither computes the budget nor conditionally spreads
   * it under `exactOptionalPropertyTypes`.
   */
  private async driveDynamicWorkflow(input: {
    readonly admitDynamicNodeAttempt: AdmitDynamicNodeAttempt;
    readonly block: BlockRun;
    readonly driveMode: WorkflowRunDriveOptions["driveMode"];
    readonly loadedPlan: DynamicWorkflowPlanDocument;
    readonly loadDriveLaneDispatch: LoadDriveLaneDispatch;
    readonly machine: DynamicWorkflowMachineDocument;
    readonly persistCheckpoint: PersistRunCheckpoint;
    readonly recordDriveLaneDispatch: RecordDriveLaneDispatch;
    readonly recordDriveLaneStatus: RecordDriveLaneStatus;
    readonly request: WorkflowRunRequest;
    readonly resumeCheckpoint: RunStepCheckpoint | null;
    readonly transition: SafetyEnvelopeTransition;
  }): Promise<DynamicExecutionResult> {
    return await this.executeDynamicWorkflow({
      admitDynamicNodeAttempt: input.admitDynamicNodeAttempt,
      block: input.block,
      loadDriveLaneDispatch: input.loadDriveLaneDispatch,
      loadedPlan: input.loadedPlan,
      machine: input.machine,
      persistCheckpoint: input.persistCheckpoint,
      recordDriveLaneDispatch: input.recordDriveLaneDispatch,
      recordDriveLaneStatus: input.recordDriveLaneStatus,
      request: input.request,
      resumeCheckpoint: input.resumeCheckpoint,
      ...(input.driveMode === "single-step" ? { stepBudget: 1 } : {}),
      transition: input.transition,
    });
  }

  private async loadCompletedExecutionFromLedger(input: {
    readonly ledgerPhase: WorkflowDriveLedgerPhase;
    readonly loadedPlan: DynamicWorkflowPlanDocument;
    readonly request: WorkflowRunRequest;
  }): Promise<CompletedExecutionLoadResult> {
    const checkpoint =
      await this.dependencies.contextCapsules.loadLatestCheckpoint({
        runId: input.request.runId,
        workItemId: input.request.workItemId,
      });
    if (checkpoint === null) {
      throw new Error(
        `Drive ledger marks execution complete for ${input.request.runId}, but no checkpoint exists.`
      );
    }
    if (checkpoint.completedStepIds.length !== input.loadedPlan.steps.length) {
      throw new Error(
        `Drive ledger marks execution complete for ${input.request.runId}, but checkpoint only completed ${checkpoint.completedStepIds.length} of ${input.loadedPlan.steps.length} steps.`
      );
    }

    const observabilityDocument = WorkflowObservabilityPackSchema.parse(
      await this.dependencies.artifacts.readJson({
        artifactCommitSha: input.ledgerPhase.artifactCommitSha,
        artifactRef: input.ledgerPhase.artifactRef,
      })
    );
    const { executionReceiptRef } = input.ledgerPhase.refs;
    const { executionReceiptCommitSha } = input.ledgerPhase.refs;
    const { executionReceiptHash } = input.ledgerPhase.refs;
    const { executionReceiptMediaType } = input.ledgerPhase.refs;
    if (
      executionReceiptRef === undefined ||
      executionReceiptCommitSha === undefined ||
      executionReceiptHash === undefined ||
      executionReceiptMediaType === undefined
    ) {
      throw new Error(
        `Drive ledger execution phase for ${input.request.runId} is missing execution receipt refs.`
      );
    }

    return {
      execution: {
        artifactRefs: [...checkpoint.executionArtifactRefs],
        capabilityReceipts: [...checkpoint.capabilityReceipts],
        completedStepIds: [...checkpoint.completedStepIds],
        generatedStateSequence: [...checkpoint.generatedStateSequence],
        ...(checkpoint.reviewSummaryPath === undefined
          ? {}
          : { reviewSummaryPath: checkpoint.reviewSummaryPath }),
        status: "executed",
        workerLaneReceipts: [...checkpoint.workerLaneReceipts],
      },
      executionReceiptEvidence: {
        artifactCommitSha: executionReceiptCommitSha,
        artifactRef: executionReceiptRef,
        hash: executionReceiptHash,
        mediaType: executionReceiptMediaType,
        text: await this.readVerifierEvidenceText({
          artifactCommitSha: executionReceiptCommitSha,
          artifactRef: executionReceiptRef,
        }),
      },
      observabilityPack: {
        artifact: {
          artifactCommitSha: input.ledgerPhase.artifactCommitSha,
          artifactRef: input.ledgerPhase.artifactRef,
          contentHash: input.ledgerPhase.artifactHash,
          mediaType: input.ledgerPhase.mediaType,
          redacted: true,
        },
        document: observabilityDocument,
      },
    };
  }

  /**
   * Translate a non-`executed` dynamic-execution result into the run result the
   * caller returns. `blocked` passes its terminal result through; `paused`
   * (single-step, FIX: one node per alarm) is lifted into the non-terminal
   * `WorkflowRunPaused` the DO re-drives on, carrying the just-persisted
   * checkpoint's step index and the cumulative completed step ids.
   */
  private static nonExecutedDriveResult(
    request: WorkflowRunRequest,
    eventLog: readonly WorkflowEvent[],
    execution: DynamicExecutionBlocked | DynamicExecutionPaused
  ): WorkflowRunDriveResult {
    if (execution.status === "blocked") {
      return execution.result;
    }

    return WorkflowRunPausedSchema.parse({
      completedStepIds: execution.completedStepIds,
      eventLog,
      runId: request.runId,
      status: "paused",
      stepIndex: execution.stepIndex,
    });
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

  private async artifactRefsResolve(
    artifactRefs: Iterable<ArtifactRef>
  ): Promise<boolean> {
    for (const artifactRef of artifactRefs) {
      if (!(await this.artifactRefResolves(artifactRef))) {
        return false;
      }
    }

    return true;
  }

  private async cleanupAsyncWorkerLane(input: {
    readonly dispatch: WorkflowDriveLaneDispatch;
    readonly reason: "completed" | "failed" | "timed-out";
    readonly receipt?: AgentLaneReceipt;
  }): Promise<void> {
    try {
      await this.dependencies.agentWorkerLane?.cleanupStep?.(input);
    } catch (error) {
      console.warn("Async worker lane cleanup skipped", {
        error: error instanceof Error ? error.message : String(error),
        laneId: input.dispatch.laneId,
        reason: input.reason,
        runId: input.dispatch.runId,
      });
    }
  }

  // oxlint-disable-next-line complexity -- Async lane dispatch/poll/advance/block is the carrier state machine; keeping it explicit makes the Durable Object behavior auditable.
  private async executeAsyncResearchReviewStep(input: {
    readonly admitDynamicNodeAttempt: AdmitDynamicNodeAttempt;
    readonly block: BlockRun;
    readonly loadedPlan: DynamicWorkflowPlanDocument;
    readonly loadDriveLaneDispatch: LoadDriveLaneDispatch;
    readonly machine: DynamicWorkflowMachineDocument;
    readonly nodeIndex: number;
    readonly recordDriveLaneDispatch: RecordDriveLaneDispatch;
    readonly recordDriveLaneStatus: RecordDriveLaneStatus;
    readonly request: WorkflowRunRequest;
    readonly step: Extract<
      DynamicWorkflowStep,
      { readonly kind: "research.review" }
    >;
  }): Promise<
    | {
        readonly status: "unsupported";
      }
    | {
        readonly completedStepIds: string[];
        readonly status: "paused";
        readonly stepIndex: number;
      }
    | {
        readonly outputRefs: readonly ArtifactRef[];
        readonly receipt: AgentLaneReceipt;
        readonly status: "executed";
      }
    | DynamicExecutionBlocked
  > {
    const { agentWorkerLane } = this.dependencies;
    if (
      agentWorkerLane?.dispatchStep === undefined ||
      agentWorkerLane.pollStep === undefined ||
      agentWorkerLane.readStepReceipt === undefined
    ) {
      return { status: "unsupported" };
    }

    const existingDispatch = input.loadDriveLaneDispatch({
      nodeIndex: input.nodeIndex,
      stepId: input.step.stepId,
    });
    if (existingDispatch === null) {
      const attemptAdmission = await input.admitDynamicNodeAttempt({
        nodeIndex: input.nodeIndex,
        step: input.step,
      });
      if (attemptAdmission.status === "blocked") {
        return { result: attemptAdmission.result, status: "blocked" };
      }

      try {
        const dispatch = WorkflowDriveLaneDispatchSchema.parse(
          await agentWorkerLane.dispatchStep({
            machine: input.machine,
            nodeIndex: input.nodeIndex,
            plan: input.loadedPlan,
            step: input.step,
          })
        );
        await input.recordDriveLaneDispatch(dispatch);

        return {
          completedStepIds: [],
          status: "paused",
          stepIndex: input.nodeIndex,
        };
      } catch (error) {
        const result = await input.block(
          blocker(
            "adapter_unavailable",
            `Async worker lane dispatch failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          ),
          "Async worker lane dispatch failed.",
          { stepId: input.step.stepId }
        );

        return { result, status: "blocked" };
      }
    }

    const dispatch = existingDispatch;
    let recovered: AgentWorkerStepResult | null;
    try {
      recovered = await agentWorkerLane.readStepReceipt({ dispatch });
    } catch (error) {
      const result = await input.block(
        blocker(
          "receipt_persistence_failed",
          `Async worker lane receipt recovery failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        ),
        "Async worker lane receipt recovery failed.",
        { stepId: input.step.stepId }
      );

      return { result, status: "blocked" };
    }

    if (recovered !== null) {
      const receipt = AgentLaneReceiptSchema.parse(recovered.receipt);
      if (receipt.status !== "completed") {
        await this.cleanupAsyncWorkerLane({
          dispatch,
          reason: "failed",
          receipt,
        });
        const result = await input.block(
          blocker(
            "capability_denied",
            `Async worker lane ${dispatch.laneId} ended with receipt status ${receipt.status}.`
          ),
          "Async worker lane returned a terminal failed receipt.",
          { stepId: input.step.stepId }
        );

        return { result, status: "blocked" };
      }

      const outputRefs = [...recovered.outputRefs];
      const refsToResolve = new Set<ArtifactRef>([
        ...dispatch.expectedOutputArtifactRefs,
        ...outputRefs,
      ]);
      if (
        outputRefs.length > 0 &&
        (await this.artifactRefsResolve(refsToResolve))
      ) {
        await this.cleanupAsyncWorkerLane({
          dispatch,
          reason: "completed",
          receipt,
        });

        return {
          outputRefs,
          receipt,
          status: "executed",
        };
      }
    }

    // Compute the deadline BEFORE polling: it must dominate EVERY exit from this
    // poll path, including a `pollStep` that THROWS. pollStep hits a live
    // Cloudflare container (getProcess RPC); an evicted or recycled container can
    // make that call reject — or hand back a payload that fails schema parse —
    // rather than return a status. An unguarded throw here aborted the whole
    // drive before the deadline guard below, so the reaper re-paused this node
    // every alarm FOREVER (observed: a 2h+ zombie on the first research.review
    // node of a live dream run). This is the SAME class as the running-past-
    // deadline wound, reached via a throwing poll instead of a stale `running`
    // status — the deadline, not the poll outcome, is the source of truth for
    // "the lane had its chance."
    const deadlineMs = Date.parse(dispatch.deadline);
    const pastDeadline =
      Number.isFinite(deadlineMs) && Date.now() >= deadlineMs;

    let statusReceipt: WorkflowDriveLaneStatusReceipt;
    try {
      statusReceipt = WorkflowDriveLaneStatusReceiptSchema.parse(
        await agentWorkerLane.pollStep({ dispatch })
      );
    } catch (error) {
      if (pastDeadline) {
        await this.cleanupAsyncWorkerLane({ dispatch, reason: "timed-out" });
        const result = await input.block(
          blocker(
            "capability_denied",
            `Async worker lane ${dispatch.laneId} poll failed past its deadline: ${
              error instanceof Error ? error.message : String(error)
            }`
          ),
          "Async worker lane poll failed and was not recoverable by its deadline.",
          { stepId: input.step.stepId }
        );

        return { result, status: "blocked" };
      }

      // Transient poll failure before the deadline: pause and retry next drive.
      // If the container is permanently gone, the deadline guard above fires on a
      // later drive instead of wedging forever.
      return {
        completedStepIds: [],
        status: "paused",
        stepIndex: input.nodeIndex,
      };
    }
    await input.recordDriveLaneStatus(statusReceipt);

    if (
      statusReceipt.status === "failed" ||
      statusReceipt.status === "killed" ||
      statusReceipt.status === "error"
    ) {
      await this.cleanupAsyncWorkerLane({ dispatch, reason: "failed" });
      const result = await input.block(
        blocker(
          "capability_denied",
          `Async worker lane ${dispatch.laneId} ended with process status ${statusReceipt.status}.`
        ),
        "Async worker lane process ended before a completed receipt was recoverable.",
        { stepId: input.step.stepId }
      );

      return { result, status: "blocked" };
    }
    // Past the dispatch deadline, ANY status reaching this point is a blown
    // lane and MUST be reaped. The recoverable paths already returned above: a
    // `completed` receipt with resolvable outputs returned "executed", and
    // `failed`/`killed`/`error` already blocked. What survives to here —
    // `starting`, `running`, `not_found`, or a `completed` whose outputs never
    // resolved — is a sandbox lane that overran without a usable receipt. A
    // process wedged `starting`/`running` past its deadline (e.g. an evicted or
    // recycled Cloudflare container handing back a stale process handle) used
    // to fall through to `paused` and get re-paused by the reaper every cycle
    // FOREVER (observed: a 4h11m zombie on node 14 of a live dream run). The
    // deadline is the single source of truth for "the lane had its chance."
    if (pastDeadline) {
      await this.cleanupAsyncWorkerLane({
        dispatch,
        reason: "timed-out",
      });
      const result = await input.block(
        blocker(
          "capability_denied",
          `Async worker lane ${dispatch.laneId} did not produce a recoverable receipt before its deadline (last status ${statusReceipt.status}).`
        ),
        "Async worker lane receipt was not recoverable by its deadline.",
        { stepId: input.step.stepId }
      );

      return { result, status: "blocked" };
    }

    return {
      completedStepIds: [],
      status: "paused",
      stepIndex: input.nodeIndex,
    };
  }

  // oxlint-disable-next-line complexity -- Generated workflow dispatch is explicit until step handlers move behind the workflow-node registry.
  private async executeDynamicWorkflow(input: {
    readonly block: BlockRun;
    readonly admitDynamicNodeAttempt: AdmitDynamicNodeAttempt;
    readonly loadedPlan: DynamicWorkflowPlanDocument;
    readonly loadDriveLaneDispatch: LoadDriveLaneDispatch;
    readonly machine: DynamicWorkflowMachineDocument;
    readonly persistCheckpoint: PersistRunCheckpoint;
    readonly recordDriveLaneDispatch: RecordDriveLaneDispatch;
    readonly recordDriveLaneStatus: RecordDriveLaneStatus;
    readonly request: WorkflowRunRequest;
    readonly resumeCheckpoint?: RunStepCheckpoint | null;
    // Single-step drive (FIX: one node per alarm). When set, the loop executes at
    // most this many not-yet-completed dynamic nodes this invocation, then pauses
    // (returns `status: "paused"`) if more remain. `undefined` => whole-run mode,
    // which walks every step plus the finishing envelope in one invocation.
    readonly stepBudget?: number;
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
    // Single-step drive accounting (FIX: one node per alarm). `stepsExecuted`
    // counts dynamic nodes run THIS invocation (resumed steps do not count);
    // `lastCheckpointStepIndex` is the index of the most recently persisted
    // checkpoint, reported back so the DO/tests can assert one-node-per-alarm.
    let stepsExecuted = 0;
    let lastCheckpointStepIndex = -1;

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
      }
      // Restore the full execution accounting from the checkpoint so the finishing
      // envelope captures the same artifact set + receipts as a whole-run. The
      // full artifact ref list (a node may emit several) and the receipts are not
      // re-collected for skipped steps, so they are rehydrated here rather than
      // rederived from `artifactRefsByStepId` (which holds only per-step primaries).
      artifactRefs.push(...resumeFrom.executionArtifactRefs);
      capabilityReceipts.push(...resumeFrom.capabilityReceipts);
      workerLaneReceipts.push(...resumeFrom.workerLaneReceipts);
      generatedStateSequence.push(...resumeFrom.generatedStateSequence);
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
        capabilityReceipts: [...capabilityReceipts],
        completedStepIds: [...completedStepIds],
        executionArtifactRefs: [...artifactRefs],
        generatedMachineSnapshot: workflowActor.getPersistedSnapshot(),
        generatedStateSequence: [...generatedStateSequence],
        outputArtifactRefs: [...artifactRefsByStepId.values()],
        reviewSummaryPath,
        stepIndex: checkpointStepIndex,
        workerLaneReceipts: [...workerLaneReceipts],
      });
      lastCheckpointStepIndex = checkpointStepIndex;
      checkpointStepIndex += 1;
      stepsExecuted += 1;
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

      // Single-step drive (FIX: one node per alarm). We are at a not-yet-done
      // step state; if this invocation already burned its step budget, pause
      // here rather than executing the next node — its checkpoint is durable, so
      // the next alarm resumes from it and advances exactly one more node. The
      // `done` check above means the last node never pauses: after it runs, the
      // next state is `done`, so the finishing envelope runs in the same drive.
      if (
        input.stepBudget !== undefined &&
        stepsExecuted >= input.stepBudget &&
        lastCheckpointStepIndex >= 0
      ) {
        return {
          completedStepIds: [...completedStepIds],
          status: "paused",
          stepIndex: lastCheckpointStepIndex,
        };
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

      if (step.kind === "research.review") {
        const asyncWorkerResult = await this.executeAsyncResearchReviewStep({
          admitDynamicNodeAttempt: input.admitDynamicNodeAttempt,
          block: input.block,
          loadDriveLaneDispatch: input.loadDriveLaneDispatch,
          loadedPlan: input.loadedPlan,
          machine: input.machine,
          nodeIndex: checkpointStepIndex,
          recordDriveLaneDispatch: input.recordDriveLaneDispatch,
          recordDriveLaneStatus: input.recordDriveLaneStatus,
          request: input.request,
          step,
        });
        if (asyncWorkerResult.status === "paused") {
          return {
            completedStepIds: [...completedStepIds],
            status: "paused",
            stepIndex: asyncWorkerResult.stepIndex,
          };
        }
        if (asyncWorkerResult.status === "blocked") {
          return {
            result: asyncWorkerResult.result,
            status: "blocked",
          };
        }
        if (asyncWorkerResult.status === "executed") {
          artifactRefs.push(...asyncWorkerResult.outputRefs);
          const primaryOutputRef = asyncWorkerResult.outputRefs.at(0);
          if (primaryOutputRef !== undefined) {
            artifactRefsByStepId.set(step.stepId, primaryOutputRef);
          }
          workerLaneReceipts.push(asyncWorkerResult.receipt);
          completedStepIds.add(step.stepId);
          await input.transition(
            { type: "DYNAMIC_STEP_EXECUTED" },
            "Dynamic research/review step executed from the pinned plan.",
            {
              outputRefs: asyncWorkerResult.outputRefs.join(","),
              stepId: step.stepId,
              workerLaneReceiptRef: asyncWorkerResult.receipt.receiptRef,
            }
          );
          workflowActor.send({ type: "STEP_DONE" });
          await checkpointAfterStepDone();
          continue;
        }
      }

      const attemptAdmission = await input.admitDynamicNodeAttempt({
        nodeIndex: checkpointStepIndex,
        step,
      });
      if (attemptAdmission.status === "blocked") {
        return { result: attemptAdmission.result, status: "blocked" };
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
    readonly artifactCommitSha?: string;
    readonly artifactRef: ArtifactRef;
  }): Promise<string> {
    const readInput =
      input.artifactCommitSha === undefined
        ? { artifactRef: input.artifactRef }
        : {
            artifactCommitSha: input.artifactCommitSha,
            artifactRef: input.artifactRef,
          };
    try {
      return await this.dependencies.artifacts.readText(readInput);
    } catch {
      const value = await this.dependencies.artifacts.readJson(readInput);

      return JSON.stringify(value, null, 2);
    }
  }

  private async loadArtifactRefVerifierEvidence(input: {
    readonly artifactRefs: readonly ArtifactRef[];
    readonly existingArtifactRefs: ReadonlySet<ArtifactRef>;
  }): Promise<VerifierOutputEvidenceLoadResult> {
    const outputEvidence: AgentVerifierOutputEvidence[] = [];
    for (const artifactRef of input.artifactRefs) {
      if (
        input.existingArtifactRefs.has(artifactRef) ||
        artifactRef.includes("/memory/relay-lease-receipts/") ||
        artifactRef.includes("/run/workflow-node-cartridges/") ||
        artifactRef.endsWith(".mdsvx")
      ) {
        continue;
      }

      try {
        const json = await this.dependencies.artifacts.readJson({
          artifactRef,
        });
        outputEvidence.push({
          artifactRef,
          hash: hashJson(json),
          mediaType: "application/json",
          text: JSON.stringify(json, null, 2),
        });
        continue;
      } catch {
        // Fall through to text evidence; generated workflow nodes can emit MDSvX
        // report artifacts and other text sidecars.
      }

      try {
        const text = await this.dependencies.artifacts.readText({
          artifactRef,
        });
        outputEvidence.push({
          artifactRef,
          hash: sha256Hex(text),
          mediaType: artifactRef.endsWith(".mdsvx")
            ? "text/mdsvx"
            : "text/plain",
          text,
        });
      } catch {
        return {
          blocker: blocker(
            "stale_package",
            "Generated workflow artifact evidence could not be loaded for verification."
          ),
          status: "blocked",
        };
      }
    }

    return { outputEvidence, status: "loaded" };
  }

  private async loadVerifierOutputEvidence(input: {
    readonly artifactRefs: readonly ArtifactRef[];
    readonly workerLaneReceipts: readonly AgentLaneReceipt[];
  }): Promise<VerifierOutputEvidenceLoadResult> {
    const outputEvidence: AgentVerifierOutputEvidence[] = [];
    const evidenceArtifactRefs = new Set<ArtifactRef>();
    for (const receipt of input.workerLaneReceipts) {
      if (receipt.outputPins.length === 0) {
        continue;
      }

      for (const outputPin of receipt.outputPins) {
        try {
          const evidenceText = await this.readVerifierEvidenceText({
            ...(receipt.artifactCommitSha === undefined
              ? {}
              : { artifactCommitSha: receipt.artifactCommitSha }),
            artifactRef: outputPin.artifactRef,
          });
          let evidenceHash = outputPin.hash;
          if (receipt.artifactCommitSha === undefined) {
            evidenceHash = outputPin.mediaType.includes("json")
              ? hashJson(JSON.parse(evidenceText))
              : sha256Hex(evidenceText);
          }
          if (
            receipt.artifactCommitSha === undefined &&
            evidenceHash !== outputPin.hash
          ) {
            return {
              blocker: blocker(
                "payload_hash_mismatch",
                "Worker lane output evidence hash does not match its receipt pin."
              ),
              status: "blocked",
            };
          }

          outputEvidence.push({
            ...(receipt.artifactCommitSha === undefined
              ? {}
              : { artifactCommitSha: receipt.artifactCommitSha }),
            artifactRef: outputPin.artifactRef,
            hash: outputPin.hash,
            mediaType: outputPin.mediaType,
            text: evidenceText,
          });
          evidenceArtifactRefs.add(outputPin.artifactRef);
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

    const artifactEvidence = await this.loadArtifactRefVerifierEvidence({
      artifactRefs: input.artifactRefs,
      existingArtifactRefs: evidenceArtifactRefs,
    });
    if (artifactEvidence.status === "blocked") {
      return artifactEvidence;
    }

    return {
      outputEvidence: [...outputEvidence, ...artifactEvidence.outputEvidence],
      status: "loaded",
    };
  }

  private async loadExistingVerificationResult(input: {
    readonly artifactCommitSha?: string;
    readonly loadedPlan: DynamicWorkflowPlanDocument;
    readonly verificationContract: VerificationContractDocument;
  }): Promise<
    | {
        readonly result: VerificationResultArtifact;
        readonly resultDocument: VerificationResultDocument;
        readonly status: "loaded";
      }
    | { readonly status: "missing" }
  > {
    const artifactRef = this.dependencies.artifacts.artifactRef({
      path: input.verificationContract.outputPath,
      runId: input.loadedPlan.runId,
    });

    try {
      const resultDocument = VerificationResultDocumentSchema.parse(
        input.artifactCommitSha === undefined
          ? await this.dependencies.artifacts.readJson({ artifactRef })
          : await this.dependencies.artifacts.readJson({
              artifactCommitSha: input.artifactCommitSha,
              artifactRef,
            })
      );

      return {
        result: VerificationResultArtifactSchema.parse({
          ...(input.artifactCommitSha === undefined
            ? {}
            : { artifactCommitSha: input.artifactCommitSha }),
          artifactRef,
          hash: hashJson(resultDocument),
          mediaType: "application/json",
          resultId: resultDocument.resultId,
        }),
        resultDocument,
        status: "loaded",
      };
    } catch (error) {
      if (
        input.artifactCommitSha === undefined &&
        isMissingArtifactReadError(error)
      ) {
        return { status: "missing" };
      }

      throw error;
    }
  }

  private workflowRuntimeEnvironment(): WorkflowRuntimeEnvironment | null {
    return (
      this.dependencies.runtimeEnvironment ??
      (this.isIntegrationTestMode()
        ? ({ platform: "local-integration" } as const)
        : null)
    );
  }

  private async captureGeneratedWorkflowExecutionReceipt(input: {
    readonly execution: DynamicExecutionSuccess;
    readonly loadedPlan: DynamicWorkflowPlanDocument;
    readonly machine: DynamicWorkflowMachineDocument;
    readonly planArtifact: PlanArtifact;
  }): Promise<AgentVerifierOutputEvidence> {
    const { execution, loadedPlan, machine, planArtifact } = input;
    const { completedStepIds, generatedStateSequence } = execution;
    const runtimeEnvironment = this.workflowRuntimeEnvironment();
    const planStepIds = loadedPlan.steps.map((step) => step.stepId);
    const missingStepIds = planStepIds.filter(
      (stepId) => !completedStepIds.includes(stepId)
    );
    const stepTransitions = loadedPlan.steps.map((step, index) => ({
      completionEvent: "STEP_DONE",
      fromState:
        generatedStateSequence[index] ?? `missing-state-for:${step.stepId}`,
      ...(step.kind === "workflow.node.invoke"
        ? { nodeType: step.nodeType }
        : {}),
      stepId: step.stepId,
      stepKind: step.kind,
      toState: generatedStateSequence[index + 1] ?? "done",
    }));
    const executionSurface =
      runtimeEnvironment?.platform === "cloudflare-workers"
        ? "cloudflare-workers-generated-machine-supervisor"
        : "local-integration-generated-machine-supervisor";
    const supervisorRuntime =
      runtimeEnvironment === null
        ? { platform: "unknown" as const }
        : (() => {
            if (runtimeEnvironment.platform === "cloudflare-workers") {
              return {
                cloudflare: {
                  ...(runtimeEnvironment.deploymentId === undefined
                    ? {}
                    : { deploymentId: runtimeEnvironment.deploymentId }),
                  platform: "cloudflare-workers" as const,
                  ...(runtimeEnvironment.workerName === undefined
                    ? {}
                    : { workerName: runtimeEnvironment.workerName }),
                },
                platform: "cloudflare-workers" as const,
              };
            }

            return { platform: "local-integration" as const };
          })();
    const document = {
      actorLifecycle: {
        actorFactory: "createGeneratedWorkflowActor",
        advancedWith: "NEXT",
        firstExecutableState: generatedStateSequence.at(0) ?? null,
        reachedDone: generatedStateSequence.at(-1) === "done",
        startState: machine.xstate.initial,
        started: true,
        terminalState: generatedStateSequence.at(-1) ?? null,
      },
      completionPolicy: {
        allowedCompletionEvents: ["STEP_DONE", "STEP_BLOCKED"],
        blockedStepIds: [],
        blockedTransitionCount: 0,
        observedCompletionEvents: ["STEP_DONE"],
      },
      executionSurface,
      generatedAt: new Date().toISOString(),
      loadedArtifacts: {
        harnessArtifact: loadedPlan.harness,
        machineArtifact: loadedPlan.machine,
        planArtifact,
      },
      planStepCoverage: {
        allPlanStepsCompleted: missingStepIds.length === 0,
        completedStepIds,
        missingStepIds,
        planStepIds,
      },
      receiptId: `generated-workflow-execution:${loadedPlan.runId}`,
      redacted: true,
      runId: loadedPlan.runId,
      schemaVersion: "workflow.generated-machine-execution-receipt.v1",
      supervisorRuntime,
      transitionProof: {
        completedStepCount: completedStepIds.length,
        generatedStateSequence,
        stepTransitions,
      },
      workItemId: loadedPlan.workItemId,
      workerLaneReceiptRefs: execution.workerLaneReceipts.map(
        (receipt) => receipt.receiptRef
      ),
      workflowNodeOutputRefs: execution.artifactRefs,
    } as const;

    const write = await this.dependencies.artifacts.writeJson({
      path: "run/generated-workflow-execution-receipt.json",
      redacted: true,
      runId: loadedPlan.runId,
      value: document,
    });

    return {
      ...(write.artifactCommitSha === undefined
        ? {}
        : { artifactCommitSha: write.artifactCommitSha }),
      artifactRef: write.artifactRef,
      hash: write.contentHash,
      mediaType: write.mediaType,
      text: JSON.stringify(document, null, 2),
    };
  }

  // oxlint-disable-next-line complexity -- Verifier selection is intentionally explicit for deterministic, agent-lane, and ledger-replay paths.
  private async verifyDynamicWorkflow(input: {
    readonly block: BlockRun;
    readonly execution: DynamicExecutionSuccess;
    readonly executionReceiptEvidence: AgentVerifierOutputEvidence;
    readonly ledgerDriven: boolean;
    readonly loadedPlan: DynamicWorkflowPlanDocument;
    readonly machine: DynamicWorkflowMachineDocument;
    readonly observabilityPack: WorkflowObservabilityPackArtifact;
    readonly planArtifact: PlanArtifact;
    readonly transition: SafetyEnvelopeTransition;
    readonly verificationContract: VerificationContractDocument;
    readonly verificationLedgerPhase: WorkflowDriveLedgerPhase | null;
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
      artifactRefs: input.execution.artifactRefs,
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
      input.executionReceiptEvidence,
      {
        artifactRef: input.observabilityPack.artifact.artifactRef,
        hash: input.observabilityPack.artifact.contentHash,
        mediaType: input.observabilityPack.artifact.mediaType,
        text: JSON.stringify(input.observabilityPack.document, null, 2),
      },
    ];
    const outputRefs = [
      ...input.execution.artifactRefs,
      input.executionReceiptEvidence.artifactRef,
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
        executionReceiptRef: input.executionReceiptEvidence.artifactRef,
        resultArtifact,
        resultDocument,
        status: "verified",
        ...(verification.verifierLaneReceipt === undefined
          ? {}
          : { verifierLaneReceipt: verification.verifierLaneReceipt }),
      };
    };

    let existingVerification:
      | {
          readonly result: VerificationResultArtifact;
          readonly resultDocument: VerificationResultDocument;
          readonly status: "loaded";
        }
      | { readonly status: "missing" } = { status: "missing" };
    if (input.verificationLedgerPhase !== null) {
      existingVerification = await this.loadExistingVerificationResult({
        artifactCommitSha: input.verificationLedgerPhase.artifactCommitSha,
        loadedPlan: input.loadedPlan,
        verificationContract: input.verificationContract,
      });
    } else if (!input.ledgerDriven) {
      existingVerification = await this.loadExistingVerificationResult({
        loadedPlan: input.loadedPlan,
        verificationContract: input.verificationContract,
      });
    }
    if (existingVerification.status === "loaded") {
      return await acceptVerification({
        result: existingVerification.result,
        resultDocument: existingVerification.resultDocument,
      });
    }

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
    const outputArtifactCommitSha = input.outputPins?.at(0)?.artifactCommitSha;

    return this.pinAgentLaneEvidenceDraft({
      draft: {
        ...(outputArtifactCommitSha === undefined
          ? {}
          : { artifactCommitSha: outputArtifactCommitSha }),
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
