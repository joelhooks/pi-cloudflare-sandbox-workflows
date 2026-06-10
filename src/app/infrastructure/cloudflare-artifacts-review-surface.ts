import type {
  ArtifactStoreContract,
  ReviewSurfacePublisherPort,
} from "../application/ports.ts";
import {
  workflowObservabilityHighCardinalityFields,
  workflowObservabilityRequiredSignals,
} from "../domain/observability.ts";
import {
  ReviewSurfaceArtifactSchema,
  ReviewSurfaceDocumentSchema,
} from "../domain/schemas.ts";
import type {
  AgentLaneReceipt,
  ArtifactRef,
  DynamicWorkflowPlanDocument,
  OutputTarget,
  ReviewSurfaceAcceptanceRef,
  ReviewSurfaceArtifact,
  ReviewSurfaceObservabilityRequirement,
  ReviewSurfaceProposalReconciliation,
  ReviewSurfaceProposalReconciliationRequirement,
  ReviewSurfaceProposalRequirementId,
  ReviewSurfaceWorkflowChainCompletion,
  ReviewSurfaceWorkflowChainRequirement,
  ReviewSurfaceWorkflowChainRequirementId,
  WorkflowExecutionProofArtifact,
  WorkflowEvent,
} from "../domain/schemas.ts";

export interface CloudflareArtifactsReviewSurfacePublisherConfig {
  readonly acceptanceRefs?: readonly ReviewSurfaceAcceptanceRef[];
  readonly artifacts: ArtifactStoreContract;
  readonly now?: () => string;
}

const surfaceKindFor = (
  outputTarget: OutputTarget
): ReviewSurfaceArtifact["kind"] => {
  if (outputTarget.kind === "artifact-only") {
    return "artifact-review";
  }

  return outputTarget.kind;
};

const uniqueArtifactRefs = (
  artifactRefs: readonly ArtifactRef[]
): ArtifactRef[] => [...new Set(artifactRefs)];

const safePathSegment = (value: string): string =>
  value.replaceAll(/[^A-Za-z0-9_.:-]/gu, "_");

const runtimeObservabilityRequirement = {
  redactionPolicy: "no-secrets-no-raw-auth-no-token-bearing-refs",
  requiredSignals: [...workflowObservabilityRequiredSignals],
  requiredStructuredLogFields: [...workflowObservabilityHighCardinalityFields],
  status: "required",
  summary:
    "Runtime observability, telemetry, and structured high-cardinality logs are required definition-of-done evidence; receipt-only audit trails do not satisfy this gate.",
} satisfies ReviewSurfaceObservabilityRequirement;

const eventStates = (
  eventLog: readonly WorkflowEvent[],
  states: readonly string[]
): string[] =>
  eventLog
    .filter((event) => states.includes(event.state))
    .map((event) => event.state);

const laneEvidenceRefs = (receipt: AgentLaneReceipt): ArtifactRef[] => [
  receipt.prompt.artifactRef,
  receipt.transcript.artifactRef,
  receipt.receiptRef,
  ...(receipt.packageMounts === undefined
    ? []
    : [receipt.packageMounts.artifactRef]),
  ...receipt.outputRefs,
];

const requirement = (input: {
  readonly captured: boolean;
  readonly evidenceRefs?: readonly ArtifactRef[];
  readonly eventStates?: readonly string[];
  readonly requirementId: ReviewSurfaceWorkflowChainRequirementId;
  readonly summary: string;
}): ReviewSurfaceWorkflowChainRequirement => ({
  eventStates: [...(input.eventStates ?? [])],
  evidenceRefs: [...(input.evidenceRefs ?? [])],
  requirementId: input.requirementId,
  status: input.captured ? "captured" : "missing",
  summary: input.summary,
});

const proposalRequirement = (input: {
  readonly acceptanceRefUrls: readonly string[];
  readonly captured: boolean;
  readonly evidenceRefs?: readonly ArtifactRef[];
  readonly requirementId: ReviewSurfaceProposalRequirementId;
  readonly summary: string;
}): ReviewSurfaceProposalReconciliationRequirement => ({
  acceptanceRefUrls: [...input.acceptanceRefUrls],
  evidenceRefs: uniqueArtifactRefs(input.evidenceRefs ?? []),
  requirementId: input.requirementId,
  status: input.captured ? "captured" : "missing",
  summary: input.summary,
});

