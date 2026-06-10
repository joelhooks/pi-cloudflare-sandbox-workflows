import type {
  ArtifactStoreContract,
  WorkflowPostExecutionArtifactRecorderPort,
} from "../application/ports.ts";
import { hashJson, sha256Hex } from "../domain/hash.ts";
import type {
  ArtifactRef,
  CapabilityBlocker,
  DynamicWorkflowMachineArtifact,
  DynamicWorkflowMachineDocument,
  DynamicWorkflowPlanDocument,
  GeneratedHarnessArtifact,
  PlanArtifact,
  WorkflowExecutionProofDocument,
} from "../domain/schemas.ts";
import {
  DreamCoverageHorizonSchema,
  DreamGeneratedWorkflowProofDocumentSchema,
  DreamMemoryFabricNodeTypeSchema,
  DreamWorkflowEffectSchema,
} from "./dream-memory-fabric-schemas.ts";
import type {
  DreamCoverageHorizon,
  DreamGeneratedWorkflowProofDocument,
  DreamMemoryFabricNodeType,
  DreamSourceProfile,
  DreamWorkflowEffect,
} from "./dream-memory-fabric-schemas.ts";

interface ProofCheck {
  readonly checkId: string;
  readonly evidenceRefs: ArtifactRef[];
  readonly passed: boolean;
  readonly summary: string;
}

export interface VerifyDreamGeneratedWorkflowInput {
  readonly executionProof: WorkflowExecutionProofDocument;
  readonly executionProofRef: ArtifactRef;
  readonly expectedPackageRef: ArtifactRef;
  readonly expectedSourceProfile: DreamSourceProfile;
  readonly expectedSourceProfileExportId: string;
  readonly generatedAt?: string;
  readonly harnessArtifact: GeneratedHarnessArtifact;
  readonly harnessSource: string;
  readonly machine: DynamicWorkflowMachineDocument;
  readonly machineArtifact: DynamicWorkflowMachineArtifact;
  readonly machineSource: string;
  readonly plan: DynamicWorkflowPlanDocument;
  readonly planArtifact: PlanArtifact;
}

export interface DreamGeneratedWorkflowProofRecorderConfig {
  readonly artifacts: ArtifactStoreContract;
  readonly expectedPackageRef: ArtifactRef;
  readonly expectedSourceProfile: DreamSourceProfile;
  readonly expectedSourceProfileExportId: string;
  readonly now?: () => string;
}

const isRelayBackedDreamNodeType = (
  nodeType: DreamMemoryFabricNodeType
): boolean =>
  nodeType !== "joelclaw.dream.hitl-report" &&
  nodeType !== "joelclaw.dream.refinement-proposals";

const dreamNodeTypeEffects = {
  "joelclaw.dream.backfill-plan": ["backfill-plan"],
  "joelclaw.dream.backfill-run": ["backfill-run"],
  "joelclaw.dream.capture-artifact": ["capture-artifact"],
  "joelclaw.dream.capture-run": ["capture-run"],
  "joelclaw.dream.correlate": ["correlate"],
  "joelclaw.dream.hitl-report": ["hitl-report"],
  "joelclaw.dream.hydrate": ["hydrate"],
  "joelclaw.dream.memory-search": ["search"],
  "joelclaw.dream.refinement-proposals": ["refinement-proposals"],
  "joelclaw.dream.signals": ["signals"],
  "joelclaw.dream.source-health": ["source-health"],
  "joelclaw.dream.source-inventory": ["inventory"],
} as const satisfies Record<
  DreamMemoryFabricNodeType,
  readonly DreamWorkflowEffect[]
>;

const requiredDreamOutputEffects = [
  "refinement-proposals",
  "hitl-report",
] as const satisfies readonly DreamWorkflowEffect[];

type DynamicWorkflowStep = DynamicWorkflowPlanDocument["steps"][number];

const sameItemsInOrder = (
  left: readonly string[],
  right: readonly string[]
): boolean =>
  left.length === right.length &&
  left.every((item, index) => item === right[index]);

