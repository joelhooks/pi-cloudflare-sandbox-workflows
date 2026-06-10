import type {
  ArtifactStoreContract,
  WorkflowTelemetrySinkPort,
} from "../application/ports.ts";
import { D1WorkflowTelemetryLogRowSchema } from "../control-plane/d1-schema.ts";
import { sha256Hex } from "../domain/hash.ts";
import {
  WorkflowExternalTelemetryBatchSchema,
  WorkflowTelemetrySinkReceiptSchema,
} from "../domain/schemas.ts";
import type {
  WorkflowStructuredLogRecord,
  WorkflowTelemetrySinkReceipt,
} from "../domain/schemas.ts";

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

interface AnalyticsEngineDataPointLike {
  readonly blobs?: readonly (ArrayBuffer | null | string)[];
  readonly doubles?: readonly number[];
  readonly indexes?: readonly (ArrayBuffer | null | string)[];
}

export interface AnalyticsEngineDatasetLike {
  writeDataPoint(event?: AnalyticsEngineDataPointLike): void;
}

export interface CloudflareArtifactsStructuredLogSinkConfig {
  readonly artifacts: ArtifactStoreContract;
  readonly now?: () => string;
}

export interface CloudflareAnalyticsEngineWorkflowTelemetrySinkConfig {
  readonly analytics: AnalyticsEngineDatasetLike;
  readonly dataset: string;
  readonly maxDataPointsPerInvocation?: number;
  readonly now?: () => string;
}

export interface CloudflareD1WorkflowTelemetrySinkConfig {
  readonly d1: D1DatabaseLike;
  readonly now?: () => string;
}

export type ExternalHttpWorkflowTelemetryFetch = (
  input: string,
  init: RequestInit
) => Promise<Response>;

export interface ExternalHttpWorkflowTelemetrySinkConfig {
  readonly authorizationBearerToken?: string;
  readonly endpointUrl: string;
  readonly fetch?: ExternalHttpWorkflowTelemetryFetch;
  readonly now?: () => string;
  readonly sinkId?: string;
  readonly timeoutMs?: number;
}

const analyticsEngineBlobMaxBytes = 768;
const analyticsEngineDataPointLimit = 250;
const analyticsEngineIndexMaxBytes = 96;
const externalTelemetryFieldNames = [
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
] as const;
const telemetryPath = "run/telemetry/structured-logs.jsonl";
const textEncoder = new TextEncoder();

const fieldString = (
  log: WorkflowStructuredLogRecord,
  key: string
): null | string => {
  const value = log.fields[key];

  return typeof value === "string" ? value : null;
};

const fieldNumber = (
  log: WorkflowStructuredLogRecord,
  key: string
): null | number => {
  const value = log.fields[key];

  return typeof value === "number" ? value : null;
};

const fieldStringOrNumber = (
  log: WorkflowStructuredLogRecord,
  key: string
): null | string => {
  const value = log.fields[key];

  if (typeof value === "string") {
    return value;
  }

  return typeof value === "number" ? String(value) : null;
};

const telemetryLogId = (input: {
  readonly index: number;
  readonly log: WorkflowStructuredLogRecord;
  readonly runId: string;
}): string =>
  `telemetry:${input.runId}:${input.index + 1}:${sha256Hex(
    JSON.stringify(input.log)
  ).slice(0, 16)}`;

const truncateUtf8 = (value: string, maxBytes: number): string => {
  if (textEncoder.encode(value).byteLength <= maxBytes) {
    return value;
  }

  let truncated = value.slice(0, maxBytes);
  while (
    truncated.length > 0 &&
    textEncoder.encode(truncated).byteLength > maxBytes
  ) {
    truncated = truncated.slice(0, -1);
  }

  return truncated;
};

const shortAnalyticsIndex = (runId: string): string => {
  if (textEncoder.encode(runId).byteLength <= analyticsEngineIndexMaxBytes) {
    return runId;
  }

  const hash = sha256Hex(runId).slice(0, 16);
  const prefix = truncateUtf8(
    runId,
    analyticsEngineIndexMaxBytes - hash.length - 1
  );

  return `${prefix}:${hash}`;
};

