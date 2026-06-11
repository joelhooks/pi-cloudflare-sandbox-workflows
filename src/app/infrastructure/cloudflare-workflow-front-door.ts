/// <reference types="@cloudflare/workers-types" />

import type { Sandbox as SandboxDurableObject } from "@cloudflare/sandbox";

import { createAdmittedAgentLaneRuntime } from "../application/admitted-agent-lane-runtime.ts";
import type {
  AgentAnalysisReasoningLanePort,
  AgentLaneAdmissionControllerContract,
  AgentLaneRuntimePort,
  ArtifactStoreContract,
  CapabilityLeaseBrokerActorContract,
  ContextCapsuleActorContract,
  DiscordMessageCapabilityAdapter,
  GitHubBranchCommitCapabilityAdapter,
  GitHubPullRequestCapabilityAdapter,
  LinearCommentCapabilityAdapter,
  ReviewGateActorContract,
  WorkerFrontDoorContract,
  WorkflowNodeAdapterPort,
  WorkflowPostExecutionArtifactRecorderRegistration,
  WzrrdPublishCapabilityAdapter,
} from "../application/ports.ts";
import { WorkflowApp } from "../application/workflow-app.ts";
import {
  AgentAuthLeaseSchema,
  AgentLaneAdmissionDecisionSchema,
  AgentLaneReleaseReceiptSchema,
  ContextCapsuleRecordSchema,
  LoadRunCheckpointResolutionSchema,
  WorkflowRunRequestSchema,
} from "../domain/schemas.ts";
import type {
  WorkflowRunDriveOptions,
  WorkflowRunRequest,
} from "../domain/schemas.ts";
import type { MemorySourceProfile } from "../domain/source-profile.ts";
import {
  createCloudflarePiAnalysisReasoningLaneAdapter,
  createCloudflarePiPlannerLaneAdapter,
  createCloudflarePiVerifierLaneAdapter,
  createCloudflarePiWorkerLaneAdapter,
} from "./cloudflare-agent-lane-adapters.ts";
import { createCloudflareArtifactsObservabilityRecorder } from "./cloudflare-artifacts-observability-recorder.ts";
import { createCloudflareArtifactsReviewSurfacePublisher } from "./cloudflare-artifacts-review-surface.ts";
import { provisionCloudflareArtifactsRunStore } from "./cloudflare-artifacts-store.ts";
import type { CloudflareArtifactsRunStore } from "./cloudflare-artifacts-store.ts";
import { createCloudflareCapabilityLeaseBroker } from "./cloudflare-capability-lease-broker.ts";
import type { CloudflareCapabilityLeaseBrokerConfig } from "./cloudflare-capability-lease-broker.ts";
import {
  createCloudflareGitHubBranchCommitAdapter,
  createDryRunGitHubBranchCommitAdapter,
} from "./cloudflare-github-branch-commit-adapter.ts";
import {
  createCloudflareGitHubPullRequestAdapter,
  createDryRunGitHubPullRequestAdapter,
} from "./cloudflare-github-pull-request-adapter.ts";
import type { GitHubTokenSecretResolver } from "./cloudflare-github-pull-request-adapter.ts";
import {
  createCloudflareLinearCommentAdapter,
  createDryRunLinearCommentAdapter,
} from "./cloudflare-linear-comment-adapter.ts";
import type { LinearApiTokenSecretResolver } from "./cloudflare-linear-comment-adapter.ts";
import { createCloudflareD1PackageRegistryActor } from "./cloudflare-package-registry.ts";
import type { CloudflareD1PackageRegistryConfig } from "./cloudflare-package-registry.ts";
import { createCloudflareReviewGateActor } from "./cloudflare-review-gate-actor.ts";
import { createCloudflareWorkflowStatusProjection } from "./cloudflare-workflow-status-projection.ts";
import {
  createCloudflareAnalyticsEngineWorkflowTelemetrySink,
  createCloudflareArtifactsStructuredLogSink,
  createCloudflareD1WorkflowTelemetrySink,
  createCompositeWorkflowTelemetrySink,
  createExternalHttpWorkflowTelemetrySink,
} from "./cloudflare-workflow-telemetry-sinks.ts";
import type {
  AnalyticsEngineDatasetLike,
  ExternalHttpWorkflowTelemetrySinkConfig,
} from "./cloudflare-workflow-telemetry-sinks.ts";
import {
  createCloudflareWzrrdPublishAdapter,
  createDryRunWzrrdPublishAdapter,
} from "./cloudflare-wzrrd-publish-adapter.ts";
import type { WzrrdApiTokenSecretResolver } from "./cloudflare-wzrrd-publish-adapter.ts";
import { createArtifactEvidenceDeterministicVerifier } from "./deterministic-verifier.ts";

