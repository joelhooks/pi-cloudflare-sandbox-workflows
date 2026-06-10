/* eslint-disable sort-keys */

import { z } from "zod";

export const IsoDateSchema = z.string().datetime();

export const DreamRunStatusSchema = z.enum([
  "queued",
  "exploring",
  "review_ready",
  "applying",
  "captured",
  "failed",
]);
export type DreamRunStatus = z.infer<typeof DreamRunStatusSchema>;

export const DreamPhaseSchema = z.object({
  intent: z.string().min(1),
  phaseId: z.string().min(1),
  stochastic: z.literal(true),
});
export type DreamPhase = z.infer<typeof DreamPhaseSchema>;

export const DreamScopeSchema = z.enum([
  "system",
  "project",
  "capability",
  "mixed",
]);
export type DreamScope = z.infer<typeof DreamScopeSchema>;

export const GraphNodeKindSchema = z.enum([
  "prompt",
  "skill",
  "script",
  "access",
  "capability",
  "memory",
  "workflow",
  "host",
  "artifact",
  "component",
  "deployment",
  "receipt",
]);
export type GraphNodeKind = z.infer<typeof GraphNodeKindSchema>;

export const GraphEdgeKindSchema = z.enum([
  "uses",
  "reads",
  "requires",
  "runs",
  "versions",
  "deploys_to",
  "observes",
  "supports",
  "proposes_patch",
  "proves",
  "materializes",
]);
export type GraphEdgeKind = z.infer<typeof GraphEdgeKindSchema>;

export const HostIdSchema = z.enum([
  "blaine",
  "panda",
  "flagg",
  "cloudflare-workflows",
]);
export type HostId = z.infer<typeof HostIdSchema>;

export const ReceiptSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["file", "doc", "session", "typesense", "manual", "command"]),
  label: z.string().min(1),
  locator: z.string().min(1),
  machine: z.string().optional(),
  note: z.string().optional(),
  sha256: z.string().optional(),
});
export type Receipt = z.infer<typeof ReceiptSchema>;

export const CrawlPlanSchema = z.object({
  focus: z.string().min(1),
  horizons: z.array(z.enum(["near_term", "long_term"])),
  machineFacetPlan: z.object({
    discoverMachinesFromTypesense: z.boolean(),
    knownMachines: z.array(z.string().min(1)),
    queryOncePerMachine: z.boolean(),
  }),
  queries: z.array(z.string().min(1)),
  schemaVersion: z.literal("shitrat-dream.crawl-plan.v0"),
});
export type CrawlPlan = z.infer<typeof CrawlPlanSchema>;

export const CandidateCoreMemorySchema = z.object({
  affectedGraphNodes: z.array(z.string().min(1)),
  candidateId: z.string().min(1),
  claim: z.string().min(1),
  confidence: z.number().min(0).max(1),
  requiredReceipts: z.array(z.string().min(1)),
  scope: DreamScopeSchema,
  status: z.enum(["candidate", "accepted", "discarded", "needs_more_evidence"]),
});
export type CandidateCoreMemory = z.infer<typeof CandidateCoreMemorySchema>;

export const FlowRatificationSchema = z.object({
  decision: z.enum(["ratified", "rejected", "needs_more_evidence"]),
  flowId: z.string().min(1),
  reason: z.string().min(1),
  receiptIds: z.array(z.string().min(1)),
});
export type FlowRatification = z.infer<typeof FlowRatificationSchema>;

export const GraphNodeSchema = z.object({
  id: z.string().min(1),
  kind: GraphNodeKindSchema,
  label: z.string().min(1),
  scope: DreamScopeSchema.optional(),
  summary: z.string().min(1).optional(),
});
export type GraphNode = z.infer<typeof GraphNodeSchema>;

export const GraphEdgeSchema = z.object({
  from: z.string().min(1),
  receiptIds: z.array(z.string().min(1)).default([]),
  to: z.string().min(1),
  type: GraphEdgeKindSchema,
});
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

export const ComponentPackSchema = z.object({
  componentId: z.string().min(1),
  kind: z.enum([
    "system_prompt_pack",
    "skills_pack",
    "scripts_pack",
    "access_pack",
    "capabilities_pack",
    "memory_pack",
    "workflow_patterns_pack",
    "runner_config_pack",
  ]),
  source: z.string().min(1),
  version: z.string().min(1),
});
export type ComponentPack = z.infer<typeof ComponentPackSchema>;

