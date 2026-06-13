import { z } from "zod";

import type {
  ArtifactStoreContract,
  WorkflowNodeAdapterPort,
  WorkflowNodeExecutionResult,
  WorkflowNodeInvocationStep,
} from "../../app/application/ports.ts";
import { hashJson, sha256Hex } from "../../app/domain/hash.ts";
import type {
  ArtifactRef,
  CapabilityBlocker,
  DynamicWorkflowPlanDocument,
} from "../../app/domain/schemas.ts";
import { ArtifactRefSchema } from "../../app/domain/schemas.ts";
import { MemoryCoverageHorizonSchema } from "../../app/domain/source-profile.ts";
import {
  AiHeroSupportSweepDraftSideEffectDocumentSchema,
  AiHeroSupportSweepHydrationDocumentSchema,
  AiHeroSupportSweepHydrationPayloadSchema,
  AiHeroSupportSweepIndexHealthDocumentSchema,
  AiHeroSupportSweepIndexHealthPayloadSchema,
  AiHeroSupportSweepInventoryDocumentSchema,
  AiHeroSupportSweepInventoryPayloadSchema,
  AiHeroSupportSweepRecommendationDocumentSchema,
  AiHeroSupportSweepSearchAxisSchema,
  AiHeroSupportSweepSignalSearchDocumentSchema,
  AiHeroSupportSweepSignalSearchPayloadSchema,
  AiHeroSupportSweepSourceFamilySchema,
} from "./schemas.ts";
import type {
  AiHeroSupportSweepDraftAction,
  AiHeroSupportSweepDraftSideEffectDocument,
  AiHeroSupportSweepHydrationDocument,
  AiHeroSupportSweepIndexHealthDocument,
  AiHeroSupportSweepInventoryDocument,
  AiHeroSupportSweepInventoryPayload,
  AiHeroSupportSweepIndexHealthPayload,
  AiHeroSupportSweepHydrationPayload,
  AiHeroSupportSweepNodeOutputDocument,
  AiHeroSupportSweepReceipt,
  AiHeroSupportSweepRecommendation,
  AiHeroSupportSweepRecommendationDocument,
  AiHeroSupportSweepSignal,
  AiHeroSupportSweepSignalSearchDocument,
  AiHeroSupportSweepSignalSearchPayload,
} from "./schemas.ts";

export type AiHeroSupportSweepResult<TDocument> =
  | {
      readonly blocker: CapabilityBlocker;
      readonly status: "blocked";
    }
  | {
      readonly document: TDocument;
      readonly status: "ready";
    };

export interface AiHeroSupportSweepDataPort {
  checkIndexHealth(
    input: AiHeroSupportSweepIndexHealthPayload
  ): Promise<AiHeroSupportSweepResult<AiHeroSupportSweepIndexHealthDocument>>;

  hydrateEvidence(
    input: AiHeroSupportSweepHydrationPayload
  ): Promise<AiHeroSupportSweepResult<AiHeroSupportSweepHydrationDocument>>;

  inventorySources(
    input: AiHeroSupportSweepInventoryPayload
  ): Promise<AiHeroSupportSweepResult<AiHeroSupportSweepInventoryDocument>>;

  searchSignals(
    input: AiHeroSupportSweepSignalSearchPayload
  ): Promise<AiHeroSupportSweepResult<AiHeroSupportSweepSignalSearchDocument>>;
}

export interface AiHeroSupportSweepWorkflowNodeAdapterConfig {
  readonly artifacts: ArtifactStoreContract;
  readonly data?: AiHeroSupportSweepDataPort;
}

type BlockedWorkflowNodeExecutionResult = Extract<
  WorkflowNodeExecutionResult,
  { readonly status: "blocked" }
>;
type AiHeroSupportSweepExecutionInput = Parameters<
  WorkflowNodeAdapterPort["execute"]
>[0];

const AIHERO_FALLBACK_QUERY = "AIHero support sweep";
const AIHERO_SIGNAL_MAX_CEILING = 20;
const AIHERO_HYDRATION_MAX_RECEIPTS_CEILING = 12;
const AIHERO_RECOMMENDATION_MAX_CEILING = 8;

const clampToBudgetCeiling =
  (ceiling: number) =>
  (value: unknown): unknown =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.min(Math.max(Math.trunc(value), 1), ceiling)
      : value;

const filterToValidSourceFamilies = (value: unknown): unknown => {
  if (!Array.isArray(value)) {
    return value;
  }

  const valid = value.filter(
    (family) => AiHeroSupportSweepSourceFamilySchema.safeParse(family).success
  );

  return valid.length > 0 ? valid : undefined;
};

const filterToValidAxes = (value: unknown): unknown => {
  if (!Array.isArray(value)) {
    return value;
  }

  const valid = value.filter(
    (axis) => AiHeroSupportSweepSearchAxisSchema.safeParse(axis).success
  );

  return valid.length > 0 ? valid : undefined;
};

const filterToValidHorizons = (value: unknown): unknown => {
  if (!Array.isArray(value)) {
    return value;
  }

  const valid = value.filter(
    (horizon) => MemoryCoverageHorizonSchema.safeParse(horizon).success
  );

  return valid.length > 0 ? valid : undefined;
};