const analyticsBlob = (value: null | string): null | string =>
  value === null ? null : truncateUtf8(value, analyticsEngineBlobMaxBytes);

const analyticsDouble = (value: null | number): number => value ?? 0;

const analyticsEngineDataPoint = (input: {
  readonly index: number;
  readonly log: WorkflowStructuredLogRecord;
  readonly runId: string;
  readonly workItemId: string;
}): AnalyticsEngineDataPointLike => ({
  blobs: [
    input.runId,
    input.workItemId,
    input.log.eventName,
    input.log.severity,
    fieldStringOrNumber(input.log, "traceId"),
    fieldStringOrNumber(input.log, "spanId"),
    fieldStringOrNumber(input.log, "laneId"),
    fieldStringOrNumber(input.log, "laneKind"),
    fieldStringOrNumber(input.log, "laneRuntime"),
    fieldStringOrNumber(input.log, "sandboxRef"),
    fieldStringOrNumber(input.log, "stepId"),
    fieldStringOrNumber(input.log, "capability"),
    fieldStringOrNumber(input.log, "leaseId"),
    fieldStringOrNumber(input.log, "resourceRef"),
    fieldStringOrNumber(input.log, "payloadHash"),
    fieldStringOrNumber(input.log, "artifactRef"),
    fieldStringOrNumber(input.log, "artifactCommitSha"),
    fieldStringOrNumber(input.log, "verifierResultId"),
    fieldStringOrNumber(input.log, "reviewSurfaceId"),
    fieldStringOrNumber(input.log, "blockerCode"),
  ].map(analyticsBlob),
  doubles: [
    1,
    analyticsDouble(fieldNumber(input.log, "durationMs")),
    analyticsDouble(fieldNumber(input.log, "tokenCount")),
    analyticsDouble(fieldNumber(input.log, "costEstimate")),
    input.index + 1,
  ],
  indexes: [shortAnalyticsIndex(input.runId)],
});

const externalTelemetryFields = (
  log: WorkflowStructuredLogRecord
): WorkflowStructuredLogRecord["fields"] => {
  const fields: WorkflowStructuredLogRecord["fields"] = {};
  for (const fieldName of externalTelemetryFieldNames) {
    const value = log.fields[fieldName];
    if (value !== undefined) {
      fields[fieldName] = value;
    }
  }

  return fields;
};

const externalTelemetryBatch = (input: {
  readonly generatedAt: string;
  readonly logs: readonly WorkflowStructuredLogRecord[];
  readonly runId: string;
  readonly workItemId: string;
}) =>
  WorkflowExternalTelemetryBatchSchema.parse({
    generatedAt: input.generatedAt,
    logCount: input.logs.length,
    logs: input.logs.map((log) => ({
      at: log.at,
      eventName: log.eventName,
      fields: externalTelemetryFields(log),
      redacted: true,
      schemaVersion: "workflow.external-telemetry-log.v1",
      severity: log.severity,
    })),
    redacted: true,
    runId: input.runId,
    schemaVersion: "workflow.external-telemetry-batch.v1",
    workItemId: input.workItemId,
  });

const externalTelemetryReceipt = (input: {
  readonly endpointUrl: string;
  readonly logCount: number;
  readonly now: string;
  readonly runId: string;
  readonly sinkId?: string;
  readonly status: "blocked" | "captured";
}): readonly WorkflowTelemetrySinkReceipt[] => [
  WorkflowTelemetrySinkReceiptSchema.parse({
    capturedAt: input.now,
    logCount: input.logCount,
    redacted: true,
    runId: input.runId,
    schemaVersion: "workflow.telemetry-sink-receipt.v1",
    sink: {
      dataset: input.sinkId ?? "external-http-structured-logs",
      description:
        input.status === "captured"
          ? "Structured workflow telemetry exported to an external HTTP collector as a redacted workflow.external-telemetry-batch.v1 payload."
          : "External HTTP structured telemetry export was attempted but did not capture successfully; workflow capture continues with a blocked sink receipt.",
      endpointHash: sha256Hex(input.endpointUrl),
      kind: "external-http-structured-logs",
      method: "POST",
    },
    status: input.status,
  }),
];

