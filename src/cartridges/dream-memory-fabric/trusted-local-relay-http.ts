import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import { z } from "zod";

import { IsoDateTimeSchema } from "../../app/domain/schemas.ts";
import { dreamMemoryRelayEndpointCatalog } from "./cloudflare-relay.ts";
import {
  DreamDerivedIndexStatusSchema,
  DreamMemoryRelayEndpointCatalogSchema,
  DreamPrivacyTierSchema,
  DreamRuntimeSchema,
  DreamSourceFamilySchema,
  DreamSourceScopeSchema,
} from "./schemas.ts";
import { createTrustedLocalDreamMemoryFabricAdapter } from "./trusted-local-memory-fabric.ts";
import type {
  TrustedLocalDreamDerivedIndexConfig,
  TrustedLocalDreamMemoryFabricConfig,
  TrustedLocalDreamSourceRoot,
} from "./trusted-local-memory-fabric.ts";
import { createTrustedLocalDreamMemoryRetrievalAdapter } from "./trusted-local-memory-retrieval.ts";
import type { TrustedDocsApiDreamMemoryRetrievalConfig } from "./trusted-local-memory-retrieval.ts";
import { handleTrustedDreamMemoryRelayRequest } from "./trusted-relay-server.ts";

export interface TrustedLocalDreamMemoryRelayHttpConfig {
  readonly docsApi?: TrustedDocsApiDreamMemoryRetrievalConfig;
  readonly expectedBearerToken: string;
  readonly host: string;
  readonly maxBodyBytes?: number;
  readonly memoryFabric: TrustedLocalDreamMemoryFabricConfig;
  readonly now?: () => string;
  readonly port: number;
}

export interface TrustedLocalDreamMemoryRelayHttpServer {
  readonly close: () => Promise<void>;
  readonly server: Server;
  readonly url: string;
}

export type TrustedLocalDreamMemoryRelayEnvironment = Readonly<
  Record<string, string | undefined>
>;

const DEFAULT_MAX_BODY_BYTES = 4_000_000;
const DEFAULT_MAX_FILES_PER_SOURCE = 10_000;
const DEFAULT_RELAY_HOST = "127.0.0.1";
const DEFAULT_RELAY_PORT = 8789;
const TRUSTED_LOCAL_PORT = "TrustedLocalDreamMemoryFabricPort";

const SupportedRelayOperationSchema = z.enum([
  "backfill-plan",
  "backfill-run",
  "capture-artifact",
  "capture-run",
  "correlate",
  "hydrate",
  "inventory",
  "search",
  "signals",
  "source-health",
]);

const TrustedLocalDreamDerivedIndexConfigSchema = z.object({
  derivedCount: z.number().int().min(0).optional(),
  indexId: z.string().min(1),
  indexKind: z.enum(["qmd", "sqlite", "typesense", "vector", "view"]),
  root: z.string().min(1).optional(),
  status: DreamDerivedIndexStatusSchema.optional(),
});

const TrustedLocalDreamSourceRootConfigSchema = z.object({
  authorityRoot: z.string().min(1),
  derivedIndexes: z.array(TrustedLocalDreamDerivedIndexConfigSchema).optional(),
  family: DreamSourceFamilySchema,
  includeExtensions: z.array(z.string().min(1)).optional(),
  label: z.string().min(1),
  privacyTier: DreamPrivacyTierSchema,
  runtime: DreamRuntimeSchema.optional(),
  scope: DreamSourceScopeSchema.optional(),
  sourceId: z.string().min(1),
  sourceSystem: z.string().min(1),
});

const TrustedLocalDreamSourceRootsConfigSchema = z
  .array(TrustedLocalDreamSourceRootConfigSchema)
  .min(1);