const AiHeroSourceFamiliesConfigSchema = z.preprocess(
  filterToValidSourceFamilies,
  z.array(AiHeroSupportSweepSourceFamilySchema).min(1).optional()
);

const AiHeroSearchAxesConfigSchema = z.preprocess(
  filterToValidAxes,
  z
    .array(AiHeroSupportSweepSearchAxisSchema)
    .min(1)
    .default(["issue", "account", "person", "course-product"])
);

const AiHeroHorizonsConfigSchema = z.preprocess(
  filterToValidHorizons,
  z
    .array(MemoryCoverageHorizonSchema)
    .min(1)
    .default(["24h", "7d", "30d", "quarter", "all-time"])
);

const AiHeroInventoryNodeConfigSchema = z.object({
  sourceFamilies: AiHeroSourceFamiliesConfigSchema,
});

const AiHeroIndexHealthNodeConfigSchema = z.object({
  inventoryRef: ArtifactRefSchema.optional(),
  inventoryStepId: z.string().min(1).optional(),
  recoveryOnly: z.literal(true).default(true),
});

const AiHeroSignalSearchNodeConfigSchema = z.object({
  axes: AiHeroSearchAxesConfigSchema,
  horizons: AiHeroHorizonsConfigSchema,
  indexHealthRef: ArtifactRefSchema.optional(),
  indexHealthStepId: z.string().min(1).optional(),
  maxSignals: z.preprocess(
    clampToBudgetCeiling(AIHERO_SIGNAL_MAX_CEILING),
    z.number().int().min(1).max(AIHERO_SIGNAL_MAX_CEILING).default(12)
  ),
  query: z.string().min(1).default(AIHERO_FALLBACK_QUERY),
});

const AiHeroHydrationNodeConfigSchema = z.object({
  maxReceipts: z.preprocess(
    clampToBudgetCeiling(AIHERO_HYDRATION_MAX_RECEIPTS_CEILING),
    z
      .number()
      .int()
      .min(1)
      .max(AIHERO_HYDRATION_MAX_RECEIPTS_CEILING)
      .default(8)
  ),
  signalSearchRef: ArtifactRefSchema.optional(),
  signalSearchStepId: z.string().min(1).optional(),
});

const AiHeroRecommendationsNodeConfigSchema = z.object({
  hydrationRef: ArtifactRefSchema.optional(),
  hydrationStepId: z.string().min(1).optional(),
  maxRecommendations: z.preprocess(
    clampToBudgetCeiling(AIHERO_RECOMMENDATION_MAX_CEILING),
    z.number().int().min(1).max(AIHERO_RECOMMENDATION_MAX_CEILING).default(5)
  ),
  signalSearchRef: ArtifactRefSchema.optional(),
  signalSearchStepId: z.string().min(1).optional(),
});

const AiHeroDraftSideEffectsNodeConfigSchema = z.object({
  recommendationsRef: ArtifactRefSchema.optional(),
  recommendationsStepId: z.string().min(1).optional(),
  requireCapabilityLease: z.literal(true).default(true),
});

export const AIHERO_SUPPORT_SWEEP_NODE_CONFIG_SCHEMAS = {
  "aihero.support-sweep.derived-index-health":
    AiHeroIndexHealthNodeConfigSchema,
  "aihero.support-sweep.draft-side-effects":
    AiHeroDraftSideEffectsNodeConfigSchema,
  "aihero.support-sweep.evidence-hydration": AiHeroHydrationNodeConfigSchema,
  "aihero.support-sweep.hitl-recommendations":
    AiHeroRecommendationsNodeConfigSchema,
  "aihero.support-sweep.signal-search": AiHeroSignalSearchNodeConfigSchema,
  "aihero.support-sweep.source-inventory": AiHeroInventoryNodeConfigSchema,
} as const satisfies Record<string, z.ZodType>;

export type AiHeroSupportSweepNodeType =
  keyof typeof AIHERO_SUPPORT_SWEEP_NODE_CONFIG_SCHEMAS;

export interface AiHeroSupportSweepNodeConfigContract {
  readonly configJsonSchema: Record<string, unknown>;
  readonly nodeType: string;
}

export const aiHeroSupportSweepNodeConfigContracts =
  (): readonly AiHeroSupportSweepNodeConfigContract[] =>
    Object.entries(AIHERO_SUPPORT_SWEEP_NODE_CONFIG_SCHEMAS)
      .map(([nodeType, schema]) => ({
        configJsonSchema: z.toJSONSchema(schema, {
          target: "draft-7",
        }) as Record<string, unknown>,
        nodeType,
      }))
      .toSorted((left, right) => left.nodeType.localeCompare(right.nodeType));

