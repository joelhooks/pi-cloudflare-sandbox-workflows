/// <reference types="@cloudflare/workers-types" />

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { hashJson, sha256Hex } from "../../src/app/domain/hash.ts";
import {
  CapabilityLeaseSchema,
  GitHubBranchCommitPayloadSchema,
} from "../../src/app/domain/schemas.ts";
import type {
  CapabilityLease,
  GitHubBranchCommitPayload,
} from "../../src/app/domain/schemas.ts";
import { workflowTraceContextForCapability } from "../../src/app/domain/trace-context.ts";
import { createCloudflareGitHubBranchCommitAdapter } from "../../src/app/infrastructure/cloudflare-github-branch-commit-adapter.ts";
import { createCloudflareGitHubTokenResolver } from "../../src/app/infrastructure/cloudflare-github-pull-request-adapter.ts";
import { buildIntegrationTestRunRequest } from "./workflow-app-fixtures.ts";

interface FetchCall {
  readonly body: string | null;
  readonly headers: Record<string, string>;
  readonly method: string;
  readonly url: string;
}

const GitHubTreeCreateBodySchema = z.object({
  base_tree: z.string().min(1),
  tree: z.array(
    z.object({
      content: z.string().min(1),
      mode: z.literal("100644"),
      path: z.string().min(1),
      type: z.literal("blob"),
    })
  ),
});

const GitHubCommitCreateBodySchema = z.object({
  message: z.string().min(1),
  parents: z.array(z.string().min(1)).length(1),
  tree: z.string().min(1),
});

const GitHubRefCreateBodySchema = z.object({
  ref: z.string().min(1),
  sha: z.string().min(1),
});

const githubToken = "github-token-never-in-branch-receipts";

const responseFrom = (body: unknown, status = 200): Response =>
  Response.json(body, { status });

const urlForFetchInput = (input: Parameters<typeof fetch>[0]): string => {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.href;
  }

  return input.url;
};

const createFakeFetch = () => {
  const responses = [
    responseFrom({}, 404),
    responseFrom({ object: { sha: "basecommitsha" } }),
    responseFrom({
      sha: "basecommitsha",
      tree: { sha: "basetreeshasha" },
    }),
    responseFrom({ sha: "newtreeshasha" }),
    responseFrom({
      html_url:
        "https://github.com/joelhooks/pi-cloudflare-sandbox-workflows/commit/newcommitsha",
      sha: "newcommitsha",
    }),
    responseFrom({ object: { sha: "newcommitsha" } }),
  ];
  const calls: FetchCall[] = [];
  const fetcher: typeof fetch = (input, init) => {
    calls.push({
      body: typeof init?.body === "string" ? init.body : null,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      method: init?.method ?? "GET",
      url: urlForFetchInput(input),
    });

    const response = responses.shift();
    if (response === undefined) {
      throw new Error("Unexpected GitHub fetch call.");
    }

    return Promise.resolve(response);
  };

  return { calls, fetcher };
};

const buildPayload = (): GitHubBranchCommitPayload => {
  const request = buildIntegrationTestRunRequest();
  const content = [
    `# Review surface for ${request.runId}`,
    "",
    "Review surface artifact: artifact://github-branch-adapter/review/surface.json",
  ].join("\n");

  return GitHubBranchCommitPayloadSchema.parse({
    baseBranch: "main",
    commitMessage: `Capture review surface for ${request.runId}`,
    files: [
      {
        content,
        contentHash: sha256Hex(content),
        mediaType: "text/markdown",
        path: `workflow-reviews/${request.runId}/review-surface.md`,
        redacted: true,
      },
    ],
    headBranch: `workflow/${request.runId}`,
    redacted: true,
    repositoryRef: "joelhooks/pi-cloudflare-sandbox-workflows",
    reviewSurface: {
      artifactRef: `artifact://github-branch-adapter/runs/${request.runId}/review/surfaces/review-surface.json`,
      hash: "4".repeat(64),
      kind: "github-pr",
      surfaceId: `review-surface:${request.runId}`,
    },
    runId: request.runId,
    schemaVersion: "github.branch-commit-payload.v1",
    workItemId: request.workItemId,
  });
};