const brainProposalAcceptanceRef = {
  kind: "wzrrd-proposal",
  title: "ShitRat Brain Proposal",
  url: "https://shitrat-brain-proposal.wzrrd.sh/",
} as const;

type CapsuleSupervisorPorts = ContextCapsuleActorContract &
  AgentLaneAdmissionControllerContract;

export interface CloudflareWorkflowNodeAdapterFactoryInput {
  /**
   * The run's analysis reasoning lane, built from the same admitted-runtime
   * lane machinery the planner/worker lanes use. Threaded into cartridge node
   * adapters so the agentic propose-refinements node REASONS over the
   * analysis-method kernel skill; absent (injected `workflowNodeAdapter`, no
   * lane runtime) the node falls back to the deterministic mechanical path.
   */
  readonly analysisReasoningLane?: AgentAnalysisReasoningLanePort;
  readonly artifacts: ArtifactStoreContract;
}

export interface CloudflarePostExecutionArtifactRecorderFactoryInput {
  readonly artifacts: ArtifactStoreContract;
}

export interface CloudflareWorkflowFrontDoorConfig {
  readonly analyticsEngine?: AnalyticsEngineDatasetLike;
  readonly analyticsEngineDataset?: string;
  readonly artifacts?: Artifacts;
  readonly capabilityLeases?: CapabilityLeaseBrokerActorContract;
  readonly capabilityLeasePolicy?: CloudflareCapabilityLeaseBrokerConfig["policy"];
  readonly contextCapsules?: CapsuleSupervisorPorts;
  readonly capsuleSupervisor?: DurableObjectNamespace;
  readonly createWorkflowNodeAdapter?: (
    input: CloudflareWorkflowNodeAdapterFactoryInput
  ) => WorkflowNodeAdapterPort;
  readonly createPostExecutionArtifactRecorders?: (
    input: CloudflarePostExecutionArtifactRecorderFactoryInput
  ) => readonly WorkflowPostExecutionArtifactRecorderRegistration[];
  readonly d1: CloudflareD1PackageRegistryConfig["d1"];
  readonly discordMessages: DiscordMessageCapabilityAdapter;
  readonly discordSecretRefs: {
    readonly dryRun: string;
    readonly send: string;
  };
  readonly externalTelemetry?: ExternalHttpWorkflowTelemetrySinkConfig;
  readonly githubPullRequestAdapter?: {
    readonly githubApiBaseUrl?: string;
    readonly secretResolver: GitHubTokenSecretResolver;
    readonly userAgent: string;
  };
  readonly githubBranchCommitAdapter?: {
    readonly githubApiBaseUrl?: string;
    readonly secretResolver: GitHubTokenSecretResolver;
    readonly userAgent: string;
  };
  readonly githubBranchCommits?: GitHubBranchCommitCapabilityAdapter;
  readonly githubPullRequests?: GitHubPullRequestCapabilityAdapter;
  readonly githubSecretRefs?: {
    readonly createBranchCommit?: string;
    readonly createPullRequest: string;
    readonly dryRun: string;
  };
  readonly installedSourceProfiles?: readonly MemorySourceProfile[];
  readonly linearCommentAdapter?: {
    readonly authorizationScheme?: "api-key" | "bearer";
    readonly linearApiBaseUrl?: string;
    readonly secretResolver: LinearApiTokenSecretResolver;
    readonly userAgent: string;
  };
  readonly linearComments?: LinearCommentCapabilityAdapter;
  readonly linearSecretRefs?: {
    readonly createComment: string;
    readonly dryRun: string;
  };
  readonly laneRuntime?: AgentLaneRuntimePort;
  readonly maxActiveLanes: number;
  readonly model: string;
  readonly packageArtifacts: Pick<ArtifactStoreContract, "readJson">;
  readonly piAuthJsonBase64: string;
  readonly piAuthLeaseTtlSeconds?: number;
  readonly piAuthSecretRef: string;
  readonly postExecutionArtifactRecorders?: readonly WorkflowPostExecutionArtifactRecorderRegistration[];
  readonly provider?: "openai-codex";
  readonly provisionRunStore?: (
    request: WorkflowRunRequest
  ) => Promise<CloudflareArtifactsRunStore>;
  readonly repoNamePrefix?: string;
  readonly reviewGate?: ReviewGateActorContract;
  readonly sandbox?: DurableObjectNamespace<SandboxDurableObject>;
  readonly timeoutMs: number;
  readonly workflowNodeAdapter?: WorkflowNodeAdapterPort;
  readonly wzrrdPublishAdapter?: {
    readonly secretResolver: WzrrdApiTokenSecretResolver;
    readonly userAgent: string;
    readonly wzrrdApiBaseUrl?: string;
  };
  readonly wzrrdPublisher?: WzrrdPublishCapabilityAdapter;
  readonly wzrrdSecretRefs?: {
    readonly dryRun: string;
    readonly publish: string;
  };
  readonly wzrrdSiteRef?: string;
}