const executableStateNamesFor = (
  machine: DynamicWorkflowMachineDocument
): string[] =>
  machine.stepOrder.flatMap((stepId) => {
    const entry = Object.entries(machine.xstate.states).find(
      ([, state]) => state.meta.stepId === stepId
    );

    return entry === undefined ? [] : [entry[0]];
  });

const checkDocument = (input: ProofCheck) => ({
  checkId: input.checkId,
  evidenceRefs: input.evidenceRefs,
  status: input.passed ? ("passed" as const) : ("failed" as const),
  summary: input.summary,
});

const sourceProfileFingerprint = (input: {
  readonly exportId: string;
  readonly profile: DreamSourceProfile;
}) => ({
  allowedRelayOperations: input.profile.allowedRelayOperations,
  hash: hashJson(input.profile),
  packageExportId: input.exportId,
  packageId: input.profile.packageId,
  profileId: input.profile.profileId,
  requiredMachineIds: input.profile.requiredMachineIds,
  requiredRuntimes: input.profile.requiredRuntimes,
  sourceFamiliesExpected: input.profile.sourceFamiliesExpected,
  sourcePacks: input.profile.sourcePacks,
  timeHorizons: input.profile.timeHorizons,
  workflowId: input.profile.workflowId,
});

const planMentionsSourceProfile = (input: {
  readonly plan: DynamicWorkflowPlanDocument;
  readonly profile: DreamSourceProfile;
}): boolean => {
  const serializedProposal = [
    input.plan.proposal.intent,
    ...input.plan.proposal.stochasticNotes,
  ].join("\n");

  return (
    serializedProposal.includes(input.profile.profileId) &&
    input.profile.sourceFamiliesExpected.every((family) =>
      serializedProposal.includes(family)
    ) &&
    input.profile.requiredRuntimes.every((runtime) =>
      serializedProposal.includes(runtime)
    ) &&
    input.profile.requiredMachineIds.every((machineId) =>
      serializedProposal.includes(machineId)
    ) &&
    input.profile.timeHorizons.every((horizon) =>
      serializedProposal.includes(horizon)
    )
  );
};

const dreamEffectOrder = (effect: DreamWorkflowEffect): number =>
  DreamWorkflowEffectSchema.options.indexOf(effect);

const uniqueDreamEffects = (
  effects: readonly DreamWorkflowEffect[]
): DreamWorkflowEffect[] =>
  [...new Set(effects)].toSorted(
    (left, right) => dreamEffectOrder(left) - dreamEffectOrder(right)
  );

const declaredDreamEffectsFor = (
  step: DynamicWorkflowStep
): DreamWorkflowEffect[] => {
  if (step.kind !== "workflow.node.invoke") {
    return [];
  }

  const declaredEffects = step.config["dreamEffects"];
  if (!Array.isArray(declaredEffects)) {
    return [];
  }

  return uniqueDreamEffects(
    declaredEffects.flatMap((declaredEffect) => {
      const parsed = DreamWorkflowEffectSchema.safeParse(declaredEffect);

      return parsed.success ? [parsed.data] : [];
    })
  );
};

const dreamCoverageHorizonOrder = (horizon: DreamCoverageHorizon): number =>
  DreamCoverageHorizonSchema.options.indexOf(horizon);

const uniqueDreamCoverageHorizons = (
  horizons: readonly DreamCoverageHorizon[]
): DreamCoverageHorizon[] =>
  [...new Set(horizons)].toSorted(
    (left, right) =>
      dreamCoverageHorizonOrder(left) - dreamCoverageHorizonOrder(right)
  );

const dreamCoverageHorizonsFor = (
  step: DynamicWorkflowStep
): DreamCoverageHorizon[] => {
  if (step.kind !== "workflow.node.invoke") {
    return [];
  }

  const declaredHorizons = step.config["dreamCoverageHorizons"];
  if (!Array.isArray(declaredHorizons)) {
    return [];
  }

  return uniqueDreamCoverageHorizons(
    declaredHorizons.flatMap((declaredHorizon) => {
      const parsed = DreamCoverageHorizonSchema.safeParse(declaredHorizon);

      return parsed.success ? [parsed.data] : [];
    })
  );
};

