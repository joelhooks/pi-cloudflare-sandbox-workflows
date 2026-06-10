import { z } from "zod";

import type {
  ArtifactStoreContract,
  WorkflowPostExecutionArtifactRecorderPort,
} from "../application/ports.ts";
import { hashJson, sha256Hex } from "../domain/hash.ts";
import {
  ArtifactRefSchema,
  IsoDateTimeSchema,
  Sha256HexSchema,
} from "../domain/schemas.ts";
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
  MemoryCoverageHorizonSchema,
  MemoryFabricNodeTypeSchema,
  MemoryRelayOperationSchema,
  MemoryRuntimeSchema,
  MemorySourceFamilySchema,
  MemorySourcePackDispositionSchema,
  MemorySourcePackSchema,
  MemoryWorkflowEffectSchema,
} from "../domain/source-profile.ts";
import type {
  MemoryCoverageHorizon,
  MemorySourcePack,
  MemorySourcePackDisposition,
  MemorySourceProfile,
  MemoryWorkflowEffect,
} from "../domain/source-profile.ts";

export const MemoryGeneratedWorkflowProofCheckSchema = z.object({
  checkId: z.string().min(1),
  evidenceRefs: z.array(ArtifactRefSchema).default([]),
  status: z.enum(["failed", "passed"]),
  summary: z.string().min(1),
});

export const MemoryGeneratedWorkflowProofDocumentSchema = z.object({
  checks: z.array(MemoryGeneratedWorkflowProofCheckSchema).min(1),
  completedStepIds: z.array(z.string().min(1)),
  effectCoverage: z.object({
    coveredEffects: z.array(MemoryWorkflowEffectSchema),
    requiredEffects: z.array(MemoryWorkflowEffectSchema).min(1),
  }),
  executionProofRef: ArtifactRefSchema,
  executionProofStatus: z.string().min(1),
  failures: z.array(z.string().min(1)).default([]),
  generatedAt: IsoDateTimeSchema,
  generatedStateSequence: z.array(z.string().min(1)).min(1),
  harnessArtifact: z.object({
    artifactRef: ArtifactRefSchema,
    entrypoint: z.literal("workflows/harness.ts"),
    harnessId: z.string().min(1),
    hash: Sha256HexSchema,
    language: z.literal("typescript"),
  }),
  horizonCoverage: z.object({
    coveredHorizons: z.array(MemoryCoverageHorizonSchema),
    requiredHorizons: z.array(MemoryCoverageHorizonSchema).min(1),
  }),
  machineArtifact: z.object({
    artifactRef: ArtifactRefSchema,
    hash: Sha256HexSchema,
    machineId: z.string().min(1),
    sourceArtifactRef: ArtifactRefSchema,
    sourceHash: Sha256HexSchema,
  }),
  nodeTypes: z.array(MemoryFabricNodeTypeSchema),
  packageRef: ArtifactRefSchema,
  planArtifact: z.object({
    artifactRef: ArtifactRefSchema,
    hash: Sha256HexSchema,
    pinnedAt: IsoDateTimeSchema,
    runId: z.string().min(1),
  }),
  plannerPromptRef: ArtifactRefSchema,
  plannerTranscriptRef: ArtifactRefSchema,
  proofId: z.string().min(1),
  rawTranscriptsReturned: z.literal(false),
  redacted: z.literal(true),
  relayLeaseReceiptRefs: z.array(ArtifactRefSchema).default([]),
  runId: z.string().min(1),
  schemaVersion: z.literal("memory.generated-workflow-proof.v1"),
  sourcePackDisposition: z.object({
    dispositionCount: z.number().int().min(0),
    dispositions: z.array(MemorySourcePackDispositionSchema).default([]),
    expectedPackIds: z.array(z.string().min(1)).default([]),
    missingPackIds: z.array(z.string().min(1)).default([]),
    unexpectedPackIds: z.array(z.string().min(1)).default([]),
  }),
  sourceProfile: z.object({
    allowedRelayOperations: z.array(MemoryRelayOperationSchema).min(1),
    hash: Sha256HexSchema,
    packageExportId: z.string().min(1),
    packageId: z.string().min(1),
    profileId: z.string().min(1),
    requiredOutputEffects: z.array(MemoryWorkflowEffectSchema),
    requiredRuntimes: z.array(MemoryRuntimeSchema).min(1),
    sourceFamiliesExpected: z.array(MemorySourceFamilySchema).min(1),
    sourcePacks: z.array(MemorySourcePackSchema).default([]),
    timeHorizons: z.array(MemoryCoverageHorizonSchema).min(1),
    workflowId: z.string().min(1),
  }),
  status: z.enum(["failed", "verified"]),
  stepCount: z.number().int().min(1),
  stepIds: z.array(z.string().min(1)).min(1),
  workItemId: z.string().min(1),
});

