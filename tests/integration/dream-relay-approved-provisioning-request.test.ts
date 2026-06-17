import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { runMemoryRelayApprovedProvisioningRequestCli } from "../../scripts/workflow-app-relay-approved-provisioning-request.ts";
import { dreamTranscriptReviewSourceProfile } from "../../src/cartridges/memory-fabric/source-profile.ts";
import { workflowCliTestRepoRoot } from "./workflow-app-fixtures.ts";

const signoffPhrase = "exposing JoelClaw/Typesense over a new network boundary";
const rawAuthorityRoot = "/private/tmp/dream-relay-approved-provisioning";
const relayBaseUrl = "https://approved-dream-relay.example.com/relay";
const relayToken = "approved-provisioning-relay-token";

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
};

const localStartupEnv = () => ({
  MEMORY_RELAY_SOURCE_ROOTS_JSON: JSON.stringify([
    {
      authorityRoot: "joelclaw+index://sessions?machine=all&runtime=all",
      family: "agent-transcripts",
      label: "JoelClaw session index",
      privacyTier: "private",
      sourceId: "source:agent-transcripts:joelclaw-index:approved-provisioning",
      sourceSystem: "joelclaw:session-index",
    },
    {
      authorityRoot: rawAuthorityRoot,
      family: "brain",
      includeExtensions: [".svx"],
      label: "Sensitive local brain notes",
      privacyTier: "private",
      sourceId: "source:brain:approved-provisioning",
      sourceSystem: "local:brain",
    },
  ]),
  MEMORY_RELAY_TOKEN: relayToken,
});

const localReadiness = () => ({
  boundHost: "127.0.0.1",
  boundPort: 49_001,
  checkedAt: "2026-06-10T10:45:00.000Z",
  configuredHost: "127.0.0.1",
  configuredPort: 8789,
  healthz: {
    authRequired: true,
    httpStatus: 200,
    rawCredentialsReturned: false,
    rawPathsReturned: false,
    schemaVersion: "trusted.memory-relay.readiness.v1",
    sourceRootCount: 1,
    status: "passed",
    supportedOperationCount: 10,
  },
  rawCredentialsReturned: false,
  rawPathsReturned: false,
  redacted: true,
  schemaVersion: "trusted.memory-relay.local-readiness-proof.v1",
  sourceRootCount: 1,
  startupEnvRef:
    ".wrangler/workflow-app/memory-relay/local-relay-startup-env.json",
  status: "passed",
  tokenConfigured: true,
  usedConfiguredPort: false,
});

const provisioningPreflight = () => ({
  approval: {
    required: true,
    signoffPhrase,
    signoffProvided: false,
    status: "required",
  },
  checkedAt: "2026-06-10T10:45:10.000Z",
  livePreflight: {
    missingCheckIds: [
      "env:MEMORY_RELAY_BASE_URL",
      "env:MEMORY_RELAY_TOKEN",
      "wrangler:MEMORY_RELAY_BASE_URL",
      "relay:healthz",
    ],
    path: ".wrangler/workflow-app/dream-preflight/latest-dream-preflight.json",
    relayHealthzStatus: "missing",
    relayLocalProofStatus: "passed",
    status: "blocked",
  },
  localRelayProof: {
    missingSourceFamilies: [],
    path: ".wrangler/workflow-app/memory-relay/latest-local-proof.json",
    rawCredentialsReturned: false,
    rawPathLeaked: false,
    rawPathsReturned: false,
    runId: "run:memory-relay-local-proof:test",
    sourceRootCount: 1,
    status: "passed",
  },
  localRelayReadiness: {
    checkedAt: "2026-06-10T10:45:00.000Z",
    healthzStatus: "passed",
    path: ".wrangler/workflow-app/memory-relay/latest-local-readiness.json",
    rawCredentialsReturned: false,
    rawPathsReturned: false,
    sourceRootCount: 1,
    status: "passed",
    supportedOperationCount: 10,
    tokenConfigured: true,
  },
  localRelayStartup: {
    envRef: ".wrangler/workflow-app/memory-relay/local-relay-startup-env.json",
    envSource: "artifact",
    host: "127.0.0.1",
    invalidEnv: [],
    missingEnv: [],
    port: 8789,
    redacted: true,
    sourceRootCount: 1,
    status: "ready",
    tokenConfigured: true,
  },
  networkTools: [
    {
      available: true,
      command: "ngrok",
      path: "/opt/homebrew/bin/ngrok",
    },
  ],
  provisioningPlan: {
    approvalStatus: "required",
    noSideEffectsPerformed: true,
    redacted: true,
    requiredSecretBindings: ["MEMORY_RELAY_TOKEN"],
    requiredSignoffPhrase: signoffPhrase,
    requiredWorkerVars: ["MEMORY_RELAY_BASE_URL"],
    schemaVersion: "trusted.memory-relay.provisioning-plan.v1",
    selectedTransportCandidates: [],
    steps: [],
  },
  recommendedNextActions: [],
  redacted: true,
  schemaVersion: "trusted.memory-relay.provisioning-preflight.v1",
  status: "blocked",
});

const writeFixtureFiles = async (repoRoot: string): Promise<void> => {
  await writeJson(
    resolve(
      repoRoot,
      ".wrangler/workflow-app/memory-relay/local-relay-startup-env.json"
    ),
    localStartupEnv()
  );
  await writeJson(
    resolve(
      repoRoot,
      ".wrangler/workflow-app/memory-relay/latest-local-readiness.json"
    ),
    localReadiness()
  );
  await writeJson(
    resolve(
      repoRoot,
      ".wrangler/workflow-app/memory-relay/latest-provisioning-preflight.json"
    ),
    provisioningPreflight()
  );
};

