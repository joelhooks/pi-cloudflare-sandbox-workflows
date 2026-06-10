#!/usr/bin/env tsx

import { spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import { sha256Hex } from "../src/app/domain/hash.ts";
import {
  WorkflowLiveRunRequestReceiptSchema,
  WorkflowLivePreflightReceiptSchema,
} from "../src/app/domain/schemas.ts";
import type {
  WorkflowLiveRunRequestReceipt,
  WorkflowLivePreflightReceipt,
} from "../src/app/domain/schemas.ts";
import type { MemorySourceProfile } from "../src/app/domain/source-profile.ts";
import {
  requireInstalledSourceProfile,
  workflowProfileWorkspacePaths,
} from "./workflow-app-profile.ts";

const defaultLocalProofPath =
  ".wrangler/workflow-app/memory-relay/latest-local-proof.json";
const defaultPublishExpiresIn = "24h";
const defaultWzrrdBin = "wzrrd";

const LocalRelayProofReceiptSchema = z
  .object({
    checkedAt: z.string().min(1),
    correlation: z.object({
      edgeCount: z.number().int().min(0),
      nodeCount: z.number().int().min(0),
    }),
    rawCredentialsReturned: z.literal(false),
    rawPathLeaked: z.literal(false),
    rawPathsReturned: z.literal(false),
    redacted: z.literal(true),
    runId: z.string().min(1),
    schemaVersion: z.literal("trusted.memory-relay.local-proof.v1"),
    search: z.object({
      hitCount: z.number().int().min(0),
      hydratedCount: z.number().int().min(0),
      skippedSourceCount: z.number().int().min(0),
    }),
    signals: z.object({
      signalCount: z.number().int().min(0),
      signalKinds: z.array(z.string().min(1)),
    }),
    sourceFamilyCoverage: z
      .array(
        z.object({
          family: z.string().min(1),
          receiptCount: z.number().int().min(0),
          status: z.string().min(1),
        })
      )
      .default([]),
    sourceRootCount: z.number().int().min(0),
  })
  .passthrough();

export type LocalRelayProofReceipt = z.infer<
  typeof LocalRelayProofReceiptSchema
>;

const WorkflowReadinessReportReceiptSchema = z.object({
  definitionOfDoneAuditPath: z.string().min(1),
  generatedAt: z.string().min(1),
  htmlHash: z.string().length(64),
  indexPath: z.string().min(1),
  localProofRunId: z.string().min(1),
  mdsvxHash: z.string().length(64),
  receiptPath: z.string().min(1),
  receiptsPath: z.string().min(1),
  redacted: z.literal(true),
  reportPath: z.string().min(1),
  runId: z.string().min(1),
  schemaVersion: z.literal("workflow.readiness-report.v1"),
  siteDir: z.string().min(1),
  status: z.literal("rendered"),
  summary: z.object({
    blockerCount: z.number().int().min(0),
    correlationEdgeCount: z.number().int().min(0),
    hydratedReceiptCount: z.number().int().min(0),
    localProofStatus: z.literal("passed"),
    sourceRootCount: z.number().int().min(0),
    submitAttempted: z.literal(false),
  }),
});

export type WorkflowReadinessReportReceipt = z.infer<
  typeof WorkflowReadinessReportReceiptSchema
>;

const WorkflowDefinitionOfDoneAuditItemSchema = z.object({
  blockerRefs: z.array(z.string().min(1)).default([]),
  evidenceRefs: z.array(z.string().min(1)).default([]),
  requirement: z.string().min(1),
  requirementId: z.string().min(1),
  status: z.enum(["blocked", "captured", "missing", "not-proven"]),
  summary: z.string().min(1),
});

const WorkflowDefinitionOfDoneAuditSchema = z.object({
  generatedAt: z.string().min(1),
  items: z.array(WorkflowDefinitionOfDoneAuditItemSchema).min(1),
  redacted: z.literal(true),
  runId: z.string().min(1),
  schemaVersion: z.literal("workflow.definition-of-done-audit.v1"),
  status: z.enum(["blocked", "captured", "not-proven"]),
  summary: z.object({
    blockedCount: z.number().int().min(0),
    capturedCount: z.number().int().min(0),
    missingCount: z.number().int().min(0),
    notProvenCount: z.number().int().min(0),
    totalCount: z.number().int().min(1),
  }),
});

export type WorkflowDefinitionOfDoneAudit = z.infer<
  typeof WorkflowDefinitionOfDoneAuditSchema
>;
type WorkflowDefinitionOfDoneAuditItem = z.infer<
  typeof WorkflowDefinitionOfDoneAuditItemSchema
>;
type WorkflowDefinitionOfDoneAuditItemInput = z.input<
  typeof WorkflowDefinitionOfDoneAuditItemSchema
>;

const WzrrdCliPublishResultSchema = z
  .object({
    command: z.string().min(1),
    ok: z.literal(true),
    result: z
      .object({
        bytes: z.number().int().min(0),
        createdAt: z.string().min(1),
        deleteAfter: z.string().min(1).optional(),
        expiresAt: z.string().min(1).optional(),
        fileCount: z.number().int().min(0),
        indexing: z.literal("noindex"),
        lifecycle: z.string().min(1),
        slug: z.string().min(1),
        source: z.string().min(1),
        status: z.string().min(1),
        updatedAt: z.string().min(1),
        url: z.string().url(),
      })
      .passthrough(),
  })
  .passthrough();

export type WzrrdCliPublishResult = z.infer<typeof WzrrdCliPublishResultSchema>;

const WorkflowReadinessReportPublishReceiptSchema = z.object({
  command: z.array(z.string().min(1)),
  expiresIn: z.string().min(1),
  htmlHash: z.string().length(64),
  mdsvxHash: z.string().length(64),
  publishReceiptPath: z.string().min(1),
  publishedAt: z.string().min(1),
  redacted: z.literal(true),
  renderReceiptPath: z.string().min(1),
  result: z.object({
    bytes: z.number().int().min(0),
    deleteAfter: z.string().min(1).optional(),
    expiresAt: z.string().min(1).optional(),
    fileCount: z.number().int().min(0),
    indexing: z.literal("noindex"),
    lifecycle: z.string().min(1),
    slug: z.string().min(1),
    status: z.string().min(1),
    url: z.string().url(),
  }),
  runId: z.string().min(1),
  schemaVersion: z.literal("workflow.readiness-report.publish.v1"),
  siteDir: z.string().min(1),
  slug: z.string().min(1),
  status: z.literal("published"),
});

export type WorkflowReadinessReportPublishReceipt = z.infer<
  typeof WorkflowReadinessReportPublishReceiptSchema
>;

interface WorkflowReadinessReportArgs {
  readonly localProofPath: string;
  readonly outRoot: string;
  readonly preflightPath: string;
  readonly publish: boolean;
  readonly publishExpiresIn: string;
  readonly publishSlug?: string;
  readonly receiptPath?: string;
  readonly runReceiptDir: string;
  readonly runReceiptPath?: string;
  readonly wzrrdBin: string;
}

export interface WorkflowReadinessReportInput {
  readonly generatedAt: string;
  readonly localProof: LocalRelayProofReceipt;
  readonly preflight: WorkflowLivePreflightReceipt;
  readonly profile: MemorySourceProfile;
  readonly runReceipt: WorkflowLiveRunRequestReceipt;
}

export interface RunWorkflowReadinessReportCliInput {
  readonly argv: readonly string[];
  readonly log?: (message: string) => void;
  readonly now?: () => string;
  readonly publishCommand?: (
    input: WzrrdPublishCommandInput
  ) => Promise<WzrrdCliPublishResult>;
  readonly repoRoot: string;
}

export interface WzrrdPublishCommandInput {
  readonly expiresIn: string;
  readonly repoRoot: string;
  readonly siteDir: string;
  readonly slug: string;
  readonly wzrrdBin: string;
}

const isMain = (): boolean =>
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

const argValue = (
  argv: readonly string[],
  name: string
): string | undefined => {
  const prefix = `${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  if (inline !== undefined) {
    return inline.slice(prefix.length);
  }

  const index = argv.indexOf(name);

  return index === -1 ? undefined : argv[index + 1];
};

const parseArgs = (
  argv: readonly string[],
  profile: MemorySourceProfile
): WorkflowReadinessReportArgs => {
  const workspacePaths = workflowProfileWorkspacePaths(profile.profileId);
  const receiptPath = argValue(argv, "--receipt-path");
  const runReceiptPath = argValue(argv, "--run-receipt-path");
  const publishSlug =
    argValue(argv, "--publish-slug") ?? argValue(argv, "--slug");

  return {
    localProofPath:
      argValue(argv, "--local-proof-path") ?? defaultLocalProofPath,
    outRoot:
      argValue(argv, "--out-root") ?? workspacePaths.readinessReportOutRoot,
    preflightPath:
      argValue(argv, "--preflight-path") ?? workspacePaths.preflightReceiptPath,
    publish: argv.includes("--publish"),
    publishExpiresIn:
      argValue(argv, "--publish-expires-in") ??
      argValue(argv, "--expires-in") ??
      defaultPublishExpiresIn,
    ...(publishSlug === undefined ? {} : { publishSlug }),
    ...(receiptPath === undefined ? {} : { receiptPath }),
    runReceiptDir:
      argValue(argv, "--run-receipt-dir") ?? workspacePaths.runReceiptDir,
    ...(runReceiptPath === undefined ? {} : { runReceiptPath }),
    wzrrdBin: argValue(argv, "--wzrrd-bin") ?? defaultWzrrdBin,
  };
};

const readJsonFile = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, "utf-8"));

const latestRunReceiptPath = async (dir: string): Promise<string> => {
  const entries = await readdir(dir);
  const receiptNames = entries.filter((entry) =>
    entry.endsWith("-receipt.json")
  );
  if (receiptNames.length === 0) {
    throw new Error(`No workflow run receipt files found in ${dir}.`);
  }

  const candidates = await Promise.all(
    receiptNames.map(async (entry) => {
      const path = join(dir, entry);
      const info = await stat(path);

      return {
        modifiedMs: info.mtimeMs,
        path,
      };
    })
  );
  const [latest] = candidates.toSorted(
    (left, right) => right.modifiedMs - left.modifiedMs
  );
  if (latest === undefined) {
    throw new Error(`No workflow run receipt files found in ${dir}.`);
  }

  return latest.path;
};

const htmlEscape = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const markdownInline = (value: string): string =>
  htmlEscape(value)
    .replaceAll(/\*\*([^*]+)\*\*/gu, "<strong>$1</strong>")
    .replaceAll(/`([^`]+)`/gu, "<code>$1</code>");

const slugForHeading = (value: string): string => {
  const slug = value
    .toLowerCase()
    .replaceAll(/`([^`]+)`/gu, "$1")
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-|-$/gu, "");

  return slug.length === 0 ? "section" : slug;
};

const stripFrontMatter = (content: string): string => {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/u.exec(content);

  return match === null ? content : content.slice(match[0].length);
};

const renderMarkdownSubset = (content: string): string => {
  const lines = stripFrontMatter(content).replaceAll("\r\n", "\n").split("\n");
  const html: string[] = [];
  let paragraph: string[] = [];
  let listItems: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) {
      return;
    }

    html.push(`<p>${markdownInline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const flushList = (): void => {
    if (listItems.length === 0) {
      return;
    }

    html.push(
      `<ul>${listItems
        .map((item) => `<li>${markdownInline(item)}</li>`)
        .join("")}</ul>`
    );
    listItems = [];
  };
  const flushBlocks = (): void => {
    flushParagraph();
    flushList();
  };

  for (const line of lines) {
    if (line.trim().length === 0) {
      flushBlocks();
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/u.exec(line);
    if (heading !== null) {
      flushBlocks();
      const level = heading[1]?.length ?? 2;
      const text = heading[2] ?? "";
      html.push(
        `<h${level} id="${htmlEscape(slugForHeading(text))}">${markdownInline(text)}</h${level}>`
      );
      continue;
    }

    const listItem = /^[-*]\s+(.+)$/u.exec(line);
    if (listItem !== null) {
      flushParagraph();
      listItems.push(listItem[1] ?? "");
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }

  flushBlocks();

  return html.join("\n");
};

const statusLineFor = (input: WorkflowReadinessReportInput): string =>
  [
    `source roots ${input.localProof.sourceRootCount}`,
    `source families ${input.localProof.sourceFamilyCoverage.length}`,
    `hydrated receipts ${input.localProof.search.hydratedCount}`,
    `correlation edges ${input.localProof.correlation.edgeCount}`,
    `blockers ${input.runReceipt.blockedReasons.length}`,
  ].join(" / ");

const sourceFamilyLine = (proof: LocalRelayProofReceipt): string =>
  proof.sourceFamilyCoverage.length === 0
    ? "no explicit source-family coverage reported"
    : proof.sourceFamilyCoverage
        .map(
          (coverage) =>
            `${coverage.family}: ${coverage.receiptCount} receipt(s), ${coverage.status}`
        )
        .join("; ");

const bulletList = (items: readonly string[]): string =>
  items.length === 0 ? "- None." : items.map((item) => `- ${item}`).join("\n");

const auditEvidenceFor = (input: WorkflowReadinessReportInput): string[] => [
  `local-proof:${input.localProof.runId}`,
  `preflight:${input.preflight.generatedAt}`,
  `run-receipt:${input.runReceipt.runId}`,
];

const retrievalCoverageCaptured = (proof: LocalRelayProofReceipt): boolean =>
  proof.search.hitCount > 0 &&
  proof.search.hydratedCount > 0 &&
  proof.correlation.edgeCount > 0;

const preflightCheckStatus = (
  input: WorkflowReadinessReportInput,
  checkId: string
): string =>
  input.preflight.checks.find((check) => check.checkId === checkId)?.status ??
  "missing";

const parseAuditItem = (
  item: WorkflowDefinitionOfDoneAuditItemInput
): WorkflowDefinitionOfDoneAuditItem =>
  WorkflowDefinitionOfDoneAuditItemSchema.parse(item);

const liveSubmittedFor = (input: WorkflowReadinessReportInput): boolean =>
  input.runReceipt.submit.attempted && input.runReceipt.status === "submitted";

const workflowCartridgePackageAuditItem = (
  input: WorkflowReadinessReportInput
): WorkflowDefinitionOfDoneAuditItem => {
  const packageCaptured =
    input.preflight.remoteRegistry.status === "queried" &&
    input.preflight.remoteRegistry.expectedPackageSeeded === true;
  const packageId = input.preflight.expectedCartridgePackageId;

  return parseAuditItem({
    evidenceRefs: auditEvidenceFor(input),
    requirement:
      "The workflow is an installed artifact-backed workflow cartridge/package.",
    requirementId: "workflow-cartridge-package",
    status: packageCaptured ? "captured" : "missing",
    summary: packageCaptured
      ? `Remote registry has ${packageId} seeded for invocation.`
      : `Remote registry did not prove ${packageId} is seeded.`,
  });
};

const trustedLocalRelayAuditItem = (
  input: WorkflowReadinessReportInput
): WorkflowDefinitionOfDoneAuditItem => {
  const localRelayCaptured =
    input.localProof.rawCredentialsReturned === false &&
    input.localProof.rawPathsReturned === false &&
    input.localProof.rawPathLeaked === false &&
    input.localProof.sourceRootCount > 0;

  return parseAuditItem({
    evidenceRefs: auditEvidenceFor(input),
    requirement:
      "Trusted relay can inspect the memory fabric without returning raw credentials, paths, or transcripts.",
    requirementId: "trusted-local-memory-relay",
    status: localRelayCaptured ? "captured" : "not-proven",
    summary: localRelayCaptured
      ? `Local relay proof covered ${input.localProof.sourceRootCount} source roots with redaction flags held.`
      : "Local relay proof did not satisfy the redaction/source-root evidence requirements.",
  });
};

const workerFacingRelayAuditItem = (
  input: WorkflowReadinessReportInput
): WorkflowDefinitionOfDoneAuditItem => {
  const relayReady =
    input.preflight.relayCapability.readiness.endpointConfigured &&
    input.preflight.relayCapability.readiness.tokenConfigured &&
    input.preflight.relayCapability.readiness.workerBaseUrlConfigured &&
    input.preflight.relayCapability.readiness.healthzStatus === "passed";

  return parseAuditItem({
    blockerRefs: input.runReceipt.blockedReasons,
    evidenceRefs: [
      ...auditEvidenceFor(input),
      `preflight-check:env:MEMORY_RELAY_BASE_URL:${preflightCheckStatus(input, "env:MEMORY_RELAY_BASE_URL")}`,
      `preflight-check:env:MEMORY_RELAY_TOKEN:${preflightCheckStatus(input, "env:MEMORY_RELAY_TOKEN")}`,
      `preflight-check:relay:healthz:${preflightCheckStatus(input, "relay:healthz")}`,
    ],
    requirement:
      "Cloudflare leases memory/search/hydration capabilities through a Worker-facing trusted relay.",
    requirementId: "worker-facing-relay-capability-lease",
    status: relayReady ? "captured" : "blocked",
    summary: relayReady
      ? "Worker-facing relay endpoint, token, config, and authenticated healthz are ready."
      : "Worker-facing relay URL/token/config/remote healthz are not all ready.",
  });
};

const liveCloudflareExecutionAuditItem = (
  input: WorkflowReadinessReportInput
): WorkflowDefinitionOfDoneAuditItem => {
  const liveSubmitted = liveSubmittedFor(input);

  return parseAuditItem({
    blockerRefs: input.runReceipt.blockedReasons,
    evidenceRefs: auditEvidenceFor(input),
    requirement:
      "The run request is submitted to and executed by the deployed Cloudflare workflow app.",
    requirementId: "live-cloudflare-execution",
    status: liveSubmitted ? "captured" : "blocked",
    summary: liveSubmitted
      ? "The live run request was submitted to Cloudflare."
      : `Live submit did not happen; submit.attempted=${String(input.runReceipt.submit.attempted)}.`,
  });
};

const generatedMachineAuditItem = (
  input: WorkflowReadinessReportInput
): WorkflowDefinitionOfDoneAuditItem => {
  const liveSubmitted = liveSubmittedFor(input);

  return parseAuditItem({
    blockerRefs: input.runReceipt.blockedReasons,
    evidenceRefs: [
      ...auditEvidenceFor(input),
      ...input.preflight.artifactModel.generatedArtifactsRequired.map(
        (artifact) => `required-generated-artifact:${artifact}`
      ),
    ],
    requirement:
      "A real planner generates and pins workflow.xstate-machine.v1 plus generated harness/source/hash artifacts.",
    requirementId: "generated-machine-and-harness",
    status: liveSubmitted ? "not-proven" : "blocked",
    summary: liveSubmitted
      ? "Live submit happened, but this readiness report has not inspected generated machine/harness artifacts."
      : "Planner execution never started, so generated machine/harness artifacts do not exist for this run.",
  });
};

const tShapedCoverageAuditItem = (
  input: WorkflowReadinessReportInput
): WorkflowDefinitionOfDoneAuditItem => {
  const coverageCaptured = retrievalCoverageCaptured(input.localProof);

  const missingFamilies = input.localProof.sourceFamilyCoverage
    .filter((coverage) => coverage.status !== "captured")
    .map((coverage) => coverage.family);
  const familyCaveatSuffix =
    missingFamilies.length === 0
      ? ""
      : ` Coverage caveat: missing source families ${missingFamilies.join(", ")}.`;

  return parseAuditItem({
    evidenceRefs: auditEvidenceFor(input),
    requirement:
      "The workflow reads T-shaped across time horizons with hydration and correlation; coverage gaps are reported as caveats, never gates.",
    requirementId: "t-shaped-memory-coverage",
    status: coverageCaptured ? "captured" : "not-proven",
    summary: coverageCaptured
      ? `Local proof captured search, hydration, and correlation coverage: ${input.localProof.search.hydratedCount} hydrated receipts, ${input.localProof.correlation.edgeCount} edges.${familyCaveatSuffix}`
      : `Local proof did not capture search/hydration/correlation evidence.${familyCaveatSuffix}`,
  });
};

const workflowOwnedWzrrdAuditItem = (
  input: WorkflowReadinessReportInput
): WorkflowDefinitionOfDoneAuditItem => {
  const liveSubmitted = liveSubmittedFor(input);

  return parseAuditItem({
    blockerRefs: input.runReceipt.blockedReasons,
    evidenceRefs: auditEvidenceFor(input),
    requirement:
      "The Cloudflare workflow publishes the canonical Tufte/MDSvX Wzrrd HITL report through a leased side effect.",
    requirementId: "workflow-owned-wzrrd-output",
    status: liveSubmitted ? "not-proven" : "blocked",
    summary: liveSubmitted
      ? "Live submit happened, but this readiness report has not inspected workflow-owned Wzrrd lease receipts."
      : "Only the operator readiness report exists; no workflow-owned Wzrrd publish capability receipt exists for this run.",
  });
};

const hitlRefinementLoopAuditItem = (
  input: WorkflowReadinessReportInput
): WorkflowDefinitionOfDoneAuditItem => {
  const liveSubmitted = liveSubmittedFor(input);

  return parseAuditItem({
    blockerRefs: input.runReceipt.blockedReasons,
    evidenceRefs: auditEvidenceFor(input),
    requirement:
      "Accepted findings produce HITL decision, workflow seed, and follow-up run request artifacts that feed the next generated workflow.",
    requirementId: "hitl-refinement-loop",
    status: liveSubmitted ? "not-proven" : "blocked",
    summary: liveSubmitted
      ? "Live submit happened, but this readiness report has not inspected HITL decision/seed/follow-up artifacts."
      : "The live run blocked before report, HITL decision seed, or follow-up run request artifacts could be generated.",
  });
};

const publicPrivateBoundaryAuditItem = (
  input: WorkflowReadinessReportInput
): WorkflowDefinitionOfDoneAuditItem => {
  const redactionCaptured =
    input.localProof.rawCredentialsReturned === false &&
    input.localProof.rawPathsReturned === false &&
    input.localProof.rawPathLeaked === false;

  return parseAuditItem({
    evidenceRefs: auditEvidenceFor(input),
    requirement:
      "Public artifacts remain redacted: no raw credentials, raw private paths, or raw transcripts.",
    requirementId: "public-private-redaction-boundary",
    status: redactionCaptured ? "captured" : "not-proven",
    summary: redactionCaptured
      ? "Local relay proof redaction flags all remained false."
      : "Redaction flags did not prove the public/private boundary.",
  });
};

const auditStatusFor = (input: {
  readonly blockedCount: number;
  readonly missingCount: number;
  readonly notProvenCount: number;
}): WorkflowDefinitionOfDoneAudit["status"] => {
  if (input.blockedCount > 0 || input.missingCount > 0) {
    return "blocked";
  }

  if (input.notProvenCount > 0) {
    return "not-proven";
  }

  return "captured";
};

export const buildWorkflowDefinitionOfDoneAudit = (
  input: WorkflowReadinessReportInput
): WorkflowDefinitionOfDoneAudit => {
  const parsedItems = [
    workflowCartridgePackageAuditItem(input),
    trustedLocalRelayAuditItem(input),
    workerFacingRelayAuditItem(input),
    liveCloudflareExecutionAuditItem(input),
    generatedMachineAuditItem(input),
    tShapedCoverageAuditItem(input),
    workflowOwnedWzrrdAuditItem(input),
    hitlRefinementLoopAuditItem(input),
    publicPrivateBoundaryAuditItem(input),
  ];
  const capturedCount = parsedItems.filter(
    (item) => item.status === "captured"
  ).length;
  const blockedCount = parsedItems.filter(
    (item) => item.status === "blocked"
  ).length;
  const missingCount = parsedItems.filter(
    (item) => item.status === "missing"
  ).length;
  const notProvenCount = parsedItems.filter(
    (item) => item.status === "not-proven"
  ).length;

  return WorkflowDefinitionOfDoneAuditSchema.parse({
    generatedAt: input.generatedAt,
    items: parsedItems,
    redacted: true,
    runId: input.runReceipt.runId,
    schemaVersion: "workflow.definition-of-done-audit.v1",
    status: auditStatusFor({ blockedCount, missingCount, notProvenCount }),
    summary: {
      blockedCount,
      capturedCount,
      missingCount,
      notProvenCount,
      totalCount: parsedItems.length,
    },
  });
};

const auditLineFor = (item: WorkflowDefinitionOfDoneAudit["items"][number]) =>
  `- ${item.requirementId}: ${item.status} — ${item.summary}`;

export const renderWorkflowReadinessReportMdsvx = (
  input: WorkflowReadinessReportInput
): string => {
  const audit = buildWorkflowDefinitionOfDoneAudit(input);
  const reportTitle = `${input.profile.title} readiness report`;

  return [
    "---",
    'expiresIn: "24h"',
    "noindex: true",
    'template: "joel/tufte-mdsvx@0.1.0"',
    `title: "${reportTitle}"`,
    "---",
    "",
    `# ${reportTitle}`,
    "",
    `This is a readiness report for the ${input.profile.title} workflow (source profile ${input.profile.profileId}), not a completed run.`,
    "",
    `The trusted local memory fabric proof passed. The live Cloudflare submit did not happen because the Worker-facing relay boundary is still blocked. That is the correct outcome: no relay URL, no relay token, no authenticated remote health check, no live run.`,
    "",
    `Status: ${statusLineFor(input)}.`,
    "",
    "## The actual finding",
    "",
    "The useful result is not that the workflow is done. It is not done. The useful result is that the local relay can now see enough of the system to make the next Cloudflare run worth doing.",
    "",
    "Reasoning",
    "",
    `The local proof covered ${input.localProof.sourceRootCount} source roots. Source-family coverage is ${sourceFamilyLine(input.localProof)}.`,
    "",
    "Rating",
    "",
    "8/10 as a readiness artifact. 0/10 as proof of completed Cloudflare execution.",
    "",
    "Recommendation",
    "",
    "Turn this into the next operational task: approve and configure the Worker-facing trusted relay, then run the real Cloudflare workflow so the generated machine, harness, verifier proof, Wzrrd delivery, and HITL seed artifacts exist for real.",
    "",
    `Receipt: ${input.localProof.runId}.`,
    "",
    "## Actionable line items",
    "",
    "### Finish the relay boundary",
    "",
    "Reasoning",
    "",
    "The workflow cartridge is seeded and the local proof is useful, but Cloudflare cannot execute the cartridge nodes until it can reach the trusted relay through an approved HTTPS endpoint with the matching Worker secret.",
    "",
    "Rating",
    "",
    "10/10.",
    "",
    "Recommendation",
    "",
    "Approve the network boundary explicitly, provision `MEMORY_RELAY_TOKEN`, deploy `MEMORY_RELAY_BASE_URL` through the signoff-gated path, verify remote `/healthz`, then submit the existing run request shape.",
    "",
    "### Keep the report honest",
    "",
    "Reasoning",
    "",
    "This page has no generated `workflow.xstate-machine.v1` artifact because the live run was blocked before planner execution. That absence is evidence, not a formatting problem.",
    "",
    "Rating",
    "",
    "9/10.",
    "",
    "Recommendation",
    "",
    "Do not call this a workflow output. Use it as the HITL handoff for the blocked relay boundary, then replace it with the real generated HITL report after Cloudflare execution.",
    "",
    "## Proof",
    "",
    `Run request: ${input.runReceipt.runId}. Status: ${input.runReceipt.status}. Submit attempted: ${String(input.runReceipt.submit.attempted)}.`,
    "",
    `Preflight generated: ${input.preflight.generatedAt}. Preflight status: ${input.preflight.status}. Worker URL: ${input.preflight.workerUrl}.`,
    "",
    "Blocked reasons:",
    "",
    bulletList(input.runReceipt.blockedReasons),
    "",
    "Required actions:",
    "",
    bulletList(input.preflight.requiredActions),
    "",
    "Source-family coverage:",
    "",
    `- ${sourceFamilyLine(input.localProof)}`,
    "",
    "Search and graph:",
    "",
    `- ${input.localProof.search.hitCount} search hit(s), ${input.localProof.search.hydratedCount} hydrated redacted receipt(s), ${input.localProof.search.skippedSourceCount} skipped source item(s).`,
    `- ${input.localProof.signals.signalCount} signal(s): ${input.localProof.signals.signalKinds.join(", ")}.`,
    `- ${input.localProof.correlation.nodeCount} correlation node(s), ${input.localProof.correlation.edgeCount} correlation edge(s).`,
    "",
    "## Definition of done audit",
    "",
    `Audit status: ${audit.status}. Captured ${audit.summary.capturedCount}/${audit.summary.totalCount}; blocked ${audit.summary.blockedCount}; missing ${audit.summary.missingCount}; not proven ${audit.summary.notProvenCount}.`,
    "",
    ...audit.items.map(auditLineFor),
    "",
    "## What did not happen",
    "",
    "- No live Cloudflare run was submitted.",
    "- No real Pi planner generated a task-specific state machine in this run attempt.",
    "- No `workflow.xstate-machine.v1`, generated TypeScript source, generated harness source, verifier proof, or cartridge invocation proof was produced by Cloudflare for this run request.",
    "- No Wzrrd publication by the workflow happened; this readiness report is a separate operator handoff artifact.",
    "- No raw credentials, raw private paths, or raw transcripts were returned by the local relay proof.",
    "",
    "## Report standard",
    "",
    "Template: `joel/tufte-mdsvx@0.1.0`. Publish policy: noindex, 24h expiry. The canonical source is `report.mdsvx`; `index.html` is a static preview for Wzrrd.",
  ].join("\n");
};

export const renderWorkflowReadinessReportHtml = (input: {
  readonly generatedAt: string;
  readonly mdsvx: string;
  readonly runId: string;
  readonly title: string;
}): string => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>${htmlEscape(input.title)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #fbfaf7;
      --ink: #161616;
      --muted: #5e615b;
      --line: #d9d2c2;
      --panel: #f2f0e8;
      --accent: #245c73;
      --accent-strong: #8f2d56;
      font-family: ui-serif, Georgia, "Times New Roman", serif;
    }
    * { box-sizing: border-box; }
    body {
      background: var(--bg);
      color: var(--ink);
      font-size: 19px;
      line-height: 1.66;
      margin: 0;
      text-rendering: optimizeLegibility;
    }
    main {
      margin: 0 auto;
      max-width: 1160px;
      padding: 44px 20px 72px;
    }
    article { max-width: 760px; }
    header {
      border-bottom: 1px solid var(--line);
      margin-bottom: 28px;
      padding-bottom: 18px;
    }
    h1 {
      font-size: clamp(2.1rem, 6vw, 4.8rem);
      line-height: 0.98;
      margin: 0 0 12px;
    }
    h2 {
      font-size: clamp(1.7rem, 4vw, 2.35rem);
      line-height: 1.12;
      margin: 54px 0 14px;
    }
    h3 {
      border-top: 1px solid var(--line);
      font-size: 1.35rem;
      line-height: 1.18;
      margin: 28px 0 8px;
      padding-top: 16px;
    }
    p, li { overflow-wrap: break-word; }
    ul { padding-left: 1.2rem; }
    a { color: var(--accent); }
    a:hover { color: var(--accent-strong); }
    code {
      background: var(--panel);
      border: 1px solid var(--line);
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      font-size: 0.82em;
      padding: 0.04rem 0.28rem;
    }
    .meta {
      color: var(--muted);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 0.88rem;
      line-height: 1.5;
    }
    footer {
      border-top: 1px solid var(--line);
      color: var(--muted);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 0.78rem;
      line-height: 1.45;
      margin-top: 64px;
      padding-top: 18px;
    }
  </style>
</head>
<body>
  <main>
    <article>
      <header>
        <h1>${htmlEscape(input.title)}</h1>
        <div class="meta">
          <div>Run <code>${htmlEscape(input.runId)}</code></div>
          <div>Generated <code>${htmlEscape(input.generatedAt)}</code></div>
          <div>Template <code>joel/tufte-mdsvx@0.1.0</code></div>
          <div>Source <a href="report.mdsvx">report.mdsvx</a></div>
          <div>Receipts <a href="receipts.json">receipts.json</a></div>
          <div>Audit <a href="definition-of-done-audit.json">definition-of-done-audit.json</a></div>
        </div>
      </header>
      ${renderMarkdownSubset(input.mdsvx)}
      <footer>
        Static preview rendered from a redacted readiness report. The canonical source is published unchanged beside this page.
      </footer>
    </article>
  </main>
</body>
</html>`;

const compactReceiptsFor = (
  input: WorkflowReadinessReportInput,
  audit: WorkflowDefinitionOfDoneAudit
) => ({
  definitionOfDoneAudit: audit,
  generatedAt: input.generatedAt,
  localProof: {
    checkedAt: input.localProof.checkedAt,
    correlation: input.localProof.correlation,
    rawCredentialsReturned: input.localProof.rawCredentialsReturned,
    rawPathLeaked: input.localProof.rawPathLeaked,
    rawPathsReturned: input.localProof.rawPathsReturned,
    redacted: true,
    runId: input.localProof.runId,
    search: input.localProof.search,
    signals: input.localProof.signals,
    sourceFamilyCoverage: input.localProof.sourceFamilyCoverage,
    sourceRootCount: input.localProof.sourceRootCount,
  },
  preflight: {
    checks: input.preflight.checks.map((check) => ({
      checkId: check.checkId,
      message: check.message,
      required: check.required,
      requiredFor: check.requiredFor,
      status: check.status,
    })),
    generatedAt: input.preflight.generatedAt,
    relayCapability: input.preflight.relayCapability,
    requiredActions: input.preflight.requiredActions,
    status: input.preflight.status,
    workerUrl: input.preflight.workerUrl,
  },
  redacted: true,
  runReceipt: {
    blockedReasons: input.runReceipt.blockedReasons,
    checkedAt: input.runReceipt.checkedAt,
    preflight: input.runReceipt.preflight,
    request: {
      planProposal: input.runReceipt.request.planProposal,
      runId: input.runReceipt.request.runId,
      workItemId: input.runReceipt.request.workItemId,
    },
    requestPath: input.runReceipt.requestPath,
    runId: input.runReceipt.runId,
    status: input.runReceipt.status,
    submit: input.runReceipt.submit,
    workerUrl: input.runReceipt.workerUrl,
  },
  schemaVersion: "workflow.readiness-report.receipts.v1",
});

const writeText = async (path: string, value: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, "utf-8");
};

const publishArgsFor = (input: WzrrdPublishCommandInput): readonly string[] => [
  "publish",
  "--file",
  input.siteDir,
  "--slug",
  input.slug,
  "--expires-in",
  input.expiresIn,
  "--non-interactive",
];

const runWzrrdPublishCommand = (
  input: WzrrdPublishCommandInput
): Promise<WzrrdCliPublishResult> => {
  const args = publishArgsFor(input);
  const result = spawnSync(input.wzrrdBin, args, {
    cwd: input.repoRoot,
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    throw new Error(
      `wzrrd publish failed with exit ${String(result.status)}: ${result.stderr.trim()}`
    );
  }

  return Promise.resolve(
    WzrrdCliPublishResultSchema.parse(JSON.parse(result.stdout.trim()))
  );
};

const publishWorkflowReadinessReport = async (input: {
  readonly command?: (
    commandInput: WzrrdPublishCommandInput
  ) => Promise<WzrrdCliPublishResult>;
  readonly expiresIn: string;
  readonly now: () => string;
  readonly receipt: WorkflowReadinessReportReceipt;
  readonly repoRoot: string;
  readonly slug: string;
  readonly wzrrdBin: string;
}): Promise<WorkflowReadinessReportPublishReceipt> => {
  const commandInput: WzrrdPublishCommandInput = {
    expiresIn: input.expiresIn,
    repoRoot: input.repoRoot,
    siteDir: input.receipt.siteDir,
    slug: input.slug,
    wzrrdBin: input.wzrrdBin,
  };
  const command = [input.wzrrdBin, ...publishArgsFor(commandInput)];
  const publishResult = await (input.command ?? runWzrrdPublishCommand)(
    commandInput
  );
  if (publishResult.result.slug !== input.slug) {
    throw new Error("wzrrd returned a slug that did not match the request.");
  }

  const publishReceiptPath = join(
    input.receipt.siteDir,
    "publish-receipt.json"
  );
  const publishReceipt = WorkflowReadinessReportPublishReceiptSchema.parse({
    command,
    expiresIn: input.expiresIn,
    htmlHash: input.receipt.htmlHash,
    mdsvxHash: input.receipt.mdsvxHash,
    publishReceiptPath,
    publishedAt: input.now(),
    redacted: true,
    renderReceiptPath: input.receipt.receiptPath,
    result: {
      bytes: publishResult.result.bytes,
      ...(publishResult.result.deleteAfter === undefined
        ? {}
        : { deleteAfter: publishResult.result.deleteAfter }),
      ...(publishResult.result.expiresAt === undefined
        ? {}
        : { expiresAt: publishResult.result.expiresAt }),
      fileCount: publishResult.result.fileCount,
      indexing: publishResult.result.indexing,
      lifecycle: publishResult.result.lifecycle,
      slug: publishResult.result.slug,
      status: publishResult.result.status,
      url: publishResult.result.url,
    },
    runId: input.receipt.runId,
    schemaVersion: "workflow.readiness-report.publish.v1",
    siteDir: input.receipt.siteDir,
    slug: input.slug,
    status: "published",
  });
  await writeText(
    publishReceiptPath,
    `${JSON.stringify(publishReceipt, null, 2)}\n`
  );

  return publishReceipt;
};

export const renderWorkflowReadinessReport = async (input: {
  readonly outRoot: string;
  readonly report: WorkflowReadinessReportInput;
}): Promise<WorkflowReadinessReportReceipt> => {
  const siteDir = resolve(input.outRoot, input.report.runReceipt.runId);
  const definitionOfDoneAuditPath = join(
    siteDir,
    "definition-of-done-audit.json"
  );
  const reportPath = join(siteDir, "report.mdsvx");
  const indexPath = join(siteDir, "index.html");
  const receiptsPath = join(siteDir, "receipts.json");
  const receiptPath = join(siteDir, "render-receipt.json");
  const audit = buildWorkflowDefinitionOfDoneAudit(input.report);
  const mdsvx = renderWorkflowReadinessReportMdsvx(input.report);
  const html = renderWorkflowReadinessReportHtml({
    generatedAt: input.report.generatedAt,
    mdsvx,
    runId: input.report.runReceipt.runId,
    title: `${input.report.profile.title} readiness report`,
  });
  const compactReceipts = compactReceiptsFor(input.report, audit);

  await writeText(
    definitionOfDoneAuditPath,
    `${JSON.stringify(audit, null, 2)}\n`
  );
  await writeText(reportPath, `${mdsvx}\n`);
  await writeText(indexPath, `${html}\n`);
  await writeText(
    receiptsPath,
    `${JSON.stringify(compactReceipts, null, 2)}\n`
  );

  const receipt = WorkflowReadinessReportReceiptSchema.parse({
    definitionOfDoneAuditPath,
    generatedAt: input.report.generatedAt,
    htmlHash: sha256Hex(html),
    indexPath,
    localProofRunId: input.report.localProof.runId,
    mdsvxHash: sha256Hex(mdsvx),
    receiptPath,
    receiptsPath,
    redacted: true,
    reportPath,
    runId: input.report.runReceipt.runId,
    schemaVersion: "workflow.readiness-report.v1",
    siteDir,
    status: "rendered",
    summary: {
      blockerCount: input.report.runReceipt.blockedReasons.length,
      correlationEdgeCount: input.report.localProof.correlation.edgeCount,
      hydratedReceiptCount: input.report.localProof.search.hydratedCount,
      localProofStatus: "passed",
      sourceRootCount: input.report.localProof.sourceRootCount,
      submitAttempted: input.report.runReceipt.submit.attempted,
    },
  });
  await writeText(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  return receipt;
};

export const runWorkflowReadinessReportCli = async (
  input: RunWorkflowReadinessReportCliInput
): Promise<WorkflowReadinessReportReceipt> => {
  const profile = requireInstalledSourceProfile(input.argv, {
    repoRoot: input.repoRoot,
  });
  const args = parseArgs(input.argv, profile);
  const localProofPath = resolve(input.repoRoot, args.localProofPath);
  const preflightPath = resolve(input.repoRoot, args.preflightPath);
  const runReceiptPath = resolve(
    input.repoRoot,
    args.runReceiptPath ??
      (await latestRunReceiptPath(resolve(input.repoRoot, args.runReceiptDir)))
  );
  const reportInput: WorkflowReadinessReportInput = {
    generatedAt: input.now?.() ?? new Date().toISOString(),
    localProof: LocalRelayProofReceiptSchema.parse(
      await readJsonFile(localProofPath)
    ),
    preflight: WorkflowLivePreflightReceiptSchema.parse(
      await readJsonFile(preflightPath)
    ),
    profile,
    runReceipt: WorkflowLiveRunRequestReceiptSchema.parse(
      await readJsonFile(runReceiptPath)
    ),
  };
  if (reportInput.runReceipt.submit.attempted) {
    throw new Error(
      "Workflow readiness report only renders blocked/pre-submit receipts."
    );
  }

  const receipt = await renderWorkflowReadinessReport({
    outRoot: resolve(input.repoRoot, args.outRoot),
    report: reportInput,
  });
  const finalReceiptPath =
    args.receiptPath === undefined
      ? receipt.receiptPath
      : resolve(input.repoRoot, args.receiptPath);
  if (finalReceiptPath !== receipt.receiptPath) {
    await writeText(finalReceiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  }

  const log = input.log ?? console.log;
  log(JSON.stringify(receipt, null, 2));
  log(`wrote ${receipt.siteDir}`);
  const publishSlug =
    args.publishSlug ?? basename(receipt.siteDir).toLowerCase();
  if (args.publish) {
    const publishReceipt = await publishWorkflowReadinessReport({
      ...(input.publishCommand === undefined
        ? {}
        : { command: input.publishCommand }),
      expiresIn: args.publishExpiresIn,
      now: input.now ?? (() => new Date().toISOString()),
      receipt,
      repoRoot: input.repoRoot,
      slug: publishSlug,
      wzrrdBin: args.wzrrdBin,
    });
    log(JSON.stringify(publishReceipt, null, 2));
    log(`published ${publishReceipt.result.url}`);
    log(`publish receipt ${publishReceipt.publishReceiptPath}`);
  } else {
    log(
      `publish: ${args.wzrrdBin} publish --file ${receipt.siteDir} --slug ${publishSlug} --expires-in ${args.publishExpiresIn} --non-interactive`
    );
  }

  return receipt;
};

if (isMain()) {
  try {
    await runWorkflowReadinessReportCli({
      argv: process.argv.slice(2),
      repoRoot: resolve(import.meta.dirname, ".."),
    });
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "Workflow readiness report failed."
    );
    process.exitCode = 1;
  }
}
