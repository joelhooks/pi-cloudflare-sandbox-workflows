import {
  AgentLaneAdmissionDecisionSchema,
  AgentLaneDispatchReceiptSchema,
  AgentLaneProcessStatusReceiptSchema,
  AgentLaneReceiptSchema,
  AgentLaneReleaseRequestSchema,
} from "../domain/schemas.ts";
import type {
  AgentLaneDispatchReceipt,
  AgentLaneReceipt,
} from "../domain/schemas.ts";
import type {
  AgentLaneAdmissionControllerContract,
  AgentLaneRuntimePort,
  AgentLaneRuntimeRequest,
} from "./ports.ts";

export interface AdmittedAgentLaneRuntimeConfig {
  readonly admissionController: AgentLaneAdmissionControllerContract;
  readonly maxActiveLanes: number;
  readonly now?: () => string;
  readonly runtime: AgentLaneRuntimePort;
}

export class AgentLaneAlreadyCompletedError extends Error {
  readonly artifactCommitSha: string | undefined;
  readonly kind: AgentLaneRuntimeRequest["kind"];
  readonly laneId: string;
  readonly runId: string;
  readonly workItemId: string;

  constructor(input: {
    readonly artifactCommitSha?: string;
    readonly kind: AgentLaneRuntimeRequest["kind"];
    readonly laneId: string;
    readonly runId: string;
    readonly workItemId: string;
  }) {
    super(
      `Agent lane already completed; refusing duplicate execution: ${input.laneId}`
    );
    this.name = "AgentLaneAlreadyCompletedError";
    this.artifactCommitSha = input.artifactCommitSha;
    this.kind = input.kind;
    this.laneId = input.laneId;
    this.runId = input.runId;
    this.workItemId = input.workItemId;
  }
}

const defaultNow = (): string => new Date().toISOString();

const releaseStatusFor = (receipt: AgentLaneReceipt): "completed" | "failed" =>
  receipt.status === "completed" ? "completed" : "failed";

const assertReceiptMatchesRequest = (
  request: AgentLaneRuntimeRequest,
  receipt: AgentLaneReceipt
): void => {
  if (receipt.kind !== request.kind || receipt.laneId !== request.laneId) {
    throw new Error(
      "Agent lane receipt does not match the admitted lane request."
    );
  }
};

const releaseLane = (
  config: AdmittedAgentLaneRuntimeConfig,
  request: AgentLaneRuntimeRequest,
  receipt: AgentLaneReceipt | undefined,
  status: "completed" | "failed"
) => {
  const artifactCommitSha =
    receipt?.artifactCommitSha === undefined
      ? {}
      : { artifactCommitSha: receipt.artifactCommitSha };

  return config.admissionController.releaseLane(
    AgentLaneReleaseRequestSchema.parse({
      ...artifactCommitSha,
      kind: request.kind,
      laneId: request.laneId,
      releasedAt: (config.now ?? defaultNow)(),
      runId: request.runId,
      status,
      workItemId: request.workItemId,
    })
  );
};

const releaseDispatchedLane = (
  config: AdmittedAgentLaneRuntimeConfig,
  dispatch: AgentLaneDispatchReceipt,
  input: {
    readonly receipt?: AgentLaneReceipt;
    readonly status: "completed" | "failed";
  }
) => {
  const artifactCommitSha =
    input.receipt?.artifactCommitSha === undefined
      ? {}
      : { artifactCommitSha: input.receipt.artifactCommitSha };

  return config.admissionController.releaseLane(
    AgentLaneReleaseRequestSchema.parse({
      ...artifactCommitSha,
      kind: dispatch.kind,
      laneId: dispatch.laneId,
      releasedAt: (config.now ?? defaultNow)(),
      runId: dispatch.runId,
      status: input.status,
      workItemId: dispatch.workItemId,
    })
  );
};

