import type { SafetyEnvelopeState } from "./schemas";

/**
 * Visual classification for a run's status badge.
 * - `captured` (success) renders green.
 * - `blocked` (wedged/denied) renders red.
 * - `received` (just queued, not yet advancing) renders neutral.
 * - everything else (in-flight planning/executing/etc.) renders amber.
 */
export type StatusTone = "amber" | "green" | "neutral" | "red";

/**
 * Maps a safety-envelope state to a badge tone. Terminal `captured`/`blocked`
 * get their own colors; the freshly-`received` state is neutral; all remaining
 * in-flight states are amber so an advancing run reads as "working".
 *
 * @param state The run's current safety-envelope state.
 */
export const statusTone = (state: SafetyEnvelopeState): StatusTone => {
  if (state === "captured") {
    return "green";
  }
  if (state === "blocked") {
    return "red";
  }
  if (state === "received") {
    return "neutral";
  }

  return "amber";
};

const TERMINAL_STATES = new Set<SafetyEnvelopeState>(["blocked", "captured"]);

/**
 * Whether a state is terminal (the run is done, for better or worse).
 *
 * @param state The run's current safety-envelope state.
 */
export const isTerminalState = (state: SafetyEnvelopeState): boolean =>
  TERMINAL_STATES.has(state);

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Parses the Worker's timestamp strings, which may be ISO-8601 or a SQLite
 * `YYYY-MM-DD HH:MM:SS` (UTC) default. Returns `null` when unparseable.
 *
 * @param value Raw timestamp string from a run row or event.
 */
export const parseTimestampMs = (value: string): null | number => {
  const direct = Date.parse(value);
  if (!Number.isNaN(direct)) {
    return direct;
  }

  // SQLite CURRENT_TIMESTAMP form: treat the space as a `T` and pin to UTC.
  const sqliteIso = `${value.replace(" ", "T")}Z`;
  const coerced = Date.parse(sqliteIso);

  return Number.isNaN(coerced) ? null : coerced;
};

/**
 * Renders a compact relative-age label ("just now", "3m ago", "2h ago") from a
 * timestamp string and a reference "now" in epoch ms. Future or unparseable
 * timestamps fall back to "—".
 *
 * @param value Raw timestamp string.
 * @param nowMs Reference time in epoch milliseconds.
 */
export const relativeAge = (value: string, nowMs: number): string => {
  const thenMs = parseTimestampMs(value);
  if (thenMs === null) {
    return "—";
  }

  const deltaMs = nowMs - thenMs;
  if (deltaMs < 0) {
    return "just now";
  }
  if (deltaMs < 5 * SECOND_MS) {
    return "just now";
  }
  if (deltaMs < MINUTE_MS) {
    return `${Math.floor(deltaMs / SECOND_MS)}s ago`;
  }
  if (deltaMs < HOUR_MS) {
    return `${Math.floor(deltaMs / MINUTE_MS)}m ago`;
  }
  if (deltaMs < DAY_MS) {
    return `${Math.floor(deltaMs / HOUR_MS)}h ago`;
  }

  return `${Math.floor(deltaMs / DAY_MS)}d ago`;
};

/**
 * Renders a signed relative label from an epoch-ms instant: "in 4s" for the
 * future, "12s ago" for the past, "now" for within a second. Used by the
 * durability panel for reaper/alarm timing, which can be either side of now.
 *
 * @param atMs The instant in epoch milliseconds.
 * @param nowMs Reference time in epoch milliseconds.
 */
export const relativeFromMs = (atMs: number, nowMs: number): string => {
  const deltaMs = atMs - nowMs;
  const absMs = Math.abs(deltaMs);
  if (absMs < SECOND_MS) {
    return "now";
  }

  let magnitude: string;
  if (absMs < MINUTE_MS) {
    magnitude = `${Math.floor(absMs / SECOND_MS)}s`;
  } else if (absMs < HOUR_MS) {
    magnitude = `${Math.floor(absMs / MINUTE_MS)}m`;
  } else if (absMs < DAY_MS) {
    magnitude = `${Math.floor(absMs / HOUR_MS)}h`;
  } else {
    magnitude = `${Math.floor(absMs / DAY_MS)}d`;
  }

  return deltaMs >= 0 ? `in ${magnitude}` : `${magnitude} ago`;
};

/**
 * Compact local wall-clock label ("14:03:21") for an epoch-ms instant, for the
 * durability panel's absolute timestamps.
 *
 * @param atMs The instant in epoch milliseconds.
 */
export const clockTime = (atMs: number): string =>
  new Date(atMs).toLocaleTimeString([], {
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    second: "2-digit",
  });

/**
 * Whether a run looks stale: in-flight but its last update is older than the
 * threshold. Used to flag a possibly-wedged run on the board.
 *
 * @param updatedAt Raw `updatedAt` timestamp string.
 * @param state The run's current safety-envelope state.
 * @param nowMs Reference time in epoch milliseconds.
 * @param thresholdMs Age beyond which an in-flight run is considered stale.
 */
export const looksStale = (
  updatedAt: string,
  state: SafetyEnvelopeState,
  nowMs: number,
  thresholdMs: number
): boolean => {
  if (isTerminalState(state)) {
    return false;
  }

  const thenMs = parseTimestampMs(updatedAt);
  if (thenMs === null) {
    return false;
  }

  return nowMs - thenMs > thresholdMs;
};
