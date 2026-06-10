import { z } from "zod";

import {
  ActorSchema,
  ArtifactPinSchema,
  ArtifactRefSchema,
  DynamicWorkflowMachineArtifactSchema,
  GeneratedHarnessArtifactSchema,
  IsoDateTimeSchema,
  Sha256HexSchema,
  VerificationContractArtifactSchema,
  WorkflowRunRequestSchema,
  WorkflowTraceContextSchema,
} from "../../app/domain/schemas.ts";

export const DreamSourceFamilySchema = z.enum([
  "agent-transcripts",
  "brain",
  "cloudflare-runs",
  "comms",
  "docs-pdf-brain",
  "people-org-memory",
  "repo-outputs",
  "support",
]);

export const DreamRuntimeSchema = z.enum([
  "claude",
  "cloudflare",
  "codex",
  "pi",
]);

export const DreamCoverageHorizonSchema = z.enum([
  "24h",
  "7d",
  "30d",
  "quarter",
  "all-time",
]);

export const DreamPrivacyTierSchema = z.enum([
  "customer-private",
  "internal",
  "private",
  "public",
  "secret-adjacent",
]);

export const DreamAdapterHealthStatusSchema = z.enum([
  "healthy",
  "missing",
  "stale",
  "unavailable",
]);

export const DreamRuntimeCoverageStatusSchema = z.enum([
  "captured",
  "false-positive",
  "missing",
  "skipped",
  "stale",
]);

export const DreamSourceScopeSchema = z.object({
  machineId: z.string().min(1).optional(),
  organizationId: z.string().min(1),
  personId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
});

export const DreamMemoryRelayOperationSchema = z.enum([
  "backfill-plan",
  "backfill-run",
  "capture-artifact",
  "capture-run",
  "correlate",
  "hydrate",
  "inventory",
  "search",
  "signals",
  "source-health",
]);

export const DreamSourceSurfaceSchema = z.enum([
  "brain",
  "cloudflare-artifacts",
  "discord",
  "front",
  "github",
  "joelclaw-docs",
  "linear",
  "local-repo",
  "org-project-graph",
  "slack",
  "wzrrd",
]);

export const DreamSourcePackSelectionPolicySchema = z.enum([
  "default",
  "optional-lease",
  "separate-workflow",
]);

export const DreamSourcePackSchema = z.object({
  description: z.string().min(1),
  packId: z.string().min(1),
  packageId: z.string().min(1),
  privacyTier: DreamPrivacyTierSchema,
  requiredCapabilityKinds: z.array(z.string().min(1)).min(1),
  scope: DreamSourceScopeSchema,
  selectionPolicy: DreamSourcePackSelectionPolicySchema,
  sourceFamilies: z.array(DreamSourceFamilySchema).min(1),
  surfaces: z.array(DreamSourceSurfaceSchema).min(1),
  title: z.string().min(1),
});

export const DreamSourcePackDispositionStatusSchema = z.enum([
  "selected-by-default",
  "selected-with-lease",
  "separate-workflow-candidate",
  "skipped-missing-lease",
]);

export const DreamSourcePackDispositionSchema = z
  .object({
    capabilityKinds: z.array(z.string().min(1)).default([]),
    leaseRefs: z.array(ArtifactRefSchema).default([]),
    missingCapabilityKinds: z.array(z.string().min(1)).default([]),
    packId: z.string().min(1),
    packageId: z.string().min(1),
    reason: z.string().min(1),
    requiredCapabilityKinds: z.array(z.string().min(1)).min(1),
    selectionPolicy: DreamSourcePackSelectionPolicySchema,
    sourceFamilies: z.array(DreamSourceFamilySchema).min(1),
    status: DreamSourcePackDispositionStatusSchema,
    surfaces: z.array(DreamSourceSurfaceSchema).min(1),
  })
  .superRefine((disposition, context) => {
    if (disposition.status === "selected-with-lease") {
      if (disposition.leaseRefs.length === 0) {
        context.addIssue({
          code: "custom",
          message:
            "Selected source packs require at least one capability lease receipt ref.",
          path: ["leaseRefs"],
        });
      }

      if (disposition.missingCapabilityKinds.length > 0) {
        context.addIssue({
          code: "custom",
          message:
            "Selected source packs must not declare missing capability kinds.",
          path: ["missingCapabilityKinds"],
        });
      }
    }

    if (disposition.status === "skipped-missing-lease") {
      if (disposition.leaseRefs.length > 0) {
        context.addIssue({
          code: "custom",
          message:
            "Skipped source packs must not carry capability lease receipt refs.",
          path: ["leaseRefs"],
        });
      }

      if (disposition.missingCapabilityKinds.length === 0) {
        context.addIssue({
          code: "custom",
          message:
            "Skipped source packs must declare missing capability kinds.",
          path: ["missingCapabilityKinds"],
        });
      }
    }
  });

export const DreamWorkflowEffectSchema = z.enum([
  "backfill-plan",
  "backfill-run",
  "capture-artifact",
  "capture-run",
  "correlate",
  "hitl-decision-seed",
  "hitl-follow-up-run-request",
  "hitl-report",
  "hydrate",
  "inventory",
  "refinement-proposals",
  "search",
  "signals",
  "source-health",
]);

export const DreamMemoryFabricNodeTypeSchema = z.enum([
  "joelclaw.dream.backfill-plan",
  "joelclaw.dream.backfill-run",
  "joelclaw.dream.correlate",
  "joelclaw.dream.capture-artifact",
  "joelclaw.dream.capture-run",
  "joelclaw.dream.hitl-decision-seed",
  "joelclaw.dream.hitl-follow-up-run-request",
  "joelclaw.dream.hitl-report",
  "joelclaw.dream.hydrate",
  "joelclaw.dream.memory-search",
  "joelclaw.dream.refinement-proposals",
  "joelclaw.dream.signals",
  "joelclaw.dream.source-health",
  "joelclaw.dream.source-inventory",
]);

export const DreamSourceProfileSchema = z
  .object({
    allowedRelayOperations: z.array(DreamMemoryRelayOperationSchema).min(1),
    defaultQuery: z.string().min(1),
    outputBoundary: z.object({
      noCustomerDataInPublicArtifacts: z.literal(true),
      noRawCredentials: z.literal(true),
      noRawPrivatePaths: z.literal(true),
      noRawTranscripts: z.literal(true),
    }),
    packageId: z.string().min(1),
    profileId: z.string().min(1),
    purpose: z.string().min(1),
    requiredMachineIds: z.array(z.string().min(1)).min(1),
    requiredRuntimes: z.array(DreamRuntimeSchema).min(1),
    schemaVersion: z.literal("dream.source-profile.v1"),
    sourceFamiliesExpected: z.array(DreamSourceFamilySchema).min(1),
    sourcePacks: z.array(DreamSourcePackSchema).default([]),
    timeHorizons: z.array(DreamCoverageHorizonSchema).min(1),
    title: z.string().min(1),
    workflowId: z.string().min(1),
  })
  .superRefine((profile, context) => {
    const packIds = new Set<string>();
    for (const [index, pack] of profile.sourcePacks.entries()) {
      if (packIds.has(pack.packId)) {
        context.addIssue({
          code: "custom",
          message:
            "Dream source profile sourcePacks packId values must be unique.",
          path: ["sourcePacks", index, "packId"],
        });
      }
      packIds.add(pack.packId);
    }
  });