const forbiddenPrivateValuesIn = (value: string): string[] =>
  [relayToken, rawAuthorityRoot, relayBaseUrl].filter((privateValue) =>
    value.includes(privateValue)
  );

describe("Memory relay approved provisioning request", () => {
  it("blocks without exact signoff and does not leak token, source root, or relay URL", async () => {
    const repoRoot = await workflowCliTestRepoRoot("dream-relay-approved-");
    const logs: string[] = [];

    await writeFixtureFiles(repoRoot);

    const receipt = await runMemoryRelayApprovedProvisioningRequestCli({
      argv: [
        "--profile",
        dreamTranscriptReviewSourceProfile.profileId,
        `--relay-base-url=${relayBaseUrl}`,
      ],
      log: (message) => {
        logs.push(message);
      },
      now: () => "2026-06-10T10:46:00.000Z",
      processEnv: {},
      repoRoot,
    });
    const serialized = JSON.stringify(receipt);
    const logsText = logs.join("\n");

    expect({
      blockers: receipt.blockers,
      noSideEffectsPerformed: receipt.noSideEffectsPerformed,
      relayConfigured: receipt.relayEndpoint.configured,
      status: receipt.status,
      tokenConfigured: receipt.localRelay.tokenConfigured,
    }).toStrictEqual({
      blockers: ["missing-exact-owner-signoff"],
      noSideEffectsPerformed: true,
      relayConfigured: true,
      status: "blocked",
      tokenConfigured: true,
    });
    expect(forbiddenPrivateValuesIn(serialized)).toStrictEqual([]);
    expect(forbiddenPrivateValuesIn(logsText)).toStrictEqual([]);
  });

  it("marks the request ready with exact signoff, HTTPS relay URL, and local proofs", async () => {
    const repoRoot = await workflowCliTestRepoRoot("dream-relay-approved-");

    await writeFixtureFiles(repoRoot);

    const receipt = await runMemoryRelayApprovedProvisioningRequestCli({
      argv: [
        "--profile",
        dreamTranscriptReviewSourceProfile.profileId,
        `--approval-signoff=${signoffPhrase}`,
        `--relay-base-url=${relayBaseUrl}`,
      ],
      log: () => {},
      now: () => "2026-06-10T10:47:00.000Z",
      processEnv: {},
      repoRoot,
    });

    expect({
      approvalStatus: receipt.approval.status,
      blockerCount: receipt.blockers.length,
      commandStatuses: receipt.commands.map((command) => command.status),
      localReadinessStatus: receipt.localRelay.localReadinessStatus,
      localStartupStatus: receipt.localRelay.localStartupStatus,
      relayHttps: receipt.relayEndpoint.https,
      status: receipt.status,
    }).toStrictEqual({
      approvalStatus: "approved",
      blockerCount: 0,
      commandStatuses: [
        "ready-after-signoff",
        "ready-after-signoff",
        "ready-after-signoff",
        "ready-after-signoff",
      ],
      localReadinessStatus: "passed",
      localStartupStatus: "ready",
      relayHttps: true,
      status: "ready-to-provision",
    });
  });

  it("rejects a non-HTTPS relay URL even with exact signoff", async () => {
    const repoRoot = await workflowCliTestRepoRoot("dream-relay-approved-");

    await writeFixtureFiles(repoRoot);

    const receipt = await runMemoryRelayApprovedProvisioningRequestCli({
      argv: [
        "--profile",
        dreamTranscriptReviewSourceProfile.profileId,
        `--approval-signoff=${signoffPhrase}`,
        "--relay-base-url=http://localhost:8789",
      ],
      log: () => {},
      now: () => "2026-06-10T10:48:00.000Z",
      processEnv: {},
      repoRoot,
    });

    expect({
      blockers: receipt.blockers,
      relayHttps: receipt.relayEndpoint.https,
      status: receipt.status,
    }).toStrictEqual({
      blockers: ["memory-relay-base-url-not-https"],
      relayHttps: false,
      status: "blocked",
    });
  });

  it("rejects Cloudflare Quick Tunnel relay URLs even with exact signoff", async () => {
    const repoRoot = await workflowCliTestRepoRoot("dream-relay-approved-");

    await writeFixtureFiles(repoRoot);

    const receipt = await runMemoryRelayApprovedProvisioningRequestCli({
      argv: [
        "--profile",
        dreamTranscriptReviewSourceProfile.profileId,
        `--approval-signoff=${signoffPhrase}`,
        "--relay-base-url=https://relax-offer-oscar-derek.trycloudflare.com",
      ],
      log: () => {},
      now: () => "2026-06-10T10:49:00.000Z",
      processEnv: {},
      repoRoot,
    });

    expect({
      blockers: receipt.blockers,
      ephemeralQuickTunnel: receipt.relayEndpoint.ephemeralQuickTunnel,
      relayHttps: receipt.relayEndpoint.https,
      status: receipt.status,
    }).toStrictEqual({
      blockers: ["memory-relay-base-url-ephemeral-quick-tunnel"],
      ephemeralQuickTunnel: true,
      relayHttps: true,
      status: "blocked",
    });
  });
});