export const aiHeroSupportSweepNodeConfigContractNotes =
  (): readonly string[] => {
    const contractLines = aiHeroSupportSweepNodeConfigContracts().map(
      (contract) =>
        `- ${contract.nodeType}: ${JSON.stringify(contract.configJsonSchema)}`
    );
    const workedExample = JSON.stringify({
      draftSideEffects: {
        config: {
          recommendationsStepId: "recommend-support-actions",
          requireCapabilityLease: true,
        },
        dependsOn: ["recommend-support-actions"],
        kind: "workflow.node.invoke",
        nodeType: "aihero.support-sweep.draft-side-effects",
        outputPath: "aihero/draft-side-effects.json",
        packageRefs: ["<workflow/aihero-support-sweep artifactRef>"],
        stepId: "draft-support-side-effects",
        summary:
          "Draft support replies/follow-ups and private review artifacts without submitting live side effects.",
      },
    });

    return [
      `Per-node config contract for AIHero support-sweep workflow.node.invoke steps. These schemas are derived from the same Zod schemas the executor parses config against.\n${contractLines.join("\n")}`,
      `Worked workflow.node.invoke config example: ${workedExample}. Keep side effects draft-only with submitted:false and requireCapabilityLease:true.`,
    ];
  };

const describePlanNodeConfigIssue = (issue: z.core.$ZodIssue): string => {
  const path = issue.path.map(String).join(".");
  const at = path.length > 0 ? `config.${path}` : "config";

  return `${at} (${issue.message})`;
};

export const validateAiHeroSupportSweepNodeConfig = (
  step: WorkflowNodeInvocationStep
): CapabilityBlocker | null => {
  const schema = (
    AIHERO_SUPPORT_SWEEP_NODE_CONFIG_SCHEMAS as Record<
      string,
      z.ZodType | undefined
    >
  )[step.nodeType];
  if (schema === undefined) {
    return null;
  }

  const parsed = schema.safeParse(step.config);
  if (parsed.success) {
    return null;
  }

  const issue = parsed.error.issues.at(0);
  const detail =
    issue === undefined
      ? "config did not satisfy the node's contract"
      : describePlanNodeConfigIssue(issue);

  return {
    code: "plan_node_config_invalid",
    message: `Plan step ${step.stepId} (nodeType ${step.nodeType}) has invalid config: ${detail}.`,
    redacted: true,
  };
};

const blocker = (
  code: CapabilityBlocker["code"],
  message: string
): BlockedWorkflowNodeExecutionResult => ({
  blocker: {
    code,
    message,
    redacted: true,
  },
  status: "blocked",
});

const writeDocument = async (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly document: AiHeroSupportSweepNodeOutputDocument;
  readonly step: WorkflowNodeInvocationStep;
}): Promise<WorkflowNodeExecutionResult> => {
  const write = await input.artifacts.writeJson({
    path: input.step.outputPath,
    redacted: true,
    runId: input.document.runId,
    value: input.document,
  });

  return { outputRefs: [write.artifactRef], status: "executed" };
};

const dependencyRefFor = (input: {
  readonly dependencyArtifactRefs: Readonly<Record<string, ArtifactRef>>;
  readonly stepId: string | undefined;
}): ArtifactRef | null => {
  if (input.stepId === undefined) {
    return null;
  }

  return input.dependencyArtifactRefs[input.stepId] ?? null;
};

const upstreamRefByNodeType = (input: {
  readonly completedStepArtifactRefs:
    | Readonly<Record<string, ArtifactRef>>
    | undefined;
  readonly nodeType: string;
  readonly plan: DynamicWorkflowPlanDocument;
}): ArtifactRef | null => {
  const completed = input.completedStepArtifactRefs;
  if (completed === undefined) {
    return null;
  }

  let resolved: ArtifactRef | null = null;
  for (const step of input.plan.steps) {
    if (step.kind !== "workflow.node.invoke") {
      continue;
    }

    const ref = completed[step.stepId];
    if (step.nodeType === input.nodeType && ref !== undefined) {
      resolved = ref;
    }
  }

  return resolved;
};

const loadInventory = async (input: {
  readonly artifactRef: ArtifactRef;
  readonly artifacts: ArtifactStoreContract;
}): Promise<
  | {
      readonly document: AiHeroSupportSweepInventoryDocument;
      readonly status: "loaded";
    }
  | BlockedWorkflowNodeExecutionResult
> => {
  try {
    return {
      document: AiHeroSupportSweepInventoryDocumentSchema.parse(
        await input.artifacts.readJson({ artifactRef: input.artifactRef })
      ),
      status: "loaded",
    };
  } catch {
    return blocker(
      "stale_package",
      "AIHero inventory artifact could not be loaded by the support-sweep node."
    );
  }
};

const loadIndexHealth = async (input: {
  readonly artifactRef: ArtifactRef;
  readonly artifacts: ArtifactStoreContract;
}): Promise<
  | {
      readonly document: AiHeroSupportSweepIndexHealthDocument;
      readonly status: "loaded";
    }
  | BlockedWorkflowNodeExecutionResult
> => {
  try {
    return {
      document: AiHeroSupportSweepIndexHealthDocumentSchema.parse(
        await input.artifacts.readJson({ artifactRef: input.artifactRef })
      ),
      status: "loaded",
    };
  } catch {
    return blocker(
      "stale_package",
      "AIHero index-health artifact could not be loaded by the support-sweep node."
    );
  }
};