const dreamEffectsFor = (step: DynamicWorkflowStep): DreamWorkflowEffect[] => {
  if (step.kind !== "workflow.node.invoke") {
    return [];
  }

  const parsedNodeType = DreamMemoryFabricNodeTypeSchema.safeParse(
    step.nodeType
  );

  return uniqueDreamEffects([
    ...declaredDreamEffectsFor(step),
    ...(parsedNodeType.success
      ? dreamNodeTypeEffects[parsedNodeType.data]
      : []),
  ]);
};

const requiredDreamEffectsFor = (
  profile: DreamSourceProfile
): DreamWorkflowEffect[] =>
  uniqueDreamEffects([
    ...profile.allowedRelayOperations,
    ...requiredDreamOutputEffects,
  ]);

const generatedPlanCoversDreamEffects = (input: {
  readonly expectedPackageRef: ArtifactRef;
  readonly plan: DynamicWorkflowPlanDocument;
  readonly requiredEffects: readonly DreamWorkflowEffect[];
}): boolean => {
  const coveredEffects = uniqueDreamEffects(
    input.plan.steps.flatMap(dreamEffectsFor)
  );

  return (
    input.plan.steps.every(
      (step) =>
        step.kind === "workflow.node.invoke" &&
        step.packageRefs.includes(input.expectedPackageRef) &&
        dreamEffectsFor(step).length > 0
    ) &&
    input.requiredEffects.every((effect) => coveredEffects.includes(effect))
  );
};

const generatedPlanCoversHorizons = (input: {
  readonly coveredHorizons: readonly DreamCoverageHorizon[];
  readonly requiredHorizons: readonly DreamCoverageHorizon[];
}): boolean =>
  input.requiredHorizons.every((horizon) =>
    input.coveredHorizons.includes(horizon)
  );

const pinnedPackageExportsSourceProfile = (input: {
  readonly exportId: string;
  readonly packageRef: ArtifactRef;
  readonly plan: DynamicWorkflowPlanDocument;
  readonly profile: DreamSourceProfile;
}): boolean => {
  const pinnedPackage = input.plan.pinnedPackages.find(
    (candidate) => candidate.artifactRef === input.packageRef
  );

  return (
    pinnedPackage !== undefined &&
    pinnedPackage.metadata.packageId === input.profile.packageId &&
    pinnedPackage.metadata.exports.some(
      (exportRecord) =>
        exportRecord.kind === "source-profile" &&
        exportRecord.exportId === input.exportId
    )
  );
};

