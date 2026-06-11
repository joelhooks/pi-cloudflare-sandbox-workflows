import type { WorkflowStatusProjectionPort } from "../application/ports.ts";
import {
  D1RunRowSchema,
  D1WorkflowEventRowSchema,
} from "../control-plane/d1-schema.ts";
import { WorkflowStatusProjectionSchema } from "../domain/schemas.ts";

type D1QueryValue = null | number | string;

interface D1RunResultLike {
  readonly success?: boolean;
}

interface D1PreparedStatementLike {
  bind(...values: D1QueryValue[]): D1PreparedStatementLike;
  run(): Promise<D1RunResultLike>;
}

interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
}

export interface CloudflareWorkflowStatusProjectionConfig {
  readonly d1: D1DatabaseLike;
}

const assertD1Write = async (
  statement: D1PreparedStatementLike,
  summary: string
): Promise<void> => {
  const result = await statement.run();
  if (result.success === false) {
    throw new Error(summary);
  }
};

export const createCloudflareWorkflowStatusProjection = (
  config: CloudflareWorkflowStatusProjectionConfig
): WorkflowStatusProjectionPort => ({
  async record(input): Promise<void> {
    const projection = WorkflowStatusProjectionSchema.parse(input.projection);
    const row = D1RunRowSchema.parse({
      actor_id: projection.actorId,
      ...(projection.terminalBlocker === undefined
        ? {}
        : {
            blocker_code: projection.terminalBlocker.code,
            blocker_message: projection.terminalBlocker.message,
            ...(projection.terminalBlocker.nodeType === undefined
              ? {}
              : { blocker_node_type: projection.terminalBlocker.nodeType }),
            ...(projection.terminalBlocker.stepId === undefined
              ? {}
              : { blocker_step_id: projection.terminalBlocker.stepId }),
          }),
      capsule_id: projection.capsuleId,
      ...(projection.planArtifact === undefined
        ? {}
        : {
            plan_hash: projection.planArtifact.hash,
            plan_ref: projection.planArtifact.artifactRef,
          }),
      run_id: projection.runId,
      status: projection.currentState,
      work_item_id: projection.workItemId,
    });
    const eventRow = D1WorkflowEventRowSchema.parse({
      actor_id: projection.actorId,
      at: projection.lastEvent.at,
      capsule_id: projection.capsuleId,
      event_index: projection.eventCount,
      redacted: 1,
      refs_json: JSON.stringify(projection.lastEvent.refs),
      run_id: projection.runId,
      state: projection.lastEvent.state,
      summary: projection.lastEvent.summary,
      work_item_id: projection.workItemId,
    });

    await assertD1Write(
      config.d1
        .prepare(
          `insert into runs (run_id, work_item_id, capsule_id, actor_id, status, plan_ref, plan_hash, blocker_code, blocker_message, blocker_step_id, blocker_node_type, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           on conflict(run_id) do update set
             work_item_id = excluded.work_item_id,
             capsule_id = excluded.capsule_id,
             actor_id = excluded.actor_id,
             status = excluded.status,
             plan_ref = coalesce(excluded.plan_ref, runs.plan_ref),
             plan_hash = coalesce(excluded.plan_hash, runs.plan_hash),
             blocker_code = excluded.blocker_code,
             blocker_message = excluded.blocker_message,
             blocker_step_id = excluded.blocker_step_id,
             blocker_node_type = excluded.blocker_node_type,
             updated_at = excluded.updated_at`
        )
        .bind(
          row.run_id,
          row.work_item_id,
          row.capsule_id,
          row.actor_id,
          row.status,
          row.plan_ref ?? null,
          row.plan_hash ?? null,
          row.blocker_code ?? null,
          row.blocker_message ?? null,
          row.blocker_step_id ?? null,
          row.blocker_node_type ?? null,
          projection.updatedAt
        ),
      "Workflow status projection row could not be persisted."
    );
    await assertD1Write(
      config.d1
        .prepare(
          `insert into workflow_events (run_id, event_index, work_item_id, capsule_id, actor_id, state, summary, refs_json, redacted, at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           on conflict(run_id, event_index) do update set
             work_item_id = excluded.work_item_id,
             capsule_id = excluded.capsule_id,
             actor_id = excluded.actor_id,
             state = excluded.state,
             summary = excluded.summary,
             refs_json = excluded.refs_json,
             redacted = excluded.redacted,
             at = excluded.at`
        )
        .bind(
          eventRow.run_id,
          eventRow.event_index,
          eventRow.work_item_id,
          eventRow.capsule_id,
          eventRow.actor_id,
          eventRow.state,
          eventRow.summary,
          eventRow.refs_json,
          eventRow.redacted,
          eventRow.at
        ),
      "Workflow event projection row could not be persisted."
    );
  },
});
