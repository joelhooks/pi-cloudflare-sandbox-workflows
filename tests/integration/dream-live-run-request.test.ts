import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  buildWorkflowLiveRunRequest,
  buildWorkflowLiveRunRequestReceipt,
  runWorkflowLiveRunCli,
} from "../../scripts/workflow-app-run.ts";
import {
  WorkflowLiveRunRequestReceiptSchema,
  WorkflowLivePreflightReceiptSchema,
  WorkflowRunRequestSchema,
} from "../../src/app/domain/schemas.ts";
import type { WorkflowLivePreflightReceipt } from "../../src/app/domain/schemas.ts";
import { dreamTranscriptReviewSourceProfile } from "../../src/cartridges/memory-fabric/source-profile.ts";
import { workflowCliTestRepoRoot } from "./workflow-app-fixtures.ts";

const profileArgs = [
  "--profile",
  dreamTranscriptReviewSourceProfile.profileId,
] as const;

const relayNetworkBoundarySignoff =
  "exposing JoelClaw/Typesense over a new network boundary";

const readyRelayCapability = {
  allowedOperations: [
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
  budget: {
    maxFiles: 500,
    maxRows: 1000,
    maxTokens: 100_000,
  },
  capability: "memory.relay",
  idempotencyKeyPrefix: "memory-relay",
  lease: {
    required: true,
    secretBindingName: "MEMORY_RELAY_TOKEN",
    secretRef: "secretref:memory-relay",
  },
  readiness: {
    endpointConfigured: true,
    healthzStatus: "passed",
    localProofStatus: "passed",
    tokenConfigured: true,
    workerBaseUrlConfigured: true,
  },
  redacted: true,
  redactionPolicy: {
    mode: "redacted-evidence",
    noCustomerDataInPublicArtifacts: true,
    noRawCredentials: true,
    noRawPrivatePaths: true,
    noRawTranscripts: true,
  },
  relayReceiptsRequired: true,
  traceCapability: "memory.relay",
} as const;

const readyPreflight = WorkflowLivePreflightReceiptSchema.parse({
  artifactModel: {
    cartridgeKind: "artifact-backed-workflow-cartridge",
    dynamicWorkflowRequiresGeneratedMachine: true,
    generatedArtifactsRequired: [
      "planner prompt/transcript",
      "workflow.xstate-machine.v1 config artifact",
      "generated TypeScript harness source",
      "machine/harness hashes",
      "memory.refinement-proposals.v1 proposal artifact",
      "workflow.hitl-report.v1 MDSvX report artifact",
      "memory.hitl-decision.v1 decision contract artifact",
      "memory.hitl-decision-workflow-seed.v1 seed artifact",
      "memory.hitl-follow-up-run-request.v1 draft artifact",
      "workflow.execution-proof.v1 Cloudflare execution proof",
      "workflow.cartridge-invocation-proof.v1 per-node proofs",
      "wzrrd.site.publish capability receipt for the HITL report",
    ],
    sideEffectsRequireCapabilityLeases: true,
  },
  checks: [
    {
      checkId: "env:MEMORY_RELAY_BASE_URL",
      message: "Relay URL configured.",
      redacted: true,
      required: true,
      requiredFor: ["memory-relay-binding"],
      status: "present",
    },
    {
      checkId: "env:MEMORY_RELAY_TOKEN",
      message: "Relay token configured.",
      redacted: true,
      required: true,
      requiredFor: ["memory-relay-lease"],
      status: "present",
    },
    {
      checkId: "wrangler:MEMORY_RELAY_BASE_URL",
      message: "Worker deploy config defines relay URL.",
      redacted: true,
      required: true,
      requiredFor: ["memory-relay-binding"],
      status: "passed",
    },
    {
      checkId: "relay:healthz",
      message: "Relay healthz passed.",
      redacted: true,
      required: true,
      requiredFor: ["memory-relay-readiness"],
      status: "passed",
    },
    {
      checkId: "relay:local-proof",
      message: "Local relay proof passed.",
      redacted: true,
      required: true,
      requiredFor: ["memory-relay-local-proof"],
      status: "passed",
    },
  ],
  expectedCartridgePackageId: "workflow/memory-fabric",
  generatedAt: "2026-06-09T22:45:00.000Z",
  redacted: true,
  relayCapability: readyRelayCapability,
  remoteRegistry: {
    command: ["pnpm", "exec", "wrangler", "d1", "execute"],
    expectedPackageArtifactRef:
      "artifact://cloudflare-artifacts/pkg-workflow-memory-fabric/package.json",
    expectedPackageArtifactRefMatched: true,
    expectedPackageId: "workflow/memory-fabric",
    expectedPackageManifestHash:
      "b36403a390d8a5f117d7ce302c0dff0579064e925999ef8767cf6680a3c0df1b",
    expectedPackageManifestHashMatched: true,
    expectedPackageSeeded: true,
    expectedWorkflowNodeTypes: [
      "joelclaw.memory.capture-run",
      "joelclaw.memory.capture-artifact",
      "joelclaw.memory.search",
      "joelclaw.memory.signals",
      "joelclaw.memory.hydrate",
      "joelclaw.memory.correlate",
      "joelclaw.memory.refinement-proposals",
      "joelclaw.memory.hitl-report",
      "joelclaw.memory.hitl-decision-seed",
      "joelclaw.memory.hitl-follow-up-run-request",
    ],
    packageIds: ["workflow/memory-fabric"],
    packageRows: [],
    redacted: true,
    status: "queried",
  },
  remoteSecrets: {
    command: ["pnpm", "exec", "wrangler", "secret", "list"],
    redacted: true,
    secretNames: [
      "MEMORY_RELAY_TOKEN",
      "PI_AUTH_JSON_B64",
      "WORKFLOW_APP_ADMIN_TOKEN",
      "WORKFLOW_APP_MODEL",
      "WZRRD_API_TOKEN",
    ],
    status: "queried",
  },
  requiredActions: [],
  schemaVersion: "workflow.live-preflight.v1",
  status: "ready",
  workerUrl: "https://worker.example.test",
  workflowId: "dream.memory-fabric",
});

const blockedPreflight = WorkflowLivePreflightReceiptSchema.parse({
  ...readyPreflight,
  checks: readyPreflight.checks.map((check) =>
    check.checkId === "relay:healthz"
      ? {
          ...check,
          message: "Relay healthz missing.",
          status: "missing" as const,
        }
      : check
  ),
  relayCapability: {
    ...readyRelayCapability,
    readiness: {
      ...readyRelayCapability.readiness,
      healthzStatus: "missing",
    },
  },
  requiredActions: [
    "Start or provision the trusted Memory relay and verify its authenticated /healthz readiness receipt.",
  ],
  status: "blocked",
});

const writePreflight = async (
  repoRoot: string,
  receipt: WorkflowLivePreflightReceipt
) => {
  await writeFile(
    resolve(repoRoot, "preflight.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
    "utf-8"
  );
};

const PostedResponseSchema = z.object({
  runId: z.string().min(1),
  status: z.literal("captured"),
});

describe("Dream live run request harness", () => {
  it("builds a typed request that asks for generated Cloudflare Dreaming through the cartridge", () => {
    const request = buildWorkflowLiveRunRequest({
      profile: dreamTranscriptReviewSourceProfile,
      runId: "run-live-memory-fabric-test",
    });

    expect({
      actorRoles: request.actor.roleIds,
      intentMentionsCloudflare: request.planProposal.intent.includes(
        "Cloudflare-generated dynamic workflow"
      ),
      intentMentionsSignalMining: request.planProposal.intent.includes(
        "mine redacted correction/friction/decision/workflow signals"
      ),
      noRelayTokenLeak: !JSON.stringify(request).includes("relay-secret"),
      packages: request.planProposal.requestedPackageIds,
      stochasticNotesAllowGeneratedRuntimeShape:
        request.planProposal.stochasticNotes.some((note) =>
          note.includes(
            "The planner may choose order, branching, loops, parallelism, and Think lanes"
          )
        ),
      stochasticNotesDoNotHardcodeNodeOrder:
        !request.planProposal.stochasticNotes.some((note) =>
          note.includes("Required Dream node order")
        ),
      stochasticNotesMentionWzrrdPrimaryDocument:
        request.planProposal.stochasticNotes.some((note) =>
          note.includes("dream/hitl-report.mdsvx")
        ),
      stochasticNotesRequireFullHitlRefinementLoop:
        request.planProposal.stochasticNotes.some(
          (note) =>
            note.includes("HITL decision seed") &&
            note.includes("HITL follow-up run request")
        ) &&
        request.planProposal.stochasticNotes.some(
          (note) =>
            note.includes("memory.hitl-decision-workflow-seed.v1") &&
            note.includes("memory.hitl-follow-up-run-request.v1") &&
            note.includes("submitted:false")
        ),
      stochasticNotesRequireSignalMining:
        request.planProposal.stochasticNotes.some((note) =>
          note.includes("signal mining")
        ),
      workItemId: request.workItemId,
    }).toStrictEqual({
      actorRoles: ["workflow.operator", "wzrrd.publish"],
      intentMentionsCloudflare: true,
      intentMentionsSignalMining: true,
      noRelayTokenLeak: true,
      packages: [
        "badass-courses/claw-kernel",
        "joelhooks/configured-familiar-kernel",
        "workflow/memory-fabric",
      ],
      stochasticNotesAllowGeneratedRuntimeShape: true,
      stochasticNotesDoNotHardcodeNodeOrder: true,
      stochasticNotesMentionWzrrdPrimaryDocument: true,
      stochasticNotesRequireFullHitlRefinementLoop: true,
      stochasticNotesRequireSignalMining: true,
      workItemId: "work-item:memory-fabric",
    });
  });

  it("blocks submission when the live preflight is not ready", () => {
    const request = buildWorkflowLiveRunRequest({
      profile: dreamTranscriptReviewSourceProfile,
      runId: "run-live-memory-fabric-blocked",
    });
    const receipt = buildWorkflowLiveRunRequestReceipt({
      checkedAt: "2026-06-09T22:45:00.000Z",
      preflight: {
        receipt: blockedPreflight,
        requiredActions: blockedPreflight.requiredActions,
        status: blockedPreflight.status,
      },
      preflightPath: "preflight.json",
      preflightRefreshed: false,
      request,
      requestPath: "request.json",
      submitAttempted: false,
      workerUrl: "https://worker.example.test",
    });

    expect({
      blockedReasons: receipt.blockedReasons,
      relayCapability: receipt.relayCapability,
      status: receipt.status,
      submitAttempted: receipt.submit.attempted,
    }).toStrictEqual({
      blockedReasons: blockedPreflight.requiredActions,
      relayCapability: blockedPreflight.relayCapability,
      status: "blocked",
      submitAttempted: false,
    });
  });

  it("writes request and receipt but refuses --submit while preflight is blocked", async () => {
    const repoRoot = await workflowCliTestRepoRoot("dream-live-run-blocked-");

    try {
      await writePreflight(repoRoot, blockedPreflight);
      let fetchCalled = false;

      const receipt = await runWorkflowLiveRunCli({
        argv: [
          ...profileArgs,
          "--submit",
          "--run-id",
          "run-live-memory-fabric-blocked",
          "--preflight-path",
          "preflight.json",
          "--request-path",
          "request.json",
          "--receipt-path",
          "receipt.json",
          "--skip-preflight-refresh",
        ],
        fetch() {
          fetchCalled = true;

          return Promise.resolve(Response.json({ ok: true }));
        },
        log() {},
        processEnv: {},
        repoRoot,
      });
      const request = WorkflowRunRequestSchema.parse(
        JSON.parse(await readFile(resolve(repoRoot, "request.json"), "utf-8"))
      );
      const writtenReceipt = WorkflowLiveRunRequestReceiptSchema.parse(
        JSON.parse(await readFile(resolve(repoRoot, "receipt.json"), "utf-8"))
      );

      expect({
        fetchCalled,
        requestRunId: request.runId,
        returnedStatus: receipt.status,
        writtenStatus: writtenReceipt.status,
      }).toStrictEqual({
        fetchCalled: false,
        requestRunId: "run-live-memory-fabric-blocked",
        returnedStatus: "blocked",
        writtenStatus: "blocked",
      });
    } finally {
      await rm(repoRoot, { force: true, recursive: true });
    }
  });

  it("refuses live submit when preflight is ready but relay boundary sign-off is missing", async () => {
    const repoRoot = await workflowCliTestRepoRoot(
      "dream-live-run-missing-signoff-"
    );

    try {
      await writePreflight(repoRoot, readyPreflight);
      let fetchCalled = false;

      const receipt = await runWorkflowLiveRunCli({
        argv: [
          ...profileArgs,
          "--submit",
          "--run-id",
          "run-live-memory-fabric-ready-no-signoff",
          "--preflight-path",
          "preflight.json",
          "--request-path",
          "request.json",
          "--receipt-path",
          "receipt.json",
          "--skip-preflight-refresh",
        ],
        fetch() {
          fetchCalled = true;

          return Promise.resolve(Response.json({ ok: true }));
        },
        log() {},
        processEnv: {},
        repoRoot,
      });

      expect({
        blockedReasons: receipt.blockedReasons,
        fetchCalled,
        status: receipt.status,
        submitAttempted: receipt.submit.attempted,
      }).toStrictEqual({
        blockedReasons: [
          "Provide the exact owner sign-off phrase before submitting a live workflow run that uses the trusted memory relay network boundary.",
        ],
        fetchCalled: false,
        status: "blocked",
        submitAttempted: false,
      });
    } finally {
      await rm(repoRoot, { force: true, recursive: true });
    }
  });

  it("submits the typed request only after preflight is ready and relay boundary sign-off is present", async () => {
    const repoRoot = await workflowCliTestRepoRoot("dream-live-run-ready-");

    try {
      await writePreflight(repoRoot, readyPreflight);
      let postedRequest: unknown;

      const receipt = await runWorkflowLiveRunCli({
        argv: [
          ...profileArgs,
          "--submit",
          "--run-id",
          "run-live-memory-fabric-ready",
          "--preflight-path",
          "preflight.json",
          "--request-path",
          "request.json",
          "--receipt-path",
          "receipt.json",
          "--response-path",
          "response.json",
          "--approval-signoff",
          relayNetworkBoundarySignoff,
          "--skip-preflight-refresh",
        ],
        fetch(_url, init) {
          if (typeof init?.body !== "string") {
            throw new TypeError("Expected request body to be JSON text.");
          }

          postedRequest = JSON.parse(init.body);

          return Promise.resolve(
            Response.json({
              runId: "run-live-memory-fabric-ready",
              status: "captured",
            })
          );
        },
        log() {},
        processEnv: {},
        repoRoot,
      });
      const parsedPostedRequest = WorkflowRunRequestSchema.parse(postedRequest);
      const response = PostedResponseSchema.parse(
        JSON.parse(await readFile(resolve(repoRoot, "response.json"), "utf-8"))
      );

      expect({
        noRelayTokenLeak: !JSON.stringify(receipt).includes("relay-secret"),
        postedRunId: parsedPostedRequest.runId,
        relayCapability: receipt.relayCapability,
        responseStatus: response.status,
        status: receipt.status,
        submitAttempted: receipt.submit.attempted,
        submitUrl: receipt.submit.url,
      }).toStrictEqual({
        noRelayTokenLeak: true,
        postedRunId: "run-live-memory-fabric-ready",
        relayCapability: readyRelayCapability,
        responseStatus: "captured",
        status: "submitted",
        submitAttempted: true,
        submitUrl: "https://worker.example.test/runs",
      });
    } finally {
      await rm(repoRoot, { force: true, recursive: true });
    }
  });

  it("refreshes preflight before --submit so stale receipts cannot submit", async () => {
    const repoRoot = await workflowCliTestRepoRoot("dream-live-run-fresh-");

    try {
      await writePreflight(repoRoot, readyPreflight);
      let fetchCalled = false;
      let preflightCalled = false;

      const receipt = await runWorkflowLiveRunCli({
        argv: [
          ...profileArgs,
          "--submit",
          "--run-id",
          "run-live-memory-fabric-refresh-blocked",
          "--preflight-path",
          "preflight.json",
          "--request-path",
          "request.json",
          "--receipt-path",
          "receipt.json",
          "--approval-signoff",
          relayNetworkBoundarySignoff,
        ],
        fetch() {
          fetchCalled = true;

          return Promise.resolve(Response.json({ ok: true }));
        },
        log() {},
        processEnv: {},
        repoRoot,
        runPreflight(input) {
          preflightCalled = true;
          expect(input.argv).toContain("--allow-missing");
          expect(input.argv).toContain("--receipt-path=preflight.json");
          expect(input.argv).toContain(
            dreamTranscriptReviewSourceProfile.profileId
          );

          return Promise.resolve(blockedPreflight);
        },
      });
      const writtenReceipt = WorkflowLiveRunRequestReceiptSchema.parse(
        JSON.parse(await readFile(resolve(repoRoot, "receipt.json"), "utf-8"))
      );

      expect({
        fetchCalled,
        preflightCalled,
        refreshed: writtenReceipt.preflight.refreshed,
        returnedStatus: receipt.status,
        staleReadyIgnored: writtenReceipt.blockedReasons,
        writtenStatus: writtenReceipt.status,
      }).toStrictEqual({
        fetchCalled: false,
        preflightCalled: true,
        refreshed: true,
        returnedStatus: "blocked",
        staleReadyIgnored: blockedPreflight.requiredActions,
        writtenStatus: "blocked",
      });
    } finally {
      await rm(repoRoot, { force: true, recursive: true });
    }
  });
});
