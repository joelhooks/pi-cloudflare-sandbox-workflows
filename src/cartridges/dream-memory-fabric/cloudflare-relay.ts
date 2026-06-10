/// <reference types="@cloudflare/workers-types" />

import type { z } from "zod";

import type {
  Actor,
  ArtifactRef,
  CapabilityBlocker,
} from "../../app/domain/schemas.ts";
import { workflowTraceContextForCapability } from "../../app/domain/trace-context.ts";
import {
  DreamCorrelationGraphDocumentSchema,
  DreamCaptureReceiptDocumentSchema,
  DreamHydrationDocumentSchema,
  DreamMemoryRelayCorrelationPayloadSchema,
  DreamMemoryRelayCaptureArtifactPayloadSchema,
  DreamMemoryRelayCaptureRunPayloadSchema,
  DreamMemorySearchDocumentSchema,
  DreamMemoryRelayRequestEnvelopeSchema,
  DreamBackfillPlanDocumentSchema,
  DreamBackfillRunReceiptDocumentSchema,
  DreamMemoryRelayBackfillRunPayloadSchema,
  DreamMemoryRelayEndpointCatalogSchema,
  DreamMemoryRelayOperationSchema,
  DreamMemoryRelaySignalsPayloadSchema,
  DreamSignalDocumentSchema,
  DreamSourceFamilySchema,
  DreamSourceHealthDocumentSchema,
  DreamSourceInventoryDocumentSchema,
  dreamMemoryRelayResponseEnvelopeSchema,
} from "../../app/workflow-nodes/dream-memory-fabric-schemas.ts";
import type {
  DreamBackfillPlanDocument,
  DreamBackfillRunReceiptDocument,
  DreamCaptureReceiptDocument,
  DreamCorrelationGraphDocument,
  DreamHydrationDocument,
  DreamMemoryRelayCaptureArtifactPayload,
  DreamMemoryRelayCaptureRunPayload,
  DreamMemoryRelayCorrelationPayload,
  DreamMemoryRelayOperation,
  DreamMemoryRelayHydrationPayload,
  DreamMemoryRelaySearchPayload,
  DreamMemoryRelayBackfillRunPayload,
  DreamMemoryRelaySignalsPayload,
  DreamMemorySearchDocument,
  DreamReceiptRef,
  DreamSignalDocument,
  DreamSourceHealthDocument,
  DreamSourceFamily,
  DreamSourceInventoryDocument,
} from "../../app/workflow-nodes/dream-memory-fabric-schemas.ts";
import type {
  DreamMemoryBackfillPort,
  DreamMemoryCapturePort,
  DreamMemoryCorrelationPort,
  DreamMemoryFabricPort,
  DreamMemoryFabricResult,
  DreamMemoryRetrievalPort,
  DreamMemorySignalPort,
} from "../../app/workflow-nodes/dream-memory-fabric.ts";

export interface DreamMemoryRelayTokenSecretResolver {
  resolve(input: {
    readonly operation: DreamMemoryRelayOperation;
    readonly runId: string;
    readonly secretRef: string;
    readonly workItemId: string;
  }): Promise<string | null>;
}

export interface CloudflareDreamMemoryRelaySecretStringBinding {
  get(): Promise<null | string>;
}

export type CloudflareDreamMemoryRelayTokenBinding =
  | CloudflareDreamMemoryRelaySecretStringBinding
  | string;

export interface CloudflareDreamMemoryRelayTokenResolverConfig {
  readonly secret: CloudflareDreamMemoryRelayTokenBinding;
  readonly secretRef: string;
}

export interface CloudflareDreamMemoryFabricRelayConfig {
  readonly budget?: {
    readonly maxFiles?: number;
    readonly maxRows?: number;
    readonly maxTokens?: number;
  };
  readonly fetch?: typeof fetch;
  readonly relayBaseUrl: string;
  readonly relaySecretRef: string;
  readonly secretResolver: DreamMemoryRelayTokenSecretResolver;
  readonly userAgent: string;
}

interface DreamRelayPayloadBase {
  readonly actor: Actor;
  readonly runId: string;
  readonly workItemId: string;
}

