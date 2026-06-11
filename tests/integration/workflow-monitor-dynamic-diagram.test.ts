import { describe, expect, it } from "vitest";

import {
  buildDynamicWorkflowDiagramSource,
  deriveDynamicWorkflowView,
  shortNodeLabel,
} from "../../prototypes/workflow-monitor-ui/src/lib/server/dynamic-workflow-diagram.ts";
import type { DiagramEventEntry } from "../../prototypes/workflow-monitor-ui/src/lib/server/dynamic-workflow-diagram.ts";

/**
 * Unit coverage for the monitor's generated-dynamic-workflow chart derivation.
 *
 * The chart is the run page's primary live view: it reconstructs the executed
 * node chain (and current/blocked node) from the redacted event stream, since
 * the full planned graph lives only in the per-run machine artifact (too heavy
 * to clone on the poll loop). These tests pin the events-derived classification
 * and the D2 source it emits.
 */

const executingEvent = (
  stepId: string,
  nodeType: string
): DiagramEventEntry => ({
  event: {
    refs: { nodeType, stepId },
    state: "executingDynamicWorkflow",
  },
});

describe(shortNodeLabel, () => {
  it("reduces a namespaced node type to its final segment", () => {
    expect(shortNodeLabel("joelclaw.memory.capture-artifact")).toBe(
      "capture-artifact"
    );
    expect(shortNodeLabel("joelclaw.memory.signals")).toBe("signals");
  });

  it("returns a bare token unchanged", () => {
    expect(shortNodeLabel("search")).toBe("search");
  });
});

describe(deriveDynamicWorkflowView, () => {
  it("marks the last executed node current and earlier nodes walked while in-flight", () => {
    const view = deriveDynamicWorkflowView(
      [
        executingEvent("step-capture-run", "joelclaw.memory.capture-run"),
        executingEvent("step-search", "joelclaw.memory.search"),
        executingEvent("step-signals", "joelclaw.memory.signals"),
      ],
      "executingDynamicWorkflow",
      null
    );

    expect(
      view.nodes.map((node) => [node.label, node.nodeClass])
    ).toStrictEqual([
      ["capture-run", "walked"],
      ["search", "walked"],
      ["signals", "current"],
    ]);
    expect(view.isTerminal).toBeFalsy();
    expect(view.showPendingTail).toBeTruthy();
    expect(view.blockerReason).toBeNull();
  });

  it("marks every node captured and hides the pending tail on a captured run", () => {
    const view = deriveDynamicWorkflowView(
      [
        executingEvent("step-search", "joelclaw.memory.search"),
        executingEvent("step-report", "joelclaw.memory.hitl-report"),
      ],
      "captured",
      null
    );

    expect(
      view.nodes.every((node) => node.nodeClass === "captured")
    ).toBeTruthy();
    expect(view.isTerminal).toBeTruthy();
    expect(view.showPendingTail).toBeFalsy();
  });

  it("lights the blocker's named node red and carries the reason", () => {
    const view = deriveDynamicWorkflowView(
      [
        executingEvent("step-search", "joelclaw.memory.search"),
        executingEvent("step-correlate", "joelclaw.memory.correlate"),
      ],
      "blocked",
      {
        message: "Capability denied for memory correlate.",
        stepId: "step-correlate",
      }
    );

    const blockedNode = view.nodes.find((node) => node.nodeClass === "blocked");
    expect(blockedNode?.stepId).toBe("step-correlate");
    expect(
      view.nodes.filter((node) => node.nodeClass === "blocked")
    ).toHaveLength(1);
    expect(view.blockerReason).toBe("Capability denied for memory correlate.");
    expect(view.showPendingTail).toBeFalsy();
  });

  it("falls back to the last executed node when the blocker names no step", () => {
    const view = deriveDynamicWorkflowView(
      [
        executingEvent("step-search", "joelclaw.memory.search"),
        executingEvent("step-hydrate", "joelclaw.memory.hydrate"),
      ],
      "blocked",
      { message: "Run blocked." }
    );

    expect(view.nodes.at(-1)?.nodeClass).toBe("blocked");
    expect(view.nodes.at(0)?.nodeClass).toBe("walked");
  });

  it("ignores events that carry no step id", () => {
    const view = deriveDynamicWorkflowView(
      [
        { event: { refs: {}, state: "planningDynamicWorkflow" } },
        executingEvent("step-search", "joelclaw.memory.search"),
      ],
      "executingDynamicWorkflow",
      null
    );

    expect(view.nodes).toHaveLength(1);
    expect(view.nodes[0]?.label).toBe("search");
  });
});

describe(buildDynamicWorkflowDiagramSource, () => {
  const inFlightSource = (): string =>
    buildDynamicWorkflowDiagramSource(
      deriveDynamicWorkflowView(
        [
          executingEvent("step-search", "joelclaw.memory.search"),
          executingEvent("step-signals", "joelclaw.memory.signals"),
        ],
        "executingDynamicWorkflow",
        null
      )
    );

  it("emits a left-to-right chain of classed nodes with a pending tail node", () => {
    const source = inFlightSource();

    expect(source).toContain("direction: right");
    expect(source).toContain("class: walked");
    expect(source).toContain("class: current");
    expect(source).toContain('pending: "pending…" { class: pending }');
  });

  it("chains the executed nodes into the pending tail", () => {
    const source = inFlightSource();

    expect(source).toContain("n0 -> n1");
    expect(source).toContain("n1 -> pending");
  });

  it("caps a captured run with a grey captured terminal node", () => {
    const view = deriveDynamicWorkflowView(
      [executingEvent("step-report", "joelclaw.memory.hitl-report")],
      "captured",
      null
    );
    const source = buildDynamicWorkflowDiagramSource(view);

    expect(source).toContain(
      'captured: "captured  (final)" { class: captured }'
    );
    expect(source).toContain("n0 -> captured");
    expect(source).not.toContain("pending…");
  });

  it("renders a lone pending node when no steps have executed yet", () => {
    const view = deriveDynamicWorkflowView([], "planningDynamicWorkflow", null);
    const source = buildDynamicWorkflowDiagramSource(view);

    expect(source).toContain('pending: "pending…" { class: pending }');
    expect(source).not.toContain("n0");
  });

  it("escapes quotes in a blocker reason so the D2 literal stays valid", () => {
    const view = deriveDynamicWorkflowView(
      [executingEvent("step-search", "joelclaw.memory.search")],
      "blocked",
      { message: 'Denied: "review_required" gate.', stepId: "step-search" }
    );
    const source = buildDynamicWorkflowDiagramSource(view);

    expect(source).toContain("class: blocked");
    expect(source).toContain('\\"review_required\\"');
  });
});