const assertD1Write = async (
  statement: D1PreparedStatementLike,
  summary: string
): Promise<void> => {
  const result = await statement.run();
  if (result.success === false) {
    throw new Error(summary);
  }
};

export const createCloudflareArtifactsStructuredLogSink = (
  config: CloudflareArtifactsStructuredLogSinkConfig
): WorkflowTelemetrySinkPort => ({
  async recordLogs(input) {
    const value = input.logs
      .map((log) => JSON.stringify(log))
      .join("\n")
      .concat(input.logs.length === 0 ? "" : "\n");
    const artifact = await config.artifacts.writeText({
      mediaType: "application/x-ndjson",
      path: telemetryPath,
      redacted: true,
      runId: input.runId,
      value,
    });

    return [
      WorkflowTelemetrySinkReceiptSchema.parse({
        artifactRef: artifact.artifactRef,
        capturedAt: config.now?.() ?? new Date().toISOString(),
        logCount: input.logs.length,
        redacted: true,
        runId: input.runId,
        schemaVersion: "workflow.telemetry-sink-receipt.v1",
        sink: {
          description:
            "Structured high-cardinality workflow logs written as newline-delimited JSON in the run Artifact store.",
          kind: "artifact-jsonl",
          path: telemetryPath,
        },
        status: "captured",
      }),
    ];
  },
});

export const createCloudflareAnalyticsEngineWorkflowTelemetrySink = (
  config: CloudflareAnalyticsEngineWorkflowTelemetrySinkConfig
): WorkflowTelemetrySinkPort => ({
  recordLogs(input) {
    const maxDataPoints =
      config.maxDataPointsPerInvocation ?? analyticsEngineDataPointLimit;
    const logsToWrite = input.logs.slice(0, maxDataPoints);

    for (const [index, log] of logsToWrite.entries()) {
      config.analytics.writeDataPoint(
        analyticsEngineDataPoint({
          index,
          log,
          runId: input.runId,
          workItemId: input.workItemId,
        })
      );
    }

    return Promise.resolve([
      WorkflowTelemetrySinkReceiptSchema.parse({
        capturedAt: config.now?.() ?? new Date().toISOString(),
        logCount: logsToWrite.length,
        redacted: true,
        runId: input.runId,
        schemaVersion: "workflow.telemetry-sink-receipt.v1",
        sink: {
          dataset: config.dataset,
          description:
            "Structured workflow telemetry exported to Cloudflare Workers Analytics Engine as bounded high-cardinality data points.",
          kind: "cloudflare-analytics-engine",
        },
        status:
          logsToWrite.length === input.logs.length ? "captured" : "blocked",
      }),
    ]);
  },
});

