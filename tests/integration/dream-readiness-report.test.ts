import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { runWorkflowReadinessReportCli } from "../../scripts/workflow-app-readiness-report.ts";
import { buildWorkflowLiveRunRequest } from "../../scripts/workflow-app-run.ts";
import {
  WorkflowLiveRunRequestReceiptSchema,
  WorkflowLivePreflightReceiptSchema,
} from "../../src/app/domain/schemas.ts";
import { dreamTranscriptReviewSourceProfile } from "../../src/cartridges/memory-fabric/source-profile.ts";
import { workflowCliTestRepoRoot } from "./workflow-app-fixtures.ts";

const profileArgs = [
  "--profile",
  dreamTranscriptReviewSourceProfile.profileId,
] as const;

const rawPrivatePath = "/private/tmp/do-not-publish-dream-path";
const rawRelayToken = "do-not-publish-dream-relay-token";
const rawRelayUrl = "https://private-relay.example.test";
const runId = "run-live-memory-fabric-report-test";

const WorkflowDefinitionOfDoneAuditSummarySchema = z.object({
  schemaVersion: z.literal("workflow.definition-of-done-audit.v1"),
  status: z.string().min(1),
  summary: z.object({
    blockedCount: z.number().int().min(0),
    capturedCount: z.number().int().min(0),
    missingCount: z.number().int().min(0),
    notProvenCount: z.number().int().min(0),
    totalCount: z.number().int().min(1),
  }),
});

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
};

const localProof = () => ({
  checkedAt: "2026-06-10T11:00:00.000Z",
  correlation: {
    edgeCount: 48,
    nodeCount: 35,
  },
  rawCredentialsReturned: false,
  rawPathLeaked: false,
  rawPathsReturned: false,
  redacted: true,
  runId: "run:memory-relay-local-proof:report-test",
  schemaVersion: "trusted.memory-relay.local-proof.v1",
  search: {
    hitCount: 12,
    hydratedCount: 12,
    skippedSourceCount: 1184,
  },
  signals: {
    signalCount: 8,
    signalKinds: ["agent-failure", "correction"],
  },
  sourceFamilyCoverage: [
    {
      family: "agent-transcripts",
      receiptCount: 5132,
      status: "captured",
    },
    {
      family: "brain",
      receiptCount: 19,
      status: "captured",
    },
    {
      family: "cloudflare-runs",
      receiptCount: 211,
      status: "captured",
    },
    {
      family: "docs-pdf-brain",
      receiptCount: 2,
      status: "captured",
    },
    {
      family: "repo-outputs",
      receiptCount: 13,
      status: "captured",
    },
  ],
  sourceRootCount: 10,
});

const preflight = () =>
  WorkflowLivePreflightReceiptSchema.parse({
    artifactModel: {
      cartridgeKind: "artifact-backed-workflow-cartridge",
      dynamicWorkflowRequiresGeneratedMachine: true,
      generatedArtifactsRequired: [
        "planner prompt/transcript",
        "workflow.xstate-machine.v1 config artifact",
        "generated TypeScript harness source",
        "machine/harness hashes",
        "workflow.hitl-report.v1 MDSvX report artifact",
      ],
      sideEffectsRequireCapabilityLeases: true,
    },
    checks: [
      {
        checkId: "env:MEMORY_RELAY_BASE_URL",
        message: "MEMORY_RELAY_BASE_URL is not configured.",
        redacted: true,
        required: true,
        requiredFor: ["memory-relay-binding"],
        status: "missing",
      },
      {
        checkId: "env:MEMORY_RELAY_TOKEN",
        message: "MEMORY_RELAY_TOKEN is not configured.",
        redacted: true,
        required: true,
        requiredFor: ["memory-relay-lease"],
        status: "missing",
      },
      {
        checkId: "relay:local-proof",
        message: "Trusted local Memory relay proof passed.",
        redacted: true,
        required: true,
        requiredFor: ["memory-relay-local-proof"],
        status: "passed",
      },
      {
        checkId: "relay:healthz",
        message: "Relay healthz missing.",
        redacted: true,
        required: true,
        requiredFor: ["memory-relay-readiness"],
        status: "missing",
      },
    ],
    expectedCartridgePackageId: "workflow/memory-fabric",
    generatedAt: "2026-06-10T11:00:10.000Z",
    redacted: true,
    relayCapability: {
      allowedOperations: ["search", "hydrate", "correlate"],
      allowedSourceFamilies: ["agent-transcripts", "brain", "cloudflare-runs"],
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
        endpointConfigured: false,
        healthzStatus: "missing",
        localProofStatus: "passed",
        tokenConfigured: false,
        workerBaseUrlConfigured: false,
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
    },
    remoteRegistry: {
      command: [],
      expectedPackageId: "workflow/memory-fabric",
      expectedPackageSeeded: true,
      packageIds: ["workflow/memory-fabric"],
      redacted: true,
      status: "queried",
    },
    remoteSecrets: {
      command: [],
      redacted: true,
      secretNames: ["PI_AUTH_JSON_B64", "WZRRD_API_TOKEN"],
      status: "queried",
    },
    requiredActions: [
      "Set MEMORY_RELAY_BASE_URL for the trusted memory relay endpoint.",
      "Provision MEMORY_RELAY_TOKEN as a Worker secret for the trusted memory relay.",
      "Start or provision the trusted Memory relay and verify its authenticated /healthz readiness receipt.",
    ],
    schemaVersion: "workflow.live-preflight.v1",
    status: "blocked",
    workerUrl: "https://pi-cloudflare-sandbox-workflows.example.test",
    workflowId: "dream.memory-fabric",
  });