const loadSignalSearch = async (input: {
  readonly artifactRef: ArtifactRef;
  readonly artifacts: ArtifactStoreContract;
}): Promise<
  | {
      readonly document: AiHeroSupportSweepSignalSearchDocument;
      readonly status: "loaded";
    }
  | BlockedWorkflowNodeExecutionResult
> => {
  try {
    return {
      document: AiHeroSupportSweepSignalSearchDocumentSchema.parse(
        await input.artifacts.readJson({ artifactRef: input.artifactRef })
      ),
      status: "loaded",
    };
  } catch {
    return blocker(
      "stale_package",
      "AIHero signal-search artifact could not be loaded by the support-sweep node."
    );
  }
};

const loadHydration = async (input: {
  readonly artifactRef: ArtifactRef;
  readonly artifacts: ArtifactStoreContract;
}): Promise<
  | {
      readonly document: AiHeroSupportSweepHydrationDocument;
      readonly status: "loaded";
    }
  | BlockedWorkflowNodeExecutionResult
> => {
  try {
    return {
      document: AiHeroSupportSweepHydrationDocumentSchema.parse(
        await input.artifacts.readJson({ artifactRef: input.artifactRef })
      ),
      status: "loaded",
    };
  } catch {
    return blocker(
      "stale_package",
      "AIHero hydration artifact could not be loaded by the support-sweep node."
    );
  }
};

const loadRecommendations = async (input: {
  readonly artifactRef: ArtifactRef;
  readonly artifacts: ArtifactStoreContract;
}): Promise<
  | {
      readonly document: AiHeroSupportSweepRecommendationDocument;
      readonly status: "loaded";
    }
  | BlockedWorkflowNodeExecutionResult
> => {
  try {
    return {
      document: AiHeroSupportSweepRecommendationDocumentSchema.parse(
        await input.artifacts.readJson({ artifactRef: input.artifactRef })
      ),
      status: "loaded",
    };
  } catch {
    return blocker(
      "stale_package",
      "AIHero recommendations artifact could not be loaded by the support-sweep node."
    );
  }
};

const inventoryRefFor = (input: {
  readonly completedStepArtifactRefs:
    | Readonly<Record<string, ArtifactRef>>
    | undefined;
  readonly config: z.infer<typeof AiHeroIndexHealthNodeConfigSchema>;
  readonly dependencyArtifactRefs: Readonly<Record<string, ArtifactRef>>;
  readonly plan: DynamicWorkflowPlanDocument;
}): ArtifactRef | null =>
  input.config.inventoryRef ??
  dependencyRefFor({
    dependencyArtifactRefs: input.dependencyArtifactRefs,
    stepId: input.config.inventoryStepId,
  }) ??
  upstreamRefByNodeType({
    completedStepArtifactRefs: input.completedStepArtifactRefs,
    nodeType: "aihero.support-sweep.source-inventory",
    plan: input.plan,
  });

const indexHealthRefFor = (input: {
  readonly completedStepArtifactRefs:
    | Readonly<Record<string, ArtifactRef>>
    | undefined;
  readonly config: z.infer<typeof AiHeroSignalSearchNodeConfigSchema>;
  readonly dependencyArtifactRefs: Readonly<Record<string, ArtifactRef>>;
  readonly plan: DynamicWorkflowPlanDocument;
}): ArtifactRef | null =>
  input.config.indexHealthRef ??
  dependencyRefFor({
    dependencyArtifactRefs: input.dependencyArtifactRefs,
    stepId: input.config.indexHealthStepId,
  }) ??
  upstreamRefByNodeType({
    completedStepArtifactRefs: input.completedStepArtifactRefs,
    nodeType: "aihero.support-sweep.derived-index-health",
    plan: input.plan,
  });

const signalSearchRefFor = (input: {
  readonly completedStepArtifactRefs:
    | Readonly<Record<string, ArtifactRef>>
    | undefined;
  readonly config:
    | z.infer<typeof AiHeroHydrationNodeConfigSchema>
    | z.infer<typeof AiHeroRecommendationsNodeConfigSchema>;
  readonly dependencyArtifactRefs: Readonly<Record<string, ArtifactRef>>;
  readonly plan: DynamicWorkflowPlanDocument;
}): ArtifactRef | null =>
  input.config.signalSearchRef ??
  dependencyRefFor({
    dependencyArtifactRefs: input.dependencyArtifactRefs,
    stepId: input.config.signalSearchStepId,
  }) ??
  upstreamRefByNodeType({
    completedStepArtifactRefs: input.completedStepArtifactRefs,
    nodeType: "aihero.support-sweep.signal-search",
    plan: input.plan,
  });

const hydrationRefFor = (input: {
  readonly completedStepArtifactRefs:
    | Readonly<Record<string, ArtifactRef>>
    | undefined;
  readonly config: z.infer<typeof AiHeroRecommendationsNodeConfigSchema>;
  readonly dependencyArtifactRefs: Readonly<Record<string, ArtifactRef>>;
  readonly plan: DynamicWorkflowPlanDocument;
}): ArtifactRef | null =>
  input.config.hydrationRef ??
  dependencyRefFor({
    dependencyArtifactRefs: input.dependencyArtifactRefs,
    stepId: input.config.hydrationStepId,
  }) ??
  upstreamRefByNodeType({
    completedStepArtifactRefs: input.completedStepArtifactRefs,
    nodeType: "aihero.support-sweep.evidence-hydration",
    plan: input.plan,
  });

