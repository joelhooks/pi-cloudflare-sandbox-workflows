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
  StaleDriveGenerationRejection,
  WorkflowDriveAdmission,
  WorkflowDriveLedger,
  WorkflowDriveLaneDispatch,
  WorkflowDriveLaneStatusReceipt,
  WorkflowDriveLedgerPhase,
  WorkflowDriveNodeAttempt,
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
  AgentLaneDispatchReceipt,
  AgentLaneKind,
  AgentLaneProcessStatusReceipt,
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
  WorkflowNodeType,
  WorkflowObservabilityPack,
  WorkflowStatusProjection,
  WorkflowStructuredLogRecord,
  WorkflowTelemetrySinkReceipt,
  WorkflowTraceContext,
  WzrrdPublishDeliveryResult,
  WzrrdPublishPayload,
} from "../domain/schemas.ts";
import type { MemorySourceFamily } from "../domain/source-profile.ts";

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
    readonly driveGeneration?: number;
    readonly workItemId: string;
  }): Promise<void>;

  loadLatestCheckpoint(input: {
    readonly runId: string;
    readonly workItemId: string;
  }): Promise<RunStepCheckpoint | null>;

  admitDrive(input: {
    readonly runId: string;
    readonly workItemId: string;
  }): Promise<WorkflowDriveAdmission>;

  assertActiveDriveGeneration(input: {
    readonly driveGeneration: number;
    readonly runId: string;
    readonly workItemId: string;
  }): Promise<void>;

  loadDriveLedger(input: {
    readonly runId: string;
    readonly workItemId: string;
  }): Promise<WorkflowDriveLedger>;

  recordDrivePhaseCompletion(input: {
    readonly driveGeneration: number;
    readonly phase: Omit<
      WorkflowDriveLedgerPhase,
      "completedAt" | "driveGeneration"
    >;
    readonly runId: string;
    readonly workItemId: string;
  }): Promise<WorkflowDriveLedger>;

  recordDriveNodeAttempt(input: {
    readonly driveGeneration: number;
    readonly nodeIndex: number;
    readonly nodeType?: WorkflowNodeType;
    readonly runId: string;
    readonly stepId: string;
    readonly workItemId: string;
  }): Promise<WorkflowDriveNodeAttempt>;

  recordDriveLaneDispatch(input: {
    readonly dispatch: WorkflowDriveLaneDispatch;
    readonly driveGeneration: number;
  }): Promise<WorkflowDriveLedger>;

  recordDriveLaneStatus(input: {
    readonly driveGeneration: number;
    readonly statusReceipt: WorkflowDriveLaneStatusReceipt;
  }): Promise<WorkflowDriveLedger>;
}

export class StaleDriveGenerationError extends Error {
  readonly currentGeneration: number;
  readonly driveGeneration: number;
  readonly rejection: StaleDriveGenerationRejection;
  readonly runId: string;
  readonly workItemId: string;

  constructor(rejection: StaleDriveGenerationRejection) {
    super(rejection.message);
    this.name = "StaleDriveGenerationError";
    this.currentGeneration = rejection.currentGeneration;
    this.driveGeneration = rejection.driveGeneration;
    this.rejection = rejection;
    this.runId = rejection.runId;
    this.workItemId = rejection.workItemId;
  }
}

export type PlannerBlueprintContractStage =
  | "planner-output"
  | "blueprint-assembly";

/**
 * Redaction-safe top-level key NAMES of a planner output value — never values.
 *
 * Returns `[]` for a non-object (a scalar, JSON array, or `null` pi might emit
 * instead of a blueprint object). Capped so a pathological object cannot flood
 * the surfaced blocker message. Key *names* are structural (`result`, `session`,
 * `harness`) — not secrets — so they are safe to name in a `redacted: true`
 * blocker, and naming them is exactly what turns a blind re-drive into a read.
 *
 * @param value - The parsed planner output (typed `unknown`; pi controls it).
 * @returns Up to 24 top-level key names, in insertion order.
 */
export const redactionSafeTopLevelKeyNames = (
  value: unknown
): readonly string[] => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [];
  }
  return Object.keys(value).slice(0, 24);
};

/**
 * Thrown by a {@link DynamicWorkflowPlannerPort} when the planner lane RAN and
 * returned output, but that output failed the blueprint contract.
 *
 * This is a DETERMINISTIC content failure — re-driving the same lane yields the
 * same invalid shape — NOT a transient transport/adapter outage. The
 * application catch keys on this type to surface the deterministic
 * `planner_output_invalid` blocker instead of the transient `adapter_unavailable`
 * that re-drove the same wrong shape for ~40 minutes (carrier wound #27). It
 * carries only top-level key NAMES (present vs missing) and schema issue PATHS —
 * never values — so the block stays redaction-safe while naming exactly what pi
 * emitted (a wrong-extraction header, an envelope, or a refusal) for the next
 * read instead of staring at a blind re-drive.
 */
// eslint-disable-next-line max-classes-per-file -- typed lane errors are colocated with the ports they cross (sibling of StaleDriveGenerationError).
export class PlannerBlueprintContractError extends Error {
  readonly issuePaths: readonly string[];
  readonly missingKeys: readonly string[];
  readonly presentKeys: readonly string[];
  readonly runId: string;
  readonly stage: PlannerBlueprintContractStage;
  readonly workItemId: string;