export const DreamMemoryRelayPathSchema = z.enum([
  "/memory/backfill/plan",
  "/memory/backfill/run",
  "/memory/capture/artifact",
  "/memory/capture/run",
  "/memory/correlate",
  "/memory/hydrate",
  "/memory/inventory",
  "/memory/search",
  "/memory/signals",
  "/memory/source-health",
]);

const dreamMemoryRelayPathForOperation = {
  "backfill-plan": "/memory/backfill/plan",
  "backfill-run": "/memory/backfill/run",
  "capture-artifact": "/memory/capture/artifact",
  "capture-run": "/memory/capture/run",
  correlate: "/memory/correlate",
  hydrate: "/memory/hydrate",
  inventory: "/memory/inventory",
  search: "/memory/search",
  signals: "/memory/signals",
  "source-health": "/memory/source-health",
} as const satisfies Record<
  z.infer<typeof DreamMemoryRelayOperationSchema>,
  z.infer<typeof DreamMemoryRelayPathSchema>
>;

export const DreamMemoryRelayRedactionPolicySchema = z.object({
  mode: z.enum(["metadata-only", "receipt-only", "redacted-evidence"]),
  noCustomerDataInPublicArtifacts: z.literal(true),
  noRawCredentials: z.literal(true),
  noRawPrivatePaths: z.literal(true),
  noRawTranscripts: z.literal(true),
});

export const DreamMemoryRelayBudgetSchema = z.object({
  maxFiles: z.number().int().min(1).optional(),
  maxRows: z.number().int().min(1).optional(),
  maxTokens: z.number().int().min(1).optional(),
});

export const DreamMemoryRelayTimeWindowSchema = z.object({
  from: IsoDateTimeSchema.optional(),
  label: z.string().min(1).optional(),
  to: IsoDateTimeSchema.optional(),
});

export const DreamMemoryRelayLeaseRefSchema = z.object({
  capability: z.literal("dream.memory.relay"),
  leaseId: z.string().min(1),
  redacted: z.literal(true),
  secretRef: z.string().min(1),
});

export const DreamMemoryRelayLeaseReceiptSchema =
  DreamMemoryRelayLeaseRefSchema.extend({
    status: z.literal("used"),
    usedAt: IsoDateTimeSchema,
  });

export const DreamMemoryRelayFollowUpLinkSchema = z.object({
  href: z.string().min(1),
  label: z.string().min(1),
  rel: z.string().min(1),
});

export const DreamMemoryRelayRequestEnvelopeSchema = z.object({
  actor: ActorSchema,
  allowedSourceFamilies: z.array(DreamSourceFamilySchema).min(1),
  budget: DreamMemoryRelayBudgetSchema,
  idempotencyKey: z.string().min(1),
  lease: DreamMemoryRelayLeaseRefSchema,
  operation: DreamMemoryRelayOperationSchema,
  payload: z.unknown(),
  purpose: z.string().min(1),
  redactionPolicy: DreamMemoryRelayRedactionPolicySchema,
  runId: z.string().min(1),
  schemaVersion: z.literal("dream.memory-relay.request.v1"),
  scope: DreamSourceScopeSchema,
  timeWindow: DreamMemoryRelayTimeWindowSchema,
  traceContext: WorkflowTraceContextSchema,
  workItemId: z.string().min(1),
});

export const DreamMemoryRelayEndpointSchema = z
  .object({
    operation: DreamMemoryRelayOperationSchema,
    path: DreamMemoryRelayPathSchema,
  })
  .superRefine((endpoint, context) => {
    const expectedPath = dreamMemoryRelayPathForOperation[endpoint.operation];
    if (endpoint.path !== expectedPath) {
      context.addIssue({
        code: "custom",
        message: `Dream relay operation ${endpoint.operation} must use path ${expectedPath}.`,
        path: ["path"],
      });
    }
  });

export const DreamMemoryRelayEndpointCatalogSchema = z.object({
  endpoints: z.array(DreamMemoryRelayEndpointSchema).min(1),
  schemaVersion: z.literal("dream.memory-relay.endpoint-catalog.v1"),
});

export const DreamDerivedIndexStatusSchema = z.enum([
  "fresh",
  "missing",
  "stale",
  "unavailable",
]);

export const DreamDerivedIndexSchema = z.object({
  authorityCount: z.number().int().min(0).optional(),
  derivedCount: z.number().int().min(0).optional(),
  freshnessCheckedAt: IsoDateTimeSchema,
  indexId: z.string().min(1),
  indexKind: z.enum(["qmd", "sqlite", "typesense", "vector", "view"]),
  status: DreamDerivedIndexStatusSchema,
});

const DreamMemoryRelayResponseBaseSchema = z.object({
  followUpLinks: z.array(DreamMemoryRelayFollowUpLinkSchema).default([]),
  leaseReceipt: DreamMemoryRelayLeaseReceiptSchema,
  missingSources: z.array(z.string().min(1)).default([]),
  operation: DreamMemoryRelayOperationSchema,
  redacted: z.literal(true),
  runId: z.string().min(1),
  schemaVersion: z.literal("dream.memory-relay.response.v1"),
  sourceFreshness: z.array(DreamDerivedIndexSchema).default([]),
  sourceInventoryRefs: z.array(ArtifactRefSchema).default([]),
  workItemId: z.string().min(1),
});

export const dreamMemoryRelayResponseEnvelopeSchema = <
  TDocument extends z.ZodType,
>(
  documentSchema: TDocument
) =>
  DreamMemoryRelayResponseBaseSchema.extend({
    document: documentSchema,
  });

export const DreamSourceInventoryItemSchema = z.object({
  adapter: z.object({
    checkedAt: IsoDateTimeSchema,
    health: DreamAdapterHealthStatusSchema,
    port: z.string().min(1),
  }),
  authority: z.object({
    count: z.number().int().min(0),
    locatorHash: Sha256HexSchema.optional(),
    redactedLocator: z.string().min(1).optional(),
    sourceSystem: z.string().min(1),
  }),
  blindSpots: z.array(z.string().min(1)).default([]),
  derivedIndexes: z.array(DreamDerivedIndexSchema).default([]),
  family: DreamSourceFamilySchema,
  freshness: z.object({
    earliestAt: IsoDateTimeSchema.optional(),
    indexedAt: IsoDateTimeSchema.optional(),
    latestAt: IsoDateTimeSchema.optional(),
  }),
  label: z.string().min(1),
  privacyTier: DreamPrivacyTierSchema,
  scope: DreamSourceScopeSchema,
  sourceId: z.string().min(1),
});

export const DreamCoverageHorizonCountSchema = z.object({
  earliestAt: IsoDateTimeSchema.optional(),
  hitCount: z.number().int().min(0),
  horizon: DreamCoverageHorizonSchema,
  hydrationCount: z.number().int().min(0),
  latestAt: IsoDateTimeSchema.optional(),
  queryCount: z.number().int().min(0),
});

