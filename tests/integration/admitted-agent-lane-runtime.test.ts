import { describe, expect, it } from "vitest";

import { createAdmittedAgentLaneRuntime } from "../../src/app/application/admitted-agent-lane-runtime.ts";
import type {
  AgentLaneAdmissionControllerContract,
  AgentLaneRuntimePort,
  AgentLaneRuntimeRequest,
} from "../../src/app/application/ports.ts";
import { sha256Hex } from "../../src/app/domain/hash.ts";
import {
  AgentLaneAdmissionDecisionSchema,
  AgentLaneReceiptSchema,
  AgentLaneReleaseReceiptSchema,
  ArtifactRefSchema,
} from "../../src/app/domain/schemas.ts";
import type {
  AgentLaneAdmissionDecision,
  AgentLaneAdmissionRequest,
  AgentLaneReceipt,
  AgentLaneReleaseRequest,
  ArtifactRef,
} from "../../src/app/domain/schemas.ts";
import { workflowTraceContextForLane } from "../../src/app/domain/trace-context.ts";

const timestamp = "2026-06-08T21:00:00.000Z";
const artifactCommitSha = "runtimecommit000000000000000000000000000000000000";

const agentAuthLease = {
  expiresAt: "2026-06-08T21:15:00.000Z",
  issuedAt: timestamp,
  leaseId: "lease:pi-agent-auth:run-admission-test:test",
  redacted: true,
  runId: "run-admission-test",
  scope: "pi-agent-auth-json",
  secretRef: "secretref:pi-agent-auth-json",
  workItemId: "work-item:admission-test",
} as const;

const artifactRefFor = (input: {
  readonly path: string;
  readonly runId: string;
}): ArtifactRef =>
  ArtifactRefSchema.parse(
    `artifact://admission-test/runs/${input.runId}/${input.path}`
  );

const buildLaneRequest = (): AgentLaneRuntimeRequest => ({
  artifactRef: artifactRefFor,
  artifactRemote: "https://artifacts.example.invalid/repo.git",
  artifactTokenSecret: "artifact-token",
  authLease: agentAuthLease,
  branchName: "planner",
  kind: "planner",
  laneId: "lane:planner:admission-test",
  leasedPiAuthJsonBase64: "pi-auth-json",
  model: "integration-test-pi-model",
  outputMediaType: "application/json",
  outputPath: "run/planner-blueprint.json",
  prompt: "Plan a bounded dynamic workflow.",
  promptPath: "lanes/planner/prompt.md",
  provider: "openai-codex",
  receiptPath: "receipts/planner-lane.json",
  runId: "run-admission-test",
  timeoutMs: 30_000,
  traceContext: workflowTraceContextForLane({
    laneId: "lane:planner:admission-test",
    runId: "run-admission-test",
  }),
  transcriptPath: "lanes/planner/transcript.md",
  workItemId: "work-item:admission-test",
});

const buildReceipt = (
  request: AgentLaneRuntimeRequest,
  status: "completed" | "failed" = "completed"
): AgentLaneReceipt => {
  const transcript = "Pi lane transcript";
  const outputRef = request.artifactRef({
    path: request.outputPath,
    runId: request.runId,
  });

  return AgentLaneReceiptSchema.parse({
    artifactCommitSha,
    authLease: request.authLease,
    completedAt: "2026-06-08T21:00:01.000Z",
    kind: request.kind,
    laneId: request.laneId,
    outputPins: [
      {
        artifactRef: outputRef,
        hash: sha256Hex("{}"),
        mediaType: request.outputMediaType,
      },
    ],
    outputRefs: [outputRef],
    prompt: {
      artifactRef: request.artifactRef({
        path: request.promptPath,
        runId: request.runId,
      }),
      hash: sha256Hex(request.prompt),
      mediaType: "text/markdown",
    },
    realAgent: true,
    receiptRef: request.artifactRef({
      path: request.receiptPath,
      runId: request.runId,
    }),
    redacted: true,
    runtime: "pi-agent-cli",
    sandboxRef: "cloudflare-sandbox:admission-test",
    startedAt: timestamp,
    status,
    traceContext: request.traceContext,
    transcript: {
      artifactRef: request.artifactRef({
        path: request.transcriptPath,
        runId: request.runId,
      }),
      hash: sha256Hex(transcript),
      mediaType: "text/markdown",
    },
  });
};

const createController = (
  decisions: AgentLaneAdmissionDecision[] = []
): AgentLaneAdmissionControllerContract & {
  readonly admissions: AgentLaneAdmissionRequest[];
  readonly releases: AgentLaneReleaseRequest[];
} => {
  const admissions: AgentLaneAdmissionRequest[] = [];
  const releases: AgentLaneReleaseRequest[] = [];

  return {
    admissions,
    admitLane(input) {
      admissions.push(input);
      const decision =
        decisions.shift() ??
        AgentLaneAdmissionDecisionSchema.parse({
          activeLaneIds: [input.laneId],
          admissionId: `admission:${input.runId}:${input.laneId}`,
          admittedAt: timestamp,
          kind: input.kind,
          laneId: input.laneId,
          maxActiveLanes: input.maxActiveLanes,
          runId: input.runId,
          status: "admitted",
          workItemId: input.workItemId,
        });

      return Promise.resolve(decision);
    },
    releaseLane(input) {
      releases.push(input);

      return Promise.resolve(
        AgentLaneReleaseReceiptSchema.parse({
          ...input,
          activeLaneIds: [],
        })
      );
    },
    releases,
  };
};