export type MemoryGeneratedWorkflowProofDocument = z.infer<
  typeof MemoryGeneratedWorkflowProofDocumentSchema
>;

export interface MemoryGeneratedWorkflowAdditionalProofCheck {
  readonly checkId: string;
  readonly evidenceRefs: ArtifactRef[];
  readonly passed: boolean;
  readonly summary: string;
}

type ProofCheck = MemoryGeneratedWorkflowAdditionalProofCheck;

export interface VerifyMemoryGeneratedWorkflowInput {
  readonly executionProof: WorkflowExecutionProofDocument;
  readonly executionProofRef: ArtifactRef;
  readonly expectedPackageRef: ArtifactRef;
  readonly expectedSourceProfile: MemorySourceProfile;
  readonly expectedSourceProfileExportId: string;
  readonly extraChecks?: readonly MemoryGeneratedWorkflowAdditionalProofCheck[];
  readonly generatedAt?: string;
  readonly harnessArtifact: GeneratedHarnessArtifact;
  readonly harnessSource: string;
  readonly machine: DynamicWorkflowMachineDocument;
  readonly machineArtifact: DynamicWorkflowMachineArtifact;
  readonly machineSource: string;
  readonly plan: DynamicWorkflowPlanDocument;
  readonly planArtifact: PlanArtifact;
}

export interface MemoryGeneratedWorkflowProofRecorderConfig {
  readonly artifacts: ArtifactStoreContract;
  readonly buildAdditionalProofChecks?: (input: {
    readonly executionProof: WorkflowExecutionProofDocument;
    readonly plan: DynamicWorkflowPlanDocument;
  }) => Promise<readonly MemoryGeneratedWorkflowAdditionalProofCheck[]>;
  readonly expectedPackageRef: ArtifactRef;
  readonly expectedSourceProfile: MemorySourceProfile;
  readonly expectedSourceProfileExportId: string;
  readonly now?: () => string;
}

type DynamicWorkflowStep = DynamicWorkflowPlanDocument["steps"][number];

/**
 * Node-type-to-effect declarations come from the pinned package data (the
 * cartridge exports its node palette with effect declarations), never from
 * platform constants.
 */
type WorkflowNodeEffectsByNodeType = ReadonlyMap<
  string,
  readonly MemoryWorkflowEffect[]
>;

const workflowNodeEffectsForPinnedPackage = (input: {
  readonly expectedPackageRef: ArtifactRef;
  readonly plan: DynamicWorkflowPlanDocument;
}): WorkflowNodeEffectsByNodeType =>
  new Map(
    (
      input.plan.pinnedPackages.find(
        (candidate) => candidate.artifactRef === input.expectedPackageRef
      )?.metadata.exports ?? []
    ).flatMap((exportRecord) =>
      exportRecord.kind === "workflow-node" &&
      exportRecord.nodeType !== undefined
        ? [[exportRecord.nodeType, exportRecord.effects ?? []] as const]
        : []
    )
  );

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
  readonly profile: MemorySourceProfile;
}) => ({
  allowedRelayOperations: input.profile.allowedRelayOperations,
  hash: hashJson(input.profile),
  packageExportId: input.exportId,
  packageId: input.profile.packageId,
  profileId: input.profile.profileId,
  requiredOutputEffects: input.profile.requiredOutputEffects,
  requiredRuntimes: input.profile.requiredRuntimes,
  sourceFamiliesExpected: input.profile.sourceFamiliesExpected,
  sourcePacks: input.profile.sourcePacks,
  timeHorizons: input.profile.timeHorizons,
  workflowId: input.profile.workflowId,
});

