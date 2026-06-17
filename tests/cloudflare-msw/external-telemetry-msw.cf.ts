import { setupNetwork } from "@msw/cloudflare";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { WorkflowStructuredLogRecord } from "../../src/app/domain/schemas.ts";
import {
  WorkflowExternalTelemetryBatchSchema,
  WorkflowStructuredLogRecordSchema,
  WorkflowTelemetrySinkReceiptSchema,
} from "../../src/app/domain/schemas.ts";
import { createExternalHttpWorkflowTelemetrySink } from "../../src/app/infrastructure/cloudflare-workflow-telemetry-sinks.ts";

const network = setupNetwork();
const endpointUrl = "https://telemetry.example.test/workflow/logs";

const structuredLog = (
  input: Partial<WorkflowStructuredLogRecord> = {}
): WorkflowStructuredLogRecord =>
  WorkflowStructuredLogRecordSchema.parse({
    at: "2026-06-17T12:00:00.000Z",
    eventName: "workflow.state.resolvingCapsule",
    fields: {
      artifactCommitSha: "commit-sha",
      artifactRef: "artifact://workflow/run/ref",
      blockerCode: "none",
      capability: "discord.message.send",
      costEstimate: 0.12,
      durationMs: 42,
      laneId: "lane:planner",
      laneKind: "planner",
      laneRuntime: "pi-agent-cli",
      leaseId: "lease:discord.message.send:run:research-review",
      payloadHash: "0".repeat(64),
      rawSecret: "must-not-be-exported",
      resourceRef: "discord:channel:operator-status",
      reviewSurfaceId: "review-surface:run",
      sandboxRef: "cloudflare-sandbox:planner",
      spanId: "span:run:event:1",
      stepId: "research-review",
      tokenCount: 123,
      traceId: "trace:run",
      verifierResultId: "verification-result:run",
      ...input.fields,
    },
    schemaVersion: "workflow.structured-log.v1",
    severity: "info",
    ...input,
  });

beforeAll(() => {
  network.enable();
});

afterEach(() => {
  network.resetHandlers();
});

afterAll(() => {
  network.disable();
});

describe("Cloudflare MSW external telemetry canary", () => {
  it("intercepts the default Worker-runtime fetch used by the external telemetry sink", async () => {
    const interceptedRequests: {
      readonly authorization: null | string;
      readonly body: unknown;
      readonly contentType: null | string;
      readonly method: string;
    }[] = [];

    network.use(
      http.post(endpointUrl, async ({ request }) => {
        interceptedRequests.push({
          authorization: request.headers.get("authorization"),
          body: await request.json(),
          contentType: request.headers.get("content-type"),
          method: request.method,
        });

        return HttpResponse.json({ accepted: true }, { status: 202 });
      })
    );

    const sink = createExternalHttpWorkflowTelemetrySink({
      authorizationBearerToken: "external-token",
      endpointUrl,
      now: () => "2026-06-17T12:01:00.000Z",
      sinkId: "msw-cloudflare-canary",
    });

    const receipts = await sink.recordLogs({
      logs: [structuredLog()],
      runId: "run:msw-cloudflare-canary",
      workItemId: "work-item:telemetry-export",
    });

    const receipt = WorkflowTelemetrySinkReceiptSchema.parse(receipts.at(0));
    const intercepted = interceptedRequests.at(0);
    if (intercepted === undefined) {
      throw new Error("Expected @msw/cloudflare to intercept telemetry fetch.");
    }
    const body = WorkflowExternalTelemetryBatchSchema.parse(intercepted.body);

    expect({
      authorization: intercepted.authorization,
      bodyContainsRawSecret: JSON.stringify(body).includes(
        "must-not-be-exported"
      ),
      contentType: intercepted.contentType,
      fieldKeys: Object.keys(body.logs[0]?.fields ?? {}).toSorted(),
      logCount: body.logCount,
      method: intercepted.method,
      receipt,
    }).toStrictEqual({
      authorization: "Bearer external-token",
      bodyContainsRawSecret: false,
      contentType: "application/json",
      fieldKeys: [
        "artifactCommitSha",
        "artifactRef",
        "blockerCode",
        "capability",
        "costEstimate",
        "durationMs",
        "laneId",
        "laneKind",
        "laneRuntime",
        "leaseId",
        "payloadHash",
        "resourceRef",
        "reviewSurfaceId",
        "sandboxRef",
        "spanId",
        "stepId",
        "tokenCount",
        "traceId",
        "verifierResultId",
      ],
      logCount: 1,
      method: "POST",
      receipt: {
        capturedAt: "2026-06-17T12:01:00.000Z",
        logCount: 1,
        redacted: true,
        runId: "run:msw-cloudflare-canary",
        schemaVersion: "workflow.telemetry-sink-receipt.v1",
        sink: {
          dataset: "msw-cloudflare-canary",
          description:
            "Structured workflow telemetry exported to an external HTTP collector as a redacted workflow.external-telemetry-batch.v1 payload.",
          endpointHash:
            "39c86986dd97fab2e51f320d5a513c993a84be3403a26a32ac2936a515d3e215",
          kind: "external-http-structured-logs",
          method: "POST",
        },
        status: "captured",
      },
    });
  });

  it("keeps collector failures typed as blocked receipts in the Worker runtime", async () => {
    network.use(
      http.post(endpointUrl, () =>
        HttpResponse.json({ accepted: false }, { status: 503 })
      )
    );

    const sink = createExternalHttpWorkflowTelemetrySink({
      endpointUrl,
      now: () => "2026-06-17T12:02:00.000Z",
    });

    const receipts = await sink.recordLogs({
      logs: [structuredLog()],
      runId: "run:msw-cloudflare-blocked",
      workItemId: "work-item:telemetry-export",
    });
    const receipt = WorkflowTelemetrySinkReceiptSchema.parse(receipts.at(0));

    expect({
      logCount: receipt.logCount,
      status: receipt.status,
    }).toStrictEqual({
      logCount: 0,
      status: "blocked",
    });
  });
});
