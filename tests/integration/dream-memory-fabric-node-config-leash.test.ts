import { describe, expect, it } from "vitest";

import type {
  WorkflowNodeAdapterPort,
  WorkflowNodeInvocationStep,
} from "../../src/app/application/ports.ts";
import { WorkflowNodeTypeSchema } from "../../src/app/domain/schemas.ts";
import type {
  DynamicWorkflowMachineDocument,
  DynamicWorkflowPlanDocument,
} from "../../src/app/domain/schemas.ts";
import { createMemoryArtifactStore } from "../../src/app/infrastructure/memory-adapters.ts";
import { createIntegrationTestMemoryFabricAdapter } from "../../src/cartridges/memory-fabric/integration-test-adapters.ts";
import { memoryFabricPackageMetadata } from "../../src/cartridges/memory-fabric/package-seed.ts";
import { MemoryCaptureReceiptDocumentSchema } from "../../src/cartridges/memory-fabric/schemas.ts";
import {
  createMemoryFabricWorkflowNodeAdapter,
  MEMORY_FABRIC_NODE_CONFIG_SCHEMAS,
} from "../../src/cartridges/memory-fabric/workflow-node-adapter.ts";
import { integrationTestActor } from "./workflow-app-fixtures.ts";

const at = "2026-06-10T08:00:00.000Z";
const hash = "1".repeat(64);
const mediaType = "application/json";
const runId = "run-dream-leash-test";
const workItemId = "work-item:dream-leash-test";

const machineArtifactRef =
  "artifact://dream-leash-test/workflows/machine.config.json";
const harnessArtifactRef = "artifact://dream-leash-test/workflows/harness.ts";

const captureArtifactStep = {
  config: {},
  dependsOn: [],
  inputRefs: [],
  kind: "workflow.node.invoke",
  nodeType: WorkflowNodeTypeSchema.parse("joelclaw.memory.capture-artifact"),
  outputPath: "dream/capture-artifact.json",
  packageRefs: ["artifact://packages/workflows/memory-fabric/refs/v1"],
  stepId: "capture-generated-machine-and-harness",
  summary: "Capture the generated machine and harness as durable memory.",
} satisfies WorkflowNodeInvocationStep;

const machine = {
  createdAt: at,
  machineId: "machine:dream-leash-test",
  planner: {
    kind: "stochastic",
    nonce: "nonce:dream-leash-test",
    source: "integration-test",
  },
  runId,
  schemaVersion: "workflow.xstate-machine.v1",
  stepOrder: [captureArtifactStep.stepId],
  workItemId,
  xstate: {
    id: "dream-leash-test",
    initial: "capture",
    states: {
      capture: {
        meta: {
          stepId: captureArtifactStep.stepId,
          stepKind: captureArtifactStep.kind,
          summary: captureArtifactStep.summary,
        },
        on: { STEP_DONE: { target: "done" } },
      },
      done: { meta: {}, on: {}, type: "final" },
    },
  },
} satisfies DynamicWorkflowMachineDocument;

