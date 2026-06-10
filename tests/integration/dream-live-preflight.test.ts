import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildDreamLivePreflightReceipt,
  checkLocalRelayProof,
  checkDreamRelayReadiness,
  extractPackageIdsFromD1Output,
  extractPackageRowsFromD1Output,
  extractSecretNamesFromWranglerOutput,
  runDreamPreflightCli,
} from "../../scripts/workflow-app-dream-preflight.ts";
import { WorkflowLivePreflightReceiptSchema } from "../../src/app/domain/schemas.ts";
import type {
  WorkflowLivePreflightCheck,
  WorkflowLivePreflightRemoteRegistry,
  WorkflowLivePreflightRemoteSecretInventory,
} from "../../src/app/domain/schemas.ts";
import { dreamMemoryRelayEndpointCatalog } from "../../src/cartridges/dream-memory-fabric/cloudflare-relay.ts";

const queriedRemoteRegistry: WorkflowLivePreflightRemoteRegistry = {
  command: ["pnpm", "exec", "wrangler", "d1", "execute"],
  expectedPackageId: "workflow/dream-memory-fabric",
  expectedPackageSeeded: false,
  expectedSchemaExportIds: ["dream-hitl-decision-schema"],
  expectedWorkflowNodeTypes: [
    "joelclaw.dream.source-inventory",
    "joelclaw.dream.source-health",
    "joelclaw.dream.backfill-plan",
    "joelclaw.dream.backfill-run",
    "joelclaw.dream.capture-run",
    "joelclaw.dream.capture-artifact",
    "joelclaw.dream.memory-search",
    "joelclaw.dream.signals",
    "joelclaw.dream.hydrate",
    "joelclaw.dream.correlate",
    "joelclaw.dream.refinement-proposals",
    "joelclaw.dream.hitl-report",
    "joelclaw.dream.hitl-decision-seed",
    "joelclaw.dream.hitl-follow-up-run-request",
  ],
  packageIds: [
    "badass-courses/claw-kernel",
    "workflow/research-review-discord",
  ],
  packageRows: [],
  redacted: true,
  status: "queried",
};

const seededRemoteRegistry: WorkflowLivePreflightRemoteRegistry = {
  ...queriedRemoteRegistry,
  expectedPackageArtifactRefMatched: true,
  expectedPackageManifestHashMatched: true,
  expectedPackageSeeded: true,
  packageIds: [
    "badass-courses/claw-kernel",
    "workflow/dream-memory-fabric",
    "workflow/research-review-discord",
  ],
};

const emptyRemoteSecrets: WorkflowLivePreflightRemoteSecretInventory = {
  command: ["pnpm", "exec", "wrangler", "secret", "list"],
  redacted: true,
  secretNames: [],
  status: "queried",
};

const completeRemoteSecrets: WorkflowLivePreflightRemoteSecretInventory = {
  ...emptyRemoteSecrets,
  secretNames: [
    "PI_AUTH_JSON_B64",
    "WORKFLOW_APP_ADMIN_TOKEN",
    "WORKFLOW_APP_MODEL",
    "WZRRD_API_TOKEN",
  ],
};

const completeEnv = {
  DREAM_MEMORY_RELAY_BASE_URL: "https://dream-relay.example.test",
  DREAM_MEMORY_RELAY_TOKEN: "relay-secret",
} as const;

const wranglerWithDreamRelay =
  '"DREAM_MEMORY_RELAY_BASE_URL": "https://dream-relay.example.test"';
const deployScriptWithDreamRelayToken = '"DREAM_MEMORY_RELAY_TOKEN"';
const deployScriptWithSignoffGatedDreamRelayConfig = [
  '"DREAM_MEMORY_RELAY_TOKEN"',
  '"DREAM_MEMORY_RELAY_BASE_URL"',
  "dreamRelaySignoffPhrase",
].join("\n");

const relayReadinessPassed: WorkflowLivePreflightCheck = {
  checkId: "relay:healthz",
  message:
    "Dream memory relay /healthz returned a redacted readiness receipt with required operations.",
  redacted: true,
  required: true,
  requiredFor: ["dream-memory-relay-readiness", "dream-memory-relay-lease"],
  status: "passed",
};

