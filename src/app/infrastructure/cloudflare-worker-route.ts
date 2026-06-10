/// <reference types="@cloudflare/workers-types" />

import type { Sandbox as SandboxDurableObject } from "@cloudflare/sandbox";
import { z } from "zod";

import {
  InstalledWorkflowCartridgeEnvBindingSchema,
  defaultPackageSeedTemplatesWithInstalledCartridges,
  workflowCartridgeDependenciesFromWorkerBindings,
} from "../../cartridges/cloudflare-workflow-cartridges.ts";
import type { WorkerFrontDoorContract } from "../application/ports.ts";
import {
  WorkflowDebuggerAttachDocumentSchema,
  WorkflowEventTailControlDocumentSchema,
  WorkflowEventStreamDocumentSchema,
  WorkflowFrontDoorRequestSchema,
  WorkflowRunRequestSchema,
  WorkflowRunResultSchema,
} from "../domain/schemas.ts";
import type {
  SafetyEnvelopeState,
  WorkflowDebuggerAttachDocument,
  WorkflowEventStreamDocument,
} from "../domain/schemas.ts";
import {
  createCloudflareDiscordBotTokenResolver,
  createCloudflareDiscordMessageAdapter,
} from "./cloudflare-discord-message-adapter.ts";
import { createCloudflareGitHubTokenResolver } from "./cloudflare-github-pull-request-adapter.ts";
import { createCloudflareLinearApiTokenResolver } from "./cloudflare-linear-comment-adapter.ts";
import { createCloudflarePackageArtifactsReader } from "./cloudflare-package-artifacts-reader.ts";
import type { CloudflareD1PackageRegistryConfig } from "./cloudflare-package-registry.ts";
import {
  finalizeCloudflarePackageSeed,
  PackageSeedFinalizeRequestSchema,
  PackageSeedPreparationReceiptSchema,
  PackageSeedReceiptSchema,
  PackageSeedRequestSchema,
  PackageSeedTemplateSchema,
  prepareCloudflarePackageSeed,
  seedCloudflarePackages,
} from "./cloudflare-package-seeder.ts";
import type {
  PackageSeedPreparationReceipt,
  PackageSeedReceipt,
} from "./cloudflare-package-seeder.ts";
import { createCloudflareWorkflowEventStreamReader } from "./cloudflare-workflow-event-stream.ts";
import { createCloudflareWorkflowFrontDoor } from "./cloudflare-workflow-front-door.ts";
import { createCloudflareWzrrdApiTokenResolver } from "./cloudflare-wzrrd-publish-adapter.ts";

export interface WorkflowWorkerHandlerOptions<Environment> {
  readonly createFrontDoor?: (env: Environment) => WorkerFrontDoorContract;
  readonly eventStreamTail?: WorkflowEventStreamTailOptions;
  readonly seedPackages?: (
    env: Environment,
    input: unknown
  ) => Promise<PackageSeedReceipt>;
  readonly preparePackageSeed?: (
    env: Environment,
    input: unknown
  ) => Promise<PackageSeedPreparationReceipt>;
  readonly finalizePackageSeed?: (
    env: Environment,
    input: unknown
  ) => Promise<PackageSeedReceipt>;
  readonly readEventStream?: (
    env: Environment,
    input: { readonly runId: string }
  ) => Promise<WorkflowEventStreamDocument | null>;
}

export interface WorkflowWorkerRequestInput<Environment> {
  readonly createFrontDoor?: (env: Environment) => WorkerFrontDoorContract;
  readonly env: Environment;
  readonly eventStreamTail?: WorkflowEventStreamTailOptions;
  readonly request: Request;
  readonly seedPackages?: (
    env: Environment,
    input: unknown
  ) => Promise<PackageSeedReceipt>;
  readonly preparePackageSeed?: (
    env: Environment,
    input: unknown
  ) => Promise<PackageSeedPreparationReceipt>;
  readonly finalizePackageSeed?: (
    env: Environment,
    input: unknown
  ) => Promise<PackageSeedReceipt>;
  readonly readEventStream?: (
    env: Environment,
    input: { readonly runId: string }
  ) => Promise<WorkflowEventStreamDocument | null>;
}

export interface WorkflowEventStreamTailOptions {
  readonly maxPolls?: number;
  readonly now?: () => string;
  readonly pollDelayMs?: number;
}

const maxRequestBodyBytes = 128 * 1024;

const objectBinding = (value: unknown): value is object =>
  typeof value === "object" && value !== null;

