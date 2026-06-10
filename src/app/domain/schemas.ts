import { z } from "zod";

export const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const IsoDateTimeSchema = z.iso.datetime();
export const ArtifactRefSchema = z.string().regex(/^artifact:\/\/.+/u);

export const ActorTypeSchema = z.enum(["human", "agent", "service"]);
export const TrustTierSchema = z.enum(["manual", "reviewed", "bounded-auto"]);

export const ActorSchema = z.object({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  roleIds: z.array(z.string().min(1)).default([]),
  sessionId: z.string().min(1),
  trustTier: TrustTierSchema,
  type: ActorTypeSchema,
});

export const ArtifactWriteReceiptSchema = z.object({
  artifactRef: ArtifactRefSchema,
  contentHash: Sha256HexSchema,
  mediaType: z.string().min(1),
  redacted: z.literal(true),
});

export const ArtifactPinSchema = z.object({
  artifactRef: ArtifactRefSchema,
  hash: Sha256HexSchema,
  mediaType: z.string().min(1),
});

export const AgentLanePackageMountEvidenceSchema = ArtifactPinSchema.extend({
  mountCount: z.number().int().min(0),
});

export const AgentLaneSandboxAccountingSchema = z.object({
  cleanup: z
    .object({
      receipt: z.string().min(1),
      status: z.literal("destroyed"),
    })
    .optional(),
  commandDurationMs: z.number().nonnegative(),
});

export const GeneratedTextArtifactDraftSchema = z.object({
  mediaType: z.string().min(1),
  path: z.string().min(1),
  redacted: z.literal(true),
  value: z.string().min(1),
});

export const AgentLaneKindSchema = z.enum(["planner", "worker", "verifier"]);
export const AgentLaneRuntimeSchema = z.enum([
  "pi-agent-cli",
  "pi-agent-rpc",
  "pi-sdk-runPrintMode",
  "think-framework",
  "integration-test",
]);
export const AgentLaneStatusSchema = z.enum([
  "planned",
  "running",
  "completed",
  "blocked",
  "failed",
]);

export const AgentLaneTokenCostAccountingSourceSchema = z.enum([
  "pi-cli-usage",
  "adapter-reported",
  "integration-test-fixture",
]);

export const AgentLaneTokenCostAccountingSchema = z.object({
  costEstimate: z.number().nonnegative().nullable(),
  currency: z.literal("USD").optional(),
  inputTokens: z.number().int().min(0).optional(),
  outputTokens: z.number().int().min(0).optional(),
  redacted: z.literal(true),
  source: AgentLaneTokenCostAccountingSourceSchema,
  tokenCount: z.number().int().min(0),
});

export const AgentLaneAdmissionRequestSchema = z.object({
  kind: AgentLaneKindSchema,
  laneId: z.string().min(1),
  maxActiveLanes: z.number().int().min(1).max(32),
  requestedAt: IsoDateTimeSchema,
  runId: z.string().min(1),
  workItemId: z.string().min(1),
});

export const AgentLaneAdmissionDecisionSchema = z.discriminatedUnion("status", [
  z.object({
    activeLaneIds: z.array(z.string().min(1)),
    admissionId: z.string().min(1),
    admittedAt: IsoDateTimeSchema,
    kind: AgentLaneKindSchema,
    laneId: z.string().min(1),
    maxActiveLanes: z.number().int().min(1),
    runId: z.string().min(1),
    status: z.literal("admitted"),
    workItemId: z.string().min(1),
  }),
  z.object({
    activeLaneIds: z.array(z.string().min(1)),
    kind: AgentLaneKindSchema,
    laneId: z.string().min(1),
    maxActiveLanes: z.number().int().min(1),
    reason: z.enum(["concurrency-cap-full", "already-active"]),
    retryAfterSeconds: z.number().int().min(1),
    runId: z.string().min(1),
    status: z.literal("deferred"),
    workItemId: z.string().min(1),
  }),
  z.object({
    kind: AgentLaneKindSchema,
    laneId: z.string().min(1),
    runId: z.string().min(1),
    status: z.literal("already-completed"),
    workItemId: z.string().min(1),
  }),
]);

export const AgentLaneReleaseStatusSchema = z.enum(["completed", "failed"]);

export const AgentLaneReleaseRequestSchema = z.object({
  artifactCommitSha: z.string().min(1).optional(),
  kind: AgentLaneKindSchema,
  laneId: z.string().min(1),
  releasedAt: IsoDateTimeSchema,
  runId: z.string().min(1),
  status: AgentLaneReleaseStatusSchema,
  workItemId: z.string().min(1),
});

export const AgentLaneReleaseReceiptSchema = z.object({
  activeLaneIds: z.array(z.string().min(1)),
  artifactCommitSha: z.string().min(1).optional(),
  kind: AgentLaneKindSchema,
  laneId: z.string().min(1),
  releasedAt: IsoDateTimeSchema,
  runId: z.string().min(1),
  status: AgentLaneReleaseStatusSchema,
  workItemId: z.string().min(1),
});

export const AgentAuthLeaseScopeSchema = z.literal("pi-agent-auth-json");

export const AgentAuthLeaseSchema = z.object({
  expiresAt: IsoDateTimeSchema,
  issuedAt: IsoDateTimeSchema,
  leaseId: z.string().min(1),
  redacted: z.literal(true),
  runId: z.string().min(1),
  scope: AgentAuthLeaseScopeSchema,
  secretRef: z.string().min(1),
  workItemId: z.string().min(1),
});

export const WorkflowTraceContextSchema = z.object({
  parentSpanId: z.string().min(1).optional(),
  redacted: z.literal(true),
  spanId: z.string().min(1),
  traceId: z.string().min(1),
});

const enforceRealAgentRuntime = (
  lane: {
    readonly authLease?: unknown;
    readonly realAgent: boolean;
    readonly runtime: string;
    readonly traceContext?: unknown;
  },
  context: z.RefinementCtx
) => {
  if (lane.runtime === "integration-test" && lane.realAgent) {
    context.addIssue({
      code: "custom",
      message:
        "integration-test lane receipts cannot claim real agent execution.",
      path: ["realAgent"],
    });
  }

  if (lane.runtime !== "integration-test" && !lane.realAgent) {
    context.addIssue({
      code: "custom",
      message: "Agent runtime lane receipts must be marked realAgent.",
      path: ["realAgent"],
    });
  }

  if (
    lane.runtime !== "integration-test" &&
    lane.runtime.startsWith("pi-") &&
    lane.authLease === undefined
  ) {
    context.addIssue({
      code: "custom",
      message: "Real Pi lane receipts must include auth lease metadata.",
      path: ["authLease"],
    });
  }

  if (lane.runtime !== "integration-test" && lane.traceContext === undefined) {
    context.addIssue({
      code: "custom",
      message:
        "Real agent lane receipts must include propagated trace context.",
      path: ["traceContext"],
    });
  }
};

export const AgentLaneEvidenceDraftSchema = z
  .object({
    artifactCommitSha: z.string().min(1).optional(),
    authLease: AgentAuthLeaseSchema.optional(),
    completedAt: IsoDateTimeSchema.optional(),
    kind: AgentLaneKindSchema,
    laneId: z.string().min(1),
    outputPins: z.array(ArtifactPinSchema).default([]),
    outputRefs: z.array(ArtifactRefSchema).default([]),
    packageMounts: AgentLanePackageMountEvidenceSchema.optional(),
    prompt: GeneratedTextArtifactDraftSchema,
    realAgent: z.boolean(),
    redacted: z.literal(true),
    runtime: AgentLaneRuntimeSchema,
    sandboxAccounting: AgentLaneSandboxAccountingSchema.optional(),
    sandboxRef: z.string().min(1).optional(),
    startedAt: IsoDateTimeSchema,
    status: AgentLaneStatusSchema,
    tokenCostAccounting: AgentLaneTokenCostAccountingSchema.optional(),
    traceContext: WorkflowTraceContextSchema.optional(),
    transcript: GeneratedTextArtifactDraftSchema,
  })
  .superRefine(enforceRealAgentRuntime);

export const AgentLaneReceiptSchema = z
  .object({
    artifactCommitSha: z.string().min(1).optional(),
    authLease: AgentAuthLeaseSchema.optional(),
    completedAt: IsoDateTimeSchema.optional(),
    kind: AgentLaneKindSchema,
    laneId: z.string().min(1),
    outputPins: z.array(ArtifactPinSchema).default([]),
    outputRefs: z.array(ArtifactRefSchema).default([]),
    packageMounts: AgentLanePackageMountEvidenceSchema.optional(),
    prompt: ArtifactPinSchema,
    realAgent: z.boolean(),
    receiptRef: ArtifactRefSchema,
    redacted: z.literal(true),
    runtime: AgentLaneRuntimeSchema,
    sandboxAccounting: AgentLaneSandboxAccountingSchema.optional(),
    sandboxRef: z.string().min(1).optional(),
    startedAt: IsoDateTimeSchema,
    status: AgentLaneStatusSchema,
    tokenCostAccounting: AgentLaneTokenCostAccountingSchema.optional(),
    traceContext: WorkflowTraceContextSchema.optional(),
    transcript: ArtifactPinSchema,
  })
  .superRefine(enforceRealAgentRuntime);

export const PackageKindSchema = z.enum([
  "kernel",
  "context-pack",
  "workflow-pack",
  "tool-pack",
  "support-pack",
  "adapter-pack",
]);

export const PackageExportSchema = z
  .object({
    contractRef: z.string().min(1),
    exportId: z.string().min(1),
    kind: z.enum([
      "app",
      "service",
      "job",
      "workflow",
      "subscription",
      "retriever",
      "adapter",
      "workflow-node",
      "schema",
      "source-profile",
      "prompt",
      "skill",
    ]),
    nodeType: z.string().min(1).optional(),
  })
  .superRefine((exportRecord, context) => {
    if (
      exportRecord.kind === "workflow-node" &&
      exportRecord.nodeType === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Workflow-node package exports require nodeType.",
        path: ["nodeType"],
      });
    }
  });

