/// <reference types="@cloudflare/workers-types" />

import { z } from "zod";

import type { LinearCommentCapabilityAdapter } from "../application/ports.ts";
import { hashJson, sha256Hex } from "../domain/hash.ts";
import {
  CapabilityLeaseSchema,
  LinearCommentDeliveryResultSchema,
  LinearCommentPayloadSchema,
} from "../domain/schemas.ts";
import type {
  CapabilityDenialCode,
  CapabilityLease,
  LinearCommentDeliveryResult,
  LinearCommentPayload,
  LinearIssueResource,
} from "../domain/schemas.ts";

type LinearCommentLease = CapabilityLease & {
  readonly capability: "linear.comment.create";
  readonly resource: LinearIssueResource;
};

export interface LinearApiTokenSecretResolver {
  resolve(input: {
    readonly leaseId: string;
    readonly runId: string;
    readonly secretRef: string;
  }): Promise<string | null>;
}

export interface CloudflareLinearApiTokenSecretBinding {
  get(): Promise<null | string>;
}

export type CloudflareLinearApiTokenBinding =
  | CloudflareLinearApiTokenSecretBinding
  | string;

export interface CloudflareLinearApiTokenResolverConfig {
  readonly secret: CloudflareLinearApiTokenBinding;
  readonly secretRef: string;
}

export interface CloudflareLinearCommentAdapterConfig {
  readonly authorizationScheme?: "api-key" | "bearer";
  readonly fetch?: typeof fetch;
  readonly linearApiBaseUrl?: string;
  readonly linearCommentSecretRef: string;
  readonly now?: () => string;
  readonly secretResolver: LinearApiTokenSecretResolver;
  readonly userAgent: string;
}

const LinearGraphQLErrorSchema = z.object({
  message: z.string().min(1),
});

const LinearIssueLookupResponseSchema = z.object({
  data: z
    .object({
      issue: z
        .object({
          id: z.string().min(1),
          identifier: z.string().min(1).optional(),
          url: z.url().optional(),
        })
        .nullable(),
    })
    .optional(),
  errors: z.array(LinearGraphQLErrorSchema).optional(),
});

const LinearCommentCreateResponseSchema = z.object({
  data: z
    .object({
      commentCreate: z.object({
        comment: z
          .object({
            createdAt: z.string().min(1).optional(),
            id: z.string().min(1),
            url: z.url(),
          })
          .nullable(),
        success: z.boolean(),
      }),
    })
    .optional(),
  errors: z.array(LinearGraphQLErrorSchema).optional(),
});

const defaultLinearApiBaseUrl = "https://api.linear.app/graphql";

const blocked = (
  code: CapabilityDenialCode,
  message: string
): LinearCommentDeliveryResult =>
  LinearCommentDeliveryResultSchema.parse({
    blocker: {
      code,
      message,
      redacted: true,
    },
    status: "blocked",
  });

const isLinearCommentLease = (
  lease: CapabilityLease
): lease is LinearCommentLease =>
  lease.capability === "linear.comment.create" &&
  lease.resource.kind === "linear.issue";

const deliveryForDryRun = (input: {
  readonly lease: LinearCommentLease;
  readonly payloadHash: string;
}): LinearCommentDeliveryResult =>
  LinearCommentDeliveryResultSchema.parse({
    dryRun: true,
    issueRef: input.lease.resource.issueRef,
    payloadHash: input.payloadHash,
    redacted: true,
    status: "dry-run",
  });

const validateLeasePayloadBinding = (input: {
  readonly lease: LinearCommentLease;
  readonly payload: LinearCommentPayload;
  readonly payloadHash: string;
}): LinearCommentDeliveryResult | null => {
  if (input.payloadHash !== input.lease.payloadHash) {
    return blocked(
      "payload_hash_mismatch",
      "Linear comment payload no longer matches the lease."
    );
  }

  if (sha256Hex(input.payload.body) !== input.payload.bodyHash) {
    return blocked(
      "payload_hash_mismatch",
      "Linear comment body hash does not match the pinned payload."
    );
  }

  if (input.payload.issueRef !== input.lease.resource.issueRef) {
    return blocked(
      "resource_scope_denied",
      "Linear comment payload issue does not match the leased issue resource."
    );
  }

  return null;
};

