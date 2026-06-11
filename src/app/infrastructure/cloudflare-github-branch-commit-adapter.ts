/// <reference types="@cloudflare/workers-types" />

import { z } from "zod";

import type { GitHubBranchCommitCapabilityAdapter } from "../application/ports.ts";
import { hashJson, sha256Hex } from "../domain/hash.ts";
import {
  CapabilityLeaseSchema,
  GitHubBranchCommitDeliveryResultSchema,
  GitHubBranchCommitPayloadSchema,
} from "../domain/schemas.ts";
import type {
  CapabilityDenialCode,
  CapabilityLease,
  GitHubBranchCommitDeliveryResult,
  GitHubBranchCommitPayload,
  GitHubRepositoryResource,
} from "../domain/schemas.ts";
import type { GitHubTokenSecretResolver } from "./cloudflare-github-pull-request-adapter.ts";

type GitHubBranchCommitLease = CapabilityLease & {
  readonly capability: "github.branch.commit";
  readonly resource: GitHubRepositoryResource;
};

export interface CloudflareGitHubBranchCommitAdapterConfig {
  readonly fetch?: typeof fetch;
  readonly githubApiBaseUrl?: string;
  readonly githubBranchCommitSecretRef: string;
  readonly now?: () => string;
  readonly secretResolver: GitHubTokenSecretResolver;
  /**
   * Hard ceiling for each GitHub Git Data round-trip in the multi-step commit
   * dance. Without a bound a stalled GitHub API hangs a fetch until workerd
   * kills the whole drive invocation; on timeout the step returns a clean
   * `adapter_unavailable` blocker the safety envelope records and surfaces.
   */
  readonly timeoutMs?: number;
  readonly userAgent: string;
}

const GitHubRefResponseSchema = z.object({
  object: z.object({
    sha: z.string().min(1),
  }),
});

const GitHubCommitResponseSchema = z.object({
  html_url: z.url().optional(),
  sha: z.string().min(1),
  tree: z.object({
    sha: z.string().min(1),
  }),
});

const GitHubTreeResponseSchema = z.object({
  sha: z.string().min(1),
});

const GitHubCreatedCommitResponseSchema = z.object({
  html_url: z.url().optional(),
  sha: z.string().min(1),
});

const defaultGitHubApiBaseUrl = "https://api.github.com";

const DEFAULT_GITHUB_TIMEOUT_MS = 30_000;

