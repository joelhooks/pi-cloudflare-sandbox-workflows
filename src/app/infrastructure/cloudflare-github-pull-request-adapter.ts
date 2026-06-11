/// <reference types="@cloudflare/workers-types" />

import { z } from "zod";

import type { GitHubPullRequestCapabilityAdapter } from "../application/ports.ts";
import { hashJson } from "../domain/hash.ts";
import {
  CapabilityLeaseSchema,
  GitHubPullRequestDeliveryResultSchema,
  GitHubPullRequestPayloadSchema,
} from "../domain/schemas.ts";
import type {
  CapabilityDenialCode,
  CapabilityLease,
  GitHubPullRequestDeliveryResult,
  GitHubPullRequestPayload,
  GitHubRepositoryResource,
} from "../domain/schemas.ts";

type GitHubPullRequestLease = CapabilityLease & {
  readonly capability: "github.pull-request.create";
  readonly resource: GitHubRepositoryResource;
};

export interface GitHubTokenSecretResolver {
  resolve(input: {
    readonly leaseId: string;
    readonly runId: string;
    readonly secretRef: string;
  }): Promise<string | null>;
}

export interface CloudflareGitHubTokenSecretBinding {
  get(): Promise<null | string>;
}

export type CloudflareGitHubTokenBinding =
  | CloudflareGitHubTokenSecretBinding
  | string;

export interface CloudflareGitHubTokenResolverConfig {
  readonly secret: CloudflareGitHubTokenBinding;
  readonly secretRef: string;
}

export interface CloudflareGitHubPullRequestAdapterConfig {
  readonly fetch?: typeof fetch;
  readonly githubApiBaseUrl?: string;
  readonly githubPullRequestSecretRef: string;
  readonly now?: () => string;
  readonly secretResolver: GitHubTokenSecretResolver;
  /**
   * Hard ceiling for the GitHub create-pull-request round-trip. Without a bound
   * a stalled GitHub API hangs the fetch until workerd kills the whole drive
   * invocation; on timeout the throw flows into the existing catch and returns
   * a clean `adapter_unavailable` blocker the safety envelope records.
   */
  readonly timeoutMs?: number;
  readonly userAgent: string;
}

const GitHubCreatePullRequestResponseSchema = z.object({
  html_url: z.url(),
  number: z.number().int().min(1),
});

const defaultGitHubApiBaseUrl = "https://api.github.com";

const DEFAULT_GITHUB_TIMEOUT_MS = 30_000;

const blocked = (
  code: CapabilityDenialCode,
  message: string
): GitHubPullRequestDeliveryResult =>
  GitHubPullRequestDeliveryResultSchema.parse({
    blocker: {
      code,
      message,
      redacted: true,
    },
    status: "blocked",
  });

const repositoryParts = (
  repositoryRef: string
): null | { readonly owner: string; readonly repo: string } => {
  const normalized = repositoryRef.startsWith("github:repo:")
    ? repositoryRef.slice("github:repo:".length)
    : repositoryRef;
  const [owner, repo, ...rest] = normalized.split("/");
  if (
    owner === undefined ||
    owner.length === 0 ||
    repo === undefined ||
    repo.length === 0 ||
    rest.length > 0
  ) {
    return null;
  }

  return { owner, repo };
};

const isGitHubPullRequestLease = (
  lease: CapabilityLease
): lease is GitHubPullRequestLease =>
  lease.capability === "github.pull-request.create" &&
  lease.resource.kind === "github.repository";

const deliveryForDryRun = (input: {
  readonly lease: GitHubPullRequestLease;
  readonly payloadHash: string;
}): GitHubPullRequestDeliveryResult => {
  const normalizedRepositoryRef = input.lease.resource.repositoryRef.startsWith(
    "github:repo:"
  )
    ? input.lease.resource.repositoryRef.slice("github:repo:".length)
    : input.lease.resource.repositoryRef;

  return GitHubPullRequestDeliveryResultSchema.parse({
    baseBranch: input.lease.resource.baseBranch,
    dryRun: true,
    headBranch: input.lease.resource.headBranch,
    payloadHash: input.payloadHash,
    pullRequestUrl: `https://github.com/${normalizedRepositoryRef}/compare/${encodeURIComponent(input.lease.resource.baseBranch)}...${encodeURIComponent(input.lease.resource.headBranch)}?expand=1`,
    redacted: true,
    repositoryRef: input.lease.resource.repositoryRef,
    status: "dry-run",
  });
};

const validateLeasePayloadBinding = (input: {
  readonly lease: GitHubPullRequestLease;
  readonly payload: GitHubPullRequestPayload;
  readonly payloadHash: string;
}): GitHubPullRequestDeliveryResult | null => {
  if (input.payloadHash !== input.lease.payloadHash) {
    return blocked(
      "payload_hash_mismatch",
      "GitHub pull request payload no longer matches the lease."
    );
  }

  if (
    input.payload.repositoryRef !== input.lease.resource.repositoryRef ||
    input.payload.baseBranch !== input.lease.resource.baseBranch ||
    input.payload.headBranch !== input.lease.resource.headBranch
  ) {
    return blocked(
      "resource_scope_denied",
      "GitHub pull request payload resource does not match the leased repository resource."
    );
  }

  return null;
};