const plan = {
  actor: integrationTestActor,
  createdAt: at,
  harness: {
    artifactRef: harnessArtifactRef,
    entrypoint: "workflows/harness.ts",
    harnessId: "harness:dream-leash-test",
    hash,
    language: "typescript",
  },
  machine: {
    artifactRef: machineArtifactRef,
    hash,
    machineId: machine.machineId,
    sourceArtifactRef: "artifact://dream-leash-test/workflows/machine.ts",
    sourceHash: hash,
  },
  outputTarget: { kind: "artifact-only", path: "review/summary.json" },
  pinnedPackages: [],
  planId: "plan:dream-leash-test",
  planner: machine.planner,
  plannerLane: {
    kind: "planner",
    laneId: "lane:planner",
    outputPins: [],
    outputRefs: [],
    prompt: {
      artifactRef: "artifact://dream-leash-test/planner/prompt.txt",
      hash,
      mediaType,
    },
    realAgent: false,
    receiptRef: "artifact://dream-leash-test/planner/receipt.json",
    redacted: true,
    runtime: "integration-test",
    startedAt: at,
    status: "completed",
    transcript: {
      artifactRef: "artifact://dream-leash-test/planner/transcript.jsonl",
      hash,
      mediaType,
    },
  },
  proposal: {
    intent: "Capture the generated machine and harness.",
    requestedPackageIds: ["workflow/memory-fabric"],
    stochasticNotes: ["Capture machine and harness as durable memory."],
  },
  runId,
  safety: {
    capabilityLeasesRequired: true,
    durableState: "artifacts-d1-do-r2-only",
    scratchOnly: true,
  },
  schemaVersion: "workflow.dynamic-plan.v1",
  sideEffects: [],
  steps: [captureArtifactStep],
  verificationContract: {
    artifactRef: "artifact://dream-leash-test/run/verification-contract.json",
    contractId: "contract:dream-leash-test",
    hash,
    mediaType,
  },
  workItemId,
} satisfies DynamicWorkflowPlanDocument;

const paletteNodeTypes = memoryFabricPackageMetadata.exports.flatMap(
  (exportRecord) =>
    exportRecord.kind === "workflow-node" && exportRecord.nodeType !== undefined
      ? [exportRecord.nodeType]
      : []
);

describe("memory-fabric node config leash registry", () => {
  it("maps every palette workflow-node nodeType to a config schema and nothing else", () => {
    const registryKeys = Object.keys(
      MEMORY_FABRIC_NODE_CONFIG_SCHEMAS
    ).toSorted();
    expect(registryKeys).toStrictEqual([...paletteNodeTypes].toSorted());
  });

  it("every registered schema parses an empty planner config to usable defaults", () => {
    for (const schema of Object.values(MEMORY_FABRIC_NODE_CONFIG_SCHEMAS)) {
      expect(schema.safeParse({}).success).toBeTruthy();
    }
  });
});

describe("memory-fabric query-bearing node config leashes", () => {
  it("defaults an omitted search query and drops out-of-enum source families", () => {
    const config = MEMORY_FABRIC_NODE_CONFIG_SCHEMAS[
      "joelclaw.memory.search"
    ].parse({
      // planner omitted `query` and hallucinated `github` as a source family
      sourceFamilies: ["github", "agent-transcripts"],
    });
    expect(config).toStrictEqual({
      maxHits: 10,
      query: "dream workflow",
      sourceFamilies: ["agent-transcripts"],
    });
  });

  it("drops invalid signalKinds and collapses an all-invalid source family list to omission", () => {
    const config = MEMORY_FABRIC_NODE_CONFIG_SCHEMAS[
      "joelclaw.memory.signals"
    ].parse({
      // planner emitted "workflow" instead of "workflow-pattern" and a bogus family
      signalKinds: ["workflow", "correction"],
      sourceFamilies: ["github", "slack"],
    });
    expect({
      maxSignals: config.maxSignals,
      query: config.query,
      signalKinds: config.signalKinds,
      // an all-invalid family list collapses to omission, treated as "all expected families"
      sourceFamilies: config.sourceFamilies,
    }).toStrictEqual({
      maxSignals: 10,
      query: "dream workflow",
      signalKinds: ["correction"],
      sourceFamilies: undefined,
    });
  });
});