const runReceipt = (input: { readonly submitAttempted: boolean }) =>
  WorkflowLiveRunRequestReceiptSchema.parse({
    blockedReasons: [
      "Set MEMORY_RELAY_BASE_URL for the trusted memory relay endpoint.",
      "Provision MEMORY_RELAY_TOKEN as a Worker secret for the trusted memory relay.",
      "Start or provision the trusted Memory relay and verify its authenticated /healthz readiness receipt.",
    ],
    checkedAt: "2026-06-10T11:00:20.000Z",
    preflight: {
      generatedAt: "2026-06-10T11:00:10.000Z",
      path: ".wrangler/workflow-app/dream-preflight/latest-dream-preflight.json",
      refreshed: true,
      requiredActions: [
        "Set MEMORY_RELAY_BASE_URL for the trusted memory relay endpoint.",
      ],
      status: "blocked",
    },
    redacted: true,
    relayCapability: preflight().relayCapability,
    request: buildWorkflowLiveRunRequest({
      profile: dreamTranscriptReviewSourceProfile,
      runId,
    }),
    requestPath: `.wrangler/workflow-app/dream-runs/${runId}-request.json`,
    runId,
    schemaVersion: "workflow.live-run-request.v1",
    status: "blocked",
    submit: {
      attempted: input.submitAttempted,
    },
    workerUrl: "https://pi-cloudflare-sandbox-workflows.example.test",
  });

