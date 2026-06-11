import { z } from "zod";

import type {
  ArtifactStoreContract,
  WorkflowNodeAdapterPort,
  WorkflowNodeExecutionResult,
  WorkflowNodeInvocationStep,
} from "../../app/application/ports.ts";
import { hashJson, sha256Hex } from "../../app/domain/hash.ts";
import {
  ArtifactPinSchema,
  ArtifactRefSchema,
} from "../../app/domain/schemas.ts";
import type {
  ArtifactPin,
  ArtifactRef,
  CapabilityBlocker,
  DynamicWorkflowMachineDocument,
  DynamicWorkflowPlanDocument,
} from "../../app/domain/schemas.ts";
import { MemorySourceFamilySchema } from "../../app/domain/source-profile.ts";
import type { MemorySourceFamily } from "../../app/domain/source-profile.ts";
import {
  WORKFLOW_HITL_REPORT_SECTION_ORDER,
  MemoryCaptureReceiptDocumentSchema,
  MemoryCorrelationGraphDocumentSchema,
  MemoryHitlDecisionContractSchema,
  MemoryHitlDecisionDocumentSchema,
  MemoryHitlFollowUpRunRequestDocumentSchema,
  MemoryHitlDecisionWorkflowSeedDocumentSchema,
  WorkflowHitlReportDefinitionOfDoneAuditSchema,
  WorkflowHitlReportDocumentSchema,
  WorkflowHitlReportProofLevelSchema,
  MemoryHydrationDocumentSchema,
  MemoryRelayCaptureArtifactPayloadSchema,
  MemoryRelayCaptureRunPayloadSchema,
  MemoryRelayCorrelationPayloadSchema,
  MemoryRelayHydrationPayloadSchema,
  MemoryRelayLeaseReceiptSchema,
  MemoryRelaySearchPayloadSchema,
  MemoryRelaySignalsPayloadSchema,
  MemorySearchDocumentSchema,
  MemoryRefinementProposalDocumentSchema,
  MemorySignalDocumentSchema,
  MemorySignalKindSchema,
} from "./schemas.ts";
import type {
  MemoryCaptureReceiptDocument,
  MemoryCorrelationGraphDocument,
  MemoryHitlDecisionContract,
  MemoryHitlDecisionDocument,
  MemoryHitlFollowUpRunRequestDocument,
  MemoryHitlDecisionWorkflowSeedDocument,
  WorkflowHitlReportCard,
  WorkflowHitlReportDefinitionOfDoneAudit,
  WorkflowHitlReportDefinitionOfDoneAuditItem,
  WorkflowHitlReportDocument,
  WorkflowHitlReportProofLevel,
  MemoryHydrationDocument,
  MemoryRelayCaptureArtifactPayload,
  MemoryRelayCaptureRunPayload,
  MemoryRelayCorrelationPayload,
  MemoryRelayHydrationPayload,
  MemoryRelayLeaseReceipt,
  MemoryRelaySearchPayload,
  MemoryRelaySignalsPayload,
  MemorySearchDocument,
  MemorySearchHit,
  MemoryReceiptRef,
  MemoryRefinementProposal,
  MemoryRefinementProposalDocument,
  MemoryRefinementProposalRecommendation,
  MemoryRefinementProposalTargetKind,
  MemorySignalDocument,
} from "./schemas.ts";

export type MemoryFabricResult<TDocument> =
  | {
      readonly blocker: CapabilityBlocker;
      readonly status: "blocked";
    }
  | {
      readonly document: TDocument;
      readonly relayLeaseReceipt?: MemoryRelayLeaseReceipt;
      readonly status: "ready";
    };

export interface MemoryRetrievalPort {
  hydrateMemories(
    input: MemoryRelayHydrationPayload
  ): Promise<MemoryFabricResult<MemoryHydrationDocument>>;

  searchMemories(
    input: MemoryRelaySearchPayload
  ): Promise<MemoryFabricResult<MemorySearchDocument>>;
}

export interface MemorySignalPort {
  mineSignals(
    input: MemoryRelaySignalsPayload
  ): Promise<MemoryFabricResult<MemorySignalDocument>>;
}

export interface MemoryCorrelationPort {
  correlateMemories(
    input: MemoryRelayCorrelationPayload
  ): Promise<MemoryFabricResult<MemoryCorrelationGraphDocument>>;
}

export interface MemoryCapturePort {
  captureArtifact(
    input: MemoryRelayCaptureArtifactPayload
  ): Promise<MemoryFabricResult<MemoryCaptureReceiptDocument>>;

  captureRun(
    input: MemoryRelayCaptureRunPayload
  ): Promise<MemoryFabricResult<MemoryCaptureReceiptDocument>>;
}

export interface MemoryFabricWorkflowNodeAdapterConfig {
  readonly artifacts: ArtifactStoreContract;
  readonly memoryCapture?: MemoryCapturePort;
  readonly memoryCorrelation?: MemoryCorrelationPort;
  readonly memoryRetrieval?: MemoryRetrievalPort;
  readonly memorySignals?: MemorySignalPort;
}

type BlockedWorkflowNodeExecutionResult = Extract<
  WorkflowNodeExecutionResult,
  { readonly status: "blocked" }
>;
type MemoryWorkflowNodeExecutionInput = Parameters<
  WorkflowNodeAdapterPort["execute"]
>[0];

const CAPTURABLE_ARTIFACT_MEDIA_TYPES = [
  "application/json",
  "text/html",
  "text/markdown",
  "text/mdsvx",
  "text/plain",
  "text/typescript",
] as const;

const MemoryCapturableArtifactMediaTypeSchema = z.enum(
  CAPTURABLE_ARTIFACT_MEDIA_TYPES,
  {
    error:
      "Memory capture artifact mediaType must be application/json or a supported text media type.",
  }
);

const MemoryCaptureRunNodeConfigSchema = z.object({
  capturedRef: ArtifactPinSchema.optional(),
  readability: z
    .enum(["actor-private", "org-private", "public"])
    .default("actor-private"),
  sourceFamilies: z.array(MemorySourceFamilySchema).min(1).optional(),
  sourceSystem: z.string().min(1).default("cloudflare-workflow-run"),
  targetRunId: z.string().min(1).optional(),
});

const MemoryCaptureArtifactNodeConfigSchema = z.object({
  artifactRef: ArtifactRefSchema.optional(),
  artifactStepId: z.string().min(1).optional(),
  mediaType:
    MemoryCapturableArtifactMediaTypeSchema.default("application/json"),
  readability: z
    .enum(["actor-private", "org-private", "public"])
    .default("actor-private"),
  sourceFamilies: z.array(MemorySourceFamilySchema).min(1).optional(),
  sourceSystem: z.string().min(1).default("cloudflare-artifacts"),
});

// The planner is a stochastic LLM lane. Give the two query-bearing node configs
// a structural floor so a plan that omits `query` or emits an out-of-enum
// `signalKinds` value (e.g. "workflow" for "workflow-pattern") conforms instead
// of blocking the run. The prompt also enumerates this contract; the schema is
// the guarantee, the prompt is the nudge.
const MEMORY_FABRIC_FALLBACK_QUERY = "dream workflow";

const filterToValidSignalKinds = (value: unknown): unknown => {
  if (!Array.isArray(value)) {
    return value;
  }
  const valid = value.filter(
    (kind) => MemorySignalKindSchema.safeParse(kind).success
  );
  return valid.length > 0 ? valid : undefined;
};