export const PackageMetadataSchema = z.object({
  description: z.string().min(1),
  exports: z.array(PackageExportSchema).default([]),
  kind: PackageKindSchema,
  latestArtifactRef: ArtifactRefSchema,
  latestVersion: z.string().min(1),
  manifestPath: z.literal("package.json"),
  ownerRef: z.string().min(1),
  packageId: z.string().min(1),
  title: z.string().min(1),
  trustTier: TrustTierSchema,
});

export const PackageEntitlementSchema = z.object({
  canDiscover: z.boolean(),
  canInvoke: z.boolean(),
  canMount: z.boolean(),
  packageId: z.string().min(1),
  subjectId: z.string().min(1),
  subjectType: z.enum(["actor", "organization", "role", "service"]),
  versionRange: z.string().min(1),
});

export const PinnedPackageSchema = z.object({
  artifactRef: ArtifactRefSchema,
  fileHashes: z.record(z.string().min(1), Sha256HexSchema),
  manifestHash: Sha256HexSchema,
  metadata: PackageMetadataSchema,
  pinnedAt: IsoDateTimeSchema,
  version: z.string().min(1),
});

export const WorkflowCartridgeTrustPolicySchema = z.object({
  invocationRequiresEntitlement: z.literal(true),
  sideEffectsRequireLeases: z.literal(true),
  verifyExportContract: z.literal(true),
  verifyManifestHash: z.literal(true),
});

export const WorkflowCartridgeNodeExportSchema = z.object({
  contractRef: z.string().min(1),
  exportId: z.string().min(1),
  nodeType: z.string().min(1),
  packageId: z.string().min(1),
});

export const WorkflowCartridgeManifestSchema = z.object({
  artifactPins: z.array(ArtifactPinSchema).default([]),
  nodeExports: z.array(WorkflowCartridgeNodeExportSchema).min(1),
  package: PackageMetadataSchema,
  redacted: z.literal(true),
  schemaVersion: z.literal("workflow.cartridge-manifest.v1"),
  trustPolicy: WorkflowCartridgeTrustPolicySchema,
});

export const WorkflowCartridgeInvocationProofDocumentSchema = z.object({
  contractRef: z.string().min(1),
  exportId: z.string().min(1),
  manifestHash: Sha256HexSchema,
  nodeType: z.string().min(1),
  packageId: z.string().min(1),
  packageRef: ArtifactRefSchema,
  redacted: z.literal(true),
  runId: z.string().min(1),
  schemaVersion: z.literal("workflow.cartridge-invocation-proof.v1"),
  status: z.literal("verified"),
  stepId: z.string().min(1),
  verification: z.object({
    exportMatched: z.literal(true),
    nodeTypeMatched: z.literal(true),
    packagePinned: z.literal(true),
    sideEffectsRequireLeases: z.literal(true),
  }),
  verifiedAt: IsoDateTimeSchema,
  version: z.string().min(1),
  workItemId: z.string().min(1),
});

export const WorkflowLivePreflightCheckSchema = z.object({
  checkId: z.string().min(1),
  message: z.string().min(1).optional(),
  redacted: z.literal(true),
  required: z.boolean(),
  requiredFor: z.array(z.string().min(1)).default([]),
  status: z.enum(["failed", "missing", "passed", "present", "skipped"]),
});

export const WorkflowLivePreflightRemotePackageRowSchema = z.object({
  artifactRef: ArtifactRefSchema.optional(),
  manifestHash: Sha256HexSchema.optional(),
  packageId: z.string().min(1),
});

export const WorkflowLivePreflightRemoteRegistrySchema = z.object({
  command: z.array(z.string().min(1)).default([]),
  errorMessage: z.string().min(1).optional(),
  expectedPackageArtifactRef: ArtifactRefSchema.optional(),
  expectedPackageArtifactRefMatched: z.boolean().optional(),
  expectedPackageId: z.string().min(1),
  expectedPackageManifestHash: Sha256HexSchema.optional(),
  expectedPackageManifestHashMatched: z.boolean().optional(),
  expectedPackageSeeded: z.boolean().optional(),
  expectedWorkflowNodeTypes: z.array(z.string().min(1)).default([]),
  packageIds: z.array(z.string().min(1)).default([]),
  packageRows: z.array(WorkflowLivePreflightRemotePackageRowSchema).default([]),
  redacted: z.literal(true),
  status: z.enum(["failed", "queried", "skipped"]),
  stderr: z.string().optional(),
  stdout: z.string().optional(),
});

export const WorkflowLivePreflightRemoteSecretInventorySchema = z.object({
  command: z.array(z.string().min(1)).default([]),
  errorMessage: z.string().min(1).optional(),
  redacted: z.literal(true),
  secretNames: z.array(z.string().min(1)).default([]),
  status: z.enum(["failed", "queried", "skipped"]),
  stderr: z.string().optional(),
  stdout: z.string().optional(),
});

export const WorkflowLivePreflightArtifactModelSchema = z.object({
  cartridgeKind: z.literal("artifact-backed-workflow-cartridge"),
  dynamicWorkflowRequiresGeneratedMachine: z.literal(true),
  generatedArtifactsRequired: z.array(z.string().min(1)).min(1),
  sideEffectsRequireCapabilityLeases: z.literal(true),
});

export const WorkflowLivePreflightRelayOperationSchema = z.enum([
  "backfill-plan",
  "backfill-run",
  "correlate",
  "hydrate",
  "inventory",
  "search",
  "signals",
  "source-health",
]);

export const WorkflowLivePreflightDreamSourceFamilySchema = z.enum([
  "agent-transcripts",
  "brain",
  "cloudflare-runs",
  "comms",
  "docs-pdf-brain",
  "people-org-memory",
  "repo-outputs",
  "support",
]);

export const WorkflowLivePreflightRelayCapabilitySchema = z.object({
  allowedOperations: z.array(WorkflowLivePreflightRelayOperationSchema).min(1),
  allowedSourceFamilies: z
    .array(WorkflowLivePreflightDreamSourceFamilySchema)
    .min(1),
  budget: z.object({
    maxFiles: z.number().int().min(1),
    maxRows: z.number().int().min(1),
    maxTokens: z.number().int().min(1),
  }),
  capability: z.literal("dream.memory.relay"),
  idempotencyKeyPrefix: z.literal("dream-memory-relay"),
  lease: z.object({
    required: z.literal(true),
    secretBindingName: z.literal("DREAM_MEMORY_RELAY_TOKEN"),
    secretRef: z.string().min(1),
  }),
  readiness: z.object({
    endpointConfigured: z.boolean(),
    healthzStatus: WorkflowLivePreflightCheckSchema.shape.status,
    localProofStatus: WorkflowLivePreflightCheckSchema.shape.status,
    tokenConfigured: z.boolean(),
    workerBaseUrlConfigured: z.boolean(),
  }),
  redacted: z.literal(true),
  redactionPolicy: z.object({
    mode: z.literal("redacted-evidence"),
    noCustomerDataInPublicArtifacts: z.literal(true),
    noRawCredentials: z.literal(true),
    noRawPrivatePaths: z.literal(true),
    noRawTranscripts: z.literal(true),
  }),
  relayReceiptsRequired: z.literal(true),
  traceCapability: z.literal("dream.memory.relay"),
});

export const WorkflowLivePreflightReceiptSchema = z.object({
  artifactModel: WorkflowLivePreflightArtifactModelSchema,
  checks: z.array(WorkflowLivePreflightCheckSchema).min(1),
  expectedCartridgePackageId: z.string().min(1),
  generatedAt: IsoDateTimeSchema,
  redacted: z.literal(true),
  relayCapability: WorkflowLivePreflightRelayCapabilitySchema,
  remoteRegistry: WorkflowLivePreflightRemoteRegistrySchema,
  remoteSecrets: WorkflowLivePreflightRemoteSecretInventorySchema,
  requiredActions: z.array(z.string().min(1)).default([]),
  schemaVersion: z.literal("workflow.live-preflight.v1"),
  status: z.enum(["blocked", "ready"]),
  workerUrl: z.url(),
  workflowId: z.string().min(1),
});

export const AgentLanePackageMountSchema = PinnedPackageSchema.extend({
  mountPath: z.string().regex(/^packages\/[A-Za-z0-9_.-]+$/u),
});

export const AgentLanePackageMountIndexSchema = z.object({
  mounts: z.array(AgentLanePackageMountSchema),
  redacted: z.literal(true),
  schemaVersion: z.literal("agent-lane.package-mounts.v1"),
});

export const DiscordMessagePayloadSchema = z.object({
  body: z.string().min(1).max(2000),
  bodyHash: Sha256HexSchema,
  channelRef: z.string().min(1),
  serverRef: z.string().min(1),
});

export const DiscordMessageApprovalSchema = z.object({
  actorId: z.string().min(1),
  approvedAt: IsoDateTimeSchema,
  dryRun: z.literal(false),
  payloadHash: Sha256HexSchema,
  payloadRef: ArtifactRefSchema,
  redacted: z.literal(true),
  runId: z.string().min(1),
  schemaVersion: z.literal("workflow.discord-message-approval.v1"),
  summary: z.string().min(1),
  workItemId: z.string().min(1),
});

export const PlanProposalSchema = z.object({
  discordMessage: z
    .object({
      body: z.string().min(1).max(2000),
      channelRef: z.string().min(1),
      dryRun: z.boolean().default(true),
      serverRef: z.string().min(1),
    })
    .optional(),
  intent: z.string().min(1),
  requestedPackageIds: z.array(z.string().min(1)).default([]),
  stochasticNotes: z.array(z.string().min(1)).default([]),
});

export const CapabilityNameSchema = z.enum([
  "discord.message.send",
  "github.branch.commit",
  "github.pull-request.create",
  "linear.comment.create",
  "wzrrd.site.publish",
]);

export const DiscordResourceSchema = z.object({
  channelRef: z.string().min(1),
  kind: z.literal("discord.channel"),
  serverRef: z.string().min(1),
});

export const WzrrdResourceSchema = z.object({
  kind: z.literal("wzrrd.site"),
  siteRef: z.string().min(1),
  slug: z.string().min(1),
});

export const GitHubRepositoryResourceSchema = z.object({
  baseBranch: z.string().min(1),
  headBranch: z.string().min(1),
  kind: z.literal("github.repository"),
  repositoryRef: z.string().min(1),
});

export const LinearIssueResourceSchema = z.object({
  issueRef: z.string().min(1),
  kind: z.literal("linear.issue"),
});

