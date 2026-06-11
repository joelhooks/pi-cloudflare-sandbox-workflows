/// <reference types="@cloudflare/workers-types" />

import { z } from "zod";

import type {
  ArtifactStoreContract,
  WzrrdPublishCapabilityAdapter,
} from "../application/ports.ts";
import { hashJson, sha256Hex } from "../domain/hash.ts";
import {
  CapabilityLeaseSchema,
  ReviewSurfaceDocumentSchema,
  WzrrdPublishDeliveryResultSchema,
  WzrrdPublishPayloadSchema,
} from "../domain/schemas.ts";
import type {
  CapabilityDenialCode,
  CapabilityLease,
  ReviewSurfaceDocument,
  WzrrdPublishDeliveryResult,
  WzrrdPublishPayload,
  WzrrdResource,
} from "../domain/schemas.ts";

type WzrrdPublishLease = CapabilityLease & {
  readonly capability: "wzrrd.site.publish";
  readonly resource: WzrrdResource;
};

type WzrrdPublishedPrimaryDocument = NonNullable<
  Extract<
    WzrrdPublishDeliveryResult,
    { readonly status: "published" }
  >["primaryDocument"]
>;

export interface WzrrdApiTokenSecretResolver {
  resolve(input: {
    readonly leaseId: string;
    readonly runId: string;
    readonly secretRef: string;
  }): Promise<string | null>;
}

export interface CloudflareWzrrdSecretStringBinding {
  get(): Promise<null | string>;
}

export type CloudflareWzrrdApiTokenBinding =
  | CloudflareWzrrdSecretStringBinding
  | string;

export interface CloudflareWzrrdApiTokenResolverConfig {
  readonly secret: CloudflareWzrrdApiTokenBinding;
  readonly secretRef: string;
}

export interface CloudflareWzrrdPublishAdapterConfig {
  readonly artifacts: Pick<ArtifactStoreContract, "readJson" | "readText">;
  readonly fetch?: typeof fetch;
  readonly now?: () => string;
  readonly primaryDocumentRenderer?: WzrrdPrimaryDocumentRenderer;
  readonly secretResolver: WzrrdApiTokenSecretResolver;
  /**
   * Hard ceiling for the Wzrrd publish round-trip. This call runs late in the
   * finishing envelope; without a bound a stalled wzrrd.sh response hangs the
   * fetch until workerd kills the whole drive invocation (a wedged run the
   * reaper later sweeps with no reason). On timeout the publish returns a clean
   * `adapter_unavailable` blocker the safety envelope records and surfaces.
   */
  readonly timeoutMs?: number;
  readonly userAgent: string;
  readonly wzrrdApiBaseUrl?: string;
  readonly wzrrdPublishSecretRef: string;
}

export interface WzrrdPublishFile {
  readonly content: string;
  readonly path: string;
}

export interface WzrrdPrimaryDocumentRenderInput {
  readonly content: string;
  readonly document: NonNullable<WzrrdPublishPayload["primaryDocument"]>;
  readonly payload: WzrrdPublishPayload;
  readonly reviewSurface: ReviewSurfaceDocument;
}

export interface WzrrdPrimaryDocumentRenderResult {
  readonly files: readonly WzrrdPublishFile[];
  readonly rendererId: string;
}

export interface WzrrdPrimaryDocumentRenderer {
  render(
    input: WzrrdPrimaryDocumentRenderInput
  ):
    | Promise<WzrrdPrimaryDocumentRenderResult>
    | WzrrdPrimaryDocumentRenderResult;
}

const WzrrdApiPublishResponseSchema = z.object({
  ok: z.literal(true),
  site: z.looseObject({
    createdAt: z.string().min(1).optional(),
    slug: z.string().min(1),
    updatedAt: z.string().min(1).optional(),
    url: z.url(),
  }),
});

const defaultWzrrdApiBaseUrl = "https://wzrrd.sh";

const DEFAULT_WZRRD_TIMEOUT_MS = 30_000;

const blocked = (
  code: CapabilityDenialCode,
  message: string
): WzrrdPublishDeliveryResult =>
  WzrrdPublishDeliveryResultSchema.parse({
    blocker: {
      code,
      message,
      redacted: true,
    },
    status: "blocked",
  });

const isWzrrdPublishLease = (
  lease: CapabilityLease
): lease is WzrrdPublishLease =>
  lease.capability === "wzrrd.site.publish" &&
  lease.resource.kind === "wzrrd.site";

const deliveryForDryRun = (input: {
  readonly lease: WzrrdPublishLease;
  readonly payload: WzrrdPublishPayload;
  readonly payloadHash: string;
}): WzrrdPublishDeliveryResult =>
  WzrrdPublishDeliveryResultSchema.parse({
    dryRun: true,
    payloadHash: input.payloadHash,
    redacted: true,
    reviewSurfaceRef: input.payload.reviewSurface.artifactRef,
    slug: input.lease.resource.slug,
    status: "dry-run",
    url: `https://${input.lease.resource.slug}.wzrrd.sh/`,
  });