const BaseWorkerEnvBindingSchema = z.object({
  ARTIFACTS: z.custom<Artifacts>(objectBinding),
  DISCORD_BOT_SECRET_REF: z.string().min(1),
  DISCORD_BOT_TOKEN: z.string().optional(),
  DISCORD_DRY_RUN_SECRET_REF: z.string().min(1),
  DISCORD_USER_AGENT: z.string().min(1),
  GITHUB_BRANCH_COMMIT_SECRET_REF: z
    .string()
    .min(1)
    .default("secretref:github-branch-commit"),
  GITHUB_DRY_RUN_SECRET_REF: z
    .string()
    .min(1)
    .default("secretref:github-dry-run"),
  GITHUB_PULL_REQUEST_SECRET_REF: z
    .string()
    .min(1)
    .default("secretref:github-pr"),
  GITHUB_TOKEN: z.string().optional(),
  GITHUB_USER_AGENT: z
    .string()
    .min(1)
    .default("pi-cloudflare-sandbox-workflows/0.0.0"),
  LINEAR_API_TOKEN: z.string().optional(),
  LINEAR_AUTHORIZATION_SCHEME: z.enum(["api-key", "bearer"]).default("api-key"),
  LINEAR_COMMENT_SECRET_REF: z.string().min(1).default("secretref:linear-api"),
  LINEAR_DRY_RUN_SECRET_REF: z
    .string()
    .min(1)
    .default("secretref:linear-dry-run"),
  LINEAR_USER_AGENT: z
    .string()
    .min(1)
    .default("pi-cloudflare-sandbox-workflows/0.0.0"),
  PI_AUTH_JSON_B64: z.string().min(1),
  PI_AUTH_SECRET_REF: z.string().min(1),
  Sandbox:
    z.custom<DurableObjectNamespace<SandboxDurableObject>>(objectBinding),
  WORKFLOW_APP_ARTIFACTS_ACCOUNT_ID: z.string().min(1),
  WORKFLOW_APP_ARTIFACTS_NAMESPACE: z.string().min(1).default("default"),
  WORKFLOW_APP_D1:
    z.custom<CloudflareD1PackageRegistryConfig["d1"]>(objectBinding),
  WORKFLOW_APP_DISCORD_POLICY_ID: z.string().min(1),
  WORKFLOW_APP_MAX_ACTIVE_LANES: z.coerce.number().int().min(1).max(32),
  WORKFLOW_APP_MODEL: z.string().min(1),
  WORKFLOW_APP_REPO_PREFIX: z.string().min(1),
  WORKFLOW_APP_TELEMETRY_DATASET: z
    .string()
    .min(1)
    .default("pi_cloudflare_sandbox_workflows_telemetry"),
  WORKFLOW_APP_TIMEOUT_MS: z.coerce.number().int().min(1),
  WORKFLOW_CAPSULE_SUPERVISOR: z.custom<DurableObjectNamespace>(objectBinding),
  WORKFLOW_EXTERNAL_TELEMETRY_BEARER_TOKEN: z.string().min(1).optional(),
  WORKFLOW_EXTERNAL_TELEMETRY_SINK_ID: z.string().min(1).optional(),
  WORKFLOW_EXTERNAL_TELEMETRY_URL: z.url().optional(),
  WORKFLOW_TELEMETRY: z
    .custom<AnalyticsEngineDataset>(objectBinding)
    .optional(),
  WZRRD_API_TOKEN: z.string().optional(),
  WZRRD_DRY_RUN_SECRET_REF: z
    .string()
    .min(1)
    .default("secretref:wzrrd-dry-run"),
  WZRRD_PUBLISH_SECRET_REF: z.string().min(1).default("secretref:wzrrd-api"),
  WZRRD_SITE_REF: z.string().min(1).default("wzrrd:default"),
  WZRRD_USER_AGENT: z
    .string()
    .min(1)
    .default("pi-cloudflare-sandbox-workflows/0.0.0"),
});

const WorkerEnvBindingSchema = BaseWorkerEnvBindingSchema.extend(
  InstalledWorkflowCartridgeEnvBindingSchema.shape
);

const PackageSeedEnvBindingSchema = z.object({
  ARTIFACTS: z.custom<Artifacts>(objectBinding),
  WORKFLOW_APP_ADMIN_TOKEN: z.string().min(1),
  WORKFLOW_APP_ARTIFACTS_ACCOUNT_ID: z.string().min(1),
  WORKFLOW_APP_ARTIFACTS_NAMESPACE: z.string().min(1).default("default"),
  WORKFLOW_APP_D1:
    z.custom<CloudflareD1PackageRegistryConfig["d1"]>(objectBinding),
});

const WorkerPackageSeedRequestSchema = PackageSeedRequestSchema.extend({
  packages: z
    .array(PackageSeedTemplateSchema)
    .default([...defaultPackageSeedTemplatesWithInstalledCartridges]),
});

const WorkflowEventStreamEnvBindingSchema = z.object({
  WORKFLOW_APP_D1:
    z.custom<CloudflareD1PackageRegistryConfig["d1"]>(objectBinding),
});

export const __cloudflareWorkerRouteTestHooks = {
  WorkerEnvBindingSchema,
  WorkerPackageSeedRequestSchema,
  workflowCartridgeDependenciesFromWorkerBindings,
};

const jsonError = (
  status: number,
  code: string,
  message: string,
  init?: ResponseInit
): Response =>
  Response.json(
    {
      error: {
        code,
        message,
        redacted: true,
      },
    },
    { ...init, status }
  );

const parseJsonRequest = async (request: Request): Promise<unknown> => {
  const contentLength = request.headers.get("content-length");
  if (
    contentLength !== null &&
    Number.parseInt(contentLength, 10) > maxRequestBodyBytes
  ) {
    throw new RangeError("request_body_too_large");
  }

  return await request.json();
};

const bearerToken = (request: Request): null | string => {
  const authorization = request.headers.get("authorization");
  const prefix = "Bearer ";
  if (authorization === null || !authorization.startsWith(prefix)) {
    return null;
  }

  return authorization.slice(prefix.length);
};

const sha256Bytes = async (value: string): Promise<Uint8Array> =>
  new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  );

