/// <reference types="@cloudflare/workers-types" />

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { hashJson, sha256Hex } from "../../src/app/domain/hash.ts";
import {
  CapabilityLeaseSchema,
  GitHubPullRequestPayloadSchema,
} from "../../src/app/domain/schemas.ts";
import type {
  CapabilityLease,
  GitHubPullRequestPayload,
} from "../../src/app/domain/schemas.ts";
import { workflowTraceContextForCapability } from "../../src/app/domain/trace-context.ts";
import {
  createCloudflareGitHubPullRequestAdapter,
  createCloudflareGitHubTokenResolver,
} from "../../src/app/infrastructure/cloudflare-github-pull-request-adapter.ts";
import { buildIntegrationTestRunRequest } from "./workflow-app-fixtures.ts";

interface FetchCall {
  readonly body: string;
  readonly headers: Record<string, string>;
  readonly method: string;
  readonly url: string;
}

const GitHubPullRequestRequestBodySchema = z.object({
  base: z.string().min(1),
  body: z.string().min(1),
  head: z.string().min(1),
  maintainer_can_modify: z.literal(false),
  title: z.string().min(1),
});

const githubToken = "github-token-never-in-receipts";

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

const createFakeFetch = (response: Response) => {
  const calls: FetchCall[] = [];
  const fetcher: typeof fetch = (input, init) => {
    if (typeof init?.body !== "string") {
      throw new TypeError("Expected GitHub request body to be JSON text.");
    }

    calls.push({
      body: init.body,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      method: init.method ?? "GET",
      url: urlForFetchInput(input),
    });

    return Promise.resolve(response);
  };

  return { calls, fetcher };
};

const buildPayload = (): GitHubPullRequestPayload => {
  const request = buildIntegrationTestRunRequest();
  const body = [
    `# Review surface for ${request.runId}`,
    "",
    "Review surface artifact: artifact://github-pr-adapter/review/surface.json",
  ].join("\n");

  return GitHubPullRequestPayloadSchema.parse({
    baseBranch: "main",
    body,
    bodyHash: sha256Hex(body),
    headBranch: `workflow/${request.runId}`,
    redacted: true,
    repositoryRef: "joelhooks/pi-cloudflare-sandbox-workflows",
    reviewSurface: {
      artifactRef: `artifact://github-pr-adapter/runs/${request.runId}/review/surfaces/review-surface.json`,
      hash: "3".repeat(64),
      kind: "github-pr",
      surfaceId: `review-surface:${request.runId}`,
    },
    runId: request.runId,
    schemaVersion: "github.pull-request-payload.v1",
    title: `Review surface for ${request.runId}`,
    workItemId: request.workItemId,
  });
};

const buildLease = (input: {
  readonly dryRun?: boolean;
  readonly payload: GitHubPullRequestPayload;
  readonly secretRef?: string;
}): CapabilityLease => {
  const request = buildIntegrationTestRunRequest();

  return CapabilityLeaseSchema.parse({
    actor: request.actor,
    capability: "github.pull-request.create",
    capabilityRef: `capability:github.pull-request.create:${request.runId}`,
    dryRun: input.dryRun ?? false,
    expiresAt: "2026-06-08T23:59:00.000Z",
    leaseId: `lease:github.pull-request.create:${request.runId}`,
    payloadHash: hashJson(input.payload),
    payloadRef: `artifact://github-pr-adapter/runs/${request.runId}/payloads/github-pr.json`,
    policyId: "github-pr-policy",
    receiptSink: `artifact://github-pr-adapter/runs/${request.runId}/receipts/github-pr-capability.json`,
    redacted: true,
    resource: {
      baseBranch: input.payload.baseBranch,
      headBranch: input.payload.headBranch,
      kind: "github.repository",
      repositoryRef: input.payload.repositoryRef,
    },
    reviewGate: {
      approvalRef:
        "artifact://github-pr-adapter/review/github-pr-approval.json",
      mode: "approved",
      reviewerActorId: request.actor.id,
    },
    runId: request.runId,
    secretRef: input.secretRef ?? "secretref:github-pr",
    traceContext: workflowTraceContextForCapability({
      capability: "github.pull-request.create",
      runId: request.runId,
      stepId: "test:github-pr",
    }),
    workItemId: request.workItemId,
  });
};

