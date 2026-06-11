import type {
  SafetyEnvelopeState,
  WorkflowEventStreamEntry,
} from "$lib/schemas";

/**
 * Server-only D2 source generator for the safety-envelope state machine.
 *
 * The canonical state set and transitions are transcribed once here, mirroring
 * `src/app/workflow/machine.ts` (`dynamicWorkflowSafetyEnvelopeMachine`) in the
 * parent repo. Per request we derive the walked set + current state from the
 * live event stream and stamp each node/edge with a D2 class, so the rendered
 * SVG always reflects the run's actual path.
 *
 * This module is intentionally under `$lib/server` so SvelteKit forbids it from
 * the client bundle — it never touches tokens, but it does pull in the heavy
 * `@terrastruct/d2` renderer on the server route that calls it.
 */

/** A directed transition between two envelope states, labelled by its event. */
interface MachineEdge {
  readonly event: string;
  readonly from: SafetyEnvelopeState;
  readonly to: SafetyEnvelopeState;
}

/**
 * The canonical envelope progression order. Used only to lay the diagram out
 * top-to-bottom in a stable, readable order (the lease sub-states and terminal
 * nodes trail the main spine). Mirrors `machine.ts`'s state set exactly.
 */
const CANONICAL_STATE_ORDER: readonly SafetyEnvelopeState[] = [
  "received",
  "resolvingCapsule",
  "discoveringPackageMetadata",
  "checkingEntitlements",
  "pinningPackages",
  "planningDynamicWorkflow",
  "pinningPlanArtifact",
  "loadingPinnedDynamicWorkflow",
  "executingDynamicWorkflow",
  "requestingCapabilityLease",
  "executingCapability",
  "verifyingDynamicWorkflow",
  "recordingReceipts",
  "summarizingReview",
  "requestingReviewSurfaceDeliveryLease",
  "executingReviewSurfaceDelivery",
  "captured",
  "blocked",
];

/**
 * Every real transition in `dynamicWorkflowSafetyEnvelopeMachine`, excluding the
 * blanket `BLOCK -> blocked` escape (rendered separately so it does not clutter
 * the spine). Transcribed directly from `machine.ts` — do not invent edges.
 */
const MACHINE_EDGES: readonly MachineEdge[] = [
  { event: "START", from: "received", to: "resolvingCapsule" },
  {
    event: "CAPSULE_RESOLVED",
    from: "resolvingCapsule",
    to: "discoveringPackageMetadata",
  },
  {
    event: "PACKAGE_METADATA_DISCOVERED",
    from: "discoveringPackageMetadata",
    to: "checkingEntitlements",
  },
  {
    event: "ENTITLEMENTS_ACCEPTED",
    from: "checkingEntitlements",
    to: "pinningPackages",
  },
  {
    event: "PACKAGES_PINNED",
    from: "pinningPackages",
    to: "planningDynamicWorkflow",
  },
  {
    event: "DYNAMIC_WORKFLOW_PLANNED",
    from: "planningDynamicWorkflow",
    to: "pinningPlanArtifact",
  },
  {
    event: "PLAN_PINNED",
    from: "pinningPlanArtifact",
    to: "loadingPinnedDynamicWorkflow",
  },
  {
    event: "PINNED_DYNAMIC_WORKFLOW_LOADED",
    from: "loadingPinnedDynamicWorkflow",
    to: "executingDynamicWorkflow",
  },
  {
    event: "CAPABILITY_LEASE_REQUESTED",
    from: "executingDynamicWorkflow",
    to: "requestingCapabilityLease",
  },
  {
    event: "LEASE_ISSUED",
    from: "requestingCapabilityLease",
    to: "executingCapability",
  },
  {
    event: "CAPABILITY_EXECUTED",
    from: "executingCapability",
    to: "executingDynamicWorkflow",
  },
  {
    event: "DYNAMIC_WORKFLOW_COMPLETED",
    from: "executingDynamicWorkflow",
    to: "verifyingDynamicWorkflow",
  },
  {
    event: "DYNAMIC_WORKFLOW_VERIFIED",
    from: "verifyingDynamicWorkflow",
    to: "recordingReceipts",
  },
  {
    event: "VERIFICATION_BYPASSED",
    from: "verifyingDynamicWorkflow",
    to: "recordingReceipts",
  },
  {
    event: "RECEIPTS_RECORDED",
    from: "recordingReceipts",
    to: "summarizingReview",
  },
  {
    event: "CAPABILITY_LEASE_REQUESTED",
    from: "summarizingReview",
    to: "requestingReviewSurfaceDeliveryLease",
  },
  {
    event: "LEASE_ISSUED",
    from: "requestingReviewSurfaceDeliveryLease",
    to: "executingReviewSurfaceDelivery",
  },
  {
    event: "CAPABILITY_EXECUTED",
    from: "executingReviewSurfaceDelivery",
    to: "summarizingReview",
  },
  { event: "REVIEW_SUMMARIZED", from: "summarizingReview", to: "captured" },
];

/** Terminal states the machine can settle into. */
const TERMINAL_STATES = new Set<SafetyEnvelopeState>(["captured", "blocked"]);

/** D2 class applied to each node, derived from the live walk. */
type NodeClass = "blocked" | "captured" | "current" | "unwalked" | "walked";

