import type {
  ArtifactStoreContract,
  CapabilityLeaseBrokerActorContract,
} from "../application/ports.ts";
import {
  D1LeaseRowSchema,
  D1ReceiptRowSchema,
} from "../control-plane/d1-schema.ts";
import { hashJson } from "../domain/hash.ts";
import {
  CapabilityLeaseReceiptSchema,
  CapabilityLeaseSchema,
  DiscordDeliveryResultSchema,
  DiscordMessagePayloadSchema,
  GitHubBranchCommitDeliveryResultSchema,
  GitHubBranchCommitPayloadSchema,
  GitHubPullRequestDeliveryResultSchema,
  GitHubPullRequestPayloadSchema,
  LinearCommentDeliveryResultSchema,
  LinearCommentPayloadSchema,
  WzrrdPublishDeliveryResultSchema,
  WzrrdPublishPayloadSchema,
} from "../domain/schemas.ts";
import type {
  CapabilityDenialCode,
  CapabilityLease,
  CapabilityLeaseDecision,
  CapabilityLeaseReceipt,
  CapabilityLeaseRequest,
  DiscordDeliveryResult,
  GitHubBranchCommitDeliveryResult,
  GitHubPullRequestDeliveryResult,
  LinearCommentDeliveryResult,
  WzrrdPublishDeliveryResult,
} from "../domain/schemas.ts";

type D1QueryValue = null | number | string;

interface D1RunResultLike {
  readonly success?: boolean;
}

interface D1PreparedStatementLike {
  bind(...values: D1QueryValue[]): D1PreparedStatementLike;
  run(): Promise<D1RunResultLike>;
}

interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
}

export interface CloudflareCapabilityLeaseBrokerConfig {
  readonly artifacts: ArtifactStoreContract;
  readonly d1: D1DatabaseLike;
  readonly policy: {
    readonly discordSecretRef: string;
    readonly githubBranchCommitSecretRef?: string;
    readonly githubPullRequestSecretRef?: string;
    readonly linearCommentSecretRef?: string;
    readonly policyId: string;
    readonly wzrrdSecretRef?: string;
  };
}

const blocker = (
  code: CapabilityDenialCode,
  message: string
): CapabilityLeaseDecision => ({
  blocker: {
    code,
    message,
    redacted: true,
  },
  status: "denied",
});

const resourceRefFor = (lease: Pick<CapabilityLease, "resource">): string => {
  if (lease.resource.kind === "discord.channel") {
    return `discord.channel:${lease.resource.serverRef}:${lease.resource.channelRef}`;
  }

  if (lease.resource.kind === "github.repository") {
    return `github.repository:${lease.resource.repositoryRef}:${lease.resource.headBranch}->${lease.resource.baseBranch}`;
  }

  if (lease.resource.kind === "linear.issue") {
    return `linear.issue:${lease.resource.issueRef}`;
  }

  return `wzrrd.site:${lease.resource.siteRef}:${lease.resource.slug}`;
};

const safePathSegment = (value: string): string =>
  value.replaceAll(/[^A-Za-z0-9_.:-]/gu, "_");

const assertD1Write = async (
  statement: D1PreparedStatementLike,
  summary: string
): Promise<void> => {
  const result = await statement.run();
  if (result.success === false) {
    throw new Error(summary);
  }
};

const writeReceiptRow = async (input: {
  readonly artifactRef: string;
  readonly d1: D1DatabaseLike;
  readonly receiptHash: string;
  readonly receiptId: string;
  readonly receiptKind: "discord" | "github" | "lease" | "linear" | "wzrrd";
  readonly runId: string;
}): Promise<void> => {
  const row = D1ReceiptRowSchema.parse({
    artifact_ref: input.artifactRef,
    receipt_hash: input.receiptHash,
    receipt_id: input.receiptId,
    receipt_kind: input.receiptKind,
    redacted: 1,
    run_id: input.runId,
  });
  await assertD1Write(
    input.d1
      .prepare(
        `insert into receipts (receipt_id, run_id, receipt_kind, artifact_ref, receipt_hash, redacted)
         values (?, ?, ?, ?, ?, ?)
         on conflict(receipt_id) do update set
           artifact_ref = excluded.artifact_ref,
           receipt_hash = excluded.receipt_hash,
           redacted = excluded.redacted`
      )
      .bind(
        row.receipt_id,
        row.run_id,
        row.receipt_kind,
        row.artifact_ref,
        row.receipt_hash,
        row.redacted
      ),
    "Capability receipt row could not be persisted."
  );
};

