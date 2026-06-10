/// <reference types="@cloudflare/workers-types" />

import type { z } from "zod";

import { dreamMemoryRelayEndpointCatalog } from "./cloudflare-relay.ts";
import {
  DreamBackfillPlanDocumentSchema,
  DreamBackfillRunReceiptDocumentSchema,
  DreamCaptureReceiptDocumentSchema,
  DreamCorrelationGraphDocumentSchema,
  DreamHydrationDocumentSchema,
  DreamMemoryRelayBackfillPlanPayloadSchema,
  DreamMemoryRelayBackfillRunPayloadSchema,
  DreamMemoryRelayCaptureArtifactPayloadSchema,
  DreamMemoryRelayCaptureRunPayloadSchema,
  DreamMemoryRelayCorrelationPayloadSchema,
  DreamMemoryRelayHydrationPayloadSchema,
  DreamMemoryRelayInventoryPayloadSchema,
  DreamMemoryRelayRequestEnvelopeSchema,
  DreamMemoryRelaySearchPayloadSchema,
  DreamMemoryRelaySignalsPayloadSchema,
  DreamMemoryRelaySourceHealthPayloadSchema,
  DreamMemorySearchDocumentSchema,
  DreamSignalDocumentSchema,
  DreamSourceHealthDocumentSchema,
  DreamSourceInventoryDocumentSchema,
  dreamMemoryRelayResponseEnvelopeSchema,
} from "./schemas.ts";
import type {
  DreamBackfillPlanDocument,
  DreamBackfillRunReceiptDocument,
  DreamCaptureReceiptDocument,
  DreamCorrelationGraphDocument,
  DreamHydrationDocument,
  DreamMemoryRelayOperation,
  DreamMemoryRelayRequestEnvelope,
  DreamMemorySearchDocument,
  DreamSignalDocument,
  DreamSourceHealthDocument,
  DreamSourceInventoryDocument,
} from "./schemas.ts";
import type {
  DreamMemoryBackfillPort,
  DreamMemoryCapturePort,
  DreamMemoryCorrelationPort,
  DreamMemoryFabricPort,
  DreamMemoryFabricResult,
  DreamMemoryRetrievalPort,
  DreamMemorySignalPort,
} from "./workflow-node-adapter.ts";

export interface TrustedDreamMemoryRelayServerConfig {
  readonly dreamMemoryBackfill?: DreamMemoryBackfillPort;
  readonly dreamMemoryCapture?: DreamMemoryCapturePort;
  readonly dreamMemoryCorrelation?: DreamMemoryCorrelationPort;
  readonly dreamMemoryFabric: DreamMemoryFabricPort;
  readonly dreamMemoryRetrieval?: DreamMemoryRetrievalPort;
  readonly dreamMemorySignals?: DreamMemorySignalPort;
  readonly expectedBearerToken: string;
  readonly now?: () => string;
}

export interface TrustedDreamMemoryRelayRequestInput {
  readonly config: TrustedDreamMemoryRelayServerConfig;
  readonly request: Request;
}

type SupportedDreamRelayOperation =
  | "backfill-plan"
  | "backfill-run"
  | "capture-artifact"
  | "capture-run"
  | "correlate"
  | "hydrate"
  | "inventory"
  | "search"
  | "signals"
  | "source-health";

type SupportedDreamRelayDocument =
  | DreamBackfillPlanDocument
  | DreamBackfillRunReceiptDocument
  | DreamCaptureReceiptDocument
  | DreamCorrelationGraphDocument
  | DreamHydrationDocument
  | DreamMemorySearchDocument
  | DreamSignalDocument
  | DreamSourceHealthDocument
  | DreamSourceInventoryDocument;

