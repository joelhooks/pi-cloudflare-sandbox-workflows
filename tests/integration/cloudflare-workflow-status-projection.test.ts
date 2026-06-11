import { describe, expect, it } from "vitest";

import {
  PlanArtifactSchema,
  WorkflowEventSchema,
  WorkflowStatusProjectionSchema,
} from "../../src/app/domain/schemas.ts";
import { createCloudflareWorkflowStatusProjection } from "../../src/app/infrastructure/cloudflare-workflow-status-projection.ts";
import { buildIntegrationTestRunRequest } from "./workflow-app-fixtures.ts";

type D1QueryValue = null | number | string;

interface D1Operation {
  readonly query: string;
  readonly values: readonly D1QueryValue[];
}

interface FakeD1Statement {
  bind(...boundValues: D1QueryValue[]): FakeD1Statement;
  run(): Promise<{ readonly success: true }>;
}

const createFakeD1 = () => {
  const operations: D1Operation[] = [];

  return {
    d1: {
      prepare(query: string) {
        const statementFor = (
          values: readonly D1QueryValue[] = []
        ): FakeD1Statement => ({
          bind(...boundValues: D1QueryValue[]) {
            return statementFor(boundValues);
          },
          run() {
            operations.push({ query, values });

            return Promise.resolve({ success: true });
          },
        });

        return statementFor();
      },
    },
    operations,
  };
};

describe("Cloudflare workflow status projection", () => {
  it("upserts the run status row and attaches plan refs once available", async () => {
    const request = buildIntegrationTestRunRequest();
    const d1 = createFakeD1();
    const store = createCloudflareWorkflowStatusProjection({ d1: d1.d1 });
    const firstEvent = WorkflowEventSchema.parse({
      at: "2026-06-09T02:45:00.000Z",
      refs: { capsuleId: `capsule:${request.workItemId}` },
      state: "discoveringPackageMetadata",
      summary: "Context capsule resolved.",
    });
    const planArtifact = PlanArtifactSchema.parse({
      artifactRef: `artifact://status-projection/runs/${request.runId}/run/plan.json`,
      hash: "a".repeat(64),
      pinnedAt: "2026-06-09T02:46:00.000Z",
      runId: request.runId,
    });
    const secondEvent = WorkflowEventSchema.parse({
      at: "2026-06-09T02:46:00.000Z",
      refs: { planRef: planArtifact.artifactRef },
      state: "loadingPinnedDynamicWorkflow",
      summary: "Dynamic plan artifact pinned.",
    });

    await store.record({
      projection: WorkflowStatusProjectionSchema.parse({
        actorId: request.actor.id,
        capsuleId: `capsule:${request.workItemId}`,
        currentState: firstEvent.state,
        eventCount: 2,
        lastEvent: firstEvent,
        redacted: true,
        runId: request.runId,
        schemaVersion: "workflow.status-projection.v1",
        updatedAt: firstEvent.at,
        workItemId: request.workItemId,
      }),
    });
    await store.record({
      projection: WorkflowStatusProjectionSchema.parse({
        actorId: request.actor.id,
        capsuleId: `capsule:${request.workItemId}`,
        currentState: secondEvent.state,
        eventCount: 7,
        lastEvent: secondEvent,
        planArtifact,
        redacted: true,
        runId: request.runId,
        schemaVersion: "workflow.status-projection.v1",
        updatedAt: secondEvent.at,
        workItemId: request.workItemId,
      }),
    });

    expect({
      eventInsertUsed: d1.operations
        .filter((operation) =>
          operation.query.includes("insert into workflow_events")
        )
        .every((operation) =>
          operation.query.includes("on conflict(run_id, event_index)")
        ),
      firstEventValues: d1.operations.at(1)?.values,
      operationCount: d1.operations.length,
      runUpsertUsed: d1.operations
        .filter((operation) => operation.query.includes("insert into runs"))
        .every((operation) =>
          operation.query.includes("on conflict(run_id) do update")
        ),
      secondRunValues: d1.operations.at(2)?.values,
    }).toStrictEqual({
      eventInsertUsed: true,
      firstEventValues: [
        request.runId,
        2,
        request.workItemId,
        `capsule:${request.workItemId}`,
        request.actor.id,
        "discoveringPackageMetadata",
        "Context capsule resolved.",
        JSON.stringify(firstEvent.refs),
        1,
        firstEvent.at,
      ],
      operationCount: 4,
      runUpsertUsed: true,
      secondRunValues: [
        request.runId,
        request.workItemId,
        `capsule:${request.workItemId}`,
        request.actor.id,
        "loadingPinnedDynamicWorkflow",
        planArtifact.artifactRef,
        planArtifact.hash,
        null,
        null,
        null,
        null,
        secondEvent.at,
      ],
    });
  });

  it("persists the terminal blocker code, message, and step on a blocked run", async () => {
    const request = buildIntegrationTestRunRequest();
    const d1 = createFakeD1();
    const store = createCloudflareWorkflowStatusProjection({ d1: d1.d1 });
    const blockedEvent = WorkflowEventSchema.parse({
      at: "2026-06-09T02:47:00.000Z",
      refs: {},
      state: "blocked",
      summary: "Workflow node adapter step failed.",
    });

    await store.record({
      projection: WorkflowStatusProjectionSchema.parse({
        actorId: request.actor.id,
        capsuleId: `capsule:${request.workItemId}`,
        currentState: blockedEvent.state,
        eventCount: 9,
        lastEvent: blockedEvent,
        redacted: true,
        runId: request.runId,
        schemaVersion: "workflow.status-projection.v1",
        terminalBlocker: {
          code: "capability_denied",
          message:
            "Workflow node joelclaw.memory.capture-artifact requires a generated artifact ref.",
          nodeType: "joelclaw.memory.capture-artifact",
          redacted: true,
          stepId: "step-capture-artifact",
        },
        updatedAt: blockedEvent.at,
        workItemId: request.workItemId,
      }),
    });

    const runUpsert = d1.operations.find((operation) =>
      operation.query.includes("insert into runs")
    );

    const blockerColumns = [
      "blocker_code",
      "blocker_message",
      "blocker_step_id",
      "blocker_node_type",
    ];

    expect({
      includesBlockerColumns: blockerColumns.every(
        (column) => runUpsert?.query.includes(column) === true
      ),
      values: runUpsert?.values,
    }).toStrictEqual({
      includesBlockerColumns: true,
      values: [
        request.runId,
        request.workItemId,
        `capsule:${request.workItemId}`,
        request.actor.id,
        "blocked",
        null,
        null,
        "capability_denied",
        "Workflow node joelclaw.memory.capture-artifact requires a generated artifact ref.",
        "step-capture-artifact",
        "joelclaw.memory.capture-artifact",
        blockedEvent.at,
      ],
    });
  });
});