const authorizationHeader = (input: {
  readonly scheme: "api-key" | "bearer";
  readonly token: string;
}): string => {
  if (input.token.startsWith("Bearer ")) {
    return input.token;
  }

  return input.scheme === "bearer" ? `Bearer ${input.token}` : input.token;
};

const linearHeaders = (input: {
  readonly authorizationScheme: "api-key" | "bearer";
  readonly token: string;
  readonly userAgent: string;
}): Record<string, string> => ({
  Accept: "application/json",
  Authorization: authorizationHeader({
    scheme: input.authorizationScheme,
    token: input.token,
  }),
  "Content-Type": "application/json",
  "User-Agent": input.userAgent,
});

const readJson = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    return blocked(
      "adapter_unavailable",
      "Linear response body was not valid JSON."
    );
  }
};

const blockerForLinearStatus = (
  status: number
): LinearCommentDeliveryResult => {
  if (status === 401 || status === 403) {
    return blocked(
      "secret_denied",
      "Linear rejected the configured API token."
    );
  }

  if (status === 404) {
    return blocked(
      "resource_scope_denied",
      "Linear could not access the leased issue resource."
    );
  }

  if (status === 429) {
    return blocked(
      "adapter_unavailable",
      "Linear API rate limited the leased comment creation."
    );
  }

  return blocked(
    "adapter_unavailable",
    `Linear API rejected the leased comment creation with HTTP ${status}.`
  );
};

const blockerForLinearErrors = (
  errors: readonly z.infer<typeof LinearGraphQLErrorSchema>[]
): LinearCommentDeliveryResult => {
  const firstMessage = errors.at(0)?.message ?? "unknown GraphQL error";
  if (/not found|invalid issue|issue/iu.test(firstMessage)) {
    return blocked(
      "resource_scope_denied",
      `Linear GraphQL could not resolve the leased issue: ${firstMessage}`
    );
  }

  if (/auth|permission|forbidden|unauthorized/iu.test(firstMessage)) {
    return blocked(
      "secret_denied",
      `Linear GraphQL rejected the configured token: ${firstMessage}`
    );
  }

  return blocked(
    "adapter_unavailable",
    `Linear GraphQL rejected the leased comment creation: ${firstMessage}`
  );
};

const executeLinearGraphql = async (input: {
  readonly body: unknown;
  readonly config: CloudflareLinearCommentAdapterConfig;
  readonly headers: Record<string, string>;
}): Promise<unknown> => {
  const response = await (input.config.fetch ?? fetch)(
    input.config.linearApiBaseUrl ?? defaultLinearApiBaseUrl,
    {
      body: JSON.stringify(input.body),
      headers: input.headers,
      method: "POST",
    }
  );
  if (!response.ok) {
    return blockerForLinearStatus(response.status);
  }

  const json = await readJson(response);
  const resultBlocker = LinearCommentDeliveryResultSchema.safeParse(json);
  if (resultBlocker.success) {
    return resultBlocker.data;
  }

  return json;
};

const configNow = (
  config: CloudflareLinearCommentAdapterConfig,
  candidate?: string
): string => candidate ?? config.now?.() ?? new Date().toISOString();