/** The walked/current snapshot derived from a run's event stream. */
export interface WalkSnapshot {
  /** True once the run has settled (captured/blocked). */
  readonly isTerminal: boolean;
  /** The current (latest, non-terminal) state, or the terminal one. */
  readonly currentState: SafetyEnvelopeState | null;
  /** The state the run blocked out of, when it ended in `blocked`. */
  readonly blockedFrom: SafetyEnvelopeState | null;
  /** Every state the walk has touched. */
  readonly walked: ReadonlySet<SafetyEnvelopeState>;
}

/**
 * Turns the ordered event stream into a walk snapshot: the touched-state set,
 * the current state, and (for a blocked run) the state it blocked out of.
 *
 * The current state is the latest event's state; when that is `blocked` we look
 * one event back for the originating state so the diagram can highlight the
 * BLOCK edge's source. A run with no events yet yields an empty walk.
 *
 * @param events Ordered event-stream entries (ascending `eventIndex`).
 * @param latestStatus The run's current state when known from the status doc.
 */
export const deriveWalkSnapshot = (
  events: readonly WorkflowEventStreamEntry[],
  latestStatus: SafetyEnvelopeState | null
): WalkSnapshot => {
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

  const isTerminal = currentState !== null && TERMINAL_STATES.has(currentState);

  let blockedFrom: SafetyEnvelopeState | null = null;
  if (currentState === "blocked") {
    // The penultimate event's state is where the run blocked out of.
    const priorEvent = events.at(-2) ?? events.at(-1);
    const candidate = priorEvent?.event.state ?? null;
    blockedFrom = candidate === "blocked" ? null : candidate;
  }

  return { blockedFrom, currentState, isTerminal, walked };
};

/**
 * Picks the D2 class for a node given the live walk. Terminal nodes take their
 * own emphatic classes when reached; the current in-flight state is `current`;
 * touched states are `walked`; everything else is the dashed `unwalked`.
 *
 * @param state The envelope state to classify.
 * @param snapshot The derived walk snapshot.
 */
const classifyNode = (
  state: SafetyEnvelopeState,
  snapshot: WalkSnapshot
): NodeClass => {
  if (state === "captured" && snapshot.currentState === "captured") {
    return "captured";
  }
  if (state === "blocked" && snapshot.currentState === "blocked") {
    return "blocked";
  }
  if (state === snapshot.currentState && !snapshot.isTerminal) {
    return "current";
  }
  if (state === snapshot.blockedFrom) {
    // Emphasise the state the run blocked out of, in the blocked palette.
    return "blocked";
  }
  if (snapshot.walked.has(state)) {
    return "walked";
  }

  return "unwalked";
};

/**
 * Human label for a node. Most states use their raw token; the two terminal
 * nodes carry a `(final)` suffix so the chart reads as a settled outcome.
 *
 * @param state The envelope state.
 */
const nodeLabel = (state: SafetyEnvelopeState): string => {
  if (state === "captured") {
    return "captured  (final)";
  }
  if (state === "blocked") {
    return "blocked  (final)";
  }

  return state;
};

/**
 * D2 class block. Mirrors the styling used by `dream-pilot-001-ui`'s
 * `figures/safety-envelope-machine.d2`: walked = green, blocked = red,
 * unwalked = dashed grey, captured = grey terminal. `current` extends `walked`
 * with a thicker stroke + the brand accent so the live state pops.
 */
const D2_CLASSES = `classes: {
  walked: {
    style.fill: "#e7f3f0"
    style.stroke: "#0f766e"
    style.stroke-width: 3
  }
  current: {
    style.fill: "#cfeae2"
    style.stroke: "#0b5d52"
    style.stroke-width: 5
  }
  unwalked: {
    style.fill: "#f6f6f3"
    style.stroke: "#8c8172"
    style.stroke-dash: 3
  }
  blocked: {
    style.fill: "#f8e7e7"
    style.stroke: "#9f1239"
    style.stroke-width: 3
  }
  captured: {
    style.fill: "#eeeeea"
    style.stroke: "#111111"
    style.stroke-width: 2
  }
}`;

/**
 * Generates the full D2 source for the envelope machine with classes applied
 * from the live walk. Nodes are emitted in canonical order; edges are the real
 * machine transitions plus a single `BLOCK -> blocked` escape from the state the
 * run blocked out of (only when the run is actually blocked, to avoid drawing 17
 * red escape edges on a healthy chart).
 *
 * @param snapshot The derived walk snapshot for this run.
 */
export const buildStateDiagramSource = (snapshot: WalkSnapshot): string => {
  const lines: string[] = ["direction: down", "", D2_CLASSES, ""];

  for (const state of CANONICAL_STATE_ORDER) {
    const nodeClass = classifyNode(state, snapshot);
    lines.push(`${state}: "${nodeLabel(state)}" { class: ${nodeClass} }`);
  }
  lines.push("");

  for (const edge of MACHINE_EDGES) {
    const fromWalked = snapshot.walked.has(edge.from);
    const toWalked = snapshot.walked.has(edge.to);
    const traversed = fromWalked && toWalked;
    const edgeStyle = traversed
      ? ' { style.stroke: "#0f766e"; style.stroke-width: 2 }'
      : "";
    lines.push(`${edge.from} -> ${edge.to}: "${edge.event}"${edgeStyle}`);
  }

  // Only draw the BLOCK escape that actually fired, in the blocked palette.
  if (snapshot.currentState === "blocked" && snapshot.blockedFrom !== null) {
    lines.push(
      `${snapshot.blockedFrom} -> blocked: "BLOCK" { style.stroke: "#9f1239"; style.stroke-width: 3 }`
    );
  }

  return lines.join("\n");
};