const allRealAgentLanes = (receipts: readonly AgentLaneReceipt[]): boolean =>
  receipts.length > 0 &&
  receipts.every(
    (receipt) => receipt.realAgent && receipt.runtime !== "integration-test"
  );

const isRealAgentLaneReceipt = (receipt: AgentLaneReceipt): boolean =>
  receipt.realAgent && receipt.runtime !== "integration-test";

const verifierOrDeterministicVerificationCaptured = (input: {
  readonly verifierLaneReceipt?: AgentLaneReceipt;
  readonly verificationResultArtifactRef?: ArtifactRef;
}): boolean => {
  if (input.verificationResultArtifactRef === undefined) {
    return false;
  }

  return (
    input.verifierLaneReceipt === undefined ||
    isRealAgentLaneReceipt(input.verifierLaneReceipt)
  );
};

const optionalArtifactRef = (
  artifactRef: ArtifactRef | undefined
): ArtifactRef[] => (artifactRef === undefined ? [] : [artifactRef]);

const optionalLaneEvidenceRefs = (
  receipt: AgentLaneReceipt | undefined
): ArtifactRef[] => (receipt === undefined ? [] : laneEvidenceRefs(receipt));

const packagePinningCaptured = (input: {
  readonly packagePinningStates: readonly string[];
  readonly packageRefs: readonly ArtifactRef[];
}): boolean =>
  input.packageRefs.length > 0 &&
  input.packagePinningStates.includes("pinningPackages");

const entitlementAndTrustCaptured = (
  packagePinningStates: readonly string[]
): boolean =>
  packagePinningStates.includes("checkingEntitlements") &&
  packagePinningStates.includes("pinningPackages");

const generatedWorkflowPinned = (plan: DynamicWorkflowPlanDocument): boolean =>
  plan.machine.artifactRef.length > 0 &&
  plan.machine.sourceArtifactRef.length > 0 &&
  plan.harness.artifactRef.length > 0 &&
  plan.verificationContract.artifactRef.length > 0;

const cloudflareExecutionProven = (
  proof: WorkflowExecutionProofArtifact
): boolean => proof.status === "cloudflare-generated-machine-executed";

const sideEffectsCoveredByCapabilityReceipts = (input: {
  readonly capabilityReceiptRefs: readonly ArtifactRef[];
  readonly plan: DynamicWorkflowPlanDocument;
}): boolean =>
  input.capabilityReceiptRefs.length > 0 &&
  (input.plan.sideEffects.length === 0 ||
    input.capabilityReceiptRefs.length >= input.plan.sideEffects.length);

const receiptBackedReviewSurfaceCaptured = (input: {
  readonly artifactRefs: readonly ArtifactRef[];
  readonly reviewSummaryRef: ArtifactRef;
  readonly verificationResultArtifactRef?: ArtifactRef;
}): boolean =>
  input.reviewSummaryRef.length > 0 &&
  input.artifactRefs.length > 0 &&
  input.verificationResultArtifactRef !== undefined;

const proposalReconciliationStatus = (input: {
  readonly acceptanceRefUrls: readonly string[];
  readonly requirements: readonly ReviewSurfaceProposalReconciliationRequirement[];
}): ReviewSurfaceProposalReconciliation["status"] =>
  input.acceptanceRefUrls.length > 0 &&
  input.requirements.every((entry) => entry.status === "captured")
    ? "reconciled"
    : "linked";