const recommendationsRefFor = (input: {
  readonly completedStepArtifactRefs:
    | Readonly<Record<string, ArtifactRef>>
    | undefined;
  readonly config: z.infer<typeof AiHeroDraftSideEffectsNodeConfigSchema>;
  readonly dependencyArtifactRefs: Readonly<Record<string, ArtifactRef>>;
  readonly plan: DynamicWorkflowPlanDocument;
}): ArtifactRef | null =>
  input.config.recommendationsRef ??
  dependencyRefFor({
    dependencyArtifactRefs: input.dependencyArtifactRefs,
    stepId: input.config.recommendationsStepId,
  }) ??
  upstreamRefByNodeType({
    completedStepArtifactRefs: input.completedStepArtifactRefs,
    nodeType: "aihero.support-sweep.hitl-recommendations",
    plan: input.plan,
  });

const receiptKey = (receipt: AiHeroSupportSweepReceipt): string =>
  `${receipt.sourceId}:${receipt.receiptId}:${receipt.hash ?? ""}`;

const hydrationReceiptsFor = (input: {
  readonly maxReceipts: number;
  readonly signalSearch: AiHeroSupportSweepSignalSearchDocument;
}): AiHeroSupportSweepReceipt[] => {
  const receipts: AiHeroSupportSweepReceipt[] = [];
  const seen = new Set<string>();

  for (const signal of input.signalSearch.signals) {
    for (const receipt of signal.receipts) {
      const key = receiptKey(receipt);
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      receipts.push(receipt);
      if (receipts.length >= input.maxReceipts) {
        return receipts;
      }
    }
  }

  return receipts;
};

const recommendationIdFor = (value: string, index: number): string => {
  const slug = value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-|-$/gu, "")
    .slice(0, 40);

  return `recommendation:${index + 1}:${slug.length === 0 ? "support" : slug}`;
};

const recommendationForSignal = (input: {
  readonly evidenceRefs: readonly ArtifactRef[];
  readonly hydratedReceiptKeys: ReadonlySet<string>;
  readonly index: number;
  readonly signal: AiHeroSupportSweepSignal;
}): AiHeroSupportSweepRecommendation => {
  const hydrated = input.signal.receipts.some((receipt) =>
    input.hydratedReceiptKeys.has(receiptKey(receipt))
  );

  return {
    evidenceRefs: [...input.evidenceRefs],
    rating: input.signal.rating,
    reasoning: hydrated
      ? "This support signal has selected redacted evidence hydration, so a human can review the recommendation without exposing raw support threads."
      : "This support signal has receipt metadata only. Treat it as a lead until a human reviews the underlying private source.",
    receiptTrail: input.signal.receipts,
    recommendation:
      input.signal.rating >= 8
        ? "Draft a support response or follow-up task for human review; do not submit it automatically."
        : "Hold for human triage and keep the action as a private review note.",
    recommendationId: recommendationIdFor(input.signal.signalId, input.index),
    summary: input.signal.summary,
  };
};

const recommendationDocumentFor = (input: {
  readonly hydration: AiHeroSupportSweepHydrationDocument;
  readonly hydrationRef: ArtifactRef;
  readonly maxRecommendations: number;
  readonly signalSearch: AiHeroSupportSweepSignalSearchDocument;
  readonly signalSearchRef: ArtifactRef;
}): AiHeroSupportSweepRecommendationDocument => {
  const hydratedReceiptKeys = new Set(
    input.hydration.evidence.map((evidence) => receiptKey(evidence.receipt))
  );
  const recommendations = input.signalSearch.signals
    .map((signal, index) =>
      recommendationForSignal({
        evidenceRefs: [input.signalSearchRef, input.hydrationRef],
        hydratedReceiptKeys,
        index,
        signal,
      })
    )
    .toSorted((left, right) => right.rating - left.rating)
    .slice(0, input.maxRecommendations);
  const receipts = recommendations.flatMap(
    (recommendation) => recommendation.receiptTrail
  );

  return AiHeroSupportSweepRecommendationDocumentSchema.parse({
    generatedAt: new Date().toISOString(),
    nodeReceipt: {
      nodeType: "aihero.support-sweep.hitl-recommendations",
      receiptId: `node-receipt:${input.signalSearch.runId}:hitl-recommendations`,
      redacted: true,
      sourceReceipts: receipts,
      summary: `Emitted ${recommendations.length} HITL support recommendation(s).`,
    },
    receiptCount: receipts.length,
    receipts,
    recommendationCount: recommendations.length,
    recommendations,
    redacted: true,
    runId: input.signalSearch.runId,
    schemaVersion: "aihero.support-sweep.recommendations.v1",
    summary:
      recommendations.length === 0
        ? "No support recommendations cleared the receipt threshold."
        : `Prepared ${recommendations.length} support recommendation(s) for HITL review.`,
    workItemId: input.signalSearch.workItemId,
  });
};