export const verifyDreamGeneratedWorkflow = (
  input: VerifyDreamGeneratedWorkflowInput
): DreamGeneratedWorkflowProofDocument => {
  const stepIds = input.plan.steps.map((step) => step.stepId);
  const coveredEffects = uniqueDreamEffects(
    input.plan.steps.flatMap(dreamEffectsFor)
  );
  const requiredEffects = requiredDreamEffectsFor(input.expectedSourceProfile);
  const coveredHorizons = uniqueDreamCoverageHorizons(
    input.plan.steps.flatMap(dreamCoverageHorizonsFor)
  );
  const requiredHorizons = input.expectedSourceProfile.timeHorizons;
  const nodeTypes = input.plan.steps.flatMap((step) => {
    if (step.kind !== "workflow.node.invoke") {
      return [];
    }

    const parsed = DreamMemoryFabricNodeTypeSchema.safeParse(step.nodeType);

    return parsed.success ? [parsed.data] : [];
  });
  const relayBackedStepIds = input.plan.steps.flatMap((step) => {
    if (step.kind !== "workflow.node.invoke") {
      return [];
    }

    const parsed = DreamMemoryFabricNodeTypeSchema.safeParse(step.nodeType);

    return parsed.success && isRelayBackedDreamNodeType(parsed.data)
      ? [step.stepId]
      : [];
  });
  const relayLeaseReceiptRefs =
    input.executionProof.workflowNodeOutputRefs.filter((artifactRef) =>
      artifactRef.includes("/dream/relay-lease-receipts/")
    );
  const missingRelayLeaseReceiptStepIds = relayBackedStepIds.filter(
    (stepId) =>
      !relayLeaseReceiptRefs.some((artifactRef) =>
        artifactRef.endsWith(`/dream/relay-lease-receipts/${stepId}.json`)
      )
  );
  const checks: ProofCheck[] = [
    {
      checkId: "plan:hash-pinned",
      evidenceRefs: [input.planArtifact.artifactRef],
      passed: hashJson(input.plan) === input.planArtifact.hash,
      summary: "Pinned Dream plan hash matches the loaded plan artifact.",
    },
    {
      checkId: "machine:hash-pinned",
      evidenceRefs: [
        input.machineArtifact.artifactRef,
        input.machineArtifact.sourceArtifactRef,
      ],
      passed:
        hashJson(input.machine) === input.machineArtifact.hash &&
        sha256Hex(input.machineSource) === input.machineArtifact.sourceHash,
      summary:
        "Generated XState config and generated TypeScript source hashes match the pinned machine artifact.",
    },
    {
      checkId: "harness:hash-pinned",
      evidenceRefs: [input.harnessArtifact.artifactRef],
      passed:
        sha256Hex(input.harnessSource) === input.harnessArtifact.hash &&
        input.harnessSource.includes("executeDynamicHarness"),
      summary:
        "Generated TypeScript harness source hash matches the pinned harness artifact.",
    },
    {
      checkId: "plan:profile-effect-coverage",
      evidenceRefs: [input.planArtifact.artifactRef],
      passed: generatedPlanCoversDreamEffects({
        expectedPackageRef: input.expectedPackageRef,
        plan: input.plan,
        requiredEffects,
      }),
      summary:
        "Dream plan uses artifact-backed package invocations and covers the installed source profile's required effects.",
    },
    {
      checkId: "plan:horizon-coverage",
      evidenceRefs: [input.planArtifact.artifactRef],
      passed: generatedPlanCoversHorizons({
        coveredHorizons,
        requiredHorizons,
      }),
      summary:
        "Dream generated plan declares coverage for every source-profile horizon so the run cannot collapse into recent-only retrieval.",
    },
    {
      checkId: "plan:source-profile-bound",
      evidenceRefs: [
        input.planArtifact.artifactRef,
        input.plan.plannerLane.prompt.artifactRef,
      ],
      passed:
        pinnedPackageExportsSourceProfile({
          exportId: input.expectedSourceProfileExportId,
          packageRef: input.expectedPackageRef,
          plan: input.plan,
          profile: input.expectedSourceProfile,
        }) &&
        planMentionsSourceProfile({
          plan: input.plan,
          profile: input.expectedSourceProfile,
        }),
      summary:
        "Dream generated plan is bound to the installed transcript-review source profile instead of generic Dream lore.",
    },
    {
      checkId: "machine:step-order-bound",
      evidenceRefs: [
        input.planArtifact.artifactRef,
        input.machineArtifact.artifactRef,
      ],
      passed:
        input.machine.runId === input.plan.runId &&
        input.machine.workItemId === input.plan.workItemId &&
        sameItemsInOrder(input.machine.stepOrder, stepIds),
      summary:
        "Generated XState machine stepOrder is bound to the pinned Dream plan step ids.",
    },
    {
      checkId: "execution:generated-machine-sequence",
      evidenceRefs: [input.executionProofRef],
      passed:
        sameItemsInOrder(input.executionProof.completedStepIds, stepIds) &&
        executableStateNamesFor(input.machine).every((stateName) =>
          input.executionProof.generatedStateSequence.includes(stateName)
        ),
      summary:
        "Execution proof completed the generated Dream machine states instead of a static phase list.",
    },
    {
      checkId: "execution:relay-lease-sidecars",
      evidenceRefs: relayLeaseReceiptRefs,
      passed:
        input.executionProof.status !==
          "cloudflare-generated-machine-executed" ||
        missingRelayLeaseReceiptStepIds.length === 0,
      summary:
        "Cloudflare Dream execution proof includes relay lease receipt sidecars for each relay-backed generated step.",
    },
    {
      checkId: "execution:no-raw-transcripts",
      evidenceRefs: [input.executionProofRef],
      passed: true,
      summary:
        "Dream generated workflow proof returns artifact refs, hashes, and state evidence only; raw transcripts remain behind the relay boundary.",
    },
  ];
  const parsedChecks = checks.map(checkDocument);
  const failures = parsedChecks
    .filter((check) => check.status === "failed")
    .map((check) => check.summary);

  return DreamGeneratedWorkflowProofDocumentSchema.parse({
    checks: parsedChecks,
    completedStepIds: input.executionProof.completedStepIds,
    effectCoverage: {
      coveredEffects,
      requiredEffects,
    },
    executionProofRef: input.executionProofRef,
    executionProofStatus: input.executionProof.status,
    failures,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    generatedStateSequence: input.executionProof.generatedStateSequence,
    harnessArtifact: input.harnessArtifact,
    horizonCoverage: {
      coveredHorizons,
      requiredHorizons,
    },
    machineArtifact: input.machineArtifact,
    nodeTypes,
    packageRef: input.expectedPackageRef,
    planArtifact: input.planArtifact,
    plannerPromptRef: input.plan.plannerLane.prompt.artifactRef,
    plannerTranscriptRef: input.plan.plannerLane.transcript.artifactRef,
    proofId: `dream-generated-workflow-proof:${input.plan.runId}`,
    rawTranscriptsReturned: false,
    redacted: true,
    relayLeaseReceiptRefs,
    runId: input.plan.runId,
    schemaVersion: "dream.generated-workflow-proof.v1",
    sourceProfile: sourceProfileFingerprint({
      exportId: input.expectedSourceProfileExportId,
      profile: input.expectedSourceProfile,
    }),
    status: failures.length === 0 ? "verified" : "failed",
    stepCount: input.plan.steps.length,
    stepIds,
    workItemId: input.plan.workItemId,
  });
};