const MemorySearchNodeConfigSchema = z.object({
  maxHits: z.number().int().min(1).max(100).default(10),
  query: z.string().min(1).default(MEMORY_FABRIC_FALLBACK_QUERY),
  sourceFamilies: z.array(MemorySourceFamilySchema).min(1).optional(),
});

const MemorySignalsNodeConfigSchema = z.object({
  maxSignals: z.number().int().min(1).max(100).default(10),
  query: z.string().min(1).default(MEMORY_FABRIC_FALLBACK_QUERY),
  signalKinds: z.preprocess(
    filterToValidSignalKinds,
    z.array(MemorySignalKindSchema).min(1).optional()
  ),
  sourceFamilies: z.array(MemorySourceFamilySchema).min(1).optional(),
});

const MemoryHydrationNodeConfigSchema = z.object({
  maxReceipts: z.number().int().min(1).max(100).default(10),
  searchRef: ArtifactRefSchema.optional(),
  searchStepId: z.string().min(1).optional(),
});

const MemoryCorrelationNodeConfigSchema = z.object({
  hydrationRef: ArtifactRefSchema.optional(),
  hydrationStepId: z.string().min(1).optional(),
  searchRef: ArtifactRefSchema.optional(),
  searchStepId: z.string().min(1).optional(),
});

const MemoryRefinementProposalNodeConfigSchema = z.object({
  correlationRef: ArtifactRefSchema.optional(),
  correlationStepId: z.string().min(1).optional(),
  hydrationRef: ArtifactRefSchema.optional(),
  hydrationStepId: z.string().min(1).optional(),
  maxProposals: z.number().int().min(1).max(20).default(8),
  searchRef: ArtifactRefSchema.optional(),
  searchStepId: z.string().min(1).optional(),
  signalsRef: ArtifactRefSchema.optional(),
  signalsStepId: z.string().min(1).optional(),
});

const WorkflowHitlReportNodeConfigSchema = z.object({
  correlationRef: ArtifactRefSchema.optional(),
  correlationStepId: z.string().min(1).optional(),
  dynamicGenerationProofLevel:
    WorkflowHitlReportProofLevelSchema.default("plan-derived"),
  hydrationRef: ArtifactRefSchema.optional(),
  hydrationStepId: z.string().min(1).optional(),
  refinementProposalRef: ArtifactRefSchema.optional(),
  refinementProposalStepId: z.string().min(1).optional(),
  searchRef: ArtifactRefSchema.optional(),
  searchStepId: z.string().min(1).optional(),
  title: z.string().min(1).default("HITL review"),
});

const MemoryHitlDecisionWorkflowSeedNodeConfigSchema = z.object({
  decisionRef: ArtifactRefSchema.optional(),
  decisionStepId: z.string().min(1).optional(),
});

const MemoryHitlFollowUpRunRequestNodeConfigSchema = z.object({
  requestedPackageIds: z
    .array(z.string().min(1))
    .default([
      "badass-courses/claw-kernel",
      "joelhooks/configured-familiar-kernel",
      "workflow/memory-fabric",
    ]),
  runId: z.string().min(1).optional(),
  seedRef: ArtifactRefSchema.optional(),
  seedStepId: z.string().min(1).optional(),
  workItemId: z.string().min(1).optional(),
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
  `memory/relay-lease-receipts/${step.stepId}.json`;

const writeDocument = async (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly document:
    | MemoryCaptureReceiptDocument
    | MemoryCorrelationGraphDocument
    | MemoryHitlFollowUpRunRequestDocument
    | MemoryHitlDecisionWorkflowSeedDocument
    | WorkflowHitlReportDocument
    | MemoryHydrationDocument
    | MemorySearchDocument
    | MemoryRefinementProposalDocument
    | MemorySignalDocument;
  readonly relayLeaseReceipt?: MemoryRelayLeaseReceipt | undefined;
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
    value: MemoryRelayLeaseReceiptSchema.parse(input.relayLeaseReceipt),
  });

  return {
    outputRefs: [write.artifactRef, relayLeaseWrite.artifactRef],
    status: "executed",
  };
};

const writeHitlReportDocument = async (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly document: WorkflowHitlReportDocument;
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

const loadSearch = async (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly artifactRef: ArtifactRef;
}): Promise<
  | {
      readonly document: MemorySearchDocument;
      readonly status: "loaded";
    }
  | BlockedWorkflowNodeExecutionResult
> => {
  try {
    return {
      document: MemorySearchDocumentSchema.parse(
        await input.artifacts.readJson({ artifactRef: input.artifactRef })
      ),
      status: "loaded",
    };
  } catch {
    return blocker(
      "stale_package",
      "Memory search artifact could not be loaded by the memory-fabric node."
    );
  }
};

const loadHydration = async (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly artifactRef: ArtifactRef;
}): Promise<
  | {
      readonly document: MemoryHydrationDocument;
      readonly status: "loaded";
    }
  | BlockedWorkflowNodeExecutionResult
> => {
  try {
    return {
      document: MemoryHydrationDocumentSchema.parse(
        await input.artifacts.readJson({ artifactRef: input.artifactRef })
      ),
      status: "loaded",
    };
  } catch {
    return blocker(
      "stale_package",
      "Memory hydration artifact could not be loaded by the memory-fabric node."
    );
  }
};

const loadSignals = async (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly artifactRef: ArtifactRef;
}): Promise<
  | {
      readonly document: MemorySignalDocument;
      readonly status: "loaded";
    }
  | BlockedWorkflowNodeExecutionResult
> => {
  try {
    return {
      document: MemorySignalDocumentSchema.parse(
        await input.artifacts.readJson({ artifactRef: input.artifactRef })
      ),
      status: "loaded",
    };
  } catch {
    return blocker(
      "stale_package",
      "Memory signals artifact could not be loaded by the memory-fabric node."
    );
  }
};

const loadCorrelation = async (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly artifactRef: ArtifactRef;
}): Promise<
  | {
      readonly document: MemoryCorrelationGraphDocument;
      readonly status: "loaded";
    }
  | BlockedWorkflowNodeExecutionResult
> => {
  try {
    return {
      document: MemoryCorrelationGraphDocumentSchema.parse(
        await input.artifacts.readJson({ artifactRef: input.artifactRef })
      ),
      status: "loaded",
    };
  } catch {
    return blocker(
      "stale_package",
      "Memory correlation graph artifact could not be loaded by the memory-fabric node."
    );
  }
};

const loadRefinementProposals = async (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly artifactRef: ArtifactRef;
}): Promise<
  | {
      readonly document: MemoryRefinementProposalDocument;
      readonly status: "loaded";
    }
  | BlockedWorkflowNodeExecutionResult
> => {
  try {
    return {
      document: MemoryRefinementProposalDocumentSchema.parse(
        await input.artifacts.readJson({ artifactRef: input.artifactRef })
      ),
      status: "loaded",
    };
  } catch {
    return blocker(
      "stale_package",
      "Memory refinement proposal artifact could not be loaded by the memory-fabric node."
    );
  }
};

const loadHitlDecision = async (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly artifactRef: ArtifactRef;
}): Promise<
  | {
      readonly document: MemoryHitlDecisionDocument;
      readonly status: "loaded";
    }
  | BlockedWorkflowNodeExecutionResult
