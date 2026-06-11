import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

/**
 * Path to the local system bus env file. The JoelClaw CLI does NOT self-load
 * its Typesense connection config; without this, it dials `localhost:8108` and
 * never reaches the real index on `panda:8108`. We load it here and pass it as
 * the child env so `agent-transcripts` resolves to real sessions.
 */
const SYSTEM_BUS_ENV_PATH = join(homedir(), ".config", "system-bus.env");

/**
 * Only these keys are lifted from `system-bus.env` into the CLI child env. We
 * intentionally allowlist rather than spread the whole file so an unrelated
 * secret in that file never leaks into a child process we spawn.
 */
const JOELCLAW_ENV_KEYS = [
  "TYPESENSE_URL",
  "TYPESENSE_API_KEY",
  "JOELCLAW_CENTRAL_URL",
] as const;

/**
 * Redacted, operator-legible cause categories for a JoelClaw CLI failure. These
 * are the ONLY substrings appended to a skip reason on the error path — never
 * stderr verbatim, never a path, never a secret value. They let an operator
 * tell "binary missing" from "config absent" from "command errored" from
 * "garbage stdout" without exposing anything sensitive.
 */
const JOELCLAW_SKIP_CAUSE = {
  cliError: "joelclaw-cli-error",
  cliNotFound: "joelclaw-cli-not-found",
  cliTimeout: "joelclaw-cli-timeout",
  indexUnavailable: "joelclaw-index-unavailable",
  parseFailed: "joelclaw-output-unparseable",
} as const;

type JoelClawSkipCause =
  (typeof JOELCLAW_SKIP_CAUSE)[keyof typeof JOELCLAW_SKIP_CAUSE];

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

/**
 * A failure that carries a redacted cause category so the catch path can append
 * a diagnosable (but non-leaking) skip reason. `message` is never surfaced.
 */
export class JoelClawSessionBridgeError extends Error {
  readonly causeCategory: JoelClawSkipCause;

  constructor(causeCategory: JoelClawSkipCause, detail: string) {
    super(detail);
    this.name = "JoelClawSessionBridgeError";
    this.causeCategory = causeCategory;
  }
}

/**
 * Parses a `KEY=VALUE` env file (shell-style). Skips blanks and `#` comments,
 * strips a leading `export `, and trims one layer of matching single/double
 * quotes from values. Returns only the JoelClaw allowlist keys; everything else
 * in the file is ignored so unrelated secrets never reach the child process.
 */
export const parseJoelClawSystemBusEnv = (
  fileContents: string
): Record<string, string> => {
  const parsed: Record<string, string> = {};
  const allowlist = new Set<string>(JOELCLAW_ENV_KEYS);

  for (const rawLine of fileContents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    const withoutExport = line.startsWith("export ")
      ? line.slice("export ".length).trim()
      : line;
    const equalsIndex = withoutExport.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }

    const key = withoutExport.slice(0, equalsIndex).trim();
    if (!allowlist.has(key)) {
      continue;
    }

    let value = withoutExport.slice(equalsIndex + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }

    parsed[key] = value;
  }

  return parsed;
};

/**
 * Reads the JoelClaw Typesense connection overlay from `~/.config/system-bus.env`
 * (allowlist keys only). Tolerant by design: a missing or unreadable file
 * yields an empty overlay rather than throwing — `agent-transcripts` degrading
 * to a skip is acceptable; the dream hard-failing is not.
 */
export const readJoelClawBridgeEnvOverlay = (input?: {
  readonly envPath?: string;
  readonly readEnvFile?: (path: string) => string;
}): Record<string, string> => {
  const envPath = input?.envPath ?? SYSTEM_BUS_ENV_PATH;
  const readEnvFile =
    input?.readEnvFile ??
    ((path: string) => readFileSync(path, { encoding: "utf-8" }));

  try {
    return parseJoelClawSystemBusEnv(readEnvFile(envPath));
  } catch {
    return {};
  }
};

/**
 * Loads the JoelClaw connection env, merging the `system-bus.env` overlay OVER
 * `process.env` so the spawned CLI reaches the real index on `panda:8108`
 * instead of dialing `localhost:8108`. Returns a plain record; callers that need
 * the strict `ProcessEnv` shape (e.g. `execFileSync`) should spread the real
 * `process.env` themselves and only merge the overlay.
 */
export const loadJoelClawBridgeEnv = (input?: {
  readonly envPath?: string;
  readonly processEnv?: Readonly<Record<string, string | undefined>>;
  readonly readEnvFile?: (path: string) => string;
}): Record<string, string | undefined> => ({
  ...(input?.processEnv ?? process.env),
  ...readJoelClawBridgeEnvOverlay(input),
});

const errnoCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  const { code } = error;
  return typeof code === "string" ? code : undefined;
};

const causeForExecError = (error: unknown): JoelClawSkipCause => {
  const code = errnoCode(error);
  if (code === "ENOENT") {
    return JOELCLAW_SKIP_CAUSE.cliNotFound;
  }
  if (code === "ETIMEDOUT") {
    return JOELCLAW_SKIP_CAUSE.cliTimeout;
  }

  return JOELCLAW_SKIP_CAUSE.cliError;
};

const defaultCommand: TrustedJoelClawSessionBridgeCommand = (input) => {
  // Spread the real `process.env` (keeps the strict ProcessEnv shape) then
  // merge the redacted system-bus overlay so the CLI reaches panda:8108.
  const env = { ...process.env, ...readJoelClawBridgeEnvOverlay() };
  try {
    return Promise.resolve({
      stdout: execFileSync("joelclaw", [...input.args], {
        encoding: "utf-8",
        env,
        maxBuffer: DEFAULT_MAX_BUFFER_BYTES,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: DEFAULT_TIMEOUT_MS,
      }),
    });
  } catch (error) {
    // Re-throw as a typed, redacted-cause error. We deliberately drop the raw
    // message/stderr/path here so nothing sensitive reaches the skip reason.
    return Promise.reject(
      new JoelClawSessionBridgeError(
        causeForExecError(error),
        "joelclaw CLI invocation failed"
      )
    );
  }
};

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
        skippedSources: [
          `${input.sourceId}:${JOELCLAW_SKIP_CAUSE.indexUnavailable}`,
        ],
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
  } catch (error) {
    const cause =
      error instanceof JoelClawSessionBridgeError
        ? error.causeCategory
        : JOELCLAW_SKIP_CAUSE.parseFailed;

    return {
      hits: [],
      hydrations: [],
      skippedSources: [`${input.sourceId}:${cause}`],
    };
  }
};