const persistIssuedLease = async (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly d1: D1DatabaseLike;
  readonly lease: CapabilityLease;
}): Promise<void> => {
  const writeReceipt = await input.artifacts.writeJson({
    path: `receipts/capability-leases/${safePathSegment(input.lease.leaseId)}.json`,
    redacted: true,
    runId: input.lease.runId,
    value: input.lease,
  });
  const leaseRow = D1LeaseRowSchema.parse({
    capability: input.lease.capability,
    expires_at: input.lease.expiresAt,
    lease_id: input.lease.leaseId,
    payload_hash: input.lease.payloadHash,
    policy_id: input.lease.policyId,
    redacted: 1,
    resource_ref: resourceRefFor(input.lease),
    run_id: input.lease.runId,
    status: "issued",
  });
  await assertD1Write(
    input.d1
      .prepare(
        `insert into capability_leases (lease_id, run_id, capability, resource_ref, payload_hash, policy_id, status, expires_at, redacted)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(lease_id) do update set
           resource_ref = excluded.resource_ref,
           payload_hash = excluded.payload_hash,
           policy_id = excluded.policy_id,
           status = excluded.status,
           expires_at = excluded.expires_at,
           redacted = excluded.redacted`
      )
      .bind(
        leaseRow.lease_id,
        leaseRow.run_id,
        leaseRow.capability,
        leaseRow.resource_ref,
        leaseRow.payload_hash,
        leaseRow.policy_id,
        leaseRow.status,
        leaseRow.expires_at,
        leaseRow.redacted
      ),
    "Capability lease row could not be persisted."
  );
  await writeReceiptRow({
    artifactRef: writeReceipt.artifactRef,
    d1: input.d1,
    receiptHash: writeReceipt.contentHash,
    receiptId: `${input.lease.leaseId}:lease`,
    receiptKind: "lease",
    runId: input.lease.runId,
  });
};

const validateDiscordPayload = async (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly request: CapabilityLeaseRequest;
}): Promise<CapabilityLeaseDecision | null> => {
  const payload = DiscordMessagePayloadSchema.safeParse(
    await input.artifacts.readJson({ artifactRef: input.request.payloadRef })
  );
  if (!payload.success || payload.data.bodyHash !== input.request.payloadHash) {
    return blocker(
      "payload_hash_mismatch",
      "Discord message payload hash does not match the pinned payload artifact."
    );
  }

  return null;
};

const validateWzrrdPayload = async (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly request: CapabilityLeaseRequest;
}): Promise<CapabilityLeaseDecision | null> => {
  const payload = WzrrdPublishPayloadSchema.safeParse(
    await input.artifacts.readJson({ artifactRef: input.request.payloadRef })
  );
  if (
    !payload.success ||
    hashJson(payload.data) !== input.request.payloadHash
  ) {
    return blocker(
      "payload_hash_mismatch",
      "Wzrrd publish payload hash does not match the pinned payload artifact."
    );
  }

  return null;
};

const validateGitHubPullRequestPayload = async (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly request: CapabilityLeaseRequest;
}): Promise<CapabilityLeaseDecision | null> => {
  const payload = GitHubPullRequestPayloadSchema.safeParse(
    await input.artifacts.readJson({ artifactRef: input.request.payloadRef })
  );
  if (
    !payload.success ||
    hashJson(payload.data) !== input.request.payloadHash
  ) {
    return blocker(
      "payload_hash_mismatch",
      "GitHub pull request payload hash does not match the pinned payload artifact."
    );
  }

  return null;
};

const validateGitHubBranchCommitPayload = async (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly request: CapabilityLeaseRequest;
}): Promise<CapabilityLeaseDecision | null> => {
  const payload = GitHubBranchCommitPayloadSchema.safeParse(
    await input.artifacts.readJson({ artifactRef: input.request.payloadRef })
  );
  if (
    !payload.success ||
    hashJson(payload.data) !== input.request.payloadHash
  ) {
    return blocker(
      "payload_hash_mismatch",
      "GitHub branch commit payload hash does not match the pinned payload artifact."
    );
  }

  return null;
};

