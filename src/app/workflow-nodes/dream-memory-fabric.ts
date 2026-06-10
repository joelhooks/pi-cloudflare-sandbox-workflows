import { z } from "zod";

import type {
  ArtifactStoreContract,
  WorkflowNodeAdapterPort,
  WorkflowNodeExecutionResult,
  WorkflowNodeInvocationStep,
} from "../application/ports.ts";
import { hashJson, sha256Hex } from "../domain/hash.ts";
import { ArtifactPinSchema, ArtifactRefSchema } from "../domain/schemas.ts";
import type {
  Actor,
  ArtifactPin,
  ArtifactRef,
  CapabilityBlocker,
  DynamicWorkflowMachineDocument,
  DynamicWorkflowPlanDocument,
} from "../domain/schemas.ts";
import {
  DREAM_HITL_REPORT_SECTION_ORDER,
  DreamBackfillPlanDocumentSchema,
  DreamBackfillRunReceiptDocumentSchema,
  DreamCaptureReceiptDocumentSchema,
  DreamCorrelationGraphDocumentSchema,
  DreamHitlDecisionContractSchema,
  DreamHitlDecisionDocumentSchema,
  DreamHitlDecisionWorkflowSeedDocumentSchema,
  DreamHitlReportDocumentSchema,
  DreamHitlReportProofLevelSchema,
  DreamHydrationDocumentSchema,
  DreamMemoryFabricNodeTypeSchema,
  DreamMemoryRelayBackfillRunPayloadSchema,
  DreamMemoryRelayCaptureArtifactPayloadSchema,
  DreamMemoryRelayCaptureRunPayloadSchema,
  DreamMemoryRelayCorrelationPayloadSchema,
  DreamMemoryRelayHydrationPayloadSchema,
  DreamMemoryRelayLeaseReceiptSchema,
  DreamMemoryRelaySearchPayloadSchema,
  DreamMemoryRelaySignalsPayloadSchema,
  DreamMemorySearchDocumentSchema,
  DreamRefinementProposalDocumentSchema,
  DreamRuntimeSchema,
  DreamSignalDocumentSchema,
  DreamSignalKindSchema,
  DreamSourceFamilySchema,
  DreamSourceHealthDocumentSchema,
  DreamSourceInventoryDocumentSchema,
} from "./dream-memory-fabric-schemas.ts";
import type {
  DreamBackfillPlanDocument,
  DreamBackfillRunReceiptDocument,
  DreamCaptureReceiptDocument,
  DreamCorrelationGraphDocument,
  DreamHitlDecisionContract,
  DreamHitlDecisionDocument,
  DreamHitlDecisionWorkflowSeedDocument,
  DreamHitlDreamCard,
  DreamHitlReportDocument,
  DreamHitlReportProofLevel,
  DreamHydrationDocument,
  DreamMemoryRelayBackfillRunPayload,
  DreamMemoryRelayCaptureArtifactPayload,
  DreamMemoryRelayCaptureRunPayload,
  DreamMemoryRelayCorrelationPayload,
  DreamMemoryRelayHydrationPayload,
  DreamMemoryRelayLeaseReceipt,
  DreamMemoryRelaySearchPayload,
  DreamMemoryRelaySignalsPayload,
  DreamMemorySearchDocument,
  DreamMemorySearchHit,
  DreamReceiptRef,
  DreamRefinementProposal,
  DreamRefinementProposalDocument,
  DreamRefinementProposalRecommendation,
  DreamRefinementProposalTargetKind,
  DreamRuntime,
  DreamSignalDocument,
  DreamSourceFamily,
  DreamSourceHealthDocument,
  DreamSourceInventoryDocument,
} from "./dream-memory-fabric-schemas.ts";

export type DreamMemoryFabricResult<TDocument> =
  | {
      readonly blocker: CapabilityBlocker;
      readonly status: "blocked";
    }
  | {
      readonly document: TDocument;
      readonly relayLeaseReceipt?: DreamMemoryRelayLeaseReceipt;
      readonly status: "ready";
    };

export interface DreamMemoryFabricPort {
  inventorySources(input: {
    readonly actor: Actor;
    readonly requiredRuntimes: readonly DreamRuntime[];
    readonly runId: string;
    readonly sourceFamiliesExpected: readonly DreamSourceFamily[];
    readonly workItemId: string;
  }): Promise<DreamMemoryFabricResult<DreamSourceInventoryDocument>>;

  checkSourceHealth(input: {
    readonly actor: Actor;
    readonly inventory: DreamSourceInventoryDocument;
    readonly inventoryRef: ArtifactRef;
    readonly runId: string;
    readonly workItemId: string;
  }): Promise<DreamMemoryFabricResult<DreamSourceHealthDocument>>;

  planBackfill(input: {
    readonly actor: Actor;
    readonly health: DreamSourceHealthDocument;
    readonly healthRef: ArtifactRef;
    readonly inventory: DreamSourceInventoryDocument;
    readonly inventoryRef: ArtifactRef;
    readonly runId: string;
    readonly workItemId: string;
  }): Promise<DreamMemoryFabricResult<DreamBackfillPlanDocument>>;
}

export interface DreamMemoryRetrievalPort {
  hydrateMemories(
    input: DreamMemoryRelayHydrationPayload
  ): Promise<DreamMemoryFabricResult<DreamHydrationDocument>>;

  searchMemories(
    input: DreamMemoryRelaySearchPayload
  ): Promise<DreamMemoryFabricResult<DreamMemorySearchDocument>>;
}

export interface DreamMemorySignalPort {
  mineSignals(
    input: DreamMemoryRelaySignalsPayload
  ): Promise<DreamMemoryFabricResult<DreamSignalDocument>>;
}

export interface DreamMemoryCorrelationPort {
  correlateMemories(
    input: DreamMemoryRelayCorrelationPayload
  ): Promise<DreamMemoryFabricResult<DreamCorrelationGraphDocument>>;
}

export interface DreamMemoryBackfillPort {
  runBackfill(
    input: DreamMemoryRelayBackfillRunPayload
  ): Promise<DreamMemoryFabricResult<DreamBackfillRunReceiptDocument>>;
}

export interface DreamMemoryCapturePort {
  captureArtifact(
    input: DreamMemoryRelayCaptureArtifactPayload
  ): Promise<DreamMemoryFabricResult<DreamCaptureReceiptDocument>>;

  captureRun(
    input: DreamMemoryRelayCaptureRunPayload
  ): Promise<DreamMemoryFabricResult<DreamCaptureReceiptDocument>>;
}

export interface DreamMemoryFabricWorkflowNodeAdapterConfig {
  readonly artifacts: ArtifactStoreContract;
  readonly dreamMemoryBackfill?: DreamMemoryBackfillPort;
  readonly dreamMemoryCapture?: DreamMemoryCapturePort;
  readonly dreamMemoryCorrelation?: DreamMemoryCorrelationPort;
  readonly dreamMemoryFabric: DreamMemoryFabricPort;
  readonly dreamMemoryRetrieval?: DreamMemoryRetrievalPort;
  readonly dreamMemorySignals?: DreamMemorySignalPort;
}

type BlockedWorkflowNodeExecutionResult = Extract<
  WorkflowNodeExecutionResult,
  { readonly status: "blocked" }
>;
type DreamWorkflowNodeExecutionInput = Parameters<
  WorkflowNodeAdapterPort["execute"]
>[0];

const DreamSourceInventoryNodeConfigSchema = z.object({
  requiredMachineIds: z.array(z.string().min(1)).min(1).optional(),
  requiredRuntimes: z.array(DreamRuntimeSchema).min(1),
  sourceFamiliesExpected: z.array(DreamSourceFamilySchema).min(1),
});

const DreamSourceHealthNodeConfigSchema = z.object({
  inventoryRef: ArtifactRefSchema.optional(),
  inventoryStepId: z.string().min(1).optional(),
});

const DreamBackfillPlanNodeConfigSchema = z.object({
  healthRef: ArtifactRefSchema.optional(),
  healthStepId: z.string().min(1).optional(),
  inventoryRef: ArtifactRefSchema.optional(),
  inventoryStepId: z.string().min(1).optional(),
});

const DreamBackfillRunNodeConfigSchema = z.object({
  planRef: ArtifactRefSchema.optional(),
  planStepId: z.string().min(1).optional(),
});

const CAPTURABLE_ARTIFACT_MEDIA_TYPES = [
  "application/json",
  "text/html",
  "text/markdown",
  "text/mdsvx",
  "text/plain",
  "text/typescript",
] as const;

const DreamCapturableArtifactMediaTypeSchema = z.enum(
  CAPTURABLE_ARTIFACT_MEDIA_TYPES,
  {
    error:
      "Dream capture artifact mediaType must be application/json or a supported text media type.",
  }
);

const DreamCaptureRunNodeConfigSchema = z.object({
  capturedRef: ArtifactPinSchema.optional(),
  readability: z
    .enum(["actor-private", "org-private", "public"])
    .default("actor-private"),
  sourceFamilies: z.array(DreamSourceFamilySchema).min(1).optional(),
  sourceSystem: z.string().min(1).default("cloudflare-workflow-run"),
  targetRunId: z.string().min(1).optional(),
});

const DreamCaptureArtifactNodeConfigSchema = z.object({
  artifactRef: ArtifactRefSchema.optional(),
  artifactStepId: z.string().min(1).optional(),
  mediaType: DreamCapturableArtifactMediaTypeSchema.default("application/json"),
  readability: z
    .enum(["actor-private", "org-private", "public"])
    .default("actor-private"),
  sourceFamilies: z.array(DreamSourceFamilySchema).min(1).optional(),
  sourceSystem: z.string().min(1).default("cloudflare-artifacts"),
});

const DreamMemorySearchNodeConfigSchema = z.object({
  maxHits: z.number().int().min(1).max(100).default(10),
  query: z.string().min(1),
  sourceFamilies: z.array(DreamSourceFamilySchema).min(1).optional(),
});

const DreamSignalsNodeConfigSchema = z.object({
  maxSignals: z.number().int().min(1).max(100).default(10),
  query: z.string().min(1),
  signalKinds: z.array(DreamSignalKindSchema).min(1).optional(),
  sourceFamilies: z.array(DreamSourceFamilySchema).min(1).optional(),
});

const DreamHydrationNodeConfigSchema = z.object({
  maxReceipts: z.number().int().min(1).max(100).default(10),
  searchRef: ArtifactRefSchema.optional(),
  searchStepId: z.string().min(1).optional(),
});

const DreamCorrelationNodeConfigSchema = z.object({
  hydrationRef: ArtifactRefSchema.optional(),
  hydrationStepId: z.string().min(1).optional(),
  searchRef: ArtifactRefSchema.optional(),
  searchStepId: z.string().min(1).optional(),
});

const DreamRefinementProposalNodeConfigSchema = z.object({
  backfillRunRef: ArtifactRefSchema.optional(),
  backfillRunStepId: z.string().min(1).optional(),
  correlationRef: ArtifactRefSchema.optional(),
  correlationStepId: z.string().min(1).optional(),
  healthRef: ArtifactRefSchema.optional(),
  healthStepId: z.string().min(1).optional(),
  hydrationRef: ArtifactRefSchema.optional(),
  hydrationStepId: z.string().min(1).optional(),
  inventoryRef: ArtifactRefSchema.optional(),
  inventoryStepId: z.string().min(1).optional(),
  maxProposals: z.number().int().min(1).max(20).default(8),
  searchRef: ArtifactRefSchema.optional(),
  searchStepId: z.string().min(1).optional(),
  signalsRef: ArtifactRefSchema.optional(),
  signalsStepId: z.string().min(1).optional(),
});

