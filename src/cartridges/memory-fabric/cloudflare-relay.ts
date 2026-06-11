/// <reference types="@cloudflare/workers-types" />

import type { z } from "zod";

import type { CapabilityBlocker } from "../../app/domain/schemas.ts";
import {
  MemoryRelayOperationSchema,
  MemorySourceFamilySchema,
} from "../../app/domain/source-profile.ts";
import type {
  MemoryRelayOperation,
  MemorySourceFamily,
} from "../../app/domain/source-profile.ts";
import { workflowTraceContextForCapability } from "../../app/domain/trace-context.ts";
import {
  MemoryCorrelationGraphDocumentSchema,
  MemoryCaptureReceiptDocumentSchema,
  MemoryHydrationDocumentSchema,
  MemoryRelayCorrelationPayloadSchema,
  MemoryRelayCaptureArtifactPayloadSchema,
  MemoryRelayCaptureRunPayloadSchema,
  MemorySearchDocumentSchema,
  MemoryRelayRequestEnvelopeSchema,
  MemoryRelayEndpointCatalogSchema,
  MemoryRelaySignalsPayloadSchema,
  MemorySignalDocumentSchema,
  memoryRelayResponseEnvelopeSchema,
} from "./schemas.ts";
import type {
  MemoryCaptureReceiptDocument,
  MemoryCorrelationGraphDocument,
  MemoryHydrationDocument,
  MemoryRelayCaptureArtifactPayload,
  MemoryRelayCaptureRunPayload,
  MemoryRelayCorrelationPayload,
  MemoryRelayHydrationPayload,
  MemoryRelaySearchPayload,
  MemoryRelaySignalsPayload,
  MemorySearchDocument,
  MemoryReceiptRef,
  MemorySignalDocument,
} from "./schemas.ts";
import type {
  MemoryCapturePort,
  MemoryCorrelationPort,
  MemoryFabricResult,
  MemoryRetrievalPort,
  MemorySignalPort,
} from "./workflow-node-adapter.ts";

export interface MemoryRelayTokenSecretResolver {
  resolve(input: {
    readonly operation: MemoryRelayOperation;
    readonly runId: string;
    readonly secretRef: string;
    readonly workItemId: string;
  }): Promise<string | null>;
}

export interface CloudflareMemoryRelaySecretStringBinding {
  get(): Promise<null | string>;
}

export type CloudflareMemoryRelayTokenBinding =
  | CloudflareMemoryRelaySecretStringBinding
  | string;

export interface CloudflareMemoryRelayTokenResolverConfig {
  readonly secret: CloudflareMemoryRelayTokenBinding;
  readonly secretRef: string;
}

export interface CloudflareMemoryFabricRelayConfig {
  readonly budget?: {
    readonly maxFiles?: number;
    readonly maxRows?: number;
    readonly maxTokens?: number;
  };
  readonly fetch?: typeof fetch;
  readonly relayBaseUrl: string;
  readonly relaySecretRef: string;
  /**
   * Hard ceiling for a single relay round-trip. The relay reaches JoelClaw over
   * a tunnel and an all-time signals/search query can stall; without a bound the
   * fetch hangs until workerd kills the whole invocation (a wedged run that the
   * reaper sweeps with no reason). On timeout the operation returns a clean
   * `adapter_unavailable` blocker the safety envelope can record and surface.
   */
  readonly relayTimeoutMs?: number;
  readonly secretResolver: MemoryRelayTokenSecretResolver;
  readonly userAgent: string;
}

const DEFAULT_RELAY_TIMEOUT_MS = 30_000;

type MemoryRelayPayload =
  | MemoryRelayCaptureArtifactPayload
  | MemoryRelayCaptureRunPayload
  | MemoryRelayCorrelationPayload
  | MemoryRelayHydrationPayload
  | MemoryRelaySearchPayload
  | MemoryRelaySignalsPayload;