export const CapabilityResourceSchema = z.discriminatedUnion("kind", [
  DiscordResourceSchema,
  GitHubRepositoryResourceSchema,
  LinearIssueResourceSchema,
  WzrrdResourceSchema,
]);

export const ReviewGateSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("dry-run-exempt"),
    reason: z.string().min(1),
  }),
  z.object({
    approvalRef: z.string().min(1),
    mode: z.literal("approved"),
    reviewerActorId: z.string().min(1),
  }),
  z.object({
    mode: z.literal("required"),
    reviewRef: ArtifactRefSchema,
  }),
  z.object({
    mode: z.literal("rejected"),
    reason: z.string().min(1),
    reviewRef: ArtifactRefSchema,
  }),
]);

export const OutputTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("artifact-only"),
    path: z.string().min(1),
  }),
  z.object({
    kind: z.literal("wzrrd"),
    primaryDocument: z
      .object({
        artifactPath: z.string().min(1),
        mediaType: z.enum(["text/mdsvx", "text/html", "text/markdown"]),
        publishPath: z.string().min(1),
        title: z.string().min(1),
      })
      .optional(),
    reviewPath: z.string().min(1),
  }),
  z.object({
    baseBranch: z.string().min(1).default("main"),
    branchName: z.string().min(1),
    kind: z.literal("github-pr"),
    repositoryRef: z.string().min(1),
  }),
  z.object({
    issueRef: z.string().min(1),
    kind: z.literal("linear"),
  }),
]);

export const WorkflowSideEffectDeclarationSchema = z.object({
  capability: CapabilityNameSchema,
  dryRun: z.boolean(),
  payloadHash: Sha256HexSchema,
  payloadRef: ArtifactRefSchema,
  resource: CapabilityResourceSchema,
  reviewGate: ReviewGateSchema,
  secretRef: z.string().min(1),
  stepId: z.string().min(1),
});

export const DynamicWorkflowStepSchema = z.discriminatedUnion("kind", [
  z.object({
    config: z.record(z.string().min(1), z.unknown()).default({}),
    dependsOn: z.array(z.string().min(1)).default([]),
    inputRefs: z.array(ArtifactRefSchema).default([]),
    kind: z.literal("workflow.node.invoke"),
    nodeType: z.string().min(1),
    outputPath: z.string().min(1),
    packageRefs: z.array(ArtifactRefSchema).default([]),
    stepId: z.string().min(1),
    summary: z.string().min(1),
  }),
  z.object({
    dependsOn: z.array(z.string().min(1)).default([]),
    kind: z.literal("research.review"),
    outputPath: z.string().min(1),
    packageRefs: z.array(ArtifactRefSchema).min(1),
    stepId: z.string().min(1),
    summary: z.string().min(1),
  }),
  z.object({
    dependsOn: z.array(z.string().min(1)).default([]),
    dryRun: z.boolean(),
    kind: z.literal("capability.discord.message"),
    payloadHash: Sha256HexSchema,
    payloadRef: ArtifactRefSchema,
    resource: DiscordResourceSchema,
    reviewGate: ReviewGateSchema,
    secretRef: z.string().min(1),
    stepId: z.string().min(1),
    summary: z.string().min(1),
  }),
  z.object({
    dependsOn: z.array(z.string().min(1)).default([]),
    kind: z.literal("review.summary"),
    outputPath: z.string().min(1),
    stepId: z.string().min(1),
    summary: z.string().min(1),
  }),
]);

export const ResearchReviewOutputDocumentSchema = z.object({
  findings: z
    .array(
      z.object({
        claim: z.string().min(1),
        evidence: z.string().min(1),
        sourceRefs: z.array(z.string().min(1)).default([]),
      })
    )
    .default([]),
  generatedAt: IsoDateTimeSchema,
  nextActions: z.array(z.string().min(1)).default([]),
  risks: z.array(z.string().min(1)).default([]),
  runId: z.string().min(1),
  schemaVersion: z.literal("workflow.research-review-output.v1"),
  stepId: z.string().min(1),
  summary: z.string().min(1),
  workItemId: z.string().min(1),
});

export const DynamicWorkflowMachineStateMetaSchema = z.object({
  stepId: z.string().min(1).optional(),
  stepKind: z.string().min(1).optional(),
  summary: z.string().min(1).optional(),
});

export const DynamicWorkflowMachineTransitionSchema = z.object({
  target: z.string().min(1),
});

export const DynamicWorkflowMachineStateSchema = z.object({
  meta: DynamicWorkflowMachineStateMetaSchema.default({}),
  on: z
    .record(z.string().min(1), DynamicWorkflowMachineTransitionSchema)
    .default({}),
  type: z.literal("final").optional(),
});

export const DynamicWorkflowMachineConfigSchema = z.object({
  id: z.string().min(1),
  initial: z.string().min(1),
  states: z
    .record(z.string().min(1), DynamicWorkflowMachineStateSchema)
    .refine((states) => Object.keys(states).length > 0, {
      message: "Generated XState machine must contain at least one state.",
    }),
});

export const DynamicWorkflowMachineDocumentSchema = z.object({
  createdAt: IsoDateTimeSchema,
  machineId: z.string().min(1),
  planner: z.object({
    kind: z.literal("stochastic"),
    nonce: z.string().min(1),
    source: z.string().min(1),
  }),
  runId: z.string().min(1),
  schemaVersion: z.literal("workflow.xstate-machine.v1"),
  stepOrder: z.array(z.string().min(1)).min(1),
  workItemId: z.string().min(1),
  xstate: DynamicWorkflowMachineConfigSchema,
});

export const DynamicWorkflowMachineArtifactSchema = z.object({
  artifactRef: ArtifactRefSchema,
  hash: Sha256HexSchema,
  machineId: z.string().min(1),
  sourceArtifactRef: ArtifactRefSchema,
  sourceHash: Sha256HexSchema,
});

export const GeneratedHarnessDocumentSchema = z.object({
  createdAt: IsoDateTimeSchema,
  entrypoint: z.literal("workflows/harness.ts"),
  harnessId: z.string().min(1),
  language: z.literal("typescript"),
  planner: z.object({
    kind: z.literal("stochastic"),
    nonce: z.string().min(1),
    source: z.string().min(1),
  }),
  runId: z.string().min(1),
  schemaVersion: z.literal("workflow.generated-harness.v1"),
  source: z.string().min(1),
  workItemId: z.string().min(1),
});

export const GeneratedHarnessArtifactSchema = z.object({
  artifactRef: ArtifactRefSchema,
  entrypoint: z.literal("workflows/harness.ts"),
  harnessId: z.string().min(1),
  hash: Sha256HexSchema,
  language: z.literal("typescript"),
});

export const VerificationSeveritySchema = z.enum(["blocking", "warning"]);

export const VerificationContractDocumentSchema = z.object({
  checks: z.array(
    z.object({
      checkId: z.string().min(1),
      evidenceRequired: z.string().min(1),
      severity: VerificationSeveritySchema,
      summary: z.string().min(1),
    })
  ),
  contractId: z.string().min(1),
  createdAt: IsoDateTimeSchema,
  outputPath: z.string().min(1),
  runId: z.string().min(1),
  schemaVersion: z.literal("workflow.verification-contract.v1"),
  verifier: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("agent-lane"),
      runtime: AgentLaneRuntimeSchema.exclude(["integration-test"]),
    }),
    z.object({
      kind: z.literal("deterministic"),
      source: z.string().min(1),
    }),
  ]),
  workItemId: z.string().min(1),
});

export const VerificationContractArtifactSchema = z.object({
  artifactRef: ArtifactRefSchema,
  contractId: z.string().min(1),
  hash: Sha256HexSchema,
  mediaType: z.literal("application/json"),
});

export const VerificationResultDocumentSchema = z.object({
  checkedAt: IsoDateTimeSchema,
  contractId: z.string().min(1),
  failures: z
    .array(
      z.object({
        checkId: z.string().min(1),
        message: z.string().min(1),
        severity: VerificationSeveritySchema,
      })
    )
    .default([]),
  resultId: z.string().min(1),
  runId: z.string().min(1),
  schemaVersion: z.literal("workflow.verification-result.v1"),
  status: z.enum(["accepted", "accepted_with_warnings", "blocked"]),
  verifierLaneId: z.string().min(1).optional(),
});

export const VerificationResultArtifactSchema = z.object({
  artifactRef: ArtifactRefSchema,
  hash: Sha256HexSchema,
  mediaType: z.literal("application/json"),
  resultId: z.string().min(1),
});

const WorkflowExecutionProofBaseSchema = z.object({
  completedStepIds: z.array(z.string().min(1)),
  eventCount: z.number().int().min(0),
  eventLogHash: Sha256HexSchema,
  generatedAt: IsoDateTimeSchema,
  generatedStateSequence: z.array(z.string().min(1)).min(1),
  harnessArtifact: GeneratedHarnessArtifactSchema,
  leaseIds: z.array(z.string().min(1)).default([]),
  machineArtifact: DynamicWorkflowMachineArtifactSchema,
  planArtifact: z.object({
    artifactRef: ArtifactRefSchema,
    hash: Sha256HexSchema,
    pinnedAt: IsoDateTimeSchema,
    runId: z.string().min(1),
  }),
  proofId: z.string().min(1),
  redacted: z.literal(true),
  runId: z.string().min(1),
  schemaVersion: z.literal("workflow.execution-proof.v1"),
  verificationResultRef: ArtifactRefSchema.optional(),
  verifierLaneReceiptRef: ArtifactRefSchema.optional(),
  workItemId: z.string().min(1),
  workerLaneReceiptRefs: z.array(ArtifactRefSchema).default([]),
  workflowNodeOutputRefs: z.array(ArtifactRefSchema).default([]),
});

export const WorkflowExecutionProofDocumentSchema = z.discriminatedUnion(
  "status",
  [
    WorkflowExecutionProofBaseSchema.extend({
      platform: z.literal("local-integration"),
      reason: z.string().min(1),
      requiredProof: z.array(z.string().min(1)).min(1),
      status: z.literal("not-proven-local-integration"),
    }),
    WorkflowExecutionProofBaseSchema.extend({
      cloudflare: z.object({
        deploymentId: z.string().min(1).optional(),
        platform: z.literal("cloudflare-workers"),
        workerName: z.string().min(1).optional(),
      }),
      platform: z.literal("cloudflare-workers"),
      status: z.literal("cloudflare-generated-machine-executed"),
      verificationResultRef: ArtifactRefSchema,
    }),
  ]
);

