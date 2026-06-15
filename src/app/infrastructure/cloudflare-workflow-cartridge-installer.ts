import type {
  AgentAnalysisReasoningLanePort,
  ArtifactStoreContract,
  WorkflowNodeAdapterPort,
  WorkflowNodeExecutionResult,
  WorkflowPostExecutionArtifactRecorderRegistration,
} from "../application/ports.ts";
import type { CapabilityBlocker } from "../domain/schemas.ts";

export interface CloudflareWorkflowCartridgeFactoryInput {
  /**
   * The run's analysis reasoning lane, when the front door wired one (real Pi
   * auth + sandbox/runtime). A cartridge node adapter that has an agentic path
   * (the propose-refinements "dream thinks" node) consumes it; absent, that
   * node falls back to the deterministic template path. Optional so a cartridge
   * that does not reason ignores it, and a run with no lane runs mechanical.
   */
  readonly analysisReasoningLane?: AgentAnalysisReasoningLanePort;
  readonly artifacts: ArtifactStoreContract;
}

export interface CloudflareWorkflowCartridgeDependencies {
  readonly createPostExecutionArtifactRecorders?: (
    input: CloudflareWorkflowCartridgeFactoryInput
  ) => readonly WorkflowPostExecutionArtifactRecorderRegistration[];
  readonly createWorkflowNodeAdapter?: (
    input: CloudflareWorkflowCartridgeFactoryInput
  ) => WorkflowNodeAdapterPort;
}

export interface CloudflareWorkflowCartridgeInstaller<Bindings> {
  readonly cartridgeId: string;
  resolve(input: {
    readonly bindings: Bindings;
  }): CloudflareWorkflowCartridgeDependencies;
}

type BlockedWorkflowNodeExecutionResult = Extract<
  WorkflowNodeExecutionResult,
  { readonly status: "blocked" }
>;

const blockedNodeResult = (
  code: CapabilityBlocker["code"],
  message: string
): BlockedWorkflowNodeExecutionResult => ({
  blocker: {
    code,
    message,
    redacted: true,
  },
  status: "blocked",
});

const workflowNodeBlocked = (
  message: string
): BlockedWorkflowNodeExecutionResult =>
  blockedNodeResult("adapter_unavailable", message);

const adapterUnavailable = (blocker: CapabilityBlocker): boolean =>
  blocker.code === "adapter_unavailable";

const createCompositeWorkflowNodeAdapter = (
  adapters: readonly WorkflowNodeAdapterPort[]
): WorkflowNodeAdapterPort => ({
  async execute(input) {
    const unavailableMessages: string[] = [];

    for (const adapter of adapters) {
      const result = await adapter.execute(input);
      if (result.status === "executed") {
        return result;
      }

      if (!adapterUnavailable(result.blocker)) {
        return result;
      }

      unavailableMessages.push(result.blocker.message);
    }

    return workflowNodeBlocked(
      `No installed workflow-node cartridge adapter handled nodeType ${input.step.nodeType}. Tried ${adapters.length} adapter(s): ${unavailableMessages.join(" | ")}`
    );
  },
});

export const combineCloudflareWorkflowCartridgeDependencies = (
  dependencies: readonly CloudflareWorkflowCartridgeDependencies[]
): CloudflareWorkflowCartridgeDependencies => {
  const workflowNodeAdapterFactories = dependencies.flatMap((dependency) =>
    dependency.createWorkflowNodeAdapter === undefined
      ? []
      : [dependency.createWorkflowNodeAdapter]
  );
  const postExecutionRecorderFactories = dependencies.flatMap((dependency) =>
    dependency.createPostExecutionArtifactRecorders === undefined
      ? []
      : [dependency.createPostExecutionArtifactRecorders]
  );

  return {
    ...(postExecutionRecorderFactories.length === 0
      ? {}
      : {
          createPostExecutionArtifactRecorders: (input) =>
            postExecutionRecorderFactories.flatMap((factory) => factory(input)),
        }),
    ...(workflowNodeAdapterFactories.length === 0
      ? {}
      : {
          createWorkflowNodeAdapter: (input) => {
            const adapters = workflowNodeAdapterFactories.map((factory) =>
              factory(input)
            );
            const [singleAdapter] = adapters;
            if (adapters.length === 1 && singleAdapter !== undefined) {
              return singleAdapter;
            }

            return createCompositeWorkflowNodeAdapter(adapters);
          },
        }),
  };
};

/**
 * Honest fail-closed workflow-node adapter for a cartridge that mounted and
 * planned its nodes, but whose live executor could not be wired because a required
 * relay binding is absent on the deployed Worker.
 *
 * Wound #41: the installer's unprovisioned branch used to `return {}` and contribute
 * NO adapter at all. `combineCloudflareWorkflowCartridgeDependencies` filters the
 * empty dependency out, so the cartridge's planned nodeTypes routed to whatever
 * adapter was left registered — a FOREIGN one — which mis-answered with a misleading
 * "does not support nodeType X" error naming the WRONG subsystem. An absent adapter
 * is strictly worse than a present-but-honestly-blocking one: it lets another
 * cartridge answer for nodes it does not own and points the operator at the wrong
 * fix. (This is the no-hollow-capability rule in adapter form — a verifier with no
 * tools reviews nothing; an executor with no adapter blocks nothing it owns.)
 *
 * This adapter CLAIMS the cartridge's own `ownedNodeTypes`. For those it returns a
 * TERMINAL `secret_denied` blocker naming the cartridge and the missing binding,
 * routed to the right owner and pointing at the real provisioning gap. It MUST be
 * terminal (not `adapter_unavailable`): `createCompositeWorkflowNodeAdapter` skips
 * `adapter_unavailable` to try the next adapter, so an `adapter_unavailable` here
 * would fall straight back through to the foreign adapter and reproduce the
 * misleading error. For nodeTypes it does NOT own it returns `adapter_unavailable`,
 * so the composite still falls through to whichever adapter does own them — exactly
 * as a fully-wired adapter's own non-matching fall-through would.
 */
export const createUnprovisionedCartridgeWorkflowNodeAdapter = (input: {
  readonly cartridgeId: string;
  readonly missingBindingName: string;
  readonly ownedNodeTypes: readonly string[];
}): WorkflowNodeAdapterPort => {
  const ownedNodeTypes = new Set(input.ownedNodeTypes);

  return {
    execute(executeInput) {
      const { nodeType } = executeInput.step;
      if (!ownedNodeTypes.has(nodeType)) {
        return Promise.resolve(
          workflowNodeBlocked(
            `${input.cartridgeId} is installed but unprovisioned and does not own nodeType ${nodeType}.`
          )
        );
      }

      return Promise.resolve(
        blockedNodeResult(
          "secret_denied",
          `${input.cartridgeId} mounted and planned nodeType ${nodeType}, but its live executor is unprovisioned: ${input.missingBindingName} is not set on the deployed Worker. Provision the relay binding to execute this cartridge live.`
        )
      );
    },
  };
};
