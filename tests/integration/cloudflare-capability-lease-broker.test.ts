import { describe, expect, it } from "vitest";

import { hashJson, sha256Hex } from "../../src/app/domain/hash.ts";
import {
  DiscordMessagePayloadSchema,
  GitHubBranchCommitPayloadSchema,
  GitHubPullRequestPayloadSchema,
  LinearCommentPayloadSchema,
  WzrrdPublishPayloadSchema,
} from "../../src/app/domain/schemas.ts";
import type {
  CapabilityLeaseRequest,
  DiscordDeliveryResult,
  GitHubBranchCommitDeliveryResult,
  GitHubPullRequestDeliveryResult,
  LinearCommentDeliveryResult,
  WzrrdPublishDeliveryResult,
} from "../../src/app/domain/schemas.ts";
import { workflowTraceContextForCapability } from "../../src/app/domain/trace-context.ts";
import { createCloudflareCapabilityLeaseBroker } from "../../src/app/infrastructure/cloudflare-capability-lease-broker.ts";
import { createMemoryArtifactStore } from "../../src/app/infrastructure/memory-adapters.ts";
import { buildIntegrationTestRunRequest } from "./workflow-app-fixtures.ts";

type D1QueryValue = null | number | string;

interface D1Operation {
  readonly query: string;
  readonly values: readonly D1QueryValue[];
}

interface FakeD1Statement {
  bind(...boundValues: D1QueryValue[]): FakeD1Statement;
  run(): Promise<{ readonly success: true }>;
}

const createFakeD1 = () => {
  const operations: D1Operation[] = [];

  return {
    d1: {
      prepare(query: string) {
        const statementFor = (
          values: readonly D1QueryValue[] = []
        ): FakeD1Statement => ({
          bind(...boundValues: D1QueryValue[]) {
            return statementFor(boundValues);
          },
          run() {
            operations.push({ query, values });

            return Promise.resolve({ success: true });
          },
        });

        return statementFor();
      },
    },
    operations,
  };
};

const capabilityTraceContext = (input: {
  readonly capability: CapabilityLeaseRequest["capability"];
  readonly runId: string;
}): CapabilityLeaseRequest["traceContext"] =>
  workflowTraceContextForCapability({
    capability: input.capability,
    runId: input.runId,
    stepId: `test:${input.capability}`,
  });

const buildLeaseFixture = async () => {
  const artifacts = createMemoryArtifactStore("cloudflare-capability-lease");
  const request = buildIntegrationTestRunRequest();
  const message = request.planProposal.discordMessage;
  if (message === undefined) {
    throw new Error("Capability lease fixture requires a Discord message.");
  }

  const payload = DiscordMessagePayloadSchema.parse({
    body: message.body,
    bodyHash: sha256Hex(message.body),
    channelRef: message.channelRef,
    serverRef: message.serverRef,
  });
  const payloadWrite = await artifacts.writeJson({
    path: "payloads/discord-message.json",
    redacted: true,
    runId: request.runId,
    value: payload,
  });
  const leaseRequest: CapabilityLeaseRequest = {
    actor: request.actor,
    capability: "discord.message.send",
    dryRun: true,
    expiresAt: "2026-06-08T23:59:00.000Z",
    payloadHash: payload.bodyHash,
    payloadRef: payloadWrite.artifactRef,
    receiptSink: artifacts.artifactRef({
      path: "receipts/discord-capability.json",
      runId: request.runId,
    }),
    resource: {
      channelRef: message.channelRef,
      kind: "discord.channel",
      serverRef: message.serverRef,
    },
    reviewGate: {
      mode: "dry-run-exempt",
      reason: "Capability lease integration test dry-run.",
    },
    runId: request.runId,
    secretRef: "secretref:discord-dry-run",
    traceContext: capabilityTraceContext({
      capability: "discord.message.send",
      runId: request.runId,
    }),
    workItemId: request.workItemId,
  };
  const d1 = createFakeD1();
  const broker = createCloudflareCapabilityLeaseBroker({
    artifacts,
    d1: d1.d1,
    policy: {
      discordSecretRef: "secretref:discord-bot",
      policyId: "discord-message-policy",
    },
  });

  return { artifacts, broker, d1, leaseRequest, payload };
};

