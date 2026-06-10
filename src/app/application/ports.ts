import type {
  Actor,
  ArtifactRef,
  ArtifactWriteReceipt,
  CapabilityBlocker,
  CapabilityLease,
  CapabilityLeaseDecision,
  CapabilityLeaseReceipt,
  CapabilityLeaseRequest,
  ContextCapsuleRecord,
  DiscordDeliveryResult,
  DiscordMessagePayload,
  DiscordResource,
  DynamicWorkflowBlueprint,
  DynamicWorkflowMachineArtifact,
  DynamicWorkflowMachineDocument,
  DynamicWorkflowPlanDocument,
  DynamicWorkflowStep,
  GeneratedHarnessArtifact,
  OutputTarget,
  PackageMetadata,
  PlanArtifact,
  PinnedPackage,
  AgentLaneAdmissionDecision,
  AgentLaneAdmissionRequest,
  AgentLaneKind,
  AgentLaneReleaseReceipt,
  AgentLaneReleaseRequest,
  AgentLaneReceipt,
  AgentLaneRuntime,
  AgentAuthLease,
  GitHubBranchCommitDeliveryResult,
  GitHubBranchCommitPayload,
  GitHubPullRequestDeliveryResult,
  GitHubPullRequestPayload,
  LinearCommentDeliveryResult,
  LinearCommentPayload,
  PlanProposal,
  ReviewGate,
  ReviewSurfaceArtifact,
  VerificationContractDocument,
  VerificationResultArtifact,
  VerificationResultDocument,
  WorkflowExecutionProofArtifact,
  WorkflowExecutionProofDocument,
  WorkflowRunRequest,
  WorkflowRunResult,
  WorkflowEvent,
  WorkflowObservabilityPack,
  WorkflowStatusProjection,
  WorkflowStructuredLogRecord,
  WorkflowTelemetrySinkReceipt,
  WorkflowTraceContext,
  WzrrdPublishDeliveryResult,
  WzrrdPublishPayload,
} from "../domain/schemas.ts";

export type FrontDoorRoute = "POST /runs";

export interface WorkerFrontDoorContract {
  readonly route: FrontDoorRoute;
  startRun(input: unknown): Promise<WorkflowRunResult>;
}

export interface ContextCapsuleActorContract {
  resolve(input: {
    readonly runId: string;
    readonly workItemId: string;
  }): Promise<ContextCapsuleRecord>;

  appendEvent(input: {
    readonly event: WorkflowEvent;
    readonly workItemId: string;
  }): Promise<void>;
}

export interface PackageRegistryActorContract {
  discoverMetadata(input: {
    readonly actor: Actor;
  }): Promise<PackageMetadata[]>;

  pinPackages(input: {
    readonly actor: Actor;
    readonly packageIds: readonly string[];
  }): Promise<
    | {
        readonly pinnedPackages: PinnedPackage[];
        readonly status: "pinned";
      }
    | {
        readonly blocker: CapabilityBlocker;
        readonly status: "blocked";
      }
  >;
}

export interface ArtifactStoreContract {
  artifactRef(input: {
    readonly path: string;
    readonly runId: string;
  }): ArtifactRef;

  readJson(input: {
    readonly artifactCommitSha?: string;
    readonly artifactRef: ArtifactRef;
  }): Promise<unknown>;

  readText(input: {
    readonly artifactCommitSha?: string;
    readonly artifactRef: ArtifactRef;
  }): Promise<string>;

  writeJson(input: {
    readonly path: string;
    readonly redacted: true;
    readonly runId: string;
    readonly value: unknown;
  }): Promise<ArtifactWriteReceipt>;

  writeText(input: {
    readonly mediaType: string;
    readonly path: string;
    readonly redacted: true;
    readonly runId: string;
    readonly value: string;
  }): Promise<ArtifactWriteReceipt>;
}

export interface CapabilityLeaseBrokerActorContract {
  recordDiscordExecution(input: {
    readonly delivery: DiscordDeliveryResult;
    readonly lease: CapabilityLease;
  }): Promise<CapabilityLeaseReceipt>;

