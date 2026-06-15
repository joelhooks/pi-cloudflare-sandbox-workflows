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
 * Redaction-safe bounded sample of a planner output's own `error` self-report.
 *
 * Wound #38: when the planner pi-agent self-reports failure it emits a
 * well-formed `{"error": "<reason>"}` envelope (exit 0, valid JSON, normalized
 * true), which the contract correctly blocks as `planner_output_invalid` — but
 * {@link redactionSafeTopLevelKeyNames} surfaces only the key NAME `[error]`,
 * redacting the WHY. That left a live block diagnosable only by mining a
 * content-addressed artifact (a 166s exec + tail dig that still could not reach
 * the reason). The planner lane runs `--no-tools` (wound #31) with secret
 * materialization forbidden by its prompt, so a pi-emitted `error` value is
 * workflow-DESIGN reasoning (e.g. "no pinned package provides capability X"),
 * never a credential, customer payload, or private path. So — narrowly — the
 * `error` field of a RECOGNIZED error envelope crosses the boundary as a BOUNDED
 * single-line sample, the same precedent as wound #34 threading `rawOutputSample`
 * into the verifier blocker. Returns null for anything that is NOT a recognized
 * error envelope, so a generic value (a `result` envelope, a `session` header)
 * still never crosses — only the diagnostic `error` self-report does.
 *
 * @param value - The parsed planner output (typed `unknown`; pi controls it).
 * @returns A bounded single-line sample of the `error` field, or null.
 */
export const redactionSafePlannerErrorEnvelopeSample = (
  value: unknown
): string | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  if (!("error" in value)) {
    return null;
  }
  const rawError = (value as { readonly error: unknown }).error;
  let text: string;
  if (typeof rawError === "string") {
    text = rawError;
  } else if (rawError === null || rawError === undefined) {
    text = "";
  } else {
    // A non-string error value (object/number/bool). Serialize it so the sample
    // stays diagnostic; fall back to a marker rather than risk `[object Object]`
    // for unserializable shapes (circular refs, functions → undefined).
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(rawError);
    } catch {
      serialized = undefined;
    }
    text = serialized ?? "[unserializable error envelope]";
  }
  const collapsed = text.replaceAll(/\s+/gu, " ").trim();
  if (collapsed === "") {
    return null;
  }
  const limit = 512;
  return collapsed.length > limit
    ? `${collapsed.slice(0, limit)}…[sample truncated]`
    : collapsed;
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
 * carries top-level key NAMES (present vs missing) and schema issue PATHS so the
 * block stays redaction-safe while naming exactly what pi emitted (a
 * wrong-extraction header, an envelope, or a refusal) for the next read instead
 * of staring at a blind re-drive. Wound #38 narrows the "never values" rule by
 * one diagnostic exception: when pi self-reports via a RECOGNIZED `{error: ...}`
 * envelope, a BOUNDED sample of that `error` field rides along (see
 * {@link redactionSafePlannerErrorEnvelopeSample}) — the planner runs `--no-tools`
 * with secrets forbidden, so its `error` is workflow-design reasoning, never a
 * credential or customer payload. No other value crosses.
 */
// eslint-disable-next-line max-classes-per-file -- typed lane errors are colocated with the ports they cross (sibling of StaleDriveGenerationError).
export class PlannerBlueprintContractError extends Error {
  readonly errorEnvelopeSample: string | null;
  readonly issuePaths: readonly string[];
  readonly missingKeys: readonly string[];
  readonly presentKeys: readonly string[];
  readonly runId: string;
  readonly stage: PlannerBlueprintContractStage;
  readonly workItemId: string;