const workflowNodeAdapterDependency = (
  config: CloudflareWorkflowFrontDoorConfig,
  input: CloudflareWorkflowNodeAdapterFactoryInput
): { readonly workflowNodeAdapter?: WorkflowNodeAdapterPort } => {
  if (config.workflowNodeAdapter !== undefined) {
    return { workflowNodeAdapter: config.workflowNodeAdapter };
  }

  if (config.createWorkflowNodeAdapter !== undefined) {
    return { workflowNodeAdapter: config.createWorkflowNodeAdapter(input) };
  }

  return {};
};

const installedSourceProfilesDependency = (
  config: CloudflareWorkflowFrontDoorConfig
): {
  readonly installedSourceProfiles?: readonly MemorySourceProfile[];
} => {
  if (config.installedSourceProfiles === undefined) {
    return {};
  }

  return { installedSourceProfiles: config.installedSourceProfiles };
};

const postExecutionArtifactRecordersDependency = (
  config: CloudflareWorkflowFrontDoorConfig,
  input: CloudflarePostExecutionArtifactRecorderFactoryInput
): {
  readonly postExecutionArtifactRecorders?: readonly WorkflowPostExecutionArtifactRecorderRegistration[];
} => {
  if (config.postExecutionArtifactRecorders !== undefined) {
    return {
      postExecutionArtifactRecorders: config.postExecutionArtifactRecorders,
    };
  }

  if (config.createPostExecutionArtifactRecorders !== undefined) {
    return {
      postExecutionArtifactRecorders:
        config.createPostExecutionArtifactRecorders(input),
    };
  }

  return {};
};

const safeRepoNameSegment = (value: string): string => {
  const slug = value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-|-$/gu, "")
    .slice(0, 72);

  return slug.length === 0 ? crypto.randomUUID().slice(0, 8) : slug;
};

const defaultRunRepoName = (
  request: WorkflowRunRequest,
  prefix: string
): string =>
  `${safeRepoNameSegment(prefix)}-${safeRepoNameSegment(request.runId)}`.slice(
    0,
    96
  );

const supervisorRequestUrl = (path: string): string =>
  new URL(path, "https://workflow-capsule-supervisor.internal").toString();