const allMemorySourceFamilies = MemorySourceFamilySchema.options;

const blocked = <TDocument>(
  code: CapabilityBlocker["code"],
  message: string
): MemoryFabricResult<TDocument> => ({
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
): MemoryFabricResult<TDocument> => {
  if (status === 401 || status === 403) {
    return blocked("secret_denied", "Memory relay rejected the token.");
  }

  if (status === 404) {
    return blocked(
      "adapter_unavailable",
      `Memory relay endpoint for ${operation} was not found.`
    );
  }

  return blocked(
    "adapter_unavailable",
    `Memory relay ${operation} failed with HTTP ${status}.`
  );
};

const operationPaths: Readonly<Record<MemoryRelayOperation, string>> = {
  "capture-artifact": "/memory/capture/artifact",
  "capture-run": "/memory/capture/run",
  correlate: "/memory/correlate",
  hydrate: "/memory/hydrate",
  search: "/memory/search",
  signals: "/memory/signals",
};

export const memoryRelayEndpointCatalog =
  MemoryRelayEndpointCatalogSchema.parse({
    endpoints: Object.entries(operationPaths).map(([operation, path]) => ({
      operation: MemoryRelayOperationSchema.parse(operation),
      path,
    })),
    schemaVersion: "memory.relay.endpoint-catalog.v1",
  });

const operationPath = (operation: MemoryRelayOperation): string =>
  operationPaths[operation];

const uniqueReceiptFamilies = (
  receipts: readonly MemoryReceiptRef[]
): readonly MemorySourceFamily[] => [
  ...new Set(receipts.map((receipt) => receipt.family)),
];

const payloadSourceFamilies = (
  payload: MemoryRelayPayload
): readonly MemorySourceFamily[] => {
  if ("query" in payload) {
    return payload.sourceFamilies ?? allMemorySourceFamilies;
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

  return allMemorySourceFamilies;
};

const payloadScope = (payload: MemoryRelayPayload) => ({
  organizationId: payload.actor.organizationId,
});

const relayRequestEnvelope = (input: {
  readonly budget: CloudflareMemoryFabricRelayConfig["budget"];
  readonly operation: MemoryRelayOperation;
  readonly payload: MemoryRelayPayload;
  readonly relaySecretRef: string;
}) =>
  MemoryRelayRequestEnvelopeSchema.parse({
    actor: input.payload.actor,
    allowedSourceFamilies: [...payloadSourceFamilies(input.payload)],
    budget: {
      maxFiles: input.budget?.maxFiles ?? 500,
      maxRows: input.budget?.maxRows ?? 1000,
      maxTokens: input.budget?.maxTokens ?? 100_000,
    },
    idempotencyKey: `memory-relay:${input.payload.runId}:${input.payload.workItemId}:${input.operation}`,
    lease: {
      capability: "memory.relay",
      leaseId: `lease:memory-relay:${input.payload.runId}:${input.payload.workItemId}:${input.operation}`,
      redacted: true,
      secretRef: input.relaySecretRef,
    },
    operation: input.operation,
    payload: input.payload,
    purpose: `Memory relay ${input.operation} for ${input.payload.runId}.`,
    redactionPolicy: {
      mode: "redacted-evidence",
      noCustomerDataInPublicArtifacts: true,
      noRawCredentials: true,
      noRawPrivatePaths: true,
      noRawTranscripts: true,
    },
    runId: input.payload.runId,
    schemaVersion: "memory.relay.request.v1",
    scope: payloadScope(input.payload),
    timeWindow: {
      label: "all-time",
    },
    traceContext: workflowTraceContextForCapability({
      capability: "memory.relay",
      runId: input.payload.runId,
      stepId: `memory-relay:${input.operation}`,
    }),
    workItemId: input.payload.workItemId,
  });

export const createCloudflareMemoryRelayTokenResolver = (
  config: CloudflareMemoryRelayTokenResolverConfig
): MemoryRelayTokenSecretResolver => ({
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

export const createCloudflareMemoryFabricRelay = (
  config: CloudflareMemoryFabricRelayConfig
): MemoryCorrelationPort &
  MemoryCapturePort &
  MemoryRetrievalPort &
  MemorySignalPort => {
  const fetcher = config.fetch ?? fetch;

  const postRelay = async <TDocument>(input: {
    readonly body: MemoryRelayPayload;
    readonly documentSchema: z.ZodType<TDocument>;
    readonly operation: MemoryRelayOperation;
    readonly runId: string;
    readonly workItemId: string;
  }): Promise<MemoryFabricResult<TDocument>> => {
    const token = await config.secretResolver.resolve({
      operation: input.operation,
      runId: input.runId,
      secretRef: config.relaySecretRef,
      workItemId: input.workItemId,
    });
    if (token === null) {
      return blocked("secret_denied", "Memory relay token is unavailable.");
    }

    const timeoutMs = config.relayTimeoutMs ?? DEFAULT_RELAY_TIMEOUT_MS;
    let response: Response;
    try {
      response = await fetcher(
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
          signal: AbortSignal.timeout(timeoutMs),
        }
      );
    } catch (error) {
      const reason =
        error instanceof Error && error.name === "TimeoutError"
          ? `did not respond within ${timeoutMs}ms`
          : `failed: ${error instanceof Error ? error.name : "network error"}`;

      return blocked(
        "adapter_unavailable",
        `Memory relay ${input.operation} ${reason}.`
      );
    }
    if (!response.ok) {
      return blockerForRelayStatus(response.status, input.operation);
    }

    try {
      const json = await response.json();
      const parsed = memoryRelayResponseEnvelopeSchema(
        input.documentSchema
      ).parse(json);
      if (parsed.operation !== input.operation) {
        return blocked(
          "adapter_unavailable",
          `Memory relay returned ${parsed.operation} for ${input.operation}.`
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
        `Memory relay ${input.operation} returned invalid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  };

  return {
    captureArtifact(input) {
      return postRelay<MemoryCaptureReceiptDocument>({
        body: MemoryRelayCaptureArtifactPayloadSchema.parse(input),
        documentSchema: MemoryCaptureReceiptDocumentSchema,
        operation: "capture-artifact",
        runId: input.runId,
        workItemId: input.workItemId,
      });
    },
    captureRun(input) {
      return postRelay<MemoryCaptureReceiptDocument>({
        body: MemoryRelayCaptureRunPayloadSchema.parse(input),
        documentSchema: MemoryCaptureReceiptDocumentSchema,
        operation: "capture-run",
        runId: input.runId,
        workItemId: input.workItemId,
      });
    },
    correlateMemories(input) {
      return postRelay<MemoryCorrelationGraphDocument>({
        body: MemoryRelayCorrelationPayloadSchema.parse(input),
        documentSchema: MemoryCorrelationGraphDocumentSchema,
        operation: "correlate",
        runId: input.runId,
        workItemId: input.workItemId,
      });
    },
    hydrateMemories(input) {
      return postRelay<MemoryHydrationDocument>({
        body: input,
        documentSchema: MemoryHydrationDocumentSchema,
        operation: "hydrate",
        runId: input.runId,
        workItemId: input.workItemId,
      });
    },
    mineSignals(input) {
      return postRelay<MemorySignalDocument>({
        body: MemoryRelaySignalsPayloadSchema.parse(input),
        documentSchema: MemorySignalDocumentSchema,
        operation: "signals",
        runId: input.runId,
        workItemId: input.workItemId,
      });
    },
    searchMemories(input) {
      return postRelay<MemorySearchDocument>({
        body: input,
        documentSchema: MemorySearchDocumentSchema,
        operation: "search",
        runId: input.runId,
        workItemId: input.workItemId,
      });
    },
  };
};