describe("Cloudflare GitHub pull request adapter", () => {
  it("normalizes github:repo-prefixed dry-run compare URLs", async () => {
    const payload = GitHubPullRequestPayloadSchema.parse({
      ...buildPayload(),
      repositoryRef: "github:repo:joelhooks/pi-cloudflare-sandbox-workflows",
    });
    const lease = buildLease({ dryRun: true, payload });
    const adapter = createCloudflareGitHubPullRequestAdapter({
      githubPullRequestSecretRef: "secretref:github-pr",
      secretResolver: createCloudflareGitHubTokenResolver({
        secret: githubToken,
        secretRef: "secretref:github-pr",
      }),
      userAgent: "pi-cloudflare-sandbox-workflows/0.0.0",
    });

    const delivery = await adapter.execute({ lease, payload });

    expect(delivery).toMatchObject({
      pullRequestUrl: `https://github.com/joelhooks/pi-cloudflare-sandbox-workflows/compare/main...${encodeURIComponent(payload.headBranch)}?expand=1`,
      repositoryRef: payload.repositoryRef,
      status: "dry-run",
    });
  });

  it("opens an approved leased pull request without token leakage", async () => {
    const payload = buildPayload();
    const lease = buildLease({ payload });
    const fakeFetch = createFakeFetch(
      responseFrom({
        html_url:
          "https://github.com/joelhooks/pi-cloudflare-sandbox-workflows/pull/42",
        number: 42,
      })
    );
    const adapter = createCloudflareGitHubPullRequestAdapter({
      fetch: fakeFetch.fetcher,
      githubApiBaseUrl: "https://api.github.example.invalid",
      githubPullRequestSecretRef: "secretref:github-pr",
      now: () => "2026-06-08T23:59:10.000Z",
      secretResolver: createCloudflareGitHubTokenResolver({
        secret: githubToken,
        secretRef: "secretref:github-pr",
      }),
      userAgent: "pi-cloudflare-sandbox-workflows/0.0.0",
    });

    const delivery = await adapter.execute({ lease, payload });
    const requestBody = GitHubPullRequestRequestBodySchema.parse(
      JSON.parse(fakeFetch.calls[0]?.body ?? "{}")
    );

    expect({
      authorizationHeader: fakeFetch.calls[0]?.headers["authorization"],
      delivery,
      method: fakeFetch.calls[0]?.method,
      requestBody,
      tokenLeaked: JSON.stringify(delivery).includes(githubToken),
      url: fakeFetch.calls[0]?.url,
    }).toStrictEqual({
      authorizationHeader: `Bearer ${githubToken}`,
      delivery: {
        baseBranch: payload.baseBranch,
        dryRun: false,
        headBranch: payload.headBranch,
        openedAt: "2026-06-08T23:59:10.000Z",
        payloadHash: hashJson(payload),
        pullRequestNumber: 42,
        pullRequestUrl:
          "https://github.com/joelhooks/pi-cloudflare-sandbox-workflows/pull/42",
        redacted: true,
        repositoryRef: payload.repositoryRef,
        status: "opened",
      },
      method: "POST",
      requestBody: {
        base: payload.baseBranch,
        body: payload.body,
        head: payload.headBranch,
        maintainer_can_modify: false,
        title: payload.title,
      },
      tokenLeaked: false,
      url: "https://api.github.example.invalid/repos/joelhooks/pi-cloudflare-sandbox-workflows/pulls",
    });
  });

  it("returns a blocked delivery when GitHub fetch throws", async () => {
    const payload = buildPayload();
    const lease = buildLease({ payload });
    const adapter = createCloudflareGitHubPullRequestAdapter({
      fetch() {
        throw new Error("network unavailable");
      },
      githubApiBaseUrl: "https://api.github.example.invalid",
      githubPullRequestSecretRef: "secretref:github-pr",
      secretResolver: createCloudflareGitHubTokenResolver({
        secret: githubToken,
        secretRef: "secretref:github-pr",
      }),
      userAgent: "pi-cloudflare-sandbox-workflows/0.0.0",
    });

    const delivery = await adapter.execute({ lease, payload });

    expect(delivery).toMatchObject({
      blocker: {
        code: "adapter_unavailable",
      },
      status: "blocked",
    });
  });
});
