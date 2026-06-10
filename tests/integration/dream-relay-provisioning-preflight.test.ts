import { describe, expect, it } from "vitest";

import { buildDreamRelayProvisioningPreflightReceipt } from "../../scripts/workflow-app-dream-relay-provisioning-preflight.ts";

const visionWithSignoffRule = `
# Vision

## Needs Sign-Off

Stop for owner sign-off before exposing JoelClaw/Typesense over a new network boundary.
`;
const approvalSignoff =
  "exposing JoelClaw/Typesense over a new network boundary";

const machineCoverage = [
  {
    authorityCount: 21,
    machineId: "blaine",
    sourceCount: 3,
    sourceIds: [
      "source:agent-transcripts:pi:blaine",
      "source:agent-transcripts:codex:blaine",
      "source:agent-transcripts:claude:blaine",
    ],
    status: "captured",
  },
  {
    authorityCount: 5,
    machineId: "panda",
    sourceCount: 1,
    sourceIds: ["source:agent-transcripts:pi:panda"],
    status: "captured",
  },
  {
    authorityCount: 4,
    machineId: "flagg",
    sourceCount: 1,
    sourceIds: ["source:agent-transcripts:pi:flagg"],
    status: "captured",
  },
  {
    authorityCount: 4,
    machineId: "cloudflare",
    sourceCount: 1,
    sourceIds: ["source:cloudflare-runs:workflow-app"],
    status: "captured",
  },
] as const;

const sourceFamilyCoverage = [
  {
    authorityCount: 21,
    family: "agent-transcripts",
    sourceCount: 3,
    sourceIds: [
      "source:agent-transcripts:pi:blaine",
      "source:agent-transcripts:codex:blaine",
      "source:agent-transcripts:claude:blaine",
    ],
    status: "captured",
  },
  {
    authorityCount: 3,
    family: "brain",
    sourceCount: 1,
    sourceIds: ["source:brain:pi-cloudflare-sandbox-workflows"],
    status: "captured",
  },
  {
    authorityCount: 4,
    family: "cloudflare-runs",
    sourceCount: 1,
    sourceIds: ["source:cloudflare-runs:workflow-app"],
    status: "captured",
  },
  {
    authorityCount: 5,
    family: "docs-pdf-brain",
    sourceCount: 1,
    sourceIds: ["source:docs-pdf-brain:joelclaw-api"],
    status: "captured",
  },
  {
    authorityCount: 6,
    family: "repo-outputs",
    sourceCount: 1,
    sourceIds: ["source:repo-outputs:pi-cloudflare-sandbox-workflows"],
    status: "captured",
  },
] as const;