const validateLeasePayloadBinding = (input: {
  readonly lease: WzrrdPublishLease;
  readonly payload: WzrrdPublishPayload;
  readonly payloadHash: string;
}): null | WzrrdPublishDeliveryResult => {
  if (input.payloadHash !== input.lease.payloadHash) {
    return blocked(
      "payload_hash_mismatch",
      "Wzrrd publish payload no longer matches the lease."
    );
  }

  if (input.payload.slug !== input.lease.resource.slug) {
    return blocked(
      "resource_scope_denied",
      "Wzrrd publish payload slug does not match the leased site resource."
    );
  }

  return null;
};

const blockerForWzrrdStatus = (status: number): WzrrdPublishDeliveryResult => {
  if (status === 401 || status === 403) {
    return blocked("secret_denied", "Wzrrd rejected the configured API token.");
  }

  if (status === 429) {
    return blocked(
      "adapter_unavailable",
      "Wzrrd API rate limited the leased site publication."
    );
  }

  return blocked(
    "adapter_unavailable",
    `Wzrrd API rejected the leased site publication with HTTP ${status}.`
  );
};

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const slugForHeading = (value: string): string => {
  const slug = value
    .toLowerCase()
    .replaceAll(/`([^`]+)`/gu, "$1")
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-|-$/gu, "");

  return slug.length === 0 ? "section" : slug;
};

const renderInlineMarkdown = (value: string): string =>
  escapeHtml(value)
    .replaceAll(/\*\*([^*]+)\*\*/gu, "<strong>$1</strong>")
    .replaceAll(/`([^`]+)`/gu, "<code>$1</code>");

const stripFrontMatter = (content: string): string => {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/u.exec(content);

  return match === null ? content : content.slice(match[0].length);
};

const frontMatterBlockFor = (content: string): string | null => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u.exec(content);

  return match?.[1] ?? null;
};