const planMentionsSourceProfile = (input: {
  readonly plan: DynamicWorkflowPlanDocument;
  readonly profile: MemorySourceProfile;
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
    input.profile.timeHorizons.every((horizon) =>
      serializedProposal.includes(horizon)
    )
  );
};

const uniqueMemoryEffects = (
  effects: readonly MemoryWorkflowEffect[]
): MemoryWorkflowEffect[] => [...new Set(effects)].toSorted();

const declaredMemoryEffectsFor = (
  step: DynamicWorkflowStep
): MemoryWorkflowEffect[] => {
  if (step.kind !== "workflow.node.invoke") {
    return [];
  }

  const declaredEffects = step.config["memoryEffects"];
  if (!Array.isArray(declaredEffects)) {
    return [];
  }

  return uniqueMemoryEffects(
    declaredEffects.flatMap((declaredEffect) => {
      const parsed = MemoryWorkflowEffectSchema.safeParse(declaredEffect);

      return parsed.success ? [parsed.data] : [];
    })
  );
};

const memoryCoverageHorizonOrder = (horizon: MemoryCoverageHorizon): number =>
  MemoryCoverageHorizonSchema.options.indexOf(horizon);

const uniqueMemoryCoverageHorizons = (
  horizons: readonly MemoryCoverageHorizon[]
): MemoryCoverageHorizon[] =>
  [...new Set(horizons)].toSorted(
    (left, right) =>
      memoryCoverageHorizonOrder(left) - memoryCoverageHorizonOrder(right)
  );

const memoryCoverageHorizonsFor = (
  step: DynamicWorkflowStep
): MemoryCoverageHorizon[] => {
  if (step.kind !== "workflow.node.invoke") {
    return [];
  }

  const declaredHorizons = step.config["memoryCoverageHorizons"];
  if (!Array.isArray(declaredHorizons)) {
    return [];
  }

  return uniqueMemoryCoverageHorizons(
    declaredHorizons.flatMap((declaredHorizon) => {
      const parsed = MemoryCoverageHorizonSchema.safeParse(declaredHorizon);

      return parsed.success ? [parsed.data] : [];
    })
  );
};

const memorySourcePackDispositionsFor = (
  step: DynamicWorkflowStep
): MemorySourcePackDisposition[] => {
  if (step.kind !== "workflow.node.invoke") {
    return [];
  }

  const declaredDispositions = step.config["memorySourcePackDispositions"];
  if (!Array.isArray(declaredDispositions)) {
    return [];
  }

  return declaredDispositions.flatMap((declaredDisposition) => {
    const parsed =
      MemorySourcePackDispositionSchema.safeParse(declaredDisposition);

    return parsed.success ? [parsed.data] : [];
  });
};

const sourcePackDispositionsFor = (
  plan: DynamicWorkflowPlanDocument
): MemorySourcePackDisposition[] => {
  const dispositionByPackId = new Map<string, MemorySourcePackDisposition>();
  for (const disposition of plan.steps.flatMap(
    memorySourcePackDispositionsFor
  )) {
    if (!dispositionByPackId.has(disposition.packId)) {
      dispositionByPackId.set(disposition.packId, disposition);
    }
  }

  return [...dispositionByPackId.values()];
};

const capabilityKindsCoverPack = (input: {
  readonly disposition: MemorySourcePackDisposition;
  readonly pack: MemorySourcePack;
}): boolean =>
  input.pack.requiredCapabilityKinds.every((capabilityKind) =>
    input.disposition.capabilityKinds.includes(capabilityKind)
  );

const missingCapabilityKindsForPack = (input: {
  readonly disposition: MemorySourcePackDisposition;
  readonly pack: MemorySourcePack;
}): string[] =>
  input.pack.requiredCapabilityKinds.filter(
    (capabilityKind) =>
      !input.disposition.capabilityKinds.includes(capabilityKind)
  );