const DreamHitlReportNodeConfigSchema = z.object({
  backfillPlanRef: ArtifactRefSchema.optional(),
  backfillPlanStepId: z.string().min(1).optional(),
  backfillRef: ArtifactRefSchema.optional(),
  backfillRunRef: ArtifactRefSchema.optional(),
  backfillRunStepId: z.string().min(1).optional(),
  backfillStepId: z.string().min(1).optional(),
  correlationRef: ArtifactRefSchema.optional(),
  correlationStepId: z.string().min(1).optional(),
  dynamicGenerationProofLevel:
    DreamHitlReportProofLevelSchema.default("plan-derived"),
  healthRef: ArtifactRefSchema.optional(),
  healthStepId: z.string().min(1).optional(),
  hydrationRef: ArtifactRefSchema.optional(),
  hydrationStepId: z.string().min(1).optional(),
  inventoryRef: ArtifactRefSchema.optional(),
  inventoryStepId: z.string().min(1).optional(),
  refinementProposalRef: ArtifactRefSchema.optional(),
  refinementProposalStepId: z.string().min(1).optional(),
  searchRef: ArtifactRefSchema.optional(),
  searchStepId: z.string().min(1).optional(),
  title: z.string().min(1).default("Dream review"),
});

const DreamHitlDecisionWorkflowSeedNodeConfigSchema = z.object({
  decisionRef: ArtifactRefSchema.optional(),
  decisionStepId: z.string().min(1).optional(),
});

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

const siblingArtifactPath = (input: {
  readonly extension: string;
  readonly outputPath: string;
}): string => {
  const lastDotIndex = input.outputPath.lastIndexOf(".");

  return lastDotIndex === -1
    ? `${input.outputPath}.${input.extension}`
    : `${input.outputPath.slice(0, lastDotIndex)}.${input.extension}`;
};

const relayLeaseReceiptPathFor = (step: WorkflowNodeInvocationStep): string =>
  `dream/relay-lease-receipts/${step.stepId}.json`;

const writeDocument = async (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly document:
    | DreamBackfillPlanDocument
    | DreamBackfillRunReceiptDocument
    | DreamCaptureReceiptDocument
    | DreamCorrelationGraphDocument
    | DreamHitlDecisionWorkflowSeedDocument
    | DreamHitlReportDocument
    | DreamHydrationDocument
    | DreamMemorySearchDocument
    | DreamRefinementProposalDocument
    | DreamSignalDocument
    | DreamSourceHealthDocument
    | DreamSourceInventoryDocument;
  readonly relayLeaseReceipt?: DreamMemoryRelayLeaseReceipt | undefined;
  readonly step: WorkflowNodeInvocationStep;
}): Promise<WorkflowNodeExecutionResult> => {
  const write = await input.artifacts.writeJson({
    path: input.step.outputPath,
    redacted: true,
    runId: input.document.runId,
    value: input.document,
  });
  if (input.relayLeaseReceipt === undefined) {
    return { outputRefs: [write.artifactRef], status: "executed" };
  }

  const relayLeaseWrite = await input.artifacts.writeJson({
    path: relayLeaseReceiptPathFor(input.step),
    redacted: true,
    runId: input.document.runId,
    value: DreamMemoryRelayLeaseReceiptSchema.parse(input.relayLeaseReceipt),
  });

  return {
    outputRefs: [write.artifactRef, relayLeaseWrite.artifactRef],
    status: "executed",
  };
};

const writeHitlReportDocument = async (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly document: DreamHitlReportDocument;
  readonly step: WorkflowNodeInvocationStep;
}): Promise<WorkflowNodeExecutionResult> => {
  const jsonWrite = await input.artifacts.writeJson({
    path: input.step.outputPath,
    redacted: true,
    runId: input.document.runId,
    value: input.document,
  });
  const mdsvxWrite = await input.artifacts.writeText({
    mediaType: "text/mdsvx",
    path: siblingArtifactPath({
      extension: "mdsvx",
      outputPath: input.step.outputPath,
    }),
    redacted: true,
    runId: input.document.runId,
    value: input.document.mdsvx,
  });

  return {
    outputRefs: [jsonWrite.artifactRef, mdsvxWrite.artifactRef],
    status: "executed",
  };
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

const loadInventory = async (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly artifactRef: ArtifactRef;
}): Promise<
  | {
      readonly document: DreamSourceInventoryDocument;
      readonly status: "loaded";
    }
  | BlockedWorkflowNodeExecutionResult
> => {
  try {
    return {
      document: DreamSourceInventoryDocumentSchema.parse(
        await input.artifacts.readJson({ artifactRef: input.artifactRef })
      ),
      status: "loaded",
    };
  } catch {
    return blocker(
      "stale_package",
      "Dream source inventory artifact could not be loaded by the Dream node."
    );
  }
};

const loadHealth = async (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly artifactRef: ArtifactRef;
}): Promise<
  | {
      readonly document: DreamSourceHealthDocument;
      readonly status: "loaded";
    }
  | BlockedWorkflowNodeExecutionResult
> => {
  try {
    return {
      document: DreamSourceHealthDocumentSchema.parse(
        await input.artifacts.readJson({ artifactRef: input.artifactRef })
      ),
      status: "loaded",
    };
  } catch {
    return blocker(
      "stale_package",
      "Dream source health artifact could not be loaded by the Dream node."
    );
  }
};

const loadBackfill = async (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly artifactRef: ArtifactRef;
}): Promise<
  | {
      readonly document: DreamBackfillPlanDocument;
      readonly status: "loaded";
    }
  | BlockedWorkflowNodeExecutionResult
> => {
  try {
    return {
      document: DreamBackfillPlanDocumentSchema.parse(
        await input.artifacts.readJson({ artifactRef: input.artifactRef })
      ),
      status: "loaded",
    };
  } catch {
    return blocker(
      "stale_package",
      "Dream backfill plan artifact could not be loaded by the Dream node."
    );
  }
};

const loadBackfillRun = async (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly artifactRef: ArtifactRef;
}): Promise<
  | {
      readonly document: DreamBackfillRunReceiptDocument;
      readonly status: "loaded";
    }
  | BlockedWorkflowNodeExecutionResult
> => {
  try {
    return {
      document: DreamBackfillRunReceiptDocumentSchema.parse(
        await input.artifacts.readJson({ artifactRef: input.artifactRef })
      ),
      status: "loaded",
    };
  } catch {
    return blocker(
      "stale_package",
      "Dream backfill run receipt artifact could not be loaded by the Dream node."
    );
  }
};

const loadSearch = async (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly artifactRef: ArtifactRef;
}): Promise<
  | {
      readonly document: DreamMemorySearchDocument;
      readonly status: "loaded";
    }
  | BlockedWorkflowNodeExecutionResult
> => {
  try {
    return {
      document: DreamMemorySearchDocumentSchema.parse(
        await input.artifacts.readJson({ artifactRef: input.artifactRef })
      ),
      status: "loaded",
    };
  } catch {
    return blocker(
      "stale_package",
      "Dream memory search artifact could not be loaded by the Dream node."
    );
  }
};

const loadHydration = async (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly artifactRef: ArtifactRef;
}): Promise<
  | {
      readonly document: DreamHydrationDocument;
      readonly status: "loaded";
    }
  | BlockedWorkflowNodeExecutionResult
> => {
  try {
    return {
      document: DreamHydrationDocumentSchema.parse(
        await input.artifacts.readJson({ artifactRef: input.artifactRef })
      ),
      status: "loaded",
    };
  } catch {
    return blocker(
      "stale_package",
      "Dream hydration artifact could not be loaded by the Dream node."
    );
  }
};

const loadSignals = async (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly artifactRef: ArtifactRef;
}): Promise<
  | {
      readonly document: DreamSignalDocument;
      readonly status: "loaded";
    }
  | BlockedWorkflowNodeExecutionResult
> => {
  try {
    return {
      document: DreamSignalDocumentSchema.parse(
        await input.artifacts.readJson({ artifactRef: input.artifactRef })
      ),
      status: "loaded",
    };
  } catch {
    return blocker(
      "stale_package",
      "Dream signals artifact could not be loaded by the Dream node."
    );
  }
};

const loadCorrelation = async (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly artifactRef: ArtifactRef;
}): Promise<
  | {
      readonly document: DreamCorrelationGraphDocument;
      readonly status: "loaded";
    }
  | BlockedWorkflowNodeExecutionResult
> => {
  try {
    return {
      document: DreamCorrelationGraphDocumentSchema.parse(
        await input.artifacts.readJson({ artifactRef: input.artifactRef })
      ),
      status: "loaded",
    };
  } catch {
    return blocker(
      "stale_package",
      "Dream correlation graph artifact could not be loaded by the Dream node."
    );
  }
};

const loadRefinementProposals = async (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly artifactRef: ArtifactRef;
}): Promise<
  | {
      readonly document: DreamRefinementProposalDocument;
      readonly status: "loaded";
    }
  | BlockedWorkflowNodeExecutionResult
> => {
  try {
    return {
      document: DreamRefinementProposalDocumentSchema.parse(
        await input.artifacts.readJson({ artifactRef: input.artifactRef })
      ),
      status: "loaded",
    };
  } catch {
    return blocker(
      "stale_package",
      "Dream refinement proposal artifact could not be loaded by the Dream node."
    );
  }
};

const loadHitlDecision = async (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly artifactRef: ArtifactRef;
}): Promise<
  | {
      readonly document: DreamHitlDecisionDocument;
      readonly status: "loaded";
    }
  | BlockedWorkflowNodeExecutionResult
> => {
  try {
    return {
      document: DreamHitlDecisionDocumentSchema.parse(
        await input.artifacts.readJson({ artifactRef: input.artifactRef })
      ),
      status: "loaded",
    };
  } catch {
    return blocker(
      "stale_package",
      "Dream HITL decision artifact could not be loaded by the Dream node."
    );
  }
};

const inventoryRefFor = (input: {
  readonly config: z.infer<typeof DreamSourceHealthNodeConfigSchema>;
  readonly dependencyArtifactRefs: Readonly<Record<string, ArtifactRef>>;
}): ArtifactRef | null =>
  input.config.inventoryRef ??
  dependencyRefFor({
    dependencyArtifactRefs: input.dependencyArtifactRefs,
    stepId: input.config.inventoryStepId,
  });

const backfillRefsFor = (input: {
  readonly config: z.infer<typeof DreamBackfillPlanNodeConfigSchema>;
  readonly dependencyArtifactRefs: Readonly<Record<string, ArtifactRef>>;
}): {
  readonly healthRef: ArtifactRef | null;
  readonly inventoryRef: ArtifactRef | null;
} => {
  const inventoryRef =
    input.config.inventoryRef ??
    dependencyRefFor({
      dependencyArtifactRefs: input.dependencyArtifactRefs,
      stepId: input.config.inventoryStepId,
    });
  const healthRef =
    input.config.healthRef ??
    dependencyRefFor({
      dependencyArtifactRefs: input.dependencyArtifactRefs,
      stepId: input.config.healthStepId,
    });

  return {
    healthRef,
    inventoryRef,
  };
};

