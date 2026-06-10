import type { Dirent } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { sha256Hex } from "../../app/domain/hash.ts";
import {
  DreamCorrelationGraphDocumentSchema,
  DreamHydrationDocumentSchema,
  DreamMemorySearchDocumentSchema,
} from "../../app/workflow-nodes/dream-memory-fabric-schemas.ts";
import type {
  DreamCorrelationGraphDocument,
  DreamCoverageHorizon,
  DreamMemoryRelayCorrelationPayload,
  DreamMemorySearchHit,
  DreamReceiptRef,
  DreamSourceFamily,
} from "../../app/workflow-nodes/dream-memory-fabric-schemas.ts";
import type {
  DreamMemoryCorrelationPort,
  DreamMemoryRetrievalPort,
} from "../../app/workflow-nodes/dream-memory-fabric.ts";
import {
  searchTrustedJoelClawSessionSource,
  trustedJoelClawSessionSourceForAuthorityRoot,
} from "./trusted-joelclaw-session-source.ts";
import type {
  TrustedJoelClawSessionBridgeCommand,
  TrustedJoelClawSessionHydrationRecord,
} from "./trusted-joelclaw-session-source.ts";
import type { TrustedLocalDreamSourceRoot } from "./trusted-local-memory-fabric.ts";

type DreamCorrelationGraphNode = DreamCorrelationGraphDocument["nodes"][number];
type DreamCorrelationGraphEdge = DreamCorrelationGraphDocument["edges"][number];

export interface TrustedDocsApiDreamMemoryRetrievalConfig {
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
  readonly userAgent?: string;
}

export interface TrustedLocalDreamMemoryRetrievalConfig {
  readonly docsApi?: TrustedDocsApiDreamMemoryRetrievalConfig;
  readonly maxFileBytes?: number;
  readonly maxFilesPerSource?: number;
  readonly now?: () => string;
  readonly sessionBridgeCommand?: TrustedJoelClawSessionBridgeCommand;
  readonly sourceRoots: readonly TrustedLocalDreamSourceRoot[];
}

interface CandidateFile {
  readonly content: string;
  readonly hash: string;
  readonly modifiedAt: string;
  readonly sourceRoot: TrustedLocalDreamSourceRoot;
}

interface CandidateSearchHit {
  readonly candidate: CandidateFile;
  readonly score: number;
  readonly termCount: number;
}

const DEFAULT_MAX_FILE_BYTES = 256_000;
const DEFAULT_MAX_FILES_PER_SOURCE = 5000;
const EXCERPT_RADIUS = 80;
const REDACTED_TOKEN = "[redacted-token]";
const DOCS_API_SOURCE_ID = "source:docs-pdf-brain:joelclaw-api";
const DOCS_API_RECEIPT_PREFIX = "docs-api:";

const DocsApiSearchHitSchema = z.object({
  docId: z.string().min(1),
  headingPath: z.array(z.string()).default([]),
  id: z.string().min(1),
  score: z.union([z.number(), z.string()]).optional(),
  snippet: z.string().min(1).optional(),
  title: z.string().min(1),
});

const DocsApiSearchResponseSchema = z.object({
  ok: z.literal(true),
  result: z.object({
    hits: z.array(DocsApiSearchHitSchema).default([]),
  }),
});

const DocsApiChunkResponseSchema = z.object({
  ok: z.literal(true),
  result: z.object({
    contentPreview: z.string().min(1).optional(),
    context_prefix: z.string().min(1).optional(),
    doc_id: z.string().min(1),
    heading_path: z.array(z.string()).default([]),
    id: z.string().min(1),
    title: z.string().min(1),
  }),
});

type DocsApiSearchHit = z.infer<typeof DocsApiSearchHitSchema>;

const termsForQuery = (query: string): string[] => {
  const terms: string[] = [];
  const seen = new Set<string>();

  for (const term of query.toLowerCase().split(/[^a-z0-9_-]+/u)) {
    if (term.length < 2 || seen.has(term)) {
      continue;
    }

    seen.add(term);
    terms.push(term);
  }

  return terms;
};

