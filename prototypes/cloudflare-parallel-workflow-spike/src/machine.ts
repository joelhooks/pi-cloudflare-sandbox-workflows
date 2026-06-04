import { MachineReceiptSchema } from "./schema.ts";
import type { JobSpec, MachineReceipt } from "./schema.ts";

const STATES = [
  "planning",
  "validatingPlan",
  "committingPlanArtifacts",
  "admittingLanes",
  "enqueueingLaneJobs",
  "runningFanoutLanes",
  "waitingFanIn",
  "synthesizingResults",
  "runningVerifier",
  "evaluatingVerification",
  "deliveringOutput",
  "destroyingSandboxes",
  "captured",
  "blocked",
  "cancelling",
  "cancelled",
] as const;

const TRANSITIONS: Record<string, Record<string, string>> = {
  admittingLanes: {
    LANES_ADMITTED: "enqueueingLaneJobs",
  },
  cancelling: {
    CLEANUP_DONE: "cancelled",
  },
  committingPlanArtifacts: {
    PLAN_PINNED: "admittingLanes",
  },
  deliveringOutput: {
    OUTPUT_DELIVERED: "destroyingSandboxes",
  },
  destroyingSandboxes: {
    CLEANUP_DONE: "captured",
    SANDBOX_DESTROYED: "destroyingSandboxes",
  },
  enqueueingLaneJobs: {
    LANE_ENQUEUED: "runningFanoutLanes",
  },
  evaluatingVerification: {
    VERIFICATION_BLOCKED: "blocked",
    VERIFICATION_VERIFIED: "deliveringOutput",
  },
  planning: {
    PLAN_GENERATED: "validatingPlan",
  },
  runningFanoutLanes: {
    ALL_REQUIRED_LANES_SETTLED: "waitingFanIn",
    LANE_DEGRADED: "runningFanoutLanes",
    LANE_FAILED: "runningFanoutLanes",
    LANE_OUTPUT_COMMITTED: "runningFanoutLanes",
    LANE_RETRY_ENQUEUED: "runningFanoutLanes",
    LANE_STARTED: "runningFanoutLanes",
  },
  runningVerifier: {
    VERIFIER_DONE: "evaluatingVerification",
  },
  synthesizingResults: {
    SYNTHESIS_COMMITTED: "runningVerifier",
  },
  validatingPlan: {
    PLAN_VALIDATED: "committingPlanArtifacts",
  },
  waitingFanIn: {
    ALL_REQUIRED_LANES_SETTLED: "synthesizingResults",
  },
};

export const buildMachineReceipt = (jobSpec: JobSpec): MachineReceipt => {
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
    if (["runningFanoutLanes", "waitingFanIn"].includes(id)) {
      tags.push("fanout");
    }
    if (["runningVerifier", "evaluatingVerification"].includes(id)) {
      tags.push("verification");
    }
    if (id === "deliveringOutput") {
      tags.push("output-target");
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
    cancellationEvent: "CANCEL_REQUESTED",
    concurrencyCap: jobSpec.parallel.concurrencyCap,
    contextKeys: [
      "workItemId",
      "contextPackRefs",
      "secretRefs",
      "parallel",
      "verificationContract",
      "outputTarget",
      "lanes",
    ],
    events,
    fanIn: jobSpec.parallel.fanIn,
    id: `fanout_synthesis:${jobSpec.outputTarget.kind}:${jobSpec.workItemId}`,
    initial: "planning",
    outputDeliveryState: "deliveringOutput",
    pattern: "fanout_synthesis",
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
