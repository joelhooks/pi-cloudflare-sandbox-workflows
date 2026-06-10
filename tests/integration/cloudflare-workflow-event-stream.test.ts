import { describe, expect, it } from "vitest";

import { WorkflowEventStreamDocumentSchema } from "../../src/app/domain/schemas.ts";
import { createCloudflareWorkflowEventStreamReader } from "../../src/app/infrastructure/cloudflare-workflow-event-stream.ts";

type D1QueryValue = null | number | string;

interface D1Operation {
  readonly query: string;
  readonly values: readonly D1QueryValue[];
}

interface FakeD1Statement {
  all(): Promise<{ readonly results: readonly unknown[] }>;
  bind(...boundValues: D1QueryValue[]): FakeD1Statement;
}

const createFakeD1 = (input: {
  readonly eventRows: readonly unknown[];
  readonly runRows: readonly unknown[];
}) => {
  const operations: D1Operation[] = [];

  return {
    d1: {
      prepare(query: string) {
        const statementFor = (
          values: readonly D1QueryValue[] = []
        ): FakeD1Statement => ({
          all() {
            operations.push({ query, values });

            if (query.includes("from runs")) {
              return Promise.resolve({ results: input.runRows });
            }

            if (query.includes("from workflow_events")) {
              return Promise.resolve({ results: input.eventRows });
            }

            return Promise.resolve({ results: [] });
          },
          bind(...boundValues: D1QueryValue[]) {
            return statementFor(boundValues);
          },
        });

        return statementFor();
      },
    },
    operations,
  };
};

describe("Cloudflare workflow event stream reader", () => {
  it("builds a typed redacted event stream document from D1 rows", async () => {
    const d1 = createFakeD1({
      eventRows: [
        {
          actor_id: "actor:event-test",
          at: "2026-06-09T10:12:00.000Z",
          capsule_id: "capsule:work-item:event-test",
          event_index: 1,
          redacted: 1,
          refs_json: JSON.stringify({
            capsuleId: "capsule:work-item:event-test",
          }),
          run_id: "run-event-test",
          state: "received",
          summary: "Run request accepted.",
          work_item_id: "work-item:event-test",
        },
        {
          actor_id: "actor:event-test",
          at: "2026-06-09T10:13:00.000Z",
          capsule_id: "capsule:work-item:event-test",
          event_index: 2,
          redacted: 1,
          refs_json: JSON.stringify({ packageCount: "3" }),
          run_id: "run-event-test",
          state: "discoveringPackageMetadata",
          summary: "Package metadata discovered before mount.",
          work_item_id: "work-item:event-test",
        },
      ],
      runRows: [
        {
          actor_id: "actor:event-test",
          capsule_id: "capsule:work-item:event-test",
          plan_hash: null,
          plan_ref: null,
          run_id: "run-event-test",
          status: "discoveringPackageMetadata",
          work_item_id: "work-item:event-test",
        },
      ],
    });
    const reader = createCloudflareWorkflowEventStreamReader({
      d1: d1.d1,
      now: () => "2026-06-09T10:14:00.000Z",
    });

    const document = WorkflowEventStreamDocumentSchema.parse(
      await reader.read({ runId: "run-event-test" })
    );

    expect({
      document,
      operationCount: d1.operations.length,
      runLookupValues: d1.operations.at(0)?.values,
    }).toStrictEqual({
      document: {
        eventCount: 2,
        events: [
          {
            event: {
              at: "2026-06-09T10:12:00.000Z",
              refs: { capsuleId: "capsule:work-item:event-test" },
              state: "received",
              summary: "Run request accepted.",
            },
            eventIndex: 1,
          },
          {
            event: {
              at: "2026-06-09T10:13:00.000Z",
              refs: { packageCount: "3" },
              state: "discoveringPackageMetadata",
              summary: "Package metadata discovered before mount.",
            },
            eventIndex: 2,
          },
        ],
        generatedAt: "2026-06-09T10:14:00.000Z",
        latestStatus: "discoveringPackageMetadata",
        redacted: true,
        runId: "run-event-test",
        schemaVersion: "workflow.event-stream.v1",
        sink: {
          description:
            "Redacted workflow events projected from Cloudflare D1 while the control plane advances the run.",
          kind: "cloudflare-d1-workflow-events",
          runId: "run-event-test",
          table: "workflow_events",
        },
        workItemId: "work-item:event-test",
      },
      operationCount: 2,
      runLookupValues: ["run-event-test"],
    });
  });

  it("returns null when the run projection does not exist", async () => {
    const d1 = createFakeD1({
      eventRows: [],
      runRows: [],
    });
    const reader = createCloudflareWorkflowEventStreamReader({
      d1: d1.d1,
      now: () => "2026-06-09T10:14:00.000Z",
    });

    await expect(reader.read({ runId: "run-missing" })).resolves.toBeNull();
  });
});
