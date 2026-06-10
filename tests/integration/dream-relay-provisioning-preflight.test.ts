import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildDreamRelayProvisioningPreflightReceipt,
  runDreamRelayProvisioningPreflightCli,
} from "../../scripts/workflow-app-dream-relay-provisioning-preflight.ts";

const visionWithSignoffRule = `
# Vision

## Needs Sign-Off

Stop for owner sign-off before exposing JoelClaw/Typesense over a new network boundary.
`;
const approvalSignoff =
  "exposing JoelClaw/Typesense over a new network boundary";
const localRelayStartupEnv = {
  MEMORY_RELAY_SOURCE_ROOTS_JSON: JSON.stringify([
    {
      authorityRoot: "/tmp/dream-relay-test",
      family: "agent-transcripts",
      includeExtensions: [".jsonl"],
      label: "Pi transcripts",
      privacyTier: "private",
      runtime: "pi",
      sourceId: "source:agent-transcripts:pi:blaine",
      sourceSystem: "pi",
    },
  ]),
  MEMORY_RELAY_TOKEN: "relay-secret",
};
const localRelayReadinessProof = JSON.stringify({
  boundHost: "127.0.0.1",
  boundPort: 49_001,
  checkedAt: "2026-06-09T10:00:00.000Z",
  configuredHost: "127.0.0.1",
  configuredPort: 8789,
  healthz: {
    authRequired: true,
    httpStatus: 200,
    rawCredentialsReturned: false,
    rawPathsReturned: false,
    schemaVersion: "trusted.dream-memory-relay.readiness.v1",
    sourceRootCount: 1,
    status: "passed",
    supportedOperationCount: 10,
  },
  rawCredentialsReturned: false,
  rawPathsReturned: false,
  redacted: true,
  schemaVersion: "trusted.dream-memory-relay.local-readiness-proof.v1",
  sourceRootCount: 1,
  startupEnvRef:
    ".wrangler/workflow-app/dream-relay/local-relay-startup-env.json",
  status: "passed",
  tokenConfigured: true,
  usedConfiguredPort: false,
});

const sourceFamilyCoverage = [
  {
    family: "agent-transcripts",
    receiptCount: 21,
    sourceIds: ["source:agent-transcripts:joelclaw"],
    status: "captured",
  },
  {
    family: "brain",
    receiptCount: 3,
    sourceIds: ["source:brain:pi-cloudflare-sandbox-workflows"],
    status: "captured",
  },
  {
    family: "cloudflare-runs",
    receiptCount: 4,
    sourceIds: ["source:cloudflare-runs:workflow-app"],
    status: "captured",
  },
  {
    family: "docs-pdf-brain",
    receiptCount: 5,
    sourceIds: ["source:docs-pdf-brain:joelclaw-api"],
    status: "captured",
  },
  {
    family: "repo-outputs",
    receiptCount: 6,
    sourceIds: ["source:repo-outputs:pi-cloudflare-sandbox-workflows"],
    status: "captured",
  },
] as const;

const localRelayProof = JSON.stringify({
  checkedAt: "2026-06-09T10:00:00.000Z",
  correlation: {
    edgeCount: 48,
    nodeCount: 33,
  },
  rawCredentialsReturned: false,
  rawPathLeaked: false,
  rawPathsReturned: false,
  redacted: true,
  runId: "run:dream-relay-local-proof:test",
  schemaVersion: "trusted.dream-memory-relay.local-proof.v1",
  search: {
    hitCount: 12,
    hydratedCount: 12,
  },
  signals: {
    receiptFamilyCounts: [
      {
        family: "agent-transcripts",
        receiptCount: 3,
      },
    ],
    signalCount: 3,
    signalKinds: ["workflow-pattern"],
  },
  sourceFamilyCoverage,
  sourceRootCount: 8,
});