const executeLinearCommentCreate = async (input: {
  readonly config: CloudflareLinearCommentAdapterConfig;
  readonly lease: LinearCommentLease;
  readonly payload: LinearCommentPayload;
  readonly payloadHash: string;
  readonly token: string;
}): Promise<LinearCommentDeliveryResult> => {
  const headers = linearHeaders({
    authorizationScheme: input.config.authorizationScheme ?? "api-key",
    token: input.token,
    userAgent: input.config.userAgent,
  });
  const issueLookupJson = await executeLinearGraphql({
    body: {
      operationName: "WorkflowAppLinearIssue",
      query: `query WorkflowAppLinearIssue($id: String!) {
        issue(id: $id) {
          id
          identifier
          url
        }
      }`,
      variables: {
        id: input.lease.resource.issueRef,
      },
    },
    config: input.config,
    headers,
  });
  const issueLookupBlocker =
    LinearCommentDeliveryResultSchema.safeParse(issueLookupJson);
  if (issueLookupBlocker.success) {
    return issueLookupBlocker.data;
  }

  const issueLookup =
    LinearIssueLookupResponseSchema.safeParse(issueLookupJson);
  if (!issueLookup.success) {
    return blocked(
      "adapter_unavailable",
      "Linear issue lookup response failed schema validation."
    );
  }
  if (
    issueLookup.data.errors !== undefined &&
    issueLookup.data.errors.length > 0
  ) {
    return blockerForLinearErrors(issueLookup.data.errors);
  }
  const issue = issueLookup.data.data?.issue;
  if (issue === undefined || issue === null) {
    return blocked(
      "resource_scope_denied",
      "Linear issue lookup returned no issue for the leased issue ref."
    );
  }

  const commentJson = await executeLinearGraphql({
    body: {
      operationName: "WorkflowAppLinearCommentCreate",
      query: `mutation WorkflowAppLinearCommentCreate($input: CommentCreateInput!) {
        commentCreate(input: $input) {
          success
          comment {
            id
            url
            createdAt
          }
        }
      }`,
      variables: {
        input: {
          body: input.payload.body,
          issueId: issue.id,
        },
      },
    },
    config: input.config,
    headers,
  });
  const commentBlocker =
    LinearCommentDeliveryResultSchema.safeParse(commentJson);
  if (commentBlocker.success) {
    return commentBlocker.data;
  }

  const commentResult =
    LinearCommentCreateResponseSchema.safeParse(commentJson);
  if (!commentResult.success) {
    return blocked(
      "adapter_unavailable",
      "Linear commentCreate response failed schema validation."
    );
  }
  if (
    commentResult.data.errors !== undefined &&
    commentResult.data.errors.length > 0
  ) {
    return blockerForLinearErrors(commentResult.data.errors);
  }
  const comment = commentResult.data.data?.commentCreate.comment;
  if (commentResult.data.data?.commentCreate.success !== true || !comment) {
    return blocked(
      "adapter_unavailable",
      "Linear commentCreate did not return a created comment."
    );
  }

  return LinearCommentDeliveryResultSchema.parse({
    commentId: comment.id,
    commentUrl: comment.url,
    commentedAt: configNow(input.config, comment.createdAt),
    dryRun: false,
    issueRef: input.lease.resource.issueRef,
    payloadHash: input.payloadHash,
    redacted: true,
    status: "commented",
  });
};

export const createCloudflareLinearApiTokenResolver = (
  config: CloudflareLinearApiTokenResolverConfig
): LinearApiTokenSecretResolver => ({
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

export const createCloudflareLinearCommentAdapter = (
  config: CloudflareLinearCommentAdapterConfig
): LinearCommentCapabilityAdapter => ({
  async execute(input) {
    const lease = CapabilityLeaseSchema.parse(input.lease);
    const payload = LinearCommentPayloadSchema.parse(input.payload);
    if (!isLinearCommentLease(lease)) {
      return blocked(
        "capability_denied",
        "Linear comment adapter requires a Linear comment lease."
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
        "Linear comment creation requires approved review before execution."
      );
    }

    if (lease.secretRef !== config.linearCommentSecretRef) {
      return blocked(
        "secret_denied",
        "Linear comment creation requires the configured secret reference."
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
        "Linear token could not be materialized for the leased comment."
      );
    }

    return await executeLinearCommentCreate({
      config,
      lease,
      payload,
      payloadHash,
      token,
    });
  },
});

export const createDryRunLinearCommentAdapter =
  (): LinearCommentCapabilityAdapter => ({
    execute(input) {
      const lease = CapabilityLeaseSchema.parse(input.lease);
      const payload = LinearCommentPayloadSchema.parse(input.payload);
      if (!isLinearCommentLease(lease)) {
        return Promise.resolve(
          blocked(
            "capability_denied",
            "Linear comment adapter requires a Linear comment lease."
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
            "Real Linear comment adapter is not configured."
          )
        );
      }

      return Promise.resolve(deliveryForDryRun({ lease, payloadHash }));
    },
  });