const proposalReconciliation = (input: {
  readonly acceptanceRefs: readonly ReviewSurfaceAcceptanceRef[];
  readonly artifactRefs: readonly ArtifactRef[];
  readonly capabilityReceipts: readonly {
    readonly receiptRef: ArtifactRef;
  }[];
  readonly eventLog: readonly WorkflowEvent[];
  readonly executionProofArtifact: WorkflowExecutionProofArtifact;
  readonly plan: DynamicWorkflowPlanDocument;
  readonly planArtifactRef: ArtifactRef;
  readonly plannerLaneReceipt: AgentLaneReceipt;
  readonly reviewSummaryRef: ArtifactRef;
  readonly verificationResultArtifactRef?: ArtifactRef;
  readonly verifierLaneReceipt?: AgentLaneReceipt;
  readonly workerLaneReceipts: readonly AgentLaneReceipt[];
}): ReviewSurfaceProposalReconciliation => {
  const acceptanceRefUrls = input.acceptanceRefs.map((ref) => ref.url);
  const packageRefs = input.plan.pinnedPackages.map(
    (packageRef) => packageRef.artifactRef
  );
  const packagePinningStates = eventStates(input.eventLog, [
    "discoveringPackageMetadata",
    "checkingEntitlements",
    "pinningPackages",
  ]);
  const plannerIsReal = isRealAgentLaneReceipt(input.plannerLaneReceipt);
  const workersAreReal = allRealAgentLanes(input.workerLaneReceipts);
  const verificationIsCaptured = verifierOrDeterministicVerificationCaptured({
    ...(input.verificationResultArtifactRef === undefined
      ? {}
      : { verificationResultArtifactRef: input.verificationResultArtifactRef }),
    ...(input.verifierLaneReceipt === undefined
      ? {}
      : { verifierLaneReceipt: input.verifierLaneReceipt }),
  });
  const capabilityReceiptRefs = input.capabilityReceipts.map(
    (receipt) => receipt.receiptRef
  );
  const observabilityPackRefs = input.artifactRefs.filter((artifactRef) =>
    artifactRef.endsWith("/run/observability-pack.json")
  );
  const laneReceiptRefs = [
    ...laneEvidenceRefs(input.plannerLaneReceipt),
    ...input.workerLaneReceipts.flatMap(laneEvidenceRefs),
    ...optionalLaneEvidenceRefs(input.verifierLaneReceipt),
  ];
  const generatedWorkflowRefs = [
    input.plan.machine.artifactRef,
    input.plan.machine.sourceArtifactRef,
    input.plan.harness.artifactRef,
    input.plan.verificationContract.artifactRef,
    input.planArtifactRef,
  ];
  const executionProofRefs = [input.executionProofArtifact.artifactRef];
  const verificationRefs = optionalArtifactRef(
    input.verificationResultArtifactRef
  );
  const requirements = [
    proposalRequirement({
      acceptanceRefUrls,
      captured: input.plan.pinnedPackages.length > 0,
      evidenceRefs: [input.planArtifactRef, ...packageRefs],
      requirementId: "package-first-saved-primitive",
      summary:
        "The run treats packages as the top-level saved primitive: package metadata is pinned in the plan and backed by artifact references.",
    }),
    proposalRequirement({
      acceptanceRefUrls,
      captured: packagePinningCaptured({ packagePinningStates, packageRefs }),
      evidenceRefs: packageRefs,
      requirementId: "artifact-backed-package-pinning",
      summary:
        "Package discovery resolves artifact-backed package versions before invocation instead of dumping raw content into the lane.",
    }),
    proposalRequirement({
      acceptanceRefUrls,
      captured: entitlementAndTrustCaptured(packagePinningStates),
      evidenceRefs: [input.planArtifactRef, ...packageRefs],
      requirementId: "entitlement-and-trust-policy",
      summary:
        "The control plane records entitlement checks and trust-tiered package pins before mounting or invoking package exports.",
    }),
    proposalRequirement({
      acceptanceRefUrls,
      captured: generatedWorkflowPinned(input.plan),
      evidenceRefs: generatedWorkflowRefs,
      requirementId: "generated-xstate-dynamic-workflow",
      summary:
        "The stochastic planner output is compiled into pinned generated XState machine, source, harness, and verification-contract artifacts.",
    }),
    proposalRequirement({
      acceptanceRefUrls,
      captured: cloudflareExecutionProven(input.executionProofArtifact),
      evidenceRefs: executionProofRefs,
      requirementId: "cloudflare-execution-proof",
      summary:
        "The run must prove Cloudflare executed the generated machine artifacts; local integration or static control-flow receipts do not satisfy this gate.",
    }),
    proposalRequirement({
      acceptanceRefUrls,
      captured: plannerIsReal && workersAreReal && verificationIsCaptured,
      evidenceRefs: [...laneReceiptRefs, ...verificationRefs],
      requirementId: "real-pi-agent-lanes",
      summary:
        "Planner and worker lanes must be real Pi agent executions; verification is satisfied by either a real Pi verifier lane or a plan-selected deterministic verifier result.",
    }),
    proposalRequirement({
      acceptanceRefUrls,
      captured: sideEffectsCoveredByCapabilityReceipts({
        capabilityReceiptRefs,
        plan: input.plan,
      }),
      evidenceRefs: capabilityReceiptRefs,
      requirementId: "capability-leased-side-effects",
      summary:
        "Side effects are executed only through capability lease receipts bound to payload hashes, actors, resources, expiry, and review gates.",
    }),
    proposalRequirement({
      acceptanceRefUrls,
      captured: receiptBackedReviewSurfaceCaptured({
        artifactRefs: input.artifactRefs,
        reviewSummaryRef: input.reviewSummaryRef,
        ...(input.verificationResultArtifactRef === undefined
          ? {}
          : {
              verificationResultArtifactRef:
                input.verificationResultArtifactRef,
            }),
      }),
      evidenceRefs: [
        input.reviewSummaryRef,
        ...verificationRefs,
        ...capabilityReceiptRefs,
      ],
      requirementId: "receipt-backed-review-surface",
      summary:
        "The final review surface is backed by redacted artifacts, receipts, verification results, and review-summary evidence.",
    }),
    proposalRequirement({
      acceptanceRefUrls,
      captured: observabilityPackRefs.length > 0,
      evidenceRefs: observabilityPackRefs,
      requirementId: "observability-redaction-envelope",
      summary:
        "Runtime observability, telemetry, structured logs, accounting status, and redaction policy are carried as review-surface evidence.",
    }),
  ];
  const status = proposalReconciliationStatus({
    acceptanceRefUrls,
    requirements,
  });

  return {
    requirements,
    status,
    summary:
      status === "reconciled"
        ? "This review surface reconciles the configured Wzrrd proposal against live run evidence for package-first artifacts, generated XState workflow, real Pi lanes, capability leases, receipts, and observability."
        : "This review surface links configured acceptance refs and carries proposal reconciliation evidence, but at least one proposal requirement is missing or test-only.",
  };
};

