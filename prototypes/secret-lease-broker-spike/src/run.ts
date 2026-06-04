/* eslint-disable func-style, no-use-before-define */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  SecretLeaseBrokerReceiptSchema,
  SecretLeaseRequestSchema,
} from "./schema.ts";
import type {
  ApprovalBlocker,
  PublicPayload,
  SecretLeaseBrokerReceipt,
  SecretLeaseRecord,
  SecretLeaseRequest,
  SecretMetadata,
} from "./schema.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const outPath = resolve(
  repoRoot,
  "prototypes/secret-lease-broker-spike/out/latest-receipt.json"
);
const privatePlaintextMarker = "REFRESH_TOKEN_SHOULD_NEVER_APPEAR";

const request = SecretLeaseRequestSchema.parse({
  purpose: "mint-task-scoped-auth-json",
  runId: "run-thread-or-issue-123-0001",
  secretRefs: ["piCodexAuth"],
  workItemId: "thread-or-issue-123",
});

const blockedRequest = SecretLeaseRequestSchema.parse({
  purpose: "mint-task-scoped-auth-json",
  runId: "run-thread-or-issue-123-0002",
  secretRefs: ["unapprovedCodexAuth"],
  workItemId: "thread-or-issue-123",
});

class SecretLeaseBroker {
  private readonly policies = new Map<string, SecretMetadata>([
    [
      "piCodexAuth",
      {
        allowedPurposes: ["mint-task-scoped-auth-json"],
        name: "piCodexAuth",
        scope: "user",
      },
    ],
  ]);

  private readonly privateValues = new Map<string, string>([
    ["piCodexAuth", privatePlaintextMarker],
  ]);

  lease(input: SecretLeaseRequest): SecretLeaseRecord | ApprovalBlocker {
    const [secretRef] = input.secretRefs;
    const metadata = secretRef ? this.policies.get(secretRef) : undefined;
    if (!secretRef || !metadata?.allowedPurposes.includes(input.purpose)) {
      return {
        approvalUrl: `/approvals/secrets?secretRef=${encodeURIComponent(secretRef ?? "missing")}&purpose=${input.purpose}`,
        code: "missing_secret_approval",
        requestedPurpose: input.purpose,
        secretRef: secretRef ?? "missing",
      };
    }

    const privateValue = this.privateValues.get(secretRef);
    if (!privateValue) {
      return {
        approvalUrl: `/approvals/secrets?secretRef=${encodeURIComponent(secretRef)}&purpose=${input.purpose}`,
        code: "missing_secret_approval",
        requestedPurpose: input.purpose,
        secretRef,
      };
    }

    const authJson = JSON.stringify({
      "openai-codex": {
        refreshToken: privateValue,
        type: "oauth-refresh-material",
      },
    });

    return {
      contentSha256: sha256(authJson),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      leaseRef: `lease:${secretRef}:${input.runId}`,
      materializedPath: "/workspace/.pi/agent/auth.json",
      purpose: input.purpose,
      redacted: true,
      runId: input.runId,
      secretRef,
    };
  }
}

async function main() {
  const broker = new SecretLeaseBroker();
  const lease = broker.lease(request);
  if ("code" in lease) {
    throw new Error(`Expected allowed lease, got blocker ${lease.code}`);
  }

  const blocker = broker.lease(blockedRequest);
  if (!("code" in blocker)) {
    throw new Error("Expected missing approval blocker");
  }

  const publicPayload: PublicPayload = {
    artifactManifest: {
      files: [
        "run/manifest.json",
        "run/plan.json",
        "artifacts/report.md",
        "artifacts/verification/result.json",
      ],
      secretLeases: [lease],
    },
    eventLog: [
      {
        event: "SECRET_REF_REQUESTED",
        secretRef: lease.secretRef,
      },
      {
        event: "TASK_SCOPED_AUTH_MATERIALIZED",
        leaseRef: lease.leaseRef,
        secretRef: lease.secretRef,
      },
      {
        event: "SECRET_APPROVAL_BLOCKED",
        secretRef: blocker.secretRef,
      },
    ],
    wzrrdPayload: {
      leaseRefs: [lease.leaseRef],
      visibleFiles: [
        "report.md",
        "run/manifest.json",
        "verification/result.json",
      ],
    },
  };

  assertNoPlaintextLeak(publicPayload);

  const receipt: SecretLeaseBrokerReceipt =
    SecretLeaseBrokerReceiptSchema.parse({
      blocker,
      checks: [
        {
          id: "harness-sees-secret-ref-only",
          status: "passed",
          summary:
            "The request carries secretRefs and never contains the private auth value.",
        },
        {
          id: "task-scoped-lease-recorded",
          status: "passed",
          summary:
            "Broker minted a run-scoped lease for /workspace/.pi/agent/auth.json.",
        },
        {
          id: "content-hash-not-content",
          status: "passed",
          summary:
            "Lease exposes a SHA-256 hash of materialized auth.json, not the auth JSON itself.",
        },
        {
          id: "public-payload-redacted",
          status: "passed",
          summary:
            "Artifact manifest, Wzrrd payload, and event log contain lease refs/metadata only.",
        },
        {
          id: "missing-approval-blocker",
          status: "passed",
          summary:
            "Unapproved secretRef returns an explicit missing_secret_approval blocker with an approval URL.",
        },
      ],
      lease,
      prototype: "secret-lease-broker-spike",
      publicPayload,
      question:
        "Can a broker turn secretRef inputs into task-scoped Pi auth materialization receipts without leaking plaintext secrets?",
      schemaVersion: "secret-lease-broker-receipt.v1",
    });

  assertNoPlaintextLeak(receipt);
  await writeJson(outPath, receipt);
  console.log(JSON.stringify(receipt, null, 2));
  console.log(`wrote ${outPath}`);
}

function assertNoPlaintextLeak(value: unknown) {
  const serialized = JSON.stringify(value);
  if (serialized.includes(privatePlaintextMarker)) {
    throw new Error("Plaintext secret leaked into public payload");
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