const buildLease = (payload: GitHubBranchCommitPayload): CapabilityLease => {
  const request = buildIntegrationTestRunRequest();

  return CapabilityLeaseSchema.parse({
    actor: request.actor,
    capability: "github.branch.commit",
    capabilityRef: `capability:github.branch.commit:${request.runId}`,
    dryRun: false,
    expiresAt: "2026-06-08T23:59:00.000Z",
    leaseId: `lease:github.branch.commit:${request.runId}`,
    payloadHash: hashJson(payload),
    payloadRef: `artifact://github-branch-adapter/runs/${request.runId}/payloads/github-branch-commit.json`,
    policyId: "github-branch-policy",
    receiptSink: `artifact://github-branch-adapter/runs/${request.runId}/receipts/github-branch-commit-capability.json`,
    redacted: true,
    resource: {
      baseBranch: payload.baseBranch,
      headBranch: payload.headBranch,
      kind: "github.repository",
      repositoryRef: payload.repositoryRef,
    },
    reviewGate: {
      approvalRef:
        "artifact://github-branch-adapter/review/github-branch-commit-approval.json",
      mode: "approved",
      reviewerActorId: request.actor.id,
    },
    runId: request.runId,
    secretRef: "secretref:github-branch-commit",
    traceContext: workflowTraceContextForCapability({
      capability: "github.branch.commit",
      runId: request.runId,
      stepId: "test:github-branch",
    }),
    workItemId: request.workItemId,
  });
};

describe("Cloudflare GitHub branch commit adapter", () => {
  it("commits approved leased review files without token leakage", async () => {
    const payload = buildPayload();
    const lease = buildLease(payload);
    const fakeFetch = createFakeFetch();
    const adapter = createCloudflareGitHubBranchCommitAdapter({
      fetch: fakeFetch.fetcher,
      githubApiBaseUrl: "https://api.github.example.invalid",
      githubBranchCommitSecretRef: "secretref:github-branch-commit",
      now: () => "2026-06-08T23:59:10.000Z",
      secretResolver: createCloudflareGitHubTokenResolver({
        secret: githubToken,
        secretRef: "secretref:github-branch-commit",
      }),
      userAgent: "pi-cloudflare-sandbox-workflows/0.0.0",
    });

    const delivery = await adapter.execute({ lease, payload });
    const treeBody = GitHubTreeCreateBodySchema.parse(
      JSON.parse(fakeFetch.calls[3]?.body ?? "{}")
    );
    const commitBody = GitHubCommitCreateBodySchema.parse(
      JSON.parse(fakeFetch.calls[4]?.body ?? "{}")
    );
    const refBody = GitHubRefCreateBodySchema.parse(
      JSON.parse(fakeFetch.calls[5]?.body ?? "{}")
    );

    expect({
      authorizationHeader: fakeFetch.calls[1]?.headers["authorization"],
      callMethods: fakeFetch.calls.map((call) => call.method),
      commitBody,
      delivery,
      refBody,
      tokenLeaked: JSON.stringify(delivery).includes(githubToken),
      treeBody,
      urls: fakeFetch.calls.map((call) => call.url),
    }).toStrictEqual({
      authorizationHeader: `Bearer ${githubToken}`,
      callMethods: ["GET", "GET", "GET", "POST", "POST", "POST"],
      commitBody: {
        message: payload.commitMessage,
        parents: ["basecommitsha"],
        tree: "newtreeshasha",
      },
      delivery: {
        baseBranch: payload.baseBranch,
        commitSha: "newcommitsha",
        commitUrl:
          "https://github.com/joelhooks/pi-cloudflare-sandbox-workflows/commit/newcommitsha",
        committedAt: "2026-06-08T23:59:10.000Z",
        dryRun: false,
        fileCount: 1,
        headBranch: payload.headBranch,
        payloadHash: hashJson(payload),
        redacted: true,
        repositoryRef: payload.repositoryRef,
        status: "committed",
      },
      refBody: {
        ref: `refs/heads/${payload.headBranch}`,
        sha: "newcommitsha",
      },
      tokenLeaked: false,
      treeBody: {
        base_tree: "basetreeshasha",
        tree: [
          {
            content: payload.files[0]?.content,
            mode: "100644",
            path: payload.files[0]?.path,
            type: "blob",
          },
        ],
      },
      urls: [
        `https://api.github.example.invalid/repos/joelhooks/pi-cloudflare-sandbox-workflows/git/ref/heads/${encodeURIComponent(payload.headBranch)}`,
        "https://api.github.example.invalid/repos/joelhooks/pi-cloudflare-sandbox-workflows/git/ref/heads/main",
        "https://api.github.example.invalid/repos/joelhooks/pi-cloudflare-sandbox-workflows/git/commits/basecommitsha",
        "https://api.github.example.invalid/repos/joelhooks/pi-cloudflare-sandbox-workflows/git/trees",
        "https://api.github.example.invalid/repos/joelhooks/pi-cloudflare-sandbox-workflows/git/commits",
        "https://api.github.example.invalid/repos/joelhooks/pi-cloudflare-sandbox-workflows/git/refs",
      ],
    });
  });
});