const relayReadinessMissing: WorkflowLivePreflightCheck = {
  checkId: "relay:healthz",
  message:
    "Dream memory relay readiness was not checked because DREAM_MEMORY_RELAY_BASE_URL is missing.",
  redacted: true,
  required: true,
  requiredFor: ["dream-memory-relay-readiness", "dream-memory-relay-lease"],
  status: "missing",
};

const localRelayProofPassed: WorkflowLivePreflightCheck = {
  checkId: "relay:local-proof",
  message:
    "Trusted local Dream relay proof passed with 8 source roots, 9 backfill action receipt(s), 0 capture-fix receipt(s), 3 signal receipt(s), 12 search hits, 12 hydrated redacted receipts, and 24 correlation edges.",
  redacted: true,
  required: true,
  requiredFor: [
    "dream-memory-relay-local-proof",
    "dream-memory-relay-network-exposure-safety",
  ],
  status: "passed",
};

const localRelayProofMissing: WorkflowLivePreflightCheck = {
  checkId: "relay:local-proof",
  message:
    "Trusted local Dream relay proof receipt is missing at .wrangler/workflow-app/dream-relay/latest-local-proof.json.",
  redacted: true,
  required: true,
  requiredFor: [
    "dream-memory-relay-local-proof",
    "dream-memory-relay-network-exposure-safety",
  ],
  status: "missing",
};

const relayReadinessReceipt = (input: {
  readonly rawPathsReturned: boolean;
}) => ({
  adapter: {
    port: "TrustedLocalDreamMemoryFabricPort",
    sourceRoots: [
      {
        derivedIndexCount: 1,
        family: "agent-transcripts",
        includeExtensionCount: 1,
        privacyTier: "private",
        runtime: "codex",
        sourceId: "source:codex-transcripts",
      },
    ],
  },
  auth: {
    mode: "bearer",
    required: true,
  },
  checkedAt: "2026-06-09T10:00:00.000Z",
  endpointCatalog: dreamMemoryRelayEndpointCatalog,
  maxFilesPerSource: 100,
  rawCredentialsReturned: false,
  rawPathsReturned: input.rawPathsReturned,
  redacted: true,
  schemaVersion: "trusted.dream-memory-relay.readiness.v1",
  supportedOperations: [
    "inventory",
    "source-health",
    "backfill-plan",
    "backfill-run",
    "capture-run",
    "capture-artifact",
    "signals",
    "search",
    "hydrate",
    "correlate",
  ],
});

