import { z } from "zod";

import { SafetyEnvelopeStateSchema } from "../domain/schemas.ts";
import type { SafetyEnvelopeState } from "../domain/schemas.ts";

type D1QueryValue = null | number | string;

interface D1ResultLike {
  readonly results?: readonly unknown[];
}

interface D1RunResultLike {
  readonly success?: boolean;
}

interface D1PreparedStatementLike {
  all(): Promise<D1ResultLike>;
  bind(...values: D1QueryValue[]): D1PreparedStatementLike;
  run(): Promise<D1RunResultLike>;
}

interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
}

/**
 * Runs that have reached one of these states are finished; the reaper must
 * never touch them. Mirrors the terminal set the worker route polls on.
 */
export const TERMINAL_RUN_STATES: ReadonlySet<SafetyEnvelopeState> =
  new Set<SafetyEnvelopeState>(["blocked", "captured"]);

/**
 * Status the reaper writes for a run it sweeps. `blocked` is the envelope's
 * failed terminal state.
 */
export const REAPER_FAILED_STATE: SafetyEnvelopeState = "blocked";

const reaperReasonSummary = (timeoutMs: number): string =>
  `Run reaped: stuck in a non-terminal state past WORKFLOW_APP_TIMEOUT_MS (${timeoutMs}ms).`;

const StuckRunRowSchema = z.object({
  actor_id: z.string().min(1),
  capsule_id: z.string().min(1),
  event_index: z.number().int().min(0).nullable(),
  run_id: z.string().min(1),
  status: SafetyEnvelopeStateSchema,
  work_item_id: z.string().min(1),
});

type StuckRunRow = z.infer<typeof StuckRunRowSchema>;

const isoMillisBefore = (nowIso: string, timeoutMs: number): string =>
  new Date(new Date(nowIso).getTime() - timeoutMs).toISOString();

const assertD1Write = async (
  statement: D1PreparedStatementLike,
  summary: string
): Promise<void> => {
  const result = await statement.run();
  if (result.success === false) {
    throw new Error(summary);
  }
};

export interface RunReaperConfig {
  readonly d1: D1DatabaseLike;
  readonly now?: () => string;
  /**
   * Run ids the reaper must leave alone because they are still making forward
   * progress (their latest checkpoint is fresh). Reconciles reaper-vs-resume:
   * a healthy resuming run is owned by the driver, only a wedged run (no fresh
   * checkpoint) is swept here. Defaults to none.
   */
  readonly protectedRunIds?: readonly string[];
  readonly timeoutMs: number;
  readonly workItemId: string;
}

export interface RunReaperSweepResult {
  readonly reapedRunIds: readonly string[];
}

const D1ChangesResultSchema = z.object({
  meta: z.object({ changes: z.number().optional() }).optional(),
});

/**
 * True when a guarded UPDATE actually mutated a row. D1 surfaces this via
 * `meta.changes`; absence of meta (older drivers / fakes that only report
 * success) is treated as a write so the reaper still progresses.
 */
const runRowReaped = (result: D1RunResultLike): boolean => {
  const { meta } = D1ChangesResultSchema.parse(result);
  if (meta?.changes === undefined) {
    return true;
  }

  return meta.changes > 0;
};

/**
 * Marks any non-terminal run for the given work item whose last projected event
 * is older than the timeout as `blocked`, with a reaper reason event, and reports
 * which runs were reaped so the caller can release leaked admission slots.
 *
 * Idempotent: the terminal-status guard on the UPDATE means sweeping an already
 * terminal (or already-reaped) run is a no-op and yields no reaped ids.
 */
export const reapStuckRunsForWorkItem = async (
  config: RunReaperConfig
): Promise<RunReaperSweepResult> => {
  const now = (config.now ?? (() => new Date().toISOString()))();
  const cutoff = isoMillisBefore(now, config.timeoutMs);
  const terminalStates = [...TERMINAL_RUN_STATES];

  const stuckResult = await config.d1
    .prepare(
      `select
         runs.run_id as run_id,
         runs.work_item_id as work_item_id,
         runs.capsule_id as capsule_id,
         runs.actor_id as actor_id,
         runs.status as status,
         (select max(event_index) from workflow_events where workflow_events.run_id = runs.run_id) as event_index
       from runs
       where runs.work_item_id = ?
         and runs.status not in (${terminalStates.map(() => "?").join(", ")})
         and runs.updated_at < ?`
    )
    .bind(config.workItemId, ...terminalStates, cutoff)
    .all();

  const protectedRunIds = new Set(config.protectedRunIds);
  const stuckRows: StuckRunRow[] = (stuckResult.results ?? [])
    .map((row) => StuckRunRowSchema.parse(row))
    .filter((row) => !protectedRunIds.has(row.run_id));

  const reapedRunIds: string[] = [];
  for (const row of stuckRows) {
    const updateResult = await config.d1
      .prepare(
        `update runs
         set status = ?, updated_at = ?
         where run_id = ?
           and status not in (${terminalStates.map(() => "?").join(", ")})`
      )
      .bind(REAPER_FAILED_STATE, now, row.run_id, ...terminalStates)
      .run();

    // A concurrent normal completion may have raced us to terminal; skip the
    // event row and slot release when our guarded update changed nothing.
    if (updateResult.success === false || !runRowReaped(updateResult)) {
      continue;
    }

    const nextEventIndex = (row.event_index ?? 0) + 1;
    await assertD1Write(
      config.d1
        .prepare(
          `insert into workflow_events (run_id, event_index, work_item_id, capsule_id, actor_id, state, summary, refs_json, redacted, at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           on conflict(run_id, event_index) do nothing`
        )
        .bind(
          row.run_id,
          nextEventIndex,
          row.work_item_id,
          row.capsule_id,
          row.actor_id,
          REAPER_FAILED_STATE,
          reaperReasonSummary(config.timeoutMs),
          JSON.stringify({ reaperReason: "workflow-app-timeout" }),
          1,
          now
        ),
      "Reaper failure event row could not be persisted."
    );

    reapedRunIds.push(row.run_id);
  }

  return { reapedRunIds };
};