export const createAdmittedAgentLaneRuntime = (
  config: AdmittedAgentLaneRuntimeConfig
): AgentLaneRuntimePort => {
  const admittedRuntime: AgentLaneRuntimePort = {
    async runLane(request) {
      const admission = AgentLaneAdmissionDecisionSchema.parse(
        await config.admissionController.admitLane({
          kind: request.kind,
          laneId: request.laneId,
          maxActiveLanes: config.maxActiveLanes,
          requestedAt: (config.now ?? defaultNow)(),
          runId: request.runId,
          workItemId: request.workItemId,
        })
      );

      if (admission.status === "already-completed") {
        const artifactCommitSha =
          admission.artifactCommitSha === undefined
            ? {}
            : { artifactCommitSha: admission.artifactCommitSha };
        throw new AgentLaneAlreadyCompletedError({
          ...artifactCommitSha,
          kind: admission.kind,
          laneId: admission.laneId,
          runId: admission.runId,
          workItemId: admission.workItemId,
        });
      }

      if (admission.status === "deferred") {
        throw new Error(
          `Agent lane admission deferred: ${request.laneId} (${admission.reason}); retry after ${admission.retryAfterSeconds}s.`
        );
      }

      let receipt: AgentLaneReceipt;
      try {
        receipt = AgentLaneReceiptSchema.parse(
          await config.runtime.runLane(request)
        );
        assertReceiptMatchesRequest(request, receipt);
      } catch (error) {
        await releaseLane(config, request, undefined, "failed");
        throw error;
      }

      await releaseLane(config, request, receipt, releaseStatusFor(receipt));

      return receipt;
    },
    runtime: config.runtime.runtime,
  };

  if (
    config.runtime.dispatchLane !== undefined &&
    config.runtime.pollLane !== undefined &&
    config.runtime.readLaneReceipt !== undefined
  ) {
    admittedRuntime.cleanupLane = async (input) => {
      try {
        await config.runtime.cleanupLane?.(input);
      } finally {
        await releaseDispatchedLane(config, input.dispatch, {
          ...(input.receipt === undefined ? {} : { receipt: input.receipt }),
          status: input.reason === "completed" ? "completed" : "failed",
        });
      }
    };

    admittedRuntime.dispatchLane = async (request) => {
      const admission = AgentLaneAdmissionDecisionSchema.parse(
        await config.admissionController.admitLane({
          kind: request.kind,
          laneId: request.laneId,
          maxActiveLanes: config.maxActiveLanes,
          requestedAt: (config.now ?? defaultNow)(),
          runId: request.runId,
          workItemId: request.workItemId,
        })
      );

      if (admission.status === "already-completed") {
        const artifactCommitSha =
          admission.artifactCommitSha === undefined
            ? {}
            : { artifactCommitSha: admission.artifactCommitSha };
        throw new AgentLaneAlreadyCompletedError({
          ...artifactCommitSha,
          kind: admission.kind,
          laneId: admission.laneId,
          runId: admission.runId,
          workItemId: admission.workItemId,
        });
      }

      if (admission.status === "deferred") {
        throw new Error(
          `Agent lane admission deferred: ${request.laneId} (${admission.reason}); retry after ${admission.retryAfterSeconds}s.`
        );
      }

      try {
        const dispatch = await config.runtime.dispatchLane?.(request);
        if (dispatch === undefined) {
          throw new Error(
            "Agent lane runtime does not support async dispatch."
          );
        }

        return AgentLaneDispatchReceiptSchema.parse(dispatch);
      } catch (error) {
        await releaseLane(config, request, undefined, "failed");
        throw error;
      }
    };

    admittedRuntime.pollLane = async (input) => {
      const statusReceipt = await config.runtime.pollLane?.(input);
      if (statusReceipt === undefined) {
        throw new Error("Agent lane runtime does not support async polling.");
      }

      return AgentLaneProcessStatusReceiptSchema.parse(statusReceipt);
    };

    admittedRuntime.readLaneReceipt = async (input) => {
      const receipt = await config.runtime.readLaneReceipt?.(input);
      if (receipt === undefined) {
        throw new Error(
          "Agent lane runtime does not support receipt recovery."
        );
      }

      return receipt === null ? null : AgentLaneReceiptSchema.parse(receipt);
    };
  }

  return admittedRuntime;
};
