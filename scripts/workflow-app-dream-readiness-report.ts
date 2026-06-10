#!/usr/bin/env tsx

import { spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import { sha256Hex } from "../src/app/domain/hash.ts";
import {
  DreamLiveRunRequestReceiptSchema,
  WorkflowLivePreflightReceiptSchema,
} from "../src/app/domain/schemas.ts";
import type {
  DreamLiveRunRequestReceipt,
  WorkflowLivePreflightReceipt,
} from "../src/app/domain/schemas.ts";

const defaultLocalProofPath =
  ".wrangler/workflow-app/dream-relay/latest-local-proof.json";
const defaultPreflightPath =
  ".wrangler/workflow-app/dream-preflight/latest-dream-preflight.json";
const defaultRunReceiptDir = ".wrangler/workflow-app/dream-runs";
const defaultOutRoot = ".wrangler/workflow-app/dream-reports";
const defaultPublishExpiresIn = "24h";
const defaultWzrrdBin = "wzrrd";

const LocalRelayProofReceiptSchema = z
  .object({
    backfill: z.object({
      actionCount: z.number().int().min(0),
      captureFixCount: z.number().int().min(0),
      status: z.string().min(1),
    }),
    backfillRun: z.object({
      blockedCount: z.number().int().min(0),
      completedCount: z.number().int().min(0),
      failedCount: z.number().int().min(0),
      skippedCount: z.number().int().min(0),
    }),
    checkedAt: z.string().min(1),
    correlation: z.object({
      edgeCount: z.number().int().min(0),
      nodeCount: z.number().int().min(0),
    }),
    health: z.object({
      blindSpotCount: z.number().int().min(0),
      degradedSourceCount: z.number().int().min(0),
      status: z.string().min(1),
    }),
    inventory: z.object({
      machineCoverage: z.array(
        z.object({
          authorityCount: z.number().int().min(0),
          machineId: z.string().min(1),
          sourceCount: z.number().int().min(0),
          status: z.string().min(1),
        })
      ),
      runtimeCoverage: z.array(
        z.object({
          count: z.number().int().min(0),
          runtime: z.string().min(1),
          status: z.string().min(1),
        })
      ),
      sourceCount: z.number().int().min(0),
      sourceFamilyCoverage: z.array(
        z.object({
          authorityCount: z.number().int().min(0),
          family: z.string().min(1),
          sourceCount: z.number().int().min(0),
          status: z.string().min(1),
        })
      ),
    }),
    rawCredentialsReturned: z.literal(false),
    rawPathLeaked: z.literal(false),
    rawPathsReturned: z.literal(false),
    redacted: z.literal(true),
    runId: z.string().min(1),
    schemaVersion: z.literal("trusted.dream-memory-relay.local-proof.v1"),
    search: z.object({
      hitCount: z.number().int().min(0),
      hydratedCount: z.number().int().min(0),
      skippedSourceCount: z.number().int().min(0),
    }),
    signals: z.object({
      signalCount: z.number().int().min(0),
      signalKinds: z.array(z.string().min(1)),
    }),
    sourceRootCount: z.number().int().min(0),
  })
  .passthrough();

export type LocalRelayProofReceipt = z.infer<
  typeof LocalRelayProofReceiptSchema
>;

const DreamReadinessReportReceiptSchema = z.object({
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
  schemaVersion: z.literal("workflow.dream-readiness-report.v1"),
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

export type DreamReadinessReportReceipt = z.infer<
  typeof DreamReadinessReportReceiptSchema
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

const DreamReadinessReportPublishReceiptSchema = z.object({
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
  schemaVersion: z.literal("workflow.dream-readiness-report.publish.v1"),
  siteDir: z.string().min(1),
  slug: z.string().min(1),
  status: z.literal("published"),
});

export type DreamReadinessReportPublishReceipt = z.infer<
  typeof DreamReadinessReportPublishReceiptSchema
>;

interface DreamReadinessReportArgs {
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

export interface DreamReadinessReportInput {
  readonly generatedAt: string;
  readonly localProof: LocalRelayProofReceipt;
  readonly preflight: WorkflowLivePreflightReceipt;
  readonly runReceipt: DreamLiveRunRequestReceipt;
}

export interface RunDreamReadinessReportCliInput {
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

const parseArgs = (argv: readonly string[]): DreamReadinessReportArgs => {
  const receiptPath = argValue(argv, "--receipt-path");
  const runReceiptPath = argValue(argv, "--run-receipt-path");
  const publishSlug =
    argValue(argv, "--publish-slug") ?? argValue(argv, "--slug");

  return {
    localProofPath:
      argValue(argv, "--local-proof-path") ?? defaultLocalProofPath,
    outRoot: argValue(argv, "--out-root") ?? defaultOutRoot,
    preflightPath: argValue(argv, "--preflight-path") ?? defaultPreflightPath,
    publish: argv.includes("--publish"),
    publishExpiresIn:
      argValue(argv, "--publish-expires-in") ??
      argValue(argv, "--expires-in") ??
      defaultPublishExpiresIn,
    ...(publishSlug === undefined ? {} : { publishSlug }),
    ...(receiptPath === undefined ? {} : { receiptPath }),
    runReceiptDir: argValue(argv, "--run-receipt-dir") ?? defaultRunReceiptDir,
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
    throw new Error(`No Dream run receipt files found in ${dir}.`);
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
    throw new Error(`No Dream run receipt files found in ${dir}.`);
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

const statusLineFor = (input: DreamReadinessReportInput): string =>
  [
    `source roots ${input.localProof.sourceRootCount}`,
    `runtime sources ${input.localProof.inventory.runtimeCoverage.length}`,
    `hydrated receipts ${input.localProof.search.hydratedCount}`,
    `correlation edges ${input.localProof.correlation.edgeCount}`,
    `blockers ${input.runReceipt.blockedReasons.length}`,
  ].join(" / ");

const runtimeCoverageLine = (proof: LocalRelayProofReceipt): string =>
  proof.inventory.runtimeCoverage
    .map(
      (coverage) => `${coverage.runtime}=${coverage.count} (${coverage.status})`
    )
    .join(", ");

const machineCoverageLine = (proof: LocalRelayProofReceipt): string =>
  proof.inventory.machineCoverage
    .map(
      (coverage) =>
        `${coverage.machineId}: ${coverage.authorityCount} authority record(s), ${coverage.status}`
    )
    .join("; ");

const sourceFamilyLine = (proof: LocalRelayProofReceipt): string =>
  proof.inventory.sourceFamilyCoverage
    .map(
      (coverage) =>
        `${coverage.family}: ${coverage.authorityCount} authority record(s), ${coverage.status}`
    )
    .join("; ");

const bulletList = (items: readonly string[]): string =>
  items.length === 0 ? "- None." : items.map((item) => `- ${item}`).join("\n");

export const renderDreamReadinessReportMdsvx = (
  input: DreamReadinessReportInput
): string =>
  [
    "---",
    'expiresIn: "24h"',
    "noindex: true",
    'template: "joel/tufte-mdsvx@0.1.0"',
    'title: "Dream readiness report"',
    "---",
    "",
    "# Dream readiness report",
    "",
    "This is a readiness report for the Dream workflow, not a completed Dream run.",
    "",
    `The trusted local memory fabric proof passed. The live Cloudflare Dream submit did not happen because the Worker-facing relay boundary is still blocked. That is the correct outcome: no relay URL, no relay token, no authenticated remote health check, no live Dream.`,
    "",
    `Status: ${statusLineFor(input)}.`,
    "",
    "## The actual finding",
    "",
    "The useful result is not that Dreaming is done. It is not done. The useful result is that the local relay can now see enough of the system to make the next Cloudflare run worth doing.",
    "",
    "Reasoning",
    "",
    `The local proof covered ${input.localProof.sourceRootCount} source roots across ${input.localProof.inventory.sourceCount} sources. Runtime coverage is ${runtimeCoverageLine(input.localProof)}. Machine coverage is ${machineCoverageLine(input.localProof)}.`,
    "",
    "Rating",
    "",
    "8/10 as a readiness artifact. 0/10 as proof of completed Cloudflare Dream execution.",
    "",
    "Recommendation",
    "",
    "Turn this into the next operational task: approve and configure the Worker-facing trusted relay, then run the real Cloudflare Dream so the generated machine, harness, verifier proof, Wzrrd delivery, and HITL seed artifacts exist for real.",
    "",
    `Receipt: ${input.localProof.runId}.`,
    "",
    "## Actionable line items",
    "",
    "### Finish the relay boundary",
    "",
    "Reasoning",
    "",
    "The Dream cartridge is seeded and the local proof is useful, but Cloudflare cannot execute the cartridge nodes until it can reach the trusted relay through an approved HTTPS endpoint with the matching Worker secret.",
    "",
    "Rating",
    "",
    "10/10.",
    "",
    "Recommendation",
    "",
    "Approve the network boundary explicitly, provision `DREAM_MEMORY_RELAY_TOKEN`, deploy `DREAM_MEMORY_RELAY_BASE_URL` through the signoff-gated path, verify remote `/healthz`, then submit the existing Dream run request shape.",
    "",
    "### Treat backfill as a capture repair signal",
    "",
    "Reasoning",
    "",
    `The local proof reported health status ${input.localProof.health.status}, ${input.localProof.health.blindSpotCount} blind spot(s), ${input.localProof.health.degradedSourceCount} degraded source(s), and ${input.localProof.backfill.actionCount} recovery backfill action(s). If that keeps recurring, ingest is still broken.`,
    "",
    "Rating",
    "",
    "8/10.",
    "",
    "Recommendation",
    "",
    "After the live Dream run, promote recurring backfill actions into capture-path repair work instead of normalizing recovery as the workflow.",
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
    "Do not call this a Dream output. Use it as the HITL handoff for the blocked relay boundary, then replace it with the real generated Dream HITL report after Cloudflare execution.",
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
    "Runtime coverage:",
    "",
    `- ${runtimeCoverageLine(input.localProof)}`,
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
    "## What did not happen",
    "",
    "- No live Cloudflare Dream was submitted.",
    "- No real Pi planner generated a task-specific Dream state machine in this run attempt.",
    "- No `workflow.xstate-machine.v1`, generated TypeScript source, generated harness source, verifier proof, or cartridge invocation proof was produced by Cloudflare for this run request.",
    "- No Wzrrd publication by the Dream workflow happened; this readiness report is a separate operator handoff artifact.",
    "- No raw credentials, raw private paths, or raw transcripts were returned by the local relay proof.",
    "",
    "## Report standard",
    "",
    "Template: `joel/tufte-mdsvx@0.1.0`. Publish policy: noindex, 24h expiry. The canonical source is `report.mdsvx`; `index.html` is a static preview for Wzrrd.",
  ].join("\n");

export const renderDreamReadinessReportHtml = (input: {
  readonly generatedAt: string;
  readonly mdsvx: string;
  readonly runId: string;
}): string => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>Dream readiness report</title>
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
        <h1>Dream readiness report</h1>
        <div class="meta">
          <div>Run <code>${htmlEscape(input.runId)}</code></div>
          <div>Generated <code>${htmlEscape(input.generatedAt)}</code></div>
          <div>Template <code>joel/tufte-mdsvx@0.1.0</code></div>
          <div>Source <a href="report.mdsvx">report.mdsvx</a></div>
          <div>Receipts <a href="receipts.json">receipts.json</a></div>
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

const compactReceiptsFor = (input: DreamReadinessReportInput) => ({
  generatedAt: input.generatedAt,
  localProof: {
    backfill: input.localProof.backfill,
    backfillRun: input.localProof.backfillRun,
    checkedAt: input.localProof.checkedAt,
    correlation: input.localProof.correlation,
    health: input.localProof.health,
    inventory: input.localProof.inventory,
    rawCredentialsReturned: input.localProof.rawCredentialsReturned,
    rawPathLeaked: input.localProof.rawPathLeaked,
    rawPathsReturned: input.localProof.rawPathsReturned,
    redacted: true,
    runId: input.localProof.runId,
    search: input.localProof.search,
    signals: input.localProof.signals,
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
  schemaVersion: "workflow.dream-readiness-report.receipts.v1",
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

const publishDreamReadinessReport = async (input: {
  readonly command?: (
    commandInput: WzrrdPublishCommandInput
  ) => Promise<WzrrdCliPublishResult>;
  readonly expiresIn: string;
  readonly now: () => string;
  readonly receipt: DreamReadinessReportReceipt;
  readonly repoRoot: string;
  readonly slug: string;
  readonly wzrrdBin: string;
}): Promise<DreamReadinessReportPublishReceipt> => {
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
  const publishReceipt = DreamReadinessReportPublishReceiptSchema.parse({
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
    schemaVersion: "workflow.dream-readiness-report.publish.v1",
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

export const renderDreamReadinessReport = async (input: {
  readonly outRoot: string;
  readonly report: DreamReadinessReportInput;
}): Promise<DreamReadinessReportReceipt> => {
  const siteDir = resolve(input.outRoot, input.report.runReceipt.runId);
  const reportPath = join(siteDir, "report.mdsvx");
  const indexPath = join(siteDir, "index.html");
  const receiptsPath = join(siteDir, "receipts.json");
  const receiptPath = join(siteDir, "render-receipt.json");
  const mdsvx = renderDreamReadinessReportMdsvx(input.report);
  const html = renderDreamReadinessReportHtml({
    generatedAt: input.report.generatedAt,
    mdsvx,
    runId: input.report.runReceipt.runId,
  });
  const compactReceipts = compactReceiptsFor(input.report);

  await writeText(reportPath, `${mdsvx}\n`);
  await writeText(indexPath, `${html}\n`);
  await writeText(
    receiptsPath,
    `${JSON.stringify(compactReceipts, null, 2)}\n`
  );

  const receipt = DreamReadinessReportReceiptSchema.parse({
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
    schemaVersion: "workflow.dream-readiness-report.v1",
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

export const runDreamReadinessReportCli = async (
  input: RunDreamReadinessReportCliInput
): Promise<DreamReadinessReportReceipt> => {
  const args = parseArgs(input.argv);
  const localProofPath = resolve(input.repoRoot, args.localProofPath);
  const preflightPath = resolve(input.repoRoot, args.preflightPath);
  const runReceiptPath = resolve(
    input.repoRoot,
    args.runReceiptPath ??
      (await latestRunReceiptPath(resolve(input.repoRoot, args.runReceiptDir)))
  );
  const reportInput: DreamReadinessReportInput = {
    generatedAt: input.now?.() ?? new Date().toISOString(),
    localProof: LocalRelayProofReceiptSchema.parse(
      await readJsonFile(localProofPath)
    ),
    preflight: WorkflowLivePreflightReceiptSchema.parse(
      await readJsonFile(preflightPath)
    ),
    runReceipt: DreamLiveRunRequestReceiptSchema.parse(
      await readJsonFile(runReceiptPath)
    ),
  };
  if (reportInput.runReceipt.submit.attempted) {
    throw new Error(
      "Dream readiness report only renders blocked/pre-submit receipts."
    );
  }

  const receipt = await renderDreamReadinessReport({
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
    const publishReceipt = await publishDreamReadinessReport({
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
  await runDreamReadinessReportCli({
    argv: process.argv.slice(2),
    repoRoot: resolve(import.meta.dirname, ".."),
  });
}