const blockerForGitHubStatus = (
  status: number
): GitHubPullRequestDeliveryResult => {
  if (status === 401 || status === 403) {
    return blocked("secret_denied", "GitHub rejected the configured token.");
  }

  if (status === 404) {
    return blocked(
      "resource_scope_denied",
      "GitHub could not access the leased repository resource."
    );
  }

  if (status === 422) {
    return blocked(
      "payload_hash_mismatch",
      "GitHub rejected the PR payload, usually because the branch is missing or a PR already exists."
    );
  }

  if (status === 429) {
    return blocked(
      "adapter_unavailable",
      "GitHub API rate limited the leased pull request creation."
    );
  }

  return blocked(
    "adapter_unavailable",
    `GitHub API rejected the leased pull request creation with HTTP ${status}.`
  );
};

export const createCloudflareGitHubTokenResolver = (
  config: CloudflareGitHubTokenResolverConfig
): GitHubTokenSecretResolver => ({
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

export const createCloudflareGitHubPullRequestAdapter = (
  config: CloudflareGitHubPullRequestAdapterConfig
): GitHubPullRequestCapabilityAdapter => ({
  async execute(input) {
    const lease = CapabilityLeaseSchema.parse(input.lease);
    const payload = GitHubPullRequestPayloadSchema.parse(input.payload);
    if (!isGitHubPullRequestLease(lease)) {
      return blocked(
        "capability_denied",
        "GitHub pull request adapter requires a GitHub pull request lease."
      );
    }

    const payloadHash = hashJson(payload);
    const bindingBlocker = validateLeasePayloadBinding({
      lease,
      payload,
      payloadHash,
    });
    if (bindingBlocker !== null) {
      return bindingBlocker;
    }

    if (lease.dryRun) {
      return deliveryForDryRun({ lease, payloadHash });
    }

    if (lease.reviewGate.mode !== "approved") {
      return blocked(
        lease.reviewGate.mode === "rejected"
          ? "review_rejected"
          : "review_required",
        "GitHub pull request creation requires approved review before execution."
      );
    }

    if (lease.secretRef !== config.githubPullRequestSecretRef) {
      return blocked(
        "secret_denied",
        "GitHub pull request creation requires the configured secret reference."
      );
    }

    const repository = repositoryParts(lease.resource.repositoryRef);
    if (repository === null) {
      return blocked(
        "resource_scope_denied",
        "GitHub repository reference must be owner/repo or github:repo:owner/repo."
      );
    }

    const token = await config.secretResolver.resolve({
      leaseId: lease.leaseId,
      runId: lease.runId,
      secretRef: lease.secretRef,
    });
    if (token === null) {
      return blocked(
        "secret_denied",
        "GitHub token could not be materialized for the leased pull request."
      );
    }

    let response: Response;
    try {
      response = await (config.fetch ?? fetch)(
        `${config.githubApiBaseUrl ?? defaultGitHubApiBaseUrl}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/pulls`,
        {
          body: JSON.stringify({
            base: lease.resource.baseBranch,
            body: payload.body,
            head: lease.resource.headBranch,
            maintainer_can_modify: false,
            title: payload.title,
          }),
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "User-Agent": config.userAgent,
            "X-GitHub-Api-Version": "2022-11-28",
          },
          method: "POST",
          signal: AbortSignal.timeout(
            config.timeoutMs ?? DEFAULT_GITHUB_TIMEOUT_MS
          ),
        }
      );
    } catch {
      return blockerForGitHubStatus(503);
    }

    if (!response.ok) {
      return blockerForGitHubStatus(response.status);
    }

    const result = GitHubCreatePullRequestResponseSchema.safeParse(
      await response.json()
    );
    if (!result.success) {
      return blocked(
        "adapter_unavailable",
        "GitHub create pull request response failed schema validation."
      );
    }

    return GitHubPullRequestDeliveryResultSchema.parse({
      baseBranch: lease.resource.baseBranch,
      dryRun: false,
      headBranch: lease.resource.headBranch,
      openedAt: config.now?.() ?? new Date().toISOString(),
      payloadHash,
      pullRequestNumber: result.data.number,
      pullRequestUrl: result.data.html_url,
      redacted: true,
      repositoryRef: lease.resource.repositoryRef,
      status: "opened",
    });
  },
});

export const createDryRunGitHubPullRequestAdapter =
  (): GitHubPullRequestCapabilityAdapter => ({
    execute(input) {
      const lease = CapabilityLeaseSchema.parse(input.lease);
      const payload = GitHubPullRequestPayloadSchema.parse(input.payload);
      if (!isGitHubPullRequestLease(lease)) {
        return Promise.resolve(
          blocked(
            "capability_denied",
            "GitHub pull request adapter requires a GitHub pull request lease."
          )
        );
      }

      const payloadHash = hashJson(payload);
      const bindingBlocker = validateLeasePayloadBinding({
        lease,
        payload,
        payloadHash,
      });
      if (bindingBlocker !== null) {
        return Promise.resolve(bindingBlocker);
      }

      if (!lease.dryRun) {
        return Promise.resolve(
          blocked(
            "adapter_unavailable",
            "Real GitHub pull request adapter is not configured."
          )
        );
      }

      return Promise.resolve(deliveryForDryRun({ lease, payloadHash }));
    },
  });