export const DreamRuntimeCoverageSchema = z
  .object({
    falsePositiveReason: z.string().min(1).optional(),
    horizonCounts: z.array(DreamCoverageHorizonCountSchema).default([]),
    missingReason: z.string().min(1).optional(),
    nativeProof: z
      .object({
        evidenceRefs: z.array(ArtifactRefSchema).default([]),
        redactedLocator: z.string().min(1).optional(),
        sourceId: z.string().min(1),
      })
      .optional(),
    runtime: DreamRuntimeSchema,
    sourceNative: z.boolean(),
    status: DreamRuntimeCoverageStatusSchema,
  })
  .superRefine((coverage, context) => {
    if (
      coverage.status === "captured" &&
      (!coverage.sourceNative || coverage.nativeProof === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Captured runtime coverage requires native source proof.",
        path: ["nativeProof"],
      });
    }

    if (coverage.status === "missing" && coverage.missingReason === undefined) {
      context.addIssue({
        code: "custom",
        message: "Missing runtime coverage requires an explicit reason.",
        path: ["missingReason"],
      });
    }

    if (
      coverage.status === "false-positive" &&
      coverage.falsePositiveReason === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "False-positive runtime coverage requires an explicit reason.",
        path: ["falsePositiveReason"],
      });
    }
  });

export const DreamSourceInventoryDocumentSchema = z
  .object({
    actor: ActorSchema,
    blindSpots: z.array(z.string().min(1)).default([]),
    generatedAt: IsoDateTimeSchema,
    redacted: z.literal(true),
    requiredRuntimes: z.array(DreamRuntimeSchema).min(1),
    runId: z.string().min(1),
    runtimeCoverage: z.array(DreamRuntimeCoverageSchema).min(1),
    schemaVersion: z.literal("dream.source-inventory.v1"),
    scope: DreamSourceScopeSchema,
    sourceFamiliesExpected: z.array(DreamSourceFamilySchema).min(1),
    sources: z.array(DreamSourceInventoryItemSchema).min(1),
    summary: z.string().min(1),
    workItemId: z.string().min(1),
  })
  .superRefine((document, context) => {
    const sourceIds = new Set<string>();
    for (const [index, source] of document.sources.entries()) {
      if (sourceIds.has(source.sourceId)) {
        context.addIssue({
          code: "custom",
          message: "Dream source inventory sourceId values must be unique.",
          path: ["sources", index, "sourceId"],
        });
      }
      sourceIds.add(source.sourceId);
    }

    const coveredRuntimes = new Set(
      document.runtimeCoverage.map((coverage) => coverage.runtime)
    );
    for (const runtime of document.requiredRuntimes) {
      if (!coveredRuntimes.has(runtime)) {
        context.addIssue({
          code: "custom",
          message:
            "Dream source inventory must explicitly report every required runtime.",
          path: ["runtimeCoverage"],
        });
      }
    }
  });

export const DreamSourceHealthStatusSchema = z.enum([
  "blocked",
  "degraded",
  "healthy",
]);

export const DreamSourceHealthDocumentSchema = z.object({
  checkedAt: IsoDateTimeSchema,
  freshnessFailures: z.array(z.string().min(1)).default([]),
  indexHealth: z.array(DreamDerivedIndexSchema).default([]),
  inventoryRef: ArtifactPinSchema,
  redacted: z.literal(true),
  runId: z.string().min(1),
  schemaVersion: z.literal("dream.source-health.v1"),
  status: DreamSourceHealthStatusSchema,
  summary: z.string().min(1),
  workItemId: z.string().min(1),
});

export const DreamBackfillPlanActionSchema = z.object({
  actionId: z.string().min(1),
  authoritySourceId: z.string().min(1),
  controlledScriptRef: z.string().min(1).optional(),
  derivedIndexId: z.string().min(1),
  expectedAuthorityCount: z.number().int().min(0).optional(),
  priority: z.enum(["high", "low", "medium"]),
  reason: z.string().min(1),
  sourceFamily: DreamSourceFamilySchema,
  timeWindow: z.object({
    from: IsoDateTimeSchema.optional(),
    to: IsoDateTimeSchema.optional(),
  }),
});

export const DreamCaptureFixSchema = z.object({
  fixId: z.string().min(1),
  ownerRef: z.string().min(1),
  reasonBackfillWasNeeded: z.string().min(1),
  targetSourceId: z.string().min(1),
});

export const DreamBackfillPlanDocumentSchema = z.object({
  actions: z.array(DreamBackfillPlanActionSchema).default([]),
  captureFixes: z.array(DreamCaptureFixSchema).default([]),
  generatedAt: IsoDateTimeSchema,
  healthRef: ArtifactPinSchema,
  inventoryRef: ArtifactPinSchema,
  mode: z.literal("recovery-not-normal-operation"),
  redacted: z.literal(true),
  runId: z.string().min(1),
  schemaVersion: z.literal("dream.backfill-plan.v1"),
  status: z.enum(["backfill-required", "blocked", "no-backfill-needed"]),
  summary: z.string().min(1),
  workItemId: z.string().min(1),
});

export const DreamMemoryRelayInventoryPayloadSchema = z.object({
  actor: ActorSchema,
  requiredRuntimes: z.array(DreamRuntimeSchema).min(1),
  runId: z.string().min(1),
  sourceFamiliesExpected: z.array(DreamSourceFamilySchema).min(1),
  workItemId: z.string().min(1),
});

export const DreamMemoryRelaySourceHealthPayloadSchema = z.object({
  actor: ActorSchema,
  inventory: DreamSourceInventoryDocumentSchema,
  inventoryRef: ArtifactRefSchema,
  runId: z.string().min(1),
  workItemId: z.string().min(1),
});

export const DreamMemoryRelayBackfillPlanPayloadSchema = z.object({
  actor: ActorSchema,
  health: DreamSourceHealthDocumentSchema,
  healthRef: ArtifactRefSchema,
  inventory: DreamSourceInventoryDocumentSchema,
  inventoryRef: ArtifactRefSchema,
  runId: z.string().min(1),
  workItemId: z.string().min(1),
});

export const DreamMemoryRelayBackfillRunPayloadSchema = z.object({
  actor: ActorSchema,
  plan: DreamBackfillPlanDocumentSchema,
  planRef: ArtifactRefSchema,
  runId: z.string().min(1),
  workItemId: z.string().min(1),
});

export const DreamReceiptRefSchema = z.object({
  artifactRef: ArtifactRefSchema.optional(),
  family: DreamSourceFamilySchema,
  hash: Sha256HexSchema.optional(),
  receiptId: z.string().min(1),
  redactedLocator: z.string().min(1).optional(),
  runtime: DreamRuntimeSchema.optional(),
  sourceId: z.string().min(1),
  timestamp: IsoDateTimeSchema.optional(),
});

export const DreamMemorySearchHitSchema = z.object({
  horizon: DreamCoverageHorizonSchema,
  receipts: z.array(DreamReceiptRefSchema).min(1),
  redactedExcerpt: z.string().min(1).optional(),
  score: z.number().min(0),
  summary: z.string().min(1),
});

export const DreamMemorySearchDocumentSchema = z.object({
  generatedAt: IsoDateTimeSchema,
  hits: z.array(DreamMemorySearchHitSchema).default([]),
  query: z.string().min(1),
  redacted: z.literal(true),
  runId: z.string().min(1),
  schemaVersion: z.literal("dream.memory-search.v1"),
  skippedSources: z.array(z.string().min(1)).default([]),
  workItemId: z.string().min(1),
});

export const DreamMemoryRelaySearchPayloadSchema = z.object({
  actor: ActorSchema,
  maxHits: z.number().int().min(1).max(100).default(10),
  query: z.string().min(1),
  runId: z.string().min(1),
  sourceFamilies: z.array(DreamSourceFamilySchema).min(1).optional(),
  workItemId: z.string().min(1),
});

