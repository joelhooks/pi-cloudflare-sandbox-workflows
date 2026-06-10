import { execFileSync } from "node:child_process";

import { z } from "zod";

import { sha256Hex } from "../../app/domain/hash.ts";
import type {
  MemoryCoverageHorizon,
  MemoryRuntime,
  MemorySourceFamily,
} from "../../app/domain/source-profile.ts";
import type { MemorySearchHit, MemoryReceiptRef } from "./schemas.ts";

export interface TrustedJoelClawSessionSourceConfig {
  readonly machine: string;
  readonly runtime: JoelClawSessionRuntime;
}

export interface TrustedJoelClawSessionBridgeCommandInput {
  readonly args: readonly string[];
}

export type TrustedJoelClawSessionBridgeCommand = (
  input: TrustedJoelClawSessionBridgeCommandInput
) => Promise<{
  readonly stderr?: string;
  readonly stdout: string;
}>;

export interface TrustedJoelClawSessionHydrationRecord {
  readonly receipt: MemoryReceiptRef;
  readonly redactedExcerpt: string;
  readonly summary: string;
}

export interface TrustedJoelClawSessionSearchResult {
  readonly hits: MemorySearchHit[];
  readonly hydrations: TrustedJoelClawSessionHydrationRecord[];
  readonly skippedSources: string[];
}

export interface TrustedJoelClawSessionMachineCoverage {
  readonly machineId: string;
  readonly receiptCount: number;
}

const JOELCLAW_INDEX_PROTOCOL = "joelclaw+index:";
const DEFAULT_MACHINE_FILTER = "all";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER_BYTES = 4_000_000;
const REDACTED_TOKEN = "[redacted-token]";
const UNKNOWN_MACHINE_ID = "unknown";

const JoelClawSessionRuntimeSchema = z.enum([
  "all",
  "claude",
  "claude-code",
  "codex",
  "pi",
]);

export type JoelClawSessionRuntime = z.infer<
  typeof JoelClawSessionRuntimeSchema
>;

const JoelClawSessionSearchOutputSchema = z.object({
  ok: z.literal(true),
  result: z.object({
    hits: z
      .array(
        z.object({
          id: z.string().min(1).optional(),
          machineId: z.string().min(1).optional(),
          role: z.string().min(1).optional(),
          runId: z.string().min(1).optional(),
          sessionId: z.string().min(1).optional(),
          snippets: z.array(z.string()).default([]),
          source: z.string().min(1).optional(),
          startedAt: z.string().min(1).optional(),
        })
      )
      .default([]),
    typesense: z
      .object({
        found: z.number().int().min(0).optional(),
        returned: z.number().int().min(0).optional(),
      })
      .optional(),
    typesenseUnavailable: z.string().min(1).optional(),
  }),
});

type JoelClawSessionSearchHit = z.infer<
  typeof JoelClawSessionSearchOutputSchema
>["result"]["hits"][number];

const stripAnsi = (input: string): string => {
  let output = "";

  for (let index = 0; index < input.length; index += 1) {
    const code = input.codePointAt(index);
    const nextCode = input.codePointAt(index + 1);
    if (code === 27 && nextCode === 91) {
      index += 2;
      while (index < input.length) {
        const commandCode = input.codePointAt(index);
        if (
          commandCode !== undefined &&
          commandCode >= 0x40 &&
          commandCode <= 0x7e
        ) {
          break;
        }
        index += 1;
      }
      continue;
    }

    output += input[index] ?? "";
  }

  return output;
};

const runtimeFor = (
  runtime: MemoryRuntime | undefined
): JoelClawSessionRuntime => {
  if (runtime === "pi" || runtime === "codex" || runtime === "claude") {
    return runtime;
  }

  return "all";
};

/**
 * Parses a JoelClaw index authority root of the form
 * `joelclaw+index://sessions?machine=all&runtime=all`. The index is the only
 * transcript substrate: cross-machine coverage comes from what the index
 * returns, never from walking per-machine filesystems.
 */
export const trustedJoelClawSessionSourceForAuthorityRoot = (
  authorityRoot: string,
  runtime?: MemoryRuntime
): TrustedJoelClawSessionSourceConfig | null => {
  let url: URL;
  try {
    url = new URL(authorityRoot);
  } catch {
    return null;
  }

  if (url.protocol !== JOELCLAW_INDEX_PROTOCOL) {
    return null;
  }

  const parsedRuntime = JoelClawSessionRuntimeSchema.safeParse(
    url.searchParams.get("runtime") ?? runtimeFor(runtime)
  );
  const machine = url.searchParams.get("machine") ?? DEFAULT_MACHINE_FILTER;

  if (machine.length === 0) {
    return null;
  }

  return {
    machine,
    runtime: parsedRuntime.success ? parsedRuntime.data : runtimeFor(runtime),
  };
};

const defaultCommand: TrustedJoelClawSessionBridgeCommand = (input) =>
  Promise.resolve({
    stdout: execFileSync("joelclaw", [...input.args], {
      encoding: "utf-8",
      maxBuffer: DEFAULT_MAX_BUFFER_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: DEFAULT_TIMEOUT_MS,
    }),
  });

const searchArgs = (input: {
  readonly limit: number;
  readonly query: string;
  readonly source: TrustedJoelClawSessionSourceConfig;
}): string[] => [
  "sessions",
  "search",
  input.query,
  "--source",
  "typesense",
  "--machine",
  input.source.machine,
  "--runtime",
  input.source.runtime,
  "--limit",
  String(input.limit),
];