const sourceMatchesFamilies = (input: {
  readonly families: readonly DreamSourceFamily[] | undefined;
  readonly sourceRoot: TrustedLocalDreamSourceRoot;
}): boolean =>
  input.families === undefined ||
  input.families.includes(input.sourceRoot.family);

const fileMatchesExtensions = (input: {
  readonly fileName: string;
  readonly includeExtensions: readonly string[] | undefined;
}): boolean => {
  if (input.includeExtensions === undefined) {
    return true;
  }

  for (const extension of input.includeExtensions) {
    if (input.fileName.endsWith(extension)) {
      return true;
    }
  }

  return false;
};

const readCandidateFile = async (input: {
  readonly filePath: string;
  readonly maxFileBytes: number;
  readonly sourceRoot: TrustedLocalDreamSourceRoot;
}): Promise<CandidateFile | null> => {
  try {
    const fileStats = await stat(input.filePath);
    if (fileStats.size > input.maxFileBytes) {
      return null;
    }

    const content = await readFile(input.filePath, "utf-8");

    return {
      content,
      hash: sha256Hex(content),
      modifiedAt: fileStats.mtime.toISOString(),
      sourceRoot: input.sourceRoot,
    };
  } catch {
    return null;
  }
};

const readSourceCandidates = async (input: {
  readonly maxFileBytes: number;
  readonly maxFilesPerSource: number;
  readonly sourceRoot: TrustedLocalDreamSourceRoot;
}): Promise<{
  readonly candidates: CandidateFile[];
  readonly skippedSources: string[];
}> => {
  const candidates: CandidateFile[] = [];
  const pendingDirectories = [input.sourceRoot.authorityRoot];
  const skippedSources: string[] = [];
  let fileCapReached = false;
  let readCount = 0;

  if (
    trustedJoelClawSessionSourceForAuthorityRoot(
      input.sourceRoot.authorityRoot,
      input.sourceRoot.runtime
    ) !== null
  ) {
    return {
      candidates,
      skippedSources,
    };
  }

  try {
    const rootStats = await stat(input.sourceRoot.authorityRoot);
    if (!rootStats.isDirectory()) {
      return {
        candidates,
        skippedSources: [`${input.sourceRoot.sourceId}:not-a-directory`],
      };
    }
  } catch {
    return {
      candidates,
      skippedSources: [`${input.sourceRoot.sourceId}:unavailable`],
    };
  }

  while (pendingDirectories.length > 0 && !fileCapReached) {
    const directory = pendingDirectories.pop();
    if (directory === undefined) {
      continue;
    }

    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      skippedSources.push(`${input.sourceRoot.sourceId}:read-failed`);
      continue;
    }

    for (const entry of entries) {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        pendingDirectories.push(entryPath);
        continue;
      }

      if (
        !entry.isFile() ||
        !fileMatchesExtensions({
          fileName: entry.name,
          includeExtensions: input.sourceRoot.includeExtensions,
        })
      ) {
        continue;
      }

      if (readCount >= input.maxFilesPerSource) {
        skippedSources.push(`${input.sourceRoot.sourceId}:file-cap`);
        fileCapReached = true;
        break;
      }

      const candidate = await readCandidateFile({
        filePath: entryPath,
        maxFileBytes: input.maxFileBytes,
        sourceRoot: input.sourceRoot,
      });
      if (candidate === null) {
        skippedSources.push(`${input.sourceRoot.sourceId}:file-skipped`);
        continue;
      }

      readCount += 1;
      candidates.push(candidate);
    }
  }

  return { candidates, skippedSources };
};