interface DreamRelayInventoryPayload extends DreamRelayPayloadBase {
  readonly requiredRuntimes: readonly string[];
  readonly sourceFamiliesExpected: readonly DreamSourceFamily[];
}

interface DreamRelaySourceHealthPayload extends DreamRelayPayloadBase {
  readonly inventory: DreamSourceInventoryDocument;
  readonly inventoryRef: ArtifactRef;
}

interface DreamRelayBackfillPlanPayload extends DreamRelayPayloadBase {
  readonly health: DreamSourceHealthDocument;
  readonly healthRef: ArtifactRef;
  readonly inventory: DreamSourceInventoryDocument;
  readonly inventoryRef: ArtifactRef;
}

type DreamRelayPayload =
  | DreamRelayBackfillPlanPayload
  | DreamMemoryRelayBackfillRunPayload
  | DreamMemoryRelayCaptureArtifactPayload
  | DreamMemoryRelayCaptureRunPayload
  | DreamMemoryRelayCorrelationPayload
  | DreamMemoryRelayHydrationPayload
  | DreamMemoryRelaySearchPayload
  | DreamMemoryRelaySignalsPayload
  | DreamRelayInventoryPayload
  | DreamRelaySourceHealthPayload;

const allDreamSourceFamilies = DreamSourceFamilySchema.options;

const blocked = <TDocument>(
  code: CapabilityBlocker["code"],
  message: string
): DreamMemoryFabricResult<TDocument> => ({
  blocker: {
    code,
    message,
    redacted: true,
  },
  status: "blocked",
});