export const AccessRefSchema = z.object({
  accessId: z.string().min(1),
  capabilityLeasePolicy: z.string().min(1),
  exposesPlaintextToSandbox: z.literal(false),
  secretRef: z.string().min(1),
});
export type AccessRef = z.infer<typeof AccessRefSchema>;

export const CapabilitySchema = z.object({
  accessRefs: z.array(z.string().min(1)),
  capabilityId: z.string().min(1),
  componentRefs: z.array(z.string().min(1)),
  memoryRefs: z.array(z.string().min(1)),
  summary: z.string().min(1),
});
export type Capability = z.infer<typeof CapabilitySchema>;

export const MemoryPackSchema = z.object({
  memoryId: z.string().min(1),
  source: z.enum([
    "joelclaw_typesense",
    "joelclaw_hydration",
    "cloudflare_artifacts",
    "brain_svx",
  ]),
  storesRawTranscript: z.boolean(),
  summary: z.string().min(1),
});
export type MemoryPack = z.infer<typeof MemoryPackSchema>;

export const DeploymentDesiredStateSchema = z.object({
  appliesMutations: z.boolean(),
  host: HostIdSchema,
  pullBased: z.literal(true),
  responsibilities: z.array(z.string().min(1)),
  smokeChecks: z.array(z.string().min(1)),
});
export type DeploymentDesiredState = z.infer<
  typeof DeploymentDesiredStateSchema
>;

export const WorkflowLaneSchema = z.object({
  laneId: z.string().min(1),
  pattern: z.string().min(1),
  proposedBy: z.enum(["dream", "operator", "fixture"]),
  requiresCapabilityLeases: z.array(z.string().min(1)),
  reviewGate: z.string().min(1),
  stochastic: z.boolean().default(true),
  target: z.string().min(1),
});
export type WorkflowLane = z.infer<typeof WorkflowLaneSchema>;

export const WorkflowPlanSchema = z.object({
  deterministicSafetyEnvelope: z.array(DreamRunStatusSchema),
  lanes: z.array(WorkflowLaneSchema),
  notes: z.array(z.string().min(1)),
  phases: z.array(DreamPhaseSchema),
  runId: z.string().min(1),
  schemaVersion: z.literal("shitrat-dream.workflow-plan.v0"),
  strategy: z.literal(
    "stochastic-dream-surface-with-deterministic-safety-envelope"
  ),
});
export type WorkflowPlan = z.infer<typeof WorkflowPlanSchema>;

export const DreamManifestSchema = z.object({
  artifactRepoPath: z.string().min(1).optional(),
  candidateCount: z.number().int().nonnegative(),
  createdAt: IsoDateSchema,
  focus: z.string().min(1),
  graphNodeCount: z.number().int().nonnegative(),
  runId: z.string().min(1),
  schemaVersion: z.literal("shitrat-dream.manifest.v0"),
  scope: DreamScopeSchema,
  snapshotId: z.string().min(1),
  status: DreamRunStatusSchema,
  workflowLaneCount: z.number().int().nonnegative(),
});
export type DreamManifest = z.infer<typeof DreamManifestSchema>;

export const DreamEventSchema = z.object({
  data: z.record(z.string(), z.unknown()).default({}),
  phaseId: z.string().min(1).optional(),
  runId: z.string().min(1),
  status: DreamRunStatusSchema.optional(),
  ts: IsoDateSchema,
  type: z.string().min(1),
});
export type DreamEvent = z.infer<typeof DreamEventSchema>;

export const DreamLocalReceiptSchema = z.object({
  artifactCommits: z.array(z.string().min(1)),
  artifactRepoPath: z.string().min(1),
  candidateCount: z.number().int().nonnegative(),
  finalState: z.literal("captured"),
  graphNodeCount: z.number().int().nonnegative(),
  runId: z.string().min(1),
  sourceRepoPath: z.string().min(1),
  workflowLaneCount: z.number().int().nonnegative(),
});
export type DreamLocalReceipt = z.infer<typeof DreamLocalReceiptSchema>;