const timingSafeSecretMatch = async (input: {
  readonly actual: string;
  readonly expected: string;
}): Promise<boolean> => {
  const [actualHash, expectedHash] = await Promise.all([
    sha256Bytes(input.actual),
    sha256Bytes(input.expected),
  ]);
  let mismatch = actualHash.length === expectedHash.length ? 0 : 1;
  for (const [index, actualByte] of actualHash.entries()) {
    mismatch += actualByte === (expectedHash[index] ?? -1) ? 0 : 1;
  }

  return mismatch === 0;
};

const createFrontDoorFromEnv = (env: unknown): WorkerFrontDoorContract => {
  const bindings = WorkerEnvBindingSchema.parse(env);
  const discordBotSecretRef = bindings.DISCORD_BOT_SECRET_REF;

  return createCloudflareWorkflowFrontDoor({
    ...(bindings.WORKFLOW_TELEMETRY === undefined
      ? {}
      : {
          analyticsEngine: bindings.WORKFLOW_TELEMETRY,
          analyticsEngineDataset: bindings.WORKFLOW_APP_TELEMETRY_DATASET,
        }),
    ...(bindings.WORKFLOW_EXTERNAL_TELEMETRY_URL === undefined
      ? {}
      : {
          externalTelemetry: {
            ...(bindings.WORKFLOW_EXTERNAL_TELEMETRY_BEARER_TOKEN === undefined
              ? {}
              : {
                  authorizationBearerToken:
                    bindings.WORKFLOW_EXTERNAL_TELEMETRY_BEARER_TOKEN,
                }),
            endpointUrl: bindings.WORKFLOW_EXTERNAL_TELEMETRY_URL,
            ...(bindings.WORKFLOW_EXTERNAL_TELEMETRY_SINK_ID === undefined
              ? {}
              : { sinkId: bindings.WORKFLOW_EXTERNAL_TELEMETRY_SINK_ID }),
          },
        }),
    artifacts: bindings.ARTIFACTS,
    capabilityLeasePolicy: {
      discordSecretRef: discordBotSecretRef,
      githubBranchCommitSecretRef: bindings.GITHUB_BRANCH_COMMIT_SECRET_REF,
      githubPullRequestSecretRef: bindings.GITHUB_PULL_REQUEST_SECRET_REF,
      linearCommentSecretRef: bindings.LINEAR_COMMENT_SECRET_REF,
      policyId: bindings.WORKFLOW_APP_DISCORD_POLICY_ID,
      wzrrdSecretRef: bindings.WZRRD_PUBLISH_SECRET_REF,
    },
    capsuleSupervisor: bindings.WORKFLOW_CAPSULE_SUPERVISOR,
    ...workflowCartridgeDependenciesFromWorkerBindings(bindings),
    d1: bindings.WORKFLOW_APP_D1,
    discordMessages: createCloudflareDiscordMessageAdapter({
      discordBotSecretRef,
      secretResolver: createCloudflareDiscordBotTokenResolver({
        secret: bindings.DISCORD_BOT_TOKEN ?? "",
        secretRef: discordBotSecretRef,
      }),
      userAgent: bindings.DISCORD_USER_AGENT,
    }),
    discordSecretRefs: {
      dryRun: bindings.DISCORD_DRY_RUN_SECRET_REF,
      send: discordBotSecretRef,
    },
    githubBranchCommitAdapter: {
      secretResolver: createCloudflareGitHubTokenResolver({
        secret: bindings.GITHUB_TOKEN ?? "",
        secretRef: bindings.GITHUB_BRANCH_COMMIT_SECRET_REF,
      }),
      userAgent: bindings.GITHUB_USER_AGENT,
    },
    githubPullRequestAdapter: {
      secretResolver: createCloudflareGitHubTokenResolver({
        secret: bindings.GITHUB_TOKEN ?? "",
        secretRef: bindings.GITHUB_PULL_REQUEST_SECRET_REF,
      }),
      userAgent: bindings.GITHUB_USER_AGENT,
    },
    githubSecretRefs: {
      createBranchCommit: bindings.GITHUB_BRANCH_COMMIT_SECRET_REF,
      createPullRequest: bindings.GITHUB_PULL_REQUEST_SECRET_REF,
      dryRun: bindings.GITHUB_DRY_RUN_SECRET_REF,
    },
    linearCommentAdapter: {
      authorizationScheme: bindings.LINEAR_AUTHORIZATION_SCHEME,
      secretResolver: createCloudflareLinearApiTokenResolver({
        secret: bindings.LINEAR_API_TOKEN ?? "",
        secretRef: bindings.LINEAR_COMMENT_SECRET_REF,
      }),
      userAgent: bindings.LINEAR_USER_AGENT,
    },
    linearSecretRefs: {
      createComment: bindings.LINEAR_COMMENT_SECRET_REF,
      dryRun: bindings.LINEAR_DRY_RUN_SECRET_REF,
    },
    maxActiveLanes: bindings.WORKFLOW_APP_MAX_ACTIVE_LANES,
    model: bindings.WORKFLOW_APP_MODEL,
    packageArtifacts: createCloudflarePackageArtifactsReader({
      artifacts: bindings.ARTIFACTS,
      artifactsAccountId: bindings.WORKFLOW_APP_ARTIFACTS_ACCOUNT_ID,
      artifactsNamespace: bindings.WORKFLOW_APP_ARTIFACTS_NAMESPACE,
    }),
    piAuthJsonBase64: bindings.PI_AUTH_JSON_B64,
    piAuthSecretRef: bindings.PI_AUTH_SECRET_REF,
    repoNamePrefix: bindings.WORKFLOW_APP_REPO_PREFIX,
    sandbox: bindings.Sandbox,
    timeoutMs: bindings.WORKFLOW_APP_TIMEOUT_MS,
    wzrrdPublishAdapter: {
      secretResolver: createCloudflareWzrrdApiTokenResolver({
        secret: bindings.WZRRD_API_TOKEN ?? "",
        secretRef: bindings.WZRRD_PUBLISH_SECRET_REF,
      }),
      userAgent: bindings.WZRRD_USER_AGENT,
    },
    wzrrdSecretRefs: {
      dryRun: bindings.WZRRD_DRY_RUN_SECRET_REF,
      publish: bindings.WZRRD_PUBLISH_SECRET_REF,
    },
    wzrrdSiteRef: bindings.WZRRD_SITE_REF,
  });
};