const dispositionMatchesPack = (input: {
  readonly disposition: MemorySourcePackDisposition;
  readonly pack: MemorySourcePack;
}): boolean =>
  input.disposition.packageId === input.pack.packageId &&
  input.disposition.selectionPolicy === input.pack.selectionPolicy &&
  sameItemsInOrder(
    input.disposition.requiredCapabilityKinds,
    input.pack.requiredCapabilityKinds
  ) &&
  sameItemsInOrder(
    input.disposition.sourceFamilies,
    input.pack.sourceFamilies
  ) &&
  sameItemsInOrder(input.disposition.surfaces, input.pack.surfaces);

const dispositionStatusMatchesPolicy = (input: {
  readonly disposition: MemorySourcePackDisposition;
  readonly pack: MemorySourcePack;
}): boolean => {
  if (!dispositionMatchesPack(input)) {
    return false;
  }

  if (input.pack.selectionPolicy === "default") {
    return input.disposition.status === "selected-by-default";
  }

  if (input.pack.selectionPolicy === "optional-lease") {
    const missingCapabilityKinds = missingCapabilityKindsForPack(input);

    return (
      (input.disposition.status === "skipped-missing-lease" &&
        input.disposition.leaseRefs.length === 0 &&
        missingCapabilityKinds.length > 0 &&
        sameItemsInOrder(
          input.disposition.missingCapabilityKinds,
          missingCapabilityKinds
        )) ||
      (input.disposition.status === "selected-with-lease" &&
        capabilityKindsCoverPack(input) &&
        input.disposition.leaseRefs.length > 0 &&
        input.disposition.missingCapabilityKinds.length === 0)
    );
  }

  return input.disposition.status === "separate-workflow-candidate";
};

const sourcePackDispositionSummaryFor = (input: {
  readonly dispositions: readonly MemorySourcePackDisposition[];
  readonly sourcePacks: readonly MemorySourcePack[];
}) => {
  const expectedPackIds = input.sourcePacks.map((pack) => pack.packId);
  const declaredPackIds = input.dispositions.map(
    (disposition) => disposition.packId
  );

  return {
    dispositionCount: input.dispositions.length,
    dispositions: input.dispositions,
    expectedPackIds,
    missingPackIds: expectedPackIds.filter(
      (packId) => !declaredPackIds.includes(packId)
    ),
    unexpectedPackIds: declaredPackIds.filter(
      (packId) => !expectedPackIds.includes(packId)
    ),
  };
};

const generatedPlanDisposesSourcePacks = (input: {
  readonly dispositions: readonly MemorySourcePackDisposition[];
  readonly sourcePacks: readonly MemorySourcePack[];
}): boolean => {
  const dispositionByPackId = new Map(
    input.dispositions.map((disposition) => [disposition.packId, disposition])
  );

  return (
    input.dispositions.every((disposition) =>
      input.sourcePacks.some((pack) => pack.packId === disposition.packId)
    ) &&
    input.sourcePacks.every((pack) => {
      const disposition = dispositionByPackId.get(pack.packId);

      return (
        disposition !== undefined &&
        dispositionStatusMatchesPolicy({ disposition, pack })
      );
    })
  );
};

const memoryEffectsFor = (
  step: DynamicWorkflowStep,
  nodeEffects: WorkflowNodeEffectsByNodeType
): MemoryWorkflowEffect[] => {
  if (step.kind !== "workflow.node.invoke") {
    return [];
  }

  return uniqueMemoryEffects([
    ...declaredMemoryEffectsFor(step),
    ...(nodeEffects.get(step.nodeType) ?? []),
  ]);
};

const requiredMemoryEffectsFor = (
  profile: MemorySourceProfile
): MemoryWorkflowEffect[] =>
  uniqueMemoryEffects([
    ...MemoryWorkflowEffectSchema.array().parse(profile.allowedRelayOperations),
    ...profile.requiredOutputEffects,
  ]);