const operationPathFor = (operation: DreamMemoryRelayOperation): string =>
  dreamMemoryRelayEndpointCatalog.endpoints.find(
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

const operationForRequest = (
  request: Request
): DreamMemoryRelayOperation | null => {
  const url = new URL(request.url);
  const endpoint = dreamMemoryRelayEndpointCatalog.endpoints.find(
    (candidate) => candidate.path === url.pathname
  );

  return endpoint?.operation ?? null;
};

const isSupportedOperation = (
  operation: DreamMemoryRelayOperation
): operation is SupportedDreamRelayOperation =>
  operation === "backfill-plan" ||
  operation === "backfill-run" ||
  operation === "capture-artifact" ||
  operation === "capture-run" ||
  operation === "correlate" ||
  operation === "hydrate" ||
  operation === "inventory" ||
  operation === "search" ||
  operation === "signals" ||
  operation === "source-health";

const sourceFreshnessFor = (document: SupportedDreamRelayDocument) => {
  if (document.schemaVersion === "dream.source-health.v1") {
    return document.indexHealth;
  }

  if (document.schemaVersion === "dream.source-inventory.v1") {
    return document.sources.flatMap((source) => source.derivedIndexes);
  }

  return [];
};

const sourceInventoryRefsFor = (document: SupportedDreamRelayDocument) => {
  if (document.schemaVersion === "dream.source-health.v1") {
    return [document.inventoryRef.artifactRef];
  }

  if (document.schemaVersion === "dream.backfill-plan.v1") {
    return [document.inventoryRef.artifactRef, document.healthRef.artifactRef];
  }

  if (document.schemaVersion === "dream.backfill-run-receipt.v1") {
    return [document.planRef.artifactRef];
  }

  if (document.schemaVersion === "dream.capture-receipt.v1") {
    return [document.capturedRef.artifactRef];
  }

  return [];
};

const unsupportedRetrievalResponse = (
  operation: "correlate" | "hydrate" | "search" | "signals"
): Response =>
  jsonError(
    501,
    "adapter_unavailable",
    `Dream memory relay operation ${operation} is not wired to a trusted retrieval adapter yet.`
  );

const responseEnvelope = <
  TDocument extends SupportedDreamRelayDocument,
>(input: {
  readonly document: TDocument;
  readonly documentSchema: z.ZodType<TDocument>;
  readonly envelope: DreamMemoryRelayRequestEnvelope;
  readonly now: string;
}) =>
  dreamMemoryRelayResponseEnvelopeSchema(input.documentSchema).parse({
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
    schemaVersion: "dream.memory-relay.response.v1",
    sourceFreshness: sourceFreshnessFor(input.document),
    sourceInventoryRefs: sourceInventoryRefsFor(input.document),
    workItemId: input.envelope.workItemId,
  });

const resultResponse = <TDocument extends SupportedDreamRelayDocument>(input: {
  readonly documentSchema: z.ZodType<TDocument>;
  readonly envelope: DreamMemoryRelayRequestEnvelope;
  readonly now: string;
  readonly result: DreamMemoryFabricResult<TDocument>;
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
  readonly config: TrustedDreamMemoryRelayServerConfig;
  readonly envelope: DreamMemoryRelayRequestEnvelope;
  readonly operation: SupportedDreamRelayOperation;
}): Promise<Response> => {
  const now = input.config.now?.() ?? new Date().toISOString();

  if (input.operation === "inventory") {
    const payload = DreamMemoryRelayInventoryPayloadSchema.parse(
      input.envelope.payload
    );
    const result = await input.config.dreamMemoryFabric.inventorySources({
      actor: payload.actor,
      requiredRuntimes: payload.requiredRuntimes,
      runId: payload.runId,
      sourceFamiliesExpected: payload.sourceFamiliesExpected,
      workItemId: payload.workItemId,
    });

    return resultResponse({
      documentSchema: DreamSourceInventoryDocumentSchema,
      envelope: input.envelope,
      now,
      result,
    });
  }

  if (input.operation === "search") {
    if (input.config.dreamMemoryRetrieval === undefined) {
      return unsupportedRetrievalResponse("search");
    }

    const payload = DreamMemoryRelaySearchPayloadSchema.parse(
      input.envelope.payload
    );
    const result =
      await input.config.dreamMemoryRetrieval.searchMemories(payload);

    return resultResponse({
      documentSchema: DreamMemorySearchDocumentSchema,
      envelope: input.envelope,
      now,
      result,
    });
  }

  if (input.operation === "signals") {
    if (input.config.dreamMemorySignals === undefined) {
      return unsupportedRetrievalResponse("signals");
    }

    const payload = DreamMemoryRelaySignalsPayloadSchema.parse(
      input.envelope.payload
    );
    const result = await input.config.dreamMemorySignals.mineSignals(payload);

    return resultResponse({
      documentSchema: DreamSignalDocumentSchema,
      envelope: input.envelope,
      now,
      result,
    });
  }

  if (input.operation === "hydrate") {
    if (input.config.dreamMemoryRetrieval === undefined) {
      return unsupportedRetrievalResponse("hydrate");
    }

    const payload = DreamMemoryRelayHydrationPayloadSchema.parse(
      input.envelope.payload
    );
    const result =
      await input.config.dreamMemoryRetrieval.hydrateMemories(payload);

    return resultResponse({
      documentSchema: DreamHydrationDocumentSchema,
      envelope: input.envelope,
      now,
      result,
    });
  }

  if (input.operation === "correlate") {
    if (input.config.dreamMemoryCorrelation === undefined) {
      return unsupportedRetrievalResponse("correlate");
    }

    const payload = DreamMemoryRelayCorrelationPayloadSchema.parse(
      input.envelope.payload
    );
    const result =
      await input.config.dreamMemoryCorrelation.correlateMemories(payload);

    return resultResponse({
      documentSchema: DreamCorrelationGraphDocumentSchema,
      envelope: input.envelope,
      now,
      result,
    });
  }

  if (input.operation === "source-health") {
    const payload = DreamMemoryRelaySourceHealthPayloadSchema.parse(
      input.envelope.payload
    );
    const result = await input.config.dreamMemoryFabric.checkSourceHealth({
      actor: payload.actor,
      inventory: payload.inventory,
      inventoryRef: payload.inventoryRef,
      runId: payload.runId,
      workItemId: payload.workItemId,
    });

    return resultResponse({
      documentSchema: DreamSourceHealthDocumentSchema,
      envelope: input.envelope,
      now,
      result,
    });
  }

  if (input.operation === "capture-artifact") {
    if (input.config.dreamMemoryCapture === undefined) {
      return jsonError(
        501,
        "adapter_unavailable",
        "Dream memory relay operation capture-artifact is not wired to a trusted capture adapter yet."
      );
    }

    const payload = DreamMemoryRelayCaptureArtifactPayloadSchema.parse(
      input.envelope.payload
    );
    const result =
      await input.config.dreamMemoryCapture.captureArtifact(payload);

    return resultResponse({
      documentSchema: DreamCaptureReceiptDocumentSchema,
      envelope: input.envelope,
      now,
      result,
    });
  }

  if (input.operation === "capture-run") {
    if (input.config.dreamMemoryCapture === undefined) {
      return jsonError(
        501,
        "adapter_unavailable",
        "Dream memory relay operation capture-run is not wired to a trusted capture adapter yet."
      );
    }

    const payload = DreamMemoryRelayCaptureRunPayloadSchema.parse(
      input.envelope.payload
    );
    const result = await input.config.dreamMemoryCapture.captureRun(payload);

    return resultResponse({
      documentSchema: DreamCaptureReceiptDocumentSchema,
      envelope: input.envelope,
      now,
      result,
    });
  }

  if (input.operation === "backfill-run") {
    if (input.config.dreamMemoryBackfill === undefined) {
      return jsonError(
        501,
        "adapter_unavailable",
        "Dream memory relay operation backfill-run is not wired to a trusted backfill adapter yet."
      );
    }

    const payload = DreamMemoryRelayBackfillRunPayloadSchema.parse(
      input.envelope.payload
    );
    const result = await input.config.dreamMemoryBackfill.runBackfill(payload);

    return resultResponse({
      documentSchema: DreamBackfillRunReceiptDocumentSchema,
      envelope: input.envelope,
      now,
      result,
    });
  }

  const payload = DreamMemoryRelayBackfillPlanPayloadSchema.parse(
    input.envelope.payload
  );
  const result = await input.config.dreamMemoryFabric.planBackfill({
    actor: payload.actor,
    health: payload.health,
    healthRef: payload.healthRef,
    inventory: payload.inventory,
    inventoryRef: payload.inventoryRef,
    runId: payload.runId,
    workItemId: payload.workItemId,
  });

  return resultResponse({
    documentSchema: DreamBackfillPlanDocumentSchema,
    envelope: input.envelope,
    now,
    result,
  });
};

export const handleTrustedDreamMemoryRelayRequest = async (
  input: TrustedDreamMemoryRelayRequestInput
): Promise<Response> => {
  if (input.request.method !== "POST") {
    return jsonError(405, "method_not_allowed", "Dream relay routes use POST.");
  }

  const operation = operationForRequest(input.request);
  if (operation === null) {
    return jsonError(404, "not_found", "Dream memory relay route not found.");
  }

  const token = bearerTokenFrom(input.request);
  if (token === null) {
    return jsonError(401, "missing_auth", "Missing relay bearer token.");
  }

  if (token !== input.config.expectedBearerToken) {
    return jsonError(403, "secret_denied", "Invalid relay bearer token.");
  }

  let envelope: DreamMemoryRelayRequestEnvelope;
  try {
    envelope = DreamMemoryRelayRequestEnvelopeSchema.parse(
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
      `Dream relay route ${operationPathFor(operation)} received operation ${envelope.operation}.`
    );
  }

  if (!isSupportedOperation(operation)) {
    return jsonError(
      501,
      "adapter_unavailable",
      `Dream memory relay operation ${String(operation)} is not wired to a trusted adapter yet.`
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
