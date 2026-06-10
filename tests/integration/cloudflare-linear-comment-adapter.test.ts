/// <reference types="@cloudflare/workers-types" />

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { hashJson, sha256Hex } from "../../src/app/domain/hash.ts";
import {
  CapabilityLeaseSchema,
  LinearCommentPayloadSchema,
} from "../../src/app/domain/schemas.ts";
import type {
  CapabilityLease,
  LinearCommentPayload,
} from "../../src/app/domain/schemas.ts";
import { workflowTraceContextForCapability } from "../../src/app/domain/trace-context.ts";
import {
  createCloudflareLinearApiTokenResolver,
  createCloudflareLinearCommentAdapter,
  createDryRunLinearCommentAdapter,
} from "../../src/app/infrastructure/cloudflare-linear-comment-adapter.ts";
import { buildIntegrationTestRunRequest } from "./workflow-app-fixtures.ts";

interface FetchCall {
  readonly body: string;
  readonly headers: Record<string, string>;
  readonly method: string;
  readonly url: string;
}

const LinearGraphQLRequestBodySchema = z.object({
  operationName: z.string().min(1),
  query: z.string().min(1),
  variables: z.record(z.string(), z.unknown()),
});

const linearToken = "linear-token-never-in-receipts";

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

const createFakeFetch = (responses: readonly Response[]) => {
  const calls: FetchCall[] = [];
  let index = 0;
  const fetcher: typeof fetch = (input, init) => {
    if (typeof init?.body !== "string") {
      throw new TypeError("Expected Linear request body to be JSON text.");
    }

    calls.push({
      body: init.body,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      method: init.method ?? "GET",
      url: urlForFetchInput(input),
    });
    const response = responses.at(index);
    index += 1;
    if (response === undefined) {
      throw new Error("Unexpected Linear fetch call.");
    }

    return Promise.resolve(response);
  };

  return { calls, fetcher };
};

const buildPayload = (): LinearCommentPayload => {
  const request = buildIntegrationTestRunRequest();
  const body = [
    `# Review surface for ${request.runId}`,
    "",
    "Review surface artifact: artifact://linear-adapter/review/surface.json",
  ].join("\n");

  return LinearCommentPayloadSchema.parse({
    body,
    bodyHash: sha256Hex(body),
    issueRef: "PIWF-123",
    redacted: true,
    reviewSurface: {
      artifactRef: `artifact://linear-adapter/runs/${request.runId}/review/surfaces/review-surface.json`,
      hash: "4".repeat(64),
      kind: "linear",
      surfaceId: `review-surface:${request.runId}`,
    },
    runId: request.runId,
    schemaVersion: "linear.comment-payload.v1",
    workItemId: request.workItemId,
  });
};

const buildLease = (input: {
  readonly dryRun?: boolean;
  readonly payload: LinearCommentPayload;
  readonly secretRef?: string;
}): CapabilityLease => {
  const request = buildIntegrationTestRunRequest();
  const dryRun = input.dryRun ?? false;

  return CapabilityLeaseSchema.parse({
    actor: request.actor,
    capability: "linear.comment.create",
    capabilityRef: `capability:linear.comment.create:${request.runId}:test:linear-comment`,
    dryRun,
    expiresAt: "2026-06-08T23:59:00.000Z",
    leaseId: `lease:linear.comment.create:${request.runId}:test:linear-comment`,
    payloadHash: hashJson(input.payload),
    payloadRef: `artifact://linear-adapter/runs/${request.runId}/payloads/linear-comment.json`,
    policyId: "linear-comment-policy",
    receiptSink: `artifact://linear-adapter/runs/${request.runId}/receipts/linear-comment-capability.json`,
    redacted: true,
    resource: {
      issueRef: input.payload.issueRef,
      kind: "linear.issue",
    },
    reviewGate: dryRun
      ? {
          mode: "dry-run-exempt",
          reason: "Linear adapter dry-run test.",
        }
      : {
          approvalRef:
            "artifact://linear-adapter/review/linear-comment-approval.json",
          mode: "approved",
          reviewerActorId: request.actor.id,
        },
    runId: request.runId,
    secretRef: input.secretRef ?? "secretref:linear-api",
    stepId: "test:linear-comment",
    traceContext: workflowTraceContextForCapability({
      capability: "linear.comment.create",
      runId: request.runId,
      stepId: "test:linear-comment",
    }),
    workItemId: request.workItemId,
  });
};

