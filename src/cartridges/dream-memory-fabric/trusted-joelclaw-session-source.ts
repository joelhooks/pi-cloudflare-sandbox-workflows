import { execFileSync } from "node:child_process";

import { z } from "zod";

import { sha256Hex } from "../../app/domain/hash.ts";
import type {
  DreamCoverageHorizon,
  DreamMemorySearchHit,
  DreamReceiptRef,
  DreamRuntime,
  DreamSourceFamily,
} from "./schemas.ts";

export interface TrustedJoelClawSessionSourceConfig {
  readonly machineId: string;
  readonly maxFiles?: number;
  readonly runtime: JoelClawSessionRuntime;
  readonly sshTarget: string;
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
  readonly receipt: DreamReceiptRef;
  readonly redactedExcerpt: string;
  readonly summary: string;
}

export interface TrustedJoelClawSessionSearchResult {
  readonly hits: DreamMemorySearchHit[];
  readonly hydrations: TrustedJoelClawSessionHydrationRecord[];
  readonly skippedSources: string[];
}

const JOELCLAW_SSH_PROTOCOL = "joelclaw+ssh:";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER_BYTES = 4_000_000;
const REDACTED_TOKEN = "[redacted-token]";

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
          sessionId: z.string().min(1).optional(),
          snippets: z.array(z.string()).default([]),
          source: z.string().min(1).optional(),
          startedAt: z.string().min(1).optional(),
        })
      )
      .default([]),
    ssh: z
      .object({
        emittedHits: z.number().int().min(0).optional(),
        found: z.number().int().min(0).optional(),
        rawReturned: z.number().int().min(0).optional(),
        searchedFiles: z.number().int().min(0).optional(),
      })
      .optional(),
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

const parsePositiveInt = (input: string | null): number | undefined => {
  if (input === null || input.length === 0 || !/^\d+$/u.test(input)) {
    return undefined;
  }

  const parsed = Number.parseInt(input, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
};

const runtimeFor = (
  runtime: DreamRuntime | undefined
): JoelClawSessionRuntime => {
  if (runtime === "pi" || runtime === "codex" || runtime === "claude") {
    return runtime;
  }

  return "all";
};

export const trustedJoelClawSessionSourceForAuthorityRoot = (
  authorityRoot: string,
  runtime?: DreamRuntime
): TrustedJoelClawSessionSourceConfig | null => {
  let url: URL;
  try {
    url = new URL(authorityRoot);
  } catch {
    return null;
  }

  if (url.protocol !== JOELCLAW_SSH_PROTOCOL) {
    return null;
  }

  const parsedRuntime = JoelClawSessionRuntimeSchema.safeParse(
    url.searchParams.get("runtime") ?? runtimeFor(runtime)
  );
  const sshTarget = url.searchParams.get("sshTarget") ?? url.hostname;
  const machineId = url.searchParams.get("machine") ?? url.hostname;
  const maxFiles = parsePositiveInt(url.searchParams.get("maxFiles"));

  if (sshTarget.length === 0 || machineId.length === 0) {
    return null;
  }

  return {
    machineId,
    ...(maxFiles === undefined ? {} : { maxFiles }),
    runtime: parsedRuntime.success ? parsedRuntime.data : runtimeFor(runtime),
    sshTarget,
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
  readonly maxFiles: number;
  readonly query: string;
  readonly source: TrustedJoelClawSessionSourceConfig;
}): string[] => [
  "sessions",
  "search",
  input.query,
  "--source",
  "ssh",
  "--machine",
  input.source.machineId,
  "--ssh-target",
  input.source.sshTarget,
  "--runtime",
  input.source.runtime,
  "--limit",
  String(input.limit),
  "--max-files",
  String(input.maxFiles),
];

const runSearch = async (input: {
  readonly command?: TrustedJoelClawSessionBridgeCommand;
  readonly limit: number;
  readonly maxFiles: number;
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
  readonly family: DreamSourceFamily;
  readonly hash: string;
  readonly hit: JoelClawSessionSearchHit;
  readonly index: number;
  readonly runtime: DreamRuntime | undefined;
  readonly sourceId: string;
  readonly sourceMachineId: string;
}): DreamReceiptRef => {
  const stableId = hitStableId(input.hit, input.index);

  return {
    family: input.family,
    hash: input.hash,
    receiptId: `receipt:${input.sourceId}:joelclaw-ssh:${encodeURIComponent(stableId)}`,
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

export const searchTrustedJoelClawSessionSource = async (input: {
  readonly command?: TrustedJoelClawSessionBridgeCommand;
  readonly family: DreamSourceFamily;
  readonly label: string;
  readonly maxFiles: number;
  readonly maxHits: number;
  readonly now: string;
  readonly query: string;
  readonly runtime?: DreamRuntime;
  readonly source: TrustedJoelClawSessionSourceConfig;
  readonly sourceId: string;
}): Promise<TrustedJoelClawSessionSearchResult> => {
  try {
    const result = await runSearch({
      ...(input.command === undefined ? {} : { command: input.command }),
      limit: input.maxHits,
      maxFiles: input.source.maxFiles ?? input.maxFiles,
      query: input.query,
      source: input.source,
    });
    const hits: DreamMemorySearchHit[] = [];
    const hydrations: TrustedJoelClawSessionHydrationRecord[] = [];

    for (const [index, hit] of result.result.hits.entries()) {
      const redactedExcerpt = redactJoelClawSessionText(
        hit.snippets.join(" ")
      ).slice(0, 240);
      const hash = sha256Hex(
        JSON.stringify({
          excerpt: redactedExcerpt,
          machineId: hit.machineId ?? input.source.machineId,
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
        sourceMachineId: hit.machineId ?? input.source.machineId,
      });
      const summary = `Matched remote JoelClaw session memory in ${input.label}.`;

      hits.push({
        horizon: horizonFor(hit.startedAt, input.now) as DreamCoverageHorizon,
        receipts: [receipt],
        ...(redactedExcerpt.length === 0 ? {} : { redactedExcerpt }),
        score: scoreFor(hit, index),
        summary,
      });
      hydrations.push({
        receipt,
        redactedExcerpt:
          redactedExcerpt.length === 0
            ? "Remote JoelClaw session hit returned metadata without a redacted excerpt."
            : redactedExcerpt,
        summary: `Hydrated redacted remote JoelClaw session evidence for ${input.sourceId}.`,
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
      skippedSources: [`${input.sourceId}:joelclaw-ssh-unavailable`],
    };
  }
};