export const TrustedLocalDreamMemoryRelayReadinessReceiptSchema = z.object({
  adapter: z.object({
    port: z.literal(TRUSTED_LOCAL_PORT),
    sourceRoots: z
      .array(
        z.object({
          derivedIndexCount: z.number().int().min(0),
          family: DreamSourceFamilySchema,
          includeExtensionCount: z.number().int().min(0),
          privacyTier: DreamPrivacyTierSchema,
          runtime: DreamRuntimeSchema.optional(),
          sourceId: z.string().min(1),
        })
      )
      .min(1),
  }),
  auth: z.object({
    mode: z.literal("bearer"),
    required: z.literal(true),
  }),
  checkedAt: IsoDateTimeSchema,
  endpointCatalog: DreamMemoryRelayEndpointCatalogSchema,
  maxFilesPerSource: z.number().int().min(1),
  rawCredentialsReturned: z.literal(false),
  rawPathsReturned: z.literal(false),
  redacted: z.literal(true),
  schemaVersion: z.literal("trusted.dream-memory-relay.readiness.v1"),
  supportedOperations: z.array(SupportedRelayOperationSchema).min(1),
});

export type TrustedLocalDreamMemoryRelayReadinessReceipt = z.infer<
  typeof TrustedLocalDreamMemoryRelayReadinessReceiptSchema
>;

const normalizeDerivedIndex = (
  input: z.infer<typeof TrustedLocalDreamDerivedIndexConfigSchema>
): TrustedLocalDreamDerivedIndexConfig => ({
  ...(input.derivedCount === undefined
    ? {}
    : { derivedCount: input.derivedCount }),
  indexId: input.indexId,
  indexKind: input.indexKind,
  ...(input.root === undefined ? {} : { root: input.root }),
  ...(input.status === undefined ? {} : { status: input.status }),
});

const normalizeSourceRoot = (
  input: z.infer<typeof TrustedLocalDreamSourceRootConfigSchema>
): TrustedLocalDreamSourceRoot => ({
  authorityRoot: input.authorityRoot,
  ...(input.derivedIndexes === undefined
    ? {}
    : { derivedIndexes: input.derivedIndexes.map(normalizeDerivedIndex) }),
  family: input.family,
  ...(input.includeExtensions === undefined
    ? {}
    : { includeExtensions: input.includeExtensions }),
  label: input.label,
  privacyTier: input.privacyTier,
  ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
  ...(input.scope === undefined ? {} : { scope: input.scope }),
  sourceId: input.sourceId,
  sourceSystem: input.sourceSystem,
});

const parseSourceRootsJson = (
  sourceRootsJson: string
): TrustedLocalDreamSourceRoot[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sourceRootsJson);
  } catch {
    throw new TypeError(
      "DREAM_MEMORY_RELAY_SOURCE_ROOTS_JSON must be valid JSON."
    );
  }

  return TrustedLocalDreamSourceRootsConfigSchema.parse(parsed).map(
    normalizeSourceRoot
  );
};

const parsePositiveInt = (input: {
  readonly fallback: number;
  readonly name: string;
  readonly value: string | undefined;
}): number => {
  if (input.value === undefined || input.value.length === 0) {
    return input.fallback;
  }

  const value = input.value.trim();
  if (!/^\d+$/u.test(value)) {
    throw new TypeError(`${input.name} must be a positive integer.`);
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TypeError(`${input.name} must be a positive integer.`);
  }

  return parsed;
};

const requiredEnv = (input: {
  readonly env: TrustedLocalDreamMemoryRelayEnvironment;
  readonly name: string;
}): string => {
  const value = input.env[input.name];
  if (value === undefined || value.length === 0) {
    throw new TypeError(`${input.name} is required.`);
  }

  return value;
};

export const trustedLocalDreamMemoryRelayHttpConfigFromEnv = (
  env: TrustedLocalDreamMemoryRelayEnvironment
): TrustedLocalDreamMemoryRelayHttpConfig => {
  const sourceRoots = parseSourceRootsJson(
    requiredEnv({ env, name: "DREAM_MEMORY_RELAY_SOURCE_ROOTS_JSON" })
  );
  const maxFilesPerSource = parsePositiveInt({
    fallback: DEFAULT_MAX_FILES_PER_SOURCE,
    name: "DREAM_MEMORY_RELAY_MAX_FILES_PER_SOURCE",
    value: env["DREAM_MEMORY_RELAY_MAX_FILES_PER_SOURCE"],
  });

  return {
    ...(env["DREAM_DOCS_API_BASE_URL"] === undefined ||
    env["DREAM_DOCS_API_BASE_URL"].length === 0
      ? {}
      : {
          docsApi: {
            baseUrl: env["DREAM_DOCS_API_BASE_URL"],
            ...(env["DREAM_DOCS_API_USER_AGENT"] === undefined
              ? {}
              : { userAgent: env["DREAM_DOCS_API_USER_AGENT"] }),
          },
        }),
    expectedBearerToken: requiredEnv({
      env,
      name: "DREAM_MEMORY_RELAY_TOKEN",
    }),
    host: env["DREAM_MEMORY_RELAY_HOST"] ?? DEFAULT_RELAY_HOST,
    maxBodyBytes: parsePositiveInt({
      fallback: DEFAULT_MAX_BODY_BYTES,
      name: "DREAM_MEMORY_RELAY_MAX_BODY_BYTES",
      value: env["DREAM_MEMORY_RELAY_MAX_BODY_BYTES"],
    }),
    memoryFabric: {
      maxFilesPerSource,
      sourceRoots,
    },
    port: parsePositiveInt({
      fallback: DEFAULT_RELAY_PORT,
      name: "DREAM_MEMORY_RELAY_PORT",
      value: env["DREAM_MEMORY_RELAY_PORT"],
    }),
  };
};