const seedPackagesFromEnv = (
  env: unknown,
  input: unknown
): Promise<PackageSeedReceipt> => {
  const bindings = PackageSeedEnvBindingSchema.parse(env);

  return seedCloudflarePackages(
    {
      artifacts: bindings.ARTIFACTS,
      artifactsAccountId: bindings.WORKFLOW_APP_ARTIFACTS_ACCOUNT_ID,
      artifactsNamespace: bindings.WORKFLOW_APP_ARTIFACTS_NAMESPACE,
      d1: bindings.WORKFLOW_APP_D1,
    },
    input
  );
};

const preparePackageSeedFromEnv = (
  env: unknown,
  input: unknown
): Promise<PackageSeedPreparationReceipt> => {
  const bindings = PackageSeedEnvBindingSchema.parse(env);

  return prepareCloudflarePackageSeed(
    {
      artifacts: bindings.ARTIFACTS,
      artifactsAccountId: bindings.WORKFLOW_APP_ARTIFACTS_ACCOUNT_ID,
      artifactsNamespace: bindings.WORKFLOW_APP_ARTIFACTS_NAMESPACE,
      d1: bindings.WORKFLOW_APP_D1,
    },
    input
  );
};

const finalizePackageSeedFromEnv = (
  env: unknown,
  input: unknown
): Promise<PackageSeedReceipt> => {
  const bindings = PackageSeedEnvBindingSchema.parse(env);

  return finalizeCloudflarePackageSeed(
    {
      d1: bindings.WORKFLOW_APP_D1,
    },
    input
  );
};

const parsePackageSeedBody = async <Schema extends z.ZodType>(
  request: Request,
  schema: Schema
): Promise<Response | z.infer<Schema>> => {
  try {
    return schema.parse(await parseJsonRequest(request));
  } catch (error) {
    if (error instanceof SyntaxError) {
      return jsonError(400, "invalid_json", "Request body must be JSON.");
    }

    if (error instanceof z.ZodError) {
      return jsonError(
        422,
        "invalid_package_seed_request",
        "Request body does not match the package seed schema."
      );
    }

    throw error;
  }
};

const requirePackageSeedAuth = async (
  request: Request,
  env: unknown
): Promise<Response | null> => {
  const bindings = PackageSeedEnvBindingSchema.parse(env);
  const token = bearerToken(request);
  if (
    token === null ||
    !(await timingSafeSecretMatch({
      actual: token,
      expected: bindings.WORKFLOW_APP_ADMIN_TOKEN,
    }))
  ) {
    return jsonError(
      401,
      "missing_auth",
      "Package seed requires an admin bearer token."
    );
  }

  return null;
};

const enforcePost = (request: Request, route: string): Response | null => {
  if (request.method === "POST") {
    return null;
  }

  return jsonError(405, "method_not_allowed", `Use POST ${route}.`, {
    headers: {
      Allow: "POST",
    },
  });
};

const enforceGet = (request: Request, route: string): Response | null => {
  if (request.method === "GET") {
    return null;
  }

  return jsonError(405, "method_not_allowed", `Use GET ${route}.`, {
    headers: {
      Allow: "GET",
    },
  });
};

const packageSeedFailureResponse = (error: unknown): Response => {
  console.error("package seed route failed", error);

  return jsonError(
    500,
    "package_seed_failed",
    "Package seed failed. Check Worker logs for the redacted stack."
  );
};

const handlePackageSeedRequest = async <Environment>(
  input: WorkflowWorkerRequestInput<Environment>
): Promise<Response> => {
  if (input.request.method !== "POST") {
    return jsonError(
      405,
      "method_not_allowed",
      "Use POST /admin/packages/seed.",
      {
        headers: {
          Allow: "POST",
        },
      }
    );
  }

  const authError = await requirePackageSeedAuth(input.request, input.env);
  if (authError !== null) {
    return authError;
  }

  const body = await parsePackageSeedBody(
    input.request,
    WorkerPackageSeedRequestSchema
  );
  if (body instanceof Response) {
    return body;
  }

  try {
    const receipt = PackageSeedReceiptSchema.parse(
      await (input.seedPackages ?? seedPackagesFromEnv)(input.env, body)
    );

    return Response.json(receipt);
  } catch (error) {
    return packageSeedFailureResponse(error);
  }
};