describe("memory-fabric node-budget bounding leash", () => {
  // The run-14 blocker: a planner that orders an over-budget payload (152 real
  // hits) blows a single Worker invocation. The leash CLAMPS each per-node budget
  // to an invocation-sized ceiling instead of honoring or rejecting it, so one
  // node always fits one invocation. Truncates floats and floors below 1.
  it("clamps an over-budget search maxHits down to the search ceiling", () => {
    const config = MEMORY_FABRIC_NODE_CONFIG_SCHEMAS[
      "joelclaw.memory.search"
    ].parse({ maxHits: 999, query: "dream workflow" });
    expect(config.maxHits).toBe(25);
  });

  it("clamps an over-budget signals maxSignals down to the signals ceiling", () => {
    const config = MEMORY_FABRIC_NODE_CONFIG_SCHEMAS[
      "joelclaw.memory.signals"
    ].parse({ maxSignals: 999, query: "dream workflow" });
    expect(config.maxSignals).toBe(15);
  });

  it("clamps an over-budget hydration maxReceipts down to the hydration ceiling", () => {
    const config = MEMORY_FABRIC_NODE_CONFIG_SCHEMAS[
      "joelclaw.memory.hydrate"
    ].parse({ maxReceipts: 999 });
    expect(config.maxReceipts).toBe(12);
  });

  it("floors a sub-1 budget up to 1 and truncates a fractional budget", () => {
    const floored = MEMORY_FABRIC_NODE_CONFIG_SCHEMAS[
      "joelclaw.memory.search"
    ].parse({ maxHits: 0, query: "dream workflow" });
    expect(floored.maxHits).toBe(1);

    const truncated = MEMORY_FABRIC_NODE_CONFIG_SCHEMAS[
      "joelclaw.memory.search"
    ].parse({ maxHits: 7.9, query: "dream workflow" });
    expect(truncated.maxHits).toBe(7);
  });

  it("leaves an in-budget value untouched and still defaults an omitted budget", () => {
    const inBudget = MEMORY_FABRIC_NODE_CONFIG_SCHEMAS[
      "joelclaw.memory.search"
    ].parse({ maxHits: 5, query: "dream workflow" });
    expect(inBudget.maxHits).toBe(5);

    const omitted = MEMORY_FABRIC_NODE_CONFIG_SCHEMAS[
      "joelclaw.memory.hydrate"
    ].parse({});
    expect(omitted.maxReceipts).toBe(10);
  });
});

describe("memory-fabric capture-artifact node ref leash", () => {
  it("resolves the planner artifactKinds intent to the pinned generated machine ref and executes", async () => {
    const artifacts = createMemoryArtifactStore("dream-leash-capture-artifact");
    // Seed the pinned generated machine config artifact at the plan's machine ref.
    artifacts.setJson(machineArtifactRef, {
      machineId: machine.machineId,
      schemaVersion: "workflow.xstate-machine.v1",
    });

    const adapter = createMemoryFabricWorkflowNodeAdapter({
      artifacts,
      memoryCapture: createIntegrationTestMemoryFabricAdapter(),
    });
    const result = await adapter.execute({
      actor: integrationTestActor,
      dependencyArtifactRefs: {},
      machine,
      plan,
      step: {
        ...captureArtifactStep,
        // Plausible planner output: declares intent via artifactKinds/capturePurpose,
        // never names a concrete artifactRef or artifactStepId.
        config: {
          artifactKinds: [
            "workflow.xstate-machine.v1",
            "workflow.generated-harness.v1",
          ],
          capturePurpose: "Capture the generated machine and harness.",
        },
      } satisfies WorkflowNodeInvocationStep,
    } satisfies Parameters<WorkflowNodeAdapterPort["execute"]>[0]);

    if (result.status === "blocked") {
      throw new Error(result.blocker.message);
    }
    const receiptRef = result.outputRefs.at(0);
    if (receiptRef === undefined) {
      throw new Error("Expected a capture-artifact receipt output ref.");
    }

    const receipt = MemoryCaptureReceiptDocumentSchema.parse(
      await artifacts.readJson({ artifactRef: receiptRef })
    );
    expect({
      captureKind: receipt.captureKind,
      capturedRef: receipt.capturedRef.artifactRef,
      schemaVersion: receipt.schemaVersion,
    }).toStrictEqual({
      captureKind: "artifact",
      capturedRef: machineArtifactRef,
      schemaVersion: "memory.capture-receipt.v1",
    });
  });
});
