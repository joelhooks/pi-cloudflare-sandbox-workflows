import { describe, expect, it } from "vitest";

import type {
  WorkflowNodeAdapterPort,
  WorkflowNodeInvocationStep,
  WorkflowPostExecutionArtifactRecorderRegistration,
} from "../../src/app/application/ports.ts";
import type {
  AgentLaneReceipt,
  ArtifactPin,
  DynamicWorkflowMachineDocument,
  DynamicWorkflowPlanDocument,
  PinnedPackage,
} from "../../src/app/domain/schemas.ts";
import { combineCloudflareWorkflowCartridgeDependencies } from "../../src/app/infrastructure/cloudflare-workflow-cartridge-installer.ts";
import { createMemoryArtifactStore } from "../../src/app/infrastructure/memory-adapters.ts";
import {
  integrationTestActor,
  integrationTestPackageMetadata,
} from "./workflow-app-fixtures.ts";

const at = "2026-06-09T20:00:00.000Z";
const hash = "0".repeat(64);
const mediaType = "application/json";
const workflowPackage = integrationTestPackageMetadata.find(
  (packageRecord) =>
    packageRecord.packageId === "workflow/research-review-discord"
);

if (workflowPackage === undefined) {
  throw new Error("Expected integration workflow package fixture.");
}

const artifactPin = (path: string): ArtifactPin => ({
  artifactRef: `artifact://cartridge-installer-test/${path}`,
  hash,
  mediaType,
});

const plannerLane = {
  kind: "planner",
  laneId: "lane:planner",
  outputPins: [],
  outputRefs: [],
  prompt: artifactPin("planner/prompt.txt"),
  realAgent: false,
  receiptRef: "artifact://cartridge-installer-test/planner/receipt.json",
  redacted: true,
  runtime: "integration-test",
  startedAt: at,
  status: "completed",
  transcript: artifactPin("planner/transcript.jsonl"),
} satisfies AgentLaneReceipt;

const pinnedPackage = {
  artifactRef: workflowPackage.latestArtifactRef,
  fileHashes: {
    "package.json": hash,
  },
  manifestHash: hash,
  metadata: workflowPackage,
  pinnedAt: at,
  version: workflowPackage.latestVersion,
} satisfies PinnedPackage;

const invocationStep = {
  config: {},
  dependsOn: [],
  inputRefs: [],
  kind: "workflow.node.invoke",
  nodeType: "com.joelclaw.integration-fixture",
  outputPath: "nodes/integration-fixture-output.json",
  packageRefs: [workflowPackage.latestArtifactRef],
  stepId: "invoke-integration-node",
  summary: "Invoke an installed workflow-node cartridge.",
} satisfies WorkflowNodeInvocationStep;

const machine = {
  createdAt: at,
  machineId: "machine:cartridge-installer-test",
  planner: {
    kind: "stochastic",
    nonce: "nonce:cartridge-installer-test",
    source: "integration-test",
  },
  runId: "run-cartridge-installer-test",
  schemaVersion: "workflow.xstate-machine.v1",
  stepOrder: [invocationStep.stepId],
  workItemId: "work-item:cartridge-installer-test",
  xstate: {
    id: "cartridge-installer-test",
    initial: "invoke",
    states: {
      done: {
        meta: {},
        on: {},
        type: "final",
      },
      invoke: {
        meta: {
          stepId: invocationStep.stepId,
          stepKind: invocationStep.kind,
          summary: invocationStep.summary,
        },
        on: {
          STEP_DONE: {
            target: "done",
          },
        },
      },
    },
  },
} satisfies DynamicWorkflowMachineDocument;

const plan = {
  actor: integrationTestActor,
  createdAt: at,
  harness: {
    artifactRef: "artifact://cartridge-installer-test/workflows/harness.ts",
    entrypoint: "workflows/harness.ts",
    harnessId: "harness:cartridge-installer-test",
    hash,
    language: "typescript",
  },
  machine: {
    artifactRef:
      "artifact://cartridge-installer-test/workflows/machine.config.json",
    hash,
    machineId: machine.machineId,
    sourceArtifactRef:
      "artifact://cartridge-installer-test/workflows/machine.ts",
    sourceHash: hash,
  },
  outputTarget: {
    kind: "artifact-only",
    path: "review/summary.json",
  },
  pinnedPackages: [pinnedPackage],
  planId: "plan:cartridge-installer-test",
  planner: machine.planner,
  plannerLane,
  proposal: {
    intent: "Exercise multiple installed workflow-node cartridge adapters.",
    requestedPackageIds: [workflowPackage.packageId],
    stochasticNotes: ["Composite adapter dispatch should be generic."],
  },
  runId: machine.runId,
  safety: {
    capabilityLeasesRequired: true,
    durableState: "artifacts-d1-do-r2-only",
    scratchOnly: true,
  },
  schemaVersion: "workflow.dynamic-plan.v1",
  sideEffects: [],
  steps: [invocationStep],
  verificationContract: {
    artifactRef:
      "artifact://cartridge-installer-test/run/verification-contract.json",
    contractId: "contract:cartridge-installer-test",
    hash,
    mediaType,
  },
  workItemId: machine.workItemId,
} satisfies DynamicWorkflowPlanDocument;