const relayBackedStepIdsFor = (input: {
  readonly nodeEffects: WorkflowNodeEffectsByNodeType;
  readonly plan: DynamicWorkflowPlanDocument;
  readonly profile: MemorySourceProfile;
}): string[] => {
  const relayOperations = new Set<string>(input.profile.allowedRelayOperations);

  return input.plan.steps.flatMap((step) =>
    step.kind === "workflow.node.invoke" &&
    memoryEffectsFor(step, input.nodeEffects).some((effect) =>
      relayOperations.has(effect)
    )
      ? [step.stepId]
      : []
  );
};

const generatedPlanCoversMemoryEffects = (input: {
  readonly expectedPackageRef: ArtifactRef;
  readonly nodeEffects: WorkflowNodeEffectsByNodeType;
  readonly plan: DynamicWorkflowPlanDocument;
  readonly requiredEffects: readonly MemoryWorkflowEffect[];
}): boolean => {
  const coveredEffects = uniqueMemoryEffects(
    input.plan.steps.flatMap((step) =>
      memoryEffectsFor(step, input.nodeEffects)
    )
  );

  return (
    input.plan.steps.every(
      (step) =>
        step.kind === "workflow.node.invoke" &&
        step.packageRefs.includes(input.expectedPackageRef) &&
        memoryEffectsFor(step, input.nodeEffects).length > 0
    ) &&
    input.requiredEffects.every((effect) => coveredEffects.includes(effect))
  );
};

const generatedPlanCoversHorizons = (input: {
  readonly coveredHorizons: readonly MemoryCoverageHorizon[];
  readonly requiredHorizons: readonly MemoryCoverageHorizon[];
}): boolean =>
  input.requiredHorizons.every((horizon) =>
    input.coveredHorizons.includes(horizon)
  );