export const WorkflowExecutionProofArtifactSchema = z.object({
  artifactRef: ArtifactRefSchema,
  hash: Sha256HexSchema,
  mediaType: z.literal("application/json"),
  proofId: z.string().min(1),
  status: z.enum([
    "not-proven-local-integration",
    "cloudflare-generated-machine-executed",
  ]),
});

export const ReviewSurfaceArtifactSchema = z.object({
  artifactRef: ArtifactRefSchema,
  hash: Sha256HexSchema,
  kind: z.enum(["wzrrd", "artifact-review", "github-pr", "linear"]),
  mediaType: z.literal("application/json"),
  supportingArtifactRefs: z.array(ArtifactRefSchema).default([]),
  surfaceId: z.string().min(1),
});

export const ReviewSurfaceAcceptanceRefSchema = z.object({
  kind: z.string().min(1),
  title: z.string().min(1),
  url: z.string().min(1),
});

export const ReviewSurfaceObservabilitySignalSchema = z.enum([
  "structured-high-cardinality-logs",
  "runtime-event-log",
  "trace-spans",
  "metrics",
  "cost-token-accounting",
  "sandbox-accounting",
  "capability-lease-receipts",
  "agent-readable-observability-pack",
  "status-projection",
  "redaction-policy",
]);

export const ReviewSurfaceStructuredLogFieldSchema = z.enum([
  "runId",
  "workItemId",
  "capsuleId",
  "actorId",
  "packageId",
  "packageVersion",
  "artifactRepo",
  "artifactRef",
  "artifactCommitSha",
  "laneId",
  "laneKind",
  "laneRuntime",
  "sandboxRef",
  "admissionId",
  "stepId",
  "stepKind",
  "capability",
  "leaseId",
  "resourceRef",
  "payloadHash",
  "verifierResultId",
  "reviewSurfaceId",
  "blockerCode",
  "traceId",
  "spanId",
  "durationMs",
  "tokenCount",
  "costEstimate",
  "projectionSink",
  "projectionStatus",
]);

export const ReviewSurfaceObservabilityRequirementSchema = z.object({
  redactionPolicy: z.literal("no-secrets-no-raw-auth-no-token-bearing-refs"),
  requiredSignals: z.array(ReviewSurfaceObservabilitySignalSchema).min(1),
  requiredStructuredLogFields: z
    .array(ReviewSurfaceStructuredLogFieldSchema)
    .min(1),
  status: z.enum(["required", "captured", "blocked"]),
  summary: z.string().min(1),
});

export const ReviewSurfaceWorkflowChainRequirementIdSchema = z.enum([
  "intent-and-policy",
  "context-capsule",
  "package-discovery-and-pinning",
  "pi-planner-lane",
  "pinned-plan-phase",
  "pi-worker-lanes",
  "capability-lease-requests",
  "verifier-lane",
  "review-surface",
  "captured-receipts",
]);

export const ReviewSurfaceWorkflowChainRequirementSchema = z.object({
  eventStates: z.array(z.string().min(1)).default([]),
  evidenceRefs: z.array(ArtifactRefSchema).default([]),
  requirementId: ReviewSurfaceWorkflowChainRequirementIdSchema,
  status: z.enum(["captured", "missing"]),
  summary: z.string().min(1),
});

export const ReviewSurfaceWorkflowChainCompletionSchema = z.object({
  requirements: z.array(ReviewSurfaceWorkflowChainRequirementSchema).min(1),
  status: z.enum(["captured", "incomplete"]),
  summary: z.string().min(1),
});

export const ReviewSurfaceProposalRequirementIdSchema = z.enum([
  "package-first-saved-primitive",
  "artifact-backed-package-pinning",
  "entitlement-and-trust-policy",
  "generated-xstate-dynamic-workflow",
  "cloudflare-execution-proof",
  "real-pi-agent-lanes",
  "capability-leased-side-effects",
  "receipt-backed-review-surface",
  "observability-redaction-envelope",
]);

export const ReviewSurfaceProposalReconciliationRequirementSchema = z.object({
  acceptanceRefUrls: z.array(z.string().min(1)).default([]),
  evidenceRefs: z.array(ArtifactRefSchema).default([]),
  requirementId: ReviewSurfaceProposalRequirementIdSchema,
  status: z.enum(["captured", "missing"]),
  summary: z.string().min(1),
});

export const ReviewSurfaceProposalReconciliationSchema = z.object({
  requirements: z
    .array(ReviewSurfaceProposalReconciliationRequirementSchema)
    .min(1),
  status: z.enum(["linked", "reconciled", "superseded"]),
  summary: z.string().min(1),
});

export const ReviewSurfaceDefinitionOfDoneSchema = z.object({
  acceptanceRefs: z.array(ReviewSurfaceAcceptanceRefSchema).default([]),
  observability: ReviewSurfaceObservabilityRequirementSchema,
  reconciliation: ReviewSurfaceProposalReconciliationSchema,
  workflowChain: ReviewSurfaceWorkflowChainCompletionSchema,
});

export const DynamicWorkflowPlanBaseSchema = z.object({
  actor: ActorSchema,
  createdAt: IsoDateTimeSchema,
  outputTarget: OutputTargetSchema,
  pinnedPackages: z.array(PinnedPackageSchema).min(1),
  planId: z.string().min(1),
  planner: z.object({
    kind: z.literal("stochastic"),
    nonce: z.string().min(1),
    source: z.string().min(1),
  }),
  proposal: z.object({
    intent: z.string().min(1),
    requestedPackageIds: z.array(z.string().min(1)),
    stochasticNotes: z.array(z.string().min(1)),
  }),
  runId: z.string().min(1),
  safety: z.object({
    capabilityLeasesRequired: z.literal(true),
    durableState: z.literal("artifacts-d1-do-r2-only"),
    scratchOnly: z.literal(true),
  }),
  schemaVersion: z.literal("workflow.dynamic-plan.v1"),
  sideEffects: z.array(WorkflowSideEffectDeclarationSchema).default([]),
  steps: z.array(DynamicWorkflowStepSchema).min(1),
  workItemId: z.string().min(1),
});

export const DynamicWorkflowPlanDocumentSchema =
  DynamicWorkflowPlanBaseSchema.extend({
    harness: GeneratedHarnessArtifactSchema,
    machine: DynamicWorkflowMachineArtifactSchema,
    plannerLane: AgentLaneReceiptSchema,
    verificationContract: VerificationContractArtifactSchema,
  });

export const PlannerLaneBlueprintDocumentSchema = z.object({
  harness: GeneratedHarnessDocumentSchema,
  machine: DynamicWorkflowMachineDocumentSchema,
  plan: DynamicWorkflowPlanBaseSchema,
  verificationContract: VerificationContractDocumentSchema,
});

export const DynamicWorkflowBlueprintSchema =
  PlannerLaneBlueprintDocumentSchema.extend({
    plannerLane: AgentLaneEvidenceDraftSchema,
  });

export const PlanArtifactSchema = z.object({
  artifactRef: ArtifactRefSchema,
  hash: Sha256HexSchema,
  pinnedAt: IsoDateTimeSchema,
  runId: z.string().min(1),
});

export const CapabilityDenialCodeSchema = z.enum([
  "missing_auth",
  "entitlement_missing",
  "stale_package",
  "payload_hash_mismatch",
  "review_required",
  "review_rejected",
  "spend_cap_exceeded",
  "secret_denied",
  "capability_denied",
  "resource_scope_denied",
  "adapter_unavailable",
  "receipt_persistence_failed",
]);

export const CapabilityBlockerSchema = z.object({
  approvalRef: z.string().min(1).optional(),
  code: CapabilityDenialCodeSchema,
  message: z.string().min(1),
  redacted: z.literal(true),
});

export const CapabilityLeaseRequestSchema = z.object({
  actor: ActorSchema,
  capability: CapabilityNameSchema,
  dryRun: z.boolean(),
  expiresAt: IsoDateTimeSchema,
  payloadHash: Sha256HexSchema,
  payloadRef: ArtifactRefSchema,
  receiptSink: ArtifactRefSchema,
  resource: CapabilityResourceSchema,
  reviewGate: ReviewGateSchema,
  rollbackRef: ArtifactRefSchema.optional(),
  runId: z.string().min(1),
  secretRef: z.string().min(1),
  traceContext: WorkflowTraceContextSchema,
  workItemId: z.string().min(1),
});

export const CapabilityLeaseSchema = z.object({
  actor: ActorSchema,
  capability: CapabilityNameSchema,
  capabilityRef: z.string().min(1),
  dryRun: z.boolean(),
  expiresAt: IsoDateTimeSchema,
  leaseId: z.string().min(1),
  payloadHash: Sha256HexSchema,
  payloadRef: ArtifactRefSchema,
  policyId: z.string().min(1),
  receiptSink: ArtifactRefSchema,
  redacted: z.literal(true),
  resource: CapabilityResourceSchema,
  reviewGate: ReviewGateSchema,
  rollbackRef: ArtifactRefSchema.optional(),
  runId: z.string().min(1),
  secretRef: z.string().min(1),
  traceContext: WorkflowTraceContextSchema,
  workItemId: z.string().min(1),
});

export const CapabilityLeaseDecisionSchema = z.discriminatedUnion("status", [
  z.object({
    blocker: CapabilityBlockerSchema,
    status: z.literal("denied"),
  }),
  z.object({
    lease: CapabilityLeaseSchema,
    status: z.literal("issued"),
  }),
]);

export const DiscordDeliveryResultSchema = z.discriminatedUnion("status", [
  z.object({
    channelRef: z.string().min(1),
    dryRun: z.literal(true),
    messageId: z.string().min(1).optional(),
    payloadHash: Sha256HexSchema,
    redacted: z.literal(true),
    serverRef: z.string().min(1),
    status: z.literal("dry-run"),
  }),
  z.object({
    channelRef: z.string().min(1),
    dryRun: z.literal(false),
    messageId: z.string().min(1),
    payloadHash: Sha256HexSchema,
    redacted: z.literal(true),
    serverRef: z.string().min(1),
    status: z.literal("sent"),
  }),
  z.object({
    blocker: CapabilityBlockerSchema,
    status: z.literal("blocked"),
  }),
]);