const authorizationToken = (request: Request): null | string => {
  const authorization = request.headers.get("authorization");
  const prefix = "Bearer ";
  if (authorization === null || !authorization.startsWith(prefix)) {
    return null;
  }

  return authorization.slice(prefix.length);
};

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

const sourceRootSummary = (sourceRoot: TrustedLocalDreamSourceRoot) => ({
  derivedIndexCount: sourceRoot.derivedIndexes?.length ?? 0,
  family: sourceRoot.family,
  includeExtensionCount: sourceRoot.includeExtensions?.length ?? 0,
  privacyTier: sourceRoot.privacyTier,
  ...(sourceRoot.runtime === undefined ? {} : { runtime: sourceRoot.runtime }),
  sourceId: sourceRoot.sourceId,
});

export const trustedLocalDreamMemoryRelayReadinessReceipt = (input: {
  readonly config: TrustedLocalDreamMemoryRelayHttpConfig;
  readonly now?: string;
}): TrustedLocalDreamMemoryRelayReadinessReceipt =>
  TrustedLocalDreamMemoryRelayReadinessReceiptSchema.parse({
    adapter: {
      port: TRUSTED_LOCAL_PORT,
      sourceRoots: input.config.memoryFabric.sourceRoots.map(sourceRootSummary),
    },
    auth: {
      mode: "bearer",
      required: true,
    },
    checkedAt: input.now ?? input.config.now?.() ?? new Date().toISOString(),
    endpointCatalog: dreamMemoryRelayEndpointCatalog,
    maxFilesPerSource:
      input.config.memoryFabric.maxFilesPerSource ??
      DEFAULT_MAX_FILES_PER_SOURCE,
    rawCredentialsReturned: false,
    rawPathsReturned: false,
    redacted: true,
    schemaVersion: "trusted.dream-memory-relay.readiness.v1",
    supportedOperations: [
      "inventory",
      "source-health",
      "backfill-plan",
      "backfill-run",
      "capture-run",
      "capture-artifact",
      "signals",
      "search",
      "hydrate",
      "correlate",
    ],
  });

const healthResponse = (input: {
  readonly config: TrustedLocalDreamMemoryRelayHttpConfig;
  readonly request: Request;
}): Response => {
  const token = authorizationToken(input.request);
  if (token === null) {
    return jsonError(401, "missing_auth", "Missing relay bearer token.");
  }

  if (token !== input.config.expectedBearerToken) {
    return jsonError(403, "secret_denied", "Invalid relay bearer token.");
  }

  return Response.json(
    trustedLocalDreamMemoryRelayReadinessReceipt({
      config: input.config,
    })
  );
};

