import type { ResolvedKernelSkill } from "../domain/kernel-skills.ts";
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
  RunStepCheckpoint,
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
  WorkflowRunDriveOptions,
  WorkflowRunDriveResult,
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
  // Single wide signature: a `single-step` drive may yield the non-terminal
  // `paused` variant alongside the terminal captured/blocked. Callers that only
  // drive whole-run (omit options) still get a `WorkflowRunDriveResult` and must
  // treat `paused` as unreachable for their mode.
  startRun(
    input: unknown,
    options?: WorkflowRunDriveOptions
  ): Promise<WorkflowRunDriveResult>;
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

  persistCheckpoint(input: {
    readonly checkpoint: RunStepCheckpoint;
    readonly workItemId: string;
  }): Promise<void>;

  loadLatestCheckpoint(input: {
    readonly runId: string;
    readonly workItemId: string;
  }): Promise<RunStepCheckpoint | null>;
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
    /**
     * Every prior step's output artifact ref keyed by stepId, in execution
     * order — not just the steps this one declared in `dependsOn`. Lets a node
     * resolve its upstream input (by nodeType, via `plan.steps`) when the
     * stochastic planner produced a correct order but omitted the explicit
     * `dependsOn`/ref wiring. Optional for adapters that do not need it.
     */
    readonly completedStepArtifactRefs?: Readonly<Record<string, ArtifactRef>>;
    readonly machine: DynamicWorkflowMachineDocument;
    readonly plan: DynamicWorkflowPlanDocument;
    /**
     * The kernel skill content (workflow-design patterns, data-access guides,
     * analysis playbooks) resolved from the run's pinned kernel packages, the
     * same set injected into the planner prompt. Carried here so an agentic
     * analytical node (the correlate/propose/report lanes the next stages make
     * reason over evidence) can read the same analysis skill the planner used
     * to shape the workflow, instead of being a deterministic template-filler
     * with no access to kernel content. Optional and defaulted empty: an
     * adapter that does not consume skills ignores it, and a run with no kernel
     * skills passes `[]` — graceful degradation, never a crash.
     */
    readonly resolvedKernelSkills?: readonly ResolvedKernelSkill[];
    readonly step: WorkflowNodeInvocationStep;
  }): Promise<WorkflowNodeExecutionResult>;

  /**
   * Fail-fast plan-config validation, run once at plan-load time (before the
   * first node executes) for one `workflow.node.invoke` step. The adapter parses
   * `step.config` against the SAME leashed registry schema its `execute` fn uses,
   * so a config the leash can repair returns `null` (valid) and only a genuinely
   * unrepairable config returns a precise `plan_node_config_invalid` blocker that
   * names the offending field path and the expected constraint (redacted, no
   * secrets). Returning `null` for a `nodeType` the adapter does not own (no
   * registry schema) leaves that step to the executor's existing dispatch. The
   * method is optional so adapters without a config registry need not implement
   * it; the app treats an absent method as "nothing to validate".
   */
  validatePlanNodeConfig?(input: {
    readonly step: WorkflowNodeInvocationStep;
  }): CapabilityBlocker | null;
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
  // Overloaded so the legacy no-options call still narrows over the 2-variant
  // terminal union (captured/blocked); a `single-step` drive may also `paused`.
  run(request: WorkflowRunRequest): Promise<WorkflowRunResult>;
  run(
    request: WorkflowRunRequest,
    options: WorkflowRunDriveOptions
  ): Promise<WorkflowRunDriveResult>;
}