const draftActionKinds = [
  "front-draft-reply",
  "front-draft-tag",
  "github-follow-up-draft",
  "linear-follow-up-draft",
  "private-wzrrd-review-draft",
] as const;

const draftActionPathFor = (input: {
  readonly actionKind: AiHeroSupportSweepDraftAction["actionKind"];
  readonly index: number;
}): string => `aihero/drafts/${input.index + 1}-${input.actionKind}.json`;

const draftActionForRecommendation = (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly index: number;
  readonly recommendation: AiHeroSupportSweepRecommendation;
  readonly runId: string;
}): AiHeroSupportSweepDraftAction => {
  const actionKind = draftActionKinds[input.index % draftActionKinds.length];
  if (actionKind === undefined) {
    throw new Error("AIHero support draft action kind resolution failed.");
  }
  const actionId = `draft:${input.recommendation.recommendationId}:${actionKind}`;
  const draftPath = draftActionPathFor({ actionKind, index: input.index });

  return {
    actionId,
    actionKind,
    draftArtifactRef: input.artifacts.artifactRef({
      path: draftPath,
      runId: input.runId,
    }),
    leaseGate: {
      capabilityKind: `aihero.support.${actionKind}`,
      leaseGranted: false,
      leaseRequired: true,
      reviewRequired: true,
    },
    recommendationId: input.recommendation.recommendationId,
    submitted: false,
    summary: `Draft-only ${actionKind} for ${input.recommendation.recommendationId}.`,
  };
};

const draftSideEffectDocumentFor = (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly recommendations: AiHeroSupportSweepRecommendationDocument;
  readonly recommendationsRef: ArtifactRef;
}): AiHeroSupportSweepDraftSideEffectDocument => {
  const draftActions = input.recommendations.recommendations.map(
    (recommendation, index) =>
      draftActionForRecommendation({
        artifacts: input.artifacts,
        index,
        recommendation,
        runId: input.recommendations.runId,
      })
  );

  return AiHeroSupportSweepDraftSideEffectDocumentSchema.parse({
    draftActions,
    generatedAt: new Date().toISOString(),
    nodeReceipt: {
      nodeType: "aihero.support-sweep.draft-side-effects",
      receiptId: `node-receipt:${input.recommendations.runId}:draft-side-effects`,
      redacted: true,
      sourceReceipts: input.recommendations.receipts,
      summary: `Created ${draftActions.length} draft-only side-effect artifact(s); no live actions submitted.`,
    },
    privateReviewSurface: {
      noindex: true,
      privacyTier: "customer-private",
      submitted: false,
    },
    receipts: input.recommendations.receipts,
    redacted: true,
    runId: input.recommendations.runId,
    schemaVersion: "aihero.support-sweep.draft-side-effects.v1",
    submitted: false,
    summary: `Drafted ${draftActions.length} lease-gated support side-effect(s) from ${input.recommendationsRef}.`,
    workItemId: input.recommendations.workItemId,
  });
};

const executeInventoryNode = async (
  config: AiHeroSupportSweepWorkflowNodeAdapterConfig,
  input: AiHeroSupportSweepExecutionInput
): Promise<WorkflowNodeExecutionResult> => {
  if (config.data === undefined) {
    return blocker(
      "adapter_unavailable",
      "AIHero support inventory node requires a support-sweep data adapter."
    );
  }

  const nodeConfig = AiHeroInventoryNodeConfigSchema.parse(input.step.config);
  const result = await config.data.inventorySources(
    AiHeroSupportSweepInventoryPayloadSchema.parse({
      actor: input.actor,
      runId: input.plan.runId,
      ...(nodeConfig.sourceFamilies === undefined
        ? {}
        : { sourceFamilies: nodeConfig.sourceFamilies }),
      workItemId: input.plan.workItemId,
    })
  );
  if (result.status === "blocked") {
    return result;
  }

  return await writeDocument({
    artifacts: config.artifacts,
    document: AiHeroSupportSweepInventoryDocumentSchema.parse(result.document),
    step: input.step,
  });
};

const executeIndexHealthNode = async (
  config: AiHeroSupportSweepWorkflowNodeAdapterConfig,
  input: AiHeroSupportSweepExecutionInput
): Promise<WorkflowNodeExecutionResult> => {
  if (config.data === undefined) {
    return blocker(
      "adapter_unavailable",
      "AIHero support index-health node requires a support-sweep data adapter."
    );
  }

  const nodeConfig = AiHeroIndexHealthNodeConfigSchema.parse(input.step.config);
  const inventoryRef = inventoryRefFor({
    completedStepArtifactRefs: input.completedStepArtifactRefs,
    config: nodeConfig,
    dependencyArtifactRefs: input.dependencyArtifactRefs,
    plan: input.plan,
  });
  if (inventoryRef === null) {
    return blocker(
      "stale_package",
      "AIHero index-health node requires an inventory artifact ref."
    );
  }

  const inventory = await loadInventory({
    artifactRef: inventoryRef,
    artifacts: config.artifacts,
  });
  if (inventory.status === "blocked") {
    return inventory;
  }

  const result = await config.data.checkIndexHealth(
    AiHeroSupportSweepIndexHealthPayloadSchema.parse({
      actor: input.actor,
      inventory: inventory.document,
      inventoryRef,
      recoveryOnly: nodeConfig.recoveryOnly,
      runId: input.plan.runId,
      workItemId: input.plan.workItemId,
    })
  );
  if (result.status === "blocked") {
    return result;
  }

  return await writeDocument({
    artifacts: config.artifacts,
    document: AiHeroSupportSweepIndexHealthDocumentSchema.parse(
      result.document
    ),
    step: input.step,
  });
};