export const createTrustedLocalDreamMemoryRelayFetchHandler = (
  config: TrustedLocalDreamMemoryRelayHttpConfig
): ((request: Request) => Promise<Response>) => {
  const adapterNow = config.memoryFabric.now ?? config.now;
  const dreamMemoryRetrieval = createTrustedLocalDreamMemoryRetrievalAdapter({
    ...(config.docsApi === undefined ? {} : { docsApi: config.docsApi }),
    ...(config.memoryFabric.maxFilesPerSource === undefined
      ? {}
      : { maxFilesPerSource: config.memoryFabric.maxFilesPerSource }),
    ...(adapterNow === undefined ? {} : { now: adapterNow }),
    sourceRoots: config.memoryFabric.sourceRoots,
  });
  const dreamMemoryFabric = createTrustedLocalDreamMemoryFabricAdapter({
    ...config.memoryFabric,
    ...(adapterNow === undefined ? {} : { now: adapterNow }),
  });
  const relayConfig = {
    dreamMemoryBackfill: dreamMemoryFabric,
    dreamMemoryCapture: dreamMemoryFabric,
    dreamMemoryCorrelation: dreamMemoryRetrieval,
    dreamMemoryFabric,
    dreamMemoryRetrieval,
    dreamMemorySignals: dreamMemoryRetrieval,
    expectedBearerToken: config.expectedBearerToken,
    ...(config.now === undefined ? {} : { now: config.now }),
  };

  return (request) => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return Promise.resolve(healthResponse({ config, request }));
    }

    return handleTrustedDreamMemoryRelayRequest({
      config: relayConfig,
      request,
    });
  };
};

const headersFromIncomingMessage = (request: IncomingMessage): HeadersInit => {
  const headers = new Headers();

  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
      continue;
    }

    headers.set(key, value);
  }

  return headers;
};

const bodyFromIncomingMessage = async (input: {
  readonly maxBodyBytes: number;
  readonly request: IncomingMessage;
}): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of input.request as AsyncIterable<Buffer | string>) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += buffer.byteLength;
    if (size > input.maxBodyBytes) {
      throw new RangeError("Dream relay request body is too large.");
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
};

const requestUrl = (request: IncomingMessage): string => {
  const host = request.headers.host ?? "127.0.0.1";

  return new URL(request.url ?? "/", `http://${host}`).toString();
};

const requestFromIncomingMessage = async (input: {
  readonly maxBodyBytes: number;
  readonly request: IncomingMessage;
}): Promise<Request> => {
  const method = input.request.method ?? "GET";
  if (method === "GET" || method === "HEAD") {
    return new Request(requestUrl(input.request), {
      headers: headersFromIncomingMessage(input.request),
      method,
    });
  }

  return new Request(requestUrl(input.request), {
    body: await bodyFromIncomingMessage(input),
    headers: headersFromIncomingMessage(input.request),
    method,
  });
};

const writeResponse = async (input: {
  readonly response: Response;
  readonly serverResponse: ServerResponse;
}): Promise<void> => {
  input.serverResponse.statusCode = input.response.status;
  for (const [key, value] of input.response.headers) {
    input.serverResponse.setHeader(key, value);
  }
  input.serverResponse.end(Buffer.from(await input.response.arrayBuffer()));
};

const writeServerError = (input: {
  readonly error: unknown;
  readonly serverResponse: ServerResponse;
}): void => {
  const response = jsonError(
    input.error instanceof RangeError ? 413 : 500,
    input.error instanceof RangeError ? "request_too_large" : "relay_error",
    input.error instanceof Error
      ? input.error.message
      : "Dream relay server failed."
  );
  input.serverResponse.statusCode = response.status;
  input.serverResponse.setHeader("content-type", "application/json");
  input.serverResponse.end(
    JSON.stringify({
      error: {
        code:
          input.error instanceof RangeError
            ? "request_too_large"
            : "relay_error",
        message:
          input.error instanceof Error
            ? input.error.message
            : "Dream relay server failed.",
        redacted: true,
      },
    })
  );
};

export const startTrustedLocalDreamMemoryRelayHttpServer = async (
  config: TrustedLocalDreamMemoryRelayHttpConfig
): Promise<TrustedLocalDreamMemoryRelayHttpServer> => {
  const handler = createTrustedLocalDreamMemoryRelayFetchHandler(config);
  const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const server = createServer((request, serverResponse) => {
    void (async () => {
      try {
        await writeResponse({
          response: await handler(
            await requestFromIncomingMessage({
              maxBodyBytes,
              request,
            })
          ),
          serverResponse,
        });
      } catch (error) {
        writeServerError({ error, serverResponse });
      }
    })();
  });

  server.listen(config.port, config.host);
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Trusted local Dream relay did not expose a TCP address.");
  }

  return {
    close: async () => {
      const closed = once(server, "close");
      server.close();
      await closed;
    },
    server,
    url: `http://${config.host}:${address.port}`,
  };
};
