/// <reference types="@cloudflare/workers-types" />

import type { z } from "zod";

import type { MemoryRelayOperation } from "../../app/domain/source-profile.ts";
import { memoryRelayEndpointCatalog } from "./cloudflare-relay.ts";
import {
  MemoryCaptureReceiptDocumentSchema,
  MemoryCorrelationGraphDocumentSchema,
  MemoryHydrationDocumentSchema,
  MemoryRelayCaptureArtifactPayloadSchema,
  MemoryRelayCaptureRunPayloadSchema,
  MemoryRelayCorrelationPayloadSchema,
  MemoryRelayHydrationPayloadSchema,
  MemoryRelayRequestEnvelopeSchema,
  MemoryRelaySearchPayloadSchema,
  MemoryRelaySignalsPayloadSchema,
  MemorySearchDocumentSchema,
  MemorySignalDocumentSchema,
  memoryRelayResponseEnvelopeSchema,
} from "./schemas.ts";
import type {
  MemoryCaptureReceiptDocument,
  MemoryCorrelationGraphDocument,
  MemoryHydrationDocument,
  MemoryRelayRequestEnvelope,
  MemorySearchDocument,
  MemorySignalDocument,
} from "./schemas.ts";
import type {
  MemoryCapturePort,
  MemoryCorrelationPort,
  MemoryFabricResult,
  MemoryRetrievalPort,
  MemorySignalPort,
} from "./workflow-node-adapter.ts";

export interface TrustedMemoryRelayServerConfig {
  readonly memoryCapture?: MemoryCapturePort;
  readonly memoryCorrelation?: MemoryCorrelationPort;
  readonly memoryRetrieval?: MemoryRetrievalPort;
  readonly memorySignals?: MemorySignalPort;
  readonly expectedBearerToken: string;
  readonly now?: () => string;
}

export interface TrustedMemoryRelayRequestInput {
  readonly config: TrustedMemoryRelayServerConfig;
  readonly request: Request;
}

type SupportedMemoryRelayOperation =
  | "capture-artifact"
  | "capture-run"
  | "correlate"
  | "hydrate"
  | "search"
  | "signals";

type SupportedMemoryRelayDocument =
  | MemoryCaptureReceiptDocument
  | MemoryCorrelationGraphDocument
  | MemoryHydrationDocument
  | MemorySearchDocument
  | MemorySignalDocument;

const operationPathFor = (operation: MemoryRelayOperation): string =>
  memoryRelayEndpointCatalog.endpoints.find(
    (endpoint) => endpoint.operation === operation
  )?.path ?? `/memory/${operation}`;

const jsonError = (status: number, code: string, message: string): Response =>
  Response.json(
    {
      error: {
        code,
        message,
        redacted: true,
      },
    },
    { status }
  );

const bearerTokenFrom = (request: Request): null | string => {
  const authorization = request.headers.get("authorization");
  const prefix = "Bearer ";
  if (authorization === null || !authorization.startsWith(prefix)) {
    return null;
  }

  return authorization.slice(prefix.length);
};

const parseJsonRequest = async (request: Request): Promise<unknown> => {
  try {
    return await request.json();
  } catch {
    throw new TypeError("Request body must be JSON.");
  }
};

const operationForRequest = (request: Request): MemoryRelayOperation | null => {
  const url = new URL(request.url);
  const endpoint = memoryRelayEndpointCatalog.endpoints.find(
    (candidate) => candidate.path === url.pathname
  );

  return endpoint?.operation ?? null;
};

const isSupportedOperation = (
  operation: MemoryRelayOperation
): operation is SupportedMemoryRelayOperation =>
  operation === "capture-artifact" ||
  operation === "capture-run" ||
  operation === "correlate" ||
  operation === "hydrate" ||
  operation === "search" ||
  operation === "signals";

const unsupportedRetrievalResponse = (
  operation: "correlate" | "hydrate" | "search" | "signals"
): Response =>
  jsonError(
    501,
    "adapter_unavailable",
    `Memory relay operation ${operation} is not wired to a trusted retrieval adapter yet.`
  );

const responseEnvelope = <
  TDocument extends SupportedMemoryRelayDocument,
>(input: {
  readonly document: TDocument;
  readonly documentSchema: z.ZodType<TDocument>;
  readonly envelope: MemoryRelayRequestEnvelope;
  readonly now: string;
}) =>
  memoryRelayResponseEnvelopeSchema(input.documentSchema).parse({
    document: input.document,
    followUpLinks: [],
    leaseReceipt: {
      ...input.envelope.lease,
      status: "used",
      usedAt: input.now,
    },
    missingSources: [],
    operation: input.envelope.operation,
    redacted: true,
    runId: input.envelope.runId,
    schemaVersion: "memory.relay.response.v1",
    workItemId: input.envelope.workItemId,
  });

const resultResponse = <TDocument extends SupportedMemoryRelayDocument>(input: {
  readonly documentSchema: z.ZodType<TDocument>;
  readonly envelope: MemoryRelayRequestEnvelope;
  readonly now: string;
  readonly result: MemoryFabricResult<TDocument>;
}): Response => {
  if (input.result.status === "blocked") {
    return Response.json(
      {
        error: input.result.blocker,
      },
      { status: 409 }
    );
  }

  return Response.json(
    responseEnvelope({
      document: input.result.document,
      documentSchema: input.documentSchema,
      envelope: input.envelope,
      now: input.now,
    })
  );
};