const executeSignalSearchNode = async (
  config: AiHeroSupportSweepWorkflowNodeAdapterConfig,
  input: AiHeroSupportSweepExecutionInput
): Promise<WorkflowNodeExecutionResult> => {
  if (config.data === undefined) {
    return blocker(
      "adapter_unavailable",
      "AIHero support signal-search node requires a support-sweep data adapter."
    );
  }

  const nodeConfig = AiHeroSignalSearchNodeConfigSchema.parse(
    input.step.config
  );
  const indexHealthRef = indexHealthRefFor({
    completedStepArtifactRefs: input.completedStepArtifactRefs,
    config: nodeConfig,
    dependencyArtifactRefs: input.dependencyArtifactRefs,
    plan: input.plan,
  });
  if (indexHealthRef === null) {
    return blocker(
      "stale_package",
      "AIHero signal-search node requires an index-health artifact ref."
    );
  }

  const indexHealth = await loadIndexHealth({
    artifactRef: indexHealthRef,
    artifacts: config.artifacts,
  });
  if (indexHealth.status === "blocked") {
    return indexHealth;
  }

  const result = await config.data.searchSignals(
    AiHeroSupportSweepSignalSearchPayloadSchema.parse({
      actor: input.actor,
      axes: nodeConfig.axes,
      horizons: nodeConfig.horizons,
      indexHealth: indexHealth.document,
      indexHealthRef,
      maxSignals: nodeConfig.maxSignals,
      query: nodeConfig.query,
      runId: input.plan.runId,
      workItemId: input.plan.workItemId,
    })
  );
  if (result.status === "blocked") {
    return result;
  }

  return await writeDocument({
    artifacts: config.artifacts,
    document: AiHeroSupportSweepSignalSearchDocumentSchema.parse(
      result.document
    ),
    step: input.step,
  });
};

const executeHydrationNode = async (
  config: AiHeroSupportSweepWorkflowNodeAdapterConfig,
  input: AiHeroSupportSweepExecutionInput
): Promise<WorkflowNodeExecutionResult> => {
  if (config.data === undefined) {
    return blocker(
      "adapter_unavailable",
      "AIHero support hydration node requires a support-sweep data adapter."
    );
  }

  const nodeConfig = AiHeroHydrationNodeConfigSchema.parse(input.step.config);
  const signalSearchRef = signalSearchRefFor({
    completedStepArtifactRefs: input.completedStepArtifactRefs,
    config: nodeConfig,
    dependencyArtifactRefs: input.dependencyArtifactRefs,
    plan: input.plan,
  });
  if (signalSearchRef === null) {
    return blocker(
      "stale_package",
      "AIHero hydration node requires a signal-search artifact ref."
    );
  }

  const signalSearch = await loadSignalSearch({
    artifactRef: signalSearchRef,
    artifacts: config.artifacts,
  });
  if (signalSearch.status === "blocked") {
    return signalSearch;
  }

  const receipts = hydrationReceiptsFor({
    maxReceipts: nodeConfig.maxReceipts,
    signalSearch: signalSearch.document,
  });
  if (receipts.length === 0) {
    return blocker(
      "stale_package",
      "AIHero hydration node requires at least one selected receipt from signal search."
    );
  }

  const result = await config.data.hydrateEvidence(
    AiHeroSupportSweepHydrationPayloadSchema.parse({
      actor: input.actor,
      maxReceipts: nodeConfig.maxReceipts,
      receipts,
      runId: input.plan.runId,
      signalSearch: signalSearch.document,
      signalSearchRef,
      workItemId: input.plan.workItemId,
    })
  );
  if (result.status === "blocked") {
    return result;
  }

  return await writeDocument({
    artifacts: config.artifacts,
    document: AiHeroSupportSweepHydrationDocumentSchema.parse(result.document),
    step: input.step,
  });
};