const relayUrl = (baseUrl: string, path: string): string => {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;

  return new URL(path.replace(/^\//u, ""), normalizedBase).toString();
};

const blockerForRelayStatus = <TDocument>(
  status: number,
  operation: string
): DreamMemoryFabricResult<TDocument> => {
  if (status === 401 || status === 403) {
    return blocked("secret_denied", "Dream memory relay rejected the token.");
  }

  if (status === 404) {
    return blocked(
      "adapter_unavailable",
      `Dream memory relay endpoint for ${operation} was not found.`
    );
  }

  return blocked(
    "adapter_unavailable",
    `Dream memory relay ${operation} failed with HTTP ${status}.`
  );
};

const operationPaths: Readonly<Record<DreamMemoryRelayOperation, string>> = {
  "backfill-plan": "/memory/backfill/plan",
  "backfill-run": "/memory/backfill/run",
  "capture-artifact": "/memory/capture/artifact",
  "capture-run": "/memory/capture/run",
  correlate: "/memory/correlate",
  hydrate: "/memory/hydrate",
  inventory: "/memory/inventory",
  search: "/memory/search",
  signals: "/memory/signals",
  "source-health": "/memory/source-health",
};

export const dreamMemoryRelayEndpointCatalog =
  DreamMemoryRelayEndpointCatalogSchema.parse({
    endpoints: Object.entries(operationPaths).map(([operation, path]) => ({
      operation: DreamMemoryRelayOperationSchema.parse(operation),
      path,
    })),
    schemaVersion: "dream.memory-relay.endpoint-catalog.v1",
  });

const operationPath = (operation: DreamMemoryRelayOperation): string =>
  operationPaths[operation];

const uniqueReceiptFamilies = (
  receipts: readonly DreamReceiptRef[]
): readonly DreamSourceFamily[] => [
  ...new Set(receipts.map((receipt) => receipt.family)),
];

const payloadSourceFamilies = (
  payload: DreamRelayPayload
): readonly DreamSourceFamily[] => {
  if ("sourceFamiliesExpected" in payload) {
    return payload.sourceFamiliesExpected;
  }

  if ("query" in payload) {
    return payload.sourceFamilies ?? allDreamSourceFamilies;
  }

  if ("receipts" in payload) {
    return uniqueReceiptFamilies(payload.receipts);
  }

  if ("sourceFamilies" in payload && payload.sourceFamilies !== undefined) {
    return payload.sourceFamilies;
  }

  if ("hydration" in payload) {
    return uniqueReceiptFamilies(
      payload.hydration.hydrated.map((hydrated) => hydrated.receipt)
    );
  }

  if ("plan" in payload) {
    const plannedFamilies = payload.plan.actions.map(
      (action) => action.sourceFamily
    );

    return plannedFamilies.length === 0
      ? allDreamSourceFamilies
      : [...new Set(plannedFamilies)];
  }

  if ("inventory" in payload) {
    return payload.inventory.sourceFamiliesExpected;
  }

  return allDreamSourceFamilies;
};

const payloadScope = (payload: DreamRelayPayload) => {
  if ("inventory" in payload) {
    return payload.inventory.scope;
  }

  return {
    organizationId: payload.actor.organizationId,
  };
};

const relayRequestEnvelope = (input: {
  readonly budget: CloudflareDreamMemoryFabricRelayConfig["budget"];
  readonly operation: DreamMemoryRelayOperation;
  readonly payload: DreamRelayPayload;
  readonly relaySecretRef: string;
}) =>
  DreamMemoryRelayRequestEnvelopeSchema.parse({
    actor: input.payload.actor,
    allowedSourceFamilies: [...payloadSourceFamilies(input.payload)],
    budget: {
      maxFiles: input.budget?.maxFiles ?? 500,
      maxRows: input.budget?.maxRows ?? 1000,
      maxTokens: input.budget?.maxTokens ?? 100_000,
    },
    idempotencyKey: `dream-memory-relay:${input.payload.runId}:${input.payload.workItemId}:${input.operation}`,
    lease: {
      capability: "dream.memory.relay",
      leaseId: `lease:dream-memory-relay:${input.payload.runId}:${input.payload.workItemId}:${input.operation}`,
      redacted: true,
      secretRef: input.relaySecretRef,
    },
    operation: input.operation,
    payload: input.payload,
    purpose: `Dream memory ${input.operation} for ${input.payload.runId}.`,
    redactionPolicy: {
      mode: "redacted-evidence",
      noCustomerDataInPublicArtifacts: true,
      noRawCredentials: true,
      noRawPrivatePaths: true,
      noRawTranscripts: true,
    },
    runId: input.payload.runId,
    schemaVersion: "dream.memory-relay.request.v1",
    scope: payloadScope(input.payload),
    timeWindow: {
      label: "all-time",
    },
    traceContext: workflowTraceContextForCapability({
      capability: "dream.memory.relay",
      runId: input.payload.runId,
      stepId: `dream-memory-relay:${input.operation}`,
    }),
    workItemId: input.payload.workItemId,
  });

export const createCloudflareDreamMemoryRelayTokenResolver = (
  config: CloudflareDreamMemoryRelayTokenResolverConfig
): DreamMemoryRelayTokenSecretResolver => ({
  async resolve(input) {
    if (input.secretRef !== config.secretRef) {
      return null;
    }

    if (typeof config.secret === "string") {
      return config.secret.length === 0 ? null : config.secret;
    }

    const secret = await config.secret.get();

    return secret === null || secret.length === 0 ? null : secret;
  },
});

export const createCloudflareDreamMemoryFabricRelay = (
  config: CloudflareDreamMemoryFabricRelayConfig
): DreamMemoryCorrelationPort &
  DreamMemoryBackfillPort &
  DreamMemoryCapturePort &
  DreamMemoryFabricPort &
  DreamMemoryRetrievalPort &
  DreamMemorySignalPort => {
  const fetcher = config.fetch ?? fetch;

  const postRelay = async <TDocument>(input: {
    readonly body: DreamRelayPayload;
    readonly documentSchema: z.ZodType<TDocument>;
    readonly operation: DreamMemoryRelayOperation;
    readonly runId: string;
    readonly workItemId: string;
  }): Promise<DreamMemoryFabricResult<TDocument>> => {
    const token = await config.secretResolver.resolve({
      operation: input.operation,
      runId: input.runId,
      secretRef: config.relaySecretRef,
      workItemId: input.workItemId,
    });
    if (token === null) {
      return blocked(
        "secret_denied",
        "Dream memory relay token is unavailable."
      );
    }

    const response = await fetcher(
      relayUrl(config.relayBaseUrl, operationPath(input.operation)),
      {
        body: JSON.stringify(
          relayRequestEnvelope({
            budget: config.budget,
            operation: input.operation,
            payload: input.body,
            relaySecretRef: config.relaySecretRef,
          })
        ),
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "user-agent": config.userAgent,
        },
        method: "POST",
      }
    );
    if (!response.ok) {
      return blockerForRelayStatus(response.status, input.operation);
    }

    try {
      const json = await response.json();
      const parsed = dreamMemoryRelayResponseEnvelopeSchema(
        input.documentSchema
      ).parse(json);
      if (parsed.operation !== input.operation) {
        return blocked(
          "adapter_unavailable",
          `Dream memory relay returned ${parsed.operation} for ${input.operation}.`
        );
      }

      return {
        document: parsed.document,
        relayLeaseReceipt: parsed.leaseReceipt,
        status: "ready",
      };
    } catch (error) {
      return blocked(
        "adapter_unavailable",
        `Dream memory relay ${input.operation} returned invalid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  };

  return {
    captureArtifact(input) {
      return postRelay<DreamCaptureReceiptDocument>({
        body: DreamMemoryRelayCaptureArtifactPayloadSchema.parse(input),
        documentSchema: DreamCaptureReceiptDocumentSchema,
        operation: "capture-artifact",
        runId: input.runId,
        workItemId: input.workItemId,
      });
    },
    captureRun(input) {
      return postRelay<DreamCaptureReceiptDocument>({
        body: DreamMemoryRelayCaptureRunPayloadSchema.parse(input),
        documentSchema: DreamCaptureReceiptDocumentSchema,
        operation: "capture-run",
        runId: input.runId,
        workItemId: input.workItemId,
      });
    },
    checkSourceHealth(input) {
      return postRelay<DreamSourceHealthDocument>({
        body: input,
        documentSchema: DreamSourceHealthDocumentSchema,
        operation: "source-health",
        runId: input.runId,
        workItemId: input.workItemId,
      });
    },
    correlateMemories(input) {
      return postRelay<DreamCorrelationGraphDocument>({
        body: DreamMemoryRelayCorrelationPayloadSchema.parse(input),
        documentSchema: DreamCorrelationGraphDocumentSchema,
        operation: "correlate",
        runId: input.runId,
        workItemId: input.workItemId,
      });
    },
    hydrateMemories(input) {
      return postRelay<DreamHydrationDocument>({
        body: input,
        documentSchema: DreamHydrationDocumentSchema,
        operation: "hydrate",
        runId: input.runId,
        workItemId: input.workItemId,
      });
    },
    inventorySources(input) {
      return postRelay<DreamSourceInventoryDocument>({
        body: input,
        documentSchema: DreamSourceInventoryDocumentSchema,
        operation: "inventory",
        runId: input.runId,
        workItemId: input.workItemId,
      });
    },
    mineSignals(input) {
      return postRelay<DreamSignalDocument>({
        body: DreamMemoryRelaySignalsPayloadSchema.parse(input),
        documentSchema: DreamSignalDocumentSchema,
        operation: "signals",
        runId: input.runId,
        workItemId: input.workItemId,
      });
    },
    planBackfill(input) {
      return postRelay<DreamBackfillPlanDocument>({
        body: input,
        documentSchema: DreamBackfillPlanDocumentSchema,
        operation: "backfill-plan",
        runId: input.runId,
        workItemId: input.workItemId,
      });
    },
    runBackfill(input) {
      return postRelay<DreamBackfillRunReceiptDocument>({
        body: DreamMemoryRelayBackfillRunPayloadSchema.parse(input),
        documentSchema: DreamBackfillRunReceiptDocumentSchema,
        operation: "backfill-run",
        runId: input.runId,
        workItemId: input.workItemId,
      });
    },
    searchMemories(input) {
      return postRelay<DreamMemorySearchDocument>({
        body: input,
        documentSchema: DreamMemorySearchDocumentSchema,
        operation: "search",
        runId: input.runId,
        workItemId: input.workItemId,
      });
    },
  };
};