const validateLinearCommentPayload = async (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly request: CapabilityLeaseRequest;
}): Promise<CapabilityLeaseDecision | null> => {
  const payload = LinearCommentPayloadSchema.safeParse(
    await input.artifacts.readJson({ artifactRef: input.request.payloadRef })
  );
  if (
    !payload.success ||
    hashJson(payload.data) !== input.request.payloadHash
  ) {
    return blocker(
      "payload_hash_mismatch",
      "Linear comment payload hash does not match the pinned payload artifact."
    );
  }

  return null;
};

const validatePayload = async (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly request: CapabilityLeaseRequest;
}): Promise<CapabilityLeaseDecision | null> => {
  if (input.request.capability === "discord.message.send") {
    return await validateDiscordPayload(input);
  }

  if (input.request.capability === "github.pull-request.create") {
    return await validateGitHubPullRequestPayload(input);
  }

  if (input.request.capability === "github.branch.commit") {
    return await validateGitHubBranchCommitPayload(input);
  }

  if (input.request.capability === "linear.comment.create") {
    return await validateLinearCommentPayload(input);
  }

  return await validateWzrrdPayload(input);
};

const policyIdForCapability = (input: {
  readonly basePolicyId: string;
  readonly capability: CapabilityLeaseRequest["capability"];
}): string => {
  if (input.capability === "wzrrd.site.publish") {
    return `${input.basePolicyId}:wzrrd`;
  }

  if (input.capability === "github.pull-request.create") {
    return `${input.basePolicyId}:github-pr`;
  }

  if (input.capability === "github.branch.commit") {
    return `${input.basePolicyId}:github-branch`;
  }

  if (input.capability === "linear.comment.create") {
    return `${input.basePolicyId}:linear-comment`;
  }

  return input.basePolicyId;
};

const validateSecretPolicy = (input: {
  readonly policy: CloudflareCapabilityLeaseBrokerConfig["policy"];
  readonly request: CapabilityLeaseRequest;
}): CapabilityLeaseDecision | null => {
  if (input.request.dryRun) {
    return null;
  }

  if (
    input.request.capability === "discord.message.send" &&
    input.request.secretRef !== input.policy.discordSecretRef
  ) {
    return blocker(
      "secret_denied",
      "Discord send requires the trusted Discord bot secret reference."
    );
  }

  if (
    input.request.capability === "wzrrd.site.publish" &&
    input.request.secretRef !== input.policy.wzrrdSecretRef
  ) {
    return blocker(
      "secret_denied",
      "Wzrrd publish requires the trusted Wzrrd secret reference."
    );
  }

  if (
    input.request.capability === "github.pull-request.create" &&
    input.request.secretRef !== input.policy.githubPullRequestSecretRef
  ) {
    return blocker(
      "secret_denied",
      "GitHub pull request creation requires the trusted GitHub secret reference."
    );
  }

  if (
    input.request.capability === "github.branch.commit" &&
    input.request.secretRef !== input.policy.githubBranchCommitSecretRef
  ) {
    return blocker(
      "secret_denied",
      "GitHub branch commit requires the trusted GitHub branch secret reference."
    );
  }

  if (
    input.request.capability === "linear.comment.create" &&
    input.request.secretRef !== input.policy.linearCommentSecretRef
  ) {
    return blocker(
      "secret_denied",
      "Linear comment creation requires the trusted Linear secret reference."
    );
  }

  return null;
};

const decideLease = async (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly policy: CloudflareCapabilityLeaseBrokerConfig["policy"];
  readonly request: CapabilityLeaseRequest;
}): Promise<CapabilityLeaseDecision> => {
  if (input.request.actor.id.length === 0) {
    return blocker("missing_auth", "Actor identity is required.");
  }

  if (!input.request.dryRun && input.request.reviewGate.mode !== "approved") {
    const code: CapabilityDenialCode =
      input.request.reviewGate.mode === "rejected"
        ? "review_rejected"
        : "review_required";
    return blocker(
      code,
      `${input.request.capability} requires review approval unless dry-run.`
    );
  }

  const secretDecision = validateSecretPolicy({
    policy: input.policy,
    request: input.request,
  });
  if (secretDecision !== null) {
    return secretDecision;
  }

  const payloadDecision = await validatePayload({
    artifacts: input.artifacts,
    request: input.request,
  });
  if (payloadDecision !== null) {
    return payloadDecision;
  }

  const lease = CapabilityLeaseSchema.parse({
    actor: input.request.actor,
    capability: input.request.capability,
    capabilityRef: `capability:${input.request.capability}:${input.request.runId}:${input.request.stepId}`,
    dryRun: input.request.dryRun,
    expiresAt: input.request.expiresAt,
    leaseId: `lease:${input.request.capability}:${input.request.runId}:${input.request.stepId}`,
    payloadHash: input.request.payloadHash,
    payloadRef: input.request.payloadRef,
    policyId: policyIdForCapability({
      basePolicyId: input.policy.policyId,
      capability: input.request.capability,
    }),
    receiptSink: input.request.receiptSink,
    redacted: true,
    resource: input.request.resource,
    reviewGate: input.request.reviewGate,
    rollbackRef: input.request.rollbackRef,
    runId: input.request.runId,
    secretRef: input.request.secretRef,
    stepId: input.request.stepId,
    traceContext: input.request.traceContext,
    workItemId: input.request.workItemId,
  });

  return { lease, status: "issued" };
};

