import { z } from "zod";

import {
  CapabilityDenialCodeSchema,
  IsoDateTimeSchema,
  SafetyEnvelopeStateSchema,
  WorkflowNodeTypeSchema,
  WorkflowTerminalBlockerSchema,
} from "../domain/schemas.ts";

type D1QueryValue = null | number | string;

export interface D1ResultLike {
  readonly results?: readonly unknown[];
}

export interface D1PreparedStatementLike {
  all(): Promise<D1ResultLike>;
  bind(...values: D1QueryValue[]): D1PreparedStatementLike;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
}

export interface CloudflareWorkflowRunsListReaderConfig {
  readonly d1: D1DatabaseLike;
  readonly now?: () => string;
}

const defaultNow = (): string => new Date().toISOString();

/**
 * Hard cap on how many run rows the monitor list can pull at once. Keeps a
 * pathological `?limit=` from scanning the whole table; the UI paginates by
 * narrowing `status` rather than by deep offsets.
 */
const MAX_RUNS_LIST_LIMIT = 200;
const DEFAULT_RUNS_LIST_LIMIT = 50;

/**
 * Query parameters for the read-only runs list. `limit` is coerced from the
 * query string, rejected when below 1 (a genuine client error), and clamped
 * down to `MAX_RUNS_LIST_LIMIT` so an over-large `?limit=` can never scan the
 * whole table. `status` optionally narrows to a single safety envelope state
 * (e.g. `blocked` to see only wedged runs).
 */
export const WorkflowRunsListQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .default(DEFAULT_RUNS_LIST_LIMIT)
    .transform((value) => Math.min(value, MAX_RUNS_LIST_LIMIT)),
  status: SafetyEnvelopeStateSchema.optional(),
});

export type WorkflowRunsListQuery = z.infer<typeof WorkflowRunsListQuerySchema>;

const nullToUndefined = <Output>(schema: z.ZodType<Output>) =>
  z.preprocess(
    (value) => (value === null ? undefined : value),
    schema.optional()
  );

/**
 * Raw `runs` row shape the list query selects. `created_at`/`updated_at` come
 * straight from SQLite — either an ISO string (when the writer bound one) or the
 * `CURRENT_TIMESTAMP` default (`YYYY-MM-DD HH:MM:SS`) — so they are validated as
 * non-empty strings rather than strict ISO datetimes.
 */
const D1RunsListRowSchema = z.object({
  blocker_code: nullToUndefined(CapabilityDenialCodeSchema),
  blocker_message: nullToUndefined(z.string().min(1)),
  blocker_node_type: nullToUndefined(WorkflowNodeTypeSchema),
  blocker_step_id: nullToUndefined(z.string().min(1)),
  created_at: z.string().min(1),
  run_id: z.string().min(1),
  status: SafetyEnvelopeStateSchema,
  updated_at: z.string().min(1),
  work_item_id: z.string().min(1),
});

/**
 * A single run as surfaced to the monitor list. `blocker` is present only for a
 * `blocked` run that carries a denial code + message in the 0004 columns. Every
 * field here is already redacted upstream (the Worker never stores secrets or
 * filesystem paths in these columns).
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

/**
 * Response document for `GET /admin/runs`. `query` echoes the effective
 * (clamped/defaulted) filter so the UI can render the active view and the next
 * limit without re-deriving it.
 */
export const WorkflowRunsListDocumentSchema = z.object({
  generatedAt: IsoDateTimeSchema,
  query: z.object({
    limit: z.number().int().min(1).max(MAX_RUNS_LIST_LIMIT),
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

const runsListItemFromRow = (value: unknown): WorkflowRunsListItem => {
  const row = D1RunsListRowSchema.parse(value);
  const blocker =
    row.status === "blocked" &&
    row.blocker_code !== undefined &&
    row.blocker_message !== undefined
      ? WorkflowTerminalBlockerSchema.parse({
          code: row.blocker_code,
          message: row.blocker_message,
          ...(row.blocker_node_type === undefined
            ? {}
            : { nodeType: row.blocker_node_type }),
          redacted: true,
          ...(row.blocker_step_id === undefined
            ? {}
            : { stepId: row.blocker_step_id }),
        })
      : undefined;

  return WorkflowRunsListItemSchema.parse({
    ...(blocker === undefined ? {} : { blocker }),
    createdAt: row.created_at,
    runId: row.run_id,
    status: row.status,
    updatedAt: row.updated_at,
    workItemId: row.work_item_id,
  });
};

/**
 * Resolves the `work_item_id` that owns a run, or `null` when the run is
 * unknown. The durability route needs this because the supervisor DO is sharded
 * by `workItemId` while the caller only knows the `runId`.
 */
export const createCloudflareWorkflowRunWorkItemReader = (
  config: CloudflareWorkflowRunsListReaderConfig
) => ({
  async read(input: { readonly runId: string }): Promise<null | string> {
    const result = await config.d1
      .prepare(
        `select work_item_id
         from runs
         where run_id = ?
         limit 1`
      )
      .bind(input.runId)
      .all();
    const firstRow = result.results?.[0];
    if (firstRow === undefined) {
      return null;
    }

    return z.object({ work_item_id: z.string().min(1) }).parse(firstRow)
      .work_item_id;
  },
});

/**
 * Read-only D1 list of runs for the local monitor. Orders newest-updated first
 * (the operator cares about the most recently advanced runs), optionally narrows
 * to a single status, and clamps the page size. Pure read — never mutates D1.
 */
export const createCloudflareWorkflowRunsListReader = (
  config: CloudflareWorkflowRunsListReaderConfig
) => {
  const now = config.now ?? defaultNow;

  return {
    async list(
      query: WorkflowRunsListQuery
    ): Promise<WorkflowRunsListDocument> {
      const where = query.status === undefined ? "" : "where status = ?";
      const bindings: D1QueryValue[] =
        query.status === undefined
          ? [query.limit]
          : [query.status, query.limit];
      const result = await config.d1
        .prepare(
          `select run_id, work_item_id, status, blocker_code, blocker_message, blocker_step_id, blocker_node_type, created_at, updated_at
           from runs
           ${where}
           order by updated_at desc, run_id asc
           limit ?`
        )
        .bind(...bindings)
        .all();
      const runs = (result.results ?? []).map(runsListItemFromRow);

      return WorkflowRunsListDocumentSchema.parse({
        generatedAt: now(),
        query: {
          limit: query.limit,
          ...(query.status === undefined ? {} : { status: query.status }),
        },
        redacted: true,
        runCount: runs.length,
        runs,
        schemaVersion: "workflow.runs-list.v1",
      });
    },
  };
};