const backfillRunPlanRefFor = (input: {
  readonly config: z.infer<typeof DreamBackfillRunNodeConfigSchema>;
  readonly dependencyArtifactRefs: Readonly<Record<string, ArtifactRef>>;
}): ArtifactRef | null =>
  input.config.planRef ??
  dependencyRefFor({
    dependencyArtifactRefs: input.dependencyArtifactRefs,
    stepId: input.config.planStepId,
  });

const captureArtifactRefFor = (input: {
  readonly config: z.infer<typeof DreamCaptureArtifactNodeConfigSchema>;
  readonly dependencyArtifactRefs: Readonly<Record<string, ArtifactRef>>;
}): ArtifactRef | null =>
  input.config.artifactRef ??
  dependencyRefFor({
    dependencyArtifactRefs: input.dependencyArtifactRefs,
    stepId: input.config.artifactStepId,
  });

const captureArtifactPinFor = async (input: {
  readonly artifactRef: ArtifactRef;
  readonly artifacts: ArtifactStoreContract;
  readonly mediaType: string;
}): Promise<
  | {
      readonly pin: ArtifactPin;
      readonly status: "loaded";
    }
  | BlockedWorkflowNodeExecutionResult
> => {
  try {
    if (input.mediaType === "application/json") {
      const value = await input.artifacts.readJson({
        artifactRef: input.artifactRef,
      });

      return {
        pin: ArtifactPinSchema.parse({
          artifactRef: input.artifactRef,
          hash: hashJson(value),
          mediaType: input.mediaType,
        }),
        status: "loaded",
      };
    }

    const value = await input.artifacts.readText({
      artifactRef: input.artifactRef,
    });

    return {
      pin: ArtifactPinSchema.parse({
        artifactRef: input.artifactRef,
        hash: sha256Hex(value),
        mediaType: input.mediaType,
      }),
      status: "loaded",
    };
  } catch {
    return blocker(
      "stale_package",
      "Dream capture artifact node requires a readable generated artifact ref."
    );
  }
};

const searchRefFor = (input: {
  readonly config: z.infer<typeof DreamHydrationNodeConfigSchema>;
  readonly dependencyArtifactRefs: Readonly<Record<string, ArtifactRef>>;
}): ArtifactRef | null =>
  input.config.searchRef ??
  dependencyRefFor({
    dependencyArtifactRefs: input.dependencyArtifactRefs,
    stepId: input.config.searchStepId,
  });

const correlationRefsFor = (input: {
  readonly config: z.infer<typeof DreamCorrelationNodeConfigSchema>;
  readonly dependencyArtifactRefs: Readonly<Record<string, ArtifactRef>>;
}): {
  readonly hydrationRef: ArtifactRef | null;
  readonly searchRef: ArtifactRef | null;
} => {
  const searchRef =
    input.config.searchRef ??
    dependencyRefFor({
      dependencyArtifactRefs: input.dependencyArtifactRefs,
      stepId: input.config.searchStepId,
    });
  const hydrationRef =
    input.config.hydrationRef ??
    dependencyRefFor({
      dependencyArtifactRefs: input.dependencyArtifactRefs,
      stepId: input.config.hydrationStepId,
    });

  return {
    hydrationRef,
    searchRef,
  };
};

const refinementProposalRefsFor = (input: {
  readonly config: z.infer<typeof DreamRefinementProposalNodeConfigSchema>;
  readonly dependencyArtifactRefs: Readonly<Record<string, ArtifactRef>>;
}): {
  readonly backfillRunRef: ArtifactRef | null;
  readonly correlationRef: ArtifactRef | null;
  readonly healthRef: ArtifactRef | null;
  readonly hydrationRef: ArtifactRef | null;
  readonly inventoryRef: ArtifactRef | null;
  readonly searchRef: ArtifactRef | null;
  readonly signalsRef: ArtifactRef | null;
} => ({
  backfillRunRef:
    input.config.backfillRunRef ??
    dependencyRefFor({
      dependencyArtifactRefs: input.dependencyArtifactRefs,
      stepId: input.config.backfillRunStepId,
    }),
  correlationRef:
    input.config.correlationRef ??
    dependencyRefFor({
      dependencyArtifactRefs: input.dependencyArtifactRefs,
      stepId: input.config.correlationStepId,
    }),
  healthRef:
    input.config.healthRef ??
    dependencyRefFor({
      dependencyArtifactRefs: input.dependencyArtifactRefs,
      stepId: input.config.healthStepId,
    }),
  hydrationRef:
    input.config.hydrationRef ??
    dependencyRefFor({
      dependencyArtifactRefs: input.dependencyArtifactRefs,
      stepId: input.config.hydrationStepId,
    }),
  inventoryRef:
    input.config.inventoryRef ??
    dependencyRefFor({
      dependencyArtifactRefs: input.dependencyArtifactRefs,
      stepId: input.config.inventoryStepId,
    }),
  searchRef:
    input.config.searchRef ??
    dependencyRefFor({
      dependencyArtifactRefs: input.dependencyArtifactRefs,
      stepId: input.config.searchStepId,
    }),
  signalsRef:
    input.config.signalsRef ??
    dependencyRefFor({
      dependencyArtifactRefs: input.dependencyArtifactRefs,
      stepId: input.config.signalsStepId,
    }),
});

const reportRefsFor = (input: {
  readonly config: z.infer<typeof DreamHitlReportNodeConfigSchema>;
  readonly dependencyArtifactRefs: Readonly<Record<string, ArtifactRef>>;
}): {
  readonly backfillPlanRef: ArtifactRef | null;
  readonly backfillRunRef: ArtifactRef | null;
  readonly correlationRef: ArtifactRef | null;
  readonly healthRef: ArtifactRef | null;
  readonly hydrationRef: ArtifactRef | null;
  readonly inventoryRef: ArtifactRef | null;
  readonly refinementProposalRef: ArtifactRef | null;
  readonly searchRef: ArtifactRef | null;
} => ({
  backfillPlanRef:
    input.config.backfillPlanRef ??
    input.config.backfillRef ??
    dependencyRefFor({
      dependencyArtifactRefs: input.dependencyArtifactRefs,
      stepId: input.config.backfillPlanStepId ?? input.config.backfillStepId,
    }),
  backfillRunRef:
    input.config.backfillRunRef ??
    dependencyRefFor({
      dependencyArtifactRefs: input.dependencyArtifactRefs,
      stepId: input.config.backfillRunStepId,
    }),
  correlationRef:
    input.config.correlationRef ??
    dependencyRefFor({
      dependencyArtifactRefs: input.dependencyArtifactRefs,
      stepId: input.config.correlationStepId,
    }),
  healthRef:
    input.config.healthRef ??
    dependencyRefFor({
      dependencyArtifactRefs: input.dependencyArtifactRefs,
      stepId: input.config.healthStepId,
    }),
  hydrationRef:
    input.config.hydrationRef ??
    dependencyRefFor({
      dependencyArtifactRefs: input.dependencyArtifactRefs,
      stepId: input.config.hydrationStepId,
    }),
  inventoryRef:
    input.config.inventoryRef ??
    dependencyRefFor({
      dependencyArtifactRefs: input.dependencyArtifactRefs,
      stepId: input.config.inventoryStepId,
    }),
  refinementProposalRef:
    input.config.refinementProposalRef ??
    dependencyRefFor({
      dependencyArtifactRefs: input.dependencyArtifactRefs,
      stepId: input.config.refinementProposalStepId,
    }),
  searchRef:
    input.config.searchRef ??
    dependencyRefFor({
      dependencyArtifactRefs: input.dependencyArtifactRefs,
      stepId: input.config.searchStepId,
    }),
});

const hitlDecisionRefFor = (input: {
  readonly config: z.infer<
    typeof DreamHitlDecisionWorkflowSeedNodeConfigSchema
  >;
  readonly dependencyArtifactRefs: Readonly<Record<string, ArtifactRef>>;
  readonly inputRefs: readonly ArtifactRef[];
}): ArtifactRef | null =>
  input.config.decisionRef ??
  dependencyRefFor({
    dependencyArtifactRefs: input.dependencyArtifactRefs,
    stepId: input.config.decisionStepId,
  }) ??
  input.inputRefs.at(0) ??
  null;

interface RequiredReportRefs {
  readonly backfillPlanRef: ArtifactRef;
  readonly backfillRunRef: ArtifactRef;
  readonly correlationRef: ArtifactRef;
  readonly healthRef: ArtifactRef;
  readonly hydrationRef: ArtifactRef;
  readonly inventoryRef: ArtifactRef;
  readonly searchRef: ArtifactRef;
}

interface LoadedReportInputs {
  readonly backfill: DreamBackfillPlanDocument;
  readonly backfillRun: DreamBackfillRunReceiptDocument;
  readonly correlation: DreamCorrelationGraphDocument;
  readonly health: DreamSourceHealthDocument;
  readonly hydration: DreamHydrationDocument;
  readonly inventory: DreamSourceInventoryDocument;
  readonly search: DreamMemorySearchDocument;
}

const requiredReportRefsFor = (
  refs: ReturnType<typeof reportRefsFor>
): RequiredReportRefs | BlockedWorkflowNodeExecutionResult => {
  if (
    refs.backfillPlanRef === null ||
    refs.backfillRunRef === null ||
    refs.correlationRef === null ||
    refs.healthRef === null ||
    refs.hydrationRef === null ||
    refs.inventoryRef === null ||
    refs.searchRef === null
  ) {
    return blocker(
      "stale_package",
      "Dream HITL report node requires source inventory, source health, backfill plan, backfill run receipt, search, hydration, and correlation artifact refs."
    );
  }

  return {
    backfillPlanRef: refs.backfillPlanRef,
    backfillRunRef: refs.backfillRunRef,
    correlationRef: refs.correlationRef,
    healthRef: refs.healthRef,
    hydrationRef: refs.hydrationRef,
    inventoryRef: refs.inventoryRef,
    searchRef: refs.searchRef,
  };
};

const loadRequiredReportInputs = async (
  artifacts: ArtifactStoreContract,
  refs: RequiredReportRefs
): Promise<LoadedReportInputs | BlockedWorkflowNodeExecutionResult> => {
  const inventory = await loadInventory({
    artifactRef: refs.inventoryRef,
    artifacts,
  });
  if (inventory.status === "blocked") {
    return inventory;
  }

  const health = await loadHealth({
    artifactRef: refs.healthRef,
    artifacts,
  });
  if (health.status === "blocked") {
    return health;
  }

  const backfill = await loadBackfill({
    artifactRef: refs.backfillPlanRef,
    artifacts,
  });
  if (backfill.status === "blocked") {
    return backfill;
  }

  const backfillRun = await loadBackfillRun({
    artifactRef: refs.backfillRunRef,
    artifacts,
  });
  if (backfillRun.status === "blocked") {
    return backfillRun;
  }

  const search = await loadSearch({
    artifactRef: refs.searchRef,
    artifacts,
  });
  if (search.status === "blocked") {
    return search;
  }

  const hydration = await loadHydration({
    artifactRef: refs.hydrationRef,
    artifacts,
  });
  if (hydration.status === "blocked") {
    return hydration;
  }

  const correlation = await loadCorrelation({
    artifactRef: refs.correlationRef,
    artifacts,
  });
  if (correlation.status === "blocked") {
    return correlation;
  }

  return {
    backfill: backfill.document,
    backfillRun: backfillRun.document,
    correlation: correlation.document,
    health: health.document,
    hydration: hydration.document,
    inventory: inventory.document,
    search: search.document,
  };
};