const postJson = async (
  stub: DurableObjectStub,
  path: string,
  body: unknown
): Promise<unknown> => {
  const response = await stub.fetch(
    new Request(supervisorRequestUrl(path), {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
  );
  if (!response.ok) {
    throw new Error(`Capsule supervisor request failed: ${path}`);
  }

  return await response.json();
};

const createCapsuleSupervisorClient = (
  namespace: DurableObjectNamespace
): CapsuleSupervisorPorts => {
  const stubFor = (workItemId: string): DurableObjectStub =>
    namespace.get(namespace.idFromName(workItemId));

  return {
    async admitLane(input) {
      return AgentLaneAdmissionDecisionSchema.parse(
        await postJson(stubFor(input.workItemId), "/admit-lane", input)
      );
    },
    async appendEvent(input): Promise<void> {
      await postJson(stubFor(input.workItemId), "/append-event", input);
    },
    async loadLatestCheckpoint(input) {
      return LoadRunCheckpointResolutionSchema.parse(
        await postJson(
          stubFor(input.workItemId),
          "/load-latest-checkpoint",
          input
        )
      ).checkpoint;
    },
    async persistCheckpoint(input): Promise<void> {
      await postJson(stubFor(input.workItemId), "/persist-checkpoint", input);
    },
    async releaseLane(input) {
      return AgentLaneReleaseReceiptSchema.parse(
        await postJson(stubFor(input.workItemId), "/release-lane", input)
      );
    },
    async resolve(input) {
      return ContextCapsuleRecordSchema.parse(
        await postJson(stubFor(input.workItemId), "/resolve", input)
      );
    },
  };
};

const resolveCapsuleSupervisor = (
  config: CloudflareWorkflowFrontDoorConfig
): CapsuleSupervisorPorts => {
  if (config.contextCapsules !== undefined) {
    return config.contextCapsules;
  }

  if (config.capsuleSupervisor === undefined) {
    throw new Error(
      "Cloudflare workflow front door requires a capsule supervisor Durable Object namespace."
    );
  }

  return createCapsuleSupervisorClient(config.capsuleSupervisor);
};

const resolveLaneRuntime = async (
  config: CloudflareWorkflowFrontDoorConfig
): Promise<AgentLaneRuntimePort> => {
  if (config.laneRuntime !== undefined) {
    return config.laneRuntime;
  }

  if (config.sandbox === undefined) {
    throw new Error(
      "Cloudflare workflow front door requires a Sandbox namespace or injected lane runtime."
    );
  }

  const { createCloudflareSandboxPiAgentLaneRuntime } =
    await import("./cloudflare-sandbox-agent-lanes.ts");

  return createCloudflareSandboxPiAgentLaneRuntime({
    Sandbox: config.sandbox,
  });
};

const provisionRunStore = async (input: {
  readonly config: CloudflareWorkflowFrontDoorConfig;
  readonly request: WorkflowRunRequest;
}): Promise<CloudflareArtifactsRunStore> => {
  if (input.config.provisionRunStore !== undefined) {
    return await input.config.provisionRunStore(input.request);
  }

  if (input.config.artifacts === undefined) {
    throw new Error(
      "Cloudflare workflow front door requires an Artifacts binding or provisionRunStore override."
    );
  }

  return await provisionCloudflareArtifactsRunStore({
    artifacts: input.config.artifacts,
    description: `Workflow app run ${input.request.runId}`,
    repoName: defaultRunRepoName(
      input.request,
      input.config.repoNamePrefix ?? "piwf"
    ),
  });
};

const resolveCapabilityLeaseBroker = (input: {
  readonly config: CloudflareWorkflowFrontDoorConfig;
  readonly runStore: CloudflareArtifactsRunStore;
}): CapabilityLeaseBrokerActorContract => {
  if (input.config.capabilityLeases !== undefined) {
    return input.config.capabilityLeases;
  }

  if (input.config.capabilityLeasePolicy === undefined) {
    throw new Error(
      "Cloudflare workflow front door requires a capability lease broker or capability lease policy."
    );
  }

  return createCloudflareCapabilityLeaseBroker({
    artifacts: input.runStore.store,
    d1: input.config.d1,
    policy: input.config.capabilityLeasePolicy,
  });
};

const issuePiAuthLease = (input: {
  readonly runId: string;
  readonly secretRef: string;
  readonly ttlSeconds?: number | undefined;
  readonly workItemId: string;
}) => {
  const issuedAtDate = new Date();
  const expiresAtDate = new Date(
    issuedAtDate.getTime() + (input.ttlSeconds ?? 900) * 1000
  );

  return AgentAuthLeaseSchema.parse({
    expiresAt: expiresAtDate.toISOString(),
    issuedAt: issuedAtDate.toISOString(),
    leaseId: `lease:pi-agent-auth:${input.runId}:${crypto.randomUUID()}`,
    redacted: true,
    runId: input.runId,
    scope: "pi-agent-auth-json",
    secretRef: input.secretRef,
    workItemId: input.workItemId,
  });
};

const resolveLinearComments = (input: {
  readonly config: CloudflareWorkflowFrontDoorConfig;
  readonly secretRefs: {
    readonly createComment: string;
    readonly dryRun: string;
  };
}): LinearCommentCapabilityAdapter => {
  if (input.config.linearComments !== undefined) {
    return input.config.linearComments;
  }

  if (input.config.linearCommentAdapter === undefined) {
    return createDryRunLinearCommentAdapter();
  }

  return createCloudflareLinearCommentAdapter({
    linearCommentSecretRef: input.secretRefs.createComment,
    secretResolver: input.config.linearCommentAdapter.secretResolver,
    userAgent: input.config.linearCommentAdapter.userAgent,
    ...(input.config.linearCommentAdapter.authorizationScheme === undefined
      ? {}
      : {
          authorizationScheme:
            input.config.linearCommentAdapter.authorizationScheme,
        }),
    ...(input.config.linearCommentAdapter.linearApiBaseUrl === undefined
      ? {}
      : {
          linearApiBaseUrl: input.config.linearCommentAdapter.linearApiBaseUrl,
        }),
  });
};

/**
 * Default the drive options to whole-run when a caller (the legacy submit path)
 * omits them, so `startRun` carries no nullish branch of its own.
 */
const resolveDriveOptions = (
  options: WorkflowRunDriveOptions | undefined
): WorkflowRunDriveOptions => options ?? { driveMode: "whole-run" };

export const createCloudflareWorkflowFrontDoor = (
  config: CloudflareWorkflowFrontDoorConfig
): WorkerFrontDoorContract => ({
  route: "POST /runs",
  async startRun(input, options?: WorkflowRunDriveOptions) {
    const request = WorkflowRunRequestSchema.parse(input);
    const runStore = await provisionRunStore({ config, request });
    const capsuleSupervisor = resolveCapsuleSupervisor(config);
    const admittedRuntime = createAdmittedAgentLaneRuntime({
      admissionController: capsuleSupervisor,
      maxActiveLanes: config.maxActiveLanes,
      runtime: await resolveLaneRuntime(config),
    });
    const piAuthLease = issuePiAuthLease({
      runId: request.runId,
      secretRef: config.piAuthSecretRef,
      ttlSeconds: config.piAuthLeaseTtlSeconds,
      workItemId: request.workItemId,
    });
    const wzrrdSecretRefs = config.wzrrdSecretRefs ?? {
      dryRun: "secretref:wzrrd-dry-run",
      publish: "secretref:wzrrd-api",
    };
    const githubSecretRefs = config.githubSecretRefs ?? {
      createBranchCommit: "secretref:github-branch-commit",
      createPullRequest: "secretref:github-pr",
      dryRun: "secretref:github-dry-run",
    };
    const linearSecretRefs = config.linearSecretRefs ?? {
      createComment: "secretref:linear-api",
      dryRun: "secretref:linear-dry-run",
    };
    const laneAdapterConfig = {
      artifactRemote: runStore.artifactRemote,
      artifactStore: runStore.store,
      artifactTokenSecret: runStore.artifactTokenSecret,
      authLease: piAuthLease,
      leasedPiAuthJsonBase64: config.piAuthJsonBase64,
      model: config.model,
      provider: config.provider ?? "openai-codex",
      runtime: admittedRuntime,
      timeoutMs: config.timeoutMs,
    } as const;
    const workflow = new WorkflowApp({
      agentVerifierLane:
        createCloudflarePiVerifierLaneAdapter(laneAdapterConfig),
      agentWorkerLane: createCloudflarePiWorkerLaneAdapter(laneAdapterConfig),
      artifacts: runStore.store,
      capabilityLeases: resolveCapabilityLeaseBroker({
        config,
        runStore,
      }),
      contextCapsules: capsuleSupervisor,
      deterministicVerifier: createArtifactEvidenceDeterministicVerifier({
        artifacts: runStore.store,
      }),
      discordMessages: config.discordMessages,
      discordSecretRefs: config.discordSecretRefs,
      dynamicWorkflowPlanner:
        createCloudflarePiPlannerLaneAdapter(laneAdapterConfig),
      executionMode: "production",
      githubBranchCommits:
        config.githubBranchCommits ??
        (config.githubBranchCommitAdapter === undefined
          ? createDryRunGitHubBranchCommitAdapter()
          : createCloudflareGitHubBranchCommitAdapter({
              githubBranchCommitSecretRef:
                githubSecretRefs.createBranchCommit ??
                githubSecretRefs.createPullRequest,
              secretResolver: config.githubBranchCommitAdapter.secretResolver,
              userAgent: config.githubBranchCommitAdapter.userAgent,
              ...(config.githubBranchCommitAdapter.githubApiBaseUrl ===
              undefined
                ? {}
                : {
                    githubApiBaseUrl:
                      config.githubBranchCommitAdapter.githubApiBaseUrl,
                  }),
            })),
      githubPullRequests:
        config.githubPullRequests ??
        (config.githubPullRequestAdapter === undefined
          ? createDryRunGitHubPullRequestAdapter()
          : createCloudflareGitHubPullRequestAdapter({
              githubPullRequestSecretRef: githubSecretRefs.createPullRequest,
              secretResolver: config.githubPullRequestAdapter.secretResolver,
              userAgent: config.githubPullRequestAdapter.userAgent,
              ...(config.githubPullRequestAdapter.githubApiBaseUrl === undefined
                ? {}
                : {
                    githubApiBaseUrl:
                      config.githubPullRequestAdapter.githubApiBaseUrl,
                  }),
            })),
      githubSecretRefs,
      ...installedSourceProfilesDependency(config),
      linearComments: resolveLinearComments({
        config,
        secretRefs: linearSecretRefs,
      }),
      linearSecretRefs,
      observabilityRecorder: createCloudflareArtifactsObservabilityRecorder({
        artifacts: runStore.store,
        telemetrySink: createCompositeWorkflowTelemetrySink([
          createCloudflareArtifactsStructuredLogSink({
            artifacts: runStore.store,
          }),
          createCloudflareD1WorkflowTelemetrySink({
            d1: config.d1,
          }),
          ...(config.analyticsEngine === undefined
            ? []
            : [
                createCloudflareAnalyticsEngineWorkflowTelemetrySink({
                  analytics: config.analyticsEngine,
                  dataset:
                    config.analyticsEngineDataset ??
                    "pi_cloudflare_sandbox_workflows_telemetry",
                }),
              ]),
          ...(config.externalTelemetry === undefined
            ? []
            : [
                createExternalHttpWorkflowTelemetrySink(
                  config.externalTelemetry
                ),
              ]),
        ]),
      }),
      packageRegistry: createCloudflareD1PackageRegistryActor({
        artifacts: config.packageArtifacts,
        d1: config.d1,
      }),
      reviewGate:
        config.reviewGate ??
        createCloudflareReviewGateActor({
          artifacts: runStore.store,
          d1: config.d1,
        }),
      reviewSurfacePublisher: createCloudflareArtifactsReviewSurfacePublisher({
        acceptanceRefs: [brainProposalAcceptanceRef],
        artifacts: runStore.store,
      }),
      runtimeEnvironment: {
        platform: "cloudflare-workers",
        workerName: "pi-cloudflare-sandbox-workflows",
      },
      statusProjection: createCloudflareWorkflowStatusProjection({
        d1: config.d1,
      }),
      ...workflowNodeAdapterDependency(config, {
        // The "dream thinks" wire: the same admitted-runtime lane machinery the
        // planner/worker/verifier lanes use, handed to cartridge node adapters
        // so the agentic propose-refinements node reasons over the analysis
        // kernel skill. A config that injects its own `workflowNodeAdapter`
        // short-circuits this in `workflowNodeAdapterDependency`.
        analysisReasoningLane:
          createCloudflarePiAnalysisReasoningLaneAdapter(laneAdapterConfig),
        artifacts: runStore.store,
      }),
      ...postExecutionArtifactRecordersDependency(config, {
        artifacts: runStore.store,
      }),
      wzrrdPublisher:
        config.wzrrdPublisher ??
        (config.wzrrdPublishAdapter === undefined
          ? createDryRunWzrrdPublishAdapter()
          : createCloudflareWzrrdPublishAdapter({
              artifacts: runStore.store,
              secretResolver: config.wzrrdPublishAdapter.secretResolver,
              userAgent: config.wzrrdPublishAdapter.userAgent,
              wzrrdPublishSecretRef: wzrrdSecretRefs.publish,
              ...(config.wzrrdPublishAdapter.wzrrdApiBaseUrl === undefined
                ? {}
                : {
                    wzrrdApiBaseUrl: config.wzrrdPublishAdapter.wzrrdApiBaseUrl,
                  }),
            })),
      wzrrdSecretRefs,
      wzrrdSiteRef: config.wzrrdSiteRef ?? "wzrrd:default",
    });

    return await workflow.run(request, resolveDriveOptions(options));
  },
});