  constructor(input: {
    // Wound #38: a bounded, redaction-safe sample of a RECOGNIZED pi error
    // envelope's `error` self-report — null unless the output was an error
    // envelope. Turns a blind `present top-level keys [error]` block into a read
    // of the actual cause. See redactionSafePlannerErrorEnvelopeSample.
    readonly errorEnvelopeSample?: string | null;
    readonly issuePaths: readonly string[];
    readonly missingKeys: readonly string[];
    readonly presentKeys: readonly string[];
    readonly runId: string;
    readonly stage: PlannerBlueprintContractStage;
    readonly workItemId: string;
  }) {
    const errorEnvelopeSample = input.errorEnvelopeSample ?? null;
    super(
      `Planner lane returned output that failed the blueprint contract ` +
        `(${input.stage}, deterministic): present top-level keys [${
          input.presentKeys.join(", ") || "<none>"
        }], missing required keys [${
          input.missingKeys.join(", ") || "<none>"
        }], schema issue paths [${input.issuePaths.join(", ") || "<none>"}]${
          errorEnvelopeSample === null
            ? ""
            : `, planner error envelope: ${errorEnvelopeSample}`
        }.`
    );
    this.name = "PlannerBlueprintContractError";
    this.errorEnvelopeSample = errorEnvelopeSample;
    this.issuePaths = input.issuePaths;
    this.missingKeys = input.missingKeys;
    this.presentKeys = input.presentKeys;
    this.runId = input.runId;
    this.stage = input.stage;
    this.workItemId = input.workItemId;
  }
}

/**
 * Thrown when an agent lane demonstrably INVOKED the agent (its step heartbeat
 * reached `pi-invoke` or later) but the lane process then aborted before
 * committing a usable result — no parseable result marker, or an error marker —
 * so the workflow obtained no plan/receipt at all.
 *
 * This is a LANE-INTERNAL failure, NOT a transient transport/adapter outage. A
 * genuine `adapter_unavailable` (the sandbox unreachable, the image un-pullable,
 * the clone failing) never reaches `pi-invoke`: the heartbeat would freeze at
 * `install-pi-agent`/`prepare-auth`/`clone-artifacts`. So the heartbeat's
 * last-reached step is OBSERVABLE proof of which class this is, and the
 * application catch keys on this type to surface the deterministic
 * `planner_lane_incomplete` blocker instead of the transient `adapter_unavailable`
 * that blind-re-drove carrier wound #28 (`a8bc84dc`: pi ran 456s, normalize 67s,
 * lane aborted at `build-transcript` with no marker — mislabeled a transport
 * outage and re-driven for ~40 minutes). It carries only the heartbeat's
 * last-reached STEP name (structural, never a value) so the block stays
 * redaction-safe while naming exactly how far the lane got for the next read.
 */
// eslint-disable-next-line max-classes-per-file -- typed lane errors are colocated with the ports they cross (sibling of PlannerBlueprintContractError).
export class AgentLaneIncompleteError extends Error {
  readonly diagnostics: string | null;
  readonly lastStep: string | null;
  readonly reachedAgentInvocation: boolean;
  readonly runId: string;
  readonly workItemId: string;

  constructor(input: {
    readonly cause?: unknown;
    // Optional structural/numeric self-diagnosis the lane wrote to
    // `/workspace/.piwf-lane-diagnostics` BEFORE the step that aborted it (disk
    // free, raw/normalized/stderr byte sizes, the failing write's exit code).
    // The lane commits NO receipt when it aborts, so without this the operator
    // only sees WHICH step died, never WHY. Surfaced in the blocker message so
    // the next read names the cause (ENOSPC vs OOM vs other) instead of guessing
    // — redaction-safe: byte counts and KB-free, never values or private paths.
    readonly diagnostics?: string;
    readonly detail: string;
    readonly lastStep: string | null;
    readonly reachedAgentInvocation: boolean;
    readonly runId: string;
    readonly workItemId: string;
  }) {
    const diagnostics =
      input.diagnostics !== undefined && input.diagnostics.trim().length > 0
        ? input.diagnostics.trim()
        : null;
    super(
      `Agent lane reached step "${
        input.lastStep ?? "unknown"
      }" — the agent ran but the lane committed no usable result (lane-internal ` +
        `failure, NOT a transport outage): ${input.detail}${
          diagnostics === null
            ? ""
            : ` [lane diagnostics: ${diagnostics.split("\n").join("; ")}]`
        }`,
      input.cause === undefined ? undefined : { cause: input.cause }
    );
    this.name = "AgentLaneIncompleteError";
    this.diagnostics = diagnostics;
    this.lastStep = input.lastStep;
    this.reachedAgentInvocation = input.reachedAgentInvocation;
    this.runId = input.runId;
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