const createRuntime = (input: {
  readonly onRun: (
    request: AgentLaneRuntimeRequest
  ) => AgentLaneReceipt | Promise<AgentLaneReceipt>;
  readonly requests: AgentLaneRuntimeRequest[];
}): AgentLaneRuntimePort => ({
  async runLane(request) {
    input.requests.push(request);

    return await input.onRun(request);
  },
  runtime: "pi-agent-cli",
});

describe("admitted agent lane runtime", () => {
  it("admits and releases a completed real Pi lane", async () => {
    const controller = createController();
    const runtimeRequests: AgentLaneRuntimeRequest[] = [];
    const innerRuntime = createRuntime({
      onRun: (request) => buildReceipt(request),
      requests: runtimeRequests,
    });
    const runtime = createAdmittedAgentLaneRuntime({
      admissionController: controller,
      maxActiveLanes: 2,
      now: () => timestamp,
      runtime: innerRuntime,
    });

    await runtime.runLane(buildLaneRequest());

    expect({
      admittedLaneId: controller.admissions.at(0)?.laneId,
      maxActiveLanes: controller.admissions.at(0)?.maxActiveLanes,
      releaseCommit: controller.releases.at(0)?.artifactCommitSha,
      releaseStatus: controller.releases.at(0)?.status,
      runtimeLaneId: runtimeRequests.at(0)?.laneId,
    }).toStrictEqual({
      admittedLaneId: "lane:planner:admission-test",
      maxActiveLanes: 2,
      releaseCommit: artifactCommitSha,
      releaseStatus: "completed",
      runtimeLaneId: "lane:planner:admission-test",
    });
  });

  it("releases a failed slot when the real Pi lane throws", async () => {
    const controller = createController();
    const runtimeRequests: AgentLaneRuntimeRequest[] = [];
    const innerRuntime = createRuntime({
      onRun: () => {
        throw new Error("Pi lane failed before committing output.");
      },
      requests: runtimeRequests,
    });
    const runtime = createAdmittedAgentLaneRuntime({
      admissionController: controller,
      maxActiveLanes: 1,
      now: () => timestamp,
      runtime: innerRuntime,
    });

    await expect(runtime.runLane(buildLaneRequest())).rejects.toThrow(
      "Pi lane failed before committing output."
    );
    expect({
      releaseCommit: controller.releases.at(0)?.artifactCommitSha,
      releaseStatus: controller.releases.at(0)?.status,
      runtimeCalls: runtimeRequests.length,
    }).toStrictEqual({
      releaseCommit: undefined,
      releaseStatus: "failed",
      runtimeCalls: 1,
    });
  });

  it("does not run the lane when admission is deferred", async () => {
    const controller = createController([
      AgentLaneAdmissionDecisionSchema.parse({
        activeLaneIds: ["lane:worker:existing"],
        kind: "planner",
        laneId: "lane:planner:admission-test",
        maxActiveLanes: 1,
        reason: "concurrency-cap-full",
        retryAfterSeconds: 2,
        runId: "run-admission-test",
        status: "deferred",
        workItemId: "work-item:admission-test",
      }),
    ]);
    const runtimeRequests: AgentLaneRuntimeRequest[] = [];
    const runtime = createAdmittedAgentLaneRuntime({
      admissionController: controller,
      maxActiveLanes: 1,
      now: () => timestamp,
      runtime: createRuntime({
        onRun: (request) => buildReceipt(request),
        requests: runtimeRequests,
      }),
    });

    await expect(runtime.runLane(buildLaneRequest())).rejects.toThrow(
      "concurrency-cap-full"
    );
    expect({
      releaseCalls: controller.releases.length,
      runtimeCalls: runtimeRequests.length,
    }).toStrictEqual({
      releaseCalls: 0,
      runtimeCalls: 0,
    });
  });

  it("does not rerun an already completed lane", async () => {
    const controller = createController([
      AgentLaneAdmissionDecisionSchema.parse({
        kind: "planner",
        laneId: "lane:planner:admission-test",
        runId: "run-admission-test",
        status: "already-completed",
        workItemId: "work-item:admission-test",
      }),
    ]);
    const runtimeRequests: AgentLaneRuntimeRequest[] = [];
    const runtime = createAdmittedAgentLaneRuntime({
      admissionController: controller,
      maxActiveLanes: 1,
      now: () => timestamp,
      runtime: createRuntime({
        onRun: (request) => buildReceipt(request),
        requests: runtimeRequests,
      }),
    });

    await expect(runtime.runLane(buildLaneRequest())).rejects.toThrow(
      "already completed"
    );
    expect({
      releaseCalls: controller.releases.length,
      runtimeCalls: runtimeRequests.length,
    }).toStrictEqual({
      releaseCalls: 0,
      runtimeCalls: 0,
    });
  });
});