const livePreflightBlocked = JSON.stringify({
  checks: [
    {
      checkId: "relay:local-proof",
      message: "Trusted local Dream relay proof passed.",
      redacted: true,
      required: true,
      requiredFor: ["dream-memory-relay-local-proof"],
      status: "passed",
    },
    {
      checkId: "relay:healthz",
      message:
        "Dream memory relay readiness was not checked because MEMORY_RELAY_BASE_URL is missing.",
      redacted: true,
      required: true,
      requiredFor: ["dream-memory-relay-readiness"],
      status: "missing",
    },
    {
      checkId: "env:MEMORY_RELAY_BASE_URL",
      message: "MEMORY_RELAY_BASE_URL is not configured.",
      redacted: true,
      required: true,
      requiredFor: ["dream-memory-relay-binding"],
      status: "missing",
    },
    {
      checkId: "env:MEMORY_RELAY_TOKEN",
      message: "MEMORY_RELAY_TOKEN is not configured.",
      redacted: true,
      required: true,
      requiredFor: ["dream-memory-relay-lease"],
      status: "missing",
    },
    {
      checkId: "wrangler:MEMORY_RELAY_BASE_URL",
      message: "Worker deploy config does not define MEMORY_RELAY_BASE_URL.",
      redacted: true,
      required: true,
      requiredFor: ["dream-memory-relay-binding"],
      status: "missing",
    },
  ],
  generatedAt: "2026-06-09T10:00:00.000Z",
  redacted: true,
  requiredActions: [],
  schemaVersion: "workflow.live-preflight.v1",
  status: "blocked",
});

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
};