export const WzrrdPublishPayloadSchema = z.object({
  primaryDocument: z
    .object({
      artifactRef: ArtifactRefSchema,
      hash: Sha256HexSchema,
      mediaType: z.enum(["text/mdsvx", "text/html", "text/markdown"]),
      path: z.string().min(1),
      title: z.string().min(1),
    })
    .optional(),
  redacted: z.literal(true),
  reviewSurface: z.object({
    artifactRef: ArtifactRefSchema,
    hash: Sha256HexSchema,
    kind: z.enum(["wzrrd", "artifact-review", "github-pr", "linear"]),
    surfaceId: z.string().min(1),
  }),
  runId: z.string().min(1),
  schemaVersion: z.literal("wzrrd.publish-payload.v1"),
  slug: z.string().min(1),
  title: z.string().min(1),
  workItemId: z.string().min(1),
});

export const WzrrdPublishApprovalSchema = z.object({
  actorId: z.string().min(1),
  approvedAt: IsoDateTimeSchema,
  dryRun: z.literal(false),
  payloadHash: Sha256HexSchema,
  payloadRef: ArtifactRefSchema,
  redacted: z.literal(true),
  runId: z.string().min(1),
  schemaVersion: z.literal("workflow.wzrrd-publish-approval.v1"),
  summary: z.string().min(1),
  workItemId: z.string().min(1),
});

export const GitHubPullRequestPayloadSchema = z.object({
  baseBranch: z.string().min(1),
  body: z.string().min(1),
  bodyHash: Sha256HexSchema,
  headBranch: z.string().min(1),
  redacted: z.literal(true),
  repositoryRef: z.string().min(1),
  reviewSurface: z.object({
    artifactRef: ArtifactRefSchema,
    hash: Sha256HexSchema,
    kind: z.enum(["wzrrd", "artifact-review", "github-pr", "linear"]),
    surfaceId: z.string().min(1),
  }),
  runId: z.string().min(1),
  schemaVersion: z.literal("github.pull-request-payload.v1"),
  title: z.string().min(1),
  workItemId: z.string().min(1),
});

export const GitHubBranchCommitFileSchema = z.object({
  content: z.string().min(1),
  contentHash: Sha256HexSchema,
  mediaType: z.string().min(1),
  path: z.string().min(1),
  redacted: z.literal(true),
});

export const GitHubBranchCommitPayloadSchema = z.object({
  baseBranch: z.string().min(1),
  commitMessage: z.string().min(1),
  files: z.array(GitHubBranchCommitFileSchema).min(1).max(10),
  headBranch: z.string().min(1),
  redacted: z.literal(true),
  repositoryRef: z.string().min(1),
  reviewSurface: z.object({
    artifactRef: ArtifactRefSchema,
    hash: Sha256HexSchema,
    kind: z.enum(["wzrrd", "artifact-review", "github-pr", "linear"]),
    surfaceId: z.string().min(1),
  }),
  runId: z.string().min(1),
  schemaVersion: z.literal("github.branch-commit-payload.v1"),
  workItemId: z.string().min(1),
});

export const GitHubBranchCommitApprovalSchema = z.object({
  actorId: z.string().min(1),
  approvedAt: IsoDateTimeSchema,
  dryRun: z.literal(false),
  payloadHash: Sha256HexSchema,
  payloadRef: ArtifactRefSchema,
  redacted: z.literal(true),
  runId: z.string().min(1),
  schemaVersion: z.literal("workflow.github-branch-commit-approval.v1"),
  summary: z.string().min(1),
  workItemId: z.string().min(1),
});

export const GitHubPullRequestApprovalSchema = z.object({
  actorId: z.string().min(1),
  approvedAt: IsoDateTimeSchema,
  dryRun: z.literal(false),
  payloadHash: Sha256HexSchema,
  payloadRef: ArtifactRefSchema,
  redacted: z.literal(true),
  runId: z.string().min(1),
  schemaVersion: z.literal("workflow.github-pr-approval.v1"),
  summary: z.string().min(1),
  workItemId: z.string().min(1),
});

export const LinearCommentPayloadSchema = z.object({
  body: z.string().min(1).max(65_000),
  bodyHash: Sha256HexSchema,
  issueRef: z.string().min(1),
  redacted: z.literal(true),
  reviewSurface: z.object({
    artifactRef: ArtifactRefSchema,
    hash: Sha256HexSchema,
    kind: z.enum(["wzrrd", "artifact-review", "github-pr", "linear"]),
    surfaceId: z.string().min(1),
  }),
  runId: z.string().min(1),
  schemaVersion: z.literal("linear.comment-payload.v1"),
  workItemId: z.string().min(1),
});

export const LinearCommentApprovalSchema = z.object({
  actorId: z.string().min(1),
  approvedAt: IsoDateTimeSchema,
  dryRun: z.literal(false),
  payloadHash: Sha256HexSchema,
  payloadRef: ArtifactRefSchema,
  redacted: z.literal(true),
  runId: z.string().min(1),
  schemaVersion: z.literal("workflow.linear-comment-approval.v1"),
  summary: z.string().min(1),
  workItemId: z.string().min(1),
});

export const WzrrdPublishDeliveryResultSchema = z.discriminatedUnion("status", [
  z.object({
    dryRun: z.literal(true),
    payloadHash: Sha256HexSchema,
    redacted: z.literal(true),
    reviewSurfaceRef: ArtifactRefSchema,
    slug: z.string().min(1),
    status: z.literal("dry-run"),
    url: z.url().optional(),
  }),
  z.object({
    dryRun: z.literal(false),
    payloadHash: Sha256HexSchema,
    publishedAt: IsoDateTimeSchema,
    redacted: z.literal(true),
    reviewSurfaceRef: ArtifactRefSchema,
    slug: z.string().min(1),
    status: z.literal("published"),
    url: z.url(),
  }),
  z.object({
    blocker: CapabilityBlockerSchema,
    status: z.literal("blocked"),
  }),
]);

export const GitHubPullRequestDeliveryResultSchema = z.discriminatedUnion(
  "status",
  [
    z.object({
      baseBranch: z.string().min(1),
      dryRun: z.literal(true),
      headBranch: z.string().min(1),
      payloadHash: Sha256HexSchema,
      pullRequestUrl: z.url().optional(),
      redacted: z.literal(true),
      repositoryRef: z.string().min(1),
      status: z.literal("dry-run"),
    }),
    z.object({
      baseBranch: z.string().min(1),
      dryRun: z.literal(false),
      headBranch: z.string().min(1),
      openedAt: IsoDateTimeSchema,
      payloadHash: Sha256HexSchema,
      pullRequestNumber: z.number().int().min(1),
      pullRequestUrl: z.url(),
      redacted: z.literal(true),
      repositoryRef: z.string().min(1),
      status: z.literal("opened"),
    }),
    z.object({
      blocker: CapabilityBlockerSchema,
      status: z.literal("blocked"),
    }),
  ]
);

export const GitHubBranchCommitDeliveryResultSchema = z.discriminatedUnion(
  "status",
  [
    z.object({
      baseBranch: z.string().min(1),
      branchUrl: z.url().optional(),
      dryRun: z.literal(true),
      fileCount: z.number().int().min(1),
      headBranch: z.string().min(1),
      payloadHash: Sha256HexSchema,
      redacted: z.literal(true),
      repositoryRef: z.string().min(1),
      status: z.literal("dry-run"),
    }),
    z.object({
      baseBranch: z.string().min(1),
      commitSha: z.string().min(7),
      commitUrl: z.url().optional(),
      committedAt: IsoDateTimeSchema,
      dryRun: z.literal(false),
      fileCount: z.number().int().min(1),
      headBranch: z.string().min(1),
      payloadHash: Sha256HexSchema,
      redacted: z.literal(true),
      repositoryRef: z.string().min(1),
      status: z.literal("committed"),
    }),
    z.object({
      blocker: CapabilityBlockerSchema,
      status: z.literal("blocked"),
    }),
  ]
);

export const LinearCommentDeliveryResultSchema = z.discriminatedUnion(
  "status",
  [
    z.object({
      commentUrl: z.url().optional(),
      dryRun: z.literal(true),
      issueRef: z.string().min(1),
      payloadHash: Sha256HexSchema,
      redacted: z.literal(true),
      status: z.literal("dry-run"),
    }),
    z.object({
      commentId: z.string().min(1),
      commentUrl: z.url(),
      commentedAt: IsoDateTimeSchema,
      dryRun: z.literal(false),
      issueRef: z.string().min(1),
      payloadHash: Sha256HexSchema,
      redacted: z.literal(true),
      status: z.literal("commented"),
    }),
    z.object({
      blocker: CapabilityBlockerSchema,
      status: z.literal("blocked"),
    }),
  ]
);

const CapabilityLeaseReceiptBaseSchema = z.object({
  channelRef: z.string().min(1),
  dryRun: z.boolean(),
  leaseId: z.string().min(1),
  payloadHash: Sha256HexSchema,
  payloadRef: ArtifactRefSchema,
  policyId: z.string().min(1),
  receiptRef: ArtifactRefSchema,
  redacted: z.literal(true),
  reviewGate: ReviewGateSchema,
  runId: z.string().min(1),
  secretRef: z.string().min(1),
  traceContext: WorkflowTraceContextSchema,
});

export const DiscordCapabilityLeaseReceiptSchema =
  CapabilityLeaseReceiptBaseSchema.extend({
    capability: z.literal("discord.message.send"),
    delivery: DiscordDeliveryResultSchema,
    resource: DiscordResourceSchema,
  });

export const WzrrdCapabilityLeaseReceiptSchema =
  CapabilityLeaseReceiptBaseSchema.extend({
    capability: z.literal("wzrrd.site.publish"),
    channelRef: z.string().min(1).optional(),
    delivery: WzrrdPublishDeliveryResultSchema,
    resource: WzrrdResourceSchema,
  });