const workflowChainCompletion = (input: {
  readonly artifactRefs: readonly ArtifactRef[];
  readonly capabilityReceipts: readonly {
    readonly receiptRef: ArtifactRef;
  }[];
  readonly eventLog: readonly WorkflowEvent[];
  readonly executionProofArtifact: WorkflowExecutionProofArtifact;
  readonly plan: DynamicWorkflowPlanDocument;
  readonly planArtifactRef: ArtifactRef;
  readonly plannerLaneReceipt: AgentLaneReceipt;
  readonly reviewSummaryRef: ArtifactRef;
  readonly verificationResultArtifactRef?: ArtifactRef;
  readonly verifierLaneReceipt?: AgentLaneReceipt;
  readonly workerLaneReceipts: readonly AgentLaneReceipt[];
}): ReviewSurfaceWorkflowChainCompletion => {
  const plannerIsReal =
    input.plannerLaneReceipt.realAgent &&
    input.plannerLaneReceipt.runtime !== "integration-test";
  const workersAreReal = allRealAgentLanes(input.workerLaneReceipts);
  const verificationIsCaptured = verifierOrDeterministicVerificationCaptured({
    ...(input.verificationResultArtifactRef === undefined
      ? {}
      : { verificationResultArtifactRef: input.verificationResultArtifactRef }),
    ...(input.verifierLaneReceipt === undefined
      ? {}
      : { verifierLaneReceipt: input.verifierLaneReceipt }),
  });
  const packageRefs = input.plan.pinnedPackages.map(
    (packageRef) => packageRef.artifactRef
  );
  const workerEvidenceRefs = input.workerLaneReceipts.flatMap(laneEvidenceRefs);
  const capabilityReceiptRefs = input.capabilityReceipts.map(
    (receipt) => receipt.receiptRef
  );
  const capabilityRequirementCaptured =
    input.plan.sideEffects.length === 0 ||
    capabilityReceiptRefs.length >= input.plan.sideEffects.length;
  const executionProofRefs = [input.executionProofArtifact.artifactRef];
  const observabilityPackRefs = input.artifactRefs.filter((artifactRef) =>
    artifactRef.endsWith("/run/observability-pack.json")
  );
  const requirements = [
    requirement({
      captured: input.plan.proposal.intent.length > 0,
      eventStates: eventStates(input.eventLog, ["resolvingCapsule"]),
      evidenceRefs: [input.planArtifactRef],
      requirementId: "intent-and-policy",
      summary:
        "The operator intent and policy-bearing plan proposal are pinned in the dynamic plan artifact.",
    }),
    requirement({
      captured:
        eventStates(input.eventLog, ["discoveringPackageMetadata"]).length > 0,
      eventStates: eventStates(input.eventLog, [
        "resolvingCapsule",
        "discoveringPackageMetadata",
      ]),
      requirementId: "context-capsule",
      summary:
        "The control plane resolved the work-item context capsule before package discovery.",
    }),
    requirement({
      captured:
        packageRefs.length > 0 &&
        eventStates(input.eventLog, ["pinningPackages"]).length > 0,
      eventStates: eventStates(input.eventLog, [
        "discoveringPackageMetadata",
        "checkingEntitlements",
        "pinningPackages",
      ]),
      evidenceRefs: packageRefs,
      requirementId: "package-discovery-and-pinning",
      summary:
        "Package metadata was discovered, entitlement-checked, and pinned from package artifacts.",
    }),
    requirement({
      captured: plannerIsReal,
      eventStates: eventStates(input.eventLog, ["planningDynamicWorkflow"]),
      evidenceRefs: laneEvidenceRefs(input.plannerLaneReceipt),
      requirementId: "pi-planner-lane",
      summary:
        "A real Pi planner lane produced the dynamic workflow blueprint and planner evidence.",
    }),
    requirement({
      captured:
        input.plan.machine.artifactRef.length > 0 &&
        input.plan.machine.sourceArtifactRef.length > 0 &&
        input.plan.harness.artifactRef.length > 0 &&
        input.plan.verificationContract.artifactRef.length > 0,
      eventStates: eventStates(input.eventLog, [
        "pinningPlanArtifact",
        "loadingPinnedDynamicWorkflow",
      ]),
      evidenceRefs: [
        input.plannerLaneReceipt.prompt.artifactRef,
        input.plannerLaneReceipt.transcript.artifactRef,
        input.plan.machine.artifactRef,
        input.plan.machine.sourceArtifactRef,
        input.plan.harness.artifactRef,
        input.plan.verificationContract.artifactRef,
        input.planArtifactRef,
        ...executionProofRefs,
      ],
      requirementId: "pinned-plan-phase",
      summary:
        "Planner prompt, planner transcript, generated machine, harness, verification contract, and plan artifacts were pinned before execution.",
    }),
    requirement({
      captured: workersAreReal,
      eventStates: eventStates(input.eventLog, ["executingDynamicWorkflow"]),
      evidenceRefs: workerEvidenceRefs,
      requirementId: "pi-worker-lanes",
      summary:
        "Real Pi worker lanes executed dynamic workflow steps from the pinned plan.",
    }),
    requirement({
      captured: capabilityRequirementCaptured,
      eventStates: eventStates(input.eventLog, [
        "requestingCapabilityLease",
        "executingCapability",
        "requestingReviewSurfaceDeliveryLease",
        "executingReviewSurfaceDelivery",
      ]),
      evidenceRefs: capabilityReceiptRefs,
      requirementId: "capability-lease-requests",
      summary:
        "Declared side effects are represented by capability lease receipts bound to payload hashes and review gates.",
    }),
    requirement({
      captured: verificationIsCaptured,
      eventStates: eventStates(input.eventLog, [
        "verifyingDynamicWorkflow",
        "recordingReceipts",
      ]),
      evidenceRefs: [
        ...(input.verifierLaneReceipt === undefined
          ? []
          : laneEvidenceRefs(input.verifierLaneReceipt)),
        ...(input.verificationResultArtifactRef === undefined
          ? []
          : [input.verificationResultArtifactRef]),
      ],
      requirementId: "verifier-lane",
      summary:
        "A plan-selected real Pi verifier lane or deterministic verifier inspected pinned outputs and emitted a structured verification result.",
    }),
    requirement({
      captured: true,
      eventStates: eventStates(input.eventLog, ["summarizingReview"]),
      evidenceRefs: [input.reviewSummaryRef],
      requirementId: "review-surface",
      summary:
        "The review surface document is being written with plan, package, lane, verifier, capability, and redacted artifact evidence.",
    }),
    requirement({
      captured:
        input.reviewSummaryRef.length > 0 &&
        input.artifactRefs.length > 0 &&
        observabilityPackRefs.length > 0,
      eventStates: eventStates(input.eventLog, [
        "recordingReceipts",
        "summarizingReview",
      ]),
      evidenceRefs: [
        input.reviewSummaryRef,
        ...executionProofRefs,
        ...observabilityPackRefs,
        ...capabilityReceiptRefs,
      ],
      requirementId: "captured-receipts",
      summary:
        "Receipts, observability pack, review summary, and supporting artifacts are captured for replay and audit.",
    }),
  ];
  const status = requirements.every((entry) => entry.status === "captured")
    ? "captured"
    : "incomplete";

  return {
    requirements,
    status,
    summary:
      status === "captured"
        ? "The review surface contains machine-readable evidence for the full real workflow completion chain."
        : "The review surface carries completion-chain evidence, but at least one requirement is missing or test-only.",
  };
};