const loadOptionalRefinementProposalDocument = async (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly refinementProposalRef: ArtifactRef | null;
}): Promise<
  | {
      readonly document: DreamRefinementProposalDocument | null;
      readonly status: "loaded";
    }
  | BlockedWorkflowNodeExecutionResult
> => {
  if (input.refinementProposalRef === null) {
    return {
      document: null,
      status: "loaded",
    };
  }

  const refinementProposals = await loadRefinementProposals({
    artifactRef: input.refinementProposalRef,
    artifacts: input.artifacts,
  });
  if (refinementProposals.status === "blocked") {
    return refinementProposals;
  }

  return {
    document: refinementProposals.document,
    status: "loaded",
  };
};

const receiptKey = (receipt: DreamReceiptRef): string =>
  `${receipt.sourceId}:${receipt.receiptId}:${receipt.hash ?? ""}`;

const hydrationReceiptsFor = (input: {
  readonly maxReceipts: number;
  readonly search: DreamMemorySearchDocument;
}): DreamReceiptRef[] => {
  const receipts: DreamReceiptRef[] = [];
  const seen = new Set<string>();

  for (const hit of input.search.hits) {
    for (const receipt of hit.receipts) {
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

const dreamFamilyLabels: Record<DreamSourceFamily, string> = {
  "agent-transcripts": "agent transcripts",
  brain: "Brain notes",
  "cloudflare-runs": "Cloudflare runs",
  comms: "comms",
  "docs-pdf-brain": "PDF brain",
  "people-org-memory": "people and org memory",
  "repo-outputs": "repo outputs",
  support: "support signals",
};

const d2Label = (value: string): string => JSON.stringify(value);

const dreamReportStateMachineFigureFor = (
  machine: DynamicWorkflowMachineDocument
): DreamHitlReportDocument["proof"]["stateMachineFigure"] => {
  const stateEntries = Object.entries(machine.xstate.states);
  const stateIds = new Map(
    stateEntries.map(([stateName], index) => [stateName, `s${index}`])
  );
  const transitions = stateEntries.flatMap(([stateName, state]) =>
    Object.entries(state.on).map(([eventName, transition]) => ({
      eventName,
      from: stateName,
      to: transition.target,
    }))
  );
  const maxFanOut = Math.max(
    0,
    ...stateEntries.map(([, state]) => Object.keys(state.on).length)
  );
  let aspectRatio = "4:5";
  if (stateEntries.length >= 10 && maxFanOut <= 2) {
    aspectRatio = "3:5";
  } else if (maxFanOut >= 3) {
    aspectRatio = "16:9";
  }
  const nodeLines = stateEntries.map(([stateName, state]) => {
    const stateId = stateIds.get(stateName);
    if (stateId === undefined) {
      throw new Error(`Generated machine state id missing for ${stateName}.`);
    }

    const stepSummary =
      state.meta.stepId === undefined ? "" : `\n${state.meta.stepId}`;
    const finalSummary = state.type === "final" ? "\nfinal" : "";

    return `${stateId}: ${d2Label(`${stateName}${stepSummary}${finalSummary}`)}`;
  });
  const edgeLines = transitions.map((transition) => {
    const fromId = stateIds.get(transition.from);
    const toId = stateIds.get(transition.to);
    if (fromId === undefined || toId === undefined) {
      throw new Error(
        `Generated machine transition references an unknown state: ${transition.from} -> ${transition.to}.`
      );
    }

    return `${fromId} -> ${toId}: ${d2Label(transition.eventName)}`;
  });

  return {
    aspectRatio,
    component: "D2",
    machineId: machine.machineId,
    source: [
      "direction: down",
      ...nodeLines,
      ...edgeLines,
      `initial: ${d2Label(machine.xstate.initial)}`,
      `machine: ${d2Label(machine.machineId)}`,
    ].join("\n"),
    sourceKind: "generated-xstate-machine",
    stateCount: stateEntries.length,
    transitionCount: transitions.length,
  };
};

const frontMatterString = (value: string): string => JSON.stringify(value);

const receiptLineFor = (receipt: DreamReceiptRef): string =>
  `- ${receipt.family} / ${receipt.sourceId} / ${receipt.receiptId}`;

const ratingForHit = (hit: DreamMemorySearchHit): number =>
  Math.min(10, Math.max(1, Math.round(hit.score * 10)));

const dreamCardForHit = (input: {
  readonly hydratedReceiptKeys: ReadonlySet<string>;
  readonly hit: DreamMemorySearchHit;
  readonly index: number;
}): DreamHitlDreamCard => {
  const receipt = input.hit.receipts.at(0);
  const familyLabel =
    receipt === undefined ? "memory fabric" : dreamFamilyLabels[receipt.family];
  const hydrated = input.hit.receipts.some((candidate) =>
    input.hydratedReceiptKeys.has(receiptKey(candidate))
  );

  return {
    rating: ratingForHit(input.hit),
    reasoning: hydrated
      ? "The search hit has matching redacted hydration, so the report can point at receipts without returning full transcripts."
      : "The search hit has receipt metadata but no matching hydration yet, so treat this as a lead instead of a claim.",
    receipts: input.hit.receipts,
    recommendation:
      "Review the receipts, decide whether this updates .brain, and turn any capture gap into a recovery task instead of normal Dream behavior.",
    summary: input.hit.summary,
    title: `Dream ${input.index + 1}: ${familyLabel} needs human review`,
  };
};

const dreamCardsFor = (input: {
  readonly hydration: DreamHydrationDocument;
  readonly search: DreamMemorySearchDocument;
}): DreamHitlDreamCard[] => {
  const hydratedReceiptKeys = new Set(
    input.hydration.hydrated.map((hydrated) => receiptKey(hydrated.receipt))
  );

  return input.search.hits.map((hit, index) =>
    dreamCardForHit({
      hit,
      hydratedReceiptKeys,
      index,
    })
  );
};

const proposalSlugFor = (value: string): string => {
  const slug = value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-|-$/gu, "")
    .slice(0, 40);

  return slug.length === 0 ? "dream" : slug;
};

const targetKindForHit = (
  hit: DreamMemorySearchHit
): DreamRefinementProposalTargetKind => {
  const text = hit.summary.toLowerCase();
  const family = hit.receipts.at(0)?.family;

  if (family === "brain") {
    return "kernel-memory";
  }

  if (family === "cloudflare-runs") {
    return "dynamic-workflow-pattern";
  }

  if (family === "repo-outputs") {
    return "package-boundary";
  }

  if (text.includes("schema") || text.includes("type")) {
    return "schema-change";
  }

  if (text.includes("report") || text.includes("hitl")) {
    return "report-node-improvement";
  }

  if (text.includes("package")) {
    return "package-boundary";
  }

  if (text.includes("lease") || text.includes("capability")) {
    return "capability-lease";
  }

  if (text.includes("workflow")) {
    return "dynamic-workflow-pattern";
  }

  return "workflow-node-plugin";
};

const proposedNextStepFor = (
  targetKind: DreamRefinementProposalTargetKind
): string => {
  if (targetKind === "capability-lease") {
    return "Review the capability boundary and decide whether the next generated workflow needs a new leased port.";
  }

  if (targetKind === "capture-ingest-fix") {
    return "Turn this into a capture or ingest repair task so backfill stays recovery-only.";
  }

  if (targetKind === "dynamic-workflow-pattern") {
    return "Feed this pattern into the next planner prompt as a generated workflow constraint with proof requirements.";
  }

  if (targetKind === "kernel-memory") {
    return "Promote the accepted claim into the appropriate Brain/kernel artifact with receipt refs.";
  }

  if (targetKind === "package-boundary") {
    return "Decide whether this belongs in a package manifest, export contract, or adapter boundary.";
  }

  if (targetKind === "report-node-improvement") {
    return "Patch the report node or Wzrrd renderer contract so future HITL artifacts are easier to act on.";
  }

  if (targetKind === "schema-change") {
    return "Update the Zod contract first, then regenerate inferred TypeScript surfaces and tests.";
  }

  return "Consider whether this should become an installable workflow-node plugin instead of report prose.";
};

const recommendationForProposal = (input: {
  readonly hydrated: boolean;
  readonly rating: number;
  readonly targetKind: DreamRefinementProposalTargetKind;
}): DreamRefinementProposalRecommendation => {
  if (input.targetKind === "capture-ingest-fix") {
    return "turn-into-work";
  }

  if (input.hydrated && input.rating >= 8) {
    return "accept";
  }

  if (input.rating >= 7) {
    return "turn-into-work";
  }

  return "hold";
};

const proposalForHit = (input: {
  readonly hit: DreamMemorySearchHit;
  readonly hydratedReceiptKeys: ReadonlySet<string>;
  readonly index: number;
  readonly sourceRefs: readonly ArtifactRef[];
}): DreamRefinementProposal => {
  const hydrated = input.hit.receipts.some((receipt) =>
    input.hydratedReceiptKeys.has(receiptKey(receipt))
  );
  const rating = ratingForHit(input.hit);
  const targetKind = targetKindForHit(input.hit);

  return {
    proposalId: `proposal:${targetKind}:${input.index + 1}:${proposalSlugFor(
      input.hit.summary
    )}`,
    proposedNextStep: proposedNextStepFor(targetKind),
    rating,
    reasoning: hydrated
      ? "This proposal is backed by redacted hydration, so it can be reviewed without returning raw transcripts."
      : "This proposal is backed by receipt metadata only. Treat it as a lead until hydration exists.",
    receipts: input.hit.receipts,
    recommendation: recommendationForProposal({
      hydrated,
      rating,
      targetKind,
    }),
    sourceRefs: [...input.sourceRefs],
    summary: input.hit.summary,
    targetKind,
    title: `Refine ${targetKind}: ${input.hit.summary}`,
  };
};

const coverageProposalFor = (input: {
  readonly coverage: DreamSourceInventoryDocument["runtimeCoverage"][number];
  readonly index: number;
  readonly sourceRefs: readonly ArtifactRef[];
}): DreamRefinementProposal => ({
  proposalId: `proposal:capture-ingest-fix:runtime:${input.coverage.runtime}`,
  proposedNextStep:
    "Fix native runtime capture or explicitly narrow the next Dream scope before trusting recommendations that depend on this runtime.",
  rating: input.coverage.status === "missing" ? 10 : 7,
  reasoning:
    "A Dream is invalid if runtime coverage is missing or false-positive without saying so. This turns the coverage gap into work instead of hiding it in the appendix.",
  receipts: [],
  recommendation: "turn-into-work",
  sourceRefs: [...input.sourceRefs],
  summary: `${input.coverage.runtime} coverage is ${input.coverage.status}. ${
    input.coverage.missingReason ??
    input.coverage.falsePositiveReason ??
    "The next run needs explicit coverage proof."
  }`,
  targetKind: "capture-ingest-fix",
  title: `Fix ${input.coverage.runtime} Dream coverage`,
});

const backfillProposalFor = (input: {
  readonly action: DreamBackfillRunReceiptDocument["actionResults"][number];
  readonly index: number;
  readonly sourceRefs: readonly ArtifactRef[];
}): DreamRefinementProposal => ({
  proposalId: `proposal:capture-ingest-fix:backfill:${input.index + 1}:${proposalSlugFor(
    input.action.actionId
  )}`,
  proposedNextStep:
    "Convert this backfill result into an ingest/capture fix before treating future Dream backfills as normal operation.",
  rating:
    input.action.status === "blocked" || input.action.status === "failed"
      ? 9
      : 7,
  reasoning:
    "Backfill is recovery, not normal operation. A skipped, blocked, or failed backfill result is still a system improvement candidate.",
  receipts: [],
  recommendation: "turn-into-work",
  sourceRefs: [...input.sourceRefs],
  summary: `${input.action.actionId} ended ${input.action.status}. ${[
    ...input.action.failures,
    ...input.action.skippedReasons,
  ].join(" ")}`,
  targetKind: "capture-ingest-fix",
  title: `Repair Dream backfill path: ${input.action.actionId}`,
});

const captureFixProposalFor = (input: {
  readonly captureFix: DreamBackfillRunReceiptDocument["captureFixResults"][number];
  readonly index: number;
  readonly sourceRefs: readonly ArtifactRef[];
}): DreamRefinementProposal => ({
  proposalId: `proposal:capture-ingest-fix:capture:${input.index + 1}:${proposalSlugFor(
    input.captureFix.fixId
  )}`,
  proposedNextStep:
    "Turn this capture-fix result into source-adapter work so future dreams rely on normal ingest instead of recovery backfill.",
  rating:
    input.captureFix.status === "blocked" ||
    input.captureFix.status === "failed"
      ? 10
      : 8,
  reasoning:
    "Dreaming is supposed to fix the memory fabric, not normalize backfills. A capture-fix result points at the ingest path that should be repaired.",
  receipts: [],
  recommendation: "turn-into-work",
  sourceRefs: [...input.sourceRefs],
  summary: `${input.captureFix.fixId} ended ${input.captureFix.status}. ${[
    input.captureFix.repairAction,
    ...input.captureFix.failures,
    ...input.captureFix.skippedReasons,
  ].join(" ")}`,
  targetKind: "capture-ingest-fix",
  title: `Repair Dream capture path: ${input.captureFix.fixId}`,
});

const targetKindForSignal = (
  signal: DreamSignalDocument["signals"][number]
): DreamRefinementProposalTargetKind => {
  if (signal.kind === "workflow-pattern") {
    return "dynamic-workflow-pattern";
  }

  if (signal.kind === "agent-failure" || signal.kind === "friction") {
    return "workflow-node-plugin";
  }

  if (signal.kind === "correction" || signal.kind === "preference") {
    return "kernel-memory";
  }

  return "package-boundary";
};

const signalProposalFor = (input: {
  readonly index: number;
  readonly signal: DreamSignalDocument["signals"][number];
  readonly sourceRefs: readonly ArtifactRef[];
}): DreamRefinementProposal => {
  const targetKind = targetKindForSignal(input.signal);

  return {
    proposalId: `proposal:${targetKind}:signal:${input.index + 1}:${proposalSlugFor(
      input.signal.signalId
    )}`,
    proposedNextStep: proposedNextStepFor(targetKind),
    rating: Math.min(10, Math.max(1, input.signal.rating * 2)),
    reasoning: input.signal.reasoning,
    receipts: input.signal.receipts,
    recommendation:
      targetKind === "workflow-node-plugin" || input.signal.rating >= 4
        ? "turn-into-work"
        : "hold",
    sourceRefs: [...input.sourceRefs],
    summary: input.signal.summary,
    targetKind,
    title: `Refine ${targetKind} from ${input.signal.kind}: ${input.signal.summary}`,
  };
};

const refinementProposalDocumentFor = (input: {
  readonly backfillRun: DreamBackfillRunReceiptDocument;
  readonly backfillRunRef: ArtifactRef;
  readonly correlation: DreamCorrelationGraphDocument;
  readonly correlationRef: ArtifactRef;
  readonly health: DreamSourceHealthDocument;
  readonly healthRef: ArtifactRef;
  readonly hydration: DreamHydrationDocument;
  readonly hydrationRef: ArtifactRef;
  readonly inventory: DreamSourceInventoryDocument;
  readonly inventoryRef: ArtifactRef;
  readonly maxProposals: number;
  readonly search: DreamMemorySearchDocument;
  readonly searchRef: ArtifactRef;
  readonly signals: DreamSignalDocument;
  readonly signalsRef: ArtifactRef;
}): DreamRefinementProposalDocument => {
  const sourceRefs = [
    input.inventoryRef,
    input.healthRef,
    input.backfillRunRef,
    input.signalsRef,
    input.searchRef,
    input.hydrationRef,
    input.correlationRef,
  ];
  const hydratedReceiptKeys = new Set(
    input.hydration.hydrated.map((hydrated) => receiptKey(hydrated.receipt))
  );
  const coverageProposals = input.inventory.runtimeCoverage
    .filter((coverage) => coverage.status !== "captured")
    .map((coverage, index) =>
      coverageProposalFor({
        coverage,
        index,
        sourceRefs: [input.inventoryRef, input.healthRef],
      })
    );
  const backfillProposals = input.backfillRun.actionResults
    .filter((action) => action.status !== "completed")
    .map((action, index) =>
      backfillProposalFor({
        action,
        index,
        sourceRefs: [input.backfillRunRef],
      })
    );
  const captureFixProposals = input.backfillRun.captureFixResults
    .filter((captureFix) => captureFix.status !== "completed")
    .map((captureFix, index) =>
      captureFixProposalFor({
        captureFix,
        index,
        sourceRefs: [input.backfillRunRef],
      })
    );
  const signalProposals = input.signals.signals.map((signal, index) =>
    signalProposalFor({
      index,
      signal,
      sourceRefs: [input.signalsRef],
    })
  );
  const hitProposals = input.search.hits.map((hit, index) =>
    proposalForHit({
      hit,
      hydratedReceiptKeys,
      index,
      sourceRefs: [input.searchRef, input.hydrationRef, input.correlationRef],
    })
  );
  const proposals = [
    ...coverageProposals,
    ...captureFixProposals,
    ...backfillProposals,
    ...signalProposals,
    ...hitProposals,
  ]
    .toSorted((left, right) => right.rating - left.rating)
    .slice(0, input.maxProposals);

  return DreamRefinementProposalDocumentSchema.parse({
    generatedAt: new Date().toISOString(),
    nextWorkflowSeed: {
      plannerInstructions: [
        "Use accepted Dream refinement proposals as constraints for the next generated workflow.",
        "Do not treat proposal text as proof; follow sourceRefs and receipts before updating Brain or packages.",
        "Keep backfill as recovery-only and turn recurring capture gaps into adapter work.",
      ],
      proposalIds: proposals.map((proposal) => proposal.proposalId),
      requiredCapabilityKinds: [
        ...new Set(
          proposals.flatMap((proposal) =>
            proposal.targetKind === "capability-lease"
              ? ["capability-lease.review"]
              : []
          )
        ),
      ],
      sourceRefs,
    },
    proposalCount: proposals.length,
    proposals,
    redacted: true,
    runId: input.search.runId,
    schemaVersion: "dream.refinement-proposals.v1",
    sourceRefs,
    workItemId: input.search.workItemId,
  });
};

const actionableHitlDecisionsFor = (
  document: DreamHitlDecisionDocument
): DreamHitlDecisionDocument["decisions"] =>
  document.decisions.filter(
    (decision) =>
      decision.decision === "accept" || decision.decision === "turn-into-work"
  );

const uniqueArtifactRefs = (refs: readonly ArtifactRef[]): ArtifactRef[] => [
  ...new Set(refs),
];

const hitlDecisionWorkflowSeedDocumentFor = (input: {
  readonly decision: DreamHitlDecisionDocument;
  readonly decisionRef: ArtifactRef;
}): DreamHitlDecisionWorkflowSeedDocument => {
  const actionableDecisions = actionableHitlDecisionsFor(input.decision);
  const acceptedDecisionIds = input.decision.decisions
    .filter((decision) => decision.decision === "accept")
    .map((decision) => decision.decisionId);
  const workItemDecisionIds = input.decision.decisions
    .filter((decision) => decision.decision === "turn-into-work")
    .map((decision) => decision.decisionId);
  const heldDecisionIds = input.decision.decisions
    .filter((decision) => decision.decision === "hold")
    .map((decision) => decision.decisionId);
  const rejectedDecisionIds = input.decision.decisions
    .filter((decision) => decision.decision === "reject")
    .map((decision) => decision.decisionId);
  const sourceRefs = uniqueArtifactRefs([
    input.decisionRef,
    input.decision.reportRef,
    ...(input.decision.refinementProposalRef === undefined
      ? []
      : [input.decision.refinementProposalRef]),
    ...input.decision.sourceRefs,
    ...input.decision.nextWorkflowSeed.sourceRefs,
    ...input.decision.decisions.flatMap((decision) => decision.sourceRefs),
    ...input.decision.nextWorkflowSeed.artifactUpdateTargets.flatMap(
      (target) => target.sourceRefs
    ),
  ]);
  const status =
    actionableDecisions.length === 0
      ? "no-actionable-decisions"
      : ("ready" as const);
  const summary =
    status === "ready"
      ? `HITL accepted ${acceptedDecisionIds.length} decision(s) and turned ${workItemDecisionIds.length} decision(s) into work; the next generated workflow must consume ${input.decision.nextWorkflowSeed.plannerInstructions.length} planner instruction(s).`
      : "HITL review did not accept or turn any Dream decision into work; the next generated workflow seed is intentionally empty.";

  return DreamHitlDecisionWorkflowSeedDocumentSchema.parse({
    acceptedDecisionIds,
    actionableDecisionCount: actionableDecisions.length,
    actionableDecisions,
    decisionRef: input.decisionRef,
    generatedAt: new Date().toISOString(),
    heldDecisionIds,
    nextWorkflowSeed: input.decision.nextWorkflowSeed,
    redacted: true,
    ...(input.decision.refinementProposalRef === undefined
      ? {}
      : { refinementProposalRef: input.decision.refinementProposalRef }),
    rejectedDecisionIds,
    reportRef: input.decision.reportRef,
    runId: input.decision.runId,
    schemaVersion: "dream.hitl-decision-workflow-seed.v1",
    sourceRefs,
    status,
    summary,
    workItemDecisionIds,
    workItemId: input.decision.workItemId,
  });
};

const dreamCardMdsvxFor = (dream: DreamHitlDreamCard): string =>
  [
    `### ${dream.title}`,
    dream.summary,
    `**Reasoning.** ${dream.reasoning}`,
    `**Rating.** ${dream.rating}/10`,
    `**Recommendation.** ${dream.recommendation}`,
    "**Receipts.**",
    dream.receipts.map(receiptLineFor).join("\n"),
  ].join("\n\n");

const dreamActionLineFor = (dream: DreamHitlDreamCard): string =>
  `- **${dream.title}** Rating ${dream.rating}/10. ${dream.recommendation}`;

const refinementProposalActionLineFor = (
  proposal: DreamRefinementProposal
): string =>
  `- **${proposal.title}** ${proposal.rating}/10. ${proposal.recommendation}: ${proposal.proposedNextStep}`;

const runtimeCoverageLineFor = (
  coverage: DreamSourceInventoryDocument["runtimeCoverage"][number]
): string => {
  const horizonSummary =
    coverage.horizonCounts.length === 0
      ? "no horizon counts"
      : coverage.horizonCounts
          .map(
            (horizon) =>
              `${horizon.horizon}: ${horizon.hitCount} hit(s), ${horizon.hydrationCount} hydrated`
          )
          .join("; ");
  const proofSummary =
    coverage.nativeProof?.sourceId ??
    coverage.missingReason ??
    coverage.falsePositiveReason ??
    "no proof detail";

  return `- **${coverage.runtime}**: ${coverage.status}; native source ${coverage.sourceNative ? "yes" : "no"}; ${horizonSummary}; ${proofSummary}.`;
};

const runtimeCoverageSectionFor = (
  inventory: DreamSourceInventoryDocument
): string => inventory.runtimeCoverage.map(runtimeCoverageLineFor).join("\n");

const hitlDecisionContractFor = (
  sourceRefs: readonly ArtifactRef[]
): DreamHitlDecisionContract =>
  DreamHitlDecisionContractSchema.parse({
    artifactPath: "dream/hitl-decision.json",
    contractRef: "contract://workflow/dream-memory-fabric/hitl-decision.v1",
    decisionSchemaVersion: "dream.hitl-decision.v1",
    exportId: "dream-hitl-decision-schema",
    nextWorkflowSeedRequiredFor: ["accept", "turn-into-work"],
    sourceRefs,
    targetKinds: ["dream-card", "refinement-proposal"],
  });

const reportMdsvxFor = (input: {
  readonly backfill: DreamBackfillPlanDocument;
  readonly backfillRun: DreamBackfillRunReceiptDocument;
  readonly correlation: DreamCorrelationGraphDocument;
  readonly hitlDecisionContract: DreamHitlDecisionContract;
  readonly dreamCount: number;
  readonly dreams: readonly DreamHitlDreamCard[];
  readonly health: DreamSourceHealthDocument;
  readonly hydration: DreamHydrationDocument;
  readonly inventory: DreamSourceInventoryDocument;
  readonly plan: DynamicWorkflowPlanDocument;
  readonly proofLevel: DreamHitlReportProofLevel;
  readonly receiptCount: number;
  readonly refinementProposals: readonly DreamRefinementProposal[];
  readonly search: DreamMemorySearchDocument;
  readonly stateMachineFigure: DreamHitlReportDocument["proof"]["stateMachineFigure"];
  readonly title: string;
}): string => {
  const dreamSection =
    input.dreams.length === 0
      ? "No dreams cleared the receipt threshold in this run."
      : input.dreams.map(dreamCardMdsvxFor).join("\n\n");
  let actionSection = "- Treat this run as a retrieval/capture diagnostic.";
  if (input.refinementProposals.length > 0) {
    actionSection = input.refinementProposals
      .map(refinementProposalActionLineFor)
      .join("\n");
  } else if (input.dreams.length > 0) {
    actionSection = input.dreams.map(dreamActionLineFor).join("\n");
  }
  const completedBackfillActions = input.backfillRun.actionResults.filter(
    (action) => action.status === "completed"
  ).length;
  const blockedBackfillActions = input.backfillRun.actionResults.filter(
    (action) => action.status === "blocked" || action.status === "failed"
  ).length;
  const completedCaptureFixes = input.backfillRun.captureFixResults.filter(
    (captureFix) => captureFix.status === "completed"
  ).length;
  const blockedCaptureFixes = input.backfillRun.captureFixResults.filter(
    (captureFix) =>
      captureFix.status === "blocked" || captureFix.status === "failed"
  ).length;

  return [
    "---",
    `expiresIn: ${frontMatterString("24h")}`,
    "noindex: true",
    `template: ${frontMatterString("joel/tufte-mdsvx@0.1.0")}`,
    `title: ${frontMatterString(input.title)}`,
    "---",
    "",
    `# ${input.title}`,
    "",
    "This is a human review surface, not an autopatcher. The report puts dreams first, then proof, so the human can decide what to accept, hold, reject, or turn into work.",
    "",
    "## Run context",
    "",
    `Run ${input.inventory.runId} searched ${input.search.hits.length} memory hits, hydrated ${input.hydration.hydrated.length} redacted receipts, and produced ${input.dreamCount} dreams for human review.`,
    "",
    `Dreams: ${input.dreamCount}. Unique receipts: ${input.receiptCount}. Status: ${input.health.status}. Expiry: 24h, noindex.`,
    "",
    "## The actual dreams",
    "",
    dreamSection,
    "",
    "## What to do with these dreams",
    "",
    "Use this as HITL input, not autopilot. Accept a dream only when the receipt trail is good enough to update .brain, create a capture fix, or refine a workflow/package decision.",
    "",
    `Refinement proposals emitted: ${input.refinementProposals.length}. Accepted proposals should become Brain/package changes or constraints for the next generated workflow.`,
    "",
    "### HITL decision receipt",
    "",
    `Write human decisions as \`${input.hitlDecisionContract.decisionSchemaVersion}\` at \`${input.hitlDecisionContract.artifactPath}\`, backed by this report and its source refs.`,
    "",
    `Schema export: \`${input.hitlDecisionContract.exportId}\` from \`${input.hitlDecisionContract.contractRef}\`.`,
    "",
    `Decisions that must feed the next generated workflow seed: ${input.hitlDecisionContract.nextWorkflowSeedRequiredFor.join(", ")}.`,
    "",
    "## Actionable line items",
    "",
    actionSection,
    "",
    "## Report node",
    "",
    "`joelclaw.dream.hitl-report` rendered this artifact as an installed Dream workflow cartridge node. The JSON document is the machine contract; this sibling `text/mdsvx` artifact is the publishable HITL source.",
    "",
    "## Workflow state machine",
    "",
    "The D2 source below is rendered from the pinned generated `workflow.xstate-machine.v1` config for this run, not from a static Dream node list. It belongs below the dreams so proof does not bury the human decision.",
    "",
    "```d2",
    input.stateMachineFigure.source,
    "```",
    "",
    "## Dynamic generation proof",
    "",
    `Dynamic generation proof level: ${input.proofLevel}.`,
    "",
    `Generated machine: ${input.plan.machine.artifactRef} hash ${input.plan.machine.hash}.`,
    "",
    `Generated machine source: ${input.plan.machine.sourceArtifactRef} hash ${input.plan.machine.sourceHash}.`,
    "",
    `Generated harness: ${input.plan.harness.artifactRef} hash ${input.plan.harness.hash}.`,
    "",
    `Verification contract: ${input.plan.verificationContract.artifactRef} hash ${input.plan.verificationContract.hash}.`,
    "",
    `Planner lane: ${input.plan.planner.source}, nonce ${input.plan.planner.nonce}. Plan ${input.plan.planId} has ${input.plan.steps.length} step(s).`,
    "",
    "The report records report-level generated artifact refs and hashes. Final acceptance still depends on the surrounding `workflow.execution-proof.v1`, cartridge invocation proofs, post-execution `dream.generated-workflow-proof.v1`, and verifier result.",
    "",
    "## Run coverage",
    "",
    runtimeCoverageSectionFor(input.inventory),
    "",
    `Source health: ${input.health.status}. Recovery receipt: ${input.backfillRun.actionResults.length} index action result(s), ${completedBackfillActions} completed, ${blockedBackfillActions} blocked or failed. Capture fixes: ${input.backfillRun.captureFixResults.length} result(s), ${completedCaptureFixes} completed, ${blockedCaptureFixes} blocked or failed.`,
    "",
    `Correlation graph: ${input.correlation.nodes.length} nodes, ${input.correlation.edges.length} source-backed edges.`,
    "",
    "## Access adapter shape",
    "",
    "Dream memory access goes through the trusted Dream relay contract. Cloudflare receives redacted receipt metadata, source freshness, hashes, coverage counts, and follow-up refs; raw local paths, raw transcripts, and credentials stay behind the relay.",
    "",
    "## Report standard",
    "",
    "Template: `joel/tufte-mdsvx@0.1.0`. Public Wzrrd publication must remain `noindex` and expiring by default. The canonical source file is this MDSvX artifact, not a rendered preview.",
    "",
    "## What did not happen",
    "",
    "- Raw transcripts were not returned.",
    "- This report did not directly publish to Wzrrd; publication remains a separate leased `wzrrd.site.publish` side effect.",
    "- This report did not mutate Brain, packages, source indexes, or capability policies by itself.",
    "",
    "## Technical appendix",
    "",
    `Recovery receipt: ${input.backfillRun.actionResults.length} index action result(s), ${completedBackfillActions} completed. Capture fixes: ${input.backfillRun.captureFixResults.length} result(s), ${completedCaptureFixes} completed.`,
    "",
    `Correlation graph: ${input.correlation.nodes.length} nodes, ${input.correlation.edges.length} source-backed edges.`,
    "",
    `Receipt count: ${input.receiptCount}. Raw transcripts returned: no.`,
    "",
    `Source health: ${input.health.status}. Backfill plan status: ${input.backfill.status}. Backfill run schema: ${input.backfillRun.schemaVersion}. Correlation graph schema: ${input.correlation.schemaVersion}. Refinement proposal count: ${input.refinementProposals.length}. Template seed: joel/tufte-mdsvx@0.1.0. Publish policy: noindex and 24h expiry by default.`,
  ].join("\n");
};

const uniqueReceiptCountFor = (search: DreamMemorySearchDocument): number =>
  new Set(
    search.hits.flatMap((hit) =>
      hit.receipts.map((receipt) => receiptKey(receipt))
    )
  ).size;

const executeSourceInventoryNode = async (
  config: DreamMemoryFabricWorkflowNodeAdapterConfig,
  input: DreamWorkflowNodeExecutionInput
): Promise<WorkflowNodeExecutionResult> => {
  const nodeConfig = DreamSourceInventoryNodeConfigSchema.parse(
    input.step.config
  );
  const result = await config.dreamMemoryFabric.inventorySources({
    actor: input.actor,
    requiredRuntimes: nodeConfig.requiredRuntimes,
    runId: input.plan.runId,
    sourceFamiliesExpected: nodeConfig.sourceFamiliesExpected,
    workItemId: input.plan.workItemId,
  });
  if (result.status === "blocked") {
    return result;
  }

  return await writeDocument({
    artifacts: config.artifacts,
    document: DreamSourceInventoryDocumentSchema.parse(result.document),
    relayLeaseReceipt: result.relayLeaseReceipt,
    step: input.step,
  });
};

const executeSourceHealthNode = async (
  config: DreamMemoryFabricWorkflowNodeAdapterConfig,
  input: DreamWorkflowNodeExecutionInput
): Promise<WorkflowNodeExecutionResult> => {
  const nodeConfig = DreamSourceHealthNodeConfigSchema.parse(input.step.config);
  const inventoryRef = inventoryRefFor({
    config: nodeConfig,
    dependencyArtifactRefs: input.dependencyArtifactRefs,
  });
  if (inventoryRef === null) {
    return blocker(
      "stale_package",
      "Dream source health node requires a source inventory artifact ref."
    );
  }

  const inventory = await loadInventory({
    artifactRef: inventoryRef,
    artifacts: config.artifacts,
  });
  if (inventory.status === "blocked") {
    return inventory;
  }

  const result = await config.dreamMemoryFabric.checkSourceHealth({
    actor: input.actor,
    inventory: inventory.document,
    inventoryRef,
    runId: input.plan.runId,
    workItemId: input.plan.workItemId,
  });
  if (result.status === "blocked") {
    return result;
  }

  return await writeDocument({
    artifacts: config.artifacts,
    document: DreamSourceHealthDocumentSchema.parse(result.document),
    relayLeaseReceipt: result.relayLeaseReceipt,
    step: input.step,
  });
};

const executeMemorySearchNode = async (
  config: DreamMemoryFabricWorkflowNodeAdapterConfig,
  input: DreamWorkflowNodeExecutionInput
): Promise<WorkflowNodeExecutionResult> => {
  if (config.dreamMemoryRetrieval === undefined) {
    return blocker(
      "adapter_unavailable",
      "Dream memory search node requires a Dream memory retrieval adapter."
    );
  }

  const nodeConfig = DreamMemorySearchNodeConfigSchema.parse(input.step.config);
  const result = await config.dreamMemoryRetrieval.searchMemories(
    DreamMemoryRelaySearchPayloadSchema.parse({
      actor: input.actor,
      maxHits: nodeConfig.maxHits,
      query: nodeConfig.query,
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
    document: DreamMemorySearchDocumentSchema.parse(result.document),
    relayLeaseReceipt: result.relayLeaseReceipt,
    step: input.step,
  });
};

const executeSignalsNode = async (
  config: DreamMemoryFabricWorkflowNodeAdapterConfig,
  input: DreamWorkflowNodeExecutionInput
): Promise<WorkflowNodeExecutionResult> => {
  if (config.dreamMemorySignals === undefined) {
    return blocker(
      "adapter_unavailable",
      "Dream signals node requires a Dream memory signal adapter."
    );
  }

  const nodeConfig = DreamSignalsNodeConfigSchema.parse(input.step.config);
  const result = await config.dreamMemorySignals.mineSignals(
    DreamMemoryRelaySignalsPayloadSchema.parse({
      actor: input.actor,
      maxSignals: nodeConfig.maxSignals,
      query: nodeConfig.query,
      runId: input.plan.runId,
      ...(nodeConfig.signalKinds === undefined
        ? {}
        : { signalKinds: nodeConfig.signalKinds }),
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
    document: DreamSignalDocumentSchema.parse(result.document),
    relayLeaseReceipt: result.relayLeaseReceipt,
    step: input.step,
  });
};

const executeHydrationNode = async (
  config: DreamMemoryFabricWorkflowNodeAdapterConfig,
  input: DreamWorkflowNodeExecutionInput
): Promise<WorkflowNodeExecutionResult> => {
  if (config.dreamMemoryRetrieval === undefined) {
    return blocker(
      "adapter_unavailable",
      "Dream hydration node requires a Dream memory retrieval adapter."
    );
  }

  const nodeConfig = DreamHydrationNodeConfigSchema.parse(input.step.config);
  const searchRef = searchRefFor({
    config: nodeConfig,
    dependencyArtifactRefs: input.dependencyArtifactRefs,
  });
  if (searchRef === null) {
    return blocker(
      "stale_package",
      "Dream hydration node requires a memory search artifact ref."
    );
  }

  const search = await loadSearch({
    artifactRef: searchRef,
    artifacts: config.artifacts,
  });
  if (search.status === "blocked") {
    return search;
  }

  const receipts = hydrationReceiptsFor({
    maxReceipts: nodeConfig.maxReceipts,
    search: search.document,
  });
  if (receipts.length === 0) {
    return blocker(
      "stale_package",
      "Dream hydration node requires at least one receipt from memory search."
    );
  }

  const result = await config.dreamMemoryRetrieval.hydrateMemories(
    DreamMemoryRelayHydrationPayloadSchema.parse({
      actor: input.actor,
      receipts,
      runId: input.plan.runId,
      workItemId: input.plan.workItemId,
    })
  );
  if (result.status === "blocked") {
    return result;
  }

  return await writeDocument({
    artifacts: config.artifacts,
    document: DreamHydrationDocumentSchema.parse(result.document),
    relayLeaseReceipt: result.relayLeaseReceipt,
    step: input.step,
  });
};

const executeCorrelationNode = async (
  config: DreamMemoryFabricWorkflowNodeAdapterConfig,
  input: DreamWorkflowNodeExecutionInput
): Promise<WorkflowNodeExecutionResult> => {
  if (config.dreamMemoryCorrelation === undefined) {
    return blocker(
      "adapter_unavailable",
      "Dream correlation node requires a Dream memory correlation adapter."
    );
  }

  const nodeConfig = DreamCorrelationNodeConfigSchema.parse(input.step.config);
  const refs = correlationRefsFor({
    config: nodeConfig,
    dependencyArtifactRefs: input.dependencyArtifactRefs,
  });
  if (refs.searchRef === null || refs.hydrationRef === null) {
    return blocker(
      "stale_package",
      "Dream correlation node requires memory search and hydration artifact refs."
    );
  }

  const search = await loadSearch({
    artifactRef: refs.searchRef,
    artifacts: config.artifacts,
  });
  if (search.status === "blocked") {
    return search;
  }

  const hydration = await loadHydration({
    artifactRef: refs.hydrationRef,
    artifacts: config.artifacts,
  });
  if (hydration.status === "blocked") {
    return hydration;
  }

  const result = await config.dreamMemoryCorrelation.correlateMemories(
    DreamMemoryRelayCorrelationPayloadSchema.parse({
      actor: input.actor,
      hydration: hydration.document,
      hydrationRef: refs.hydrationRef,
      runId: input.plan.runId,
      search: search.document,
      searchRef: refs.searchRef,
      workItemId: input.plan.workItemId,
    })
  );
  if (result.status === "blocked") {
    return result;
  }

  return await writeDocument({
    artifacts: config.artifacts,
    document: DreamCorrelationGraphDocumentSchema.parse(result.document),
    relayLeaseReceipt: result.relayLeaseReceipt,
    step: input.step,
  });
};

const executeRefinementProposalsNode = async (
  config: DreamMemoryFabricWorkflowNodeAdapterConfig,
  input: DreamWorkflowNodeExecutionInput
): Promise<WorkflowNodeExecutionResult> => {
  const nodeConfig = DreamRefinementProposalNodeConfigSchema.parse(
    input.step.config
  );
  const refs = refinementProposalRefsFor({
    config: nodeConfig,
    dependencyArtifactRefs: input.dependencyArtifactRefs,
  });
  if (
    refs.backfillRunRef === null ||
    refs.correlationRef === null ||
    refs.healthRef === null ||
    refs.hydrationRef === null ||
    refs.inventoryRef === null ||
    refs.searchRef === null ||
    refs.signalsRef === null
  ) {
    return blocker(
      "stale_package",
      "Dream refinement proposal node requires inventory, source health, backfill run receipt, signals, search, hydration, and correlation artifact refs."
    );
  }

  const inventory = await loadInventory({
    artifactRef: refs.inventoryRef,
    artifacts: config.artifacts,
  });
  if (inventory.status === "blocked") {
    return inventory;
  }

  const health = await loadHealth({
    artifactRef: refs.healthRef,
    artifacts: config.artifacts,
  });
  if (health.status === "blocked") {
    return health;
  }

  const backfillRun = await loadBackfillRun({
    artifactRef: refs.backfillRunRef,
    artifacts: config.artifacts,
  });
  if (backfillRun.status === "blocked") {
    return backfillRun;
  }

  const search = await loadSearch({
    artifactRef: refs.searchRef,
    artifacts: config.artifacts,
  });
  if (search.status === "blocked") {
    return search;
  }

  const signals = await loadSignals({
    artifactRef: refs.signalsRef,
    artifacts: config.artifacts,
  });
  if (signals.status === "blocked") {
    return signals;
  }

  const hydration = await loadHydration({
    artifactRef: refs.hydrationRef,
    artifacts: config.artifacts,
  });
  if (hydration.status === "blocked") {
    return hydration;
  }

  const correlation = await loadCorrelation({
    artifactRef: refs.correlationRef,
    artifacts: config.artifacts,
  });
  if (correlation.status === "blocked") {
    return correlation;
  }

  const document = refinementProposalDocumentFor({
    backfillRun: backfillRun.document,
    backfillRunRef: refs.backfillRunRef,
    correlation: correlation.document,
    correlationRef: refs.correlationRef,
    health: health.document,
    healthRef: refs.healthRef,
    hydration: hydration.document,
    hydrationRef: refs.hydrationRef,
    inventory: inventory.document,
    inventoryRef: refs.inventoryRef,
    maxProposals: nodeConfig.maxProposals,
    search: search.document,
    searchRef: refs.searchRef,
    signals: signals.document,
    signalsRef: refs.signalsRef,
  });

  return await writeDocument({
    artifacts: config.artifacts,
    document,
    step: input.step,
  });
};

const executeHitlReportNode = async (
  config: DreamMemoryFabricWorkflowNodeAdapterConfig,
  input: DreamWorkflowNodeExecutionInput
): Promise<WorkflowNodeExecutionResult> => {
  const nodeConfig = DreamHitlReportNodeConfigSchema.parse(input.step.config);
  const refs = reportRefsFor({
    config: nodeConfig,
    dependencyArtifactRefs: input.dependencyArtifactRefs,
  });
  const requiredRefs = requiredReportRefsFor(refs);
  if ("status" in requiredRefs) {
    return requiredRefs;
  }

  const reportInputs = await loadRequiredReportInputs(
    config.artifacts,
    requiredRefs
  );
  if ("status" in reportInputs) {
    return reportInputs;
  }

  const refinementProposals = await loadOptionalRefinementProposalDocument({
    artifacts: config.artifacts,
    refinementProposalRef: refs.refinementProposalRef,
  });
  if (refinementProposals.status === "blocked") {
    return refinementProposals;
  }

  const dreams = dreamCardsFor({
    hydration: reportInputs.hydration,
    search: reportInputs.search,
  });
  const receiptCount = uniqueReceiptCountFor(reportInputs.search);
  const stateMachineFigure = dreamReportStateMachineFigureFor(input.machine);
  const sourceRefs = [
    requiredRefs.inventoryRef,
    requiredRefs.healthRef,
    requiredRefs.backfillPlanRef,
    requiredRefs.backfillRunRef,
    requiredRefs.searchRef,
    requiredRefs.hydrationRef,
    requiredRefs.correlationRef,
    ...(refs.refinementProposalRef === null
      ? []
      : [refs.refinementProposalRef]),
  ];
  const hitlDecisionContract = hitlDecisionContractFor(sourceRefs);
  const mdsvx = reportMdsvxFor({
    backfill: reportInputs.backfill,
    backfillRun: reportInputs.backfillRun,
    correlation: reportInputs.correlation,
    dreamCount: dreams.length,
    dreams,
    health: reportInputs.health,
    hitlDecisionContract,
    hydration: reportInputs.hydration,
    inventory: reportInputs.inventory,
    plan: input.plan,
    proofLevel: nodeConfig.dynamicGenerationProofLevel,
    receiptCount,
    refinementProposals: refinementProposals.document?.proposals ?? [],
    search: reportInputs.search,
    stateMachineFigure,
    title: nodeConfig.title,
  });
  const document = DreamHitlReportDocumentSchema.parse({
    dreamCount: dreams.length,
    dreams,
    expiresIn: "24h",
    generatedAt: new Date().toISOString(),
    hitlDecisionContract,
    mdsvx,
    noindex: true,
    proof: {
      dynamicGenerationProofLevel: nodeConfig.dynamicGenerationProofLevel,
      generatedArtifacts: {
        harness: input.plan.harness,
        machine: input.plan.machine,
        plan: {
          planId: input.plan.planId,
          planner: input.plan.planner,
          stepCount: input.plan.steps.length,
        },
        verificationContract: input.plan.verificationContract,
      },
      rawTranscriptsReturned: false,
      stateMachineFigure,
    },
    receiptCount,
    redacted: true,
    refinementProposalCount: refinementProposals.document?.proposalCount ?? 0,
    ...(refs.refinementProposalRef === null
      ? {}
      : { refinementProposalRef: refs.refinementProposalRef }),
    refinementProposals: refinementProposals.document?.proposals ?? [],
    runId: input.plan.runId,
    schemaVersion: "dream.hitl-report.v1",
    sectionOrder: DREAM_HITL_REPORT_SECTION_ORDER,
    sourceRefs,
    template: {
      defaultExpiresIn: "24h",
      format: "mdsvx",
      noindex: true,
      templateId: "joel/tufte-mdsvx",
      version: "0.1.0",
    },
    title: nodeConfig.title,
    workItemId: input.plan.workItemId,
  });

  return await writeHitlReportDocument({
    artifacts: config.artifacts,
    document,
    step: input.step,
  });
};

const executeHitlDecisionWorkflowSeedNode = async (
  config: DreamMemoryFabricWorkflowNodeAdapterConfig,
  input: DreamWorkflowNodeExecutionInput
): Promise<WorkflowNodeExecutionResult> => {
  const nodeConfig = DreamHitlDecisionWorkflowSeedNodeConfigSchema.parse(
    input.step.config
  );
  const decisionRef = hitlDecisionRefFor({
    config: nodeConfig,
    dependencyArtifactRefs: input.dependencyArtifactRefs,
    inputRefs: input.step.inputRefs,
  });
  if (decisionRef === null) {
    return blocker(
      "stale_package",
      "Dream HITL decision seed node requires a dream.hitl-decision.v1 artifact ref."
    );
  }

  const decision = await loadHitlDecision({
    artifactRef: decisionRef,
    artifacts: config.artifacts,
  });
  if (decision.status === "blocked") {
    return decision;
  }

  return await writeDocument({
    artifacts: config.artifacts,
    document: hitlDecisionWorkflowSeedDocumentFor({
      decision: decision.document,
      decisionRef,
    }),
    step: input.step,
  });
};

const executeCaptureRunNode = async (
  config: DreamMemoryFabricWorkflowNodeAdapterConfig,
  input: DreamWorkflowNodeExecutionInput
): Promise<WorkflowNodeExecutionResult> => {
  if (config.dreamMemoryCapture === undefined) {
    return blocker(
      "adapter_unavailable",
      "Dream capture run node requires a Dream memory capture adapter."
    );
  }

  const nodeConfig = DreamCaptureRunNodeConfigSchema.parse(input.step.config);
  const result = await config.dreamMemoryCapture.captureRun(
    DreamMemoryRelayCaptureRunPayloadSchema.parse({
      actor: input.actor,
      ...(nodeConfig.capturedRef === undefined
        ? {}
        : { capturedRef: nodeConfig.capturedRef }),
      readability: nodeConfig.readability,
      runId: input.plan.runId,
      ...(nodeConfig.sourceFamilies === undefined
        ? {}
        : { sourceFamilies: nodeConfig.sourceFamilies }),
      sourceSystem: nodeConfig.sourceSystem,
      targetRunId: nodeConfig.targetRunId ?? input.plan.runId,
      workItemId: input.plan.workItemId,
    })
  );
  if (result.status === "blocked") {
    return result;
  }

  return await writeDocument({
    artifacts: config.artifacts,
    document: DreamCaptureReceiptDocumentSchema.parse(result.document),
    relayLeaseReceipt: result.relayLeaseReceipt,
    step: input.step,
  });
};

const executeCaptureArtifactNode = async (
  config: DreamMemoryFabricWorkflowNodeAdapterConfig,
  input: DreamWorkflowNodeExecutionInput
): Promise<WorkflowNodeExecutionResult> => {
  if (config.dreamMemoryCapture === undefined) {
    return blocker(
      "adapter_unavailable",
      "Dream capture artifact node requires a Dream memory capture adapter."
    );
  }

  const nodeConfig = DreamCaptureArtifactNodeConfigSchema.parse(
    input.step.config
  );
  const artifactRef = captureArtifactRefFor({
    config: nodeConfig,
    dependencyArtifactRefs: input.dependencyArtifactRefs,
  });
  if (artifactRef === null) {
    return blocker(
      "stale_package",
      "Dream capture artifact node requires a generated artifact ref."
    );
  }

  const capturedRef = await captureArtifactPinFor({
    artifactRef,
    artifacts: config.artifacts,
    mediaType: nodeConfig.mediaType,
  });
  if (capturedRef.status === "blocked") {
    return capturedRef;
  }

  const result = await config.dreamMemoryCapture.captureArtifact(
    DreamMemoryRelayCaptureArtifactPayloadSchema.parse({
      actor: input.actor,
      capturedRef: capturedRef.pin,
      readability: nodeConfig.readability,
      runId: input.plan.runId,
      ...(nodeConfig.sourceFamilies === undefined
        ? {}
        : { sourceFamilies: nodeConfig.sourceFamilies }),
      sourceSystem: nodeConfig.sourceSystem,
      workItemId: input.plan.workItemId,
    })
  );
  if (result.status === "blocked") {
    return result;
  }

  return await writeDocument({
    artifacts: config.artifacts,
    document: DreamCaptureReceiptDocumentSchema.parse(result.document),
    relayLeaseReceipt: result.relayLeaseReceipt,
    step: input.step,
  });
};

const executeBackfillRunNode = async (
  config: DreamMemoryFabricWorkflowNodeAdapterConfig,
  input: DreamWorkflowNodeExecutionInput
): Promise<WorkflowNodeExecutionResult> => {
  if (config.dreamMemoryBackfill === undefined) {
    return blocker(
      "adapter_unavailable",
      "Dream backfill run node requires a Dream memory backfill adapter."
    );
  }

  const nodeConfig = DreamBackfillRunNodeConfigSchema.parse(input.step.config);
  const planRef = backfillRunPlanRefFor({
    config: nodeConfig,
    dependencyArtifactRefs: input.dependencyArtifactRefs,
  });
  if (planRef === null) {
    return blocker(
      "stale_package",
      "Dream backfill run node requires a recovery backfill plan artifact ref."
    );
  }

  const plan = await loadBackfill({
    artifactRef: planRef,
    artifacts: config.artifacts,
  });
  if (plan.status === "blocked") {
    return plan;
  }

  const result = await config.dreamMemoryBackfill.runBackfill(
    DreamMemoryRelayBackfillRunPayloadSchema.parse({
      actor: input.actor,
      plan: plan.document,
      planRef,
      runId: input.plan.runId,
      workItemId: input.plan.workItemId,
    })
  );
  if (result.status === "blocked") {
    return result;
  }

  return await writeDocument({
    artifacts: config.artifacts,
    document: DreamBackfillRunReceiptDocumentSchema.parse(result.document),
    relayLeaseReceipt: result.relayLeaseReceipt,
    step: input.step,
  });
};

const executeBackfillPlanNode = async (
  config: DreamMemoryFabricWorkflowNodeAdapterConfig,
  input: DreamWorkflowNodeExecutionInput
): Promise<WorkflowNodeExecutionResult> => {
  const nodeConfig = DreamBackfillPlanNodeConfigSchema.parse(input.step.config);
  const refs = backfillRefsFor({
    config: nodeConfig,
    dependencyArtifactRefs: input.dependencyArtifactRefs,
  });
  if (refs.inventoryRef === null || refs.healthRef === null) {
    return blocker(
      "stale_package",
      "Dream backfill node requires source inventory and source health artifact refs."
    );
  }

  const inventory = await loadInventory({
    artifactRef: refs.inventoryRef,
    artifacts: config.artifacts,
  });
  if (inventory.status === "blocked") {
    return inventory;
  }

  const health = await loadHealth({
    artifactRef: refs.healthRef,
    artifacts: config.artifacts,
  });
  if (health.status === "blocked") {
    return health;
  }

  const result = await config.dreamMemoryFabric.planBackfill({
    actor: input.actor,
    health: health.document,
    healthRef: refs.healthRef,
    inventory: inventory.document,
    inventoryRef: refs.inventoryRef,
    runId: input.plan.runId,
    workItemId: input.plan.workItemId,
  });
  if (result.status === "blocked") {
    return result;
  }

  return await writeDocument({
    artifacts: config.artifacts,
    document: DreamBackfillPlanDocumentSchema.parse(result.document),
    relayLeaseReceipt: result.relayLeaseReceipt,
    step: input.step,
  });
};

export const createDreamMemoryFabricWorkflowNodeAdapter = (
  config: DreamMemoryFabricWorkflowNodeAdapterConfig
): WorkflowNodeAdapterPort => ({
  async execute(input) {
    const nodeTypeResult = DreamMemoryFabricNodeTypeSchema.safeParse(
      input.step.nodeType
    );
    if (!nodeTypeResult.success) {
      return blocker(
        "adapter_unavailable",
        `Dream workflow node adapter does not support nodeType ${input.step.nodeType}.`
      );
    }

    if (nodeTypeResult.data === "joelclaw.dream.source-inventory") {
      return await executeSourceInventoryNode(config, input);
    }

    if (nodeTypeResult.data === "joelclaw.dream.source-health") {
      return await executeSourceHealthNode(config, input);
    }

    if (nodeTypeResult.data === "joelclaw.dream.memory-search") {
      return await executeMemorySearchNode(config, input);
    }

    if (nodeTypeResult.data === "joelclaw.dream.signals") {
      return await executeSignalsNode(config, input);
    }

    if (nodeTypeResult.data === "joelclaw.dream.backfill-run") {
      return await executeBackfillRunNode(config, input);
    }

    if (nodeTypeResult.data === "joelclaw.dream.capture-run") {
      return await executeCaptureRunNode(config, input);
    }

    if (nodeTypeResult.data === "joelclaw.dream.capture-artifact") {
      return await executeCaptureArtifactNode(config, input);
    }

    if (nodeTypeResult.data === "joelclaw.dream.correlate") {
      return await executeCorrelationNode(config, input);
    }

    if (nodeTypeResult.data === "joelclaw.dream.refinement-proposals") {
      return await executeRefinementProposalsNode(config, input);
    }

    if (nodeTypeResult.data === "joelclaw.dream.hitl-decision-seed") {
      return await executeHitlDecisionWorkflowSeedNode(config, input);
    }

    if (nodeTypeResult.data === "joelclaw.dream.hitl-report") {
      return await executeHitlReportNode(config, input);
    }

    if (nodeTypeResult.data === "joelclaw.dream.hydrate") {
      return await executeHydrationNode(config, input);
    }

    return await executeBackfillPlanNode(config, input);
  },
});