> => {
  try {
    return {
      document: MemoryHitlDecisionDocumentSchema.parse(
        await input.artifacts.readJson({ artifactRef: input.artifactRef })
      ),
      status: "loaded",
    };
  } catch {
    return blocker(
      "stale_package",
      "Memory HITL decision artifact could not be loaded by the memory-fabric node."
    );
  }
};

const loadHitlDecisionWorkflowSeed = async (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly artifactRef: ArtifactRef;
}): Promise<
  | {
      readonly document: MemoryHitlDecisionWorkflowSeedDocument;
      readonly status: "loaded";
    }
  | BlockedWorkflowNodeExecutionResult
> => {
  try {
    return {
      document: MemoryHitlDecisionWorkflowSeedDocumentSchema.parse(
        await input.artifacts.readJson({ artifactRef: input.artifactRef })
      ),
      status: "loaded",
    };
  } catch {
    return blocker(
      "stale_package",
      "Memory HITL decision workflow seed artifact could not be loaded by the memory-fabric node."
    );
  }
};

const captureArtifactRefFor = (input: {
  readonly config: z.infer<typeof MemoryCaptureArtifactNodeConfigSchema>;
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
      "Memory capture artifact node requires a readable generated artifact ref."
    );
  }
};

const searchRefFor = (input: {
  readonly config: z.infer<typeof MemoryHydrationNodeConfigSchema>;
  readonly dependencyArtifactRefs: Readonly<Record<string, ArtifactRef>>;
}): ArtifactRef | null =>
  input.config.searchRef ??
  dependencyRefFor({
    dependencyArtifactRefs: input.dependencyArtifactRefs,
    stepId: input.config.searchStepId,
  });