export const createCloudflareArtifactsReviewSurfacePublisher = (
  config: CloudflareArtifactsReviewSurfacePublisherConfig
): ReviewSurfacePublisherPort => ({
  async publish(input) {
    const surfaceId = `review-surface:${input.plan.runId}`;
    const artifactRefs = uniqueArtifactRefs(input.artifactRefs);
    const acceptanceRefs = config.acceptanceRefs ?? [];
    const document = ReviewSurfaceDocumentSchema.parse({
      artifactRefs,
      capabilityReceipts: input.capabilityReceipts,
      definitionOfDone: {
        acceptanceRefs,
        observability: runtimeObservabilityRequirement,
        reconciliation: proposalReconciliation({
          acceptanceRefs,
          artifactRefs,
          capabilityReceipts: input.capabilityReceipts,
          eventLog: input.eventLog,
          executionProofArtifact: input.executionProofArtifact,
          plan: input.plan,
          planArtifactRef: input.planArtifact.artifactRef,
          plannerLaneReceipt: input.plannerLaneReceipt,
          reviewSummaryRef: input.reviewSummaryRef,
          ...(input.verificationResultArtifact === undefined
            ? {}
            : {
                verificationResultArtifactRef:
                  input.verificationResultArtifact.artifactRef,
              }),
          ...(input.verifierLaneReceipt === undefined
            ? {}
            : { verifierLaneReceipt: input.verifierLaneReceipt }),
          workerLaneReceipts: input.workerLaneReceipts,
        }),
        workflowChain: workflowChainCompletion({
          artifactRefs,
          capabilityReceipts: input.capabilityReceipts,
          eventLog: input.eventLog,
          executionProofArtifact: input.executionProofArtifact,
          plan: input.plan,
          planArtifactRef: input.planArtifact.artifactRef,
          plannerLaneReceipt: input.plannerLaneReceipt,
          reviewSummaryRef: input.reviewSummaryRef,
          ...(input.verificationResultArtifact === undefined
            ? {}
            : {
                verificationResultArtifactRef:
                  input.verificationResultArtifact.artifactRef,
              }),
          ...(input.verifierLaneReceipt === undefined
            ? {}
            : { verifierLaneReceipt: input.verifierLaneReceipt }),
          workerLaneReceipts: input.workerLaneReceipts,
        }),
      },
      eventLog: input.eventLog,
      generatedArtifacts: {
        executionProof: input.executionProofArtifact,
        harness: input.plan.harness,
        machine: input.plan.machine,
        verificationContract: input.plan.verificationContract,
        ...(input.verificationResultArtifact === undefined
          ? {}
          : { verificationResult: input.verificationResultArtifact }),
      },
      generatedAt: config.now?.() ?? new Date().toISOString(),
      laneReceipts: {
        planner: input.plannerLaneReceipt,
        ...(input.verifierLaneReceipt === undefined
          ? {}
          : { verifier: input.verifierLaneReceipt }),
        workers: input.workerLaneReceipts,
      },
      outputTarget: input.outputTarget,
      packages: input.plan.pinnedPackages.map((packageRef) => ({
        artifactRef: packageRef.artifactRef,
        manifestHash: packageRef.manifestHash,
        packageId: packageRef.metadata.packageId,
        title: packageRef.metadata.title,
        version: packageRef.version,
      })),
      plan: {
        artifactRef: input.planArtifact.artifactRef,
        hash: input.planArtifact.hash,
        planId: input.plan.planId,
      },
      redacted: true,
      redactedArtifactRefs: artifactRefs,
      reviewSummaryRef: input.reviewSummaryRef,
      runId: input.plan.runId,
      schemaVersion: "workflow.review-surface.v1",
      surfaceId,
      workItemId: input.plan.workItemId,
    });
    const writeReceipt = await config.artifacts.writeJson({
      path: `review/surfaces/${safePathSegment(surfaceId)}.json`,
      redacted: true,
      runId: input.plan.runId,
      value: document,
    });

    return ReviewSurfaceArtifactSchema.parse({
      artifactRef: writeReceipt.artifactRef,
      hash: writeReceipt.contentHash,
      kind: surfaceKindFor(input.outputTarget),
      mediaType: writeReceipt.mediaType,
      supportingArtifactRefs: artifactRefs,
      surfaceId,
    });
  },
});