  recordGitHubPullRequestExecution(input: {
    readonly delivery: GitHubPullRequestDeliveryResult;
    readonly lease: CapabilityLease;
  }): Promise<CapabilityLeaseReceipt>;

  recordGitHubBranchCommitExecution(input: {
    readonly delivery: GitHubBranchCommitDeliveryResult;
    readonly lease: CapabilityLease;
  }): Promise<CapabilityLeaseReceipt>;

  recordLinearCommentExecution(input: {
    readonly delivery: LinearCommentDeliveryResult;
    readonly lease: CapabilityLease;
  }): Promise<CapabilityLeaseReceipt>;

  recordWzrrdExecution(input: {
    readonly delivery: WzrrdPublishDeliveryResult;
    readonly lease: CapabilityLease;
  }): Promise<CapabilityLeaseReceipt>;

  requestLease(input: CapabilityLeaseRequest): Promise<CapabilityLeaseDecision>;
}

export interface DiscordMessageCapabilityAdapter {
  execute(input: {
    readonly lease: CapabilityLease;
    readonly payload: DiscordMessagePayload;
  }): Promise<DiscordDeliveryResult>;
}

export interface WzrrdPublishCapabilityAdapter {
  execute(input: {
    readonly lease: CapabilityLease;
    readonly payload: WzrrdPublishPayload;
  }): Promise<WzrrdPublishDeliveryResult>;
}

export interface GitHubPullRequestCapabilityAdapter {
  execute(input: {
    readonly lease: CapabilityLease;
    readonly payload: GitHubPullRequestPayload;
  }): Promise<GitHubPullRequestDeliveryResult>;
}

export interface GitHubBranchCommitCapabilityAdapter {
  execute(input: {
    readonly lease: CapabilityLease;
    readonly payload: GitHubBranchCommitPayload;
  }): Promise<GitHubBranchCommitDeliveryResult>;
}

export interface LinearCommentCapabilityAdapter {
  execute(input: {
    readonly lease: CapabilityLease;
    readonly payload: LinearCommentPayload;
  }): Promise<LinearCommentDeliveryResult>;
}

export interface DynamicWorkflowNotificationInput {
  readonly dryRun: boolean;
  readonly payloadHash: string;
  readonly payloadRef: ArtifactRef;
  readonly resource: DiscordResource;
  readonly reviewGate: ReviewGate;
  readonly secretRef: string;
}

export interface DynamicWorkflowPlannerPort {
  proposePlan(input: {
    readonly actor: Actor;
    readonly availablePackages: readonly PackageMetadata[];
    readonly notification?: DynamicWorkflowNotificationInput;
    readonly pinnedPackages: readonly PinnedPackage[];
    readonly proposal: PlanProposal;
    readonly runId: string;
    readonly workItemId: string;
  }): Promise<DynamicWorkflowBlueprint>;
}

export type WorkflowNodeInvocationStep = Extract<
  DynamicWorkflowStep,
  { readonly kind: "workflow.node.invoke" }
>;

export type WorkflowNodeExecutionResult =
  | {
      readonly blocker: CapabilityBlocker;
      readonly status: "blocked";
    }
  | {
      readonly outputRefs: readonly ArtifactRef[];
      readonly status: "executed";
    };

export interface WorkflowNodeAdapterPort {
  execute(input: {
    readonly actor: Actor;
    readonly dependencyArtifactRefs: Readonly<Record<string, ArtifactRef>>;
    readonly machine: DynamicWorkflowMachineDocument;
    readonly plan: DynamicWorkflowPlanDocument;
    readonly step: WorkflowNodeInvocationStep;
  }): Promise<WorkflowNodeExecutionResult>;
}

export interface AgentPlannerLanePort extends DynamicWorkflowPlannerPort {
  readonly laneKind: "planner";
  readonly runtime: AgentLaneRuntime;
}