const buildWzrrdLeaseFixture = async () => {
  const artifacts = createMemoryArtifactStore("cloudflare-wzrrd-lease");
  const request = buildIntegrationTestRunRequest();
  const payload = WzrrdPublishPayloadSchema.parse({
    redacted: true,
    reviewSurface: {
      artifactRef: artifacts.artifactRef({
        path: "review/surfaces/review-surface.json",
        runId: request.runId,
      }),
      hash: "1".repeat(64),
      kind: "wzrrd",
      surfaceId: `review-surface:${request.runId}`,
    },
    runId: request.runId,
    schemaVersion: "wzrrd.publish-payload.v1",
    slug: request.runId.toLowerCase(),
    title: `Review surface for ${request.runId}`,
    workItemId: request.workItemId,
  });
  const payloadWrite = await artifacts.writeJson({
    path: "payloads/wzrrd-publish.json",
    redacted: true,
    runId: request.runId,
    value: payload,
  });
  const leaseRequest: CapabilityLeaseRequest = {
    actor: request.actor,
    capability: "wzrrd.site.publish",
    dryRun: true,
    expiresAt: "2026-06-08T23:59:00.000Z",
    payloadHash: hashJson(payload),
    payloadRef: payloadWrite.artifactRef,
    receiptSink: artifacts.artifactRef({
      path: "receipts/wzrrd-capability.json",
      runId: request.runId,
    }),
    resource: {
      kind: "wzrrd.site",
      siteRef: "wzrrd:test",
      slug: payload.slug,
    },
    reviewGate: {
      mode: "dry-run-exempt",
      reason: "Capability lease integration test Wzrrd dry-run.",
    },
    runId: request.runId,
    secretRef: "secretref:wzrrd-dry-run",
    traceContext: capabilityTraceContext({
      capability: "wzrrd.site.publish",
      runId: request.runId,
    }),
    workItemId: request.workItemId,
  };
  const d1 = createFakeD1();
  const broker = createCloudflareCapabilityLeaseBroker({
    artifacts,
    d1: d1.d1,
    policy: {
      discordSecretRef: "secretref:discord-bot",
      policyId: "workflow-capability-policy",
      wzrrdSecretRef: "secretref:wzrrd-api",
    },
  });

  return { artifacts, broker, d1, leaseRequest, payload };
};

const buildGitHubPullRequestLeaseFixture = async () => {
  const artifacts = createMemoryArtifactStore("cloudflare-github-pr-lease");
  const request = buildIntegrationTestRunRequest();
  const body = [
    `# Review surface for ${request.runId}`,
    "",
    "Review surface artifact: artifact://example/review-surface.json",
  ].join("\n");
  const payload = GitHubPullRequestPayloadSchema.parse({
    baseBranch: "main",
    body,
    bodyHash: sha256Hex(body),
    headBranch: `workflow/${request.runId}`,
    redacted: true,
    repositoryRef: "joelhooks/pi-cloudflare-sandbox-workflows",
    reviewSurface: {
      artifactRef: artifacts.artifactRef({
        path: "review/surfaces/review-surface.json",
        runId: request.runId,
      }),
      hash: "2".repeat(64),
      kind: "github-pr",
      surfaceId: `review-surface:${request.runId}`,
    },
    runId: request.runId,
    schemaVersion: "github.pull-request-payload.v1",
    title: `Review surface for ${request.runId}`,
    workItemId: request.workItemId,
  });
  const payloadWrite = await artifacts.writeJson({
    path: "payloads/github-pr.json",
    redacted: true,
    runId: request.runId,
    value: payload,
  });
  const leaseRequest: CapabilityLeaseRequest = {
    actor: request.actor,
    capability: "github.pull-request.create",
    dryRun: true,
    expiresAt: "2026-06-08T23:59:00.000Z",
    payloadHash: hashJson(payload),
    payloadRef: payloadWrite.artifactRef,
    receiptSink: artifacts.artifactRef({
      path: "receipts/github-pr-capability.json",
      runId: request.runId,
    }),
    resource: {
      baseBranch: payload.baseBranch,
      headBranch: payload.headBranch,
      kind: "github.repository",
      repositoryRef: payload.repositoryRef,
    },
    reviewGate: {
      mode: "dry-run-exempt",
      reason: "Capability lease integration test GitHub PR dry-run.",
    },
    runId: request.runId,
    secretRef: "secretref:github-dry-run",
    traceContext: capabilityTraceContext({
      capability: "github.pull-request.create",
      runId: request.runId,
    }),
    workItemId: request.workItemId,
  };
  const d1 = createFakeD1();
  const broker = createCloudflareCapabilityLeaseBroker({
    artifacts,
    d1: d1.d1,
    policy: {
      discordSecretRef: "secretref:discord-bot",
      githubPullRequestSecretRef: "secretref:github-pr",
      policyId: "workflow-capability-policy",
      wzrrdSecretRef: "secretref:wzrrd-api",
    },
  });

  return { artifacts, broker, d1, leaseRequest, payload };
};