export const GitHubCapabilityLeaseReceiptSchema =
  CapabilityLeaseReceiptBaseSchema.extend({
    capability: z.literal("github.pull-request.create"),
    channelRef: z.string().min(1).optional(),
    delivery: GitHubPullRequestDeliveryResultSchema,
    resource: GitHubRepositoryResourceSchema,
  });

export const GitHubBranchCommitCapabilityLeaseReceiptSchema =
  CapabilityLeaseReceiptBaseSchema.extend({
    capability: z.literal("github.branch.commit"),
    channelRef: z.string().min(1).optional(),
    delivery: GitHubBranchCommitDeliveryResultSchema,
    resource: GitHubRepositoryResourceSchema,
  });

export const LinearCommentCapabilityLeaseReceiptSchema =
  CapabilityLeaseReceiptBaseSchema.extend({
    capability: z.literal("linear.comment.create"),
    channelRef: z.string().min(1).optional(),
    delivery: LinearCommentDeliveryResultSchema,
    resource: LinearIssueResourceSchema,
  });

export const CapabilityLeaseReceiptSchema = z.discriminatedUnion("capability", [
  DiscordCapabilityLeaseReceiptSchema,
  GitHubBranchCommitCapabilityLeaseReceiptSchema,
  GitHubCapabilityLeaseReceiptSchema,
  LinearCommentCapabilityLeaseReceiptSchema,
  WzrrdCapabilityLeaseReceiptSchema,
]);

export const SafetyEnvelopeStateSchema = z.enum([
  "received",
  "resolvingCapsule",
  "discoveringPackageMetadata",
  "checkingEntitlements",
  "pinningPackages",
  "planningDynamicWorkflow",
  "pinningPlanArtifact",
  "loadingPinnedDynamicWorkflow",
  "executingDynamicWorkflow",
  "verifyingDynamicWorkflow",
  "requestingCapabilityLease",
  "executingCapability",
  "recordingReceipts",
  "summarizingReview",
  "requestingReviewSurfaceDeliveryLease",
  "executingReviewSurfaceDelivery",
  "captured",
  "blocked",
]);

export const WorkflowEventSchema = z.object({
  at: IsoDateTimeSchema,
  refs: z.record(z.string(), z.string()).default({}),
  state: SafetyEnvelopeStateSchema,
  summary: z.string().min(1),
});

export const WorkflowStatusProjectionSchema = z.object({
  actorId: z.string().min(1),
  capsuleId: z.string().min(1),
  currentState: SafetyEnvelopeStateSchema,
  eventCount: z.number().int().min(1),
  lastEvent: WorkflowEventSchema,
  planArtifact: PlanArtifactSchema.optional(),
  redacted: z.literal(true),
  runId: z.string().min(1),
  schemaVersion: z.literal("workflow.status-projection.v1"),
  updatedAt: IsoDateTimeSchema,
  workItemId: z.string().min(1),
});

export const WorkflowEventStreamEntrySchema = z.object({
  event: WorkflowEventSchema,
  eventIndex: z.number().int().min(1),
});

export const WorkflowEventStreamDocumentSchema = z.object({
  eventCount: z.number().int().min(0),
  events: z.array(WorkflowEventStreamEntrySchema),
  generatedAt: IsoDateTimeSchema,
  latestStatus: SafetyEnvelopeStateSchema.optional(),
  redacted: z.literal(true),
  runId: z.string().min(1),
  schemaVersion: z.literal("workflow.event-stream.v1"),
  sink: z.object({
    description: z.string().min(1),
    kind: z.literal("cloudflare-d1-workflow-events"),
    runId: z.string().min(1),
    table: z.literal("workflow_events"),
  }),
  workItemId: z.string().min(1),
});

export const WorkflowDebuggerAttachTransportSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({
      description: z.string().min(1),
      kind: z.literal("event-stream-json"),
      method: z.literal("GET"),
      url: z.url(),
    }),
    z.object({
      description: z.string().min(1),
      kind: z.literal("event-stream-sse"),
      method: z.literal("GET"),
      url: z.url(),
    }),
    z.object({
      description: z.string().min(1),
      kind: z.literal("event-stream-live-tail"),
      method: z.literal("GET"),
      url: z.url(),
    }),
    z.object({
      description: z.string().min(1),
      kind: z.literal("event-stream-websocket"),
      protocol: z.literal("websocket"),
      url: z.url(),
    }),
  ]
);

export const WorkflowDebuggerAttachDocumentSchema = z.object({
  afterEventIndex: z.number().int().min(0),
  attachPolicy: z.object({
    redaction: z.literal("redacted-events-only"),
    secretMaterial: z.literal("not-exposed"),
    sideEffects: z.literal("read-only"),
  }),
  eventCount: z.number().int().min(0),
  generatedAt: IsoDateTimeSchema,
  latestEventIndex: z.number().int().min(0),
  latestStatus: SafetyEnvelopeStateSchema.optional(),
  mode: z.literal("event-observer"),
  redacted: z.literal(true),
  runId: z.string().min(1),
  schemaVersion: z.literal("workflow.debugger-attach.v1"),
  source: z.object({
    eventStreamSchemaVersion: z.literal("workflow.event-stream.v1"),
    sink: z.object({
      description: z.string().min(1),
      kind: z.literal("cloudflare-d1-workflow-events"),
      runId: z.string().min(1),
      table: z.literal("workflow_events"),
    }),
  }),
  transports: z.array(WorkflowDebuggerAttachTransportSchema).min(1),
  workItemId: z.string().min(1),
});

export const WorkflowEventTailCloseReasonSchema = z.enum([
  "max-polls",
  "reader-error",
  "run-not-found",
  "terminal-state",
]);

export const WorkflowEventTailControlDocumentSchema = z.object({
  at: IsoDateTimeSchema,
  eventCount: z.number().int().min(0),
  lastEventIndex: z.number().int().min(0),
  latestStatus: SafetyEnvelopeStateSchema.optional(),
  reason: WorkflowEventTailCloseReasonSchema,
  redacted: z.literal(true),
  runId: z.string().min(1),
  schemaVersion: z.literal("workflow.event-tail-control.v1"),
  status: z.literal("closed"),
  stream: z.object({
    kind: z.literal("cloudflare-d1-workflow-events-live-tail"),
    maxPolls: z.number().int().min(1),
    pollDelayMs: z.number().int().min(0),
  }),
  workItemId: z.string().min(1),
});

export const WorkflowStructuredLogValueSchema = z.union([
  z.boolean(),
  z.number(),
  z.string(),
  z.null(),
]);

export const WorkflowStructuredLogRecordSchema = z.object({
  at: IsoDateTimeSchema,
  eventName: z.string().min(1),
  fields: z.record(z.string().min(1), WorkflowStructuredLogValueSchema),
  schemaVersion: z.literal("workflow.structured-log.v1"),
  severity: z.enum(["debug", "info", "warn", "error"]),
});

export const WorkflowTelemetrySinkKindSchema = z.enum([
  "artifact-jsonl",
  "cloudflare-analytics-engine",
  "cloudflare-d1-structured-logs",
  "external-http-structured-logs",
]);

export const WorkflowExternalTelemetryLogRecordSchema = z.object({
  at: IsoDateTimeSchema,
  eventName: z.string().min(1),
  fields: z.record(z.string().min(1), WorkflowStructuredLogValueSchema),
  redacted: z.literal(true),
  schemaVersion: z.literal("workflow.external-telemetry-log.v1"),
  severity: z.enum(["debug", "info", "warn", "error"]),
});

export const WorkflowExternalTelemetryBatchSchema = z.object({
  generatedAt: IsoDateTimeSchema,
  logCount: z.number().int().min(0),
  logs: z.array(WorkflowExternalTelemetryLogRecordSchema),
  redacted: z.literal(true),
  runId: z.string().min(1),
  schemaVersion: z.literal("workflow.external-telemetry-batch.v1"),
  workItemId: z.string().min(1),
});

export const WorkflowTelemetrySinkReceiptSchema = z.object({
  artifactRef: ArtifactRefSchema.optional(),
  capturedAt: IsoDateTimeSchema,
  logCount: z.number().int().min(0),
  redacted: z.literal(true),
  runId: z.string().min(1),
  schemaVersion: z.literal("workflow.telemetry-sink-receipt.v1"),
  sink: z.object({
    dataset: z.string().min(1).optional(),
    description: z.string().min(1),
    endpointHash: Sha256HexSchema.optional(),
    kind: WorkflowTelemetrySinkKindSchema,
    method: z.literal("POST").optional(),
    path: z.string().min(1).optional(),
    table: z.string().min(1).optional(),
  }),
  status: z.enum(["captured", "blocked"]),
});

export const WorkflowObservabilityPackSchema = z.object({
  artifactRefs: z.array(ArtifactRefSchema),
  generatedAt: IsoDateTimeSchema,
  highCardinalityFields: z.array(ReviewSurfaceStructuredLogFieldSchema).min(1),
  laneReceipts: z.object({
    planner: AgentLaneReceiptSchema,
    workers: z.array(AgentLaneReceiptSchema),
  }),
  logs: z.array(WorkflowStructuredLogRecordSchema).min(1),
  metrics: z.object({
    artifactRefCount: z.number().int().min(0),
    capabilityReceiptCount: z.number().int().min(0),
    eventCount: z.number().int().min(0),
    sandboxAccountingStatus: z.enum(["captured", "not-yet-instrumented"]),
    sandboxCommandDurationMs: z.number().nonnegative().nullable(),
    sandboxDestroyedLaneCount: z.number().int().min(0),
    structuredLogSinkStatus: z
      .enum(["captured", "not-configured", "blocked"])
      .default("not-configured"),
    tokenCostAccountingStatus: z.enum([
      "captured",
      "partial",
      "not-yet-instrumented",
    ]),
    tokenCostEstimate: z.number().nonnegative().nullable(),
    tokenCount: z.number().int().min(0).nullable(),
    tracePropagationStatus: z.enum([
      "captured",
      "partial",
      "not-yet-instrumented",
    ]),
    traceSpanCount: z.number().int().min(0),
    workerLaneCount: z.number().int().min(0),
  }),
  redacted: z.literal(true),
  requiredSignals: z.array(ReviewSurfaceObservabilitySignalSchema).min(1),
  runId: z.string().min(1),
  schemaVersion: z.literal("workflow.observability-pack.v1"),
  statusProjection: z.object({
    history: z.array(WorkflowStatusProjectionSchema).min(1),
    latest: WorkflowStatusProjectionSchema,
    sink: z.object({
      description: z.string().min(1),
      kind: z.literal("cloudflare-d1-runs"),
      runId: z.string().min(1),
      table: z.literal("runs"),
    }),
  }),
  summary: z.string().min(1),
  telemetrySinks: z.array(WorkflowTelemetrySinkReceiptSchema).default([]),
  workItemId: z.string().min(1),
});