  constructor(input: {
    readonly issuePaths: readonly string[];
    readonly missingKeys: readonly string[];
    readonly presentKeys: readonly string[];
    readonly runId: string;
    readonly stage: PlannerBlueprintContractStage;
    readonly workItemId: string;
  }) {
    super(
      `Planner lane returned output that failed the blueprint contract ` +
        `(${input.stage}, deterministic): present top-level keys [${
          input.presentKeys.join(", ") || "<none>"
        }], missing required keys [${
          input.missingKeys.join(", ") || "<none>"
        }], schema issue paths [${input.issuePaths.join(", ") || "<none>"}].`
    );
    this.name = "PlannerBlueprintContractError";
    this.issuePaths = input.issuePaths;
    this.missingKeys = input.missingKeys;
    this.presentKeys = input.presentKeys;
    this.runId = input.runId;
    this.stage = input.stage;
    this.workItemId = input.workItemId;
  }
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
    /**
     * Primary source families declared by the run's INSTALLED source profile —
     * the deterministic backstop for criticality enforcement. The report node
     * enforces against these (unioned with any planner-provided config), so a
     * dead primary source cannot masquerade as a dream even if the stochastic
     * planner omits the field. Empty when the profile declares no primaries.
     */
    readonly primarySourceFamilies?: readonly MemorySourceFamily[];
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

  dispatchLane?(
    input: AgentLaneRuntimeRequest
  ): Promise<AgentLaneDispatchReceipt>;

  pollLane?(input: {
    readonly dispatch: AgentLaneDispatchReceipt;
  }): Promise<AgentLaneProcessStatusReceipt>;

  readLaneReceipt?(input: {
    readonly artifacts: Pick<ArtifactStoreContract, "readJson">;
    readonly dispatch: AgentLaneDispatchReceipt;
  }): Promise<AgentLaneReceipt | null>;

  cleanupLane?(input: {
    readonly dispatch: AgentLaneDispatchReceipt;
    readonly reason: "completed" | "failed" | "timed-out";
    readonly receipt?: AgentLaneReceipt;
  }): Promise<void>;
}

/**
 * Structured result of one agentic analytical reasoning step. The lane runs a
 * real agent over the prompt the calling node assembled (redacted evidence +
 * analysis-method kernel skill + run goal) and writes a JSON artifact the node
 * parses against its own output schema. The node hands back that parsed value
 * here, plus the lane receipt so the deterministic envelope can hash-pin and
 * record it like any other lane output. `outputRefs`/`receipt` carry the proof
 * the reasoning actually ran on a real agent; `parsed` carries the reasoning.
 */
export interface AgentAnalysisReasoningResult<TParsed> {
  readonly outputRefs: readonly ArtifactRef[];
  readonly parsed: TParsed;
  readonly receipt: AgentLaneReceipt;
}

/**
 * Cartridge-facing seam for the "dream thinks" pattern: an analytical workflow
 * node (propose-refinements today) calls this with a prompt it built from the
 * hydrated evidence and the analysis-method kernel skill, plus a Zod schema for
 * the structured output it expects back. The lane invokes a REAL agent through
 * the same {@link AgentLaneRuntimePort} machinery the planner/worker lanes use
 * (no new runtime), reads the pinned JSON output, validates it against the
 * supplied schema, and returns the parsed reasoning with the lane receipt. The
 * port is deliberately narrow — the node owns prompt assembly and output shape;
 * the lane owns running the agent and producing receipts. When this port is not
 * configured (integration-test runtime, no Pi auth) the node falls back to its
 * deterministic path and labels the output as mechanical, so a report never
 * claims reasoning it did not do.
 */
export interface AgentAnalysisReasoningLanePort {
  readonly laneKind: "analysis";
  readonly runtime: Exclude<AgentLaneRuntime, "integration-test">;

  reason<TParsed>(input: {
    readonly actor: Actor;
    readonly laneId: string;
    readonly outputPath: string;
    readonly outputSchema: { readonly parse: (value: unknown) => TParsed };
    readonly packageMounts: readonly PinnedPackage[];
    readonly prompt: string;
    readonly promptPath: string;
    readonly receiptPath: string;
    readonly runId: string;
    readonly transcriptPath: string;
    readonly workItemId: string;
  }): Promise<AgentAnalysisReasoningResult<TParsed>>;
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

  dispatchStep?(input: {
    readonly machine: DynamicWorkflowMachineDocument;
    readonly nodeIndex: number;
    readonly plan: DynamicWorkflowPlanDocument;
    readonly step: Extract<
      DynamicWorkflowStep,
      { readonly kind: "research.review" }
    >;
  }): Promise<WorkflowDriveLaneDispatch>;

  pollStep?(input: {
    readonly dispatch: WorkflowDriveLaneDispatch;
  }): Promise<WorkflowDriveLaneStatusReceipt>;

  readStepReceipt?(input: {
    readonly dispatch: WorkflowDriveLaneDispatch;
  }): Promise<AgentWorkerStepResult | null>;

  cleanupStep?(input: {
    readonly dispatch: WorkflowDriveLaneDispatch;
    readonly reason: "completed" | "failed" | "timed-out";
    readonly receipt?: AgentLaneReceipt;
  }): Promise<void>;
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