export interface AgentLaneRuntimeRequest {
  readonly authLease: AgentAuthLease;
  artifactRef(input: {
    readonly path: string;
    readonly runId: string;
  }): ArtifactRef;
  readonly artifactRemote: string;
  readonly artifactTokenSecret: string;
  readonly branchName?: string;
  readonly kind: AgentLaneKind;
  readonly laneId: string;
  readonly model: string;
  readonly outputMediaType: string;
  readonly outputPath: string;
  readonly packageMounts?: readonly PinnedPackage[];
  readonly leasedPiAuthJsonBase64: string;
  readonly prompt: string;
  readonly promptPath: string;
  readonly provider: "openai-codex";
  readonly receiptPath: string;
  readonly runId: string;
  readonly timeoutMs: number;
  readonly traceContext: WorkflowTraceContext;
  readonly transcriptPath: string;
  readonly workItemId: string;
}

export interface AgentLaneRuntimePort {
  readonly runtime: Exclude<AgentLaneRuntime, "integration-test">;

  runLane(input: AgentLaneRuntimeRequest): Promise<AgentLaneReceipt>;
}

export interface AgentLaneAdmissionControllerContract {
  admitLane(
    input: AgentLaneAdmissionRequest
  ): Promise<AgentLaneAdmissionDecision>;

  releaseLane(input: AgentLaneReleaseRequest): Promise<AgentLaneReleaseReceipt>;
}

export interface AgentWorkerStepResult {
  readonly outputRefs: readonly ArtifactRef[];
  readonly receipt: AgentLaneReceipt;
}

export interface AgentWorkerLanePort {
  readonly laneKind: "worker";
  readonly runtime: Exclude<AgentLaneRuntime, "integration-test">;

  runStep(input: {
    readonly machine: DynamicWorkflowMachineDocument;
    readonly plan: DynamicWorkflowPlanDocument;
    readonly step: DynamicWorkflowStep;
  }): Promise<AgentWorkerStepResult>;
}

export interface AgentVerifierOutputEvidence {
  readonly artifactCommitSha?: string;
  readonly artifactRef: ArtifactRef;
  readonly hash: string;
  readonly mediaType: string;
  readonly text: string;
}

export interface AgentVerifierLanePort {
  readonly laneKind: "verifier";
  readonly runtime: Exclude<AgentLaneRuntime, "integration-test">;

  verify(input: {
    readonly capabilityReceipts: readonly CapabilityLeaseReceipt[];
    readonly contract: VerificationContractDocument;
    readonly outputEvidence: readonly AgentVerifierOutputEvidence[];
    readonly outputRefs: readonly ArtifactRef[];
    readonly plan: DynamicWorkflowPlanDocument;
  }): Promise<{
    readonly result: VerificationResultArtifact;
    readonly resultDocument: VerificationResultDocument;
    readonly verifierLaneReceipt: AgentLaneReceipt;
  }>;
}

export interface DeterministicVerifierPort {
  readonly verifierKind: "deterministic";

  verify(input: {
    readonly capabilityReceipts: readonly CapabilityLeaseReceipt[];
    readonly contract: VerificationContractDocument;
    readonly outputEvidence: readonly AgentVerifierOutputEvidence[];
    readonly outputRefs: readonly ArtifactRef[];
    readonly plan: DynamicWorkflowPlanDocument;
  }): Promise<{
    readonly result: VerificationResultArtifact;
    readonly resultDocument: VerificationResultDocument;
  }>;
}

export interface ReviewSurfacePublisherPort {
  publish(input: {
    readonly artifactRefs: readonly ArtifactRef[];
    readonly capabilityReceipts: readonly CapabilityLeaseReceipt[];
    readonly eventLog: readonly WorkflowEvent[];
    readonly executionProofArtifact: WorkflowExecutionProofArtifact;
    readonly outputTarget: OutputTarget;
    readonly plan: DynamicWorkflowPlanDocument;
    readonly planArtifact: PlanArtifact;
    readonly plannerLaneReceipt: AgentLaneReceipt;
    readonly reviewSummaryRef: ArtifactRef;
    readonly verificationResultArtifact?: VerificationResultArtifact;
    readonly verifierLaneReceipt?: AgentLaneReceipt;
    readonly workerLaneReceipts: readonly AgentLaneReceipt[];
  }): Promise<ReviewSurfaceArtifact>;
}