const unquoteScalar = (value: string): string =>
  value.trim().replaceAll(/^["']|["']$/gu, "");

const frontMatterScalarFor = (input: {
  readonly content: string;
  readonly key: string;
}): string | null => {
  const frontMatter = frontMatterBlockFor(input.content);
  if (frontMatter === null) {
    return null;
  }

  const pattern = new RegExp(`^${input.key}:\\s*(.+)$`, "mu");
  const match = pattern.exec(frontMatter);

  return match?.[1] === undefined ? null : unquoteScalar(match[1]);
};

interface D2FigureDirective {
  readonly aspectRatio?: string;
  readonly machineId?: string;
  readonly sourceKind?: string;
  readonly stateCount?: string;
  readonly title?: string;
  readonly transitionCount?: string;
}

const parseD2FigureDirective = (line: string): D2FigureDirective | null => {
  if (!/^<D2Fig(?:\s|>)/u.test(line.trim())) {
    return null;
  }

  const attrs: Record<string, string> = {};
  const attributePattern = /([A-Za-z][A-Za-z0-9]*)=(?:"([^"]*)"|\{(\d+)\})/gu;
  let match: RegExpExecArray | null;
  while ((match = attributePattern.exec(line)) !== null) {
    const [, key, quotedValue, numericValue] = match;
    const value = quotedValue ?? numericValue;
    if (key !== undefined && value !== undefined) {
      attrs[key] = value;
    }
  }

  return {
    ...(attrs["aspectRatio"] === undefined
      ? {}
      : { aspectRatio: attrs["aspectRatio"] }),
    ...(attrs["machineId"] === undefined
      ? {}
      : { machineId: attrs["machineId"] }),
    ...(attrs["sourceKind"] === undefined
      ? {}
      : { sourceKind: attrs["sourceKind"] }),
    ...(attrs["stateCount"] === undefined
      ? {}
      : { stateCount: attrs["stateCount"] }),
    ...(attrs["title"] === undefined ? {} : { title: attrs["title"] }),
    ...(attrs["transitionCount"] === undefined
      ? {}
      : { transitionCount: attrs["transitionCount"] }),
  };
};

const cssAspectRatioFor = (aspectRatio: string | undefined): string | null => {
  if (aspectRatio === undefined) {
    return null;
  }

  const match = /^([1-9]\d*):([1-9]\d*)$/u.exec(aspectRatio);

  return match === null ? null : `${match[1]} / ${match[2]}`;
};

const templateLabelFor = (
  template: NonNullable<
    NonNullable<WzrrdPublishPayload["primaryDocument"]>["template"]
  >
): string => `${template.templateId}@${template.version}`;

const validatePrimaryDocumentTemplate = (input: {
  readonly content: string;
  readonly document: NonNullable<WzrrdPublishPayload["primaryDocument"]>;
}): null | WzrrdPublishDeliveryResult => {
  if (
    input.document.template === undefined ||
    input.document.mediaType !== "text/mdsvx"
  ) {
    return null;
  }

  const expectedTemplate = templateLabelFor(input.document.template);
  const declaredTemplate = frontMatterScalarFor({
    content: input.content,
    key: "template",
  });

  if (declaredTemplate !== expectedTemplate) {
    return blocked(
      "capability_denied",
      "Wzrrd primary MDSvX document does not match the declared report template."
    );
  }

  return null;
};

const renderCodeBlock = (input: {
  readonly code: string;
  readonly d2Figure?: D2FigureDirective;
  readonly language: string;
}): string => {
  const language = input.language.toLowerCase();
  if (language === "d2") {
    const title = input.d2Figure?.title ?? "Workflow state machine";
    const aspectRatio = cssAspectRatioFor(input.d2Figure?.aspectRatio);
    const style =
      aspectRatio === null
        ? ""
        : ` style="--flow-chart-aspect-ratio:${escapeHtml(aspectRatio)}"`;
    const dataAttributes = [
      'data-component="D2Fig"',
      ...(input.d2Figure?.aspectRatio === undefined
        ? []
        : [`data-aspect-ratio="${escapeHtml(input.d2Figure.aspectRatio)}"`]),
      ...(input.d2Figure?.machineId === undefined
        ? []
        : [`data-machine-id="${escapeHtml(input.d2Figure.machineId)}"`]),
      ...(input.d2Figure?.sourceKind === undefined
        ? []
        : [`data-source-kind="${escapeHtml(input.d2Figure.sourceKind)}"`]),
      ...(input.d2Figure?.stateCount === undefined
        ? []
        : [`data-state-count="${escapeHtml(input.d2Figure.stateCount)}"`]),
      ...(input.d2Figure?.transitionCount === undefined
        ? []
        : [
            `data-transition-count="${escapeHtml(
              input.d2Figure.transitionCount
            )}"`,
          ]),
    ].join(" ");

    return `<figure class="flow-chart" ${dataAttributes} aria-label="${escapeHtml(title)}"${style}>
      <pre class="d2-source"><code>${escapeHtml(input.code)}</code></pre>
      <figcaption><strong>${escapeHtml(title)}</strong> - D2 source from the pinned report artifact. The canonical <code>.mdsvx</code> source is published beside this preview.</figcaption>
    </figure>`;
  }

  const label =
    language.length === 0 ? "Source" : `${language.toUpperCase()} source`;

  return `<figure class="code-block">
    <figcaption>${escapeHtml(label)}</figcaption>
    <pre><code>${escapeHtml(input.code)}</code></pre>
  </figure>`;
};

interface MarkdownCodeBlock {
  readonly d2Figure?: D2FigureDirective;
  readonly language: string;
  lines: string[];
}

interface MarkdownSubsetRenderState {
  readonly headingIds: Map<string, number>;
  readonly html: string[];
  listItems: string[];
  paragraph: string[];
}

const flushParagraph = (state: MarkdownSubsetRenderState): void => {
  if (state.paragraph.length === 0) {
    return;
  }

  state.html.push(`<p>${renderInlineMarkdown(state.paragraph.join(" "))}</p>`);
  state.paragraph = [];
};

const flushList = (state: MarkdownSubsetRenderState): void => {
  if (state.listItems.length === 0) {
    return;
  }

  state.html.push(
    `<ul>${state.listItems
      .map((item) => `<li>${renderInlineMarkdown(item)}</li>`)
      .join("")}</ul>`
  );
  state.listItems = [];
};

const flushTextBlocks = (state: MarkdownSubsetRenderState): void => {
  flushParagraph(state);
  flushList(state);
};

const renderCompletedCodeBlock = (codeBlock: MarkdownCodeBlock): string =>
  renderCodeBlock({
    code: `${codeBlock.lines.join("\n")}\n`,
    ...(codeBlock.d2Figure === undefined
      ? {}
      : { d2Figure: codeBlock.d2Figure }),
    language: codeBlock.language,
  });

const advanceCodeBlock = (input: {
  readonly codeBlock: MarkdownCodeBlock;
  readonly html: string[];
  readonly line: string;
}): MarkdownCodeBlock | undefined => {
  if (input.line.startsWith("```")) {
    input.html.push(renderCompletedCodeBlock(input.codeBlock));

    return undefined;
  }

  input.codeBlock.lines.push(input.line);

  return input.codeBlock;
};

const renderMarkdownSubset = (content: string): string => {
  const lines = stripFrontMatter(content).replaceAll("\r\n", "\n").split("\n");
  const state: MarkdownSubsetRenderState = {
    headingIds: new Map<string, number>(),
    html: [],
    listItems: [],
    paragraph: [],
  };
  let codeBlock: MarkdownCodeBlock | undefined;
  let pendingD2Figure: D2FigureDirective | undefined;

  for (const line of lines) {
    if (codeBlock !== undefined) {
      codeBlock = advanceCodeBlock({
        codeBlock,
        html: state.html,
        line,
      });
      continue;
    }

    const d2Figure = parseD2FigureDirective(line);
    if (d2Figure !== null) {
      flushTextBlocks(state);
      pendingD2Figure = d2Figure;
      continue;
    }

    if (line.trim() === "</D2Fig>") {
      flushTextBlocks(state);
      pendingD2Figure = undefined;
      continue;
    }

    const fence = /^```([a-z0-9_-]*)\s*$/iu.exec(line);
    if (fence !== null) {
      flushTextBlocks(state);
      const language = fence[1] ?? "";
      codeBlock = {
        ...(language.toLowerCase() === "d2" && pendingD2Figure !== undefined
          ? { d2Figure: pendingD2Figure }
          : {}),
        language,
        lines: [],
      };
      pendingD2Figure = undefined;
      continue;
    }

    if (line.trim().length === 0) {
      flushTextBlocks(state);
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/u.exec(line);
    if (heading !== null) {
      flushTextBlocks(state);
      const level = heading[1]?.length ?? 2;
      const text = heading[2] ?? "";
      const baseId = slugForHeading(text);
      const nextCount = (state.headingIds.get(baseId) ?? 0) + 1;
      state.headingIds.set(baseId, nextCount);
      const id = nextCount === 1 ? baseId : `${baseId}-${nextCount}`;
      state.html.push(
        `<h${level} id="${escapeHtml(id)}">${renderInlineMarkdown(text)}</h${level}>`
      );
      continue;
    }

    const listItem = /^[-*]\s+(.+)$/u.exec(line);
    if (listItem !== null) {
      flushParagraph(state);
      state.listItems.push(listItem[1] ?? "");
      continue;
    }

    flushList(state);
    state.paragraph.push(line.trim());
  }

  if (codeBlock !== undefined) {
    state.html.push(renderCompletedCodeBlock(codeBlock));
  }

  flushTextBlocks(state);

  return state.html.join("\n");
};

const renderLinkList = (
  refs: readonly { readonly title: string; readonly url: string }[]
): string => {
  if (refs.length === 0) {
    return '<p class="muted">No external acceptance refs configured.</p>';
  }

  return `<ul>${refs
    .map(
      (ref) =>
        `<li><a href="${escapeHtml(ref.url)}">${escapeHtml(ref.title)}</a></li>`
    )
    .join("")}</ul>`;
};

const renderProposalReconciliationRequirements = (
  reconciliation: ReviewSurfaceDocument["definitionOfDone"]["reconciliation"]
): string =>
  `<ul>${reconciliation.requirements
    .map(
      (requirement) =>
        `<li><code>${escapeHtml(requirement.requirementId)}</code> <strong>${escapeHtml(requirement.status)}</strong> - ${escapeHtml(requirement.summary)} <span class="muted">(${requirement.evidenceRefs.length} evidence refs)</span></li>`
    )
    .join("")}</ul>`;

const renderReviewSurfaceHtml = (input: {
  readonly payload: WzrrdPublishPayload;
  readonly reviewSurface: ReviewSurfaceDocument;
}): string => {
  const latestEvent = input.reviewSurface.eventLog.at(-1);
  const json = JSON.stringify(input.reviewSurface, null, 2);
  const capabilityRows = input.reviewSurface.capabilityReceipts
    .map(
      (receipt) =>
        `<tr><td>${escapeHtml(receipt.capability)}</td><td>${escapeHtml(receipt.delivery.status)}</td><td>${escapeHtml(receipt.receiptRef)}</td></tr>`
    )
    .join("");
  const packageRows = input.reviewSurface.packages
    .map(
      (packageRef) =>
        `<tr><td>${escapeHtml(packageRef.packageId)}</td><td>${escapeHtml(packageRef.version)}</td><td>${escapeHtml(packageRef.manifestHash.slice(0, 16))}</td></tr>`
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>${escapeHtml(input.payload.title)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f7f4;
      --ink: #161616;
      --muted: #5d6360;
      --line: #d8d9d2;
      --panel: #ffffff;
      --accent: #0f766e;
      --warn: #a16207;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      background: var(--bg);
      color: var(--ink);
      margin: 0;
    }
    header, main {
      margin: 0 auto;
      max-width: 1120px;
      padding: 32px 20px;
    }
    header {
      border-bottom: 1px solid var(--line);
      padding-top: 40px;
    }
    h1 {
      font-size: clamp(2rem, 5vw, 4rem);
      line-height: 1;
      margin: 8px 0 16px;
    }
    h2 {
      font-size: 1rem;
      margin: 0 0 12px;
      text-transform: uppercase;
    }
    p { line-height: 1.55; }
    a { color: var(--accent); }
    .eyebrow {
      color: var(--muted);
      font-size: 0.82rem;
      font-weight: 700;
      letter-spacing: 0;
      text-transform: uppercase;
    }
    .meta {
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      margin-top: 24px;
    }
    .tile {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 14px;
    }
    .label {
      color: var(--muted);
      display: block;
      font-size: 0.78rem;
      margin-bottom: 6px;
      text-transform: uppercase;
    }
    code, pre {
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      font-size: 0.82rem;
    }
    code {
      overflow-wrap: anywhere;
    }
    section {
      border-bottom: 1px solid var(--line);
      padding: 24px 0;
    }
    table {
      border-collapse: collapse;
      width: 100%;
    }
    th, td {
      border-bottom: 1px solid var(--line);
      padding: 10px 8px;
      text-align: left;
      vertical-align: top;
    }
    th {
      color: var(--muted);
      font-size: 0.78rem;
      text-transform: uppercase;
    }
    pre {
      background: #101312;
      border-radius: 6px;
      color: #f7f7f4;
      max-height: 70vh;
      overflow: auto;
      padding: 16px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .muted { color: var(--muted); }
    .status {
      color: var(--warn);
      font-weight: 700;
    }
  </style>
</head>
<body>
  <header>
    <div class="eyebrow">Leased Wzrrd review surface</div>
    <h1>${escapeHtml(input.payload.title)}</h1>
    <p>This public page was rendered from the redacted <code>workflow.review-surface.v1</code> artifact and published through a <code>wzrrd.site.publish</code> capability lease.</p>
    <div class="meta">
      <div class="tile"><span class="label">Run</span><code>${escapeHtml(input.reviewSurface.runId)}</code></div>
      <div class="tile"><span class="label">Work item</span><code>${escapeHtml(input.reviewSurface.workItemId)}</code></div>
      <div class="tile"><span class="label">Latest state</span><span class="status">${escapeHtml(latestEvent?.state ?? "unknown")}</span></div>
      <div class="tile"><span class="label">Generated</span><code>${escapeHtml(input.reviewSurface.generatedAt)}</code></div>
    </div>
  </header>
  <main>
    <section>
      <h2>Definition Of Done</h2>
      <p>${escapeHtml(input.reviewSurface.definitionOfDone.reconciliation.summary)}</p>
      <p><strong>Proposal reconciliation:</strong> ${escapeHtml(input.reviewSurface.definitionOfDone.reconciliation.status)}</p>
      ${renderProposalReconciliationRequirements(input.reviewSurface.definitionOfDone.reconciliation)}
      <p><strong>Observability:</strong> ${escapeHtml(input.reviewSurface.definitionOfDone.observability.status)} - ${escapeHtml(input.reviewSurface.definitionOfDone.observability.summary)}</p>
      ${renderLinkList(input.reviewSurface.definitionOfDone.acceptanceRefs)}
    </section>
    <section>
      <h2>Artifacts</h2>
      <div class="meta">
        <div class="tile"><span class="label">Plan</span><code>${escapeHtml(input.reviewSurface.plan.artifactRef)}</code></div>
        <div class="tile"><span class="label">Machine</span><code>${escapeHtml(input.reviewSurface.generatedArtifacts.machine.artifactRef)}</code></div>
        <div class="tile"><span class="label">Harness</span><code>${escapeHtml(input.reviewSurface.generatedArtifacts.harness.artifactRef)}</code></div>
        <div class="tile"><span class="label">Verification contract</span><code>${escapeHtml(input.reviewSurface.generatedArtifacts.verificationContract.artifactRef)}</code></div>
      </div>
    </section>
    <section>
      <h2>Capability Receipts</h2>
      <table>
        <thead><tr><th>Capability</th><th>Status</th><th>Receipt</th></tr></thead>
        <tbody>${capabilityRows || '<tr><td colspan="3" class="muted">No capability receipts in this review surface.</td></tr>'}</tbody>
      </table>
    </section>
    <section>
      <h2>Packages</h2>
      <table>
        <thead><tr><th>Package</th><th>Version</th><th>Manifest Hash</th></tr></thead>
        <tbody>${packageRows}</tbody>
      </table>
    </section>
    <section id="json">
      <h2>Review Surface JSON</h2>
      <pre>${escapeHtml(json)}</pre>
    </section>
  </main>
</body>
</html>`;
};

const renderPrimaryDocumentHtml = (input: {
  readonly content: string;
  readonly document: NonNullable<WzrrdPublishPayload["primaryDocument"]>;
  readonly payload: WzrrdPublishPayload;
  readonly reviewSurface: ReviewSurfaceDocument;
}): string => {
  const body =
    input.document.mediaType === "text/html"
      ? input.content
      : renderMarkdownSubset(input.content);
  const templateSummary =
    input.document.template === undefined
      ? "untyped primary document template"
      : templateLabelFor(input.document.template);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>${escapeHtml(input.document.title)}</title>
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
    article {
      max-width: 760px;
    }
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
    p, li {
      overflow-wrap: break-word;
    }
    ul {
      padding-left: 1.2rem;
    }
    .meta {
      color: var(--muted);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 0.88rem;
      line-height: 1.5;
    }
    pre {
      background: #fff;
      border: 1px solid var(--line);
      border-radius: 6px;
      overflow: auto;
      padding: 22px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    a { color: var(--accent); }
    a:hover { color: var(--accent-strong); }
    code {
      background: var(--panel);
      border: 1px solid var(--line);
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      font-size: 0.82em;
      padding: 0.04rem 0.28rem;
    }
    pre code {
      background: transparent;
      border: 0;
      display: block;
      padding: 0;
    }
    .flow-chart {
      margin: 42px 0 48px;
    }
    .flow-chart .d2-source {
      aspect-ratio: var(--flow-chart-aspect-ratio, auto);
      max-height: min(72vh, 760px);
    }
    .flow-chart figcaption,
    .code-block figcaption {
      border-top: 1px solid var(--line);
      color: var(--muted);
      font-size: 0.82rem;
      line-height: 1.45;
      margin-top: 12px;
      max-width: 620px;
      padding-top: 10px;
    }
    .flow-chart figcaption strong {
      color: var(--ink);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 0.72rem;
      letter-spacing: 0.9px;
      text-transform: uppercase;
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
        <h1>${escapeHtml(input.document.title)}</h1>
        <div class="meta">
          <div>Run <code>${escapeHtml(input.payload.runId)}</code></div>
          <div>Work item <code>${escapeHtml(input.payload.workItemId)}</code></div>
          <div>Source <a href="${escapeHtml(input.document.path)}">${escapeHtml(input.document.path)}</a></div>
          <div>Template <code>${escapeHtml(templateSummary)}</code></div>
          <div>Review data <a href="review-surface.json">review-surface.json</a></div>
        </div>
      </header>
      ${body}
      <footer>
        Static preview rendered by <code>joel/static-tufte-mdsvx-preview@0.1.0</code> from a hash-pinned redacted artifact using <code>${escapeHtml(templateSummary)}</code>. The canonical report source is published unchanged beside this page.
      </footer>
    </article>
  </main>
</body>
</html>`;
};

export const createStaticTufteMdsvxPrimaryDocumentRenderer =
  (): WzrrdPrimaryDocumentRenderer => ({
    render(input) {
      return {
        files: [
          {
            content: renderPrimaryDocumentHtml(input),
            path: "index.html",
          },
        ],
        rendererId: "joel/static-tufte-mdsvx-preview@0.1.0",
      };
    },
  });

const renderPrimaryDocumentFiles = async (input: {
  readonly content: string;
  readonly document: NonNullable<WzrrdPublishPayload["primaryDocument"]>;
  readonly payload: WzrrdPublishPayload;
  readonly renderer?: WzrrdPrimaryDocumentRenderer;
  readonly reviewSurface: ReviewSurfaceDocument;
}): Promise<
  | {
      readonly files: readonly WzrrdPublishFile[];
      readonly rendererId: string;
      readonly status: "rendered";
    }
  | {
      readonly result: WzrrdPublishDeliveryResult;
      readonly status: "blocked";
    }
> => {
  const renderer =
    input.renderer ?? createStaticTufteMdsvxPrimaryDocumentRenderer();
  let renderResult: WzrrdPrimaryDocumentRenderResult;

  try {
    renderResult = await renderer.render({
      content: input.content,
      document: input.document,
      payload: input.payload,
      reviewSurface: input.reviewSurface,
    });
  } catch {
    return {
      result: blocked(
        "adapter_unavailable",
        "Wzrrd primary document renderer failed while rendering the pinned artifact."
      ),
      status: "blocked",
    };
  }

  const paths = new Set<string>();
  for (const file of renderResult.files) {
    if (file.path.length === 0 || file.content.length === 0) {
      return {
        result: blocked(
          "adapter_unavailable",
          "Wzrrd primary document renderer returned an empty file path or content."
        ),
        status: "blocked",
      };
    }

    if (
      file.path === input.document.path ||
      file.path === "review-surface.json"
    ) {
      return {
        result: blocked(
          "adapter_unavailable",
          "Wzrrd primary document renderer attempted to overwrite publisher-managed files."
        ),
        status: "blocked",
      };
    }

    if (paths.has(file.path)) {
      return {
        result: blocked(
          "adapter_unavailable",
          "Wzrrd primary document renderer returned duplicate file paths."
        ),
        status: "blocked",
      };
    }

    paths.add(file.path);
  }

  if (!paths.has("index.html")) {
    return {
      result: blocked(
        "adapter_unavailable",
        "Wzrrd primary document renderer did not return index.html."
      ),
      status: "blocked",
    };
  }

  return {
    files: renderResult.files,
    rendererId: renderResult.rendererId,
    status: "rendered",
  };
};

const loadPrimaryDocumentContent = async (input: {
  readonly artifacts: Pick<ArtifactStoreContract, "readText">;
  readonly payload: WzrrdPublishPayload;
}): Promise<
  | {
      readonly content: string;
      readonly status: "loaded";
    }
  | {
      readonly result: WzrrdPublishDeliveryResult;
      readonly status: "blocked";
    }
> => {
  const document = input.payload.primaryDocument;
  if (document === undefined) {
    return { content: "", status: "loaded" };
  }

  try {
    const content = await input.artifacts.readText({
      artifactRef: document.artifactRef,
    });
    if (sha256Hex(content) !== document.hash) {
      return {
        result: blocked(
          "payload_hash_mismatch",
          "Wzrrd primary document artifact no longer matches the pinned hash."
        ),
        status: "blocked",
      };
    }

    const templateBlocker = validatePrimaryDocumentTemplate({
      content,
      document,
    });
    if (templateBlocker !== null) {
      return {
        result: templateBlocker,
        status: "blocked",
      };
    }

    return { content, status: "loaded" };
  } catch {
    return {
      result: blocked(
        "adapter_unavailable",
        "Wzrrd publish adapter could not load the pinned primary document artifact."
      ),
      status: "blocked",
    };
  }
};

const filesForWzrrdPublish = async (input: {
  readonly artifacts: Pick<ArtifactStoreContract, "readText">;
  readonly payload: WzrrdPublishPayload;
  readonly renderer?: WzrrdPrimaryDocumentRenderer;
  readonly reviewSurface: ReviewSurfaceDocument;
}): Promise<
  | {
      readonly files: readonly WzrrdPublishFile[];
      readonly primaryDocument?: WzrrdPublishedPrimaryDocument;
      readonly status: "ready";
    }
  | {
      readonly result: WzrrdPublishDeliveryResult;
      readonly status: "blocked";
    }
> => {
  if (input.payload.primaryDocument === undefined) {
    return {
      files: [
        {
          content: renderReviewSurfaceHtml({
            payload: input.payload,
            reviewSurface: input.reviewSurface,
          }),
          path: "index.html",
        },
        {
          content: `${JSON.stringify(input.reviewSurface, null, 2)}\n`,
          path: "review-surface.json",
        },
      ],
      status: "ready",
    };
  }

  const primaryDocumentContent = await loadPrimaryDocumentContent({
    artifacts: input.artifacts,
    payload: input.payload,
  });
  if (primaryDocumentContent.status === "blocked") {
    return primaryDocumentContent;
  }

  const primaryDocumentDescriptor = input.payload.primaryDocument;
  const rendered = await renderPrimaryDocumentFiles({
    content: primaryDocumentContent.content,
    document: primaryDocumentDescriptor,
    payload: input.payload,
    reviewSurface: input.reviewSurface,
    ...(input.renderer === undefined ? {} : { renderer: input.renderer }),
  });
  if (rendered.status === "blocked") {
    return rendered;
  }

  const primaryDocument: WzrrdPublishedPrimaryDocument = {
    artifactRef: primaryDocumentDescriptor.artifactRef,
    hash: primaryDocumentDescriptor.hash,
    mediaType: primaryDocumentDescriptor.mediaType,
    path: primaryDocumentDescriptor.path,
    rendererId: rendered.rendererId,
    ...(primaryDocumentDescriptor.template === undefined
      ? {}
      : { template: primaryDocumentDescriptor.template }),
    title: primaryDocumentDescriptor.title,
  };

  return {
    files: [
      ...rendered.files,
      {
        content: primaryDocumentContent.content,
        path: primaryDocumentDescriptor.path,
      },
      {
        content: `${JSON.stringify(
          {
            primaryDocument,
            redacted: true,
            rendererId: rendered.rendererId,
            runId: input.payload.runId,
            schemaVersion: "wzrrd.primary-document-rendering.v1",
            workItemId: input.payload.workItemId,
          },
          null,
          2
        )}\n`,
        path: "report-rendering.json",
      },
      {
        content: `${JSON.stringify(input.reviewSurface, null, 2)}\n`,
        path: "review-surface.json",
      },
    ],
    primaryDocument,
    status: "ready",
  };
};

const coercePublishedAt = (input: {
  readonly fallback: () => string;
  readonly value?: string | undefined;
}): string => {
  if (input.value === undefined) {
    return input.fallback();
  }

  const date = new Date(input.value);

  return Number.isNaN(date.getTime()) ? input.fallback() : date.toISOString();
};

const postWzrrdPublish = async (input: {
  readonly config: CloudflareWzrrdPublishAdapterConfig;
  readonly files: readonly WzrrdPublishFile[];
  readonly runId: string;
  readonly slug: string;
  readonly token: string;
}): Promise<
  | { readonly response: Response; readonly status: "ok" }
  | { readonly result: WzrrdPublishDeliveryResult; readonly status: "blocked" }
> => {
  const apiBaseUrl = (
    input.config.wzrrdApiBaseUrl ?? defaultWzrrdApiBaseUrl
  ).replaceAll(/\/+$/gu, "");
  const timeoutMs = input.config.timeoutMs ?? DEFAULT_WZRRD_TIMEOUT_MS;

  try {
    const response = await (input.config.fetch ?? fetch)(
      `${apiBaseUrl}/api/sites`,
      {
        body: JSON.stringify({
          files: input.files,
          indexing: "noindex",
          slug: input.slug,
          source: `pi-cloudflare-sandbox-workflows:${input.runId}`,
        }),
        headers: {
          Authorization: `Bearer ${input.token}`,
          "Content-Type": "application/json",
          "User-Agent": input.config.userAgent,
        },
        method: "POST",
        signal: AbortSignal.timeout(timeoutMs),
      }
    );

    return { response, status: "ok" };
  } catch (error) {
    return {
      result: blocked(
        "adapter_unavailable",
        error instanceof Error && error.name === "TimeoutError"
          ? `Wzrrd API did not respond within ${timeoutMs}ms.`
          : `Wzrrd API request failed: ${
              error instanceof Error ? error.name : "network error"
            }.`
      ),
      status: "blocked",
    };
  }
};

export const createCloudflareWzrrdApiTokenResolver = (
  config: CloudflareWzrrdApiTokenResolverConfig
): WzrrdApiTokenSecretResolver => ({
  async resolve(input) {
    if (input.secretRef !== config.secretRef) {
      return null;
    }

    if (typeof config.secret === "string") {
      return config.secret.length === 0 ? null : config.secret;
    }

    const secret = await config.secret.get();

    return secret === null || secret.length === 0 ? null : secret;
  },
});

export const createCloudflareWzrrdPublishAdapter = (
  config: CloudflareWzrrdPublishAdapterConfig
): WzrrdPublishCapabilityAdapter => ({
  async execute(input) {
    const lease = CapabilityLeaseSchema.parse(input.lease);
    const payload = WzrrdPublishPayloadSchema.parse(input.payload);
    if (!isWzrrdPublishLease(lease)) {
      return blocked(
        "capability_denied",
        "Wzrrd publish adapter requires a Wzrrd publish lease."
      );
    }

    const payloadHash = hashJson(payload);
    const bindingBlocker = validateLeasePayloadBinding({
      lease,
      payload,
      payloadHash,
    });
    if (bindingBlocker !== null) {
      return bindingBlocker;
    }

    if (lease.dryRun) {
      return deliveryForDryRun({ lease, payload, payloadHash });
    }

    if (lease.reviewGate.mode !== "approved") {
      return blocked(
        lease.reviewGate.mode === "rejected"
          ? "review_rejected"
          : "review_required",
        "Wzrrd publication requires approved review before execution."
      );
    }

    if (lease.secretRef !== config.wzrrdPublishSecretRef) {
      return blocked(
        "secret_denied",
        "Wzrrd publication requires the configured API secret reference."
      );
    }

    const token = await config.secretResolver.resolve({
      leaseId: lease.leaseId,
      runId: lease.runId,
      secretRef: lease.secretRef,
    });
    if (token === null) {
      return blocked(
        "secret_denied",
        "Wzrrd API token could not be materialized for the leased publication."
      );
    }

    const reviewSurface = ReviewSurfaceDocumentSchema.safeParse(
      await config.artifacts.readJson({
        artifactRef: payload.reviewSurface.artifactRef,
      })
    );
    if (!reviewSurface.success) {
      return blocked(
        "adapter_unavailable",
        "Wzrrd publish adapter could not load the pinned review surface artifact."
      );
    }

    if (hashJson(reviewSurface.data) !== payload.reviewSurface.hash) {
      return blocked(
        "payload_hash_mismatch",
        "Wzrrd review surface artifact no longer matches the pinned hash."
      );
    }

    const publishFiles = await filesForWzrrdPublish({
      artifacts: config.artifacts,
      payload,
      reviewSurface: reviewSurface.data,
      ...(config.primaryDocumentRenderer === undefined
        ? {}
        : { renderer: config.primaryDocumentRenderer }),
    });
    if (publishFiles.status === "blocked") {
      return publishFiles.result;
    }

    const posted = await postWzrrdPublish({
      config,
      files: publishFiles.files,
      runId: lease.runId,
      slug: payload.slug,
      token,
    });
    if (posted.status === "blocked") {
      return posted.result;
    }
    const { response } = posted;
    if (!response.ok) {
      return blockerForWzrrdStatus(response.status);
    }

    const body = WzrrdApiPublishResponseSchema.parse(await response.json());
    if (body.site.slug !== payload.slug) {
      return blocked(
        "resource_scope_denied",
        "Wzrrd returned a site slug that does not match the leased resource."
      );
    }

    return WzrrdPublishDeliveryResultSchema.parse({
      dryRun: false,
      payloadHash,
      publishedAt: coercePublishedAt({
        fallback: config.now ?? (() => new Date().toISOString()),
        value: body.site.updatedAt ?? body.site.createdAt,
      }),
      ...(publishFiles.primaryDocument === undefined
        ? {}
        : { primaryDocument: publishFiles.primaryDocument }),
      redacted: true,
      reviewSurfaceRef: payload.reviewSurface.artifactRef,
      slug: body.site.slug,
      status: "published",
      url: body.site.url,
    });
  },
});

export const createDryRunWzrrdPublishAdapter =
  (): WzrrdPublishCapabilityAdapter => ({
    execute(input: {
      readonly lease: CapabilityLease;
      readonly payload: WzrrdPublishPayload;
    }) {
      const lease = CapabilityLeaseSchema.parse(input.lease);
      const payload = WzrrdPublishPayloadSchema.parse(input.payload);
      if (!isWzrrdPublishLease(lease)) {
        return Promise.resolve({
          blocker: {
            code: "capability_denied",
            message: "Wzrrd publish adapter requires a Wzrrd publish lease.",
            redacted: true,
          },
          status: "blocked",
        } as const);
      }

      if (!lease.dryRun) {
        return Promise.resolve({
          blocker: {
            code: "adapter_unavailable",
            message: "Real Wzrrd publish adapter is not configured.",
            redacted: true,
          },
          status: "blocked",
        } as const);
      }

      const payloadHash = hashJson(payload);
      const bindingBlocker = validateLeasePayloadBinding({
        lease,
        payload,
        payloadHash,
      });
      if (bindingBlocker !== null) {
        return Promise.resolve(bindingBlocker);
      }

      return Promise.resolve(
        deliveryForDryRun({
          lease,
          payload,
          payloadHash,
        })
      );
    },
  });
