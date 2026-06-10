/* eslint-disable curly, sort-keys, typescript/consistent-type-definitions */

import { assign, setup } from "xstate";

import type { DreamRunStatus } from "./schema.ts";

export interface DreamWorkflowContext {
  candidateCount: number;
  error?: string;
  graphNodeCount: number;
  lastPhaseId?: string;
  runId: string;
  status: DreamRunStatus;
  workflowLaneCount: number;
}

export interface DreamWorkflowInput {
  runId?: string;
}

export type DreamWorkflowEvent =
  | { type: "START_EXPLORING" }
  | { phaseId: string; type: "STOCHASTIC_PHASE_RECORDED" }
  | {
      candidateCount: number;
      graphNodeCount: number;
      type: "REVIEW_READY";
      workflowLaneCount: number;
    }
  | { type: "APPLY_APPROVED_ITEMS" }
  | { type: "CAPTURE" }
  | { error: string; type: "FAIL" };

export const dreamWorkflowMachine = setup({
  actions: {
    fail: assign(({ context, event }) => {
      if (event.type !== "FAIL") return context;
      return { ...context, error: event.error, status: "failed" as const };
    }),
    markApplying: assign({ status: () => "applying" as const }),
    markCaptured: assign({ status: () => "captured" as const }),
    markExploring: assign({ status: () => "exploring" as const }),
    recordPhase: assign(({ context, event }) => {
      if (event.type !== "STOCHASTIC_PHASE_RECORDED") return context;
      return { ...context, lastPhaseId: event.phaseId };
    }),
    recordReviewReady: assign(({ context, event }) => {
      if (event.type !== "REVIEW_READY") return context;
      return {
        ...context,
        candidateCount: event.candidateCount,
        graphNodeCount: event.graphNodeCount,
        status: "review_ready" as const,
        workflowLaneCount: event.workflowLaneCount,
      };
    }),
  },
  types: {} as {
    context: DreamWorkflowContext;
    events: DreamWorkflowEvent;
    input: DreamWorkflowInput;
  },
}).createMachine({
  context: ({ input }) => ({
    candidateCount: 0,
    graphNodeCount: 0,
    runId: input.runId ?? "dream-local-prototype",
    status: "queued",
    workflowLaneCount: 0,
  }),
  id: "shitrat-dream-safety-envelope",
  initial: "queued",
  states: {
    applying: {
      on: {
        CAPTURE: { actions: "markCaptured", target: "captured" },
        FAIL: { actions: "fail", target: "failed" },
      },
    },
    captured: { type: "final" },
    exploring: {
      on: {
        FAIL: { actions: "fail", target: "failed" },
        REVIEW_READY: { actions: "recordReviewReady", target: "reviewReady" },
        STOCHASTIC_PHASE_RECORDED: { actions: "recordPhase" },
      },
    },
    failed: {},
    queued: {
      on: {
        START_EXPLORING: { actions: "markExploring", target: "exploring" },
      },
    },
    reviewReady: {
      on: {
        APPLY_APPROVED_ITEMS: { actions: "markApplying", target: "applying" },
        CAPTURE: { actions: "markCaptured", target: "captured" },
        FAIL: { actions: "fail", target: "failed" },
      },
    },
  },
});
