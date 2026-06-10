type State =
  | "planning"
  | "supervising"
  | "running_lanes"
  | "finalizing"
  | "captured"
  | "blocked"
  | "cancelled";

type Event =
  | "PLAN_PINNED"
  | "HARNESS_GENERATED"
  | "LANES_ENQUEUED"
  | "LANE_STARTED"
  | "LANE_COMMITTED"
  | "LANES_SETTLED"
  | "OBSERVABILITY_PACK_WRITTEN"
  | "VERIFICATION_ACCEPTED"
  | "VERIFICATION_BLOCKED"
  | "CLEANUP_DONE"
  | "CANCEL_REQUESTED";

const transitions: Record<State, Partial<Record<Event, State>>> = {
  blocked: {},
  cancelled: {},
  captured: {},
  finalizing: {
    CANCEL_REQUESTED: "cancelled",
    OBSERVABILITY_PACK_WRITTEN: "finalizing",
    VERIFICATION_ACCEPTED: "captured",
    VERIFICATION_BLOCKED: "blocked",
  },
  planning: {
    CANCEL_REQUESTED: "cancelled",
    PLAN_PINNED: "supervising",
  },
  running_lanes: {
    CANCEL_REQUESTED: "cancelled",
    LANES_SETTLED: "finalizing",
    LANE_COMMITTED: "running_lanes",
    LANE_STARTED: "running_lanes",
  },
  supervising: {
    CANCEL_REQUESTED: "cancelled",
    HARNESS_GENERATED: "supervising",
    LANES_ENQUEUED: "running_lanes",
  },
};

export const transitionMachine = (state: string, event: string): string => {
  const current = state as State;
  const next = transitions[current]?.[event as Event];
  return next ?? state;
};