const pinnedPackageExportsSourceProfile = (input: {
  readonly exportId: string;
  readonly packageRef: ArtifactRef;
  readonly plan: DynamicWorkflowPlanDocument;
  readonly profile: MemorySourceProfile;
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

export const verifyMemoryGeneratedWorkflow = (
  input: VerifyMemoryGeneratedWorkflowInput
): MemoryGeneratedWorkflowProofDocument => {
  const stepIds = input.plan.steps.map((step) => step.stepId);
  const nodeEffects = workflowNodeEffectsForPinnedPackage({
    expectedPackageRef: input.expectedPackageRef,
    plan: input.plan,
  });
  const coveredEffects = uniqueMemoryEffects(
    input.plan.steps.flatMap((step) => memoryEffectsFor(step, nodeEffects))
  );
  const requiredEffects = requiredMemoryEffectsFor(input.expectedSourceProfile);
  const coveredHorizons = uniqueMemoryCoverageHorizons(
    input.plan.steps.flatMap(memoryCoverageHorizonsFor)
  );
  const requiredHorizons = input.expectedSourceProfile.timeHorizons;
  const sourcePackDisposition = sourcePackDispositionSummaryFor({
    dispositions: sourcePackDispositionsFor(input.plan),
    sourcePacks: input.expectedSourceProfile.sourcePacks,
  });
  const nodeTypes = input.plan.steps.flatMap((step) => {
    if (step.kind !== "workflow.node.invoke") {
      return [];
    }

    const parsed = MemoryFabricNodeTypeSchema.safeParse(step.nodeType);

    return parsed.success ? [parsed.data] : [];
  });
  const relayBackedStepIds = relayBackedStepIdsFor({
    nodeEffects,
    plan: input.plan,
    profile: input.expectedSourceProfile,
  });
  const relayLeaseReceiptRefs =
    input.executionProof.workflowNodeOutputRefs.filter((artifactRef) =>
      artifactRef.includes("/memory/relay-lease-receipts/")
    );
  const missingRelayLeaseReceiptStepIds = relayBackedStepIds.filter(
    (stepId) =>
      !relayLeaseReceiptRefs.some((artifactRef) =>
        artifactRef.endsWith(`/memory/relay-lease-receipts/${stepId}.json`)
      )
  );
  const checks: ProofCheck[] = [
    {
      checkId: "plan:hash-pinned",
      evidenceRefs: [input.planArtifact.artifactRef],
      passed: hashJson(input.plan) === input.planArtifact.hash,
      summary: "Pinned plan hash matches the loaded plan artifact.",
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
      passed: generatedPlanCoversMemoryEffects({
        expectedPackageRef: input.expectedPackageRef,
        nodeEffects,
        plan: input.plan,
        requiredEffects,
      }),
      summary:
        "Generated plan uses artifact-backed package invocations and covers the installed source profile's required effects.",
    },
    {
      checkId: "plan:horizon-coverage",
      evidenceRefs: [input.planArtifact.artifactRef],
      passed: generatedPlanCoversHorizons({
        coveredHorizons,
        requiredHorizons,
      }),
      summary:
        "Generated plan declares coverage for every source-profile horizon so the run cannot collapse into recent-only retrieval.",
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
        "Generated plan is bound to the installed source profile instead of generic workflow lore.",
    },
    {
      checkId: "plan:source-pack-disposition",
      evidenceRefs: [input.planArtifact.artifactRef],
      passed: generatedPlanDisposesSourcePacks({
        dispositions: sourcePackDisposition.dispositions,
        sourcePacks: input.expectedSourceProfile.sourcePacks,
      }),
      summary:
        "Generated plan explicitly declares whether each advertised source pack was selected under leases, skipped for missing leases, or saved as a separate workflow candidate.",
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
        "Generated XState machine stepOrder is bound to the pinned plan step ids.",
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
        "Execution proof completed the generated machine states instead of a static phase list.",
    },
    {
      checkId: "execution:relay-lease-sidecars",
      evidenceRefs: relayLeaseReceiptRefs,
      passed:
        input.executionProof.status !==
          "cloudflare-generated-machine-executed" ||
        missingRelayLeaseReceiptStepIds.length === 0,
      summary:
        "Cloudflare execution proof includes relay lease receipt sidecars for each relay-backed generated step.",
    },
    {
      checkId: "execution:no-raw-transcripts",
      evidenceRefs: [input.executionProofRef],
      passed: true,
      summary:
        "Memory generated workflow proof returns artifact refs, hashes, and state evidence only; raw transcripts remain behind the relay boundary.",
    },
    ...(input.extraChecks ?? []),
  ];
  const parsedChecks = checks.map(checkDocument);
  const failures = parsedChecks
    .filter((check) => check.status === "failed")
    .map((check) => check.summary);

  return MemoryGeneratedWorkflowProofDocumentSchema.parse({
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
    proofId: `memory-generated-workflow-proof:${input.plan.runId}`,
    rawTranscriptsReturned: false,
    redacted: true,
    relayLeaseReceiptRefs,
    runId: input.plan.runId,
    schemaVersion: "memory.generated-workflow-proof.v1",
    sourcePackDisposition,
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

const memoryGeneratedWorkflowProofBlocker = (
  proof: MemoryGeneratedWorkflowProofDocument
): CapabilityBlocker => ({
  code: "capability_denied",
  message: `Memory generated workflow proof failed: ${proof.failures.join("; ")}`,
  redacted: true,
});

export const createMemoryGeneratedWorkflowProofRecorder = (
  config: MemoryGeneratedWorkflowProofRecorderConfig
): WorkflowPostExecutionArtifactRecorderPort => ({
  async record(input) {
    const extraChecks =
      (await config.buildAdditionalProofChecks?.({
        executionProof: input.executionProofDocument,
        plan: input.plan,
      })) ?? [];
    const proof = verifyMemoryGeneratedWorkflow({
      executionProof: input.executionProofDocument,
      executionProofRef: input.executionProofArtifact.artifactRef,
      expectedPackageRef: config.expectedPackageRef,
      expectedSourceProfile: config.expectedSourceProfile,
      expectedSourceProfileExportId: config.expectedSourceProfileExportId,
      extraChecks,
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
        blocker: memoryGeneratedWorkflowProofBlocker(proof),
        status: "blocked",
      };
    }

    const write = await config.artifacts.writeJson({
      path: "memory/generated-workflow-proof.json",
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