export type WorkflowPostExecutionArtifactRecorderResult =
  | {
      readonly artifactRefs: readonly ArtifactRef[];
      readonly status: "recorded";
    }
  | {
      readonly blocker: CapabilityBlocker;
      readonly status: "blocked";
    };

export interface WorkflowPostExecutionArtifactRecorderPort {
  record(input: {
    readonly executionProofArtifact: WorkflowExecutionProofArtifact;
    readonly executionProofDocument: WorkflowExecutionProofDocument;
    readonly harnessArtifact: GeneratedHarnessArtifact;
    readonly harnessSource: string;
    readonly machine: DynamicWorkflowMachineDocument;
    readonly machineArtifact: DynamicWorkflowMachineArtifact;
    readonly machineSource: string;
    readonly plan: DynamicWorkflowPlanDocument;
    readonly planArtifact: PlanArtifact;
  }): Promise<WorkflowPostExecutionArtifactRecorderResult>;
}

/**
 * Declares which installed source profile a post-execution recorder is bound
 * to. The app runs a recorder only when the run request's source profile
 * matches the binding; a run with no matching recorder runs zero recorders.
 */
export type WorkflowPostExecutionArtifactRecorderBinding =
  | {
      readonly kind: "profile-id";
      readonly packageId: string;
      readonly profileId: string;
    }
  | {
      readonly kind: "profile-id-predicate";
      readonly matchesProfileId: (profileId: string) => boolean;
      readonly packageId: string;
    };

export interface WorkflowPostExecutionArtifactRecorderRegistration {
  readonly binding: WorkflowPostExecutionArtifactRecorderBinding;
  readonly recorder: WorkflowPostExecutionArtifactRecorderPort;
}

export interface WorkflowObservabilityCaptureInput {
  readonly capabilityReceipts: readonly CapabilityLeaseReceipt[];
  readonly eventLog: readonly WorkflowEvent[];
  readonly executionArtifactRefs: readonly ArtifactRef[];
  readonly plan: DynamicWorkflowPlanDocument;
  readonly planArtifact: PlanArtifact;
  readonly plannerLaneReceipt: AgentLaneReceipt;
  readonly workerLaneReceipts: readonly AgentLaneReceipt[];
}

export interface WorkflowObservabilityPackArtifact {
  readonly artifact: ArtifactWriteReceipt;
  readonly document: WorkflowObservabilityPack;
}

export interface WorkflowTelemetrySinkPort {
  recordLogs(input: {
    readonly logs: readonly WorkflowStructuredLogRecord[];
    readonly runId: string;
    readonly workItemId: string;
  }): Promise<readonly WorkflowTelemetrySinkReceipt[]>;
}

export interface WorkflowObservabilityRecorderPort {
  capturePack(
    input: WorkflowObservabilityCaptureInput
  ): Promise<WorkflowObservabilityPackArtifact>;
}

export interface WorkflowStatusProjectionPort {
  record(input: {
    readonly projection: WorkflowStatusProjection;
  }): Promise<void>;
}

export interface ReviewGateActorContract {
  summarize(input: {
    readonly capabilityReceipts: readonly CapabilityLeaseReceipt[];
    readonly eventLog: readonly WorkflowEvent[];
    readonly outputPath?: string;
    readonly runId: string;
    readonly stepArtifactRefs: readonly ArtifactRef[];
  }): Promise<ArtifactWriteReceipt>;
}

export interface WorkflowAppContract {
  readonly appName: "workflow-app";
  run(request: WorkflowRunRequest): Promise<WorkflowRunResult>;
}