const DreamMemoryRelayCaptureBasePayloadSchema = z.object({
  actor: ActorSchema,
  readability: z
    .enum(["actor-private", "org-private", "public"])
    .default("actor-private"),
  runId: z.string().min(1),
  sourceFamilies: z.array(DreamSourceFamilySchema).min(1).optional(),
  sourceSystem: z.string().min(1),
  workItemId: z.string().min(1),
});

export const DreamMemoryRelayCaptureArtifactPayloadSchema =
  DreamMemoryRelayCaptureBasePayloadSchema.extend({
    capturedRef: ArtifactPinSchema,
  });

export const DreamMemoryRelayCaptureRunPayloadSchema =
  DreamMemoryRelayCaptureBasePayloadSchema.extend({
    capturedRef: ArtifactPinSchema.optional(),
    targetRunId: z.string().min(1).optional(),
  });

export const DreamSignalKindSchema = z.enum([
  "agent-failure",
  "correction",
  "decision",
  "friction",
  "preference",
  "workflow-pattern",
]);

export const DreamSignalDocumentSchema = z.object({
  generatedAt: IsoDateTimeSchema,
  redacted: z.literal(true),
  runId: z.string().min(1),
  schemaVersion: z.literal("dream.signals.v1"),
  signals: z
    .array(
      z.object({
        confidence: z.number().min(0).max(1),
        kind: DreamSignalKindSchema,
        rating: z.number().int().min(1).max(5),
        reasoning: z.string().min(1),
        receipts: z.array(DreamReceiptRefSchema).min(1),
        signalId: z.string().min(1),
        summary: z.string().min(1),
      })
    )
    .default([]),
  workItemId: z.string().min(1),
});

export const DreamMemoryRelaySignalsPayloadSchema = z.object({
  actor: ActorSchema,
  maxSignals: z.number().int().min(1).max(100).default(10),
  query: z.string().min(1),
  runId: z.string().min(1),
  signalKinds: z.array(DreamSignalKindSchema).min(1).optional(),
  sourceFamilies: z.array(DreamSourceFamilySchema).min(1).optional(),
  workItemId: z.string().min(1),
});

export const DreamHydrationDocumentSchema = z.object({
  generatedAt: IsoDateTimeSchema,
  hydrated: z
    .array(
      z.object({
        evidenceRef: ArtifactRefSchema.optional(),
        fullTranscriptReturned: z.literal(false),
        receipt: DreamReceiptRefSchema,
        redactedExcerpt: z.string().min(1).optional(),
        summary: z.string().min(1),
      })
    )
    .default([]),
  redacted: z.literal(true),
  runId: z.string().min(1),
  schemaVersion: z.literal("dream.hydration.v1"),
  workItemId: z.string().min(1),
});

export const DreamMemoryRelayHydrationPayloadSchema = z.object({
  actor: ActorSchema,
  receipts: z.array(DreamReceiptRefSchema).min(1),
  runId: z.string().min(1),
  workItemId: z.string().min(1),
});

export const DreamMemoryRelayCorrelationPayloadSchema = z.object({
  actor: ActorSchema,
  hydration: DreamHydrationDocumentSchema,
  hydrationRef: ArtifactRefSchema,
  runId: z.string().min(1),
  search: DreamMemorySearchDocumentSchema,
  searchRef: ArtifactRefSchema,
  workItemId: z.string().min(1),
});

export const DreamRefinementProposalTargetKindSchema = z.enum([
  "capability-lease",
  "capture-ingest-fix",
  "dynamic-workflow-pattern",
  "kernel-memory",
  "package-boundary",
  "report-node-improvement",
  "schema-change",
  "workflow-node-plugin",
]);

export const DreamRefinementProposalRecommendationSchema = z.enum([
  "accept",
  "hold",
  "reject",
  "turn-into-work",
]);

export const DreamRefinementProposalSchema = z.object({
  proposalId: z.string().min(1),
  proposedNextStep: z.string().min(1),
  rating: z.number().int().min(1).max(10),
  reasoning: z.string().min(1),
  receipts: z.array(DreamReceiptRefSchema).default([]),
  recommendation: DreamRefinementProposalRecommendationSchema,
  sourceRefs: z.array(ArtifactRefSchema).min(1),
  summary: z.string().min(1),
  targetKind: DreamRefinementProposalTargetKindSchema,
  title: z.string().min(1),
});

export const DreamRefinementProposalDocumentSchema = z.object({
  generatedAt: IsoDateTimeSchema,
  nextWorkflowSeed: z.object({
    plannerInstructions: z.array(z.string().min(1)).min(1),
    proposalIds: z.array(z.string().min(1)).default([]),
    requiredCapabilityKinds: z.array(z.string().min(1)).default([]),
    sourceRefs: z.array(ArtifactRefSchema).min(1),
  }),
  proposalCount: z.number().int().min(0),
  proposals: z.array(DreamRefinementProposalSchema).default([]),
  redacted: z.literal(true),
  runId: z.string().min(1),
  schemaVersion: z.literal("dream.refinement-proposals.v1"),
  sourceRefs: z.array(ArtifactRefSchema).min(1),
  workItemId: z.string().min(1),
});

export const DreamHitlDecisionTargetKindSchema = z.enum([
  "dream-card",
  "refinement-proposal",
]);

export const DreamHitlDecisionArtifactUpdateTargetKindSchema = z.enum([
  "brain",
  "capability-lease",
  "package",
  "report",
  "schema",
  "workflow",
]);

export const DreamHitlDecisionSchema = z.object({
  decision: DreamRefinementProposalRecommendationSchema,
  decisionId: z.string().min(1),
  rating: z.number().int().min(1).max(10),
  reasoning: z.string().min(1),
  receiptTrail: z.array(DreamReceiptRefSchema).default([]),
  recommendation: z.string().min(1),
  reviewedAt: IsoDateTimeSchema,
  sourceRefs: z.array(ArtifactRefSchema).min(1),
  summary: z.string().min(1),
  targetId: z.string().min(1),
  targetKind: DreamHitlDecisionTargetKindSchema,
  targetTitle: z.string().min(1),
});

export const DreamHitlDecisionArtifactUpdateTargetSchema = z.object({
  sourceRefs: z.array(ArtifactRefSchema).min(1),
  summary: z.string().min(1),
  targetKind: DreamHitlDecisionArtifactUpdateTargetKindSchema,
});

export const DreamHitlDecisionNextWorkflowSeedSchema = z.object({
  artifactUpdateTargets: z
    .array(DreamHitlDecisionArtifactUpdateTargetSchema)
    .default([]),
  decisionIds: z.array(z.string().min(1)).default([]),
  plannerInstructions: z.array(z.string().min(1)).default([]),
  requiredCapabilityKinds: z.array(z.string().min(1)).default([]),
  sourceRefs: z.array(ArtifactRefSchema).default([]),
});

