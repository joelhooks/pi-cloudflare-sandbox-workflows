import {
  AgentLaneAdmissionDecisionSchema,
  AgentLaneReceiptSchema,
  AgentLaneReleaseRequestSchema,
} from "../domain/schemas.ts";
import type { AgentLaneReceipt } from "../domain/schemas.ts";
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

export const createAdmittedAgentLaneRuntime = (
  config: AdmittedAgentLaneRuntimeConfig
): AgentLaneRuntimePort => ({
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
});
