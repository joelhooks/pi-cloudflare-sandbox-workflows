import type {
  ArtifactStoreContract,
  WorkflowNodeAdapterPort,
  WorkflowNodeExecutionResult,
  WorkflowNodeInvocationStep,
} from "../application/ports.ts";
import { WorkflowCartridgeInvocationProofDocumentSchema } from "../domain/schemas.ts";
import type {
  ArtifactRef,
  CapabilityBlocker,
  DynamicWorkflowPlanDocument,
  PackageExport,
  PinnedPackage,
} from "../domain/schemas.ts";

export interface ArtifactBackedWorkflowCartridgeAdapterConfig {
  readonly artifacts: ArtifactStoreContract;
  readonly delegate: WorkflowNodeAdapterPort;
  readonly now?: () => string;
}

interface VerifiedWorkflowNodeExport {
  readonly contractRef: string;
  readonly exportId: string;
  readonly manifestHash: string;
  readonly packageId: string;
  readonly packageRef: ArtifactRef;
  readonly version: string;
}

type BlockedWorkflowNodeExecutionResult = Extract<
  WorkflowNodeExecutionResult,
  { readonly status: "blocked" }
>;

const blocked = (
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

const safePathSegment = (value: string): string =>
  value
    .toLowerCase()
    .replaceAll(/[^a-z0-9_.-]+/gu, "-")
    .replaceAll(/^-|-$/gu, "")
    .slice(0, 96);

const matchingWorkflowNodeExport = (
  step: WorkflowNodeInvocationStep,
  pinnedPackage: PinnedPackage
): PackageExport | null =>
  pinnedPackage.metadata.exports.find(
    (exportRecord) =>
      exportRecord.kind === "workflow-node" &&
      exportRecord.nodeType === step.nodeType
  ) ?? null;

const verifyWorkflowNodeExport = (input: {
  readonly plan: DynamicWorkflowPlanDocument;
  readonly step: WorkflowNodeInvocationStep;
}): BlockedWorkflowNodeExecutionResult | VerifiedWorkflowNodeExport => {
  if (input.step.packageRefs.length === 0) {
    return blocked(
      "stale_package",
      "Workflow node invocation requires a packageRef to an artifact-backed workflow cartridge."
    );
  }

  const pinnedPackageIds: string[] = [];
  for (const packageRef of input.step.packageRefs) {
    const pinnedPackage = input.plan.pinnedPackages.find(
      (candidate) => candidate.artifactRef === packageRef
    );
    if (pinnedPackage === undefined) {
      continue;
    }

    pinnedPackageIds.push(pinnedPackage.metadata.packageId);
    const exportRecord = matchingWorkflowNodeExport(input.step, pinnedPackage);
    if (exportRecord === null) {
      continue;
    }

    return {
      contractRef: exportRecord.contractRef,
      exportId: exportRecord.exportId,
      manifestHash: pinnedPackage.manifestHash,
      packageId: pinnedPackage.metadata.packageId,
      packageRef: pinnedPackage.artifactRef,
      version: pinnedPackage.version,
    };
  }

  if (pinnedPackageIds.length > 0) {
    return blocked(
      "stale_package",
      `Pinned packages ${pinnedPackageIds.join(", ")} do not export workflow node ${input.step.nodeType}.`
    );
  }

  return blocked(
    "stale_package",
    `Workflow node invocation references unpinned package artifacts: ${input.step.packageRefs.join(", ")}.`
  );
};

export const createArtifactBackedWorkflowCartridgeAdapter = (
  config: ArtifactBackedWorkflowCartridgeAdapterConfig
): WorkflowNodeAdapterPort => ({
  async execute(input) {
    const verifiedExport = verifyWorkflowNodeExport({
      plan: input.plan,
      step: input.step,
    });
    if ("status" in verifiedExport) {
      return verifiedExport;
    }

    const result = await config.delegate.execute(input);
    if (result.status === "blocked") {
      return result;
    }

    const proofDocument = WorkflowCartridgeInvocationProofDocumentSchema.parse({
      contractRef: verifiedExport.contractRef,
      exportId: verifiedExport.exportId,
      manifestHash: verifiedExport.manifestHash,
      nodeType: input.step.nodeType,
      packageId: verifiedExport.packageId,
      packageRef: verifiedExport.packageRef,
      redacted: true,
      runId: input.plan.runId,
      schemaVersion: "workflow.cartridge-invocation-proof.v1",
      status: "verified",
      stepId: input.step.stepId,
      verification: {
        exportMatched: true,
        nodeTypeMatched: true,
        packagePinned: true,
        sideEffectsRequireLeases: true,
      },
      verifiedAt: config.now?.() ?? new Date().toISOString(),
      version: verifiedExport.version,
      workItemId: input.plan.workItemId,
    });
    const proofWrite = await config.artifacts.writeJson({
      path: `run/workflow-node-cartridges/${safePathSegment(
        input.step.stepId
      )}.json`,
      redacted: true,
      runId: input.plan.runId,
      value: proofDocument,
    });

    return {
      outputRefs: [...result.outputRefs, proofWrite.artifactRef],
      status: "executed",
    };
  },
  validatePlanNodeConfig(input) {
    // Fail-fast plan-config validation is the delegate cartridge's contract; the
    // artifact-backed wrapper only adds cartridge-export proof at execution time
    // and has no config schema of its own, so it forwards verbatim (and returns
    // null when the delegate does not implement the optional validator).
    return (
      config.delegate.validatePlanNodeConfig?.({ step: input.step }) ?? null
    );
  },
});