describe("Cloudflare Linear comment adapter", () => {
  it("creates an approved leased Linear comment without token leakage", async () => {
    const payload = buildPayload();
    const lease = buildLease({ payload });
    const fakeFetch = createFakeFetch([
      responseFrom({
        data: {
          issue: {
            id: "linear-issue-uuid",
            identifier: payload.issueRef,
            url: "https://linear.app/joelhooks/issue/PIWF-123/test",
          },
        },
      }),
      responseFrom({
        data: {
          commentCreate: {
            comment: {
              createdAt: "2026-06-08T23:59:10.000Z",
              id: "linear-comment-uuid",
              url: "https://linear.app/joelhooks/issue/PIWF-123/test#comment-linear-comment-uuid",
            },
            success: true,
          },
        },
      }),
    ]);
    const adapter = createCloudflareLinearCommentAdapter({
      authorizationScheme: "api-key",
      fetch: fakeFetch.fetcher,
      linearApiBaseUrl: "https://api.linear.example.invalid/graphql",
      linearCommentSecretRef: "secretref:linear-api",
      secretResolver: createCloudflareLinearApiTokenResolver({
        secret: linearToken,
        secretRef: "secretref:linear-api",
      }),
      userAgent: "pi-cloudflare-sandbox-workflows/0.0.0",
    });

    const delivery = await adapter.execute({ lease, payload });
    const lookupBody = LinearGraphQLRequestBodySchema.parse(
      JSON.parse(fakeFetch.calls[0]?.body ?? "{}")
    );
    const commentBody = LinearGraphQLRequestBodySchema.parse(
      JSON.parse(fakeFetch.calls[1]?.body ?? "{}")
    );

    expect({
      authorizationHeader: fakeFetch.calls[0]?.headers["authorization"],
      commentVariables: commentBody.variables,
      delivery,
      lookupVariables: lookupBody.variables,
      method: fakeFetch.calls[0]?.method,
      tokenLeaked: JSON.stringify(delivery).includes(linearToken),
      urls: fakeFetch.calls.map((call) => call.url),
    }).toStrictEqual({
      authorizationHeader: linearToken,
      commentVariables: {
        input: {
          body: payload.body,
          issueId: "linear-issue-uuid",
        },
      },
      delivery: {
        commentId: "linear-comment-uuid",
        commentUrl:
          "https://linear.app/joelhooks/issue/PIWF-123/test#comment-linear-comment-uuid",
        commentedAt: "2026-06-08T23:59:10.000Z",
        dryRun: false,
        issueRef: payload.issueRef,
        payloadHash: hashJson(payload),
        redacted: true,
        status: "commented",
      },
      lookupVariables: {
        id: payload.issueRef,
      },
      method: "POST",
      tokenLeaked: false,
      urls: [
        "https://api.linear.example.invalid/graphql",
        "https://api.linear.example.invalid/graphql",
      ],
    });
  });

  it("dry-runs leased Linear comments without materializing a token", async () => {
    const payload = buildPayload();
    const lease = buildLease({ dryRun: true, payload });
    const adapter = createDryRunLinearCommentAdapter();

    const delivery = await adapter.execute({ lease, payload });

    expect(delivery).toStrictEqual({
      dryRun: true,
      issueRef: payload.issueRef,
      payloadHash: hashJson(payload),
      redacted: true,
      status: "dry-run",
    });
  });
});