const buildGitHubBranchCommitLeaseFixture = async () => {
  const artifacts = createMemoryArtifactStore("cloudflare-github-branch-lease");
  const request = buildIntegrationTestRunRequest();
  const content = [
    `# Review surface for ${request.runId}`,
    "",
    "Review surface artifact: artifact://example/review-surface.json",
  ].join("\n");
  const payload = GitHubBranchCommitPayloadSchema.parse({
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
      artifactRef: artifacts.artifactRef({
        path: "review/surfaces/review-surface.json",
        runId: request.runId,
      }),
      hash: "5".repeat(64),
      kind: "github-pr",
      surfaceId: `review-surface:${request.runId}`,
    },
    runId: request.runId,
    schemaVersion: "github.branch-commit-payload.v1",
    workItemId: request.workItemId,
  });
  const payloadWrite = await artifacts.writeJson({
    path: "payloads/github-branch-commit.json",
    redacted: true,
    runId: request.runId,
    value: payload,
  });
  const leaseRequest: CapabilityLeaseRequest = {
    actor: request.actor,
    capability: "github.branch.commit",
    dryRun: true,
    expiresAt: "2026-06-08T23:59:00.000Z",
    payloadHash: hashJson(payload),
    payloadRef: payloadWrite.artifactRef,
    receiptSink: artifacts.artifactRef({
      path: "receipts/github-branch-commit-capability.json",
      runId: request.runId,
    }),
    resource: {
      baseBranch: payload.baseBranch,
      headBranch: payload.headBranch,
      kind: "github.repository",
      repositoryRef: payload.repositoryRef,
    },
    reviewGate: {
      mode: "dry-run-exempt",
      reason: "Capability lease integration test GitHub branch dry-run.",
    },
    runId: request.runId,
    secretRef: "secretref:github-dry-run",
    traceContext: capabilityTraceContext({
      capability: "github.branch.commit",
      runId: request.runId,
    }),
    workItemId: request.workItemId,
  };
  const d1 = createFakeD1();
  const broker = createCloudflareCapabilityLeaseBroker({
    artifacts,
    d1: d1.d1,
    policy: {
      discordSecretRef: "secretref:discord-bot",
      githubBranchCommitSecretRef: "secretref:github-branch-commit",
      githubPullRequestSecretRef: "secretref:github-pr",
      policyId: "workflow-capability-policy",
      wzrrdSecretRef: "secretref:wzrrd-api",
    },
  });

  return { artifacts, broker, d1, leaseRequest, payload };
};