const handlePackageSeedPreparationRequest = async <Environment>(
  input: WorkflowWorkerRequestInput<Environment>
): Promise<Response> => {
  const methodError = enforcePost(
    input.request,
    "/admin/packages/prepare-seed"
  );
  if (methodError !== null) {
    return methodError;
  }
  const authError = await requirePackageSeedAuth(input.request, input.env);
  if (authError !== null) {
    return authError;
  }
  const body = await parsePackageSeedBody(
    input.request,
    WorkerPackageSeedRequestSchema
  );
  if (body instanceof Response) {
    return body;
  }

  try {
    const receipt = PackageSeedPreparationReceiptSchema.parse(
      await (input.preparePackageSeed ?? preparePackageSeedFromEnv)(
        input.env,
        body
      )
    );

    return Response.json(receipt);
  } catch (error) {
    return packageSeedFailureResponse(error);
  }
};

const handlePackageSeedFinalizationRequest = async <Environment>(
  input: WorkflowWorkerRequestInput<Environment>
): Promise<Response> => {
  const methodError = enforcePost(
    input.request,
    "/admin/packages/finalize-seed"
  );
  if (methodError !== null) {
    return methodError;
  }
  const authError = await requirePackageSeedAuth(input.request, input.env);
  if (authError !== null) {
    return authError;
  }
  const body = await parsePackageSeedBody(
    input.request,
    PackageSeedFinalizeRequestSchema
  );
  if (body instanceof Response) {
    return body;
  }

  try {
    const receipt = PackageSeedReceiptSchema.parse(
      await (input.finalizePackageSeed ?? finalizePackageSeedFromEnv)(
        input.env,
        body
      )
    );

    return Response.json(receipt);
  } catch (error) {
    return packageSeedFailureResponse(error);
  }
};

const readEventStreamFromEnv = async (
  env: unknown,
  input: { readonly runId: string }
): Promise<WorkflowEventStreamDocument | null> => {
  const bindings = WorkflowEventStreamEnvBindingSchema.parse(env);

  return await createCloudflareWorkflowEventStreamReader({
    d1: bindings.WORKFLOW_APP_D1,
  }).read(input);
};

const encodeServerSentEvent = (input: {
  readonly data: unknown;
  readonly event: string;
  readonly id?: string;
}): string => {
  const idLine = input.id === undefined ? "" : `id: ${input.id}\n`;

  return `${idLine}event: ${input.event}\ndata: ${JSON.stringify(
    input.data
  )}\n\n`;
};

const parseEventStreamCursor = (input: {
  readonly request: Request;
  readonly url: URL;
}): number | Response => {
  const rawCursor =
    input.url.searchParams.get("after") ??
    input.request.headers.get("last-event-id");
  if (rawCursor === null || rawCursor === "") {
    return 0;
  }

  const cursor = Number.parseInt(rawCursor, 10);
  if (!Number.isInteger(cursor) || cursor < 0 || String(cursor) !== rawCursor) {
    return jsonError(
      400,
      "invalid_event_cursor",
      "Event stream cursor must be a non-negative integer."
    );
  }

  return cursor;
};

const terminalWorkflowStates = new Set<SafetyEnvelopeState>([
  "blocked",
  "captured",
]);

const isTerminalWorkflowState = (
  state: SafetyEnvelopeState | undefined
): boolean => state !== undefined && terminalWorkflowStates.has(state);

const defaultEventStreamTailOptions = (
  options: WorkflowEventStreamTailOptions | undefined
): {
  readonly maxPolls: number;
  readonly now: () => string;
  readonly pollDelayMs: number;
} => ({
  maxPolls: options?.maxPolls ?? 60,
  now: options?.now ?? (() => new Date().toISOString()),
  pollDelayMs: options?.pollDelayMs ?? 1000,
});

const wait = async (durationMs: number): Promise<void> => {
  if (durationMs <= 0) {
    return;
  }

  // oxlint-disable-next-line promise/avoid-new -- Worker SSE tailing needs a timer-backed polling delay.
  await new Promise<void>((resolve) => {
    setTimeout(resolve, durationMs);
  });
};

const wantsLiveEventStreamTail = (url: URL): boolean => {
  const tail = url.searchParams.get("tail");

  return (
    tail === "live" ||
    tail === "true" ||
    tail === "1" ||
    url.searchParams.get("live") === "1"
  );
};

const workflowEventStreamResponse = (
  document: WorkflowEventStreamDocument
): Response => {
  const body = [
    "retry: 5000\n\n",
    ...document.events.map((entry) =>
      encodeServerSentEvent({
        data: entry,
        event: "workflow.event",
        id: String(entry.eventIndex),
      })
    ),
    encodeServerSentEvent({
      data: document,
      event: "workflow.snapshot",
    }),
  ].join("");

  return new Response(body, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/event-stream; charset=utf-8",
    },
  });
};

const wantsEventStream = (request: Request, url: URL): boolean =>
  wantsLiveEventStreamTail(url) ||
  url.searchParams.get("format") === "sse" ||
  (request.headers.get("accept") ?? "").includes("text/event-stream");

const wantsWebSocketEventStream = (request: Request): boolean =>
  request.headers.get("upgrade")?.toLowerCase() === "websocket";

const workflowEventStreamUrl = (input: {
  readonly origin: string;
  readonly runId: string;
  readonly search?: Record<string, string>;
}): string => {
  const url = new URL(
    `/runs/${encodeURIComponent(input.runId)}/events`,
    input.origin
  );
  for (const [key, value] of Object.entries(input.search ?? {})) {
    url.searchParams.set(key, value);
  }

  return url.toString();
};

