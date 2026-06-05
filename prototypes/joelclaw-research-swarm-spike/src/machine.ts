import { MachineReceiptSchema } from "./schema.ts";
import type { MachineReceipt, ResearchTask } from "./schema.ts";

const STATES = [
  "preparingPrelaunch",
  "scoutingJoelClaw",
  "mappingThemes",
  "renderingReviewPage",
  "planningNeedsOperator",
  "awaitingOperatorApproval",
  "committingApprovedArtifacts",
  "publishingObserver",
  "admittingResearchLanes",
  "runningHotResearchLanes",
  "waitingFanIn",
  "synthesizingBrainPage",
  "runningVerifier",
  "renderingBrainPage",
  "deliveringOutput",
  "destroyingSandboxes",
  "captured",
  "blocked",
  "cancelling",
  "cancelled",
] as const;

const TRANSITIONS: Record<string, Record<string, string>> = {
  admittingResearchLanes: {
    RESEARCH_LANES_ADMITTED: "runningHotResearchLanes",
  },
  awaitingOperatorApproval: {
    OPERATOR_APPROVED: "committingApprovedArtifacts",
    OPERATOR_EDIT_REQUESTED: "planningNeedsOperator",
    OPERATOR_REJECTED: "blocked",
  },
  cancelling: {
    CLEANUP_DONE: "cancelled",
  },
  committingApprovedArtifacts: {
    APPROVED_ARTIFACTS_COMMITTED: "publishingObserver",
  },
  deliveringOutput: {
    OUTPUT_DELIVERED: "destroyingSandboxes",
  },
  destroyingSandboxes: {
    CLEANUP_DONE: "captured",
    SANDBOX_DESTROYED: "destroyingSandboxes",
  },
  mappingThemes: {
    THEME_MAP_READY: "renderingReviewPage",
  },
  planningNeedsOperator: {
    PLAN_REVISED: "renderingReviewPage",
  },
  preparingPrelaunch: {
    PRELAUNCH_ENVELOPE_READY: "scoutingJoelClaw",
  },
  publishingObserver: {
    OBSERVER_PUBLISHED: "admittingResearchLanes",
  },
  renderingBrainPage: {
    BRAIN_PAGE_RENDERED: "deliveringOutput",
  },
  renderingReviewPage: {
    REVIEW_PAGE_RENDERED: "awaitingOperatorApproval",
  },
  runningHotResearchLanes: {
    ALL_REQUIRED_LANES_SETTLED: "waitingFanIn",
    LANE_FAILED: "runningHotResearchLanes",
    LANE_OUTPUT_COMMITTED: "runningHotResearchLanes",
    LANE_RETRY_ENQUEUED: "runningHotResearchLanes",
    LANE_STARTED: "runningHotResearchLanes",
  },
  runningVerifier: {
    VERIFICATION_BLOCKED: "blocked",
    VERIFICATION_VERIFIED: "renderingBrainPage",
    VERIFICATION_WARNINGS: "renderingBrainPage",
  },
  scoutingJoelClaw: {
    SCOUT_RECEIPTS_READY: "mappingThemes",
  },
  synthesizingBrainPage: {
    SYNTHESIS_COMMITTED: "runningVerifier",
  },
  waitingFanIn: {
    FAN_IN_READY: "synthesizingBrainPage",
  },
};

export const buildMachineReceipt = (task: ResearchTask): MachineReceipt => {
  const states = STATES.map((id) => {
    const isFinal = ["captured", "blocked", "cancelled"].includes(id);
    const on = isFinal
      ? {}
      : {
          ...(id === "destroyingSandboxes"
            ? {}
            : { CANCEL_REQUESTED: "cancelling" }),
          ...TRANSITIONS[id],
        };
    const tags: string[] = [];
    if (["awaitingOperatorApproval", "planningNeedsOperator"].includes(id)) {
      tags.push("operator-gate");
    }
    if (["scoutingJoelClaw", "mappingThemes"].includes(id)) {
      tags.push("adaptive-planning");
    }
    if (id === "publishingObserver") {
      tags.push("observer");
    }
    if (["runningHotResearchLanes", "waitingFanIn"].includes(id)) {
      tags.push("fanout");
    }
    if (["runningVerifier", "renderingBrainPage"].includes(id)) {
      tags.push("verification");
    }
    if (["destroyingSandboxes", "cancelling"].includes(id)) {
      tags.push("cleanup");
    }
    return {
      id,
      kind: isFinal ? ("final" as const) : ("normal" as const),
      on,
      tags,
    };
  });

  const events = [
    ...new Set(states.flatMap((state) => Object.keys(state.on))),
  ].toSorted();

  return MachineReceiptSchema.parse({
    approvalRequiredBefore: "admittingResearchLanes",
    cancellationEvent: "CANCEL_REQUESTED",
    contextKeys: [
      "workItemId",
      "targetBrainPage",
      "researchEnvelope",
      "sourcePolicy",
      "themeMap",
      "operatorApproval",
      "verificationContract",
      "observerTarget",
      "publicObserverUrl",
      "laneReceipts",
    ],
    events,
    id: `adaptive_research_swarm:${task.workItemId}`,
    initial: "preparingPrelaunch",
    pattern: "adaptive_research_swarm",
    receiptOnly: false,
    states,
    xstateVersion: "v5",
  });
};

export const transitionMachine = (
  machine: MachineReceipt,
  currentState: string,
  event: string
): string => {
  const state = machine.states.find(
    (candidate) => candidate.id === currentState
  );
  return state?.on[event] ?? currentState;
};