export const ReviewSurfaceDocumentSchema = z.object({
  artifactRefs: z.array(ArtifactRefSchema),
  capabilityReceipts: z.array(CapabilityLeaseReceiptSchema).default([]),
  definitionOfDone: ReviewSurfaceDefinitionOfDoneSchema,
  eventLog: z.array(WorkflowEventSchema),
  generatedArtifacts: z.object({
    executionProof: WorkflowExecutionProofArtifactSchema,
    harness: GeneratedHarnessArtifactSchema,
    machine: DynamicWorkflowMachineArtifactSchema,
    verificationContract: VerificationContractArtifactSchema,
    verificationResult: VerificationResultArtifactSchema.optional(),
  }),
  generatedAt: IsoDateTimeSchema,
  laneReceipts: z.object({
    planner: AgentLaneReceiptSchema,
    verifier: AgentLaneReceiptSchema.optional(),
    workers: z.array(AgentLaneReceiptSchema),
  }),
  outputTarget: OutputTargetSchema,
  packages: z.array(
    z.object({
      artifactRef: ArtifactRefSchema,
      manifestHash: Sha256HexSchema,
      packageId: z.string().min(1),
      title: z.string().min(1),
      version: z.string().min(1),
    })
  ),
  plan: z.object({
    artifactRef: ArtifactRefSchema,
    hash: Sha256HexSchema,
    planId: z.string().min(1),
  }),
  redacted: z.literal(true),
  redactedArtifactRefs: z.array(ArtifactRefSchema),
  reviewSummaryRef: ArtifactRefSchema,
  runId: z.string().min(1),
  schemaVersion: z.literal("workflow.review-surface.v1"),
  surfaceId: z.string().min(1),
  workItemId: z.string().min(1),
});

export const ReviewSummaryDocumentSchema = z.object({
  capabilityCount: z.number().int().min(0),
  capabilityReceiptRefs: z.array(ArtifactRefSchema),
  eventCount: z.number().int().min(0),
  eventLog: z.array(WorkflowEventSchema),
  finalStateBeforeCapture: SafetyEnvelopeStateSchema,
  generatedAt: IsoDateTimeSchema,
  redacted: z.literal(true),
  reviewId: z.string().min(1),
  runId: z.string().min(1),
  schemaVersion: z.literal("workflow.review-summary.v1"),
  status: z.literal("summary-captured"),
  stepArtifactRefs: z.array(ArtifactRefSchema),
});

export const SafetyEnvelopeCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("START") }),
  z.object({ type: z.literal("CAPSULE_RESOLVED") }),
  z.object({ type: z.literal("PACKAGE_METADATA_DISCOVERED") }),
  z.object({ type: z.literal("ENTITLEMENTS_ACCEPTED") }),
  z.object({ type: z.literal("PACKAGES_PINNED") }),
  z.object({ type: z.literal("DYNAMIC_WORKFLOW_PLANNED") }),
  z.object({ type: z.literal("PLAN_PINNED") }),
  z.object({ type: z.literal("PINNED_DYNAMIC_WORKFLOW_LOADED") }),
  z.object({ type: z.literal("CAPABILITY_LEASE_REQUESTED") }),
  z.object({ type: z.literal("DYNAMIC_STEP_EXECUTED") }),
  z.object({ type: z.literal("DYNAMIC_WORKFLOW_COMPLETED") }),
  z.object({ type: z.literal("DYNAMIC_WORKFLOW_VERIFIED") }),
  z.object({ type: z.literal("VERIFICATION_BYPASSED") }),
  z.object({ type: z.literal("LEASE_ISSUED") }),
  z.object({ type: z.literal("CAPABILITY_EXECUTED") }),
  z.object({ type: z.literal("RECEIPTS_RECORDED") }),
  z.object({ type: z.literal("REVIEW_SUMMARIZED") }),
  z.object({
    blocker: CapabilityBlockerSchema,
    type: z.literal("BLOCK"),
  }),
]);

export const ContextCapsuleRecordSchema = z.object({
  capsuleId: z.string().min(1),
  createdAt: IsoDateTimeSchema,
  latestRunId: z.string().min(1).optional(),
  pinnedPackageRefs: z.array(ArtifactRefSchema).default([]),
  workItemId: z.string().min(1),
});

export const WorkflowRunRequestSchema = z.object({
  actor: ActorSchema,
  planProposal: PlanProposalSchema,
  runId: z.string().min(1),
  workItemId: z.string().min(1),
});

export const DreamLiveRunRequestReceiptSchema = z.object({
  blockedReasons: z.array(z.string().min(1)).default([]),
  checkedAt: IsoDateTimeSchema,
  preflight: z.object({
    generatedAt: IsoDateTimeSchema.optional(),
    path: z.string().min(1),
    refreshed: z.boolean().default(false),
    requiredActions: z.array(z.string().min(1)).default([]),
    status: z.enum(["blocked", "invalid", "missing", "ready"]),
  }),
  redacted: z.literal(true),
  relayCapability: WorkflowLivePreflightRelayCapabilitySchema.optional(),
  request: WorkflowRunRequestSchema,
  requestPath: z.string().min(1),
  responsePath: z.string().min(1).optional(),
  runId: z.string().min(1),
  schemaVersion: z.literal("workflow.dream-live-run-request.v1"),
  status: z.enum(["blocked", "failed", "prepared", "submitted"]),
  submit: z.object({
    attempted: z.boolean(),
    statusCode: z.number().int().min(100).max(599).optional(),
    url: z.url().optional(),
  }),
  workerUrl: z.url(),
});

export const WorkflowFrontDoorRequestSchema = z.object({
  body: WorkflowRunRequestSchema,
  method: z.literal("POST"),
  route: z.literal("/runs"),
});

export const WorkflowRunReceiptSchema = z.object({
  artifactRefs: z.array(ArtifactRefSchema),
  capabilityReceipts: z.array(CapabilityLeaseReceiptSchema).default([]),
  capsule: ContextCapsuleRecordSchema,
  eventLog: z.array(WorkflowEventSchema),
  executionProofArtifact: WorkflowExecutionProofArtifactSchema,
  harnessArtifact: GeneratedHarnessArtifactSchema,
  machineArtifact: DynamicWorkflowMachineArtifactSchema,
  planArtifact: PlanArtifactSchema,
  plannerLaneReceipt: AgentLaneReceiptSchema,
  reviewSummaryRef: ArtifactRefSchema,
  reviewSurfaceArtifact: ReviewSurfaceArtifactSchema,
  runId: z.string().min(1),
  status: z.literal("captured"),
  verificationContractArtifact: VerificationContractArtifactSchema,
  verificationResultArtifact: VerificationResultArtifactSchema.optional(),
  verifierLaneReceipt: AgentLaneReceiptSchema.optional(),
  workerLaneReceipts: z.array(AgentLaneReceiptSchema).default([]),
});

export const WorkflowRunBlockedSchema = z.object({
  blocker: CapabilityBlockerSchema,
  eventLog: z.array(WorkflowEventSchema),
  runId: z.string().min(1),
  status: z.literal("blocked"),
});

export const WorkflowRunResultSchema = z.discriminatedUnion("status", [
  WorkflowRunReceiptSchema,
  WorkflowRunBlockedSchema,
]);

export type Actor = z.infer<typeof ActorSchema>;
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;
export type ArtifactPin = z.infer<typeof ArtifactPinSchema>;
export type ArtifactWriteReceipt = z.infer<typeof ArtifactWriteReceiptSchema>;
export type CapabilityBlocker = z.infer<typeof CapabilityBlockerSchema>;
export type CapabilityDenialCode = z.infer<typeof CapabilityDenialCodeSchema>;
export type CapabilityLease = z.infer<typeof CapabilityLeaseSchema>;
export type CapabilityLeaseDecision = z.infer<
  typeof CapabilityLeaseDecisionSchema
>;
export type CapabilityLeaseReceipt = z.infer<
  typeof CapabilityLeaseReceiptSchema
>;
export type CapabilityLeaseRequest = z.infer<
  typeof CapabilityLeaseRequestSchema
>;
export type CapabilityResource = z.infer<typeof CapabilityResourceSchema>;
export type ContextCapsuleRecord = z.infer<typeof ContextCapsuleRecordSchema>;
export type DiscordDeliveryResult = z.infer<typeof DiscordDeliveryResultSchema>;
export type DiscordMessageApproval = z.infer<
  typeof DiscordMessageApprovalSchema
>;
export type DiscordMessagePayload = z.infer<typeof DiscordMessagePayloadSchema>;
export type DiscordResource = z.infer<typeof DiscordResourceSchema>;
export type DynamicWorkflowPlanDocument = z.infer<
  typeof DynamicWorkflowPlanDocumentSchema
>;
export type DynamicWorkflowBlueprint = z.infer<
  typeof DynamicWorkflowBlueprintSchema
>;
export type DynamicWorkflowMachineArtifact = z.infer<
  typeof DynamicWorkflowMachineArtifactSchema
>;
export type DynamicWorkflowMachineDocument = z.infer<
  typeof DynamicWorkflowMachineDocumentSchema
>;
export type DynamicWorkflowStep = z.infer<typeof DynamicWorkflowStepSchema>;
export type GeneratedHarnessArtifact = z.infer<
  typeof GeneratedHarnessArtifactSchema
>;
export type GeneratedHarnessDocument = z.infer<
  typeof GeneratedHarnessDocumentSchema
>;
export type GeneratedTextArtifactDraft = z.infer<
  typeof GeneratedTextArtifactDraftSchema
>;
export type GitHubPullRequestApproval = z.infer<
  typeof GitHubPullRequestApprovalSchema
>;
export type GitHubBranchCommitApproval = z.infer<
  typeof GitHubBranchCommitApprovalSchema
