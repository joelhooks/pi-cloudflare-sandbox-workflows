/// <reference types="@cloudflare/workers-types" />

import type { Sandbox as SandboxDurableObject } from "@cloudflare/sandbox";
import { z } from "zod";

import {
  InstalledWorkflowCartridgeEnvBindingSchema,
  defaultPackageSeedTemplatesWithInstalledCartridges,
  installedWorkflowCartridgeSourceProfiles,
  workflowCartridgeDependenciesFromWorkerBindings,
} from "../../cartridges/cloudflare-workflow-cartridges.ts";
import type { WorkerFrontDoorContract } from "../application/ports.ts";
import {
  RunDurabilityDumpSchema,
  StartRunRequestSchema,
  WorkflowDebuggerAttachDocumentSchema,
  WorkflowEventTailControlDocumentSchema,
  WorkflowEventStreamDocumentSchema,
  WorkflowFrontDoorRequestSchema,
  WorkflowRunAcceptedSchema,
  WorkflowRunRequestSchema,
} from "../domain/schemas.ts";
import type {
  RunDurabilityDump,
  SafetyEnvelopeState,
  StartRunRequest,
  WorkflowDebuggerAttachDocument,
  WorkflowEventStreamDocument,
} from "../domain/schemas.ts";
import { timingSafeSecretMatch } from "../domain/secret-compare.ts";
import type { CloudflareWorkflowCapsuleSupervisor } from "./cloudflare-capsule-supervisor.ts";
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
import {
  createCloudflareWorkflowEventStreamReader,
  createCloudflareWorkflowRunStatusReader,
  WorkflowRunStatusSnapshotSchema,
} from "./cloudflare-workflow-event-stream.ts";
import type { WorkflowRunStatusSnapshot } from "./cloudflare-workflow-event-stream.ts";
import { createCloudflareWorkflowFrontDoor } from "./cloudflare-workflow-front-door.ts";
import {
  createCloudflareWorkflowRunsListReader,
  createCloudflareWorkflowRunWorkItemReader,
  WorkflowRunsListDocumentSchema,
  WorkflowRunsListQuerySchema,
} from "./cloudflare-workflow-runs-list.ts";
import type {
  WorkflowRunsListDocument,
  WorkflowRunsListQuery,
} from "./cloudflare-workflow-runs-list.ts";
import { createCloudflareWzrrdApiTokenResolver } from "./cloudflare-wzrrd-publish-adapter.ts";

export interface WorkflowWorkerHandlerOptions<Environment> {
  readonly createFrontDoor?: (env: Environment) => WorkerFrontDoorContract;
  readonly enqueueRun?: (
    env: Environment,
    input: StartRunRequest
  ) => Promise<void>;
  readonly eventStreamTail?: WorkflowEventStreamTailOptions;
  readonly listRuns?: (
    env: Environment,
    input: WorkflowRunsListQuery
  ) => Promise<WorkflowRunsListDocument>;
  readonly readRunDurability?: (
    env: Environment,
    input: { readonly runId: string }
  ) => Promise<RunDurabilityDump | null>;
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
  readonly readRunStatus?: (
    env: Environment,
    input: { readonly runId: string }
  ) => Promise<WorkflowRunStatusSnapshot | null>;
}