const executeInput = {
  actor: integrationTestActor,
  dependencyArtifactRefs: {},
  machine,
  plan,
  step: invocationStep,
} satisfies Parameters<WorkflowNodeAdapterPort["execute"]>[0];

const unavailableAdapter = (
  label: string,
  calls: string[]
): WorkflowNodeAdapterPort => ({
  execute(input) {
    calls.push(`${label}:${input.step.nodeType}`);

    return Promise.resolve({
      blocker: {
        code: "adapter_unavailable",
        message: `${label} does not handle ${input.step.nodeType}.`,
        redacted: true,
      },
      status: "blocked",
    });
  },
});

const executingAdapter = (
  label: string,
  calls: string[]
): WorkflowNodeAdapterPort => ({
  execute(input) {
    calls.push(`${label}:${input.step.nodeType}`);

    return Promise.resolve({
      outputRefs: [
        `artifact://cartridge-installer-test/${label}/${input.step.stepId}.json`,
      ],
      status: "executed",
    });
  },
});

const recorder = (
  label: string
): WorkflowPostExecutionArtifactRecorderRegistration => ({
  binding: {
    kind: "profile-id",
    packageId: `workflow/${label}`,
    profileId: `integration-test/${label}`,
  },
  recorder: {
    record() {
      return Promise.resolve({
        artifactRefs: [`artifact://cartridge-installer-test/${label}.json`],
        status: "recorded",
      });
    },
  },
});

describe("Cloudflare workflow cartridge installer", () => {
  it("composes multiple workflow-node cartridge adapters instead of forcing a single installed cartridge", async () => {
    const calls: string[] = [];
    const dependency = combineCloudflareWorkflowCartridgeDependencies([
      {
        createWorkflowNodeAdapter: () => unavailableAdapter("first", calls),
      },
      {
        createWorkflowNodeAdapter: () => executingAdapter("second", calls),
      },
    ]);
    if (dependency.createWorkflowNodeAdapter === undefined) {
      throw new Error("Expected composite workflow-node adapter factory.");
    }

    const adapter = dependency.createWorkflowNodeAdapter({
      artifacts: createMemoryArtifactStore("cartridge-installer-composite"),
    });
    const result = await adapter.execute(executeInput);

    expect({ calls, result }).toStrictEqual({
      calls: [
        "first:com.joelclaw.integration-fixture",
        "second:com.joelclaw.integration-fixture",
      ],
      result: {
        outputRefs: [
          "artifact://cartridge-installer-test/second/invoke-integration-node.json",
        ],
        status: "executed",
      },
    });
  });

  it("preserves non-availability blockers from the matching cartridge adapter", async () => {
    const calls: string[] = [];
    const dependency = combineCloudflareWorkflowCartridgeDependencies([
      {
        createWorkflowNodeAdapter: () => unavailableAdapter("first", calls),
      },
      {
        createWorkflowNodeAdapter: () => ({
          execute(input) {
            calls.push(`second:${input.step.nodeType}`);

            return Promise.resolve({
              blocker: {
                code: "stale_package",
                message: "Pinned package export hash is stale.",
                redacted: true,
              },
              status: "blocked",
            });
          },
        }),
      },
      {
        createWorkflowNodeAdapter: () => executingAdapter("third", calls),
      },
    ]);
    if (dependency.createWorkflowNodeAdapter === undefined) {
      throw new Error("Expected composite workflow-node adapter factory.");
    }

    const adapter = dependency.createWorkflowNodeAdapter({
      artifacts: createMemoryArtifactStore("cartridge-installer-blocker"),
    });
    const result = await adapter.execute(executeInput);

    expect({ calls, result }).toStrictEqual({
      calls: [
        "first:com.joelclaw.integration-fixture",
        "second:com.joelclaw.integration-fixture",
      ],
      result: {
        blocker: {
          code: "stale_package",
          message: "Pinned package export hash is stale.",
          redacted: true,
        },
        status: "blocked",
      },
    });
  });

  it("aggregates post-execution artifact recorder factories across installed cartridges", () => {
    const dependency = combineCloudflareWorkflowCartridgeDependencies([
      {
        createPostExecutionArtifactRecorders: () => [recorder("first")],
      },
      {
        createPostExecutionArtifactRecorders: () => [
          recorder("second"),
          recorder("third"),
        ],
      },
    ]);
    if (dependency.createPostExecutionArtifactRecorders === undefined) {
      throw new Error("Expected post-execution recorder factory.");
    }

    const recorders = dependency.createPostExecutionArtifactRecorders({
      artifacts: createMemoryArtifactStore("cartridge-installer-recorders"),
    });

    expect(recorders).toHaveLength(3);
  });
});