export const createCloudflareD1WorkflowTelemetrySink = (
  config: CloudflareD1WorkflowTelemetrySinkConfig
): WorkflowTelemetrySinkPort => ({
  async recordLogs(input) {
    for (const [index, log] of input.logs.entries()) {
      const row = D1WorkflowTelemetryLogRowSchema.parse({
        artifact_ref: fieldString(log, "artifactRef") ?? undefined,
        at: log.at,
        capability: fieldString(log, "capability") ?? undefined,
        duration_ms: fieldNumber(log, "durationMs") ?? undefined,
        event_name: log.eventName,
        fields_json: JSON.stringify(log.fields),
        lane_id: fieldString(log, "laneId") ?? undefined,
        lease_id: fieldString(log, "leaseId") ?? undefined,
        log_id: telemetryLogId({ index, log, runId: input.runId }),
        payload_hash: fieldString(log, "payloadHash") ?? undefined,
        redacted: 1,
        run_id: input.runId,
        severity: log.severity,
        span_id: fieldString(log, "spanId"),
        trace_id: fieldString(log, "traceId"),
        work_item_id: input.workItemId,
      });

      await assertD1Write(
        config.d1
          .prepare(
            `insert into workflow_telemetry_logs (
              log_id,
              run_id,
              work_item_id,
              trace_id,
              span_id,
              event_name,
              severity,
              lane_id,
              capability,
              lease_id,
              artifact_ref,
              payload_hash,
              duration_ms,
              fields_json,
              redacted,
              at
            ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict(log_id) do update set
              fields_json = excluded.fields_json,
              redacted = excluded.redacted`
          )
          .bind(
            row.log_id,
            row.run_id,
            row.work_item_id,
            row.trace_id,
            row.span_id,
            row.event_name,
            row.severity,
            row.lane_id ?? null,
            row.capability ?? null,
            row.lease_id ?? null,
            row.artifact_ref ?? null,
            row.payload_hash ?? null,
            row.duration_ms ?? null,
            row.fields_json,
            row.redacted,
            row.at
          ),
        "Workflow telemetry log row could not be persisted."
      );
    }

    return [
      WorkflowTelemetrySinkReceiptSchema.parse({
        capturedAt: config.now?.() ?? new Date().toISOString(),
        logCount: input.logs.length,
        redacted: true,
        runId: input.runId,
        schemaVersion: "workflow.telemetry-sink-receipt.v1",
        sink: {
          description:
            "Structured high-cardinality workflow logs mirrored into the Cloudflare D1 workflow_telemetry_logs table for queryable runtime inspection.",
          kind: "cloudflare-d1-structured-logs",
          table: "workflow_telemetry_logs",
        },
        status: "captured",
      }),
    ];
  },
});

export const createExternalHttpWorkflowTelemetrySink = (
  config: ExternalHttpWorkflowTelemetrySinkConfig
): WorkflowTelemetrySinkPort => ({
  async recordLogs(input) {
    const now = config.now?.() ?? new Date().toISOString();
    const payload = externalTelemetryBatch({
      generatedAt: now,
      logs: input.logs,
      runId: input.runId,
      workItemId: input.workItemId,
    });
    const headers = new Headers({
      "content-type": "application/json",
    });
    if (config.authorizationBearerToken !== undefined) {
      headers.set("authorization", `Bearer ${config.authorizationBearerToken}`);
    }

    const controller = new AbortController();
    const timeoutMs = Math.max(1, config.timeoutMs ?? 10_000);
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const response = await (config.fetch ?? fetch)(config.endpointUrl, {
        body: JSON.stringify(payload),
        headers,
        method: "POST",
        signal: controller.signal,
      });

      return externalTelemetryReceipt({
        endpointUrl: config.endpointUrl,
        logCount: response.ok ? input.logs.length : 0,
        now,
        runId: input.runId,
        ...(config.sinkId === undefined ? {} : { sinkId: config.sinkId }),
        status: response.ok ? "captured" : "blocked",
      });
    } catch {
      return externalTelemetryReceipt({
        endpointUrl: config.endpointUrl,
        logCount: 0,
        now,
        runId: input.runId,
        ...(config.sinkId === undefined ? {} : { sinkId: config.sinkId }),
        status: "blocked",
      });
    } finally {
      clearTimeout(timeoutId);
    }
  },
});

export const createCompositeWorkflowTelemetrySink = (
  sinks: readonly WorkflowTelemetrySinkPort[]
): WorkflowTelemetrySinkPort => ({
  async recordLogs(input): Promise<readonly WorkflowTelemetrySinkReceipt[]> {
    const receipts: WorkflowTelemetrySinkReceipt[] = [];
    for (const sink of sinks) {
      receipts.push(...(await sink.recordLogs(input)));
    }

    return receipts;
  },
});