export const DreamHitlDecisionDocumentSchema = z
  .object({
    decisionCount: z.number().int().min(0),
    decisions: z.array(DreamHitlDecisionSchema).default([]),
    generatedAt: IsoDateTimeSchema,
    nextWorkflowSeed: DreamHitlDecisionNextWorkflowSeedSchema,
    redacted: z.literal(true),
    refinementProposalRef: ArtifactRefSchema.optional(),
    reportRef: ArtifactRefSchema,
    reviewer: ActorSchema,
    runId: z.string().min(1),
    schemaVersion: z.literal("dream.hitl-decision.v1"),
    sourceRefs: z.array(ArtifactRefSchema).min(1),
    workItemId: z.string().min(1),
  })
  .superRefine((document, context) => {
    if (document.decisionCount !== document.decisions.length) {
      context.addIssue({
        code: "custom",
        message: "decisionCount must match decisions.length.",
        path: ["decisionCount"],
      });
    }

    const actionableDecisions = document.decisions.filter(
      (decision) =>
        decision.decision === "accept" || decision.decision === "turn-into-work"
    );

    if (actionableDecisions.length === 0) {
      if (document.nextWorkflowSeed.decisionIds.length > 0) {
        context.addIssue({
          code: "custom",
          message:
            "nextWorkflowSeed.decisionIds must be empty when no decision is accepted or turned into work.",
          path: ["nextWorkflowSeed", "decisionIds"],
        });
      }
      if (document.nextWorkflowSeed.artifactUpdateTargets.length > 0) {
        context.addIssue({
          code: "custom",
          message:
            "nextWorkflowSeed.artifactUpdateTargets must be empty when no decision is accepted or turned into work.",
          path: ["nextWorkflowSeed", "artifactUpdateTargets"],
        });
      }
      return;
    }

    const seededDecisionIds = new Set(document.nextWorkflowSeed.decisionIds);
    for (const decision of actionableDecisions) {
      if (!seededDecisionIds.has(decision.decisionId)) {
        context.addIssue({
          code: "custom",
          message:
            "Accepted or work-conversion decisions must feed the next workflow seed.",
          path: ["nextWorkflowSeed", "decisionIds"],
        });
      }
    }

    if (document.nextWorkflowSeed.plannerInstructions.length === 0) {
      context.addIssue({
        code: "custom",
        message:
          "Accepted or work-conversion decisions require planner instructions for the next generated workflow.",
        path: ["nextWorkflowSeed", "plannerInstructions"],
      });
    }

    if (document.nextWorkflowSeed.sourceRefs.length === 0) {
      context.addIssue({
        code: "custom",
        message:
          "Accepted or work-conversion decisions require source refs for the next generated workflow.",
        path: ["nextWorkflowSeed", "sourceRefs"],
      });
    }

    if (document.nextWorkflowSeed.artifactUpdateTargets.length === 0) {
      context.addIssue({
        code: "custom",
        message:
          "Accepted or work-conversion decisions require Brain/package/workflow artifact update targets.",
        path: ["nextWorkflowSeed", "artifactUpdateTargets"],
      });
    }
  });

export const DreamHitlDecisionWorkflowSeedStatusSchema = z.enum([
  "no-actionable-decisions",
  "ready",
]);

export const DreamHitlDecisionWorkflowSeedDocumentSchema = z
  .object({
    acceptedDecisionIds: z.array(z.string().min(1)).default([]),
    actionableDecisionCount: z.number().int().min(0),
    actionableDecisions: z.array(DreamHitlDecisionSchema).default([]),
    decisionRef: ArtifactRefSchema,
    generatedAt: IsoDateTimeSchema,
    heldDecisionIds: z.array(z.string().min(1)).default([]),
    nextWorkflowSeed: DreamHitlDecisionNextWorkflowSeedSchema,
    redacted: z.literal(true),
    refinementProposalRef: ArtifactRefSchema.optional(),
    rejectedDecisionIds: z.array(z.string().min(1)).default([]),
    reportRef: ArtifactRefSchema,
    runId: z.string().min(1),
    schemaVersion: z.literal("dream.hitl-decision-workflow-seed.v1"),
    sourceRefs: z.array(ArtifactRefSchema).min(1),
    status: DreamHitlDecisionWorkflowSeedStatusSchema,
    summary: z.string().min(1),
    workItemDecisionIds: z.array(z.string().min(1)).default([]),
    workItemId: z.string().min(1),
  })
  .superRefine((document, context) => {
    if (
      document.actionableDecisionCount !== document.actionableDecisions.length
    ) {
      context.addIssue({
        code: "custom",
        message:
          "actionableDecisionCount must match actionableDecisions.length.",
        path: ["actionableDecisionCount"],
      });
    }

    if (document.status === "ready" && document.actionableDecisionCount === 0) {
      context.addIssue({
        code: "custom",
        message:
          "Ready HITL decision workflow seeds require at least one actionable decision.",
        path: ["status"],
      });
    }

    if (
      document.status === "no-actionable-decisions" &&
      document.actionableDecisionCount > 0
    ) {
      context.addIssue({
        code: "custom",
        message:
          "No-actionable-decisions HITL workflow seeds cannot include actionable decisions.",
        path: ["status"],
      });
    }

    if (
      document.status === "ready" &&
      document.nextWorkflowSeed.plannerInstructions.length === 0
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Ready HITL decision workflow seeds require planner instructions.",
        path: ["nextWorkflowSeed", "plannerInstructions"],
      });
    }

    if (
      document.status === "ready" &&
      document.nextWorkflowSeed.artifactUpdateTargets.length === 0
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Ready HITL decision workflow seeds require artifact update targets.",
        path: ["nextWorkflowSeed", "artifactUpdateTargets"],
      });
    }
  });

export const DreamHitlFollowUpRunRequestStatusSchema = z.enum([
  "drafted",
  "no-actionable-decisions",
]);

export const DreamHitlFollowUpRunRequestDocumentSchema = z
  .object({
    actionableDecisionCount: z.number().int().min(0),
    artifactUpdateTargets: z
      .array(DreamHitlDecisionArtifactUpdateTargetSchema)
      .default([]),
    decisionWorkflowSeedRef: ArtifactRefSchema,
    generatedAt: IsoDateTimeSchema,
    redacted: z.literal(true),
    request: WorkflowRunRequestSchema.optional(),
    requestedPackageIds: z.array(z.string().min(1)).default([]),
    requiredCapabilityKinds: z.array(z.string().min(1)).default([]),
    runId: z.string().min(1),
    schemaVersion: z.literal("dream.hitl-follow-up-run-request.v1"),
    sourceRefs: z.array(ArtifactRefSchema).min(1),
    status: DreamHitlFollowUpRunRequestStatusSchema,
    submitted: z.literal(false),
    summary: z.string().min(1),
    workItemId: z.string().min(1),
  })
  .superRefine((document, context) => {
    if (document.status === "drafted" && document.request === undefined) {
      context.addIssue({
        code: "custom",
        message: "Drafted follow-up run request artifacts require request.",
        path: ["request"],
      });
    }

    if (
      document.status === "no-actionable-decisions" &&
      document.request !== undefined
    ) {
      context.addIssue({
        code: "custom",
        message:
          "No-actionable-decisions follow-up artifacts cannot include a run request.",
        path: ["request"],
      });
    }

    if (
      document.status === "no-actionable-decisions" &&
      document.actionableDecisionCount !== 0
    ) {
      context.addIssue({
        code: "custom",
        message:
          "No-actionable-decisions follow-up artifacts must have actionableDecisionCount === 0.",
        path: ["actionableDecisionCount"],
      });
    }

    if (
      document.status === "drafted" &&
      document.actionableDecisionCount === 0
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Drafted follow-up run requests require at least one actionable decision.",
        path: ["actionableDecisionCount"],
      });
    }

    if (
      document.status === "drafted" &&
      document.artifactUpdateTargets.length === 0
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Drafted follow-up run requests require artifact update targets.",
        path: ["artifactUpdateTargets"],
      });
    }
  });