const readCandidateFiles = async (input: {
  readonly families: readonly DreamSourceFamily[] | undefined;
  readonly maxFileBytes: number;
  readonly maxFilesPerSource: number;
  readonly sourceRoots: readonly TrustedLocalDreamSourceRoot[];
}): Promise<{
  readonly candidates: CandidateFile[];
  readonly skippedSources: string[];
}> => {
  const candidates: CandidateFile[] = [];
  const skippedSources: string[] = [];

  for (const sourceRoot of input.sourceRoots) {
    if (!sourceMatchesFamilies({ families: input.families, sourceRoot })) {
      continue;
    }

    const sourceResult = await readSourceCandidates({
      maxFileBytes: input.maxFileBytes,
      maxFilesPerSource: input.maxFilesPerSource,
      sourceRoot,
    });
    candidates.push(...sourceResult.candidates);
    skippedSources.push(...sourceResult.skippedSources);
  }

  return { candidates, skippedSources };
};

const candidateScore = (input: {
  readonly candidate: CandidateFile;
  readonly terms: readonly string[];
}): CandidateSearchHit | null => {
  const haystack = input.candidate.content.toLowerCase();
  let termCount = 0;
  let score = 0;

  for (const term of input.terms) {
    const index = haystack.indexOf(term);
    if (index === -1) {
      continue;
    }

    termCount += 1;
    score += 1 + 1 / (index + 1);
  }

  if (termCount === 0) {
    return null;
  }

  return {
    candidate: input.candidate,
    score,
    termCount,
  };
};