const workflowEventStreamWebSocketUrl = (input: {
  readonly afterEventIndex: number;
  readonly origin: string;
  readonly runId: string;
}): string => {
  const url = new URL(
    workflowEventStreamUrl({
      origin: input.origin,
      runId: input.runId,
      search: { after: String(input.afterEventIndex) },
    })
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  return url.toString();
};

const workflowDebuggerAttachDocument = (input: {
  readonly afterEventIndex: number;
  readonly document: WorkflowEventStreamDocument;
  readonly origin: string;
}): WorkflowDebuggerAttachDocument => {
  const latestEventIndex = input.document.events.at(-1)?.eventIndex ?? 0;

  return WorkflowDebuggerAttachDocumentSchema.parse({
    afterEventIndex: input.afterEventIndex,
    attachPolicy: {
      redaction: "redacted-events-only",
      secretMaterial: "not-exposed",
      sideEffects: "read-only",
    },
    eventCount: input.document.eventCount,
    generatedAt: input.document.generatedAt,
    latestEventIndex,
    latestStatus: input.document.latestStatus,
    mode: "event-observer",
    redacted: true,
    runId: input.document.runId,
    schemaVersion: "workflow.debugger-attach.v1",
    source: {
      eventStreamSchemaVersion: "workflow.event-stream.v1",
      sink: input.document.sink,
    },
    transports: [
      {
        description:
          "Read the current redacted workflow event snapshot as JSON.",
        kind: "event-stream-json",
        method: "GET",
        url: workflowEventStreamUrl({
          origin: input.origin,
          runId: input.document.runId,
        }),
      },
      {
        description:
          "Replay redacted workflow events as Server-Sent Events from the requested cursor.",
        kind: "event-stream-sse",
        method: "GET",
        url: workflowEventStreamUrl({
          origin: input.origin,
          runId: input.document.runId,
          search: {
            after: String(input.afterEventIndex),
            format: "sse",
          },
        }),
      },
      {
        description:
          "Bounded live-tail over redacted workflow events from the requested cursor.",
        kind: "event-stream-live-tail",
        method: "GET",
        url: workflowEventStreamUrl({
          origin: input.origin,
          runId: input.document.runId,
          search: {
            after: String(input.afterEventIndex),
            tail: "live",
          },
        }),
      },
      {
        description:
          "WebSocket live observer over redacted workflow events from the requested cursor.",
        kind: "event-stream-websocket",
        protocol: "websocket",
        url: workflowEventStreamWebSocketUrl({
          afterEventIndex: input.afterEventIndex,
          origin: input.origin,
          runId: input.document.runId,
        }),
      },
    ],
    workItemId: input.document.workItemId,
  });
};

const workflowWebSocketMessage = (input: {
  readonly data: unknown;
  readonly event:
    | "workflow.event"
    | "workflow.snapshot"
    | "workflow.tail.closed";
  readonly id?: string;
}): string =>
  JSON.stringify({
    data: input.data,
    event: input.event,
    ...(input.id === undefined ? {} : { id: input.id }),
  });

const liveWorkflowEventWebSocketResponse = <Environment>(input: {
  readonly afterEventIndex: number;
  readonly document: WorkflowEventStreamDocument;
  readonly env: Environment;
  readonly options?: WorkflowEventStreamTailOptions;
  readonly readEventStream: (
    env: Environment,
    input: { readonly runId: string }
  ) => Promise<WorkflowEventStreamDocument | null>;
  readonly runId: string;
}): Response => {
  const pair = new WebSocketPair();
  const { 0: client, 1: server } = pair;
  const tailOptions = defaultEventStreamTailOptions(input.options);
  server.accept();

  const send = (message: string): void => {
    if (server.readyState === WebSocket.OPEN) {
      server.send(message);
    }
  };

  void (async () => {
    let document = WorkflowEventStreamDocumentSchema.parse(input.document);
    let lastEventIndex = input.afterEventIndex;
    let closeReason:
      | "max-polls"
      | "reader-error"
      | "run-not-found"
      | "terminal-state" = "max-polls";

    try {
      for (
        let pollIndex = 0;
        pollIndex < tailOptions.maxPolls;
        pollIndex += 1
      ) {
        for (const entry of document.events) {
          if (entry.eventIndex <= lastEventIndex) {
            continue;
          }

          send(
            workflowWebSocketMessage({
              data: entry,
              event: "workflow.event",
              id: String(entry.eventIndex),
            })
          );
          lastEventIndex = entry.eventIndex;
        }

        send(
          workflowWebSocketMessage({
            data: document,
            event: "workflow.snapshot",
          })
        );

        if (isTerminalWorkflowState(document.latestStatus)) {
          closeReason = "terminal-state";
          break;
        }

        if (pollIndex === tailOptions.maxPolls - 1) {
          closeReason = "max-polls";
          break;
        }

        await wait(tailOptions.pollDelayMs);
        const nextDocument = await input.readEventStream(input.env, {
          runId: input.runId,
        });
        if (nextDocument === null) {
          closeReason = "run-not-found";
          break;
        }
        document = WorkflowEventStreamDocumentSchema.parse(nextDocument);
      }
    } catch (error) {
      console.error("workflow event websocket tail failed", error);
      closeReason = "reader-error";
    } finally {
      send(
        workflowWebSocketMessage({
          data: WorkflowEventTailControlDocumentSchema.parse({
            at: tailOptions.now(),
            eventCount: document.eventCount,
            lastEventIndex,
            latestStatus: document.latestStatus,
            reason: closeReason,
            redacted: true,
            runId: document.runId,
            schemaVersion: "workflow.event-tail-control.v1",
            status: "closed",
            stream: {
              kind: "cloudflare-d1-workflow-events-live-tail",
              maxPolls: tailOptions.maxPolls,
              pollDelayMs: tailOptions.pollDelayMs,
            },
            workItemId: document.workItemId,
          }),
          event: "workflow.tail.closed",
        })
      );
      if (server.readyState === WebSocket.OPEN) {
        server.close(1000, closeReason);
      }
    }
  })();

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
};

const liveWorkflowEventStreamResponse = <Environment>(input: {
  readonly afterEventIndex: number;
  readonly document: WorkflowEventStreamDocument;
  readonly env: Environment;
  readonly options?: WorkflowEventStreamTailOptions;
  readonly readEventStream: (
    env: Environment,
    input: { readonly runId: string }
  ) => Promise<WorkflowEventStreamDocument | null>;
  readonly runId: string;
}): Response => {
  const encoder = new TextEncoder();
  const tailOptions = defaultEventStreamTailOptions(input.options);

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (chunk: string): void => {
        controller.enqueue(encoder.encode(chunk));
      };
      let document = WorkflowEventStreamDocumentSchema.parse(input.document);
      let lastEventIndex = input.afterEventIndex;
      let closeReason:
        | "max-polls"
        | "reader-error"
        | "run-not-found"
        | "terminal-state" = "max-polls";

      write("retry: 1000\n\n");

      try {
        for (
          let pollIndex = 0;
          pollIndex < tailOptions.maxPolls;
          pollIndex += 1
        ) {
          for (const entry of document.events) {
            if (entry.eventIndex <= lastEventIndex) {
              continue;
            }

            write(
              encodeServerSentEvent({
                data: entry,
                event: "workflow.event",
                id: String(entry.eventIndex),
              })
            );
            lastEventIndex = entry.eventIndex;
          }

          write(
            encodeServerSentEvent({
              data: document,
              event: "workflow.snapshot",
            })
          );

          if (isTerminalWorkflowState(document.latestStatus)) {
            closeReason = "terminal-state";
            break;
          }

          if (pollIndex === tailOptions.maxPolls - 1) {
            closeReason = "max-polls";
            break;
          }

          await wait(tailOptions.pollDelayMs);
          const nextDocument = await input.readEventStream(input.env, {
            runId: input.runId,
          });
          if (nextDocument === null) {
            closeReason = "run-not-found";
            break;
          }
          document = WorkflowEventStreamDocumentSchema.parse(nextDocument);
        }
      } catch (error) {
        console.error("workflow event live tail failed", error);
        closeReason = "reader-error";
      } finally {
        write(
          encodeServerSentEvent({
            data: WorkflowEventTailControlDocumentSchema.parse({
              at: tailOptions.now(),
              eventCount: document.eventCount,
              lastEventIndex,
              latestStatus: document.latestStatus,
              reason: closeReason,
              redacted: true,
              runId: document.runId,
              schemaVersion: "workflow.event-tail-control.v1",
              status: "closed",
              stream: {
                kind: "cloudflare-d1-workflow-events-live-tail",
                maxPolls: tailOptions.maxPolls,
                pollDelayMs: tailOptions.pollDelayMs,
              },
              workItemId: document.workItemId,
            }),
            event: "workflow.tail.closed",
          })
        );
        controller.close();
      }
    },
  });

  return new Response(body, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/event-stream; charset=utf-8",
    },
  });
};