const buildLinearCommentLeaseFixture = async () => {
  const artifacts = createMemoryArtifactStore("cloudflare-linear-lease");
  const request = buildIntegrationTestRunRequest();
  const body = [
    `# Review surface for ${request.runId}`,
    "",
    "Review surface artifact: artifact://example/review-surface.json",
  ].join("\n");
  const payload = LinearCommentPayloadSchema.parse({
    body,
    bodyHash: sha256Hex(body),
    issueRef: "PIWF-123",
    redacted: true,
    reviewSurface: {
      artifactRef: artifacts.artifactRef({
        path: "review/surfaces/review-surface.json",
        runId: request.runId,
      }),
      hash: "6".repeat(64),
      kind: "linear",
      surfaceId: `review-surface:${request.runId}`,
    },
    runId: request.runId,
    schemaVersion: "linear.comment-payload.v1",
    workItemId: request.workItemId,
  });
  const payloadWrite = await artifacts.writeJson({
    path: "payloads/linear-comment.json",
    redacted: true,
    runId: request.runId,
    value: payload,
  });
  const leaseRequest: CapabilityLeaseRequest = {
    actor: request.actor,
    capability: "linear.comment.create",
    dryRun: true,
    expiresAt: "2026-06-08T23:59:00.000Z",
    payloadHash: hashJson(payload),
    payloadRef: payloadWrite.artifactRef,
    receiptSink: artifacts.artifactRef({
      path: "receipts/linear-comment-capability.json",
      runId: request.runId,
    }),
    resource: {
      issueRef: payload.issueRef,
      kind: "linear.issue",
    },
    reviewGate: {
      mode: "dry-run-exempt",
      reason: "Capability lease integration test Linear dry-run.",
    },
    runId: request.runId,
    secretRef: "secretref:linear-dry-run",
    traceContext: capabilityTraceContext({
      capability: "linear.comment.create",
      runId: request.runId,
    }),
    workItemId: request.workItemId,
  };
  const d1 = createFakeD1();
  const broker = createCloudflareCapabilityLeaseBroker({
    artifacts,
    d1: d1.d1,
    policy: {
      discordSecretRef: "secretref:discord-bot",
      linearCommentSecretRef: "secretref:linear-api",
      policyId: "workflow-capability-policy",
      wzrrdSecretRef: "secretref:wzrrd-api",
    },
  });

  return { artifacts, broker, d1, leaseRequest, payload };
};