const localRelayProof = JSON.stringify({
  backfillRun: {
    blockedCount: 0,
    completedCount: 0,
    failedCount: 0,
    skippedCount: 9,
  },
  checkedAt: "2026-06-09T10:00:00.000Z",
  correlation: {
    edgeCount: 48,
    nodeCount: 33,
  },
  inventory: {
    machineCoverage,
    sourceFamilyCoverage,
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
        "Dream memory relay readiness was not checked because DREAM_MEMORY_RELAY_BASE_URL is missing.",
      redacted: true,
      required: true,
      requiredFor: ["dream-memory-relay-readiness"],
      status: "missing",
    },
    {
      checkId: "env:DREAM_MEMORY_RELAY_TOKEN",
      message: "DREAM_MEMORY_RELAY_TOKEN is not configured.",
      redacted: true,
      required: true,
      requiredFor: ["dream-memory-relay-lease"],
      status: "missing",
    },
    {
      checkId: "wrangler:DREAM_MEMORY_RELAY_BASE_URL",
      message:
        "Worker deploy config does not define DREAM_MEMORY_RELAY_BASE_URL.",
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
      backfillRunSkippedCount: receipt.localRelayProof.backfillRunSkippedCount,
      correlationEdgeCount: receipt.localRelayProof.correlationEdgeCount,
      localProofStatus: receipt.localRelayProof.status,
      recommendedSignoff: receipt.recommendedNextActions.includes(
        "Get explicit owner sign-off for exposing the trusted Dream relay over a new network boundary."
      ),
      signoffProvided: receipt.approval.signoffProvided,
      status: receipt.status,
    }).toStrictEqual({
      approvalStatus: "required",
      backfillRunSkippedCount: 9,
      correlationEdgeCount: 48,
      localProofStatus: "passed",
      recommendedSignoff: true,
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
      backfillRun: {
        blockedCount: 0,
        completedCount: 0,
        failedCount: 0,
        skippedCount: 9,
      },
      checkedAt: "2026-06-09T10:00:00.000Z",
      inventory: {
        machineCoverage,
        sourceFamilyCoverage,
      },
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

  it("rejects local relay proofs missing required machine coverage", () => {
    const missingMachineLocalRelayProof = JSON.stringify({
      backfillRun: {
        blockedCount: 0,
        completedCount: 0,
        failedCount: 0,
        skippedCount: 9,
      },
      checkedAt: "2026-06-09T10:00:00.000Z",
      correlation: {
        edgeCount: 48,
        nodeCount: 33,
      },
      inventory: {
        machineCoverage: machineCoverage.filter(
          (coverage) =>
            coverage.machineId !== "panda" && coverage.machineId !== "flagg"
        ),
        sourceFamilyCoverage,
      },
      rawCredentialsReturned: false,
      rawPathLeaked: false,
      rawPathsReturned: false,
      redacted: true,
      runId: "run:dream-relay-local-proof:missing-machines",
      schemaVersion: "trusted.dream-memory-relay.local-proof.v1",
      search: {
        hitCount: 12,
        hydratedCount: 12,
      },
      sourceRootCount: 8,
    });
    const receipt = buildDreamRelayProvisioningPreflightReceipt({
      approvalRef: "approval:joel:2026-06-09:dream-relay-network-boundary",
      approvalSignoff,
      checkedAt: "2026-06-09T10:00:00.000Z",
      livePreflightPath: "dream-preflight.json",
      livePreflightText: livePreflightBlocked,
      localRelayProofPath: "local-proof.json",
      localRelayProofText: missingMachineLocalRelayProof,
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
      localProofStatus: receipt.localRelayProof.status,
      missingMachineIds: receipt.localRelayProof.missingMachineIds,
      status: receipt.status,
    }).toStrictEqual({
      localProofStatus: "failed",
      missingMachineIds: ["panda", "flagg"],
      status: "blocked",
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
      signoffProvided: receipt.approval.signoffProvided,
      status: receipt.status,
    }).toStrictEqual({
      approvalRef: "approval:joel:2026-06-09:dream-relay-network-boundary",
      approvalStatus: "approved",
      healthzAction: true,
      signoffProvided: true,
      status: "ready-for-approved-provisioning",
    });
  });

  it("does not treat optional support/comms source packs as Dreamer provisioning blockers", () => {
    const optionalFamilyGapProof = JSON.stringify({
      backfillRun: {
        blockedCount: 0,
        completedCount: 0,
        failedCount: 0,
        skippedCount: 9,
      },
      checkedAt: "2026-06-09T10:00:00.000Z",
      correlation: {
        edgeCount: 48,
        nodeCount: 33,
      },
      inventory: {
        machineCoverage,
        sourceFamilyCoverage: [
          ...sourceFamilyCoverage,
          {
            authorityCount: 0,
            family: "comms",
            missingReason:
              "No scoped capability lease is configured for this optional source family.",
            sourceCount: 0,
            sourceIds: [],
            status: "missing",
          },
          {
            authorityCount: 0,
            family: "support",
            missingReason:
              "No scoped capability lease is configured for this optional source family.",
            sourceCount: 0,
            sourceIds: [],
            status: "missing",
          },
        ],
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
      sourceFamilyAction: receipt.recommendedNextActions.includes(
        "Provision scoped Dream source adapters or capability leases for missing source families: comms, support."
      ),
      status: receipt.localRelayProof.status,
    }).toStrictEqual({
      missingSourceFamilies: [],
      sourceFamilyAction: false,
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
});