const blocked = (
  code: CapabilityDenialCode,
  message: string
): GitHubBranchCommitDeliveryResult =>
  GitHubBranchCommitDeliveryResultSchema.parse({
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

const isGitHubBranchCommitLease = (
  lease: CapabilityLease
): lease is GitHubBranchCommitLease =>
  lease.capability === "github.branch.commit" &&
  lease.resource.kind === "github.repository";

const isSafeRepositoryPath = (path: string): boolean => {
  if (path.startsWith("/") || path.includes("\\")) {
    return false;
  }

  return path
    .split("/")
    .every(
      (segment) => segment.length > 0 && segment !== "." && segment !== ".."
    );
};

const branchUrlFor = (input: {
  readonly headBranch: string;
  readonly repositoryRef: string;
}): string =>
  `https://github.com/${input.repositoryRef}/tree/${encodeURIComponent(input.headBranch)}`;

const deliveryForDryRun = (input: {
  readonly lease: GitHubBranchCommitLease;
  readonly payload: GitHubBranchCommitPayload;
  readonly payloadHash: string;
}): GitHubBranchCommitDeliveryResult =>
  GitHubBranchCommitDeliveryResultSchema.parse({
    baseBranch: input.lease.resource.baseBranch,
    branchUrl: branchUrlFor({
      headBranch: input.lease.resource.headBranch,
      repositoryRef: input.lease.resource.repositoryRef,
    }),
    dryRun: true,
    fileCount: input.payload.files.length,
    headBranch: input.lease.resource.headBranch,
    payloadHash: input.payloadHash,
    redacted: true,
    repositoryRef: input.lease.resource.repositoryRef,
    status: "dry-run",
  });

const validateLeasePayloadBinding = (input: {
  readonly lease: GitHubBranchCommitLease;
  readonly payload: GitHubBranchCommitPayload;
  readonly payloadHash: string;
}): GitHubBranchCommitDeliveryResult | null => {
  if (input.payloadHash !== input.lease.payloadHash) {
    return blocked(
      "payload_hash_mismatch",
      "GitHub branch commit payload no longer matches the lease."
    );
  }

  if (
    input.payload.repositoryRef !== input.lease.resource.repositoryRef ||
    input.payload.baseBranch !== input.lease.resource.baseBranch ||
    input.payload.headBranch !== input.lease.resource.headBranch
  ) {
    return blocked(
      "resource_scope_denied",
      "GitHub branch commit payload resource does not match the leased repository resource."
    );
  }

  for (const file of input.payload.files) {
    if (!isSafeRepositoryPath(file.path)) {
      return blocked(
        "resource_scope_denied",
        "GitHub branch commit payload contains an unsafe repository path."
      );
    }

    if (sha256Hex(file.content) !== file.contentHash) {
      return blocked(
        "payload_hash_mismatch",
        "GitHub branch commit file content hash does not match the pinned payload."
      );
    }
  }

  return null;
};

const blockerForGitHubStatus = (
  action: string,
  status: number
): GitHubBranchCommitDeliveryResult => {
  if (status === 401 || status === 403) {
    return blocked("secret_denied", "GitHub rejected the configured token.");
  }

  if (status === 404) {
    return blocked(
      "resource_scope_denied",
      `GitHub could not access the leased repository resource while trying to ${action}.`
    );
  }

  if (status === 422) {
    return blocked(
      "resource_scope_denied",
      `GitHub rejected the leased branch commit while trying to ${action}.`
    );
  }

  if (status === 429) {
    return blocked(
      "adapter_unavailable",
      `GitHub API rate limited the leased branch commit while trying to ${action}.`
    );
  }

  return blocked(
    "adapter_unavailable",
    `GitHub API rejected the leased branch commit while trying to ${action} with HTTP ${status}.`
  );
};

const githubHeaders = (input: {
  readonly token: string;
  readonly userAgent: string;
}): Record<string, string> => ({
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${input.token}`,
  "Content-Type": "application/json",
  "User-Agent": input.userAgent,
  "X-GitHub-Api-Version": "2022-11-28",
});

const readJson = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch (error) {
    throw new Error("GitHub response body was not valid JSON.", {
      cause: error,
    });
  }
};

const boundedGitHubRequest = (
  config: CloudflareGitHubBranchCommitAdapterConfig
): typeof fetch => {
  const fetcher = config.fetch ?? fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_GITHUB_TIMEOUT_MS;

  return (url, init) =>
    fetcher(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
};

const executeGitHubBranchCommit = async (input: {
  readonly config: CloudflareGitHubBranchCommitAdapterConfig;
  readonly lease: GitHubBranchCommitLease;
  readonly payload: GitHubBranchCommitPayload;
  readonly payloadHash: string;
  readonly repository: { readonly owner: string; readonly repo: string };
  readonly token: string;
}): Promise<GitHubBranchCommitDeliveryResult> => {
  const request = boundedGitHubRequest(input.config);
  const apiBase = `${input.config.githubApiBaseUrl ?? defaultGitHubApiBaseUrl}/repos/${encodeURIComponent(input.repository.owner)}/${encodeURIComponent(input.repository.repo)}`;
  const headers = githubHeaders({
    token: input.token,
    userAgent: input.config.userAgent,
  });
  const encodedHeadBranch = encodeURIComponent(input.lease.resource.headBranch);
  const encodedBaseBranch = encodeURIComponent(input.lease.resource.baseBranch);
  const headRefResponse = await request(
    `${apiBase}/git/ref/heads/${encodedHeadBranch}`,
    { headers, method: "GET" }
  );
  const branchExists = headRefResponse.ok;
  const refResponse = branchExists
    ? headRefResponse
    : await request(`${apiBase}/git/ref/heads/${encodedBaseBranch}`, {
        headers,
        method: "GET",
      });
  if (!refResponse.ok) {
    return blockerForGitHubStatus("read branch ref", refResponse.status);
  }

  const refJson = await readJson(refResponse);
  const refBlocker = GitHubBranchCommitDeliveryResultSchema.safeParse(refJson);
  if (refBlocker.success) {
    return refBlocker.data;
  }
  const ref = GitHubRefResponseSchema.safeParse(refJson);
  if (!ref.success) {
    return blocked(
      "adapter_unavailable",
      "GitHub ref response failed schema validation."
    );
  }

  const parentCommitResponse = await request(
    `${apiBase}/git/commits/${encodeURIComponent(ref.data.object.sha)}`,
    { headers, method: "GET" }
  );
  if (!parentCommitResponse.ok) {
    return blockerForGitHubStatus(
      "read parent commit",
      parentCommitResponse.status
    );
  }

  const parentCommitJson = await readJson(parentCommitResponse);
  const parentCommitBlocker =
    GitHubBranchCommitDeliveryResultSchema.safeParse(parentCommitJson);
  if (parentCommitBlocker.success) {
    return parentCommitBlocker.data;
  }
  const parentCommit = GitHubCommitResponseSchema.safeParse(parentCommitJson);
  if (!parentCommit.success) {
    return blocked(
      "adapter_unavailable",
      "GitHub parent commit response failed schema validation."
    );
  }

  const treeResponse = await request(`${apiBase}/git/trees`, {
    body: JSON.stringify({
      base_tree: parentCommit.data.tree.sha,
      tree: input.payload.files.map((file) => ({
        content: file.content,
        mode: "100644",
        path: file.path,
        type: "blob",
      })),
    }),
    headers,
    method: "POST",
  });
  if (!treeResponse.ok) {
    return blockerForGitHubStatus("create tree", treeResponse.status);
  }

  const treeJson = await readJson(treeResponse);
  const treeBlocker =
    GitHubBranchCommitDeliveryResultSchema.safeParse(treeJson);
  if (treeBlocker.success) {
    return treeBlocker.data;
  }
  const tree = GitHubTreeResponseSchema.safeParse(treeJson);
  if (!tree.success) {
    return blocked(
      "adapter_unavailable",
      "GitHub tree response failed schema validation."
    );
  }

  const commitResponse = await request(`${apiBase}/git/commits`, {
    body: JSON.stringify({
      message: input.payload.commitMessage,
      parents: [parentCommit.data.sha],
      tree: tree.data.sha,
    }),
    headers,
    method: "POST",
  });
  if (!commitResponse.ok) {
    return blockerForGitHubStatus("create commit", commitResponse.status);
  }

  const commitJson = await readJson(commitResponse);
  const commitBlocker =
    GitHubBranchCommitDeliveryResultSchema.safeParse(commitJson);
  if (commitBlocker.success) {
    return commitBlocker.data;
  }
  const commit = GitHubCreatedCommitResponseSchema.safeParse(commitJson);
  if (!commit.success) {
    return blocked(
      "adapter_unavailable",
      "GitHub created commit response failed schema validation."
    );
  }

  const refWriteResponse = branchExists
    ? await request(`${apiBase}/git/refs/heads/${encodedHeadBranch}`, {
        body: JSON.stringify({
          force: false,
          sha: commit.data.sha,
        }),
        headers,
        method: "PATCH",
      })
    : await request(`${apiBase}/git/refs`, {
        body: JSON.stringify({
          ref: `refs/heads/${input.lease.resource.headBranch}`,
          sha: commit.data.sha,
        }),
        headers,
        method: "POST",
      });
  if (!refWriteResponse.ok) {
    return blockerForGitHubStatus("write branch ref", refWriteResponse.status);
  }

  return GitHubBranchCommitDeliveryResultSchema.parse({
    baseBranch: input.lease.resource.baseBranch,
    commitSha: commit.data.sha,
    commitUrl: commit.data.html_url,
    committedAt: input.config.now?.() ?? new Date().toISOString(),
    dryRun: false,
    fileCount: input.payload.files.length,
    headBranch: input.lease.resource.headBranch,
    payloadHash: input.payloadHash,
    redacted: true,
    repositoryRef: input.lease.resource.repositoryRef,
    status: "committed",
  });
};

export const createCloudflareGitHubBranchCommitAdapter = (
  config: CloudflareGitHubBranchCommitAdapterConfig
): GitHubBranchCommitCapabilityAdapter => ({
  async execute(input) {
    const lease = CapabilityLeaseSchema.parse(input.lease);
    const payload = GitHubBranchCommitPayloadSchema.parse(input.payload);
    if (!isGitHubBranchCommitLease(lease)) {
      return blocked(
        "capability_denied",
        "GitHub branch commit adapter requires a GitHub branch commit lease."
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
      return deliveryForDryRun({ lease, payload, payloadHash });
    }

    if (lease.reviewGate.mode !== "approved") {
      return blocked(
        lease.reviewGate.mode === "rejected"
          ? "review_rejected"
          : "review_required",
        "GitHub branch commit requires approved review before execution."
      );
    }

    if (lease.secretRef !== config.githubBranchCommitSecretRef) {
      return blocked(
        "secret_denied",
        "GitHub branch commit requires the configured secret reference."
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
        "GitHub token could not be materialized for the leased branch commit."
      );
    }

    try {
      return await executeGitHubBranchCommit({
        config,
        lease,
        payload,
        payloadHash,
        repository,
        token,
      });
    } catch (error) {
      const timeoutMs = config.timeoutMs ?? DEFAULT_GITHUB_TIMEOUT_MS;

      return blocked(
        "adapter_unavailable",
        error instanceof Error && error.name === "TimeoutError"
          ? `GitHub API did not respond within ${timeoutMs}ms.`
          : `GitHub API request failed: ${
              error instanceof Error ? error.name : "network error"
            }.`
      );
    }
  },
});

export const createDryRunGitHubBranchCommitAdapter =
  (): GitHubBranchCommitCapabilityAdapter => ({
    execute(input) {
      const lease = CapabilityLeaseSchema.parse(input.lease);
      const payload = GitHubBranchCommitPayloadSchema.parse(input.payload);
      if (!isGitHubBranchCommitLease(lease)) {
        return Promise.resolve(
          blocked(
            "capability_denied",
            "GitHub branch commit adapter requires a GitHub branch commit lease."
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
            "Real GitHub branch commit adapter is not configured."
          )
        );
      }

      return Promise.resolve(
        deliveryForDryRun({ lease, payload, payloadHash })
      );
    },
  });
