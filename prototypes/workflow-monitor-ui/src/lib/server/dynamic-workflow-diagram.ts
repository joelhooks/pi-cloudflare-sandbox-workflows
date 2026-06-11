/**
 * Structural input shapes for the dynamic-workflow derivation. These mirror the
 * relevant fields of `$lib/schemas`'s `WorkflowEventStreamEntry` /
 * `WorkflowTerminalBlocker` but are declared locally so this pure module carries
 * no `$lib`/SvelteKit alias dependency and can be unit-tested directly from the
 * root vitest suite. The route passes the (structurally compatible) parsed
 * documents in.
 */

/**
 * The envelope state token. Kept as a permissive `string` here (the chart treats
 * `captured`/`blocked` specially and everything else as in-flight) so the module
 * stays decoupled from the full enum mirror in `$lib/schemas`.
 */
export type DiagramEnvelopeState = string;

/** A single redacted event-stream entry, as far as the chart cares. */
export interface DiagramEventEntry {
  readonly event: {
    readonly refs: Readonly<Record<string, string>>;
    readonly state: DiagramEnvelopeState;
  };
}

/** The terminal blocker detail, as far as the chart cares. */
export interface DiagramBlocker {
  readonly message: string;
  readonly stepId?: string;
}

/**
 * Server-only D2 source generator for the *generated dynamic workflow* — the
 * per-run node chain the planner stochastically synthesised, walking inside the
 * fixed safety-envelope shell. This is the chart the operator cares about most:
 * it is different every run.
 *
 * Data source: the live event stream. Each executed node emits events carrying
 * `refs.stepId` + `refs.nodeType`, so the executed chain (with the current node)
 * is reconstructable in order. The *full* planned graph (including not-yet-run
 * nodes) lives only in the run's pinned `machine.config.json` artifact, which
 * sits in a per-run git-backed Cloudflare Artifacts repo — too heavy to clone on
 * the monitor's ~4s poll. So this chart shows the live-growing executed chain
 * plus a single dashed "pending…" tail while the run is still in-flight; the
 * concrete pending node identities are not shown (they are unknowable from
 * events alone).
 *
 * Lives under `$lib/server` so SvelteKit forbids it from the client bundle. It
 * never touches tokens; it only consumes the already-redacted event document the
 * proxy fetched server-side.
 */

/** D2 class applied to each node, derived from the live walk. */
type NodeClass = "blocked" | "captured" | "current" | "pending" | "walked";

/** A single node in the generated dynamic workflow chain. */
export interface DynamicNodeView {
  /** D2 class controlling fill/stroke + the live pulse. */
  readonly nodeClass: NodeClass;
  /** Short, human label (last dotted segment of the nodeType). */
  readonly label: string;
  /** The originating event state, for context. */
  readonly state: DiagramEnvelopeState;
  /** The plan step id (D2 node key + subtext). */
  readonly stepId: string;
}

/** The full derived view of a run's generated dynamic workflow. */
export interface DynamicWorkflowView {
  /** When blocked, the denial reason to stamp on the blocking node. */
  readonly blockerReason: string | null;
  /** True once the run has settled (captured/blocked). */
  readonly isTerminal: boolean;
  /** Ordered node chain, first-executed first. */
  readonly nodes: readonly DynamicNodeView[];
  /** True while in-flight (draw a dashed pending tail). */
  readonly showPendingTail: boolean;
}

const TERMINAL_STATES = new Set<DiagramEnvelopeState>(["captured", "blocked"]);

/**
 * Reduces a namespaced node type (`joelclaw.memory.capture-artifact`) to its
 * final segment (`capture-artifact`) for a compact chart label. A bare token is
 * returned unchanged; an empty input falls back to the step id by the caller.
 *
 * @param nodeType The full (possibly namespaced) node type token.
 */
export const shortNodeLabel = (nodeType: string): string => {
  const segments = nodeType.split(".").filter((segment) => segment.length > 0);

  return segments.at(-1) ?? nodeType;
};

/**
 * Derives the generated dynamic workflow view from the ordered event stream.
 *
 * Each distinct `refs.stepId` becomes one node, ordered by first appearance, and
 * labelled by the short form of its `refs.nodeType`. The last distinct node is
 * the `current` (pulsing) node while in-flight; everything before it is `walked`
 * (executed). On a terminal `captured` run every node is `captured`. On a
 * `blocked` run the node the blocker names (or, failing that, the last executed
 * node) is `blocked` and carries the reason.
 *
 * @param events Ordered event-stream entries (ascending `eventIndex`).
 * @param latestStatus The run's current state, when known from status/stream.
 * @param blocker The terminal blocker, when the run ended `blocked`.
 */