const executeRecommendationsNode = async (
  config: AiHeroSupportSweepWorkflowNodeAdapterConfig,
  input: AiHeroSupportSweepExecutionInput
): Promise<WorkflowNodeExecutionResult> => {
  const nodeConfig = AiHeroRecommendationsNodeConfigSchema.parse(
    input.step.config
  );
  const signalSearchRef = signalSearchRefFor({
    completedStepArtifactRefs: input.completedStepArtifactRefs,
    config: nodeConfig,
    dependencyArtifactRefs: input.dependencyArtifactRefs,
    plan: input.plan,
  });
  const hydrationRef = hydrationRefFor({
    completedStepArtifactRefs: input.completedStepArtifactRefs,
    config: nodeConfig,
    dependencyArtifactRefs: input.dependencyArtifactRefs,
    plan: input.plan,
  });
  if (signalSearchRef === null || hydrationRef === null) {
    return blocker(
      "stale_package",
      "AIHero recommendations node requires signal-search and hydration artifact refs."
    );
  }

  const signalSearch = await loadSignalSearch({
    artifactRef: signalSearchRef,
    artifacts: config.artifacts,
  });
  if (signalSearch.status === "blocked") {
    return signalSearch;
  }

  const hydration = await loadHydration({
    artifactRef: hydrationRef,
    artifacts: config.artifacts,
  });
  if (hydration.status === "blocked") {
    return hydration;
  }

  return await writeDocument({
    artifacts: config.artifacts,
    document: recommendationDocumentFor({
      hydration: hydration.document,
      hydrationRef,
      maxRecommendations: nodeConfig.maxRecommendations,
      signalSearch: signalSearch.document,
      signalSearchRef,
    }),
    step: input.step,
  });
};

const executeDraftSideEffectsNode = async (
  config: AiHeroSupportSweepWorkflowNodeAdapterConfig,
  input: AiHeroSupportSweepExecutionInput
): Promise<WorkflowNodeExecutionResult> => {
  const nodeConfig = AiHeroDraftSideEffectsNodeConfigSchema.parse(
    input.step.config
  );
  const recommendationsRef = recommendationsRefFor({
    completedStepArtifactRefs: input.completedStepArtifactRefs,
    config: nodeConfig,
    dependencyArtifactRefs: input.dependencyArtifactRefs,
    plan: input.plan,
  });
  if (recommendationsRef === null) {
    return blocker(
      "stale_package",
      "AIHero draft side-effects node requires a recommendations artifact ref."
    );
  }

  const recommendations = await loadRecommendations({
    artifactRef: recommendationsRef,
    artifacts: config.artifacts,
  });
  if (recommendations.status === "blocked") {
    return recommendations;
  }

  const document = draftSideEffectDocumentFor({
    artifacts: config.artifacts,
    recommendations: recommendations.document,
    recommendationsRef,
  });
  const draftWrites = await Promise.all(
    document.draftActions.map((action, index) =>
      config.artifacts.writeJson({
        path: draftActionPathFor({
          actionKind: action.actionKind,
          index,
        }),
        redacted: true,
        runId: document.runId,
        value: {
          actionId: action.actionId,
          actionKind: action.actionKind,
          leaseGate: action.leaseGate,
          recommendationId: action.recommendationId,
          recommendationRef: recommendationsRef,
          redacted: true,
          schemaVersion: "aihero.support-sweep.side-effect-draft.v1",
          submitted: false,
          summary: action.summary,
        },
      })
    )
  );
  const documentWrite = await config.artifacts.writeJson({
    path: input.step.outputPath,
    redacted: true,
    runId: document.runId,
    value: document,
  });

  return {
    outputRefs: [
      documentWrite.artifactRef,
      ...draftWrites.map((write) => write.artifactRef),
    ],
    status: "executed",
  };
};

export const createAiHeroSupportSweepWorkflowNodeAdapter = (
  config: AiHeroSupportSweepWorkflowNodeAdapterConfig
): WorkflowNodeAdapterPort => ({
  async execute(input) {
    const { nodeType } = input.step;

    if (nodeType === "aihero.support-sweep.source-inventory") {
      return await executeInventoryNode(config, input);
    }

    if (nodeType === "aihero.support-sweep.derived-index-health") {
      return await executeIndexHealthNode(config, input);
    }

    if (nodeType === "aihero.support-sweep.signal-search") {
      return await executeSignalSearchNode(config, input);
    }

    if (nodeType === "aihero.support-sweep.evidence-hydration") {
      return await executeHydrationNode(config, input);
    }

    if (nodeType === "aihero.support-sweep.hitl-recommendations") {
      return await executeRecommendationsNode(config, input);
    }

    if (nodeType === "aihero.support-sweep.draft-side-effects") {
      return await executeDraftSideEffectsNode(config, input);
    }

    return blocker(
      "adapter_unavailable",
      `AIHero support-sweep workflow node adapter does not support nodeType ${input.step.nodeType}.`
    );
  },
  validatePlanNodeConfig(input) {
    return validateAiHeroSupportSweepNodeConfig(input.step);
  },
});

export const aiHeroSupportSweepReceiptFor = (input: {
  readonly family: AiHeroSupportSweepReceipt["family"];
  readonly receiptId: string;
  readonly runId: string;
  readonly sourceId: string;
  readonly timestamp?: string;
}): AiHeroSupportSweepReceipt => ({
  artifactRef: `artifact://aihero-support-sweep/runs/${input.runId}/receipts/${input.receiptId}.json`,
  family: input.family,
  hash: sha256Hex(`${input.runId}:${input.sourceId}:${input.receiptId}`),
  privacyTier: "customer-private",
  receiptId: input.receiptId,
  redactedLocator: `redacted://aihero-support-sweep/${hashJson({
    receiptId: input.receiptId,
    sourceId: input.sourceId,
  })}`,
  sourceId: input.sourceId,
  ...(input.timestamp === undefined ? {} : { timestamp: input.timestamp }),
});