export const DREAM_HITL_REPORT_SECTION_ORDER = [
  "run-context",
  "actual-dreams",
  "what-to-do",
  "actionable-line-items",
  "proof",
  "technical-appendix",
] as const;

export const DreamHitlReportProofLevelSchema = z.enum([
  "generated-machine",
  "plan-derived",
  "static-fallback",
]);

export const DreamHitlReportSectionIdSchema = z.enum(
  DREAM_HITL_REPORT_SECTION_ORDER
);

export const DreamHitlReportSectionOrderSchema = z.tuple([
  z.literal("run-context"),
  z.literal("actual-dreams"),
  z.literal("what-to-do"),
  z.literal("actionable-line-items"),
  z.literal("proof"),
  z.literal("technical-appendix"),
]);

export const DreamHitlReportTemplateSchema = z.object({
  defaultExpiresIn: z.literal("24h"),
  format: z.literal("mdsvx"),
  noindex: z.literal(true),
  templateId: z.literal("joel/tufte-mdsvx"),
  version: z.literal("0.1.0"),
});

export const DreamHitlReportStateMachineFigureSchema = z.object({
  aspectRatio: z.string().min(1),
  component: z.literal("D2"),
  machineBinding: z.object({
    machineArtifactHash: Sha256HexSchema,
    machineArtifactRef: ArtifactRefSchema,
    machineId: z.string().min(1),
    machineSourceArtifactRef: ArtifactRefSchema,
    machineSourceHash: Sha256HexSchema,
    status: z.literal("bound-to-generated-machine"),
  }),
  machineId: z.string().min(1),
  source: z.string().min(1),
  sourceHash: Sha256HexSchema,
  sourceKind: z.literal("generated-xstate-machine"),
  stateCount: z.number().int().min(1),
  transitionCount: z.number().int().min(0),
});

export const DreamHitlReportGeneratedArtifactsSchema = z.object({
  harness: GeneratedHarnessArtifactSchema,
  machine: DynamicWorkflowMachineArtifactSchema,
  plan: z.object({
    planId: z.string().min(1),
    planner: z.object({
      kind: z.literal("stochastic"),
      nonce: z.string().min(1),
      source: z.string().min(1),
    }),
    stepCount: z.number().int().min(1),
  }),
  verificationContract: VerificationContractArtifactSchema,
});

export const DreamHitlReportDefinitionOfDoneAuditItemSchema = z.object({
  blockerRefs: z.array(z.string().min(1)).default([]),
  evidenceRefs: z.array(z.string().min(1)).default([]),
  requirement: z.string().min(1),
  requirementId: z.string().min(1),
  status: z.enum(["blocked", "captured", "missing", "not-proven"]),
  summary: z.string().min(1),
});

export const DreamHitlReportDefinitionOfDoneAuditSchema = z.object({
  generatedAt: IsoDateTimeSchema,
  items: z.array(DreamHitlReportDefinitionOfDoneAuditItemSchema).min(1),
  redacted: z.literal(true),
  runId: z.string().min(1),
  schemaVersion: z.literal("dream.hitl-report.definition-of-done-audit.v1"),
  status: z.enum(["blocked", "captured", "not-proven"]),
  summary: z.object({
    blockedCount: z.number().int().min(0),
    capturedCount: z.number().int().min(0),
    missingCount: z.number().int().min(0),
    notProvenCount: z.number().int().min(0),
    totalCount: z.number().int().min(1),
  }),
});

export const DreamHitlDreamCardSchema = z.object({
  rating: z.number().int().min(1).max(10),
  reasoning: z.string().min(1),
  receipts: z.array(DreamReceiptRefSchema).min(1),
  recommendation: z.string().min(1),
  summary: z.string().min(1),
  title: z.string().min(1),
});

export const DreamHitlDecisionContractSchema = z.object({
  artifactPath: z.literal("dream/hitl-decision.json"),
  contractRef: z.literal(
    "contract://workflow/dream-memory-fabric/hitl-decision.v1"
  ),
  decisionSchemaVersion: z.literal("dream.hitl-decision.v1"),
  exportId: z.literal("dream-hitl-decision-schema"),
  nextWorkflowSeedRequiredFor: z.tuple([
    z.literal("accept"),
    z.literal("turn-into-work"),
  ]),
  sourceRefs: z.array(ArtifactRefSchema).min(1),
  targetKinds: z.tuple([
    z.literal("dream-card"),
    z.literal("refinement-proposal"),
  ]),
});

export const DreamHitlReportDocumentSchema = z.object({
  definitionOfDoneAudit: DreamHitlReportDefinitionOfDoneAuditSchema,
  dreamCount: z.number().int().min(0),
  dreams: z.array(DreamHitlDreamCardSchema).default([]),
  expiresIn: z.literal("24h"),
  generatedAt: IsoDateTimeSchema,
  hitlDecisionContract: DreamHitlDecisionContractSchema,
  mdsvx: z.string().min(1),
  noindex: z.literal(true),
  proof: z.object({
    dynamicGenerationProofLevel: DreamHitlReportProofLevelSchema,
    generatedArtifacts: DreamHitlReportGeneratedArtifactsSchema,
    rawTranscriptsReturned: z.literal(false),
    stateMachineFigure: DreamHitlReportStateMachineFigureSchema,
  }),
  receiptCount: z.number().int().min(0),
  redacted: z.literal(true),
  refinementProposalCount: z.number().int().min(0).default(0),
  refinementProposalRef: ArtifactRefSchema.optional(),
  refinementProposals: z.array(DreamRefinementProposalSchema).default([]),
  runId: z.string().min(1),
  schemaVersion: z.literal("dream.hitl-report.v1"),
  sectionOrder: DreamHitlReportSectionOrderSchema,
  sourceRefs: z.array(ArtifactRefSchema).min(1),
  template: DreamHitlReportTemplateSchema,
  title: z.string().min(1),
  workItemId: z.string().min(1),
});

export const DreamGeneratedWorkflowProofCheckSchema = z.object({
  checkId: z.string().min(1),
  evidenceRefs: z.array(ArtifactRefSchema).default([]),
  status: z.enum(["failed", "passed"]),
  summary: z.string().min(1),
});