const dispatchSupportedOperation = async (input: {
  readonly config: TrustedMemoryRelayServerConfig;
  readonly envelope: MemoryRelayRequestEnvelope;
  readonly operation: SupportedMemoryRelayOperation;
}): Promise<Response> => {
  const now = input.config.now?.() ?? new Date().toISOString();

  if (input.operation === "search") {
    if (input.config.memoryRetrieval === undefined) {
      return unsupportedRetrievalResponse("search");
    }

    const payload = MemoryRelaySearchPayloadSchema.parse(
      input.envelope.payload
    );
    const result = await input.config.memoryRetrieval.searchMemories(payload);

    return resultResponse({
      documentSchema: MemorySearchDocumentSchema,
      envelope: input.envelope,
      now,
      result,
    });
  }

  if (input.operation === "signals") {
    if (input.config.memorySignals === undefined) {
      return unsupportedRetrievalResponse("signals");
    }

    const payload = MemoryRelaySignalsPayloadSchema.parse(
      input.envelope.payload
    );
    const result = await input.config.memorySignals.mineSignals(payload);

    return resultResponse({
      documentSchema: MemorySignalDocumentSchema,
      envelope: input.envelope,
      now,
      result,
    });
  }

  if (input.operation === "hydrate") {
    if (input.config.memoryRetrieval === undefined) {
      return unsupportedRetrievalResponse("hydrate");
    }

    const payload = MemoryRelayHydrationPayloadSchema.parse(
      input.envelope.payload
    );
    const result = await input.config.memoryRetrieval.hydrateMemories(payload);

    return resultResponse({
      documentSchema: MemoryHydrationDocumentSchema,
      envelope: input.envelope,
      now,
      result,
    });
  }

  if (input.operation === "correlate") {
    if (input.config.memoryCorrelation === undefined) {
      return unsupportedRetrievalResponse("correlate");
    }

    const payload = MemoryRelayCorrelationPayloadSchema.parse(
      input.envelope.payload
    );
    const result =
      await input.config.memoryCorrelation.correlateMemories(payload);

    return resultResponse({
      documentSchema: MemoryCorrelationGraphDocumentSchema,
      envelope: input.envelope,
      now,
      result,
    });
  }

  if (input.operation === "capture-artifact") {
    if (input.config.memoryCapture === undefined) {
      return jsonError(
        501,
        "adapter_unavailable",
        "Memory relay operation capture-artifact is not wired to a trusted capture adapter yet."
      );
    }

    const payload = MemoryRelayCaptureArtifactPayloadSchema.parse(
      input.envelope.payload
    );
    const result = await input.config.memoryCapture.captureArtifact(payload);

    return resultResponse({
      documentSchema: MemoryCaptureReceiptDocumentSchema,
      envelope: input.envelope,
      now,
      result,
    });
  }

  if (input.config.memoryCapture === undefined) {
    return jsonError(
      501,
      "adapter_unavailable",
      "Memory relay operation capture-run is not wired to a trusted capture adapter yet."
    );
  }

  const payload = MemoryRelayCaptureRunPayloadSchema.parse(
    input.envelope.payload
  );
  const result = await input.config.memoryCapture.captureRun(payload);

  return resultResponse({
    documentSchema: MemoryCaptureReceiptDocumentSchema,
    envelope: input.envelope,
    now,
    result,
  });
};

export const handleTrustedMemoryRelayRequest = async (
  input: TrustedMemoryRelayRequestInput
): Promise<Response> => {
  if (input.request.method !== "POST") {
    return jsonError(
      405,
      "method_not_allowed",
      "Memory relay routes use POST."
    );
  }

  const operation = operationForRequest(input.request);
  if (operation === null) {
    return jsonError(404, "not_found", "Memory relay route not found.");
  }

  const token = bearerTokenFrom(input.request);
  if (token === null) {
    return jsonError(401, "missing_auth", "Missing relay bearer token.");
  }

  if (token !== input.config.expectedBearerToken) {
    return jsonError(403, "secret_denied", "Invalid relay bearer token.");
  }

  let envelope: MemoryRelayRequestEnvelope;
  try {
    envelope = MemoryRelayRequestEnvelopeSchema.parse(
      await parseJsonRequest(input.request)
    );
  } catch (error) {
    return jsonError(
      400,
      "invalid_json",
      error instanceof Error ? error.message : "Invalid relay request body."
    );
  }

  if (envelope.operation !== operation) {
    return jsonError(
      400,
      "operation_mismatch",
      `Memory relay route ${operationPathFor(operation)} received operation ${envelope.operation}.`
    );
  }

  if (!isSupportedOperation(operation)) {
    return jsonError(
      501,
      "adapter_unavailable",
      `Memory relay operation ${String(operation)} is not wired to a trusted adapter yet.`
    );
  }

  try {
    return await dispatchSupportedOperation({
      config: input.config,
      envelope,
      operation,
    });
  } catch (error) {
    return jsonError(
      400,
      "invalid_json",
      error instanceof Error
        ? error.message
        : "Invalid relay operation payload."
    );
  }
};
