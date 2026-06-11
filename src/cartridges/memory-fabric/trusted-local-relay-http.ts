import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import { z } from "zod";

import { IsoDateTimeSchema } from "../../app/domain/schemas.ts";
import { timingSafeSecretMatch } from "../../app/domain/secret-compare.ts";
import {
  MemoryPrivacyTierSchema,
  MemoryRuntimeSchema,
  MemorySourceFamilySchema,
  MemorySourceScopeSchema,
} from "../../app/domain/source-profile.ts";
import { memoryRelayEndpointCatalog } from "./cloudflare-relay.ts";
import { MemoryRelayEndpointCatalogSchema } from "./schemas.ts";
import { trustedJoelClawSessionSourceForAuthorityRoot } from "./trusted-joelclaw-session-source.ts";
import { createTrustedLocalMemoryFabricAdapter } from "./trusted-local-memory-fabric.ts";
import type {
  TrustedLocalMemoryFabricConfig,
  TrustedLocalMemorySourceRoot,
} from "./trusted-local-memory-fabric.ts";
import { createTrustedLocalMemoryRetrievalAdapter } from "./trusted-local-memory-retrieval.ts";
import type { TrustedDocsApiMemoryRetrievalConfig } from "./trusted-local-memory-retrieval.ts";
import { handleTrustedMemoryRelayRequest } from "./trusted-relay-server.ts";

export interface TrustedLocalMemoryRelayHttpConfig {
  readonly docsApi?: TrustedDocsApiMemoryRetrievalConfig;
  readonly expectedBearerToken: string;
  readonly host: string;
  readonly maxBodyBytes?: number;
  readonly memoryFabric: TrustedLocalMemoryFabricConfig;
  readonly now?: () => string;
  readonly port: number;
}

export interface TrustedLocalMemoryRelayHttpServer {
  readonly close: () => Promise<void>;
  readonly server: Server;
  readonly url: string;
}

export type TrustedLocalMemoryRelayEnvironment = Readonly<
  Record<string, string | undefined>
>;

const DEFAULT_MAX_BODY_BYTES = 4_000_000;
const DEFAULT_MAX_FILES_PER_SOURCE = 10_000;
const DEFAULT_RELAY_HOST = "127.0.0.1";
const DEFAULT_RELAY_PORT = 8789;
const TRUSTED_LOCAL_PORT = "TrustedLocalMemoryFabricPort";

const SupportedRelayOperationSchema = z.enum([
  "capture-artifact",
  "capture-run",
  "correlate",
  "hydrate",
  "search",
  "signals",
]);

const TrustedLocalMemorySourceRootConfigSchema = z
  .object({
    authorityRoot: z.string().min(1),
    family: MemorySourceFamilySchema,
    includeExtensions: z.array(z.string().min(1)).optional(),
    label: z.string().min(1),
    privacyTier: MemoryPrivacyTierSchema,
    runtime: MemoryRuntimeSchema.optional(),
    scope: MemorySourceScopeSchema.optional(),
    sourceId: z.string().min(1),
    sourceSystem: z.string().min(1),
  })
  .superRefine((sourceRoot, context) => {
    if (
      sourceRoot.family === "agent-transcripts" &&
      trustedJoelClawSessionSourceForAuthorityRoot(
        sourceRoot.authorityRoot,
        sourceRoot.runtime
      ) === null
    ) {
      context.addIssue({
        code: "custom",
        message:
          "agent-transcripts source roots must use a joelclaw+index:// authority root; per-machine filesystem transcript roots were removed.",
        path: ["authorityRoot"],
      });
    }
  });

const TrustedLocalMemorySourceRootsConfigSchema = z
  .array(TrustedLocalMemorySourceRootConfigSchema)
  .min(1);

