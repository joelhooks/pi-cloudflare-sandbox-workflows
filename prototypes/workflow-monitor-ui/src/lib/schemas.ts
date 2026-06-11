import { z } from "zod";

/**
 * Local Zod mirrors of the Worker's redacted monitor contracts. These are
 * intentionally a narrow copy of the server-side shapes (kept in
 * `src/app/...` of the parent repo) so the prototype stays self-contained and
 * never drags the Worker's full module graph into the SvelteKit build. Every
 * field here is already redacted by the Worker before it is sent.
 */

const isoDateTime = z.iso.datetime();

/**
 * Safety-envelope states a run can report. `captured` and `blocked` are the two
 * terminal states; everything else is in-flight. Kept as a permissive `string`
 * fallback would hide drift, so this is an exact enum mirror of the Worker.
 */
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

export type SafetyEnvelopeState = z.infer<typeof SafetyEnvelopeStateSchema>;

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
  "plan_node_config_invalid",
]);

export const WorkflowTerminalBlockerSchema = z.object({
  code: CapabilityDenialCodeSchema,
  message: z.string().min(1),
  nodeType: z.string().min(1).optional(),
  redacted: z.literal(true),
  stepId: z.string().min(1).optional(),
});

export type WorkflowTerminalBlocker = z.infer<
  typeof WorkflowTerminalBlockerSchema
>;

/**
 * One run row in `GET /admin/runs`. `createdAt`/`updatedAt` are non-empty
 * strings (ISO or SQLite `CURRENT_TIMESTAMP`) rather than strict ISO datetimes,
 * matching the Worker's relaxed validation of these columns.
 */
export const WorkflowRunsListItemSchema = z.object({
  blocker: WorkflowTerminalBlockerSchema.optional(),
  createdAt: z.string().min(1),
  runId: z.string().min(1),
  status: SafetyEnvelopeStateSchema,
  updatedAt: z.string().min(1),
  workItemId: z.string().min(1),
});

export type WorkflowRunsListItem = z.infer<typeof WorkflowRunsListItemSchema>;

export const WorkflowRunsListDocumentSchema = z.object({
  generatedAt: isoDateTime,
  query: z.object({
    limit: z.number().int().min(1),
    status: SafetyEnvelopeStateSchema.optional(),
  }),
  redacted: z.literal(true),
  runCount: z.number().int().min(0),
  runs: z.array(WorkflowRunsListItemSchema),
  schemaVersion: z.literal("workflow.runs-list.v1"),
});

export type WorkflowRunsListDocument = z.infer<
  typeof WorkflowRunsListDocumentSchema
>;

/**
 * `GET /runs/:runId/status`. `blocker` is present only for a `blocked` terminal
 * run.
 */
export const WorkflowRunStatusDocumentSchema = z.object({
  blocker: WorkflowTerminalBlockerSchema.optional(),
  redacted: z.literal(true),
  runId: z.string().min(1),
  status: SafetyEnvelopeStateSchema,
  terminal: z.boolean(),
});

export type WorkflowRunStatusDocument = z.infer<
  typeof WorkflowRunStatusDocumentSchema
>;

export const WorkflowEventSchema = z.object({
  at: isoDateTime,
  refs: z.record(z.string(), z.string()).default({}),
  state: SafetyEnvelopeStateSchema,
  summary: z.string().min(1),
});

export type WorkflowEvent = z.infer<typeof WorkflowEventSchema>;

export const WorkflowEventStreamEntrySchema = z.object({
  event: WorkflowEventSchema,
  eventIndex: z.number().int().min(1),
});

export type WorkflowEventStreamEntry = z.infer<
  typeof WorkflowEventStreamEntrySchema
>;

/**
 * `GET /runs/:runId/events` (JSON form). The events array is ordered by
 * `eventIndex`; the last entry is the most recent.
 */
export const WorkflowEventStreamDocumentSchema = z.object({
  eventCount: z.number().int().min(0),
  events: z.array(WorkflowEventStreamEntrySchema),
  generatedAt: isoDateTime,
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

export type WorkflowEventStreamDocument = z.infer<
  typeof WorkflowEventStreamDocumentSchema
>;

/** `artifact://…` opaque ref; the Worker never sends raw artifact bodies. */
const artifactRefSchema = z.string().regex(/^artifact:\/\/.+/u);

/**
 * Latest persisted resume checkpoint for a run. Counts + step ids + output
 * artifact refs only — no snapshot bodies cross the boundary.
 */
const checkpointSchema = z.object({
  completedStepCount: z.number().int().min(0),
  completedStepIds: z.array(z.string().min(1)),
  outputArtifactRefCount: z.number().int().min(0),
  outputArtifactRefs: z.array(artifactRefSchema),
  persistedAt: isoDateTime,
  stepIndex: z.number().int().min(0),
});

/**
 * The short-lived `driving:<runId>` marker. `stale` flips true once the marker
 * is older than the driver timeout — the prior driver was evicted and the run
 * is re-drivable. Absent marker => no driver currently parked.
 */
const drivingMarkerSchema = z.object({
  stale: z.boolean(),
  startedAtMs: z.number().int().min(0),
});

/**
 * `GET /runs/:runId/durability`. Lets the operator distinguish a healthy
 * advancing run from a wedged one: a stale driving marker plus an overdue
 * reaper/alarm is the signature of a stuck run. No raw snapshot bodies — only
 * counts, keys, and timestamps.
 */
export const RunDurabilityDumpSchema = z.object({
  activeLaneCount: z.number().int().min(0),
  alarmAtMs: z.number().int().min(0).nullable(),
  checkpoint: checkpointSchema.nullable(),
  drivingMarker: drivingMarkerSchema.nullable(),
  generatedAt: isoDateTime,
  hasRunStartRecord: z.boolean(),
  reaperDueAtMs: z.number().int().min(0).nullable(),
  redacted: z.literal(true),
  runId: z.string().min(1),
  schemaVersion: z.literal("workflow.run-durability.v1"),
  workItemId: z.string().min(1),
});

export type RunDurabilityDump = z.infer<typeof RunDurabilityDumpSchema>;