describe("Cloudflare capability lease broker", () => {
  it("issues a dry-run Discord lease and persists lease control rows", async () => {
    const fixture = await buildLeaseFixture();

    const decision = await fixture.broker.requestLease(fixture.leaseRequest);

    if (decision.status !== "issued") {
      throw new Error(decision.blocker.message);
    }

    expect({
      artifactReceiptCount: [...fixture.artifacts.records.keys()].filter(
        (key) => key.includes("/receipts/capability-leases/")
      ).length,
      leaseId: decision.lease.leaseId,
      leaseTraceContext: decision.lease.traceContext,
      operationCount: fixture.d1.operations.length,
      operationValues: fixture.d1.operations.map((operation) =>
        operation.values.slice(0, 3)
      ),
    }).toStrictEqual({
      artifactReceiptCount: 1,
      leaseId: `lease:discord.message.send:${fixture.leaseRequest.runId}`,
      leaseTraceContext: fixture.leaseRequest.traceContext,
      operationCount: 2,
      operationValues: [
        [
          `lease:discord.message.send:${fixture.leaseRequest.runId}`,
          fixture.leaseRequest.runId,
          "discord.message.send",
        ],
        [
          `lease:discord.message.send:${fixture.leaseRequest.runId}:lease`,
          fixture.leaseRequest.runId,
          "lease",
        ],
      ],
    });
  });

  it("records Discord execution as a receipt and marks the lease executed", async () => {
    const fixture = await buildLeaseFixture();
    const decision = await fixture.broker.requestLease(fixture.leaseRequest);
    if (decision.status !== "issued") {
      throw new Error(decision.blocker.message);
    }
    const { resource } = fixture.leaseRequest;
    if (resource.kind !== "discord.channel") {
      throw new Error("Expected Discord lease fixture resource.");
    }

    const delivery: DiscordDeliveryResult = {
      channelRef: resource.channelRef,
      dryRun: true,
      payloadHash: fixture.leaseRequest.payloadHash,
      redacted: true,
      serverRef: resource.serverRef,
      status: "dry-run",
    };
    const receipt = await fixture.broker.recordDiscordExecution({
      delivery,
      lease: decision.lease,
    });

    expect({
      operationKinds: fixture.d1.operations.map((operation) =>
        operation.query.includes("update capability_leases")
          ? "lease-update"
          : operation.values[2]
      ),
      receiptRef: receipt.receiptRef,
      receiptStatus: receipt.delivery.status,
      receiptTraceContext: receipt.traceContext,
    }).toStrictEqual({
      operationKinds: [
        "discord.message.send",
        "lease",
        "lease-update",
        "discord",
      ],
      receiptRef: fixture.artifacts.artifactRef({
        path: `receipts/capability-executions/${decision.lease.leaseId}.json`,
        runId: fixture.leaseRequest.runId,
      }),
      receiptStatus: "dry-run",
      receiptTraceContext: fixture.leaseRequest.traceContext,
    });
  });

  it("denies real sends without approval and does not persist rows", async () => {
    const fixture = await buildLeaseFixture();

    const decision = await fixture.broker.requestLease({
      ...fixture.leaseRequest,
      dryRun: false,
      reviewGate: {
        mode: "required",
        reviewRef: fixture.artifacts.artifactRef({
          path: "reviews/discord-send.json",
          runId: fixture.leaseRequest.runId,
        }),
      },
      secretRef: "secretref:discord-bot",
    });

    expect({
      decision,
      operationCount: fixture.d1.operations.length,
    }).toStrictEqual({
      decision: {
        blocker: {
          code: "review_required",
          message:
            "discord.message.send requires review approval unless dry-run.",
          redacted: true,
        },
        status: "denied",
      },
      operationCount: 0,
    });
  });

  it("denies payload hash mismatch before persisting rows", async () => {
    const fixture = await buildLeaseFixture();

    const decision = await fixture.broker.requestLease({
      ...fixture.leaseRequest,
      payloadHash: "0".repeat(64),
    });

    expect({
      decision,
      operationCount: fixture.d1.operations.length,
    }).toStrictEqual({
      decision: {
        blocker: {
          code: "payload_hash_mismatch",
          message:
            "Discord message payload hash does not match the pinned payload artifact.",
          redacted: true,
        },
        status: "denied",
      },
      operationCount: 0,
    });
  });

  it("issues and records dry-run Wzrrd publish leases as capability receipts", async () => {
    const fixture = await buildWzrrdLeaseFixture();
    const decision = await fixture.broker.requestLease(fixture.leaseRequest);
    if (decision.status !== "issued") {
      throw new Error(decision.blocker.message);
    }

    const delivery: WzrrdPublishDeliveryResult = {
      dryRun: true,
      payloadHash: fixture.leaseRequest.payloadHash,
      redacted: true,
      reviewSurfaceRef: fixture.payload.reviewSurface.artifactRef,
      slug: fixture.payload.slug,
      status: "dry-run",
      url: `https://${fixture.payload.slug}.wzrrd.sh/`,
    };
    const receipt = await fixture.broker.recordWzrrdExecution({
      delivery,
      lease: decision.lease,
    });

    expect({
      operationKinds: fixture.d1.operations.map((operation) =>
        operation.query.includes("update capability_leases")
          ? "lease-update"
          : operation.values[2]
      ),
      receiptCapability: receipt.capability,
      receiptResource: receipt.resource,
      receiptStatus: receipt.delivery.status,
      receiptTraceContext: receipt.traceContext,
    }).toStrictEqual({
      operationKinds: ["wzrrd.site.publish", "lease", "lease-update", "wzrrd"],
      receiptCapability: "wzrrd.site.publish",
      receiptResource: {
        kind: "wzrrd.site",
        siteRef: "wzrrd:test",
        slug: fixture.payload.slug,
      },
      receiptStatus: "dry-run",
      receiptTraceContext: fixture.leaseRequest.traceContext,
    });
  });

  it("issues and records dry-run GitHub pull request leases as capability receipts", async () => {
    const fixture = await buildGitHubPullRequestLeaseFixture();
    const decision = await fixture.broker.requestLease(fixture.leaseRequest);
    if (decision.status !== "issued") {
      throw new Error(decision.blocker.message);
    }

    const delivery: GitHubPullRequestDeliveryResult = {
      baseBranch: fixture.payload.baseBranch,
      dryRun: true,
      headBranch: fixture.payload.headBranch,
      payloadHash: fixture.leaseRequest.payloadHash,
      pullRequestUrl: `https://github.com/${fixture.payload.repositoryRef}/compare/main...${encodeURIComponent(fixture.payload.headBranch)}?expand=1`,
      redacted: true,
      repositoryRef: fixture.payload.repositoryRef,
      status: "dry-run",
    };
    const receipt = await fixture.broker.recordGitHubPullRequestExecution({
      delivery,
      lease: decision.lease,
    });

    expect({
      leaseId: decision.lease.leaseId,
      operationKinds: fixture.d1.operations.map((operation) =>
        operation.query.includes("update capability_leases")
          ? "lease-update"
          : operation.values[2]
      ),
      receiptResource: receipt.resource,
      receiptStatus: receipt.delivery.status,
      receiptTraceContext: receipt.traceContext,
    }).toStrictEqual({
      leaseId: `lease:github.pull-request.create:${fixture.leaseRequest.runId}`,
      operationKinds: [
        "github.pull-request.create",
        "lease",
        "lease-update",
        "github",
      ],
      receiptResource: {
        baseBranch: "main",
        headBranch: fixture.payload.headBranch,
        kind: "github.repository",
        repositoryRef: fixture.payload.repositoryRef,
      },
      receiptStatus: "dry-run",
      receiptTraceContext: fixture.leaseRequest.traceContext,
    });
  });

  it("issues and records dry-run GitHub branch commit leases as capability receipts", async () => {
    const fixture = await buildGitHubBranchCommitLeaseFixture();
    const decision = await fixture.broker.requestLease(fixture.leaseRequest);
    if (decision.status !== "issued") {
      throw new Error(decision.blocker.message);
    }

    const delivery: GitHubBranchCommitDeliveryResult = {
      baseBranch: fixture.payload.baseBranch,
      branchUrl: `https://github.com/${fixture.payload.repositoryRef}/tree/${encodeURIComponent(fixture.payload.headBranch)}`,
      dryRun: true,
      fileCount: fixture.payload.files.length,
      headBranch: fixture.payload.headBranch,
      payloadHash: fixture.leaseRequest.payloadHash,
      redacted: true,
      repositoryRef: fixture.payload.repositoryRef,
      status: "dry-run",
    };
    const receipt = await fixture.broker.recordGitHubBranchCommitExecution({
      delivery,
      lease: decision.lease,
    });

    expect({
      leaseId: decision.lease.leaseId,
      operationKinds: fixture.d1.operations.map((operation) =>
        operation.query.includes("update capability_leases")
          ? "lease-update"
          : operation.values[2]
      ),
      receiptResource: receipt.resource,
      receiptStatus: receipt.delivery.status,
      receiptTraceContext: receipt.traceContext,
    }).toStrictEqual({
      leaseId: `lease:github.branch.commit:${fixture.leaseRequest.runId}`,
      operationKinds: [
        "github.branch.commit",
        "lease",
        "lease-update",
        "github",
      ],
      receiptResource: {
        baseBranch: "main",
        headBranch: fixture.payload.headBranch,
        kind: "github.repository",
        repositoryRef: "joelhooks/pi-cloudflare-sandbox-workflows",
      },
      receiptStatus: "dry-run",
      receiptTraceContext: fixture.leaseRequest.traceContext,
    });
  });

  it("issues and records dry-run Linear comment leases as capability receipts", async () => {
    const fixture = await buildLinearCommentLeaseFixture();
    const decision = await fixture.broker.requestLease(fixture.leaseRequest);
    if (decision.status !== "issued") {
      throw new Error(decision.blocker.message);
    }

    const delivery: LinearCommentDeliveryResult = {
      dryRun: true,
      issueRef: fixture.payload.issueRef,
      payloadHash: fixture.leaseRequest.payloadHash,
      redacted: true,
      status: "dry-run",
    };
    const receipt = await fixture.broker.recordLinearCommentExecution({
      delivery,
      lease: decision.lease,
    });

    expect({
      leaseId: decision.lease.leaseId,
      operationKinds: fixture.d1.operations.map((operation) =>
        operation.query.includes("update capability_leases")
          ? "lease-update"
          : operation.values[2]
      ),
      receiptResource: receipt.resource,
      receiptStatus: receipt.delivery.status,
      receiptTraceContext: receipt.traceContext,
    }).toStrictEqual({
      leaseId: `lease:linear.comment.create:${fixture.leaseRequest.runId}`,
      operationKinds: [
        "linear.comment.create",
        "lease",
        "lease-update",
        "linear",
      ],
      receiptResource: {
        issueRef: fixture.payload.issueRef,
        kind: "linear.issue",
      },
      receiptStatus: "dry-run",
      receiptTraceContext: fixture.leaseRequest.traceContext,
    });
  });
});
