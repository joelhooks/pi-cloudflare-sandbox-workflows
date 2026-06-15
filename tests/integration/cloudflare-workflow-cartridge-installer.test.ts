import { describe, expect, it } from "vitest";

import type {
  WorkflowNodeAdapterPort,
  WorkflowNodeInvocationStep,
  WorkflowPostExecutionArtifactRecorderRegistration,
} from "../../src/app/application/ports.ts";
import { WorkflowNodeTypeSchema } from "../../src/app/domain/schemas.ts";
import type {
  AgentLaneReceipt,
  ArtifactPin,
  DynamicWorkflowMachineDocument,
  DynamicWorkflowPlanDocument,
  PinnedPackage,
} from "../../src/app/domain/schemas.ts";
import { combineCloudflareWorkflowCartridgeDependencies } from "../../src/app/infrastructure/cloudflare-workflow-cartridge-installer.ts";
import { createMemoryArtifactStore } from "../../src/app/infrastructure/memory-adapters.ts";
import { aiHeroSupportSweepPackageMetadata } from "../../src/cartridges/aihero-support-sweep/package-seed.ts";
import {
  InstalledWorkflowCartridgeEnvBindingSchema,
  workflowCartridgeDependenciesFromWorkerBindings,
} from "../../src/cartridges/cloudflare-workflow-cartridges.ts";
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
  nodeType: WorkflowNodeTypeSchema.parse("com.joelclaw.integration-fixture"),
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

  // ---------------------------------------------------------------------------
  // Wound #41: an unprovisioned cartridge installer used to `return {}` and
  // contribute NO adapter, so its planned nodes routed to a FOREIGN adapter that
  // mis-answered with a misleading error naming the wrong subsystem. The live
  // failure was support-sweep run run-live-20260615T021858572Z-ec8eb69c going
  // terminal at stepId `inventory-aihero-sources` with
  // `adapter_unavailable: "Memory fabric workflow node adapter does not support
  // nodeType aihero.support-sweep.source-inventory."` — memory-fabric answering
  // for a node it does not own, because the aihero adapter had vanished. These
  // tests drive the REAL installer assembly
  // (`workflowCartridgeDependenciesFromWorkerBindings` → the real
  // `aiHeroSupportSweepCloudflareCartridgeInstaller` /
  // `memoryFabricCloudflareCartridgeInstaller`), NOT synthetic adapters: the
  // bindings are parsed through the production
  // `InstalledWorkflowCartridgeEnvBindingSchema`, so the test exercises the same
  // resolve()/combine() path the deployed Worker runs.

  const aiHeroSourceInventoryStep = {
    config: {},
    dependsOn: [],
    inputRefs: [],
    kind: "workflow.node.invoke",
    nodeType: WorkflowNodeTypeSchema.parse(
      "aihero.support-sweep.source-inventory"
    ),
    outputPath: "nodes/aihero-source-inventory-output.json",
    packageRefs: [aiHeroSupportSweepPackageMetadata.latestArtifactRef],
    stepId: "inventory-aihero-sources",
    summary: "Inventory aihero support sources.",
  } satisfies WorkflowNodeInvocationStep;

  // The aihero package IS pinned with its source-inventory workflow-node export,
  // reproducing the live condition exactly: the planner mounted aihero and planned
  // its nodes. This is what makes memory-fabric's artifact-backed wrapper PASS
  // export verification and delegate to the memory adapter (which then emits the
  // skippable `adapter_unavailable`), rather than short-circuiting on a
  // `stale_package` blocker that would never reach the aihero adapter.
  const aiHeroPinnedPackage = {
    artifactRef: aiHeroSupportSweepPackageMetadata.latestArtifactRef,
    fileHashes: {
      "package.json": hash,
    },
    manifestHash: hash,
    metadata: aiHeroSupportSweepPackageMetadata,
    pinnedAt: at,
    version: aiHeroSupportSweepPackageMetadata.latestVersion,
  } satisfies PinnedPackage;

  const aiHeroExecuteInput = {
    actor: integrationTestActor,
    dependencyArtifactRefs: {},
    machine,
    plan: {
      ...plan,
      pinnedPackages: [aiHeroPinnedPackage],
      steps: [aiHeroSourceInventoryStep],
    },
    step: aiHeroSourceInventoryStep,
  } satisfies Parameters<WorkflowNodeAdapterPort["execute"]>[0];

  const executeInputForNodeType = (
    nodeType: string
  ): Parameters<WorkflowNodeAdapterPort["execute"]>[0] => ({
    ...executeInput,
    step: {
      ...invocationStep,
      nodeType: WorkflowNodeTypeSchema.parse(nodeType),
    },
  });

  it("routes an aihero node to the aihero provisioning blocker — not memory-fabric — when memory is provisioned but aihero is not (the live wound)", async () => {
    const bindings = InstalledWorkflowCartridgeEnvBindingSchema.parse({
      MEMORY_RELAY_BASE_URL: "https://memory-relay.test.invalid",
      MEMORY_RELAY_TOKEN: "memory-relay-test-token",
      // AIHERO_SUPPORT_SWEEP_RELAY_BASE_URL intentionally omitted → undefined.
    });

    const dependency =
      workflowCartridgeDependenciesFromWorkerBindings(bindings);
    if (dependency.createWorkflowNodeAdapter === undefined) {
      throw new Error("Expected an assembled workflow-node adapter factory.");
    }

    const adapter = dependency.createWorkflowNodeAdapter({
      artifacts: createMemoryArtifactStore("cartridge-installer-wound-41-live"),
    });
    const result = await adapter.execute(aiHeroExecuteInput);

    // PRE-FIX (red): aihero `resolve()` returned `{}`, so only memory-fabric's
    // adapter existed; it answered with
    // `adapter_unavailable: "Memory fabric workflow node adapter does not support
    // nodeType aihero.support-sweep.source-inventory."` — the exact live failure.
    // POST-FIX (green): the aihero installer contributes an honest fail-closed
    // adapter; the composite skips memory-fabric's `adapter_unavailable` and
    // reaches the aihero adapter, which OWNS the node and blocks with a terminal
    // `secret_denied` naming the missing binding.
    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") {
      throw new Error("Expected the aihero node to block.");
    }

    expect(result.blocker.code).toBe("secret_denied");
    expect(result.blocker.message).toContain("workflow/aihero-support-sweep");
    expect(result.blocker.message).toContain(
      "AIHERO_SUPPORT_SWEEP_RELAY_BASE_URL"
    );
    expect(result.blocker.message).not.toContain("Memory fabric");
  });

  it("each unprovisioned cartridge claims its OWN palette and disowns the other's — neither vanishes (the class)", async () => {
    // Both relays absent: every installer must contribute a fail-closed adapter.
    // This proves the fix is a CLASS fix, not an aihero instance fix — an aihero
    // node must reach the aihero blocker and a memory node must reach the memory
    // blocker, even though both adapters are bare fail-closed and the composite
    // must route each node to its true owner by ownership, not registration order.
    const bindings = InstalledWorkflowCartridgeEnvBindingSchema.parse({});

    const dependency =
      workflowCartridgeDependenciesFromWorkerBindings(bindings);
    if (dependency.createWorkflowNodeAdapter === undefined) {
      throw new Error("Expected an assembled workflow-node adapter factory.");
    }

    const adapter = dependency.createWorkflowNodeAdapter({
      artifacts: createMemoryArtifactStore(
        "cartridge-installer-wound-41-class"
      ),
    });

    const aiHeroResult = await adapter.execute(
      executeInputForNodeType("aihero.support-sweep.source-inventory")
    );
    const memoryResult = await adapter.execute(
      executeInputForNodeType("joelclaw.memory.search")
    );

    if (
      aiHeroResult.status !== "blocked" ||
      memoryResult.status !== "blocked"
    ) {
      throw new Error("Expected both unprovisioned nodes to block.");
    }

    expect({
      code: aiHeroResult.blocker.code,
      disownsForeign: !aiHeroResult.blocker.message.includes("memory-fabric"),
      namesOwnBinding: aiHeroResult.blocker.message.includes(
        "AIHERO_SUPPORT_SWEEP_RELAY_BASE_URL"
      ),
    }).toStrictEqual({
      code: "secret_denied",
      disownsForeign: true,
      namesOwnBinding: true,
    });

    expect({
      code: memoryResult.blocker.code,
      disownsForeign: !memoryResult.blocker.message.includes("aihero"),
      namesOwnBinding: memoryResult.blocker.message.includes(
        "MEMORY_RELAY_BASE_URL"
      ),
    }).toStrictEqual({
      code: "secret_denied",
      disownsForeign: true,
      namesOwnBinding: true,
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