export interface WorkflowWorkerRequestInput<Environment> {
  readonly createFrontDoor?: (env: Environment) => WorkerFrontDoorContract;
  readonly enqueueRun?: (
    env: Environment,
    input: StartRunRequest
  ) => Promise<void>;
  readonly env: Environment;
  readonly eventStreamTail?: WorkflowEventStreamTailOptions;
  readonly listRuns?: (
    env: Environment,
    input: WorkflowRunsListQuery
  ) => Promise<WorkflowRunsListDocument>;
  readonly readRunDurability?: (
    env: Environment,
    input: { readonly runId: string }
  ) => Promise<RunDurabilityDump | null>;
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
  readonly readRunStatus?: (
    env: Environment,
    input: { readonly runId: string }
  ) => Promise<WorkflowRunStatusSnapshot | null>;
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
  ZOMBIE_NODE_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(3),
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

const WorkflowRunDriverEnvBindingSchema = z.object({
  WORKFLOW_CAPSULE_SUPERVISOR: z.custom<DurableObjectNamespace>(objectBinding),
});

const WorkflowRunsAuthEnvBindingSchema = z.object({
  WORKFLOW_APP_RUNS_TOKEN: z.string().min(1),
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

export const createFrontDoorFromEnv = (
  env: unknown
): WorkerFrontDoorContract => {
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
    artifactsAccountId: bindings.WORKFLOW_APP_ARTIFACTS_ACCOUNT_ID,
    artifactsNamespace: bindings.WORKFLOW_APP_ARTIFACTS_NAMESPACE,
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
    installedSourceProfiles: installedWorkflowCartridgeSourceProfiles,
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
    zombieNodeMaxAttempts: bindings.ZOMBIE_NODE_MAX_ATTEMPTS,
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

const requireWorkflowRunsAuth = async (
  request: Request,
  env: unknown
): Promise<Response | null> => {
  const bindings = WorkflowRunsAuthEnvBindingSchema.safeParse(env);
  if (!bindings.success) {
    return jsonError(
      503,
      "runs_auth_unconfigured",
      "Run routes are not configured."
    );
  }

  const token = bearerToken(request);
  if (
    token === null ||
    !(await timingSafeSecretMatch({
      actual: token,
      expected: bindings.data.WORKFLOW_APP_RUNS_TOKEN,
    }))
  ) {
    return jsonError(401, "missing_auth", "Run routes require a bearer token.");
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

const readRunStatusFromEnv = async (
  env: unknown,
  input: { readonly runId: string }
): Promise<WorkflowRunStatusSnapshot | null> => {
  const bindings = WorkflowEventStreamEnvBindingSchema.parse(env);

  return await createCloudflareWorkflowRunStatusReader({
    d1: bindings.WORKFLOW_APP_D1,
  }).read(input);
};

const listRunsFromEnv = async (
  env: unknown,
  input: WorkflowRunsListQuery
): Promise<WorkflowRunsListDocument> => {
  const bindings = WorkflowEventStreamEnvBindingSchema.parse(env);

  return await createCloudflareWorkflowRunsListReader({
    d1: bindings.WORKFLOW_APP_D1,
  }).list(input);
};

const RunDurabilityEnvBindingSchema = z.object({
  WORKFLOW_APP_D1:
    z.custom<CloudflareD1PackageRegistryConfig["d1"]>(objectBinding),
  WORKFLOW_CAPSULE_SUPERVISOR: z.custom<DurableObjectNamespace>(objectBinding),
});

const readRunDurabilityFromEnv = async (
  env: unknown,
  input: { readonly runId: string }
): Promise<RunDurabilityDump | null> => {
  const bindings = RunDurabilityEnvBindingSchema.parse(env);
  const workItemId = await createCloudflareWorkflowRunWorkItemReader({
    d1: bindings.WORKFLOW_APP_D1,
  }).read(input);
  if (workItemId === null) {
    return null;
  }

  const { readCapsuleSupervisorRunDurability } =
    await import("./cloudflare-capsule-supervisor.ts");

  return await readCapsuleSupervisorRunDurability(
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The runtime binding is the typed supervisor namespace; the schema only proves it is an object.
    bindings.WORKFLOW_CAPSULE_SUPERVISOR as unknown as DurableObjectNamespace<CloudflareWorkflowCapsuleSupervisor>,
    { runId: input.runId, workItemId }
  );
};

const enqueueRunFromEnv = async (
  env: unknown,
  input: StartRunRequest
): Promise<void> => {
  const bindings = WorkflowRunDriverEnvBindingSchema.parse(env);
  const { enqueueCapsuleSupervisorRun } =
    await import("./cloudflare-capsule-supervisor.ts");
  await enqueueCapsuleSupervisorRun(
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The runtime binding is the typed supervisor namespace; the schema only proves it is an object.
    bindings.WORKFLOW_CAPSULE_SUPERVISOR as unknown as DurableObjectNamespace<CloudflareWorkflowCapsuleSupervisor>,
    input
  );
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

const handleWorkflowRunStatusRequest = async <Environment>(
  input: WorkflowWorkerRequestInput<Environment>,
  runIdSegment: string
): Promise<Response> => {
  const methodError = enforceGet(input.request, "/runs/:runId/status");
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

  const readRunStatus = input.readRunStatus ?? readRunStatusFromEnv;
  let snapshot: WorkflowRunStatusSnapshot | null;
  try {
    snapshot = await readRunStatus(input.env, { runId });
  } catch (error) {
    console.error("workflow run status read failed", error);

    return jsonError(
      500,
      "run_status_read_failed",
      "Run status could not be read."
    );
  }
  if (snapshot === null) {
    return jsonError(404, "run_not_found", "Run not found.");
  }

  const status = WorkflowRunStatusSnapshotSchema.parse(snapshot);
  const terminal = isTerminalWorkflowState(status.status);

  return Response.json(
    {
      ...(terminal &&
      status.status === "blocked" &&
      status.terminalBlocker !== undefined
        ? {
            blocker: {
              code: status.terminalBlocker.code,
              message: status.terminalBlocker.message,
              ...(status.terminalBlocker.nodeType === undefined
                ? {}
                : { nodeType: status.terminalBlocker.nodeType }),
              redacted: true,
              ...(status.terminalBlocker.stepId === undefined
                ? {}
                : { stepId: status.terminalBlocker.stepId }),
            },
          }
        : {}),
      redacted: true,
      runId: status.runId,
      status: status.status,
      terminal,
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
};

const handleWorkflowRunsListRequest = async <Environment>(
  input: WorkflowWorkerRequestInput<Environment>,
  url: URL
): Promise<Response> => {
  const methodError = enforceGet(input.request, "/admin/runs");
  if (methodError !== null) {
    return methodError;
  }

  const authError = await requirePackageSeedAuth(input.request, input.env);
  if (authError !== null) {
    return authError;
  }

  let query: WorkflowRunsListQuery;
  try {
    query = WorkflowRunsListQuerySchema.parse({
      ...(url.searchParams.get("limit") === null
        ? {}
        : { limit: url.searchParams.get("limit") }),
      ...(url.searchParams.get("status") === null
        ? {}
        : { status: url.searchParams.get("status") }),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return jsonError(
        422,
        "invalid_runs_list_query",
        "Runs list query parameters are invalid."
      );
    }

    throw error;
  }

  const listRuns = input.listRuns ?? listRunsFromEnv;
  let document: WorkflowRunsListDocument;
  try {
    document = WorkflowRunsListDocumentSchema.parse(
      await listRuns(input.env, query)
    );
  } catch (error) {
    console.error("workflow runs list read failed", error);

    return jsonError(
      500,
      "runs_list_read_failed",
      "Runs list could not be read."
    );
  }

  return Response.json(document, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
};

const handleWorkflowRunDurabilityRequest = async <Environment>(
  input: WorkflowWorkerRequestInput<Environment>,
  runIdSegment: string
): Promise<Response> => {
  const methodError = enforceGet(input.request, "/runs/:runId/durability");
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

  const readRunDurability = input.readRunDurability ?? readRunDurabilityFromEnv;
  let dump: RunDurabilityDump | null;
  try {
    dump = await readRunDurability(input.env, { runId });
  } catch (error) {
    console.error("workflow run durability read failed", error);

    return jsonError(
      500,
      "run_durability_read_failed",
      "Run durability could not be read."
    );
  }
  if (dump === null) {
    return jsonError(404, "run_not_found", "Run not found.");
  }

  return Response.json(RunDurabilityDumpSchema.parse(dump), {
    headers: {
      "Cache-Control": "no-store",
    },
  });
};

const handleWorkflowRunSubmissionRequest = async <Environment>(
  input: WorkflowWorkerRequestInput<Environment>,
  url: URL
): Promise<Response> => {
  if (input.request.method !== "POST") {
    return jsonError(405, "method_not_allowed", "Use POST /runs.", {
      headers: {
        Allow: "POST",
      },
    });
  }

  let body: z.infer<typeof WorkflowRunRequestSchema>;
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

  const readRunStatus = input.readRunStatus ?? readRunStatusFromEnv;
  let existingRun: WorkflowRunStatusSnapshot | null;
  try {
    existingRun = await readRunStatus(input.env, { runId: body.runId });
  } catch (error) {
    console.error("workflow run duplicate guard failed", error);

    return jsonError(
      500,
      "run_duplicate_guard_failed",
      "Run duplicate guard failed before execution."
    );
  }
  if (existingRun !== null && isTerminalWorkflowState(existingRun.status)) {
    return Response.json(
      {
        error: {
          code: "duplicate_run_id",
          message:
            "Run id already reached a terminal state; refusing to re-execute.",
          redacted: true,
        },
        run: WorkflowRunStatusSnapshotSchema.parse(existingRun),
      },
      { status: 409 }
    );
  }

  try {
    const enqueueRun = input.enqueueRun ?? enqueueRunFromEnv;
    await enqueueRun(
      input.env,
      StartRunRequestSchema.parse({
        request: body,
        workItemId: body.workItemId,
      })
    );

    return Response.json(
      WorkflowRunAcceptedSchema.parse({
        runId: body.runId,
        status: "accepted",
      }),
      { status: 202 }
    );
  } catch (error) {
    console.error("workflow run enqueue failed", error);

    return jsonError(
      500,
      "workflow_run_enqueue_failed",
      "Workflow run could not be enqueued for execution."
    );
  }
};

export const handleWorkflowWorkerRequest = async <Environment>(
  input: WorkflowWorkerRequestInput<Environment>
): Promise<Response> => {
  const url = new URL(input.request.url);
  if (url.pathname === "/runs" || url.pathname.startsWith("/runs/")) {
    const authError = await requireWorkflowRunsAuth(input.request, input.env);
    if (authError !== null) {
      return authError;
    }
  }

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

  const statusRoute = /^\/runs\/([^/]+)\/status$/u.exec(url.pathname);
  if (statusRoute !== null) {
    const [, runIdSegment] = statusRoute;
    if (runIdSegment === undefined) {
      return jsonError(404, "not_found", "Route not found.");
    }

    return await handleWorkflowRunStatusRequest(input, runIdSegment);
  }

  const durabilityRoute = /^\/runs\/([^/]+)\/durability$/u.exec(url.pathname);
  if (durabilityRoute !== null) {
    const [, runIdSegment] = durabilityRoute;
    if (runIdSegment === undefined) {
      return jsonError(404, "not_found", "Route not found.");
    }

    return await handleWorkflowRunDurabilityRequest(input, runIdSegment);
  }

  if (url.pathname === "/admin/runs") {
    return await handleWorkflowRunsListRequest(input, url);
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

  return await handleWorkflowRunSubmissionRequest(input, url);
};

export const createWorkflowWorkerHandler = <Environment = Env>(
  options: WorkflowWorkerHandlerOptions<Environment> = {}
): ExportedHandler<Environment> => ({
  fetch(request, env): Promise<Response> {
    return handleWorkflowWorkerRequest({
      ...(options.createFrontDoor === undefined
        ? {}
        : { createFrontDoor: options.createFrontDoor }),
      ...(options.enqueueRun === undefined
        ? {}
        : { enqueueRun: options.enqueueRun }),
      env,
      request,
      ...(options.eventStreamTail === undefined
        ? {}
        : { eventStreamTail: options.eventStreamTail }),
      ...(options.listRuns === undefined ? {} : { listRuns: options.listRuns }),
      ...(options.readRunDurability === undefined
        ? {}
        : { readRunDurability: options.readRunDurability }),
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
      ...(options.readRunStatus === undefined
        ? {}
        : { readRunStatus: options.readRunStatus }),
    });
  },
});