export const createCloudflareCapabilityLeaseBroker = (
  config: CloudflareCapabilityLeaseBrokerConfig
): CapabilityLeaseBrokerActorContract => ({
  async recordDiscordExecution(input: {
    readonly delivery: DiscordDeliveryResult;
    readonly lease: CapabilityLease;
  }): Promise<CapabilityLeaseReceipt> {
    if (
      input.lease.capability !== "discord.message.send" ||
      input.lease.resource.kind !== "discord.channel"
    ) {
      throw new Error("Discord execution requires a Discord message lease.");
    }
    const delivery = DiscordDeliveryResultSchema.parse(input.delivery);
    const receipt = CapabilityLeaseReceiptSchema.parse({
      capability: input.lease.capability,
      channelRef: input.lease.resource.channelRef,
      delivery,
      dryRun: input.lease.dryRun,
      leaseId: input.lease.leaseId,
      payloadHash: input.lease.payloadHash,
      payloadRef: input.lease.payloadRef,
      policyId: input.lease.policyId,
      receiptRef: config.artifacts.artifactRef({
        path: `receipts/capability-executions/${safePathSegment(input.lease.leaseId)}.json`,
        runId: input.lease.runId,
      }),
      redacted: true,
      resource: input.lease.resource,
      reviewGate: input.lease.reviewGate,
      runId: input.lease.runId,
      secretRef: input.lease.secretRef,
      traceContext: input.lease.traceContext,
    });
    const writeReceipt = await config.artifacts.writeJson({
      path: `receipts/capability-executions/${safePathSegment(input.lease.leaseId)}.json`,
      redacted: true,
      runId: input.lease.runId,
      value: {
        delivery,
        leaseId: input.lease.leaseId,
        payloadHash: input.lease.payloadHash,
        receipt,
        redacted: true,
      },
    });
    await assertD1Write(
      config.d1
        .prepare(
          `update capability_leases
           set status = ?
           where lease_id = ?`
        )
        .bind("executed", input.lease.leaseId),
      "Capability lease row could not be marked executed."
    );
    await writeReceiptRow({
      artifactRef: writeReceipt.artifactRef,
      d1: config.d1,
      receiptHash: writeReceipt.contentHash,
      receiptId: `${input.lease.leaseId}:discord`,
      receiptKind: "discord",
      runId: input.lease.runId,
    });

    return CapabilityLeaseReceiptSchema.parse({
      ...receipt,
      receiptRef: writeReceipt.artifactRef,
    });
  },

  async recordGitHubBranchCommitExecution(input: {
    readonly delivery: GitHubBranchCommitDeliveryResult;
    readonly lease: CapabilityLease;
  }): Promise<CapabilityLeaseReceipt> {
    if (
      input.lease.capability !== "github.branch.commit" ||
      input.lease.resource.kind !== "github.repository"
    ) {
      throw new Error(
        "GitHub execution requires a GitHub branch commit lease."
      );
    }
    const delivery = GitHubBranchCommitDeliveryResultSchema.parse(
      input.delivery
    );
    const receipt = CapabilityLeaseReceiptSchema.parse({
      capability: input.lease.capability,
      delivery,
      dryRun: input.lease.dryRun,
      leaseId: input.lease.leaseId,
      payloadHash: input.lease.payloadHash,
      payloadRef: input.lease.payloadRef,
      policyId: input.lease.policyId,
      receiptRef: config.artifacts.artifactRef({
        path: `receipts/capability-executions/${safePathSegment(input.lease.leaseId)}.json`,
        runId: input.lease.runId,
      }),
      redacted: true,
      resource: input.lease.resource,
      reviewGate: input.lease.reviewGate,
      runId: input.lease.runId,
      secretRef: input.lease.secretRef,
      traceContext: input.lease.traceContext,
    });
    const writeReceipt = await config.artifacts.writeJson({
      path: `receipts/capability-executions/${safePathSegment(input.lease.leaseId)}.json`,
      redacted: true,
      runId: input.lease.runId,
      value: {
        delivery,
        leaseId: input.lease.leaseId,
        payloadHash: input.lease.payloadHash,
        receipt,
        redacted: true,
      },
    });
    await assertD1Write(
      config.d1
        .prepare(
          `update capability_leases
           set status = ?
           where lease_id = ?`
        )
        .bind("executed", input.lease.leaseId),
      "Capability lease row could not be marked executed."
    );
    await writeReceiptRow({
      artifactRef: writeReceipt.artifactRef,
      d1: config.d1,
      receiptHash: writeReceipt.contentHash,
      receiptId: `${input.lease.leaseId}:github`,
      receiptKind: "github",
      runId: input.lease.runId,
    });

    return CapabilityLeaseReceiptSchema.parse({
      ...receipt,
      receiptRef: writeReceipt.artifactRef,
    });
  },

  async recordGitHubPullRequestExecution(input: {
    readonly delivery: GitHubPullRequestDeliveryResult;
    readonly lease: CapabilityLease;
  }): Promise<CapabilityLeaseReceipt> {
    if (
      input.lease.capability !== "github.pull-request.create" ||
      input.lease.resource.kind !== "github.repository"
    ) {
      throw new Error("GitHub execution requires a GitHub pull request lease.");
    }
    const delivery = GitHubPullRequestDeliveryResultSchema.parse(
      input.delivery
    );
    const receipt = CapabilityLeaseReceiptSchema.parse({
      capability: input.lease.capability,
      delivery,
      dryRun: input.lease.dryRun,
      leaseId: input.lease.leaseId,
      payloadHash: input.lease.payloadHash,
      payloadRef: input.lease.payloadRef,
      policyId: input.lease.policyId,
      receiptRef: config.artifacts.artifactRef({
        path: `receipts/capability-executions/${safePathSegment(input.lease.leaseId)}.json`,
        runId: input.lease.runId,
      }),
      redacted: true,
      resource: input.lease.resource,
      reviewGate: input.lease.reviewGate,
      runId: input.lease.runId,
      secretRef: input.lease.secretRef,
      traceContext: input.lease.traceContext,
    });
    const writeReceipt = await config.artifacts.writeJson({
      path: `receipts/capability-executions/${safePathSegment(input.lease.leaseId)}.json`,
      redacted: true,
      runId: input.lease.runId,
      value: {
        delivery,
        leaseId: input.lease.leaseId,
        payloadHash: input.lease.payloadHash,
        receipt,
        redacted: true,
      },
    });
    await assertD1Write(
      config.d1
        .prepare(
          `update capability_leases
           set status = ?
           where lease_id = ?`
        )
        .bind("executed", input.lease.leaseId),
      "Capability lease row could not be marked executed."
    );
    await writeReceiptRow({
      artifactRef: writeReceipt.artifactRef,
      d1: config.d1,
      receiptHash: writeReceipt.contentHash,
      receiptId: `${input.lease.leaseId}:github`,
      receiptKind: "github",
      runId: input.lease.runId,
    });

    return CapabilityLeaseReceiptSchema.parse({
      ...receipt,
      receiptRef: writeReceipt.artifactRef,
    });
  },

  async recordLinearCommentExecution(input: {
    readonly delivery: LinearCommentDeliveryResult;
    readonly lease: CapabilityLease;
  }): Promise<CapabilityLeaseReceipt> {
    if (
      input.lease.capability !== "linear.comment.create" ||
      input.lease.resource.kind !== "linear.issue"
    ) {
      throw new Error("Linear execution requires a Linear comment lease.");
    }
    const delivery = LinearCommentDeliveryResultSchema.parse(input.delivery);
    const receipt = CapabilityLeaseReceiptSchema.parse({
      capability: input.lease.capability,
      delivery,
      dryRun: input.lease.dryRun,
      leaseId: input.lease.leaseId,
      payloadHash: input.lease.payloadHash,
      payloadRef: input.lease.payloadRef,
      policyId: input.lease.policyId,
      receiptRef: config.artifacts.artifactRef({
        path: `receipts/capability-executions/${safePathSegment(input.lease.leaseId)}.json`,
        runId: input.lease.runId,
      }),
      redacted: true,
      resource: input.lease.resource,
      reviewGate: input.lease.reviewGate,
      runId: input.lease.runId,
      secretRef: input.lease.secretRef,
      traceContext: input.lease.traceContext,
    });
    const writeReceipt = await config.artifacts.writeJson({
      path: `receipts/capability-executions/${safePathSegment(input.lease.leaseId)}.json`,
      redacted: true,
      runId: input.lease.runId,
      value: {
        delivery,
        leaseId: input.lease.leaseId,
        payloadHash: input.lease.payloadHash,
        receipt,
        redacted: true,
      },
    });
    await assertD1Write(
      config.d1
        .prepare(
          `update capability_leases
           set status = ?
           where lease_id = ?`
        )
        .bind("executed", input.lease.leaseId),
      "Capability lease row could not be marked executed."
    );
    await writeReceiptRow({
      artifactRef: writeReceipt.artifactRef,
      d1: config.d1,
      receiptHash: writeReceipt.contentHash,
      receiptId: `${input.lease.leaseId}:linear`,
      receiptKind: "linear",
      runId: input.lease.runId,
    });

    return CapabilityLeaseReceiptSchema.parse({
      ...receipt,
      receiptRef: writeReceipt.artifactRef,
    });
  },

  async recordWzrrdExecution(input: {
    readonly delivery: WzrrdPublishDeliveryResult;
    readonly lease: CapabilityLease;
  }): Promise<CapabilityLeaseReceipt> {
    if (
      input.lease.capability !== "wzrrd.site.publish" ||
      input.lease.resource.kind !== "wzrrd.site"
    ) {
      throw new Error("Wzrrd execution requires a Wzrrd publish lease.");
    }
    const delivery = WzrrdPublishDeliveryResultSchema.parse(input.delivery);
    const receipt = CapabilityLeaseReceiptSchema.parse({
      capability: input.lease.capability,
      delivery,
      dryRun: input.lease.dryRun,
      leaseId: input.lease.leaseId,
      payloadHash: input.lease.payloadHash,
      payloadRef: input.lease.payloadRef,
      policyId: input.lease.policyId,
      receiptRef: config.artifacts.artifactRef({
        path: `receipts/capability-executions/${safePathSegment(input.lease.leaseId)}.json`,
        runId: input.lease.runId,
      }),
      redacted: true,
      resource: input.lease.resource,
      reviewGate: input.lease.reviewGate,
      runId: input.lease.runId,
      secretRef: input.lease.secretRef,
      traceContext: input.lease.traceContext,
    });
    const writeReceipt = await config.artifacts.writeJson({
      path: `receipts/capability-executions/${safePathSegment(input.lease.leaseId)}.json`,
      redacted: true,
      runId: input.lease.runId,
      value: {
        delivery,
        leaseId: input.lease.leaseId,
        payloadHash: input.lease.payloadHash,
        receipt,
        redacted: true,
      },
    });
    await assertD1Write(
      config.d1
        .prepare(
          `update capability_leases
           set status = ?
           where lease_id = ?`
        )
        .bind("executed", input.lease.leaseId),
      "Capability lease row could not be marked executed."
    );
    await writeReceiptRow({
      artifactRef: writeReceipt.artifactRef,
      d1: config.d1,
      receiptHash: writeReceipt.contentHash,
      receiptId: `${input.lease.leaseId}:wzrrd`,
      receiptKind: "wzrrd",
      runId: input.lease.runId,
    });

    return CapabilityLeaseReceiptSchema.parse({
      ...receipt,
      receiptRef: writeReceipt.artifactRef,
    });
  },

  async requestLease(
    request: CapabilityLeaseRequest
  ): Promise<CapabilityLeaseDecision> {
    const decision = await decideLease({
      artifacts: config.artifacts,
      policy: config.policy,
      request,
    });
    if (decision.status === "issued") {
      await persistIssuedLease({
        artifacts: config.artifacts,
        d1: config.d1,
        lease: decision.lease,
      });
    }

    return decision;
  },
});