const handleWorkflowEventStreamRequest = async <Environment>(
  input: WorkflowWorkerRequestInput<Environment>,
  runIdSegment: string
): Promise<Response> => {
  const url = new URL(input.request.url);
  const methodError = enforceGet(input.request, "/runs/:runId/events");
  if (methodError !== null) {
    return methodError;
  }

  let runId: string;
  try {
    runId = decodeURIComponent(runIdSegment);
  } catch {
    return jsonError(
      400,
      "invalid_run_id",
      "Run id path segment must be URL encoded."
    );
  }

  const afterEventIndex = parseEventStreamCursor({
    request: input.request,
    url,
  });
  if (afterEventIndex instanceof Response) {
    return afterEventIndex;
  }

  const readEventStream = input.readEventStream ?? readEventStreamFromEnv;
  const eventStream = await readEventStream(input.env, {
    runId,
  });
  if (eventStream === null) {
    return jsonError(404, "run_not_found", "Run event stream not found.");
  }
  const document = WorkflowEventStreamDocumentSchema.parse(eventStream);

  if (wantsWebSocketEventStream(input.request)) {
    return liveWorkflowEventWebSocketResponse({
      afterEventIndex,
      document,
      env: input.env,
      ...(input.eventStreamTail === undefined
        ? {}
        : { options: input.eventStreamTail }),
      readEventStream,
      runId,
    });
  }

  if (wantsEventStream(input.request, url)) {
    if (wantsLiveEventStreamTail(url)) {
      return liveWorkflowEventStreamResponse({
        afterEventIndex,
        document,
        env: input.env,
        ...(input.eventStreamTail === undefined
          ? {}
          : { options: input.eventStreamTail }),
        readEventStream,
        runId,
      });
    }

    return workflowEventStreamResponse(document);
  }

  return Response.json(document, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
};

const handleWorkflowDebuggerAttachRequest = async <Environment>(
  input: WorkflowWorkerRequestInput<Environment>,
  runIdSegment: string
): Promise<Response> => {
  const url = new URL(input.request.url);
  const methodError = enforceGet(input.request, "/runs/:runId/debugger");
  if (methodError !== null) {
    return methodError;
  }

  let runId: string;
  try {
    runId = decodeURIComponent(runIdSegment);
  } catch {
    return jsonError(
      400,
      "invalid_run_id",
      "Run id path segment must be URL encoded."
    );
  }

  const afterEventIndex = parseEventStreamCursor({
    request: input.request,
    url,
  });
  if (afterEventIndex instanceof Response) {
    return afterEventIndex;
  }

  const readEventStream = input.readEventStream ?? readEventStreamFromEnv;
  const eventStream = await readEventStream(input.env, {
    runId,
  });
  if (eventStream === null) {
    return jsonError(404, "run_not_found", "Run event stream not found.");
  }

  return Response.json(
    workflowDebuggerAttachDocument({
      afterEventIndex,
      document: WorkflowEventStreamDocumentSchema.parse(eventStream),
      origin: url.origin,
    }),
    {
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
};

export const handleWorkflowWorkerRequest = async <Environment>(
  input: WorkflowWorkerRequestInput<Environment>
): Promise<Response> => {
  const url = new URL(input.request.url);
  const debuggerAttachRoute = /^\/runs\/([^/]+)\/debugger$/u.exec(url.pathname);
  if (debuggerAttachRoute !== null) {
    const [, runIdSegment] = debuggerAttachRoute;
    if (runIdSegment === undefined) {
      return jsonError(404, "not_found", "Route not found.");
    }

    return await handleWorkflowDebuggerAttachRequest(input, runIdSegment);
  }

  const eventStreamRoute = /^\/runs\/([^/]+)\/events$/u.exec(url.pathname);
  if (eventStreamRoute !== null) {
    const [, runIdSegment] = eventStreamRoute;
    if (runIdSegment === undefined) {
      return jsonError(404, "not_found", "Route not found.");
    }

    return await handleWorkflowEventStreamRequest(input, runIdSegment);
  }

  if (url.pathname === "/admin/packages/prepare-seed") {
    return await handlePackageSeedPreparationRequest(input);
  }

  if (url.pathname === "/admin/packages/finalize-seed") {
    return await handlePackageSeedFinalizationRequest(input);
  }

  if (url.pathname === "/admin/packages/seed") {
    return await handlePackageSeedRequest(input);
  }

  if (url.pathname !== "/runs") {
    return jsonError(404, "not_found", "Route not found.");
  }

  if (input.request.method !== "POST") {
    return jsonError(405, "method_not_allowed", "Use POST /runs.", {
      headers: {
        Allow: "POST",
      },
    });
  }

  let body: unknown;
  try {
    body = WorkflowRunRequestSchema.parse(
      await parseJsonRequest(input.request)
    );
    WorkflowFrontDoorRequestSchema.parse({
      body,
      method: input.request.method,
      route: url.pathname,
    });
  } catch (error) {
    if (error instanceof RangeError) {
      return jsonError(
        413,
        "request_body_too_large",
        "Request body is too large."
      );
    }

    if (error instanceof SyntaxError) {
      return jsonError(400, "invalid_json", "Request body must be JSON.");
    }

    if (error instanceof z.ZodError) {
      return jsonError(
        422,
        "invalid_workflow_request",
        "Request body does not match the workflow run schema."
      );
    }

    throw error;
  }

  try {
    const frontDoor =
      input.createFrontDoor?.(input.env) ?? createFrontDoorFromEnv(input.env);
    const result = WorkflowRunResultSchema.parse(
      await frontDoor.startRun(body)
    );

    return Response.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return jsonError(
        422,
        "invalid_workflow_result",
        "Workflow result did not match the response schema."
      );
    }

    console.error("workflow route failed", error);

    return jsonError(
      500,
      "workflow_route_failed",
      "Workflow route failed before a receipt was captured."
    );
  }
};

export const createWorkflowWorkerHandler = <Environment = Env>(
  options: WorkflowWorkerHandlerOptions<Environment> = {}
): ExportedHandler<Environment> => ({
  fetch(request, env): Promise<Response> {
    return handleWorkflowWorkerRequest({
      ...(options.createFrontDoor === undefined
        ? {}
        : { createFrontDoor: options.createFrontDoor }),
      env,
      request,
      ...(options.eventStreamTail === undefined
        ? {}
        : { eventStreamTail: options.eventStreamTail }),
      ...(options.seedPackages === undefined
        ? {}
        : { seedPackages: options.seedPackages }),
      ...(options.preparePackageSeed === undefined
        ? {}
        : { preparePackageSeed: options.preparePackageSeed }),
      ...(options.finalizePackageSeed === undefined
        ? {}
        : { finalizePackageSeed: options.finalizePackageSeed }),
      ...(options.readEventStream === undefined
        ? {}
        : { readEventStream: options.readEventStream }),
    });
  },
});
