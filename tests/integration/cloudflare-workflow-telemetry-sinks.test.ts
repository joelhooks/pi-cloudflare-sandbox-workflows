import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { WorkflowStructuredLogRecord } from "../../src/app/domain/schemas.ts";
import {
  WorkflowExternalTelemetryBatchSchema,
  WorkflowTelemetrySinkReceiptSchema,
  WorkflowStructuredLogRecordSchema,
} from "../../src/app/domain/schemas.ts";
import {
  createCloudflareAnalyticsEngineWorkflowTelemetrySink,
  createExternalHttpWorkflowTelemetrySink,
} from "../../src/app/infrastructure/cloudflare-workflow-telemetry-sinks.ts";
import type { AnalyticsEngineDatasetLike } from "../../src/app/infrastructure/cloudflare-workflow-telemetry-sinks.ts";

const AnalyticsEngineDataPointTestSchema = z.object({
  blobs: z.array(z.string().nullable()),
  doubles: z.array(z.number()),
  indexes: z.array(z.string()),
});

const structuredLog = (
  input: Partial<WorkflowStructuredLogRecord> = {}
): WorkflowStructuredLogRecord =>
  WorkflowStructuredLogRecordSchema.parse({
    at: "2026-06-09T08:00:00.000Z",
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

describe("Cloudflare workflow telemetry sinks", () => {
  it("exports structured logs to Cloudflare Analytics Engine with bounded fields", async () => {
    const writes: unknown[] = [];
    const analytics: AnalyticsEngineDatasetLike = {
      writeDataPoint(event) {
        writes.push(event);
      },
    };

    const sink = createCloudflareAnalyticsEngineWorkflowTelemetrySink({
      analytics,
      dataset: "pi_cloudflare_sandbox_workflows_telemetry",
      now: () => "2026-06-09T08:01:00.000Z",
    });

    const receipts = await sink.recordLogs({
      logs: [
        structuredLog({
          fields: {
            artifactRef: `artifact://${"x".repeat(1200)}`,
          },
        }),
      ],
      runId: `run-${"very-long-".repeat(20)}id`,
      workItemId: "work-item:telemetry-export",
    });
    const receipt = WorkflowTelemetrySinkReceiptSchema.parse(receipts.at(0));
    const dataPoint = AnalyticsEngineDataPointTestSchema.parse(writes.at(0));

    expect({
      blobCount: dataPoint.blobs.length,
      blockedSecretExport: dataPoint.blobs.includes("must-not-be-exported"),
      doubleCount: dataPoint.doubles.length,
      firstDoubleIsCount: dataPoint.doubles.at(0),
      indexCount: dataPoint.indexes.length,
      indexLength: dataPoint.indexes.at(0)?.length,
      longArtifactRefLength: dataPoint.blobs.at(15)?.length,
      receipt,
      writes: writes.length,
    }).toStrictEqual({
      blobCount: 20,
      blockedSecretExport: false,
      doubleCount: 5,
      firstDoubleIsCount: 1,
      indexCount: 1,
      indexLength: 96,
      longArtifactRefLength: 768,
      receipt: {
        capturedAt: "2026-06-09T08:01:00.000Z",
        logCount: 1,
        redacted: true,
        runId: `run-${"very-long-".repeat(20)}id`,
        schemaVersion: "workflow.telemetry-sink-receipt.v1",
        sink: {
          dataset: "pi_cloudflare_sandbox_workflows_telemetry",
          description:
            "Structured workflow telemetry exported to Cloudflare Workers Analytics Engine as bounded high-cardinality data points.",
          kind: "cloudflare-analytics-engine",
        },
        status: "captured",
      },
      writes: 1,
    });
  });

  it("marks Analytics Engine export blocked when logs exceed invocation limits", async () => {
    const writes: unknown[] = [];
    const analytics: AnalyticsEngineDatasetLike = {
      writeDataPoint(event) {
        writes.push(event);
      },
    };

    const sink = createCloudflareAnalyticsEngineWorkflowTelemetrySink({
      analytics,
      dataset: "pi_cloudflare_sandbox_workflows_telemetry",
      maxDataPointsPerInvocation: 2,
      now: () => "2026-06-09T08:02:00.000Z",
    });

    const receipts = await sink.recordLogs({
      logs: [structuredLog(), structuredLog(), structuredLog()],
      runId: "run:telemetry-limit",
      workItemId: "work-item:telemetry-export",
    });
    const receipt = WorkflowTelemetrySinkReceiptSchema.parse(receipts.at(0));

    expect({
      logCount: receipt.logCount,
      status: receipt.status,
      writes: writes.length,
    }).toStrictEqual({
      logCount: 2,
      status: "blocked",
      writes: 2,
    });
  });

  it("exports redacted structured logs to an external HTTP telemetry collector", async () => {
    const calls: {
      readonly body: unknown;
      readonly headers: Headers;
      readonly method: string | undefined;
      readonly url: string;
    }[] = [];
    const sink = createExternalHttpWorkflowTelemetrySink({
      authorizationBearerToken: "external-token",
      endpointUrl: "https://telemetry.example.test/workflow/logs",
      fetch(url, init) {
        if (typeof init.body !== "string") {
          throw new TypeError("Expected external telemetry JSON body.");
        }
        calls.push({
          body: JSON.parse(init.body) as unknown,
          headers: new Headers(init.headers),
          method: init.method,
          url,
        });

        return Promise.resolve(new Response(null, { status: 202 }));
      },
      now: () => "2026-06-09T08:03:00.000Z",
      sinkId: "operator-external-collector",
    });

    const receipts = await sink.recordLogs({
      logs: [structuredLog()],
      runId: "run:external-telemetry",
      workItemId: "work-item:telemetry-export",
    });
    const receipt = WorkflowTelemetrySinkReceiptSchema.parse(receipts.at(0));
    const call = calls.at(0);
    if (call === undefined) {
      throw new Error("Expected external telemetry fetch call.");
    }
    const body = WorkflowExternalTelemetryBatchSchema.parse(call.body);

    expect({
      authorization: call.headers.get("authorization"),
      bodyContainsRawSecret: JSON.stringify(body).includes(
        "must-not-be-exported"
      ),
      bodyLog: {
        eventName: body.logs[0]?.eventName,
        fieldKeys: Object.keys(body.logs[0]?.fields ?? {}).toSorted(),
        logCount: body.logCount,
        schemaVersion: body.schemaVersion,
      },
      contentType: call.headers.get("content-type"),
      method: call.method,
      receipt,
      url: call.url,
    }).toStrictEqual({
      authorization: "Bearer external-token",
      bodyContainsRawSecret: false,
      bodyLog: {
        eventName: "workflow.state.resolvingCapsule",
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
        schemaVersion: "workflow.external-telemetry-batch.v1",
      },
      contentType: "application/json",
      method: "POST",
      receipt: {
        capturedAt: "2026-06-09T08:03:00.000Z",
        logCount: 1,
        redacted: true,
        runId: "run:external-telemetry",
        schemaVersion: "workflow.telemetry-sink-receipt.v1",
        sink: {
          dataset: "operator-external-collector",
          description:
            "Structured workflow telemetry exported to an external HTTP collector as a redacted workflow.external-telemetry-batch.v1 payload.",
          endpointHash:
            "39c86986dd97fab2e51f320d5a513c993a84be3403a26a32ac2936a515d3e215",
          kind: "external-http-structured-logs",
          method: "POST",
        },
        status: "captured",
      },
      url: "https://telemetry.example.test/workflow/logs",
    });
  });

  it("returns a blocked external telemetry receipt without throwing on collector failure", async () => {
    const sink = createExternalHttpWorkflowTelemetrySink({
      endpointUrl: "https://telemetry.example.test/workflow/logs",
      fetch() {
        return Promise.resolve(new Response(null, { status: 503 }));
      },
      now: () => "2026-06-09T08:04:00.000Z",
    });

    const receipts = await sink.recordLogs({
      logs: [structuredLog()],
      runId: "run:external-telemetry-blocked",
      workItemId: "work-item:telemetry-export",
    });
    const receipt = WorkflowTelemetrySinkReceiptSchema.parse(receipts.at(0));

    expect({
      logCount: receipt.logCount,
      sink: receipt.sink,
      status: receipt.status,
    }).toStrictEqual({
      logCount: 0,
      sink: {
        dataset: "external-http-structured-logs",
        description:
          "External HTTP structured telemetry export was attempted but did not capture successfully; workflow capture continues with a blocked sink receipt.",
        endpointHash:
          "39c86986dd97fab2e51f320d5a513c993a84be3403a26a32ac2936a515d3e215",
        kind: "external-http-structured-logs",
        method: "POST",
      },
      status: "blocked",
    });
  });
});