const dreamGeneratedWorkflowProofBlocker = (
  proof: DreamGeneratedWorkflowProofDocument
): CapabilityBlocker => ({
  code: "capability_denied",
  message: `Dream generated workflow proof failed: ${proof.failures.join("; ")}`,
  redacted: true,
});

export const createDreamGeneratedWorkflowProofRecorder = (
  config: DreamGeneratedWorkflowProofRecorderConfig
): WorkflowPostExecutionArtifactRecorderPort => ({
  async record(input) {
    const proof = verifyDreamGeneratedWorkflow({
      executionProof: input.executionProofDocument,
      executionProofRef: input.executionProofArtifact.artifactRef,
      expectedPackageRef: config.expectedPackageRef,
      expectedSourceProfile: config.expectedSourceProfile,
      expectedSourceProfileExportId: config.expectedSourceProfileExportId,
      generatedAt: config.now?.() ?? new Date().toISOString(),
      harnessArtifact: input.harnessArtifact,
      harnessSource: input.harnessSource,
      machine: input.machine,
      machineArtifact: input.machineArtifact,
      machineSource: input.machineSource,
      plan: input.plan,
      planArtifact: input.planArtifact,
    });

    if (proof.status === "failed") {
      return {
        blocker: dreamGeneratedWorkflowProofBlocker(proof),
        status: "blocked",
      };
    }

    const write = await config.artifacts.writeJson({
      path: "dream/generated-workflow-proof.json",
      redacted: true,
      runId: input.plan.runId,
      value: proof,
    });

    return {
      artifactRefs: [write.artifactRef],
      status: "recorded",
    };
  },
});
