import type {
  ArtifactStoreContract,
  WorkflowNodeAdapterPort,
  WorkflowNodeExecutionResult,
  WorkflowPostExecutionArtifactRecorderPort,
} from "../application/ports.ts";
import type { CapabilityBlocker } from "../domain/schemas.ts";

export interface CloudflareWorkflowCartridgeFactoryInput {
  readonly artifacts: ArtifactStoreContract;
}

export interface CloudflareWorkflowCartridgeDependencies {
  readonly createPostExecutionArtifactRecorders?: (
    input: CloudflareWorkflowCartridgeFactoryInput
  ) => readonly WorkflowPostExecutionArtifactRecorderPort[];
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

const workflowNodeBlocked = (
  message: string
): BlockedWorkflowNodeExecutionResult => ({
  blocker: {
    code: "adapter_unavailable",
    message,
    redacted: true,
  },
  status: "blocked",
});

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