describe("Dream readiness report", () => {
  it("renders a Tufte MDSvX/static report from redacted blocked Dream receipts", async () => {
    const repoRoot = await workflowCliTestRepoRoot("dream-readiness-report-");
    const localProofPath = resolve(repoRoot, "proof.json");
    const preflightPath = resolve(repoRoot, "preflight.json");
    const runReceiptPath = resolve(repoRoot, "run-receipt.json");

    await writeJson(localProofPath, localProof());
    await writeJson(preflightPath, preflight());
    await writeJson(runReceiptPath, runReceipt({ submitAttempted: false }));

    const receipt = await runWorkflowReadinessReportCli({
      argv: [
        ...profileArgs,
        `--local-proof-path=${localProofPath}`,
        `--preflight-path=${preflightPath}`,
        `--run-receipt-path=${runReceiptPath}`,
        "--out-root=out",
      ],
      log: () => {},
      now: () => "2026-06-10T11:01:00.000Z",
      repoRoot,
    });
    const mdsvx = await readFile(receipt.reportPath, "utf-8");
    const html = await readFile(receipt.indexPath, "utf-8");
    const receipts = await readFile(receipt.receiptsPath, "utf-8");
    const audit = WorkflowDefinitionOfDoneAuditSummarySchema.parse(
      JSON.parse(await readFile(receipt.definitionOfDoneAuditPath, "utf-8"))
    );
    const combined = `${mdsvx}\n${html}\n${receipts}\n${JSON.stringify(audit)}`;

    expect({
      auditBlockedCount: audit.summary.blockedCount,
      auditCapturedCount: audit.summary.capturedCount,
      auditMissingCount: audit.summary.missingCount,
      auditNotProvenCount: audit.summary.notProvenCount,
      auditSchemaVersion: audit.schemaVersion,
      auditStatus: audit.status,
      auditTotalCount: audit.summary.totalCount,
      blockerCount: receipt.summary.blockerCount,
      hasCanonicalTemplate: mdsvx.includes(
        'template: "joel/tufte-mdsvx@0.1.0"'
      ),
      hasDefinitionOfDoneAudit: mdsvx.includes("## Definition of done audit"),
      hasHumanFindingBeforeProof:
        mdsvx.indexOf("## The actual finding") < mdsvx.indexOf("## Proof"),
      hasNoCandidateReview: !mdsvx.includes("Candidate review"),
      hasNoRawPrivateValues: [rawPrivatePath, rawRelayToken, rawRelayUrl].every(
        (privateValue) => !combined.includes(privateValue)
      ),
      htmlLinksAudit: html.includes("definition-of-done-audit.json"),
      htmlLinksSource: html.includes("report.mdsvx"),
      localProofStatus: receipt.summary.localProofStatus,
      submitAttempted: receipt.summary.submitAttempted,
    }).toStrictEqual({
      auditBlockedCount: 5,
      auditCapturedCount: 4,
      auditMissingCount: 0,
      auditNotProvenCount: 0,
      auditSchemaVersion: "workflow.definition-of-done-audit.v1",
      auditStatus: "blocked",
      auditTotalCount: 9,
      blockerCount: 3,
      hasCanonicalTemplate: true,
      hasDefinitionOfDoneAudit: true,
      hasHumanFindingBeforeProof: true,
      hasNoCandidateReview: true,
      hasNoRawPrivateValues: true,
      htmlLinksAudit: true,
      htmlLinksSource: true,
      localProofStatus: "passed",
      submitAttempted: false,
    });
  });

  it("refuses to render a readiness report for a submitted Dream receipt", async () => {
    const repoRoot = await workflowCliTestRepoRoot("dream-readiness-report-");
    const localProofPath = resolve(repoRoot, "proof.json");
    const preflightPath = resolve(repoRoot, "preflight.json");
    const runReceiptPath = resolve(repoRoot, "run-receipt.json");

    await writeJson(localProofPath, localProof());
    await writeJson(preflightPath, preflight());
    await writeJson(runReceiptPath, runReceipt({ submitAttempted: true }));

    await expect(
      runWorkflowReadinessReportCli({
        argv: [
          ...profileArgs,
          `--local-proof-path=${localProofPath}`,
          `--preflight-path=${preflightPath}`,
          `--run-receipt-path=${runReceiptPath}`,
          "--out-root=out",
        ],
        log: () => {},
        repoRoot,
      })
    ).rejects.toThrow(
      "Workflow readiness report only renders blocked/pre-submit receipts."
    );
  });

  it("publishes the rendered report behind an explicit publish flag and writes a receipt", async () => {
    const repoRoot = await workflowCliTestRepoRoot("dream-readiness-report-");
    const localProofPath = resolve(repoRoot, "proof.json");
    const preflightPath = resolve(repoRoot, "preflight.json");
    const runReceiptPath = resolve(repoRoot, "run-receipt.json");
    const publishCalls: unknown[] = [];

    await writeJson(localProofPath, localProof());
    await writeJson(preflightPath, preflight());
    await writeJson(runReceiptPath, runReceipt({ submitAttempted: false }));

    const receipt = await runWorkflowReadinessReportCli({
      argv: [
        ...profileArgs,
        `--local-proof-path=${localProofPath}`,
        `--preflight-path=${preflightPath}`,
        `--run-receipt-path=${runReceiptPath}`,
        "--out-root=out",
        "--publish",
        "--publish-slug=dream-readiness-report-test",
        "--publish-expires-in=24h",
      ],
      log: () => {},
      now: () => "2026-06-10T11:02:00.000Z",
      publishCommand: (input) => {
        publishCalls.push(input);

        return Promise.resolve({
          command: "wzrrd publish",
          ok: true,
          result: {
            bytes: 12_345,
            createdAt: "2026-06-10T11:02:01.000Z",
            deleteAfter: "2026-06-18T11:02:01.000Z",
            expiresAt: "2026-06-11T11:02:01.000Z",
            fileCount: 4,
            indexing: "noindex",
            lifecycle: "expiring",
            slug: input.slug,
            source: input.siteDir,
            status: "active",
            updatedAt: "2026-06-10T11:02:01.000Z",
            url: `https://${input.slug}.wzrrd.sh/`,
          },
        });
      },
      repoRoot,
    });

    const publishReceipt = await readFile(
      resolve(receipt.siteDir, "publish-receipt.json"),
      "utf-8"
    );

    expect({
      noPrivateValues: [rawPrivatePath, rawRelayToken, rawRelayUrl].every(
        (privateValue) => !publishReceipt.includes(privateValue)
      ),
      publishCalls,
      publishReceipt: JSON.parse(publishReceipt) as unknown,
    }).toMatchObject({
      noPrivateValues: true,
      publishCalls: [
        {
          expiresIn: "24h",
          siteDir: receipt.siteDir,
          slug: "dream-readiness-report-test",
          wzrrdBin: "wzrrd",
        },
      ],
      publishReceipt: {
        expiresIn: "24h",
        htmlHash: receipt.htmlHash,
        mdsvxHash: receipt.mdsvxHash,
        redacted: true,
        result: {
          expiresAt: "2026-06-11T11:02:01.000Z",
          indexing: "noindex",
          lifecycle: "expiring",
          slug: "dream-readiness-report-test",
          status: "active",
          url: "https://dream-readiness-report-test.wzrrd.sh/",
        },
        runId,
        schemaVersion: "workflow.readiness-report.publish.v1",
        status: "published",
      },
    });
  });
});