const runSearch = async (input: {
  readonly command?: TrustedJoelClawSessionBridgeCommand;
  readonly limit: number;
  readonly query: string;
  readonly source: TrustedJoelClawSessionSourceConfig;
}) => {
  const command = input.command ?? defaultCommand;
  const result = await command({
    args: searchArgs(input),
  });

  return JoelClawSessionSearchOutputSchema.parse(
    JSON.parse(stripAnsi(result.stdout))
  );
};

const redactJoelClawSessionText = (input: string): string =>
  input
    .replaceAll(/<\/?mark>/gu, "")
    .replaceAll(/\/Users\/[^\s"'`]+/gu, "[redacted-path]")
    .replaceAll(/[A-Za-z0-9_/-]{32,}/gu, REDACTED_TOKEN)
    .replaceAll(
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
      "[redacted-email]"
    )
    .replaceAll(/\s+/gu, " ")
    .trim();

const isIsoLike = (input: string | undefined): input is string =>
  input !== undefined && Number.isFinite(Date.parse(input));

const horizonFor = (modifiedAt: string | undefined, now: string) => {
  if (modifiedAt === undefined) {
    return "all-time";
  }

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

const hitStableId = (hit: JoelClawSessionSearchHit, index: number): string =>
  hit.sessionId ?? hit.id ?? `hit-${index + 1}`;

const receiptFor = (input: {
  readonly family: MemorySourceFamily;
  readonly hash: string;
  readonly hit: JoelClawSessionSearchHit;
  readonly index: number;
  readonly runtime: MemoryRuntime | undefined;
  readonly sourceId: string;
  readonly sourceMachineId: string;
}): MemoryReceiptRef => {
  const stableId = hitStableId(input.hit, input.index);

  return {
    family: input.family,
    hash: input.hash,
    machineId: input.sourceMachineId,
    receiptId: `receipt:${input.sourceId}:joelclaw-index:${encodeURIComponent(stableId)}`,
    redactedLocator: `redacted://joelclaw-sessions/${encodeURIComponent(input.sourceMachineId)}/${encodeURIComponent(stableId)}`,
    ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
    sourceId: input.sourceId,
    ...(isIsoLike(input.hit.startedAt)
      ? { timestamp: input.hit.startedAt }
      : {}),
  };
};

const scoreFor = (hit: JoelClawSessionSearchHit, index: number): number =>
  Math.max(1, hit.snippets.length) + 1 / (index + 1);

/**
 * Derives per-machine receipt counts from what the index returned. This is a
 * reported coverage caveat for readiness/coverage receipts — never a gate.
 */
export const trustedJoelClawSessionMachineCoverageFor = (
  receipts: readonly MemoryReceiptRef[]
): TrustedJoelClawSessionMachineCoverage[] => {
  const counts = new Map<string, number>();

  for (const receipt of receipts) {
    if (receipt.family !== "agent-transcripts") {
      continue;
    }

    const machineId = receipt.machineId ?? UNKNOWN_MACHINE_ID;
    counts.set(machineId, (counts.get(machineId) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([machineId, receiptCount]) => ({ machineId, receiptCount }))
    .toSorted((left, right) => left.machineId.localeCompare(right.machineId));
};

export const searchTrustedJoelClawSessionSource = async (input: {
  readonly command?: TrustedJoelClawSessionBridgeCommand;
  readonly family: MemorySourceFamily;
  readonly label: string;
  readonly maxHits: number;
  readonly now: string;
  readonly query: string;
  readonly runtime?: MemoryRuntime;
  readonly source: TrustedJoelClawSessionSourceConfig;
  readonly sourceId: string;
}): Promise<TrustedJoelClawSessionSearchResult> => {
  try {
    const result = await runSearch({
      ...(input.command === undefined ? {} : { command: input.command }),
      limit: input.maxHits,
      query: input.query,
      source: input.source,
    });
    if (result.result.typesenseUnavailable !== undefined) {
      return {
        hits: [],
        hydrations: [],
        skippedSources: [`${input.sourceId}:joelclaw-index-unavailable`],
      };
    }

    const hits: MemorySearchHit[] = [];
    const hydrations: TrustedJoelClawSessionHydrationRecord[] = [];

    for (const [index, hit] of result.result.hits.entries()) {
      const redactedExcerpt = redactJoelClawSessionText(
        hit.snippets.join(" ")
      ).slice(0, 240);
      const sourceMachineId = hit.machineId ?? UNKNOWN_MACHINE_ID;
      const hash = sha256Hex(
        JSON.stringify({
          excerpt: redactedExcerpt,
          machineId: sourceMachineId,
          role: hit.role,
          sessionId: hitStableId(hit, index),
          sourceId: input.sourceId,
        })
      );
      const receipt = receiptFor({
        family: input.family,
        hash,
        hit,
        index,
        runtime: input.runtime,
        sourceId: input.sourceId,
        sourceMachineId,
      });
      const summary = `Matched indexed JoelClaw session memory in ${input.label}.`;

      hits.push({
        horizon: horizonFor(hit.startedAt, input.now) as MemoryCoverageHorizon,
        receipts: [receipt],
        ...(redactedExcerpt.length === 0 ? {} : { redactedExcerpt }),
        score: scoreFor(hit, index),
        summary,
      });
      hydrations.push({
        receipt,
        redactedExcerpt:
          redactedExcerpt.length === 0
            ? "Indexed JoelClaw session hit returned metadata without a redacted excerpt."
            : redactedExcerpt,
        summary: `Hydrated redacted indexed JoelClaw session evidence for ${input.sourceId}.`,
      });
    }

    return {
      hits,
      hydrations,
      skippedSources: [],
    };
  } catch {
    return {
      hits: [],
      hydrations: [],
      skippedSources: [`${input.sourceId}:joelclaw-index-unavailable`],
    };
  }
};