>;
export type GitHubBranchCommitDeliveryResult = z.infer<
  typeof GitHubBranchCommitDeliveryResultSchema
>;
export type GitHubBranchCommitPayload = z.infer<
  typeof GitHubBranchCommitPayloadSchema
>;
export type GitHubPullRequestDeliveryResult = z.infer<
  typeof GitHubPullRequestDeliveryResultSchema
>;
export type GitHubPullRequestPayload = z.infer<
  typeof GitHubPullRequestPayloadSchema
>;
export type GitHubRepositoryResource = z.infer<
  typeof GitHubRepositoryResourceSchema
>;
export type LinearCommentApproval = z.infer<typeof LinearCommentApprovalSchema>;
export type LinearCommentDeliveryResult = z.infer<
  typeof LinearCommentDeliveryResultSchema
>;
export type LinearCommentPayload = z.infer<typeof LinearCommentPayloadSchema>;
export type LinearIssueResource = z.infer<typeof LinearIssueResourceSchema>;
export type OutputTarget = z.infer<typeof OutputTargetSchema>;
export type PackageEntitlement = z.infer<typeof PackageEntitlementSchema>;
export type PackageExport = z.infer<typeof PackageExportSchema>;
export type PackageMetadata = z.infer<typeof PackageMetadataSchema>;
export type PinnedPackage = z.infer<typeof PinnedPackageSchema>;
export type WorkflowCartridgeInvocationProofDocument = z.infer<
  typeof WorkflowCartridgeInvocationProofDocumentSchema
>;
export type WorkflowCartridgeManifest = z.infer<
  typeof WorkflowCartridgeManifestSchema
>;
export type WorkflowCartridgeNodeExport = z.infer<
  typeof WorkflowCartridgeNodeExportSchema
>;
export type WorkflowCartridgeTrustPolicy = z.infer<
  typeof WorkflowCartridgeTrustPolicySchema
>;
export type WorkflowLivePreflightArtifactModel = z.infer<
  typeof WorkflowLivePreflightArtifactModelSchema
>;
export type WorkflowLivePreflightCheck = z.infer<
  typeof WorkflowLivePreflightCheckSchema
>;
export type WorkflowLivePreflightRelayCapability = z.infer<
  typeof WorkflowLivePreflightRelayCapabilitySchema
>;
export type WorkflowLivePreflightReceipt = z.infer<
  typeof WorkflowLivePreflightReceiptSchema
>;
export type WorkflowLivePreflightRemotePackageRow = z.infer<
  typeof WorkflowLivePreflightRemotePackageRowSchema
>;
export type WorkflowLivePreflightRemoteRegistry = z.infer<
  typeof WorkflowLivePreflightRemoteRegistrySchema
>;
export type WorkflowLivePreflightRemoteSecretInventory = z.infer<
  typeof WorkflowLivePreflightRemoteSecretInventorySchema
>;
export type DreamLiveRunRequestReceipt = z.infer<
  typeof DreamLiveRunRequestReceiptSchema
>;
export type AgentAuthLease = z.infer<typeof AgentAuthLeaseSchema>;
export type WorkflowTraceContext = z.infer<typeof WorkflowTraceContextSchema>;
export type AgentLaneEvidenceDraft = z.infer<
  typeof AgentLaneEvidenceDraftSchema
>;
export type AgentLaneAdmissionDecision = z.infer<
  typeof AgentLaneAdmissionDecisionSchema
>;
export type AgentLaneAdmissionRequest = z.infer<
  typeof AgentLaneAdmissionRequestSchema
>;
export type AgentLaneKind = z.infer<typeof AgentLaneKindSchema>;
export type AgentLanePackageMountEvidence = z.infer<
  typeof AgentLanePackageMountEvidenceSchema
>;
export type AgentLanePackageMount = z.infer<typeof AgentLanePackageMountSchema>;
export type AgentLanePackageMountIndex = z.infer<
  typeof AgentLanePackageMountIndexSchema
>;
export type AgentLaneSandboxAccounting = z.infer<
  typeof AgentLaneSandboxAccountingSchema
>;
export type AgentLaneReleaseReceipt = z.infer<
  typeof AgentLaneReleaseReceiptSchema
>;
export type AgentLaneReleaseRequest = z.infer<
  typeof AgentLaneReleaseRequestSchema
>;
export type AgentLaneReleaseStatus = z.infer<
  typeof AgentLaneReleaseStatusSchema
>;
export type AgentLaneReceipt = z.infer<typeof AgentLaneReceiptSchema>;
export type AgentLaneRuntime = z.infer<typeof AgentLaneRuntimeSchema>;
export type AgentLaneTokenCostAccounting = z.infer<
  typeof AgentLaneTokenCostAccountingSchema
>;
export type PlanArtifact = z.infer<typeof PlanArtifactSchema>;
export type PlannerLaneBlueprintDocument = z.infer<
  typeof PlannerLaneBlueprintDocumentSchema
>;
export type PlanProposal = z.infer<typeof PlanProposalSchema>;
export type ReviewGate = z.infer<typeof ReviewGateSchema>;
export type ResearchReviewOutputDocument = z.infer<
  typeof ResearchReviewOutputDocumentSchema
>;
export type ReviewSummaryDocument = z.infer<typeof ReviewSummaryDocumentSchema>;
export type ReviewSurfaceAcceptanceRef = z.infer<
  typeof ReviewSurfaceAcceptanceRefSchema
>;
export type ReviewSurfaceArtifact = z.infer<typeof ReviewSurfaceArtifactSchema>;
export type ReviewSurfaceDefinitionOfDone = z.infer<
  typeof ReviewSurfaceDefinitionOfDoneSchema
>;
export type ReviewSurfaceDocument = z.infer<typeof ReviewSurfaceDocumentSchema>;
export type ReviewSurfaceObservabilitySignal = z.infer<
  typeof ReviewSurfaceObservabilitySignalSchema
>;
export type ReviewSurfaceObservabilityRequirement = z.infer<
  typeof ReviewSurfaceObservabilityRequirementSchema
>;
export type ReviewSurfaceProposalReconciliation = z.infer<
  typeof ReviewSurfaceProposalReconciliationSchema
>;
export type ReviewSurfaceProposalReconciliationRequirement = z.infer<
  typeof ReviewSurfaceProposalReconciliationRequirementSchema
>;
export type ReviewSurfaceProposalRequirementId = z.infer<
  typeof ReviewSurfaceProposalRequirementIdSchema
>;
export type ReviewSurfaceStructuredLogField = z.infer<
  typeof ReviewSurfaceStructuredLogFieldSchema
>;
export type ReviewSurfaceWorkflowChainCompletion = z.infer<
  typeof ReviewSurfaceWorkflowChainCompletionSchema
>;
export type ReviewSurfaceWorkflowChainRequirement = z.infer<
  typeof ReviewSurfaceWorkflowChainRequirementSchema
>;
export type ReviewSurfaceWorkflowChainRequirementId = z.infer<
  typeof ReviewSurfaceWorkflowChainRequirementIdSchema
>;
export type SafetyEnvelopeCommand = z.infer<typeof SafetyEnvelopeCommandSchema>;
export type SafetyEnvelopeState = z.infer<typeof SafetyEnvelopeStateSchema>;
export type VerificationContractArtifact = z.infer<
  typeof VerificationContractArtifactSchema
>;
export type VerificationContractDocument = z.infer<
  typeof VerificationContractDocumentSchema
>;
export type VerificationResultArtifact = z.infer<
  typeof VerificationResultArtifactSchema
>;
export type VerificationResultDocument = z.infer<
  typeof VerificationResultDocumentSchema
>;
export type WorkflowExecutionProofArtifact = z.infer<
  typeof WorkflowExecutionProofArtifactSchema
>;
export type WorkflowExecutionProofDocument = z.infer<
  typeof WorkflowExecutionProofDocumentSchema
>;
export type WorkflowSideEffectDeclaration = z.infer<
  typeof WorkflowSideEffectDeclarationSchema
>;
export type WorkflowEvent = z.infer<typeof WorkflowEventSchema>;
export type WorkflowEventStreamDocument = z.infer<
  typeof WorkflowEventStreamDocumentSchema
>;
export type WorkflowEventStreamEntry = z.infer<
  typeof WorkflowEventStreamEntrySchema
>;
export type WorkflowExternalTelemetryBatch = z.infer<
  typeof WorkflowExternalTelemetryBatchSchema
>;
export type WorkflowExternalTelemetryLogRecord = z.infer<
  typeof WorkflowExternalTelemetryLogRecordSchema
>;
export type WorkflowDebuggerAttachDocument = z.infer<
  typeof WorkflowDebuggerAttachDocumentSchema
>;
export type WorkflowDebuggerAttachTransport = z.infer<
  typeof WorkflowDebuggerAttachTransportSchema
>;
export type WorkflowEventTailControlDocument = z.infer<
  typeof WorkflowEventTailControlDocumentSchema
>;
export type WorkflowObservabilityPack = z.infer<
  typeof WorkflowObservabilityPackSchema
>;
export type WorkflowTelemetrySinkKind = z.infer<
  typeof WorkflowTelemetrySinkKindSchema
>;
export type WorkflowTelemetrySinkReceipt = z.infer<
  typeof WorkflowTelemetrySinkReceiptSchema
>;
export type WorkflowStatusProjection = z.infer<
  typeof WorkflowStatusProjectionSchema
>;
export type WorkflowStructuredLogRecord = z.infer<
  typeof WorkflowStructuredLogRecordSchema
>;
export type WzrrdPublishDeliveryResult = z.infer<
  typeof WzrrdPublishDeliveryResultSchema
>;
export type WzrrdPublishApproval = z.infer<typeof WzrrdPublishApprovalSchema>;
export type WzrrdPublishPayload = z.infer<typeof WzrrdPublishPayloadSchema>;
export type WzrrdResource = z.infer<typeof WzrrdResourceSchema>;
export type WorkflowRunBlocked = z.infer<typeof WorkflowRunBlockedSchema>;
export type WorkflowRunReceipt = z.infer<typeof WorkflowRunReceiptSchema>;
export type WorkflowRunRequest = z.infer<typeof WorkflowRunRequestSchema>;
export type WorkflowRunResult = z.infer<typeof WorkflowRunResultSchema>;