export const DreamGeneratedWorkflowProofDocumentSchema = z.object({
  checks: z.array(DreamGeneratedWorkflowProofCheckSchema).min(1),
  completedStepIds: z.array(z.string().min(1)),
  effectCoverage: z.object({
    coveredEffects: z.array(DreamWorkflowEffectSchema),
    requiredEffects: z.array(DreamWorkflowEffectSchema).min(1),
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
    coveredHorizons: z.array(DreamCoverageHorizonSchema),
    requiredHorizons: z.array(DreamCoverageHorizonSchema).min(1),
  }),
  machineArtifact: z.object({
    artifactRef: ArtifactRefSchema,
    hash: Sha256HexSchema,
    machineId: z.string().min(1),
    sourceArtifactRef: ArtifactRefSchema,
    sourceHash: Sha256HexSchema,
  }),
  nodeTypes: z.array(DreamMemoryFabricNodeTypeSchema),
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
  runtimeSourceCoverage: z.object({
    declaredMachineIds: z.array(z.string().min(1)).default([]),
    declaredRuntimes: z.array(DreamRuntimeSchema).default([]),
    declaredSourceFamilies: z.array(DreamSourceFamilySchema).default([]),
    inventoryStepIds: z.array(z.string().min(1)).default([]),
    requiredMachineIds: z.array(z.string().min(1)).min(1),
    requiredRuntimes: z.array(DreamRuntimeSchema).min(1),
    requiredSourceFamilies: z.array(DreamSourceFamilySchema).min(1),
  }),
  schemaVersion: z.literal("dream.generated-workflow-proof.v1"),
  sourcePackDisposition: z.object({
    dispositionCount: z.number().int().min(0),
    dispositions: z.array(DreamSourcePackDispositionSchema).default([]),
    expectedPackIds: z.array(z.string().min(1)).default([]),
    missingPackIds: z.array(z.string().min(1)).default([]),
    unexpectedPackIds: z.array(z.string().min(1)).default([]),
  }),
  sourceProfile: z.object({
    allowedRelayOperations: z.array(DreamMemoryRelayOperationSchema).min(1),
    hash: Sha256HexSchema,
    packageExportId: z.string().min(1),
    packageId: z.string().min(1),
    profileId: z.string().min(1),
    requiredMachineIds: z.array(z.string().min(1)).min(1),
    requiredRuntimes: z.array(DreamRuntimeSchema).min(1),
    sourceFamiliesExpected: z.array(DreamSourceFamilySchema).min(1),
    sourcePacks: z.array(DreamSourcePackSchema).default([]),
    timeHorizons: z.array(DreamCoverageHorizonSchema).min(1),
    workflowId: z.string().min(1),
  }),
  status: z.enum(["failed", "verified"]),
  stepCount: z.number().int().min(1),
  stepIds: z.array(z.string().min(1)).min(1),
  workItemId: z.string().min(1),
});

export const DreamCorrelationGraphDocumentSchema = z.object({
  edges: z
    .array(
      z.object({
        edgeId: z.string().min(1),
        evidence: z.array(DreamReceiptRefSchema).min(1),
        fromNodeId: z.string().min(1),
        relationship: z.enum([
          "belongs_to_org",
          "belongs_to_project",
          "contradicts_memory",
          "corrected_by",
          "eligible_for_backfill",
          "mentions_person",
          "produced_artifact",
          "reported_by",
          "repeats_pattern",
          "requires_hydration",
          "supports_dream",
        ]),
        toNodeId: z.string().min(1),
      })
    )
    .default([]),
  generatedAt: IsoDateTimeSchema,
  nodes: z
    .array(
      z.object({
        label: z.string().min(1),
        nodeId: z.string().min(1),
        nodeType: z.enum([
          "actor",
          "artifact",
          "event",
          "memory",
          "org",
          "project",
          "source",
        ]),
        redacted: z.literal(true),
      })
    )
    .default([]),
  redacted: z.literal(true),
  runId: z.string().min(1),
  schemaVersion: z.literal("dream.correlation-graph.v1"),
  workItemId: z.string().min(1),
});

export const DreamBackfillRunReceiptDocumentSchema = z.object({
  actionResults: z
    .array(
      z.object({
        actionId: z.string().min(1),
        failures: z.array(z.string().min(1)).default([]),
        indexedCount: z.number().int().min(0),
        skippedReasons: z.array(z.string().min(1)).default([]),
        status: z.enum(["blocked", "completed", "failed", "skipped"]),
      })
    )
    .default([]),
  captureFixResults: z
    .array(
      z.object({
        failures: z.array(z.string().min(1)).default([]),
        fixId: z.string().min(1),
        ownerRef: z.string().min(1),
        repairAction: z.string().min(1),
        skippedReasons: z.array(z.string().min(1)).default([]),
        status: z.enum(["blocked", "completed", "failed", "skipped"]),
        targetSourceId: z.string().min(1),
      })
    )
    .default([]),
  completedAt: IsoDateTimeSchema,
  planRef: ArtifactPinSchema,
  redacted: z.literal(true),
  runId: z.string().min(1),
  schemaVersion: z.literal("dream.backfill-run-receipt.v1"),
  workItemId: z.string().min(1),
});

const DreamCaptureReceiptBaseDocumentSchema = z.object({
  captureKind: z.enum(["artifact", "run"]),
  capturedAt: IsoDateTimeSchema,
  capturedRef: ArtifactPinSchema,
  readability: z.enum(["actor-private", "org-private", "public"]),
  redacted: z.literal(true),
  runId: z.string().min(1),
  schemaVersion: z.literal("dream.capture-receipt.v1"),
  sourceSystem: z.string().min(1),
  workItemId: z.string().min(1),
});

export const DreamCaptureReceiptDocumentSchema = z.discriminatedUnion(
  "captureKind",
  [
    DreamCaptureReceiptBaseDocumentSchema.extend({
      captureKind: z.literal("artifact"),
    }),
    DreamCaptureReceiptBaseDocumentSchema.extend({
      captureKind: z.literal("run"),
      capturedRunId: z.string().min(1),
    }),
  ]
);

export type DreamAdapterHealthStatus = z.infer<
  typeof DreamAdapterHealthStatusSchema
>;
export type DreamBackfillRunReceiptDocument = z.infer<
  typeof DreamBackfillRunReceiptDocumentSchema
>;
export type DreamBackfillPlanAction = z.infer<
  typeof DreamBackfillPlanActionSchema
>;
export type DreamBackfillPlanDocument = z.infer<
  typeof DreamBackfillPlanDocumentSchema
>;
export type DreamCaptureReceiptDocument = z.infer<
  typeof DreamCaptureReceiptDocumentSchema
>;
export type DreamCaptureFix = z.infer<typeof DreamCaptureFixSchema>;
export type DreamCorrelationGraphDocument = z.infer<
  typeof DreamCorrelationGraphDocumentSchema
>;
export type DreamCoverageHorizon = z.infer<typeof DreamCoverageHorizonSchema>;
export type DreamCoverageHorizonCount = z.infer<
  typeof DreamCoverageHorizonCountSchema
>;
export type DreamDerivedIndex = z.infer<typeof DreamDerivedIndexSchema>;
export type DreamDerivedIndexStatus = z.infer<
  typeof DreamDerivedIndexStatusSchema
>;
export type DreamHydrationDocument = z.infer<
  typeof DreamHydrationDocumentSchema
>;
export type DreamHitlDreamCard = z.infer<typeof DreamHitlDreamCardSchema>;
export type DreamHitlDecisionContract = z.infer<
  typeof DreamHitlDecisionContractSchema
>;
export type DreamHitlReportDocument = z.infer<
  typeof DreamHitlReportDocumentSchema
>;
export type DreamHitlReportDefinitionOfDoneAudit = z.infer<
  typeof DreamHitlReportDefinitionOfDoneAuditSchema
>;
export type DreamHitlReportDefinitionOfDoneAuditItem = z.infer<
  typeof DreamHitlReportDefinitionOfDoneAuditItemSchema
>;
export type DreamHitlReportGeneratedArtifacts = z.infer<
  typeof DreamHitlReportGeneratedArtifactsSchema
>;
export type DreamHitlReportProofLevel = z.infer<
  typeof DreamHitlReportProofLevelSchema
>;
export type DreamHitlReportSectionId = z.infer<
  typeof DreamHitlReportSectionIdSchema