describe("Dream live preflight", () => {
  it("parses package ids from Wrangler D1 output", () => {
    const output = `
Wrangler 4.97.0
[
  {
    "results": [
      {
        "artifact_ref": "artifact://cloudflare-artifacts/pkg-badass-courses-claw-kernel/package.json",
        "manifest_hash": "${"a".repeat(64)}",
        "package_id": "badass-courses/claw-kernel"
      },
      {
        "artifact_ref": "artifact://cloudflare-artifacts/pkg-workflow-dream-memory-fabric/package.json",
        "manifest_hash": "${"b".repeat(64)}",
        "package_id": "workflow/dream-memory-fabric"
      }
    ],
    "success": true
  }
]`;

    expect(extractPackageIdsFromD1Output(output)).toStrictEqual([
      "badass-courses/claw-kernel",
      "workflow/dream-memory-fabric",
    ]);
    expect(extractPackageRowsFromD1Output(output).at(1)).toStrictEqual({
      artifactRef:
        "artifact://cloudflare-artifacts/pkg-workflow-dream-memory-fabric/package.json",
      manifestHash: "b".repeat(64),
      packageId: "workflow/dream-memory-fabric",
    });
  });

  it("parses remote Worker secret names without secret values", () => {
    const output = `
[
  {"name": "PI_AUTH_JSON_B64", "type": "secret_text"},
  {"name": "WZRRD_API_TOKEN", "type": "secret_text"}
]`;

    expect(extractSecretNamesFromWranglerOutput(output)).toStrictEqual([
      "PI_AUTH_JSON_B64",
      "WZRRD_API_TOKEN",
    ]);
  });

  it("blocks Dream live readiness when Cloudflare package or relay gates are missing", () => {
    const receipt = buildDreamLivePreflightReceipt({
      deployScriptText: "",
      env: {},
      generatedAt: "2026-06-09T10:00:00.000Z",
      localRelayProofCheck: localRelayProofMissing,
      relayReadinessCheck: relayReadinessMissing,
      remoteRegistry: queriedRemoteRegistry,
      remoteSecrets: emptyRemoteSecrets,
      workerUrl:
        "https://pi-cloudflare-sandbox-workflows.joelhooks.workers.dev",
      wranglerConfigText: "",
    });

    expect({
      actionCount: receipt.requiredActions.length,
      missingAdmin: receipt.checks.some(
        (check) =>
          check.checkId === "env:WORKFLOW_APP_ADMIN_TOKEN" &&
          check.status === "missing"
      ),
      relayCapability: {
        capability: receipt.relayCapability.capability,
        endpointConfigured:
          receipt.relayCapability.readiness.endpointConfigured,
        healthzStatus: receipt.relayCapability.readiness.healthzStatus,
        leaseSecretRef: receipt.relayCapability.lease.secretRef,
        localProofStatus: receipt.relayCapability.readiness.localProofStatus,
        noRawTranscripts:
          receipt.relayCapability.redactionPolicy.noRawTranscripts,
        operationCount: receipt.relayCapability.allowedOperations.length,
        tokenConfigured: receipt.relayCapability.readiness.tokenConfigured,
      },
      remoteSeeded: receipt.remoteRegistry.expectedPackageSeeded,
      status: receipt.status,
    }).toStrictEqual({
      actionCount: 11,
      missingAdmin: true,
      relayCapability: {
        capability: "dream.memory.relay",
        endpointConfigured: false,
        healthzStatus: "missing",
        leaseSecretRef: "secretref:dream-memory-relay",
        localProofStatus: "missing",
        noRawTranscripts: true,
        operationCount: 10,
        tokenConfigured: false,
      },
      remoteSeeded: false,
      status: "blocked",
    });
  });

  it("marks Dream live readiness only when the cartridge artifact and leases are proven", () => {
    const receipt = buildDreamLivePreflightReceipt({
      deployScriptText: deployScriptWithDreamRelayToken,
      env: completeEnv,
      generatedAt: "2026-06-09T10:00:00.000Z",
      localRelayProofCheck: localRelayProofPassed,
      relayReadinessCheck: relayReadinessPassed,
      remoteRegistry: seededRemoteRegistry,
      remoteSecrets: completeRemoteSecrets,
      workerUrl:
        "https://pi-cloudflare-sandbox-workflows.joelhooks.workers.dev",
      wranglerConfigText: wranglerWithDreamRelay,
    });
    const serialized = JSON.stringify(receipt);

    expect({
      leakedAdminSecret: serialized.includes("admin-secret"),
      leakedPiSecret: serialized.includes("pi-secret"),
      leakedRelaySecret: serialized.includes("relay-secret"),
      leakedWzrrdSecret: serialized.includes("wzrrd-secret"),
      relayCapability: {
        allowedOperations: receipt.relayCapability.allowedOperations,
        allowedSourceFamilies: receipt.relayCapability.allowedSourceFamilies,
        healthzStatus: receipt.relayCapability.readiness.healthzStatus,
        idempotencyKeyPrefix: receipt.relayCapability.idempotencyKeyPrefix,
        secretBindingName: receipt.relayCapability.lease.secretBindingName,
        tokenConfigured: receipt.relayCapability.readiness.tokenConfigured,
        traceCapability: receipt.relayCapability.traceCapability,
      },
      requiredActions: receipt.requiredActions,
      requiredGeneratedArtifacts:
        receipt.artifactModel.generatedArtifactsRequired,
      status: receipt.status,
    }).toStrictEqual({
      leakedAdminSecret: false,
      leakedPiSecret: false,
      leakedRelaySecret: false,
      leakedWzrrdSecret: false,
      relayCapability: {
        allowedOperations: [
          "inventory",
          "source-health",
          "backfill-plan",
          "backfill-run",
          "capture-run",
          "capture-artifact",
          "signals",
          "search",
          "hydrate",
          "correlate",
        ],
        allowedSourceFamilies: [
          "agent-transcripts",
          "brain",
          "cloudflare-runs",
          "docs-pdf-brain",
          "repo-outputs",
        ],
        healthzStatus: "passed",
        idempotencyKeyPrefix: "dream-memory-relay",
        secretBindingName: "DREAM_MEMORY_RELAY_TOKEN",
        tokenConfigured: true,
        traceCapability: "dream.memory.relay",
      },
      requiredActions: [],
      requiredGeneratedArtifacts: [
        "planner prompt/transcript",
        "workflow.xstate-machine.v1 config artifact",
        "generated TypeScript harness source",
        "machine/harness hashes",
        "dream.refinement-proposals.v1 proposal artifact",
        "dream.hitl-report.v1 MDSvX report artifact",
        "dream.hitl-decision.v1 decision contract artifact",
        "dream.hitl-decision-workflow-seed.v1 seed artifact",
        "dream.hitl-follow-up-run-request.v1 draft artifact",
        "workflow.execution-proof.v1 Cloudflare execution proof",
        "workflow.cartridge-invocation-proof.v1 per-node proofs",
        "wzrrd.site.publish capability receipt for the Dream report",
      ],
      status: "ready",
    });
  });

  it("accepts signoff-gated deploy-time relay URL injection without hardcoding the URL into wrangler", () => {
    const receipt = buildDreamLivePreflightReceipt({
      deployScriptText: deployScriptWithSignoffGatedDreamRelayConfig,
      env: completeEnv,
      generatedAt: "2026-06-09T10:00:00.000Z",
      localRelayProofCheck: localRelayProofPassed,
      relayReadinessCheck: relayReadinessPassed,
      remoteRegistry: seededRemoteRegistry,
      remoteSecrets: completeRemoteSecrets,
      workerUrl:
        "https://pi-cloudflare-sandbox-workflows.joelhooks.workers.dev",
      wranglerConfigText: "",
    });
    const relayConfigCheck = receipt.checks.find(
      (check) => check.checkId === "wrangler:DREAM_MEMORY_RELAY_BASE_URL"
    );

    expect({
      leakedRelaySecret: JSON.stringify(receipt).includes("relay-secret"),
      relayConfigMessage: relayConfigCheck?.message,
      relayConfigStatus: relayConfigCheck?.status,
      status: receipt.status,
      workerBaseUrlConfigured:
        receipt.relayCapability.readiness.workerBaseUrlConfigured,
    }).toStrictEqual({
      leakedRelaySecret: false,
      relayConfigMessage:
        "Worker deploy config or signoff-gated deploy-time injection defines DREAM_MEMORY_RELAY_BASE_URL.",
      relayConfigStatus: "passed",
      status: "ready",
      workerBaseUrlConfigured: true,
    });
  });

  it("blocks Dream live readiness when the remote package manifest is stale", () => {
    const receipt = buildDreamLivePreflightReceipt({
      deployScriptText: deployScriptWithDreamRelayToken,
      env: completeEnv,
      generatedAt: "2026-06-09T10:00:00.000Z",
      localRelayProofCheck: localRelayProofPassed,
      relayReadinessCheck: relayReadinessPassed,
      remoteRegistry: {
        ...seededRemoteRegistry,
        expectedPackageManifestHashMatched: false,
      },
      remoteSecrets: completeRemoteSecrets,
      workerUrl:
        "https://pi-cloudflare-sandbox-workflows.joelhooks.workers.dev",
      wranglerConfigText: wranglerWithDreamRelay,
    });

    expect({
      requiredAction: receipt.requiredActions.at(0),
      status: receipt.status,
    }).toStrictEqual({
      requiredAction:
        "Re-seed workflow/dream-memory-fabric so the remote artifact ref and manifest hash match the current Dream cartridge manifest, including joelclaw.dream.source-inventory, joelclaw.dream.source-health, joelclaw.dream.backfill-plan, joelclaw.dream.backfill-run, joelclaw.dream.capture-run, joelclaw.dream.capture-artifact, joelclaw.dream.memory-search, joelclaw.dream.signals, joelclaw.dream.hydrate, joelclaw.dream.correlate, joelclaw.dream.refinement-proposals, joelclaw.dream.hitl-report, joelclaw.dream.hitl-decision-seed, joelclaw.dream.hitl-follow-up-run-request, dream-hitl-decision-schema.",
      status: "blocked",
    });
  });

  it("checks the trusted relay healthz receipt without leaking the relay token", async () => {
    let authorizationHeader: null | string = null;
    const fetcher: typeof fetch = (_input, init) => {
      authorizationHeader = new Headers(init?.headers).get("authorization");

      return Promise.resolve(
        Response.json(relayReadinessReceipt({ rawPathsReturned: false }))
      );
    };
    const check = await checkDreamRelayReadiness({
      env: completeEnv,
      fetch: fetcher,
    });

    expect({
      authorizationHeader,
      leakedRelaySecret: JSON.stringify(check).includes("relay-secret"),
      status: check.status,
    }).toStrictEqual({
      authorizationHeader: "Bearer relay-secret",
      leakedRelaySecret: false,
      status: "passed",
    });
  });

  it("requires a redacted local relay proof before live readiness", async () => {
    const proofRoot = await mkdtemp(
      resolve(tmpdir(), "dream-local-relay-proof-")
    );
    const proofPath = resolve(proofRoot, "proof.json");
    const validProof = {
      backfill: {
        actionCount: 9,
        captureFixCount: 0,
        status: "backfill-required",
      },
      backfillRun: {
        blockedCount: 0,
        completedCount: 0,
        failedCount: 0,
        skippedCount: 9,
      },
      checkedAt: "2026-06-09T10:00:00.000Z",
      correlation: {
        edgeCount: 24,
        nodeCount: 40,
      },
      health: {
        blindSpotCount: 1,
        degradedSourceCount: 1,
        status: "degraded",
      },
      inventory: {
        machineCoverage: [
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
        ],
        runtimeCoverage: [
          { count: 10, runtime: "pi", status: "captured" },
          { count: 8, runtime: "codex", status: "captured" },
          { count: 3, runtime: "claude", status: "captured" },
          { count: 4, runtime: "cloudflare", status: "captured" },
        ],
        sourceCount: 8,
        sourceFamilyCoverage: [
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
        ],
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
        skippedSourceCount: 0,
      },
      signals: {
        receiptFamilyCounts: [{ family: "agent-transcripts", receiptCount: 3 }],
        signalCount: 3,
        signalKinds: ["workflow-pattern"],
      },
      sourceRootCount: 8,
    };

    try {
      await writeFile(proofPath, JSON.stringify(validProof), "utf-8");
      const passed = await checkLocalRelayProof(proofPath);
      await writeFile(
        proofPath,
        JSON.stringify({
          ...validProof,
          backfill: {
            ...validProof.backfill,
            captureFixCount: 1,
          },
        }),
        "utf-8"
      );
      const captureFixMismatch = await checkLocalRelayProof(proofPath);
      await writeFile(
        proofPath,
        JSON.stringify({
          ...validProof,
          backfill: {
            ...validProof.backfill,
            captureFixCount: 1,
          },
          backfillRun: {
            ...validProof.backfillRun,
            captureFixBlockedCount: 1,
          },
        }),
        "utf-8"
      );
      const passedWithCaptureFix = await checkLocalRelayProof(proofPath);
      await writeFile(
        proofPath,
        JSON.stringify({
          ...validProof,
          inventory: {
            ...validProof.inventory,
            runtimeCoverage: [{ count: 10, runtime: "pi", status: "captured" }],
          },
        }),
        "utf-8"
      );
      const missingCoverage = await checkLocalRelayProof(proofPath);
      await writeFile(
        proofPath,
        JSON.stringify({
          ...validProof,
          inventory: {
            ...validProof.inventory,
            machineCoverage: validProof.inventory.machineCoverage.filter(
              (coverage) =>
                coverage.machineId !== "panda" && coverage.machineId !== "flagg"
            ),
          },
        }),
        "utf-8"
      );
      const missingMachineCoverage = await checkLocalRelayProof(proofPath);
      await writeFile(
        proofPath,
        JSON.stringify({
          ...validProof,
          inventory: {
            ...validProof.inventory,
            sourceFamilyCoverage:
              validProof.inventory.sourceFamilyCoverage.filter(
                (coverage) => coverage.family !== "docs-pdf-brain"
              ),
          },
        }),
        "utf-8"
      );
      const missingSourceFamilyCoverage = await checkLocalRelayProof(proofPath);

      expect({
        captureFixMismatchMessage: captureFixMismatch.message,
        captureFixMismatchStatus: captureFixMismatch.status,
        missingCoverageMessage: missingCoverage.message,
        missingCoverageStatus: missingCoverage.status,
        missingMachineCoverageMessage: missingMachineCoverage.message,
        missingMachineCoverageStatus: missingMachineCoverage.status,
        missingSourceFamilyCoverageMessage: missingSourceFamilyCoverage.message,
        missingSourceFamilyCoverageStatus: missingSourceFamilyCoverage.status,
        passedMessage: passed.message,
        passedStatus: passed.status,
        passedWithCaptureFixMessage: passedWithCaptureFix.message,
        passedWithCaptureFixStatus: passedWithCaptureFix.status,
      }).toStrictEqual({
        captureFixMismatchMessage:
          "Trusted local Dream relay proof capture-fix receipt does not match the planned capture-fix count.",
        captureFixMismatchStatus: "failed",
        missingCoverageMessage:
          "Trusted local Dream relay proof is missing captured native runtime coverage for: codex, claude, cloudflare.",
        missingCoverageStatus: "failed",
        missingMachineCoverageMessage:
          "Trusted local Dream relay proof is missing required machine coverage for: panda, flagg.",
        missingMachineCoverageStatus: "failed",
        missingSourceFamilyCoverageMessage:
          "Trusted local Dream relay proof is missing explicit source-family coverage for: docs-pdf-brain.",
        missingSourceFamilyCoverageStatus: "failed",
        passedMessage:
          "Trusted local Dream relay proof passed with 8 source roots, 9 backfill action receipt(s), 0 capture-fix receipt(s), 3 signal receipt(s), 12 search hits, 12 hydrated redacted receipts, and 24 correlation edges.",
        passedStatus: "passed",
        passedWithCaptureFixMessage:
          "Trusted local Dream relay proof passed with 8 source roots, 9 backfill action receipt(s), 1 capture-fix receipt(s), 3 signal receipt(s), 12 search hits, 12 hydrated redacted receipts, and 24 correlation edges.",
        passedWithCaptureFixStatus: "passed",
      });
    } finally {
      await rm(proofRoot, { force: true, recursive: true });
    }
  });

  it("blocks relay readiness when healthz is missing or returns unsafe readiness", async () => {
    const unsafeFetcher: typeof fetch = () =>
      Promise.resolve(
        Response.json(relayReadinessReceipt({ rawPathsReturned: true }))
      );
    const missing = await checkDreamRelayReadiness({
      env: {},
    });
    const unsafe = await checkDreamRelayReadiness({
      env: completeEnv,
      fetch: unsafeFetcher,
    });

    expect({
      missingStatus: missing.status,
      missingTokenLeak: JSON.stringify(missing).includes("relay-secret"),
      unsafeMessage: unsafe.message,
      unsafeStatus: unsafe.status,
    }).toStrictEqual({
      missingStatus: "missing",
      missingTokenLeak: false,
      unsafeMessage:
        "Dream memory relay /healthz returned an invalid redacted readiness receipt.",
      unsafeStatus: "failed",
    });
  });

  it("writes a blocked receipt instead of faking readiness when remote proof is skipped", async () => {
    const repoRoot = await mkdtemp(resolve(tmpdir(), "dream-preflight-"));

    try {
      await mkdir(resolve(repoRoot, "scripts"), { recursive: true });
      await writeFile(resolve(repoRoot, ".env.local"), "", "utf-8");
      await writeFile(resolve(repoRoot, "wrangler.jsonc"), "{}", "utf-8");
      await writeFile(
        resolve(repoRoot, "scripts/workflow-app-deploy-and-seed.mjs"),
        "",
        "utf-8"
      );
      const receiptPath = "receipts/dream-preflight.json";
      await runDreamPreflightCli({
        argv: [
          "--allow-missing",
          "--skip-remote",
          `--receipt-path=${receiptPath}`,
        ],
        log: () => {},
        processEnv: {},
        repoRoot,
      });
      const parsed: unknown = JSON.parse(
        await readFile(resolve(repoRoot, receiptPath), "utf-8")
      );
      const written = WorkflowLivePreflightReceiptSchema.parse(parsed);

      expect({
        remoteSecretStatus: written.remoteSecrets.status,
        remoteStatus: written.remoteRegistry.status,
        schemaVersion: written.schemaVersion,
        status: written.status,
      }).toStrictEqual({
        remoteSecretStatus: "skipped",
        remoteStatus: "skipped",
        schemaVersion: "workflow.live-preflight.v1",
        status: "blocked",
      });
    } finally {
      await rm(repoRoot, { force: true, recursive: true });
    }
  });
});
