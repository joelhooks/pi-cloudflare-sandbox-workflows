import { describe, expect, it } from "vitest";

import type { WorkflowNodeInvocationStep } from "../../src/app/application/ports.ts";
import { WorkflowNodeTypeSchema } from "../../src/app/domain/schemas.ts";
import { createMemoryArtifactStore } from "../../src/app/infrastructure/memory-adapters.ts";
import { createIntegrationTestMemoryFabricAdapter } from "../../src/cartridges/memory-fabric/integration-test-adapters.ts";
import {
  createMemoryFabricWorkflowNodeAdapter,
  validateMemoryFabricNodeConfig,
} from "../../src/cartridges/memory-fabric/workflow-node-adapter.ts";

const nodeStep = (input: {
  readonly config: Record<string, unknown>;
  readonly nodeType: string;
  readonly stepId: string;
}): WorkflowNodeInvocationStep => ({
  config: input.config,
  dependsOn: [],
  inputRefs: [],
  kind: "workflow.node.invoke",
  nodeType: WorkflowNodeTypeSchema.parse(input.nodeType),
  outputPath: `dream/${input.stepId}.json`,
  packageRefs: ["artifact://packages/workflows/memory-fabric/refs/v1"],
  stepId: input.stepId,
  summary: "Memory-fabric node step under validation.",
});

describe("memory-fabric fail-fast plan node config validation", () => {
  it("blocks an unrepairable config with a precise plan_node_config_invalid blocker naming the step and field", () => {
    // A wrong-TYPE maxHits (a string, not a number) is genuinely unrepairable:
    // the budget clamp passes non-numbers through untouched, so the inner number
    // schema rejects it and the node blocks. (An over-budget number is now
    // clamped, not blocked — see the next test.)
    const step = nodeStep({
      config: { maxHits: "lots", query: "dream workflow" },
      nodeType: "joelclaw.memory.search",
      stepId: "search-dream-memory",
    });

    const blocker = validateMemoryFabricNodeConfig(step);

    expect({ code: blocker?.code, redacted: blocker?.redacted }).toStrictEqual({
      code: "plan_node_config_invalid",
      redacted: true,
    });
    // The clause names step + nodeType + field, and describes the schema
    // constraint — never the offending value (no "lots").
    expect(blocker?.message).toMatch(
      /search-dream-memory.*joelclaw\.memory\.search.*config\.maxHits/u
    );
    expect(blocker?.message).not.toContain("lots");
  });

  it("clamps an over-budget numeric maxHits to the node budget ceiling instead of blocking", () => {
    // Node-budget bounding (the run-14 blocker): a planner that orders 999 hits
    // is no longer unrepairable — the leash CLAMPS it to the search ceiling so the
    // node fits one Worker invocation, rather than blocking the whole run. The
    // clamped value that reaches the relay (999 -> 25) is asserted end-to-end in
    // the workflow-app execution test; here the contract is simply: repairable.
    const step = nodeStep({
      config: { maxHits: 999, query: "dream workflow" },
      nodeType: "joelclaw.memory.search",
      stepId: "search-dream-memory",
    });

    expect(validateMemoryFabricNodeConfig(step)).toBeNull();
  });

  it("passes a leashable config (out-of-enum signalKinds, omitted query) because the leash repairs it", () => {
    // The planner's classic miss: "workflow" instead of "workflow-pattern" and
    // no query. The leash drops the invalid kind and defaults the query, so
    // validation must NOT block.
    const step = nodeStep({
      config: { signalKinds: ["workflow", "workflow-pattern"] },
      nodeType: "joelclaw.memory.signals",
      stepId: "mine-memory-signals",
    });

    expect(validateMemoryFabricNodeConfig(step)).toBeNull();
  });

  it("passes a fully valid config", () => {
    const step = nodeStep({
      config: {
        maxHits: 5,
        query: "dream workflow",
        sourceFamilies: ["agent-transcripts"],
      },
      nodeType: "joelclaw.memory.search",
      stepId: "search-dream-memory",
    });

    expect(validateMemoryFabricNodeConfig(step)).toBeNull();
  });

  it("returns null for a nodeType the registry does not own", () => {
    const step = nodeStep({
      config: { whatever: true },
      nodeType: "com.example.not-memory-fabric",
      stepId: "alien-node",
    });

    expect(validateMemoryFabricNodeConfig(step)).toBeNull();
  });

  it("exposes the same validation through the adapter port's validatePlanNodeConfig", () => {
    const adapter = createMemoryFabricWorkflowNodeAdapter({
      artifacts: createMemoryArtifactStore("memory-fabric-validate-port"),
      memoryCapture: createIntegrationTestMemoryFabricAdapter(),
    });

    const badStep = nodeStep({
      config: { maxProposals: 99 },
      nodeType: "joelclaw.memory.refinement-proposals",
      stepId: "propose-dream-refinements",
    });
    const goodStep = nodeStep({
      config: { maxProposals: 7 },
      nodeType: "joelclaw.memory.refinement-proposals",
      stepId: "propose-dream-refinements",
    });

    const badBlocker = adapter.validatePlanNodeConfig?.({ step: badStep });
    expect(badBlocker?.code).toBe("plan_node_config_invalid");
    expect(badBlocker?.message).toContain("config.maxProposals");
    expect(adapter.validatePlanNodeConfig?.({ step: goodStep })).toBeNull();
  });
});