export const deriveDynamicWorkflowView = (
  events: readonly DiagramEventEntry[],
  latestStatus: DiagramEnvelopeState | null,
  blocker: DiagramBlocker | null
): DynamicWorkflowView => {
  const order: string[] = [];
  const byStep = new Map<
    string,
    { nodeType: string; state: DiagramEnvelopeState }
  >();

  for (const entry of events) {
    const { stepId } = entry.event.refs;
    if (stepId === undefined || stepId === "") {
      continue;
    }
    if (!byStep.has(stepId)) {
      order.push(stepId);
    }
    // Last writer wins so the row carries the most-recent node type for the step.
    byStep.set(stepId, {
      nodeType: entry.event.refs["nodeType"] ?? "",
      state: entry.event.state,
    });
  }

  const lastEvent = events.at(-1);
  const currentState =
    latestStatus ?? (lastEvent === undefined ? null : lastEvent.event.state);
  const isTerminal = currentState !== null && TERMINAL_STATES.has(currentState);
  const isCaptured = currentState === "captured";
  const isBlocked = currentState === "blocked";

  // The node the run blocked out of: the blocker's stepId when present, else
  // the last executed node, so a blocked run always lights exactly one node red.
  const blockedStepId = isBlocked
    ? (blocker?.stepId ?? order.at(-1) ?? null)
    : null;

  const nodes: DynamicNodeView[] = order.map((stepId, index) => {
    const detail = byStep.get(stepId);
    const isLast = index === order.length - 1;
    const label =
      detail !== undefined && detail.nodeType !== ""
        ? shortNodeLabel(detail.nodeType)
        : stepId;

    let nodeClass: NodeClass;
    if (stepId === blockedStepId) {
      nodeClass = "blocked";
    } else if (isCaptured) {
      nodeClass = "captured";
    } else if (!isTerminal && isLast) {
      nodeClass = "current";
    } else {
      nodeClass = "walked";
    }

    return {
      label,
      nodeClass,
      state: detail?.state ?? "executingDynamicWorkflow",
      stepId,
    };
  });

  return {
    blockerReason:
      isBlocked && blocker !== null && blocker.message.length > 0
        ? blocker.message
        : null,
    isTerminal,
    nodes,
    // A dashed "pending…" tail communicates "more nodes will come" while the
    // run is still walking. Hidden once terminal (nothing more will execute).
    showPendingTail: !isTerminal,
  };
};

/**
 * D2 class block for the generated dynamic workflow chain. Mirrors the envelope
 * chart's palette: walked = green, current = heavier green + pulse, blocked =
 * red, captured = grey terminal, pending = dashed grey.
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
  pending: {
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

/** Escapes a string for use inside a D2 double-quoted literal. */
const d2Quote = (value: string): string =>
  value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

/** Stable D2 node key for the nth chain node. */
const nodeKey = (index: number): string => `n${index}`;

/** D2 style for an executed (green) edge. */
const WALKED_EDGE = ' { style.stroke: "#0f766e"; style.stroke-width: 2 }';

/** Whether the chain should cap with a grey terminal `captured` node. */
const hasCapturedCap = (view: DynamicWorkflowView): boolean =>
  view.isTerminal &&
  !view.showPendingTail &&
  view.blockerReason === null &&
  view.nodes.at(-1)?.nodeClass === "captured";

/** Emits the D2 declaration line for one chain node. */
const nodeLine = (
  view: DynamicWorkflowView,
  index: number,
  node: DynamicNodeView
): string => {
  const subtext = node.stepId === node.label ? "" : `\\n${node.stepId}`;
  const reasonSuffix =
    node.nodeClass === "blocked" && view.blockerReason !== null
      ? `\\n⛔ ${view.blockerReason.slice(0, 64)}`
      : "";

  return `${nodeKey(index)}: "${d2Quote(
    `${node.label}${subtext}${reasonSuffix}`
  )}" { class: ${node.nodeClass} }`;
};

/** Emits the inter-node chain edges (green when both ends were walked). */
const chainEdgeLines = (view: DynamicWorkflowView): string[] => {
  const edges: string[] = [];
  for (let index = 0; index < view.nodes.length - 1; index += 1) {
    const traversed =
      view.nodes[index]?.nodeClass !== "pending" &&
      view.nodes[index + 1]?.nodeClass !== "pending";
    edges.push(
      `${nodeKey(index)} -> ${nodeKey(index + 1)}${traversed ? WALKED_EDGE : ""}`
    );
  }

  return edges;
};

/**
 * Builds the full D2 source for a run's generated dynamic workflow as a
 * left-to-right node chain. Each node renders its short label with the step id
 * as subtext; a trailing dashed `pending…` node communicates the not-yet-walked
 * tail while in-flight. A captured run appends a grey `captured` cap; a blocked
 * run's blocking node carries the (truncated) reason.
 *
 * When the run has emitted no node steps yet, a single informational placeholder
 * node is drawn so the chart never renders empty.
 *
 * @param view The derived dynamic-workflow view for this run.
 */
export const buildDynamicWorkflowDiagramSource = (
  view: DynamicWorkflowView
): string => {
  const lines: string[] = ["direction: right", "", D2_CLASSES, ""];

  if (view.nodes.length === 0) {
    lines.push(
      view.showPendingTail
        ? 'pending: "pending…" { class: pending }'
        : 'empty: "no generated nodes" { class: pending }'
    );

    return lines.join("\n");
  }

  for (const [index, node] of view.nodes.entries()) {
    lines.push(nodeLine(view, index, node));
  }

  if (hasCapturedCap(view)) {
    lines.push('captured: "captured  (final)" { class: captured }');
  }
  if (view.showPendingTail) {
    lines.push('pending: "pending…" { class: pending }');
  }

  lines.push("", ...chainEdgeLines(view));

  const lastIndex = view.nodes.length - 1;
  if (view.showPendingTail) {
    lines.push(`${nodeKey(lastIndex)} -> pending { style.stroke-dash: 3 }`);
  } else if (hasCapturedCap(view)) {
    lines.push(`${nodeKey(lastIndex)} -> captured${WALKED_EDGE}`);
  }

  return lines.join("\n");
};