describe("Dream relay provisioning preflight", () => {
  it("blocks network exposure until owner sign-off is present", () => {
    const receipt = buildDreamRelayProvisioningPreflightReceipt({
      checkedAt: "2026-06-09T10:00:00.000Z",
      livePreflightPath: "dream-preflight.json",
      livePreflightText: livePreflightBlocked,
      localRelayProofPath: "local-proof.json",
      localRelayProofText: localRelayProof,
      networkTools: [
        {
          available: true,
          command: "ngrok",
          path: "/opt/homebrew/bin/ngrok",
        },
      ],
      visionText: visionWithSignoffRule,
    });

    expect({
      approvalStatus: receipt.approval.status,
      correlationEdgeCount: receipt.localRelayProof.correlationEdgeCount,
      localProofStatus: receipt.localRelayProof.status,
      noSideEffectsPerformed: receipt.provisioningPlan.noSideEffectsPerformed,
      planSchemaVersion: receipt.provisioningPlan.schemaVersion,
      recommendedSignoff: receipt.recommendedNextActions.includes(
        "Get explicit owner sign-off for exposing the trusted Dream relay over a new network boundary."
      ),
      signalCount: receipt.localRelayProof.signalCount,
      signoffProvided: receipt.approval.signoffProvided,
      status: receipt.status,
    }).toStrictEqual({
      approvalStatus: "required",
      correlationEdgeCount: 48,
      localProofStatus: "passed",
      noSideEffectsPerformed: true,
      planSchemaVersion: "trusted.dream-memory-relay.provisioning-plan.v1",
      recommendedSignoff: true,
      signalCount: 3,
      signoffProvided: false,
      status: "blocked",
    });
  });

  it("does not treat an approval ref as the required exact sign-off phrase", () => {
    const receipt = buildDreamRelayProvisioningPreflightReceipt({
      approvalRef: "approval:joel:2026-06-09:dream-relay-network-boundary",
      checkedAt: "2026-06-09T10:00:00.000Z",
      livePreflightPath: "dream-preflight.json",
      livePreflightText: livePreflightBlocked,
      localRelayProofPath: "local-proof.json",
      localRelayProofText: localRelayProof,
      networkTools: [
        {
          available: true,
          command: "ngrok",
          path: "/opt/homebrew/bin/ngrok",
        },
      ],
      visionText: visionWithSignoffRule,
    });

    expect({
      approvalRef: receipt.approval.approvalRef,
      approvalStatus: receipt.approval.status,
      signoffProvided: receipt.approval.signoffProvided,
      status: receipt.status,
    }).toStrictEqual({
      approvalRef: "approval:joel:2026-06-09:dream-relay-network-boundary",
      approvalStatus: "required",
      signoffProvided: false,
      status: "blocked",
    });
  });

  it("rejects a non-matching relay exposure sign-off phrase", () => {
    const receipt = buildDreamRelayProvisioningPreflightReceipt({
      approvalRef: "approval:joel:2026-06-09:dream-relay-network-boundary",
      approvalSignoff: "sure go ahead",
      checkedAt: "2026-06-09T10:00:00.000Z",
      livePreflightPath: "dream-preflight.json",
      livePreflightText: livePreflightBlocked,
      localRelayProofPath: "local-proof.json",
      localRelayProofText: localRelayProof,
      networkTools: [
        {
          available: true,
          command: "ngrok",
          path: "/opt/homebrew/bin/ngrok",
        },
      ],
      visionText: visionWithSignoffRule,
    });

    expect({
      approvalStatus: receipt.approval.status,
      invalidSignoffAction: receipt.recommendedNextActions.includes(
        "Recorded relay exposure sign-off did not match the required phrase; provide the exact sign-off phrase before provisioning."
      ),
      signoffProvided: receipt.approval.signoffProvided,
      status: receipt.status,
    }).toStrictEqual({
      approvalStatus: "invalid",
      invalidSignoffAction: true,
      signoffProvided: false,
      status: "blocked",
    });
  });

  it("rejects stale local relay proofs without correlation graph counts", () => {
    const staleLocalRelayProof = JSON.stringify({
      checkedAt: "2026-06-09T10:00:00.000Z",
      rawCredentialsReturned: false,
      rawPathLeaked: false,
      rawPathsReturned: false,
      redacted: true,
      runId: "run:dream-relay-local-proof:stale",
      schemaVersion: "trusted.dream-memory-relay.local-proof.v1",
      search: {
        hitCount: 12,
        hydratedCount: 12,
      },
      sourceFamilyCoverage,
      sourceRootCount: 8,
    });
    const receipt = buildDreamRelayProvisioningPreflightReceipt({
      approvalRef: "approval:joel:2026-06-09:dream-relay-network-boundary",
      approvalSignoff,
      checkedAt: "2026-06-09T10:00:00.000Z",
      livePreflightPath: "dream-preflight.json",
      livePreflightText: livePreflightBlocked,
      localRelayProofPath: "local-proof.json",
      localRelayProofText: staleLocalRelayProof,
      networkTools: [
        {
          available: true,
          command: "ngrok",
          path: "/opt/homebrew/bin/ngrok",
        },
      ],
      visionText: visionWithSignoffRule,
    });

    expect({
      action: receipt.recommendedNextActions.at(0),
      localProofStatus: receipt.localRelayProof.status,
      status: receipt.status,
    }).toStrictEqual({
      action:
        "Run pnpm app:dream:relay:proof and inspect the redacted local relay proof receipt.",
      localProofStatus: "failed",
      status: "blocked",
    });
  });

  it("reports missing source families as a non-blocking coverage caveat", () => {
    const missingFamilyLocalRelayProof = JSON.stringify({
      checkedAt: "2026-06-09T10:00:00.000Z",
      correlation: {
        edgeCount: 48,
        nodeCount: 33,
      },
      rawCredentialsReturned: false,
      rawPathLeaked: false,
      rawPathsReturned: false,
      redacted: true,
      runId: "run:dream-relay-local-proof:missing-families",
      schemaVersion: "trusted.dream-memory-relay.local-proof.v1",
      search: {
        hitCount: 12,
        hydratedCount: 12,
      },
      sourceFamilyCoverage: sourceFamilyCoverage.filter(
        (coverage) => coverage.family !== "agent-transcripts"
      ),
      sourceRootCount: 8,
    });
    const receipt = buildDreamRelayProvisioningPreflightReceipt({
      approvalRef: "approval:joel:2026-06-09:dream-relay-network-boundary",
      approvalSignoff,
      checkedAt: "2026-06-09T10:00:00.000Z",
      livePreflightPath: "dream-preflight.json",
      livePreflightText: livePreflightBlocked,
      localRelayProofPath: "local-proof.json",
      localRelayProofText: missingFamilyLocalRelayProof,
      networkTools: [
        {
          available: true,
          command: "ngrok",
          path: "/opt/homebrew/bin/ngrok",
        },
      ],
      visionText: visionWithSignoffRule,
    });

    expect({
      caveatAction: receipt.recommendedNextActions.includes(
        "Coverage caveat (reported, not blocking): missing source families agent-transcripts will appear in the dream report."
      ),
      localProofStatus: receipt.localRelayProof.status,
      missingSourceFamilies: receipt.localRelayProof.missingSourceFamilies,
    }).toStrictEqual({
      caveatAction: true,
      localProofStatus: "passed",
      missingSourceFamilies: ["agent-transcripts"],
    });
  });

  it("marks the relay ready for approved provisioning after sign-off and local proof", () => {
    const receipt = buildDreamRelayProvisioningPreflightReceipt({
      approvalRef: "approval:joel:2026-06-09:dream-relay-network-boundary",
      approvalSignoff,
      checkedAt: "2026-06-09T10:00:00.000Z",
      livePreflightPath: "dream-preflight.json",
      livePreflightText: livePreflightBlocked,
      localRelayProofPath: "local-proof.json",
      localRelayProofText: localRelayProof,
      localRelayReadinessPath: "local-readiness.json",
      localRelayReadinessText: localRelayReadinessProof,
      localRelayStartupEnv,
      networkTools: [
        {
          available: true,
          command: "ngrok",
          path: "/opt/homebrew/bin/ngrok",
        },
      ],
      visionText: visionWithSignoffRule,
    });

    expect({
      approvalRef: receipt.approval.approvalRef,
      approvalStatus: receipt.approval.status,
      healthzAction: receipt.recommendedNextActions.includes(
        "Provision an approved HTTPS relay endpoint and verify authenticated /healthz."
      ),
      localReadinessStatus: receipt.localRelayReadiness.status,
      localRelayStartup: {
        sourceRootCount: receipt.localRelayStartup.sourceRootCount,
        status: receipt.localRelayStartup.status,
        tokenConfigured: receipt.localRelayStartup.tokenConfigured,
      },
      signoffProvided: receipt.approval.signoffProvided,
      status: receipt.status,
    }).toStrictEqual({
      approvalRef: "approval:joel:2026-06-09:dream-relay-network-boundary",
      approvalStatus: "approved",
      healthzAction: true,
      localReadinessStatus: "passed",
      localRelayStartup: {
        sourceRootCount: 1,
        status: "ready",
        tokenConfigured: true,
      },
      signoffProvided: true,
      status: "ready-for-approved-provisioning",
    });
  });

  it("keeps approved provisioning blocked until local relay readiness is proven", () => {
    const receipt = buildDreamRelayProvisioningPreflightReceipt({
      approvalRef: "approval:joel:2026-06-09:dream-relay-network-boundary",
      approvalSignoff,
      checkedAt: "2026-06-09T10:00:00.000Z",
      livePreflightPath: "dream-preflight.json",
      livePreflightText: livePreflightBlocked,
      localRelayProofPath: "local-proof.json",
      localRelayProofText: localRelayProof,
      localRelayStartupEnv,
      networkTools: [
        {
          available: true,
          command: "ngrok",
          path: "/opt/homebrew/bin/ngrok",
        },
      ],
      visionText: visionWithSignoffRule,
    });
    const stepsById = new Map(
      receipt.provisioningPlan.steps.map((step) => [step.stepId, step])
    );

    expect({
      readinessAction: receipt.recommendedNextActions.includes(
        "Run pnpm app:dream:relay:readiness to prove the local trusted relay can boot from the generated startup env and pass authenticated /healthz."
      ),
      readinessStatus: receipt.localRelayReadiness.status,
      status: receipt.status,
      verifyReadinessBlockers: stepsById.get("verify-local-relay-readiness")
        ?.blockedBy,
    }).toStrictEqual({
      readinessAction: true,
      readinessStatus: "missing",
      status: "blocked",
      verifyReadinessBlockers: ["local-relay-readiness-not-passed"],
    });
  });

  it("keeps approved provisioning blocked until local relay startup env is configured", () => {
    const receipt = buildDreamRelayProvisioningPreflightReceipt({
      approvalRef: "approval:joel:2026-06-09:dream-relay-network-boundary",
      approvalSignoff,
      checkedAt: "2026-06-09T10:00:00.000Z",
      livePreflightPath: "dream-preflight.json",
      livePreflightText: livePreflightBlocked,
      localRelayProofPath: "local-proof.json",
      localRelayProofText: localRelayProof,
      networkTools: [
        {
          available: true,
          command: "ngrok",
          path: "/opt/homebrew/bin/ngrok",
        },
      ],
      visionText: visionWithSignoffRule,
    });
    const stepsById = new Map(
      receipt.provisioningPlan.steps.map((step) => [step.stepId, step])
    );

    expect({
      localRelayStartup: receipt.localRelayStartup,
      sourceRootsAction: receipt.recommendedNextActions.includes(
        "Set MEMORY_RELAY_SOURCE_ROOTS_JSON before starting the local trusted relay."
      ),
      startRelayBlockers: stepsById.get("start-local-trusted-relay")?.blockedBy,
      status: receipt.status,
      tokenAction: receipt.recommendedNextActions.includes(
        "Set MEMORY_RELAY_TOKEN locally before starting the relay and provisioning the Worker secret."
      ),
    }).toStrictEqual({
      localRelayStartup: {
        invalidEnv: [],
        missingEnv: ["MEMORY_RELAY_SOURCE_ROOTS_JSON", "MEMORY_RELAY_TOKEN"],
        redacted: true,
        sourceRootCount: 0,
        status: "blocked",
        tokenConfigured: false,
      },
      sourceRootsAction: true,
      startRelayBlockers: ["local-relay-startup-config-missing"],
      status: "blocked",
      tokenAction: true,
    });
  });

  it("emits a non-executed provisioning plan with blocked live submit steps", () => {
    const receipt = buildDreamRelayProvisioningPreflightReceipt({
      approvalRef: "approval:joel:2026-06-09:dream-relay-network-boundary",
      approvalSignoff,
      checkedAt: "2026-06-09T10:00:00.000Z",
      livePreflightPath: "dream-preflight.json",
      livePreflightText: livePreflightBlocked,
      localRelayProofPath: "local-proof.json",
      localRelayProofText: localRelayProof,
      localRelayReadinessPath: "local-readiness.json",
      localRelayReadinessText: localRelayReadinessProof,
      localRelayStartupEnv,
      networkTools: [
        {
          available: false,
          command: "cloudflared",
        },
        {
          available: true,
          command: "ngrok",
          path: "/opt/homebrew/bin/ngrok",
        },
      ],
      visionText: visionWithSignoffRule,
    });

    const stepsById = new Map(
      receipt.provisioningPlan.steps.map((step) => [step.stepId, step])
    );

    expect({
      allStepsNonExecuted: receipt.provisioningPlan.steps.every(
        (step) => !step.executed
      ),
      refreshStatus: stepsById.get("refresh-local-relay-proof")?.status,
      relayTokenStep: {
        executed: stepsById.get("provision-worker-relay-token")?.executed,
        sideEffectClass: stepsById.get("provision-worker-relay-token")
          ?.sideEffectClass,
        status: stepsById.get("provision-worker-relay-token")?.status,
      },
      submitBlockers: stepsById.get("submit-live-dream")?.blockedBy,
      transportCandidates: receipt.provisioningPlan.selectedTransportCandidates,
    }).toStrictEqual({
      allStepsNonExecuted: true,
      refreshStatus: "ready",
      relayTokenStep: {
        executed: false,
        sideEffectClass: "secret-write",
        status: "ready-after-signoff",
      },
      submitBlockers: [
        "missing-dream-memory-relay-base-url",
        "missing-dream-memory-relay-token",
        "missing-worker-relay-url-config",
        "relay-healthz-not-verified",
      ],
      transportCandidates: [
        {
          available: false,
          command: "cloudflared",
          preferred: true,
          reason: "cloudflared is not available on PATH.",
        },
        {
          available: true,
          command: "ngrok",
          preferred: false,
          reason: "ngrok is installed locally.",
        },
        {
          available: false,
          command: "tailscale",
          preferred: false,
          reason: "tailscale is not available on PATH.",
        },
      ],
    });
  });

  it("does not treat optional support/comms source packs as Dreamer provisioning blockers", () => {
    const optionalFamilyGapProof = JSON.stringify({
      checkedAt: "2026-06-09T10:00:00.000Z",
      correlation: {
        edgeCount: 48,
        nodeCount: 33,
      },
      rawCredentialsReturned: false,
      rawPathLeaked: false,
      rawPathsReturned: false,
      redacted: true,
      runId: "run:dream-relay-local-proof:missing-source-families",
      schemaVersion: "trusted.dream-memory-relay.local-proof.v1",
      search: {
        hitCount: 12,
        hydratedCount: 12,
      },
      sourceFamilyCoverage: [
        ...sourceFamilyCoverage,
        {
          family: "comms",
          missingReason:
            "No scoped capability lease is configured for this optional source family.",
          receiptCount: 0,
          sourceIds: [],
          status: "missing",
        },
        {
          family: "support",
          missingReason:
            "No scoped capability lease is configured for this optional source family.",
          receiptCount: 0,
          sourceIds: [],
          status: "missing",
        },
      ],
      sourceRootCount: 8,
    });
    const receipt = buildDreamRelayProvisioningPreflightReceipt({
      approvalSignoff,
      checkedAt: "2026-06-09T10:00:00.000Z",
      livePreflightPath: "dream-preflight.json",
      livePreflightText: livePreflightBlocked,
      localRelayProofPath: "local-proof.json",
      localRelayProofText: optionalFamilyGapProof,
      networkTools: [
        {
          available: true,
          command: "ngrok",
          path: "/opt/homebrew/bin/ngrok",
        },
      ],
      visionText: visionWithSignoffRule,
    });

    expect({
      missingSourceFamilies: receipt.localRelayProof.missingSourceFamilies,
      status: receipt.localRelayProof.status,
    }).toStrictEqual({
      missingSourceFamilies: [],
      status: "passed",
    });
  });

  it("blocks when local relay proof is missing or unsafe", () => {
    const receipt = buildDreamRelayProvisioningPreflightReceipt({
      approvalRef: "approval:joel:2026-06-09:dream-relay-network-boundary",
      approvalSignoff,
      checkedAt: "2026-06-09T10:00:00.000Z",
      livePreflightPath: "dream-preflight.json",
      livePreflightText: livePreflightBlocked,
      localRelayProofPath: "local-proof.json",
      localRelayProofText: "",
      networkTools: [
        {
          available: true,
          command: "ngrok",
          path: "/opt/homebrew/bin/ngrok",
        },
      ],
      visionText: visionWithSignoffRule,
    });

    expect({
      action: receipt.recommendedNextActions.at(0),
      localProofStatus: receipt.localRelayProof.status,
      status: receipt.status,
    }).toStrictEqual({
      action:
        "Run pnpm app:dream:relay:proof and inspect the redacted local relay proof receipt.",
      localProofStatus: "missing",
      status: "blocked",
    });
  });

  it("loads the local relay startup env artifact without leaking its token or raw roots", async () => {
    const repoRoot = await mkdtemp(resolve(tmpdir(), "dream-preflight-"));
    const localRelayReadinessPath =
      ".wrangler/workflow-app/dream-relay/latest-local-readiness.json";
    const localRelayStartupEnvPath =
      ".wrangler/workflow-app/dream-relay/local-relay-startup-env.json";
    const logs: string[] = [];
    const rawAuthorityRoot = "/private/tmp/dream-relay-preflight-source";
    const relayToken = "super-secret-local-relay-token";

    await writeFile(resolve(repoRoot, "VISION.md"), visionWithSignoffRule);
    await writeFile(
      resolve(repoRoot, "dream-preflight.json"),
      livePreflightBlocked
    );
    await writeFile(resolve(repoRoot, "local-proof.json"), localRelayProof);
    await writeJson(
      resolve(repoRoot, localRelayReadinessPath),
      JSON.parse(localRelayReadinessProof)
    );
    await writeJson(resolve(repoRoot, localRelayStartupEnvPath), {
      MEMORY_RELAY_SOURCE_ROOTS_JSON: JSON.stringify([
        {
          authorityRoot: rawAuthorityRoot,
          family: "agent-transcripts",
          includeExtensions: [".jsonl"],
          label: "Sensitive local transcripts",
          privacyTier: "private",
          runtime: "codex",
          sourceId: "source:agent-transcripts:codex:test",
          sourceSystem: "codex",
        },
      ]),
      MEMORY_RELAY_TOKEN: relayToken,
    });

    const receipt = await runDreamRelayProvisioningPreflightCli({
      argv: [
        "--approval-ref=approval:joel:2026-06-09:dream-relay-network-boundary",
        `--approval-signoff=${approvalSignoff}`,
        "--live-preflight-path=dream-preflight.json",
        "--local-relay-proof-path=local-proof.json",
        `--local-relay-readiness-path=${localRelayReadinessPath}`,
        `--local-relay-startup-env-path=${localRelayStartupEnvPath}`,
        "--receipt-path=receipt.json",
      ],
      log: (message) => {
        logs.push(message);
      },
      networkTools: [
        {
          available: true,
          command: "ngrok",
          path: "/opt/homebrew/bin/ngrok",
        },
      ],
      processEnv: {},
      repoRoot,
    });
    const serializedReceipt = JSON.stringify(receipt);
    const serializedLogs = logs.join("\n");

    expect({
      envRef: receipt.localRelayStartup.envRef,
      envSource: receipt.localRelayStartup.envSource,
      readinessStatus: receipt.localRelayReadiness.status,
      sourceRootCount: receipt.localRelayStartup.sourceRootCount,
      startupStatus: receipt.localRelayStartup.status,
      status: receipt.status,
      tokenConfigured: receipt.localRelayStartup.tokenConfigured,
    }).toStrictEqual({
      envRef: localRelayStartupEnvPath,
      envSource: "artifact",
      readinessStatus: "passed",
      sourceRootCount: 1,
      startupStatus: "ready",
      status: "ready-for-approved-provisioning",
      tokenConfigured: true,
    });
    expect(serializedReceipt).not.toContain(rawAuthorityRoot);
    expect(serializedReceipt).not.toContain(relayToken);
    expect(serializedLogs).not.toContain(rawAuthorityRoot);
    expect(serializedLogs).not.toContain(relayToken);
  });
});