const correlationRefsFor = (input: {
  readonly config: z.infer<typeof MemoryCorrelationNodeConfigSchema>;
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
  readonly config: z.infer<typeof MemoryRefinementProposalNodeConfigSchema>;
  readonly dependencyArtifactRefs: Readonly<Record<string, ArtifactRef>>;
}): {
  readonly correlationRef: ArtifactRef | null;
  readonly hydrationRef: ArtifactRef | null;
  readonly searchRef: ArtifactRef | null;
  readonly signalsRef: ArtifactRef | null;
} => ({
  correlationRef:
    input.config.correlationRef ??
    dependencyRefFor({
      dependencyArtifactRefs: input.dependencyArtifactRefs,
      stepId: input.config.correlationStepId,
    }),
  hydrationRef:
    input.config.hydrationRef ??
    dependencyRefFor({
      dependencyArtifactRefs: input.dependencyArtifactRefs,
      stepId: input.config.hydrationStepId,
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
  readonly config: z.infer<typeof WorkflowHitlReportNodeConfigSchema>;
  readonly dependencyArtifactRefs: Readonly<Record<string, ArtifactRef>>;
}): {
  readonly correlationRef: ArtifactRef | null;
  readonly hydrationRef: ArtifactRef | null;
  readonly refinementProposalRef: ArtifactRef | null;
  readonly searchRef: ArtifactRef | null;
} => ({
  correlationRef:
    input.config.correlationRef ??
    dependencyRefFor({
      dependencyArtifactRefs: input.dependencyArtifactRefs,
      stepId: input.config.correlationStepId,
    }),
  hydrationRef:
    input.config.hydrationRef ??
    dependencyRefFor({
      dependencyArtifactRefs: input.dependencyArtifactRefs,
      stepId: input.config.hydrationStepId,
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
    typeof MemoryHitlDecisionWorkflowSeedNodeConfigSchema
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

const hitlDecisionWorkflowSeedRefFor = (input: {
  readonly config: z.infer<typeof MemoryHitlFollowUpRunRequestNodeConfigSchema>;
  readonly dependencyArtifactRefs: Readonly<Record<string, ArtifactRef>>;
  readonly inputRefs: readonly ArtifactRef[];
}): ArtifactRef | null =>
  input.config.seedRef ??
  dependencyRefFor({
    dependencyArtifactRefs: input.dependencyArtifactRefs,
    stepId: input.config.seedStepId,
  }) ??
  input.inputRefs.at(0) ??
  null;

interface RequiredReportRefs {
  readonly correlationRef: ArtifactRef;
  readonly hydrationRef: ArtifactRef;
  readonly searchRef: ArtifactRef;
}

interface LoadedReportInputs {
  readonly correlation: MemoryCorrelationGraphDocument;
  readonly hydration: MemoryHydrationDocument;
  readonly search: MemorySearchDocument;
}

const requiredReportRefsFor = (
  refs: ReturnType<typeof reportRefsFor>
): RequiredReportRefs | BlockedWorkflowNodeExecutionResult => {
  if (
    refs.correlationRef === null ||
    refs.hydrationRef === null ||
    refs.searchRef === null
  ) {
    return blocker(
      "stale_package",
      "Memory HITL report node requires search, hydration, and correlation artifact refs."
    );
  }

  return {
    correlationRef: refs.correlationRef,
    hydrationRef: refs.hydrationRef,
    searchRef: refs.searchRef,
  };
};

const loadRequiredReportInputs = async (
  artifacts: ArtifactStoreContract,
  refs: RequiredReportRefs
): Promise<LoadedReportInputs | BlockedWorkflowNodeExecutionResult> => {
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
    correlation: correlation.document,
    hydration: hydration.document,
    search: search.document,
  };
};

const loadOptionalRefinementProposalDocument = async (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly refinementProposalRef: ArtifactRef | null;
}): Promise<
  | {
      readonly document: MemoryRefinementProposalDocument | null;
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

const receiptKey = (receipt: MemoryReceiptRef): string =>
  `${receipt.sourceId}:${receipt.receiptId}:${receipt.hash ?? ""}`;

const hydrationReceiptsFor = (input: {
  readonly maxReceipts: number;
  readonly search: MemorySearchDocument;
}): MemoryReceiptRef[] => {
  const receipts: MemoryReceiptRef[] = [];
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

const memoryFamilyLabels: Record<MemorySourceFamily, string> = {
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

const mdsvxAttributeString = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

const reportStateMachineFigureFor = (input: {
  readonly machine: DynamicWorkflowMachineDocument;
  readonly machineArtifact: DynamicWorkflowPlanDocument["machine"];
}): WorkflowHitlReportDocument["proof"]["stateMachineFigure"] => {
  if (input.machine.machineId !== input.machineArtifact.machineId) {
    throw new Error(
      `Generated report machine id mismatch: ${input.machine.machineId} != ${input.machineArtifact.machineId}.`
    );
  }

  const stateEntries = Object.entries(input.machine.xstate.states);
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
  const source = [
    "direction: down",
    ...nodeLines,
    ...edgeLines,
    `initial: ${d2Label(input.machine.xstate.initial)}`,
    `machine: ${d2Label(input.machine.machineId)}`,
  ].join("\n");

  return {
    aspectRatio,
    component: "D2",
    machineBinding: {
      machineArtifactHash: input.machineArtifact.hash,
      machineArtifactRef: input.machineArtifact.artifactRef,
      machineId: input.machineArtifact.machineId,
      machineSourceArtifactRef: input.machineArtifact.sourceArtifactRef,
      machineSourceHash: input.machineArtifact.sourceHash,
      status: "bound-to-generated-machine",
    },
    machineId: input.machine.machineId,
    source,
    sourceHash: sha256Hex(source),
    sourceKind: "generated-xstate-machine",
    stateCount: stateEntries.length,
    transitionCount: transitions.length,
  };
};

const frontMatterString = (value: string): string => JSON.stringify(value);

const receiptLineFor = (receipt: MemoryReceiptRef): string =>
  `- ${receipt.family} / ${receipt.sourceId} / ${receipt.receiptId}`;

const ratingForHit = (hit: MemorySearchHit): number =>
  Math.min(10, Math.max(1, Math.round(hit.score * 10)));

const reportCardForHit = (input: {
  readonly hydratedReceiptKeys: ReadonlySet<string>;
  readonly hit: MemorySearchHit;
  readonly index: number;
}): WorkflowHitlReportCard => {
  const receipt = input.hit.receipts.at(0);
  const familyLabel =
    receipt === undefined
      ? "memory fabric"
      : memoryFamilyLabels[receipt.family];
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
      "Review the receipts, decide whether this updates .brain, and turn any capture gap into a recovery task instead of normal workflow behavior.",
    summary: input.hit.summary,
    title: `Finding ${input.index + 1}: ${familyLabel} needs human review`,
  };
};

const reportCardsFor = (input: {
  readonly hydration: MemoryHydrationDocument;
  readonly search: MemorySearchDocument;
}): WorkflowHitlReportCard[] => {
  const hydratedReceiptKeys = new Set(
    input.hydration.hydrated.map((hydrated) => receiptKey(hydrated.receipt))
  );

  return input.search.hits.map((hit, index) =>
    reportCardForHit({
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

  return slug.length === 0 ? "memory" : slug;
};

const targetKindForHit = (
  hit: MemorySearchHit
): MemoryRefinementProposalTargetKind => {
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
  targetKind: MemoryRefinementProposalTargetKind
): string => {
  if (targetKind === "capability-lease") {
    return "Review the capability boundary and decide whether the next generated workflow needs a new leased port.";
  }

  if (targetKind === "capture-ingest-fix") {
    return "Turn this into a capture or ingest repair task for the separate memory-fabric repair workflow.";
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
  readonly targetKind: MemoryRefinementProposalTargetKind;
}): MemoryRefinementProposalRecommendation => {
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
  readonly hit: MemorySearchHit;
  readonly hydratedReceiptKeys: ReadonlySet<string>;
  readonly index: number;
  readonly sourceRefs: readonly ArtifactRef[];
}): MemoryRefinementProposal => {
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

const targetKindForSignal = (
  signal: MemorySignalDocument["signals"][number]
): MemoryRefinementProposalTargetKind => {
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
  readonly signal: MemorySignalDocument["signals"][number];
  readonly sourceRefs: readonly ArtifactRef[];
}): MemoryRefinementProposal => {
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
  readonly correlation: MemoryCorrelationGraphDocument;
  readonly correlationRef: ArtifactRef;
  readonly hydration: MemoryHydrationDocument;
  readonly hydrationRef: ArtifactRef;
  readonly maxProposals: number;
  readonly search: MemorySearchDocument;
  readonly searchRef: ArtifactRef;
  readonly signals: MemorySignalDocument;
  readonly signalsRef: ArtifactRef;
}): MemoryRefinementProposalDocument => {
  const sourceRefs = [
    input.signalsRef,
    input.searchRef,
    input.hydrationRef,
    input.correlationRef,
  ];
  const hydratedReceiptKeys = new Set(
    input.hydration.hydrated.map((hydrated) => receiptKey(hydrated.receipt))
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
  const proposals = [...signalProposals, ...hitProposals]
    .toSorted((left, right) => right.rating - left.rating)
    .slice(0, input.maxProposals);

  return MemoryRefinementProposalDocumentSchema.parse({
    generatedAt: new Date().toISOString(),
    nextWorkflowSeed: {
      plannerInstructions: [
        "Use accepted refinement proposals as constraints for the next generated workflow.",
        "Do not treat proposal text as proof; follow sourceRefs and receipts before updating Brain or packages.",
        "Route capture or ingest gaps to the separate memory-fabric repair workflow instead of folding them into this workflow.",
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
    schemaVersion: "memory.refinement-proposals.v1",
    sourceRefs,
    workItemId: input.search.workItemId,
  });
};

const actionableHitlDecisionsFor = (
  document: MemoryHitlDecisionDocument
): MemoryHitlDecisionDocument["decisions"] =>
  document.decisions.filter(
    (decision) =>
      decision.decision === "accept" || decision.decision === "turn-into-work"
  );

const uniqueArtifactRefs = (refs: readonly ArtifactRef[]): ArtifactRef[] => [
  ...new Set(refs),
];

const uniqueStrings = (values: readonly string[]): string[] => [
  ...new Set(values),
];

const hitlDecisionWorkflowSeedDocumentFor = (input: {
  readonly decision: MemoryHitlDecisionDocument;
  readonly decisionRef: ArtifactRef;
}): MemoryHitlDecisionWorkflowSeedDocument => {
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
      : "HITL review did not accept or turn any decision into work; the next generated workflow seed is intentionally empty.";

  return MemoryHitlDecisionWorkflowSeedDocumentSchema.parse({
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
    schemaVersion: "memory.hitl-decision-workflow-seed.v1",
    sourceRefs,
    status,
    summary,
    workItemDecisionIds,
    workItemId: input.decision.workItemId,
  });
};

const followUpRunRequestIntentFor = (
  seed: MemoryHitlDecisionWorkflowSeedDocument
): string =>
  `Run the next generated workflow from accepted HITL decisions for ${seed.workItemId}. Convert the accepted/work-conversion decisions into reviewable Brain/package/workflow/schema/report/capability artifact updates, preserving source receipts and capability requirements.`;

const followUpRunRequestNotesFor = (input: {
  readonly seed: MemoryHitlDecisionWorkflowSeedDocument;
  readonly seedRef: ArtifactRef;
}): string[] => {
  const artifactTargets = input.seed.nextWorkflowSeed.artifactUpdateTargets.map(
    (target) =>
      `Artifact update target ${target.targetKind}: ${target.summary}; sourceRefs ${target.sourceRefs.join(", ")}.`
  );
  const capabilityKinds =
    input.seed.nextWorkflowSeed.requiredCapabilityKinds.length === 0
      ? ["No extra capability kinds were declared by the HITL seed."]
      : [
          `Required capability kinds before side effects: ${input.seed.nextWorkflowSeed.requiredCapabilityKinds.join(", ")}.`,
        ];

  return [
    `Consume HITL decision workflow seed ${input.seedRef}.`,
    `Actionable decision ids: ${input.seed.nextWorkflowSeed.decisionIds.join(", ")}.`,
    ...input.seed.nextWorkflowSeed.plannerInstructions,
    ...capabilityKinds,
    ...artifactTargets,
    `Source refs for verification: ${input.seed.sourceRefs.join(", ")}.`,
    "Generate a fresh workflow.xstate-machine.v1 config, generated TypeScript source, generated harness source, and verifier proof for this follow-up work.",
    "Do not mutate Brain, packages, schemas, reports, source indexes, or capability policies unless the generated workflow has explicit leased side-effect receipts and review gates.",
    "Prefer reviewable artifact or GitHub PR delivery for repo-backed artifact updates; keep unleased updates as artifacts for human review.",
  ];
};

const hitlFollowUpRunRequestDocumentFor = (input: {
  readonly actor: MemoryWorkflowNodeExecutionInput["actor"];
  readonly config: z.infer<typeof MemoryHitlFollowUpRunRequestNodeConfigSchema>;
  readonly seed: MemoryHitlDecisionWorkflowSeedDocument;
  readonly seedRef: ArtifactRef;
}): MemoryHitlFollowUpRunRequestDocument => {
  const status =
    input.seed.status === "ready" && input.seed.actionableDecisionCount > 0
      ? "drafted"
      : ("no-actionable-decisions" as const);
  const requestedPackageIds = uniqueStrings(input.config.requestedPackageIds);
  const followUpRunId =
    input.config.runId ??
    `run-memory-hitl-follow-up-${proposalSlugFor(input.seed.runId)}`;
  const followUpWorkItemId =
    input.config.workItemId ??
    `work-item:memory-hitl-follow-up:${proposalSlugFor(input.seed.workItemId)}`;
  const request =
    status === "drafted"
      ? {
          actor: input.actor,
          planProposal: {
            intent: followUpRunRequestIntentFor(input.seed),
            requestedPackageIds,
            stochasticNotes: followUpRunRequestNotesFor({
              seed: input.seed,
              seedRef: input.seedRef,
            }),
          },
          runId: followUpRunId,
          workItemId: followUpWorkItemId,
        }
      : undefined;
  const summary =
    status === "drafted"
      ? `Drafted follow-up workflow request ${followUpRunId} from ${input.seed.actionableDecisionCount} actionable HITL decision(s).`
      : "No follow-up workflow request was drafted because the HITL decision seed had no actionable decisions.";

  return MemoryHitlFollowUpRunRequestDocumentSchema.parse({
    actionableDecisionCount: input.seed.actionableDecisionCount,
    artifactUpdateTargets: input.seed.nextWorkflowSeed.artifactUpdateTargets,
    decisionWorkflowSeedRef: input.seedRef,
    generatedAt: new Date().toISOString(),
    redacted: true,
    ...(request === undefined ? {} : { request }),
    requestedPackageIds,
    requiredCapabilityKinds:
      input.seed.nextWorkflowSeed.requiredCapabilityKinds,
    runId: input.seed.runId,
    schemaVersion: "memory.hitl-follow-up-run-request.v1",
    sourceRefs: uniqueArtifactRefs([input.seedRef, ...input.seed.sourceRefs]),
    status,
    submitted: false,
    summary,
    workItemId: input.seed.workItemId,
  });
};

const reportCardMdsvxFor = (finding: WorkflowHitlReportCard): string =>
  [
    `### ${finding.title}`,
    finding.summary,
    `**Reasoning.** ${finding.reasoning}`,
    `**Rating.** ${finding.rating}/10`,
    `**Recommendation.** ${finding.recommendation}`,
    "**Receipts.**",
    finding.receipts.map(receiptLineFor).join("\n"),
  ].join("\n\n");

const reportActionLineFor = (finding: WorkflowHitlReportCard): string =>
  `- **${finding.title}** Rating ${finding.rating}/10. ${finding.recommendation}`;

const refinementProposalActionLineFor = (
  proposal: MemoryRefinementProposal
): string =>
  `- **${proposal.title}** ${proposal.rating}/10. ${proposal.recommendation}: ${proposal.proposedNextStep}`;

const hitlDecisionContractFor = (
  sourceRefs: readonly ArtifactRef[]
): MemoryHitlDecisionContract =>
  MemoryHitlDecisionContractSchema.parse({
    artifactPath: "report/hitl-decision.json",
    contractRef: "contract://workflow/memory-fabric/hitl-decision.v1",
    decisionSchemaVersion: "memory.hitl-decision.v1",
    exportId: "memory-hitl-decision-schema",
    nextWorkflowSeedRequiredFor: ["accept", "turn-into-work"],
    sourceRefs,
    targetKinds: ["finding-card", "refinement-proposal"],
  });

type WorkflowHitlReportDefinitionOfDoneAuditItemInput = Omit<
  WorkflowHitlReportDefinitionOfDoneAuditItem,
  "blockerRefs" | "evidenceRefs"
> & {
  readonly blockerRefs?: readonly string[];
  readonly evidenceRefs?: readonly string[];
};

const reportAuditItem = (
  item: WorkflowHitlReportDefinitionOfDoneAuditItemInput
): WorkflowHitlReportDefinitionOfDoneAuditItem => ({
  blockerRefs: [...(item.blockerRefs ?? [])],
  evidenceRefs: [...(item.evidenceRefs ?? [])],
  requirement: item.requirement,
  requirementId: item.requirementId,
  status: item.status,
  summary: item.summary,
});

const reportAuditStatusFor = (
  items: readonly WorkflowHitlReportDefinitionOfDoneAuditItem[]
): WorkflowHitlReportDefinitionOfDoneAudit["status"] => {
  if (
    items.some((item) => item.status === "blocked" || item.status === "missing")
  ) {
    return "blocked";
  }

  return items.some((item) => item.status === "not-proven")
    ? "not-proven"
    : "captured";
};

const reportDefinitionOfDoneAuditFor = (input: {
  readonly correlation: MemoryCorrelationGraphDocument;
  readonly findingCount: number;
  readonly generatedAt: string;
  readonly hydration: MemoryHydrationDocument;
  readonly plan: DynamicWorkflowPlanDocument;
  readonly proofLevel: WorkflowHitlReportProofLevel;
  readonly refinementProposalCount: number;
  readonly runId: string;
  readonly search: MemorySearchDocument;
  readonly sourceRefs: readonly ArtifactRef[];
  readonly stateMachineFigure: WorkflowHitlReportDocument["proof"]["stateMachineFigure"];
}): WorkflowHitlReportDefinitionOfDoneAudit => {
  const generatedArtifactRefs = [
    input.plan.machine.artifactRef,
    input.plan.machine.sourceArtifactRef,
    input.plan.harness.artifactRef,
    input.plan.verificationContract.artifactRef,
  ];
  const tShapedCoverageCaptured =
    input.search.hits.length > 0 &&
    input.hydration.hydrated.length > 0 &&
    input.correlation.edges.length > 0;
  const unsafeHydrationCount = input.hydration.hydrated.filter(
    (hydrated) => hydrated.fullTranscriptReturned
  ).length;
  const findingsAndRefinementsCaptured =
    input.findingCount > 0 && input.refinementProposalCount > 0;
  const tShapedGapSummary = input.search.skippedSources.map(
    (skippedSource) => `${skippedSource}:skipped-source`
  );

  const items = [
    reportAuditItem({
      evidenceRefs: ["node:joelclaw.memory.hitl-report", ...input.sourceRefs],
      requirement:
        "The HITL report is emitted by the installed workflow cartridge/package.",
      requirementId: "workflow-cartridge-package",
      status: "captured",
      summary:
        "`joelclaw.memory.hitl-report` produced the JSON/MDSvX report as a cartridge-owned workflow node.",
    }),
    reportAuditItem({
      evidenceRefs: input.sourceRefs,
      requirement:
        "Cloudflare leases memory search/hydration/correlation capabilities through the trusted relay.",
      requirementId: "worker-facing-relay-capability-lease",
      status: "not-proven",
      summary:
        "This report consumes run artifacts but does not prove relay lease sidecars; `memory.generated-workflow-proof.v1` must verify them.",
    }),
    reportAuditItem({
      evidenceRefs: generatedArtifactRefs,
      requirement:
        "The run is submitted to and executed by the deployed Cloudflare workflow app.",
      requirementId: "live-cloudflare-execution",
      status: "not-proven",
      summary:
        "The report is not the Cloudflare execution receipt; require `workflow.execution-proof.v1` and verifier acceptance for the surrounding run.",
    }),
    reportAuditItem({
      evidenceRefs: generatedArtifactRefs,
      requirement:
        "A real planner generates and pins workflow.xstate-machine.v1 plus generated harness/source/hash artifacts.",
      requirementId: "generated-machine-and-harness",
      status:
        input.proofLevel === "generated-machine" &&
        input.stateMachineFigure.machineBinding.status ===
          "bound-to-generated-machine"
          ? "captured"
          : "not-proven",
      summary:
        input.proofLevel === "generated-machine"
          ? `Generated machine, source, harness, and verifier contract are hash-pinned; D2 source hash ${input.stateMachineFigure.sourceHash}.`
          : `Report proof level is ${input.proofLevel}, so generated machine execution is not proven by this report.`,
    }),
    reportAuditItem({
      evidenceRefs: input.sourceRefs,
      requirement:
        "The run reads T-shaped across time horizons with hydration and correlation; coverage gaps are reported as caveats, never hidden.",
      requirementId: "t-shaped-memory-coverage",
      status: tShapedCoverageCaptured ? "captured" : "not-proven",
      summary: tShapedCoverageCaptured
        ? `Retrieval produced ${input.search.hits.length} search hit(s), ${input.hydration.hydrated.length} hydrated receipt(s), and ${input.correlation.edges.length} correlation edge(s).`
        : `Coverage gaps are explicit, not hidden: ${tShapedGapSummary.join(", ") || "missing search, hydration, or correlation evidence"}.`,
    }),
    reportAuditItem({
      evidenceRefs: input.sourceRefs,
      requirement:
        "The run emits actionable findings and refinement proposals for kernel/package/workflow/schema/access/report changes.",
      requirementId: "findings-and-refinement-proposals",
      status: findingsAndRefinementsCaptured ? "captured" : "not-proven",
      summary: findingsAndRefinementsCaptured
        ? `Report contains ${input.findingCount} finding card(s) and ${input.refinementProposalCount} refinement proposal(s).`
        : `Report contains ${input.findingCount} finding card(s) and ${input.refinementProposalCount} refinement proposal(s); this is diagnostic, not a complete refinement loop.`,
    }),
    reportAuditItem({
      evidenceRefs: input.sourceRefs,
      requirement:
        "Accepted findings produce HITL decision, workflow seed, and follow-up run request artifacts that feed the next generated workflow.",
      requirementId: "hitl-refinement-loop",
      status: "not-proven",
      summary:
        "The report emits the HITL decision contract; decision seed and follow-up run request artifacts are post-report workflow nodes.",
    }),
    reportAuditItem({
      evidenceRefs: input.sourceRefs,
      requirement:
        "The Cloudflare workflow publishes the canonical Tufte/MDSvX Wzrrd HITL report through a leased side effect.",
      requirementId: "workflow-owned-wzrrd-output",
      status: "not-proven",
      summary:
        "The report node renders MDSvX only; leased `wzrrd.site.publish` delivery is a separate post-verifier side effect.",
    }),
    reportAuditItem({
      evidenceRefs: input.sourceRefs,
      requirement:
        "Public artifacts remain redacted: no raw credentials, raw private paths, or raw transcripts.",
      requirementId: "public-private-redaction-boundary",
      status: unsafeHydrationCount === 0 ? "captured" : "blocked",
      summary:
        unsafeHydrationCount === 0
          ? "Report and hydration artifacts assert redacted evidence only; raw transcripts were not returned."
          : `${unsafeHydrationCount} hydration item(s) returned full transcripts and must not be published.`,
    }),
  ];
  const summary = {
    blockedCount: items.filter((item) => item.status === "blocked").length,
    capturedCount: items.filter((item) => item.status === "captured").length,
    missingCount: items.filter((item) => item.status === "missing").length,
    notProvenCount: items.filter((item) => item.status === "not-proven").length,
    totalCount: items.length,
  };

  return WorkflowHitlReportDefinitionOfDoneAuditSchema.parse({
    generatedAt: input.generatedAt,
    items,
    redacted: true,
    runId: input.runId,
    schemaVersion: "workflow.hitl-report.definition-of-done-audit.v1",
    status: reportAuditStatusFor(items),
    summary,
  });
};

const reportDefinitionOfDoneAuditMdsvxFor = (
  audit: WorkflowHitlReportDefinitionOfDoneAudit
): string =>
  [
    `Audit status: ${audit.status}. Captured ${audit.summary.capturedCount}/${audit.summary.totalCount}; blocked ${audit.summary.blockedCount}; missing ${audit.summary.missingCount}; not proven ${audit.summary.notProvenCount}.`,
    "",
    ...audit.items.map(
      (item) => `- ${item.requirementId}: ${item.status} -- ${item.summary}`
    ),
  ].join("\n");

const reportMdsvxFor = (input: {
  readonly correlation: MemoryCorrelationGraphDocument;
  readonly definitionOfDoneAudit: WorkflowHitlReportDefinitionOfDoneAudit;
  readonly hitlDecisionContract: MemoryHitlDecisionContract;
  readonly findingCount: number;
  readonly findings: readonly WorkflowHitlReportCard[];
  readonly hydration: MemoryHydrationDocument;
  readonly plan: DynamicWorkflowPlanDocument;
  readonly proofLevel: WorkflowHitlReportProofLevel;
  readonly receiptCount: number;
  readonly refinementProposals: readonly MemoryRefinementProposal[];
  readonly search: MemorySearchDocument;
  readonly stateMachineFigure: WorkflowHitlReportDocument["proof"]["stateMachineFigure"];
  readonly title: string;
}): string => {
  const findingSection =
    input.findings.length === 0
      ? "No findings cleared the receipt threshold in this run."
      : input.findings.map(reportCardMdsvxFor).join("\n\n");
  let actionSection = "- Treat this run as a retrieval/capture diagnostic.";
  if (input.refinementProposals.length > 0) {
    actionSection = input.refinementProposals
      .map(refinementProposalActionLineFor)
      .join("\n");
  } else if (input.findings.length > 0) {
    actionSection = input.findings.map(reportActionLineFor).join("\n");
  }
  const skippedSourceSummary =
    input.search.skippedSources.length === 0
      ? "No sources were skipped by memory search."
      : `Skipped sources reported as caveats: ${input.search.skippedSources.join(", ")}.`;

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
    "This is a human review surface, not an autopatcher. The report puts findings first, then proof, so the human can decide what to accept, hold, reject, or turn into work.",
    "",
    "## Run context",
    "",
    `Run ${input.search.runId} searched ${input.search.hits.length} memory hits, hydrated ${input.hydration.hydrated.length} redacted receipts, and produced ${input.findingCount} findings for human review.`,
    "",
    `Findings: ${input.findingCount}. Unique receipts: ${input.receiptCount}. Expiry: 24h, noindex.`,
    "",
    "## The actual findings",
    "",
    findingSection,
    "",
    "## What to do with these findings",
    "",
    "Use this as HITL input, not autopilot. Accept a finding only when the receipt trail is good enough to update .brain, create a capture fix, or refine a workflow/package decision.",
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
    "`joelclaw.memory.hitl-report` rendered this artifact as an installed workflow cartridge node. The JSON document is the machine contract; this sibling `text/mdsvx` artifact is the publishable HITL source.",
    "",
    "## Workflow state machine",
    "",
    "The D2 figure below is rendered from the pinned generated `workflow.xstate-machine.v1` config for this run, not from a static node list. It belongs below the findings so proof does not bury the human decision.",
    "",
    `<D2Fig aspectRatio="${mdsvxAttributeString(input.stateMachineFigure.aspectRatio)}" machineId="${mdsvxAttributeString(input.stateMachineFigure.machineId)}" sourceKind="${mdsvxAttributeString(input.stateMachineFigure.sourceKind)}" stateCount={${input.stateMachineFigure.stateCount}} title="Generated workflow state machine" transitionCount={${input.stateMachineFigure.transitionCount}}>`,
    "",
    "```d2",
    input.stateMachineFigure.source,
    "```",
    "",
    "</D2Fig>",
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
    `D2 figure source hash: ${input.stateMachineFigure.sourceHash}. Binding: ${input.stateMachineFigure.machineBinding.status} to ${input.stateMachineFigure.machineBinding.machineArtifactRef} hash ${input.stateMachineFigure.machineBinding.machineArtifactHash}.`,
    "",
    `Planner lane: ${input.plan.planner.source}, nonce ${input.plan.planner.nonce}. Plan ${input.plan.planId} has ${input.plan.steps.length} step(s).`,
    "",
    "The report records report-level generated artifact refs and hashes. Final acceptance still depends on the surrounding `workflow.execution-proof.v1`, cartridge invocation proofs, post-execution `memory.generated-workflow-proof.v1`, and verifier result.",
    "",
    "## Definition of done audit",
    "",
    reportDefinitionOfDoneAuditMdsvxFor(input.definitionOfDoneAudit),
    "",
    "## Run coverage",
    "",
    skippedSourceSummary,
    "",
    `Correlation graph: ${input.correlation.nodes.length} nodes, ${input.correlation.edges.length} source-backed edges.`,
    "",
    "## Access adapter shape",
    "",
    "Memory access goes through the trusted Memory relay contract. Cloudflare receives redacted receipt metadata, source freshness, hashes, coverage counts, and follow-up refs; raw local paths, raw transcripts, and credentials stay behind the relay.",
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
    `Correlation graph: ${input.correlation.nodes.length} nodes, ${input.correlation.edges.length} source-backed edges.`,
    "",
    `Receipt count: ${input.receiptCount}. Raw transcripts returned: no.`,
    "",
    `Correlation graph schema: ${input.correlation.schemaVersion}. Refinement proposal count: ${input.refinementProposals.length}. Template seed: joel/tufte-mdsvx@0.1.0. Publish policy: noindex and 24h expiry by default.`,
  ].join("\n");
};

const uniqueReceiptCountFor = (search: MemorySearchDocument): number =>
  new Set(
    search.hits.flatMap((hit) =>
      hit.receipts.map((receipt) => receiptKey(receipt))
    )
  ).size;

const executeMemorySearchNode = async (
  config: MemoryFabricWorkflowNodeAdapterConfig,
  input: MemoryWorkflowNodeExecutionInput
): Promise<WorkflowNodeExecutionResult> => {
  if (config.memoryRetrieval === undefined) {
    return blocker(
      "adapter_unavailable",
      "Memory search node requires a memory retrieval adapter."
    );
  }

  const nodeConfig = MemorySearchNodeConfigSchema.parse(input.step.config);
  const result = await config.memoryRetrieval.searchMemories(
    MemoryRelaySearchPayloadSchema.parse({
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
    document: MemorySearchDocumentSchema.parse(result.document),
    relayLeaseReceipt: result.relayLeaseReceipt,
    step: input.step,
  });
};

const executeSignalsNode = async (
  config: MemoryFabricWorkflowNodeAdapterConfig,
  input: MemoryWorkflowNodeExecutionInput
): Promise<WorkflowNodeExecutionResult> => {
  if (config.memorySignals === undefined) {
    return blocker(
      "adapter_unavailable",
      "Memory signals node requires a memory signal adapter."
    );
  }

  const nodeConfig = MemorySignalsNodeConfigSchema.parse(input.step.config);
  const result = await config.memorySignals.mineSignals(
    MemoryRelaySignalsPayloadSchema.parse({
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
    document: MemorySignalDocumentSchema.parse(result.document),
    relayLeaseReceipt: result.relayLeaseReceipt,
    step: input.step,
  });
};

const executeHydrationNode = async (
  config: MemoryFabricWorkflowNodeAdapterConfig,
  input: MemoryWorkflowNodeExecutionInput
): Promise<WorkflowNodeExecutionResult> => {
  if (config.memoryRetrieval === undefined) {
    return blocker(
      "adapter_unavailable",
      "Memory hydration node requires a memory retrieval adapter."
    );
  }

  const nodeConfig = MemoryHydrationNodeConfigSchema.parse(input.step.config);
  const searchRef = searchRefFor({
    config: nodeConfig,
    dependencyArtifactRefs: input.dependencyArtifactRefs,
  });
  if (searchRef === null) {
    return blocker(
      "stale_package",
      "Memory hydration node requires a memory search artifact ref."
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
      "Memory hydration node requires at least one receipt from memory search."
    );
  }

  const result = await config.memoryRetrieval.hydrateMemories(
    MemoryRelayHydrationPayloadSchema.parse({
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
    document: MemoryHydrationDocumentSchema.parse(result.document),
    relayLeaseReceipt: result.relayLeaseReceipt,
    step: input.step,
  });
};

const executeCorrelationNode = async (
  config: MemoryFabricWorkflowNodeAdapterConfig,
  input: MemoryWorkflowNodeExecutionInput
): Promise<WorkflowNodeExecutionResult> => {
  if (config.memoryCorrelation === undefined) {
    return blocker(
      "adapter_unavailable",
      "Memory correlation node requires a memory correlation adapter."
    );
  }

  const nodeConfig = MemoryCorrelationNodeConfigSchema.parse(input.step.config);
  const refs = correlationRefsFor({
    config: nodeConfig,
    dependencyArtifactRefs: input.dependencyArtifactRefs,
  });
  if (refs.searchRef === null || refs.hydrationRef === null) {
    return blocker(
      "stale_package",
      "Memory correlation node requires memory search and hydration artifact refs."
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

  const result = await config.memoryCorrelation.correlateMemories(
    MemoryRelayCorrelationPayloadSchema.parse({
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
    document: MemoryCorrelationGraphDocumentSchema.parse(result.document),
    relayLeaseReceipt: result.relayLeaseReceipt,
    step: input.step,
  });
};

const executeRefinementProposalsNode = async (
  config: MemoryFabricWorkflowNodeAdapterConfig,
  input: MemoryWorkflowNodeExecutionInput
): Promise<WorkflowNodeExecutionResult> => {
  const nodeConfig = MemoryRefinementProposalNodeConfigSchema.parse(
    input.step.config
  );
  const refs = refinementProposalRefsFor({
    config: nodeConfig,
    dependencyArtifactRefs: input.dependencyArtifactRefs,
  });
  if (
    refs.correlationRef === null ||
    refs.hydrationRef === null ||
    refs.searchRef === null ||
    refs.signalsRef === null
  ) {
    return blocker(
      "stale_package",
      "Memory refinement proposal node requires signals, search, hydration, and correlation artifact refs."
    );
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
    correlation: correlation.document,
    correlationRef: refs.correlationRef,
    hydration: hydration.document,
    hydrationRef: refs.hydrationRef,
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
  config: MemoryFabricWorkflowNodeAdapterConfig,
  input: MemoryWorkflowNodeExecutionInput
): Promise<WorkflowNodeExecutionResult> => {
  const nodeConfig = WorkflowHitlReportNodeConfigSchema.parse(
    input.step.config
  );
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

  const findings = reportCardsFor({
    hydration: reportInputs.hydration,
    search: reportInputs.search,
  });
  const receiptCount = uniqueReceiptCountFor(reportInputs.search);
  const stateMachineFigure = reportStateMachineFigureFor({
    machine: input.machine,
    machineArtifact: input.plan.machine,
  });
  const sourceRefs = [
    requiredRefs.searchRef,
    requiredRefs.hydrationRef,
    requiredRefs.correlationRef,
    ...(refs.refinementProposalRef === null
      ? []
      : [refs.refinementProposalRef]),
  ];
  const hitlDecisionContract = hitlDecisionContractFor(sourceRefs);
  const generatedAt = new Date().toISOString();
  const definitionOfDoneAudit = reportDefinitionOfDoneAuditFor({
    correlation: reportInputs.correlation,
    findingCount: findings.length,
    generatedAt,
    hydration: reportInputs.hydration,
    plan: input.plan,
    proofLevel: nodeConfig.dynamicGenerationProofLevel,
    refinementProposalCount: refinementProposals.document?.proposalCount ?? 0,
    runId: input.plan.runId,
    search: reportInputs.search,
    sourceRefs,
    stateMachineFigure,
  });
  const mdsvx = reportMdsvxFor({
    correlation: reportInputs.correlation,
    definitionOfDoneAudit,
    findingCount: findings.length,
    findings,
    hitlDecisionContract,
    hydration: reportInputs.hydration,
    plan: input.plan,
    proofLevel: nodeConfig.dynamicGenerationProofLevel,
    receiptCount,
    refinementProposals: refinementProposals.document?.proposals ?? [],
    search: reportInputs.search,
    stateMachineFigure,
    title: nodeConfig.title,
  });
  const document = WorkflowHitlReportDocumentSchema.parse({
    definitionOfDoneAudit,
    expiresIn: "24h",
    findingCount: findings.length,
    findings,
    generatedAt,
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
    schemaVersion: "workflow.hitl-report.v1",
    sectionOrder: WORKFLOW_HITL_REPORT_SECTION_ORDER,
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
  config: MemoryFabricWorkflowNodeAdapterConfig,
  input: MemoryWorkflowNodeExecutionInput
): Promise<WorkflowNodeExecutionResult> => {
  const nodeConfig = MemoryHitlDecisionWorkflowSeedNodeConfigSchema.parse(
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
      "Memory HITL decision seed node requires a memory.hitl-decision.v1 artifact ref."
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

const executeHitlFollowUpRunRequestNode = async (
  config: MemoryFabricWorkflowNodeAdapterConfig,
  input: MemoryWorkflowNodeExecutionInput
): Promise<WorkflowNodeExecutionResult> => {
  const nodeConfig = MemoryHitlFollowUpRunRequestNodeConfigSchema.parse(
    input.step.config
  );
  const seedRef = hitlDecisionWorkflowSeedRefFor({
    config: nodeConfig,
    dependencyArtifactRefs: input.dependencyArtifactRefs,
    inputRefs: input.step.inputRefs,
  });
  if (seedRef === null) {
    return blocker(
      "stale_package",
      "Memory HITL follow-up run request node requires a memory.hitl-decision-workflow-seed.v1 artifact ref."
    );
  }

  const seed = await loadHitlDecisionWorkflowSeed({
    artifactRef: seedRef,
    artifacts: config.artifacts,
  });
  if (seed.status === "blocked") {
    return seed;
  }

  return await writeDocument({
    artifacts: config.artifacts,
    document: hitlFollowUpRunRequestDocumentFor({
      actor: input.actor,
      config: nodeConfig,
      seed: seed.document,
      seedRef,
    }),
    step: input.step,
  });
};

const executeCaptureRunNode = async (
  config: MemoryFabricWorkflowNodeAdapterConfig,
  input: MemoryWorkflowNodeExecutionInput
): Promise<WorkflowNodeExecutionResult> => {
  if (config.memoryCapture === undefined) {
    return blocker(
      "adapter_unavailable",
      "Memory capture run node requires a memory capture adapter."
    );
  }

  const nodeConfig = MemoryCaptureRunNodeConfigSchema.parse(input.step.config);
  const result = await config.memoryCapture.captureRun(
    MemoryRelayCaptureRunPayloadSchema.parse({
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
    document: MemoryCaptureReceiptDocumentSchema.parse(result.document),
    relayLeaseReceipt: result.relayLeaseReceipt,
    step: input.step,
  });
};

const executeCaptureArtifactNode = async (
  config: MemoryFabricWorkflowNodeAdapterConfig,
  input: MemoryWorkflowNodeExecutionInput
): Promise<WorkflowNodeExecutionResult> => {
  if (config.memoryCapture === undefined) {
    return blocker(
      "adapter_unavailable",
      "Memory capture artifact node requires a memory capture adapter."
    );
  }

  const nodeConfig = MemoryCaptureArtifactNodeConfigSchema.parse(
    input.step.config
  );
  const artifactRef = captureArtifactRefFor({
    config: nodeConfig,
    dependencyArtifactRefs: input.dependencyArtifactRefs,
  });
  if (artifactRef === null) {
    return blocker(
      "stale_package",
      "Memory capture artifact node requires a generated artifact ref."
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

  const result = await config.memoryCapture.captureArtifact(
    MemoryRelayCaptureArtifactPayloadSchema.parse({
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
    document: MemoryCaptureReceiptDocumentSchema.parse(result.document),
    relayLeaseReceipt: result.relayLeaseReceipt,
    step: input.step,
  });
};

export const createMemoryFabricWorkflowNodeAdapter = (
  config: MemoryFabricWorkflowNodeAdapterConfig
): WorkflowNodeAdapterPort => ({
  async execute(input) {
    const { nodeType } = input.step;

    if (nodeType === "joelclaw.memory.search") {
      return await executeMemorySearchNode(config, input);
    }

    if (nodeType === "joelclaw.memory.signals") {
      return await executeSignalsNode(config, input);
    }

    if (nodeType === "joelclaw.memory.capture-run") {
      return await executeCaptureRunNode(config, input);
    }

    if (nodeType === "joelclaw.memory.capture-artifact") {
      return await executeCaptureArtifactNode(config, input);
    }

    if (nodeType === "joelclaw.memory.correlate") {
      return await executeCorrelationNode(config, input);
    }

    if (nodeType === "joelclaw.memory.refinement-proposals") {
      return await executeRefinementProposalsNode(config, input);
    }

    if (nodeType === "joelclaw.memory.hitl-decision-seed") {
      return await executeHitlDecisionWorkflowSeedNode(config, input);
    }

    if (nodeType === "joelclaw.memory.hitl-follow-up-run-request") {
      return await executeHitlFollowUpRunRequestNode(config, input);
    }

    if (nodeType === "joelclaw.memory.hitl-report") {
      return await executeHitlReportNode(config, input);
    }

    if (nodeType === "joelclaw.memory.hydrate") {
      return await executeHydrationNode(config, input);
    }

    return blocker(
      "adapter_unavailable",
      `Memory fabric workflow node adapter does not support nodeType ${input.step.nodeType}.`
    );
  },
});