export const TrustedLocalMemoryRelayReadinessReceiptSchema = z.object({
  adapter: z.object({
    port: z.literal(TRUSTED_LOCAL_PORT),
    sourceRoots: z
      .array(
        z.object({
          family: MemorySourceFamilySchema,
          includeExtensionCount: z.number().int().min(0),
          privacyTier: MemoryPrivacyTierSchema,
          runtime: MemoryRuntimeSchema.optional(),
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
  endpointCatalog: MemoryRelayEndpointCatalogSchema,
  maxFilesPerSource: z.number().int().min(1),
  rawCredentialsReturned: z.literal(false),
  rawPathsReturned: z.literal(false),
  redacted: z.literal(true),
  schemaVersion: z.literal("trusted.memory-relay.readiness.v1"),
  supportedOperations: z.array(SupportedRelayOperationSchema).min(1),
});

export type TrustedLocalMemoryRelayReadinessReceipt = z.infer<
  typeof TrustedLocalMemoryRelayReadinessReceiptSchema
>;

const normalizeSourceRoot = (
  input: z.infer<typeof TrustedLocalMemorySourceRootConfigSchema>
): TrustedLocalMemorySourceRoot => ({
  authorityRoot: input.authorityRoot,
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
): TrustedLocalMemorySourceRoot[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sourceRootsJson);
  } catch {
    throw new TypeError("MEMORY_RELAY_SOURCE_ROOTS_JSON must be valid JSON.");
  }

  return TrustedLocalMemorySourceRootsConfigSchema.parse(parsed).map(
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
  readonly env: TrustedLocalMemoryRelayEnvironment;
  readonly name: string;
}): string => {
  const value = input.env[input.name];
  if (value === undefined || value.length === 0) {
    throw new TypeError(`${input.name} is required.`);
  }

  return value;
};

export const trustedLocalMemoryRelayHttpConfigFromEnv = (
  env: TrustedLocalMemoryRelayEnvironment
): TrustedLocalMemoryRelayHttpConfig => {
  const sourceRoots = parseSourceRootsJson(
    requiredEnv({ env, name: "MEMORY_RELAY_SOURCE_ROOTS_JSON" })
  );
  const maxFilesPerSource = parsePositiveInt({
    fallback: DEFAULT_MAX_FILES_PER_SOURCE,
    name: "MEMORY_RELAY_MAX_FILES_PER_SOURCE",
    value: env["MEMORY_RELAY_MAX_FILES_PER_SOURCE"],
  });

  return {
    ...(env["MEMORY_DOCS_API_BASE_URL"] === undefined ||
    env["MEMORY_DOCS_API_BASE_URL"].length === 0
      ? {}
      : {
          docsApi: {
            baseUrl: env["MEMORY_DOCS_API_BASE_URL"],
            ...(env["MEMORY_DOCS_API_USER_AGENT"] === undefined
              ? {}
              : { userAgent: env["MEMORY_DOCS_API_USER_AGENT"] }),
          },
        }),
    expectedBearerToken: requiredEnv({
      env,
      name: "MEMORY_RELAY_TOKEN",
    }),
    host: env["MEMORY_RELAY_HOST"] ?? DEFAULT_RELAY_HOST,
    maxBodyBytes: parsePositiveInt({
      fallback: DEFAULT_MAX_BODY_BYTES,
      name: "MEMORY_RELAY_MAX_BODY_BYTES",
      value: env["MEMORY_RELAY_MAX_BODY_BYTES"],
    }),
    memoryFabric: {
      maxFilesPerSource,
      sourceRoots,
    },
    port: parsePositiveInt({
      fallback: DEFAULT_RELAY_PORT,
      name: "MEMORY_RELAY_PORT",
      value: env["MEMORY_RELAY_PORT"],
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

const sourceRootSummary = (sourceRoot: TrustedLocalMemorySourceRoot) => ({
  family: sourceRoot.family,
  includeExtensionCount: sourceRoot.includeExtensions?.length ?? 0,
  privacyTier: sourceRoot.privacyTier,
  ...(sourceRoot.runtime === undefined ? {} : { runtime: sourceRoot.runtime }),
  sourceId: sourceRoot.sourceId,
});

export const trustedLocalMemoryRelayReadinessReceipt = (input: {
  readonly config: TrustedLocalMemoryRelayHttpConfig;
  readonly now?: string;
}): TrustedLocalMemoryRelayReadinessReceipt =>
  TrustedLocalMemoryRelayReadinessReceiptSchema.parse({
    adapter: {
      port: TRUSTED_LOCAL_PORT,
      sourceRoots: input.config.memoryFabric.sourceRoots.map(sourceRootSummary),
    },
    auth: {
      mode: "bearer",
      required: true,
    },
    checkedAt: input.now ?? input.config.now?.() ?? new Date().toISOString(),
    endpointCatalog: memoryRelayEndpointCatalog,
    maxFilesPerSource:
      input.config.memoryFabric.maxFilesPerSource ??
      DEFAULT_MAX_FILES_PER_SOURCE,
    rawCredentialsReturned: false,
    rawPathsReturned: false,
    redacted: true,
    schemaVersion: "trusted.memory-relay.readiness.v1",
    supportedOperations: [
      "capture-run",
      "capture-artifact",
      "signals",
      "search",
      "hydrate",
      "correlate",
    ],
  });

const healthResponse = async (input: {
  readonly config: TrustedLocalMemoryRelayHttpConfig;
  readonly request: Request;
}): Promise<Response> => {
  const token = authorizationToken(input.request);
  if (token === null) {
    return jsonError(401, "missing_auth", "Missing relay bearer token.");
  }

  if (
    !(await timingSafeSecretMatch({
      actual: token,
      expected: input.config.expectedBearerToken,
    }))
  ) {
    return jsonError(403, "secret_denied", "Invalid relay bearer token.");
  }

  return Response.json(
    trustedLocalMemoryRelayReadinessReceipt({
      config: input.config,
    })
  );
};

export const createTrustedLocalMemoryRelayFetchHandler = (
  config: TrustedLocalMemoryRelayHttpConfig
): ((request: Request) => Promise<Response>) => {
  const adapterNow = config.memoryFabric.now ?? config.now;
  const memoryRetrieval = createTrustedLocalMemoryRetrievalAdapter({
    ...(config.docsApi === undefined ? {} : { docsApi: config.docsApi }),
    ...(config.memoryFabric.maxFilesPerSource === undefined
      ? {}
      : { maxFilesPerSource: config.memoryFabric.maxFilesPerSource }),
    ...(adapterNow === undefined ? {} : { now: adapterNow }),
    ...(config.memoryFabric.sessionBridgeCommand === undefined
      ? {}
      : { sessionBridgeCommand: config.memoryFabric.sessionBridgeCommand }),
    sourceRoots: config.memoryFabric.sourceRoots,
  });
  const memoryCapture = createTrustedLocalMemoryFabricAdapter({
    ...config.memoryFabric,
    ...(adapterNow === undefined ? {} : { now: adapterNow }),
  });
  const relayConfig = {
    expectedBearerToken: config.expectedBearerToken,
    memoryCapture,
    memoryCorrelation: memoryRetrieval,
    memoryRetrieval,
    memorySignals: memoryRetrieval,
    ...(config.now === undefined ? {} : { now: config.now }),
  };

  return (request) => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return healthResponse({ config, request });
    }

    return handleTrustedMemoryRelayRequest({
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
      throw new RangeError("Memory relay request body is too large.");
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
      : "Memory relay server failed."
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
            : "Memory relay server failed.",
        redacted: true,
      },
    })
  );
};

export const startTrustedLocalMemoryRelayHttpServer = async (
  config: TrustedLocalMemoryRelayHttpConfig
): Promise<TrustedLocalMemoryRelayHttpServer> => {
  const handler = createTrustedLocalMemoryRelayFetchHandler(config);
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
    throw new Error("Trusted local Memory relay did not expose a TCP address.");
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
