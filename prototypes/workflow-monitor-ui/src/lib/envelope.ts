import { isTerminalState } from "./format";
import type { SafetyEnvelopeState, WorkflowEventStreamEntry } from "./schemas";

/**
 * The canonical safety-envelope progression the operator reasons about. The two
 * terminal states (`captured` success / `blocked` denial) collapse into a single
 * trailing rail slot so the spine reads as a linear 13-stage walk; the optional
 * capability/review-surface lease sub-states are not on the main rail (they
 * appear inline in the timeline when an event carries them).
 *
 * Mirrors the prompt's "19-state safety-envelope" enumeration, surfacing the
 * canonical stages with the terminal pair folded into one cell.
 */
export const CANONICAL_ENVELOPE_STAGES: readonly SafetyEnvelopeState[] = [
  "received",
  "resolvingCapsule",
  "discoveringPackageMetadata",
  "checkingEntitlements",
  "pinningPackages",
  "planningDynamicWorkflow",
  "pinningPlanArtifact",
  "loadingPinnedDynamicWorkflow",
  "executingDynamicWorkflow",
  "verifyingDynamicWorkflow",
  "recordingReceipts",
  "summarizingReview",
];

/** Status of a single stage cell on the envelope spine. */
export type EnvelopeStageStatus =
  | "blocked"
  | "current"
  | "done"
  | "pending"
  | "walked";

export interface EnvelopeStageView {
  /** Whether the run is currently sitting in this stage. */
  readonly isCurrent: boolean;
  /** Whether the walked path passed through this stage. */
  readonly isWalked: boolean;
  readonly label: string;
  readonly state: SafetyEnvelopeState;
  readonly status: EnvelopeStageStatus;
}

/**
 * A pseudo-state representing the terminal outcome (`captured`/`blocked`). It is
 * never on the canonical rail directly; this label is used for the trailing
 * outcome cell.
 */
export type EnvelopeTerminalView =
  | { readonly kind: "blocked"; readonly reached: boolean }
  | { readonly kind: "captured"; readonly reached: boolean }
  | { readonly kind: "pending" };

export interface EnvelopeProgression {
  readonly currentState: SafetyEnvelopeState | null;
  readonly stages: readonly EnvelopeStageView[];
  readonly terminal: EnvelopeTerminalView;
}

const STAGE_INDEX = new Map<SafetyEnvelopeState, number>(
  CANONICAL_ENVELOPE_STAGES.map((state, index) => [state, index])
);

/**
 * Turns a `camelCase`/Pascal envelope state into a human label
 * ("resolvingCapsule" -> "Resolving capsule").
 *
 * @param state The envelope state token.
 */
export const stageLabel = (state: string): string => {
  const spaced = state
    .replaceAll(/([a-z\d])([A-Z])/gu, "$1 $2")
    .replaceAll(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .toLowerCase()
    .trim();

  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

/**
 * Derives the envelope spine view from the ordered event stream: which stages
 * were walked, which one is current (pulsing), and the terminal outcome. The
 * walked set is the union of every event's state plus the latest status; the
 * current stage is the latest non-terminal state. A stage before the current
 * one that was never explicitly emitted is still rendered `done` because the
 * envelope is strictly forward-only.
 *
 * @param events Ordered event-stream entries (ascending `eventIndex`).
 * @param latestStatus The run's current state, when known from status/stream.
 */
export const deriveEnvelopeProgression = (
  events: readonly WorkflowEventStreamEntry[],
  latestStatus: SafetyEnvelopeState | null
): EnvelopeProgression => {
  const walked = new Set<SafetyEnvelopeState>();
  for (const entry of events) {
    walked.add(entry.event.state);
  }
  if (latestStatus !== null) {
    walked.add(latestStatus);
  }

  const lastEvent = events.at(-1);
  const currentState =
    latestStatus ?? (lastEvent === undefined ? null : lastEvent.event.state);

  const isTerminal = currentState !== null && isTerminalState(currentState);

  // Furthest non-terminal rail index reached, for the forward-only "done" fill.
  let furthestIndex = -1;
  for (const state of walked) {
    const index = STAGE_INDEX.get(state);
    if (index !== undefined && index > furthestIndex) {
      furthestIndex = index;
    }
  }

  const currentIndex =
    currentState === null ? -1 : (STAGE_INDEX.get(currentState) ?? -1);

  const stages: EnvelopeStageView[] = CANONICAL_ENVELOPE_STAGES.map(
    (state, index) => {
      const isWalked = walked.has(state);
      const isCurrent = !isTerminal && index === currentIndex;

      // A stage at or before the furthest reached index (and not the pulsing
      // current cell) counts as traversed; everything beyond it is pending.
      const reached = index <= furthestIndex;

      let status: EnvelopeStageStatus;
      if (isCurrent) {
        status = "current";
      } else if (reached) {
        status = isWalked ? "walked" : "done";
      } else {
        status = "pending";
      }

      return {
        isCurrent,
        isWalked,
        label: stageLabel(state),
        state,
        status,
      };
    }
  );

  let terminal: EnvelopeTerminalView;
  if (currentState === "captured") {
    terminal = { kind: "captured", reached: true };
  } else if (currentState === "blocked") {
    terminal = { kind: "blocked", reached: true };
  } else {
    terminal = { kind: "pending" };
  }

  return { currentState, stages, terminal };
};

export interface NodeStepView {
  /** Best-effort node type from the event refs (may be empty). */
  readonly nodeType: string;
  /** The originating event's state, for context. */
  readonly state: SafetyEnvelopeState;
  readonly status: "current" | "done" | "pending";
  readonly stepId: string;
  /** Relative order this node step first appeared. */
  readonly summary: string;
}

/**
 * Extracts generated-machine node steps from the event stream. Each distinct
 * `refs.stepId` becomes one node row, ordered by first appearance. The last
 * distinct step is `current` while the run is in-flight; everything before it is
 * `done`. When the run is terminal every observed step is `done`.
 *
 * Pending (not-yet-executed) nodes are unknowable from events alone — the plan
 * artifact body is redacted out — so this list grows as the machine walks.
 *
 * @param events Ordered event-stream entries (ascending `eventIndex`).
 * @param terminal Whether the run has reached a terminal state.
 */
export const deriveNodeSteps = (
  events: readonly WorkflowEventStreamEntry[],
  terminal: boolean
): readonly NodeStepView[] => {
  const order: string[] = [];
  const byStep = new Map<
    string,
    { nodeType: string; state: SafetyEnvelopeState; summary: string }
  >();

  for (const entry of events) {
    const { stepId } = entry.event.refs;
    if (stepId === undefined || stepId === "") {
      continue;
    }
    if (!byStep.has(stepId)) {
      order.push(stepId);
    }
    // Last writer wins so the row carries the most-recent summary for the step.
    byStep.set(stepId, {
      nodeType: entry.event.refs.nodeType ?? "",
      state: entry.event.state,
      summary: entry.event.summary,
    });
  }

  return order.map((stepId, index) => {
    const detail = byStep.get(stepId);
    const isLast = index === order.length - 1;
    const status: NodeStepView["status"] =
      !terminal && isLast ? "current" : "done";

    return {
      nodeType: detail?.nodeType ?? "",
      state: detail?.state ?? "executingDynamicWorkflow",
      status,
      stepId,
      summary: detail?.summary ?? "",
    };
  });
};