>;
export type DreamHitlReportStateMachineFigure = z.infer<
  typeof DreamHitlReportStateMachineFigureSchema
>;
export type DreamHitlReportTemplate = z.infer<
  typeof DreamHitlReportTemplateSchema
>;
export type DreamGeneratedWorkflowProofDocument = z.infer<
  typeof DreamGeneratedWorkflowProofDocumentSchema
>;
export type DreamMemoryRelayBudget = z.infer<
  typeof DreamMemoryRelayBudgetSchema
>;
export type DreamMemoryRelayEndpoint = z.infer<
  typeof DreamMemoryRelayEndpointSchema
>;
export type DreamMemoryRelayEndpointCatalog = z.infer<
  typeof DreamMemoryRelayEndpointCatalogSchema
>;
export type DreamMemoryRelayCorrelationPayload = z.infer<
  typeof DreamMemoryRelayCorrelationPayloadSchema
>;
export type DreamMemoryRelayFollowUpLink = z.infer<
  typeof DreamMemoryRelayFollowUpLinkSchema
>;
export type DreamMemoryRelayLeaseReceipt = z.infer<
  typeof DreamMemoryRelayLeaseReceiptSchema
>;
export type DreamMemoryRelayLeaseRef = z.infer<
  typeof DreamMemoryRelayLeaseRefSchema
>;
export type DreamMemoryFabricNodeType = z.infer<
  typeof DreamMemoryFabricNodeTypeSchema
>;
export type DreamMemoryRelayOperation = z.infer<
  typeof DreamMemoryRelayOperationSchema
>;
export type DreamWorkflowEffect = z.infer<typeof DreamWorkflowEffectSchema>;
export type DreamMemoryRelayBackfillPlanPayload = z.infer<
  typeof DreamMemoryRelayBackfillPlanPayloadSchema
>;
export type DreamMemoryRelayBackfillRunPayload = z.infer<
  typeof DreamMemoryRelayBackfillRunPayloadSchema
>;
export type DreamMemoryRelayCaptureArtifactPayload = z.infer<
  typeof DreamMemoryRelayCaptureArtifactPayloadSchema
>;
export type DreamMemoryRelayCaptureRunPayload = z.infer<
  typeof DreamMemoryRelayCaptureRunPayloadSchema
>;
export type DreamMemoryRelayHydrationPayload = z.infer<
  typeof DreamMemoryRelayHydrationPayloadSchema
>;
export type DreamMemoryRelayInventoryPayload = z.infer<
  typeof DreamMemoryRelayInventoryPayloadSchema
>;
export type DreamMemoryRelayPath = z.infer<typeof DreamMemoryRelayPathSchema>;
export type DreamMemoryRelayRedactionPolicy = z.infer<
  typeof DreamMemoryRelayRedactionPolicySchema
>;
export type DreamMemoryRelayRequestEnvelope = z.infer<
  typeof DreamMemoryRelayRequestEnvelopeSchema
>;
export type DreamMemoryRelaySearchPayload = z.infer<
  typeof DreamMemoryRelaySearchPayloadSchema
>;
export type DreamMemoryRelaySignalsPayload = z.infer<
  typeof DreamMemoryRelaySignalsPayloadSchema
>;
export type DreamMemoryRelaySourceHealthPayload = z.infer<
  typeof DreamMemoryRelaySourceHealthPayloadSchema
>;
export type DreamMemoryRelayTimeWindow = z.infer<
  typeof DreamMemoryRelayTimeWindowSchema
>;
export type DreamMemorySearchDocument = z.infer<
  typeof DreamMemorySearchDocumentSchema
>;
export type DreamMemorySearchHit = z.infer<typeof DreamMemorySearchHitSchema>;
export type DreamPrivacyTier = z.infer<typeof DreamPrivacyTierSchema>;
export type DreamReceiptRef = z.infer<typeof DreamReceiptRefSchema>;
export type DreamHitlDecision = z.infer<typeof DreamHitlDecisionSchema>;
export type DreamHitlDecisionArtifactUpdateTarget = z.infer<
  typeof DreamHitlDecisionArtifactUpdateTargetSchema
>;
export type DreamHitlDecisionArtifactUpdateTargetKind = z.infer<
  typeof DreamHitlDecisionArtifactUpdateTargetKindSchema
>;
export type DreamHitlDecisionDocument = z.infer<
  typeof DreamHitlDecisionDocumentSchema
>;
export type DreamHitlDecisionWorkflowSeedDocument = z.infer<
  typeof DreamHitlDecisionWorkflowSeedDocumentSchema
>;
export type DreamHitlDecisionWorkflowSeedStatus = z.infer<
  typeof DreamHitlDecisionWorkflowSeedStatusSchema
>;
export type DreamHitlFollowUpRunRequestDocument = z.infer<
  typeof DreamHitlFollowUpRunRequestDocumentSchema
>;
export type DreamHitlFollowUpRunRequestStatus = z.infer<
  typeof DreamHitlFollowUpRunRequestStatusSchema
>;
export type DreamHitlDecisionNextWorkflowSeed = z.infer<
  typeof DreamHitlDecisionNextWorkflowSeedSchema
>;
export type DreamHitlDecisionTargetKind = z.infer<
  typeof DreamHitlDecisionTargetKindSchema
>;
export type DreamRefinementProposal = z.infer<
  typeof DreamRefinementProposalSchema
>;
export type DreamRefinementProposalDocument = z.infer<
  typeof DreamRefinementProposalDocumentSchema
>;
export type DreamRefinementProposalRecommendation = z.infer<
  typeof DreamRefinementProposalRecommendationSchema
>;
export type DreamRefinementProposalTargetKind = z.infer<
  typeof DreamRefinementProposalTargetKindSchema
>;
export type DreamRuntime = z.infer<typeof DreamRuntimeSchema>;
export type DreamRuntimeCoverage = z.infer<typeof DreamRuntimeCoverageSchema>;
export type DreamRuntimeCoverageStatus = z.infer<
  typeof DreamRuntimeCoverageStatusSchema
>;
export type DreamSignalDocument = z.infer<typeof DreamSignalDocumentSchema>;
export type DreamSignalKind = z.infer<typeof DreamSignalKindSchema>;
export type DreamSourceFamily = z.infer<typeof DreamSourceFamilySchema>;
export type DreamSourcePack = z.infer<typeof DreamSourcePackSchema>;
export type DreamSourcePackDisposition = z.infer<
  typeof DreamSourcePackDispositionSchema
>;
export type DreamSourcePackDispositionStatus = z.infer<
  typeof DreamSourcePackDispositionStatusSchema
>;
export type DreamSourcePackSelectionPolicy = z.infer<
  typeof DreamSourcePackSelectionPolicySchema
>;
export type DreamSourceSurface = z.infer<typeof DreamSourceSurfaceSchema>;
export type DreamSourceHealthDocument = z.infer<
  typeof DreamSourceHealthDocumentSchema
>;
export type DreamSourceHealthStatus = z.infer<
  typeof DreamSourceHealthStatusSchema
>;
export type DreamSourceProfile = z.infer<typeof DreamSourceProfileSchema>;
export type DreamSourceInventoryDocument = z.infer<
  typeof DreamSourceInventoryDocumentSchema
>;
export type DreamSourceInventoryItem = z.infer<
  typeof DreamSourceInventoryItemSchema
>;
export type DreamSourceScope = z.infer<typeof DreamSourceScopeSchema>;