const redactText = (input: string): string =>
  input
    .replaceAll(/<\/?mark>/gu, "")
    .replaceAll(/\/Users\/[^\s"'`]+/gu, "[redacted-path]")
    .replaceAll(/[A-Za-z0-9_/-]{32,}/gu, REDACTED_TOKEN)
    .replaceAll(
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
      "[redacted-email]"
    );

const docsApiUrl = (input: {
  readonly baseUrl: string;
  readonly path: string;
  readonly searchParams?: Readonly<Record<string, string>>;
}): string => {
  const normalizedBase = input.baseUrl.endsWith("/")
    ? input.baseUrl
    : `${input.baseUrl}/`;
  const url = new URL(input.path.replace(/^\//u, ""), normalizedBase);

  for (const [key, value] of Object.entries(input.searchParams ?? {})) {
    url.searchParams.set(key, value);
  }

  return url.toString();
};

const docsApiHeaders = (
  config: TrustedDocsApiDreamMemoryRetrievalConfig
): HeadersInit =>
  config.userAgent === undefined
    ? {}
    : {
        "user-agent": config.userAgent,
      };

const docsScore = (score: number | string | undefined): number => {
  if (typeof score === "number") {
    return Number.isFinite(score) && score >= 0 ? score : 0;
  }

  if (typeof score === "string") {
    const parsed = Number.parseFloat(score);

    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }

  return 0;
};

const docsReceiptFor = (hit: DocsApiSearchHit): DreamReceiptRef => ({
  family: "docs-pdf-brain",
  hash: sha256Hex(JSON.stringify(hit)),
  receiptId: `${DOCS_API_RECEIPT_PREFIX}${encodeURIComponent(hit.id)}`,
  redactedLocator: `redacted://docs-api/chunks/${encodeURIComponent(hit.id)}`,
  sourceId: DOCS_API_SOURCE_ID,
});

const docsSearchHitFor = (hit: DocsApiSearchHit): DreamMemorySearchHit => {
  const headingPath = hit.headingPath.join(" > ");
  const context = headingPath.length === 0 ? hit.title : headingPath;

  return {
    horizon: "all-time",
    receipts: [docsReceiptFor(hit)],
    ...(hit.snippet === undefined
      ? {}
      : {
          redactedExcerpt: redactText(hit.snippet)
            .replaceAll(/\s+/gu, " ")
            .trim(),
        }),
    score: docsScore(hit.score),
    summary: `Matched docs/pdf-brain chunk in ${hit.title}: ${context}.`,
  };
};

const docsChunkIdFromReceipt = (receipt: DreamReceiptRef): string | null => {
  if (
    receipt.sourceId !== DOCS_API_SOURCE_ID ||
    !receipt.receiptId.startsWith(DOCS_API_RECEIPT_PREFIX)
  ) {
    return null;
  }

  return decodeURIComponent(
    receipt.receiptId.slice(DOCS_API_RECEIPT_PREFIX.length)
  );
};

const docsApiSearch = async (input: {
  readonly config: TrustedDocsApiDreamMemoryRetrievalConfig | undefined;
  readonly maxHits: number;
  readonly query: string;
  readonly sourceFamilies: readonly DreamSourceFamily[] | undefined;
}): Promise<{
  readonly hits: DreamMemorySearchHit[];
  readonly skippedSources: string[];
}> => {
  if (
    input.config === undefined ||
    (input.sourceFamilies !== undefined &&
      !input.sourceFamilies.includes("docs-pdf-brain"))
  ) {
    return {
      hits: [],
      skippedSources: [],
    };
  }

  const fetcher = input.config.fetch ?? fetch;
  try {
    const response = await fetcher(
      docsApiUrl({
        baseUrl: input.config.baseUrl,
        path: "search",
        searchParams: {
          perPage: String(input.maxHits),
          q: input.query,
          semantic: "false",
        },
      }),
      {
        headers: docsApiHeaders(input.config),
        method: "GET",
      }
    );
    if (!response.ok) {
      return {
        hits: [],
        skippedSources: [`${DOCS_API_SOURCE_ID}:http-${response.status}`],
      };
    }

    const parsed = DocsApiSearchResponseSchema.parse(await response.json());

    return {
      hits: parsed.result.hits.map(docsSearchHitFor),
      skippedSources: [],
    };
  } catch {
    return {
      hits: [],
      skippedSources: [`${DOCS_API_SOURCE_ID}:unavailable`],
    };
  }
};

const docsApiHydrate = async (input: {
  readonly config: TrustedDocsApiDreamMemoryRetrievalConfig | undefined;
  readonly receipt: DreamReceiptRef;
}): Promise<{
  readonly redactedExcerpt: string;
  readonly receipt: DreamReceiptRef;
  readonly summary: string;
} | null> => {
  const chunkId = docsChunkIdFromReceipt(input.receipt);
  if (input.config === undefined || chunkId === null) {
    return null;
  }

  const fetcher = input.config.fetch ?? fetch;
  try {
    const response = await fetcher(
      docsApiUrl({
        baseUrl: input.config.baseUrl,
        path: `chunks/${encodeURIComponent(chunkId)}`,
        searchParams: {
          includeEmbedding: "false",
          lite: "true",
        },
      }),
      {
        headers: docsApiHeaders(input.config),
        method: "GET",
      }
    );
    if (!response.ok) {
      return null;
    }

    const parsed = DocsApiChunkResponseSchema.parse(await response.json());
    const content =
      parsed.result.contentPreview ??
      parsed.result.context_prefix ??
      parsed.result.title;

    return {
      receipt: input.receipt,
      redactedExcerpt: redactText(content).replaceAll(/\s+/gu, " ").trim(),
      summary: `Hydrated redacted docs/pdf-brain evidence from ${parsed.result.title}.`,
    };
  } catch {
    return null;
  }
};

const joelClawSessionSearch = async (input: {
  readonly command: TrustedJoelClawSessionBridgeCommand | undefined;
  readonly maxFilesPerSource: number;
  readonly maxHits: number;
  readonly now: string;
  readonly query: string;
  readonly sourceFamilies: readonly DreamSourceFamily[] | undefined;
  readonly sourceRoots: readonly TrustedLocalDreamSourceRoot[];
}): Promise<{
  readonly hits: DreamMemorySearchHit[];
  readonly hydrations: TrustedJoelClawSessionHydrationRecord[];
  readonly skippedSources: string[];
}> => {
  const hits: DreamMemorySearchHit[] = [];
  const hydrations: TrustedJoelClawSessionHydrationRecord[] = [];
  const skippedSources: string[] = [];

  for (const sourceRoot of input.sourceRoots) {
    if (
      !sourceMatchesFamilies({ families: input.sourceFamilies, sourceRoot })
    ) {
      continue;
    }

    const joelClawSessionSource = trustedJoelClawSessionSourceForAuthorityRoot(
      sourceRoot.authorityRoot,
      sourceRoot.runtime
    );
    if (joelClawSessionSource === null) {
      continue;
    }

    const result = await searchTrustedJoelClawSessionSource({
      ...(input.command === undefined ? {} : { command: input.command }),
      family: sourceRoot.family,
      label: sourceRoot.label,
      maxFiles: input.maxFilesPerSource,
      maxHits: input.maxHits,
      now: input.now,
      query: input.query,
      ...(sourceRoot.runtime === undefined
        ? {}
        : { runtime: sourceRoot.runtime }),
      source: joelClawSessionSource,
      sourceId: sourceRoot.sourceId,
    });
    hits.push(...result.hits);
    hydrations.push(...result.hydrations);
    skippedSources.push(...result.skippedSources);
  }

  return {
    hits,
    hydrations,
    skippedSources,
  };
};

const primaryFamilyFor = (
  hit: DreamMemorySearchHit
): DreamSourceFamily | null => hit.receipts.at(0)?.family ?? null;

const balancedHitsByFamily = (input: {
  readonly hits: readonly DreamMemorySearchHit[];
  readonly maxHits: number;
  readonly sourceFamilies: readonly DreamSourceFamily[] | undefined;
}): DreamMemorySearchHit[] => {
  const buckets = new Map<DreamSourceFamily, DreamMemorySearchHit[]>();
  const firstSeenFamilies: DreamSourceFamily[] = [];

  for (const hit of input.hits) {
    const family = primaryFamilyFor(hit);
    if (family === null) {
      continue;
    }

    if (!buckets.has(family)) {
      buckets.set(family, []);
      firstSeenFamilies.push(family);
    }

    buckets.set(family, [...(buckets.get(family) ?? []), hit]);
  }

  const orderedFamilies = [
    ...(input.sourceFamilies ?? []),
    ...firstSeenFamilies.filter(
      (family) => !(input.sourceFamilies ?? []).includes(family)
    ),
  ].filter((family) => buckets.has(family));
  const sortedBuckets = new Map(
    [...buckets.entries()].map(([family, hits]) => [
      family,
      hits.toSorted((left, right) => right.score - left.score),
    ])
  );
  const indexes = new Map<DreamSourceFamily, number>();
  const selected: DreamMemorySearchHit[] = [];
  let madeProgress = true;

  while (selected.length < input.maxHits && madeProgress) {
    madeProgress = false;
    for (const family of orderedFamilies) {
      if (selected.length >= input.maxHits) {
        break;
      }

      const bucket = sortedBuckets.get(family);
      const index = indexes.get(family) ?? 0;
      const hit = bucket?.at(index);
      if (hit === undefined) {
        continue;
      }

      selected.push(hit);
      indexes.set(family, index + 1);
      madeProgress = true;
    }
  }

  return selected;
};

const excerptFor = (input: {
  readonly content: string;
  readonly terms: readonly string[];
}): string => {
  const lowerContent = input.content.toLowerCase();
  const firstIndex =
    input.terms
      .map((term) => lowerContent.indexOf(term))
      .find((index) => index >= 0) ?? 0;
  const start = Math.max(0, firstIndex - EXCERPT_RADIUS);
  const end = Math.min(input.content.length, firstIndex + EXCERPT_RADIUS);
  const excerpt = input.content.slice(start, end).replaceAll(/\s+/gu, " ");

  return redactText(excerpt).trim();
};

const horizonFor = (modifiedAt: string, now: string): DreamCoverageHorizon => {
  const modifiedMs = Date.parse(modifiedAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(modifiedMs) || !Number.isFinite(nowMs)) {
    return "all-time";
  }

  const ageMs = nowMs - modifiedMs;
  if (ageMs <= 24 * 60 * 60 * 1000) {
    return "24h";
  }

  if (ageMs <= 7 * 24 * 60 * 60 * 1000) {
    return "7d";
  }

  if (ageMs <= 30 * 24 * 60 * 60 * 1000) {
    return "30d";
  }

  if (ageMs <= 92 * 24 * 60 * 60 * 1000) {
    return "quarter";
  }

  return "all-time";
};

const receiptFor = (candidate: CandidateFile): DreamReceiptRef => ({
  family: candidate.sourceRoot.family,
  hash: candidate.hash,
  receiptId: `receipt:${candidate.sourceRoot.sourceId}:${candidate.hash.slice(0, 16)}`,
  redactedLocator: `redacted://dream-source/${encodeURIComponent(candidate.sourceRoot.sourceId)}/receipt/${candidate.hash.slice(0, 12)}`,
  ...(candidate.sourceRoot.runtime === undefined
    ? {}
    : { runtime: candidate.sourceRoot.runtime }),
  sourceId: candidate.sourceRoot.sourceId,
  timestamp: candidate.modifiedAt,
});

const searchHitFor = (input: {
  readonly hit: CandidateSearchHit;
  readonly now: string;
  readonly terms: readonly string[];
}): DreamMemorySearchHit => ({
  horizon: horizonFor(input.hit.candidate.modifiedAt, input.now),
  receipts: [receiptFor(input.hit.candidate)],
  redactedExcerpt: excerptFor({
    content: input.hit.candidate.content,
    terms: input.terms,
  }),
  score: input.hit.score,
  summary: `Matched ${input.hit.termCount} term(s) in ${input.hit.candidate.sourceRoot.label}.`,
});

const bestHits = (input: {
  readonly candidates: readonly CandidateFile[];
  readonly maxHits: number;
  readonly terms: readonly string[];
}): CandidateSearchHit[] => {
  const hits: CandidateSearchHit[] = [];

  for (const candidate of input.candidates) {
    const hit = candidateScore({ candidate, terms: input.terms });
    if (hit === null) {
      continue;
    }

    hits.push(hit);
  }

  return hits
    .toSorted((left, right) => right.score - left.score)
    .slice(0, input.maxHits);
};

const hydrateReceipt = async (input: {
  readonly maxFileBytes: number;
  readonly maxFilesPerSource: number;
  readonly receipt: DreamReceiptRef;
  readonly sourceRoots: readonly TrustedLocalDreamSourceRoot[];
}): Promise<{
  readonly content: string;
  readonly receipt: DreamReceiptRef;
} | null> => {
  if (input.receipt.hash === undefined) {
    return null;
  }

  const sourceRoots = input.sourceRoots.filter(
    (sourceRoot) => sourceRoot.sourceId === input.receipt.sourceId
  );
  const candidates = await readCandidateFiles({
    families: undefined,
    maxFileBytes: input.maxFileBytes,
    maxFilesPerSource: input.maxFilesPerSource,
    sourceRoots,
  });
  const candidate = candidates.candidates.find(
    (item) => item.hash === input.receipt.hash
  );
  if (candidate === undefined) {
    return null;
  }

  return {
    content: candidate.content,
    receipt: {
      ...input.receipt,
      timestamp: input.receipt.timestamp ?? candidate.modifiedAt,
    },
  };
};

const graphSafeId = (value: string): string =>
  value
    .toLowerCase()
    .replaceAll(/[^a-z0-9_.:-]+/gu, "-")
    .replaceAll(/^-|-$/gu, "")
    .slice(0, 120);

const addGraphNode = (
  nodes: Map<string, DreamCorrelationGraphNode>,
  input: Omit<DreamCorrelationGraphNode, "redacted">
) => {
  if (nodes.has(input.nodeId)) {
    return;
  }

  nodes.set(input.nodeId, {
    label: input.label.slice(0, 160),
    nodeId: input.nodeId,
    nodeType: input.nodeType,
    redacted: true,
  });
};

const receiptKey = (receipt: DreamReceiptRef): string =>
  `${receipt.sourceId}:${receipt.receiptId}:${receipt.hash ?? ""}`;

const correlationGraphFor = (input: {
  readonly generatedAt: string;
  readonly payload: DreamMemoryRelayCorrelationPayload;
}) => {
  const nodes = new Map<string, DreamCorrelationGraphNode>();
  const edges: DreamCorrelationGraphEdge[] = [];
  const hydratedReceiptKeys = new Set(
    input.payload.hydration.hydrated.map((hydrated) =>
      receiptKey(hydrated.receipt)
    )
  );

  addGraphNode(nodes, {
    label: "Dream human review",
    nodeId: "dream:hitl-review",
    nodeType: "project",
  });

  for (const [index, hit] of input.payload.search.hits.entries()) {
    const hitNodeId = `memory-hit:${index + 1}`;
    const horizonNodeId = `horizon:${hit.horizon}`;
    addGraphNode(nodes, {
      label: hit.summary,
      nodeId: hitNodeId,
      nodeType: "memory",
    });
    addGraphNode(nodes, {
      label: `${hit.horizon} retrieval horizon`,
      nodeId: horizonNodeId,
      nodeType: "event",
    });

    const firstReceipt = hit.receipts.at(0);
    if (firstReceipt !== undefined) {
      edges.push({
        edgeId: `edge:${hitNodeId}:supports-dream`,
        evidence: [firstReceipt],
        fromNodeId: hitNodeId,
        relationship: "supports_dream",
        toNodeId: "dream:hitl-review",
      });
      edges.push({
        edgeId: `edge:${hitNodeId}:horizon`,
        evidence: [firstReceipt],
        fromNodeId: hitNodeId,
        relationship: "reported_by",
        toNodeId: horizonNodeId,
      });
    }

    for (const receipt of hit.receipts) {
      const sourceNodeId = `source:${graphSafeId(receipt.sourceId)}`;
      addGraphNode(nodes, {
        label: `${receipt.family} source ${receipt.sourceId}`,
        nodeId: sourceNodeId,
        nodeType: "source",
      });
      edges.push({
        edgeId: `edge:${hitNodeId}:${graphSafeId(receipt.receiptId)}:source`,
        evidence: [receipt],
        fromNodeId: hitNodeId,
        relationship: "reported_by",
        toNodeId: sourceNodeId,
      });

      if (hydratedReceiptKeys.has(receiptKey(receipt))) {
        const hydrationNodeId = `artifact:hydration:${graphSafeId(receipt.receiptId)}`;
        addGraphNode(nodes, {
          label: `Hydrated redacted receipt ${receipt.receiptId}`,
          nodeId: hydrationNodeId,
          nodeType: "artifact",
        });
        edges.push({
          edgeId: `edge:${hitNodeId}:${graphSafeId(receipt.receiptId)}:hydrated`,
          evidence: [receipt],
          fromNodeId: hitNodeId,
          relationship: "produced_artifact",
          toNodeId: hydrationNodeId,
        });
      }
    }
  }

  return DreamCorrelationGraphDocumentSchema.parse({
    edges,
    generatedAt: input.generatedAt,
    nodes: [...nodes.values()],
    redacted: true,
    runId: input.payload.runId,
    schemaVersion: "dream.correlation-graph.v1",
    workItemId: input.payload.workItemId,
  });
};

export const createTrustedLocalDreamMemoryRetrievalAdapter = (
  config: TrustedLocalDreamMemoryRetrievalConfig
): DreamMemoryCorrelationPort & DreamMemoryRetrievalPort => {
  const joelClawSessionHydrationCache = new Map<
    string,
    TrustedJoelClawSessionHydrationRecord
  >();

  return {
    correlateMemories(input) {
      return Promise.resolve({
        document: correlationGraphFor({
          generatedAt: config.now?.() ?? new Date().toISOString(),
          payload: input,
        }),
        status: "ready",
      });
    },
    async hydrateMemories(input) {
      const generatedAt = config.now?.() ?? new Date().toISOString();
      const hydrated = [];

      for (const receipt of input.receipts) {
        const result = await hydrateReceipt({
          maxFileBytes: config.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
          maxFilesPerSource:
            config.maxFilesPerSource ?? DEFAULT_MAX_FILES_PER_SOURCE,
          receipt,
          sourceRoots: config.sourceRoots,
        });
        if (result === null) {
          continue;
        }

        hydrated.push({
          fullTranscriptReturned: false as const,
          receipt: result.receipt,
          redactedExcerpt: redactText(result.content)
            .replaceAll(/\s+/gu, " ")
            .slice(0, 240)
            .trim(),
          summary: `Hydrated redacted evidence for ${result.receipt.sourceId}.`,
        });
      }

      for (const receipt of input.receipts) {
        const result = joelClawSessionHydrationCache.get(receiptKey(receipt));
        if (result === undefined) {
          continue;
        }

        hydrated.push({
          fullTranscriptReturned: false as const,
          receipt: result.receipt,
          redactedExcerpt: result.redactedExcerpt.slice(0, 240).trim(),
          summary: result.summary,
        });
      }

      for (const receipt of input.receipts) {
        const result = await docsApiHydrate({
          config: config.docsApi,
          receipt,
        });
        if (result === null) {
          continue;
        }

        hydrated.push({
          fullTranscriptReturned: false as const,
          receipt: result.receipt,
          redactedExcerpt: result.redactedExcerpt.slice(0, 240).trim(),
          summary: result.summary,
        });
      }

      return {
        document: DreamHydrationDocumentSchema.parse({
          generatedAt,
          hydrated,
          redacted: true,
          runId: input.runId,
          schemaVersion: "dream.hydration.v1",
          workItemId: input.workItemId,
        }),
        status: "ready",
      };
    },
    async searchMemories(input) {
      const generatedAt = config.now?.() ?? new Date().toISOString();
      const terms = termsForQuery(input.query);
      const candidates = await readCandidateFiles({
        families: input.sourceFamilies,
        maxFileBytes: config.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
        maxFilesPerSource:
          config.maxFilesPerSource ?? DEFAULT_MAX_FILES_PER_SOURCE,
        sourceRoots: config.sourceRoots,
      });
      const docsSearch = await docsApiSearch({
        config: config.docsApi,
        maxHits: input.maxHits,
        query: input.query,
        sourceFamilies: input.sourceFamilies,
      });
      const joelClawSearch = await joelClawSessionSearch({
        command: config.sessionBridgeCommand,
        maxFilesPerSource:
          config.maxFilesPerSource ?? DEFAULT_MAX_FILES_PER_SOURCE,
        maxHits: input.maxHits,
        now: generatedAt,
        query: input.query,
        sourceFamilies: input.sourceFamilies,
        sourceRoots: config.sourceRoots,
      });
      for (const hydration of joelClawSearch.hydrations) {
        joelClawSessionHydrationCache.set(
          receiptKey(hydration.receipt),
          hydration
        );
      }
      const localHits = bestHits({
        candidates: candidates.candidates,
        maxHits: input.maxHits,
        terms,
      }).map((hit) => searchHitFor({ hit, now: generatedAt, terms }));

      return {
        document: DreamMemorySearchDocumentSchema.parse({
          generatedAt,
          hits: balancedHitsByFamily({
            hits: [...localHits, ...joelClawSearch.hits, ...docsSearch.hits],
            maxHits: input.maxHits,
            sourceFamilies: input.sourceFamilies,
          }),
          query: input.query,
          redacted: true,
          runId: input.runId,
          schemaVersion: "dream.memory-search.v1",
          skippedSources: [
            ...candidates.skippedSources,
            ...joelClawSearch.skippedSources,
            ...docsSearch.skippedSources,
          ],
          workItemId: input.workItemId,
        }),
        status: "ready",
      };
    },
  };
};
