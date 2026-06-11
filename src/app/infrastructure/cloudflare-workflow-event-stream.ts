import { z } from "zod";

import {
  D1RunRowSchema,
  D1WorkflowEventRowSchema,
} from "../control-plane/d1-schema.ts";
import {
  CapabilityDenialCodeSchema,
  SafetyEnvelopeStateSchema,
  WorkflowEventSchema,
  WorkflowEventStreamDocumentSchema,
  WorkflowEventStreamEntrySchema,
  WorkflowNodeTypeSchema,
  WorkflowTerminalBlockerSchema,
} from "../domain/schemas.ts";
import type { WorkflowEventStreamDocument } from "../domain/schemas.ts";

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

export interface CloudflareWorkflowEventStreamReaderConfig {
  readonly d1: D1DatabaseLike;
  readonly now?: () => string;
}

export interface CloudflareWorkflowRunStatusReaderConfig {
  readonly d1: D1DatabaseLike;
}

const nullToUndefined = <Output>(schema: z.ZodType<Output>) =>
  z.preprocess(
    (value) => (value === null ? undefined : value),
    schema.optional()
  );

const D1RunStatusRowSchema = z.object({
  blocker_code: nullToUndefined(CapabilityDenialCodeSchema),
  blocker_message: nullToUndefined(z.string().min(1)),
  blocker_node_type: nullToUndefined(WorkflowNodeTypeSchema),
  blocker_step_id: nullToUndefined(z.string().min(1)),
  run_id: z.string().min(1),
  status: SafetyEnvelopeStateSchema,
});

export const WorkflowRunStatusSnapshotSchema = z.object({
  runId: z.string().min(1),
  status: SafetyEnvelopeStateSchema,
  terminalBlocker: WorkflowTerminalBlockerSchema.optional(),
});

export type WorkflowRunStatusSnapshot = z.infer<
  typeof WorkflowRunStatusSnapshotSchema
>;

const defaultNow = (): string => new Date().toISOString();

const nullableRunRow = (value: unknown) => {
  const row = z.record(z.string(), z.unknown()).parse(value);

  return D1RunRowSchema.parse({
    actor_id: row["actor_id"],
    capsule_id: row["capsule_id"],
    ...(row["plan_hash"] === null || row["plan_hash"] === undefined
      ? {}
      : { plan_hash: row["plan_hash"] }),
    ...(row["plan_ref"] === null || row["plan_ref"] === undefined
      ? {}
      : { plan_ref: row["plan_ref"] }),
    run_id: row["run_id"],
    status: row["status"],
    work_item_id: row["work_item_id"],
  });
};

const workflowEventFromRow = (value: unknown) => {
  const row = D1WorkflowEventRowSchema.parse(value);
  const refs = z
    .record(z.string(), z.string())
    .parse(JSON.parse(row.refs_json) as unknown);

  return WorkflowEventStreamEntrySchema.parse({
    event: WorkflowEventSchema.parse({
      at: row.at,
      refs,
      state: row.state,
      summary: row.summary,
    }),
    eventIndex: row.event_index,
  });
};

export const createCloudflareWorkflowEventStreamReader = (
  config: CloudflareWorkflowEventStreamReaderConfig
) => {
  const now = config.now ?? defaultNow;

  return {
    async read(input: {
      readonly runId: string;
    }): Promise<WorkflowEventStreamDocument | null> {
      const runResult = await config.d1
        .prepare(
          `select run_id, work_item_id, capsule_id, actor_id, status, plan_ref, plan_hash
           from runs
           where run_id = ?
           limit 1`
        )
        .bind(input.runId)
        .all();
      const firstRunRow = runResult.results?.[0];
      if (firstRunRow === undefined) {
        return null;
      }
      const runRow = nullableRunRow(firstRunRow);
      const eventResult = await config.d1
        .prepare(
          `select run_id, event_index, work_item_id, capsule_id, actor_id, state, summary, refs_json, redacted, at
           from workflow_events
           where run_id = ?
           order by event_index asc`
        )
        .bind(input.runId)
        .all();
      const events = (eventResult.results ?? []).map(workflowEventFromRow);

      return WorkflowEventStreamDocumentSchema.parse({
        eventCount: events.length,
        events,
        generatedAt: now(),
        latestStatus: runRow.status,
        redacted: true,
        runId: runRow.run_id,
        schemaVersion: "workflow.event-stream.v1",
        sink: {
          description:
            "Redacted workflow events projected from Cloudflare D1 while the control plane advances the run.",
          kind: "cloudflare-d1-workflow-events",
          runId: runRow.run_id,
          table: "workflow_events",
        },
        workItemId: runRow.work_item_id,
      });
    },
  };
};

export const createCloudflareWorkflowRunStatusReader = (
  config: CloudflareWorkflowRunStatusReaderConfig
) => ({
  async read(input: {
    readonly runId: string;
  }): Promise<WorkflowRunStatusSnapshot | null> {
    const result = await config.d1
      .prepare(
        `select run_id, status, blocker_code, blocker_message, blocker_step_id, blocker_node_type
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
    const row = D1RunStatusRowSchema.parse(firstRow);
    const terminalBlocker =
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

    return WorkflowRunStatusSnapshotSchema.parse({
      runId: row.run_id,
      status: row.status,
      ...(terminalBlocker === undefined ? {} : { terminalBlocker }),
    });
  },
});
