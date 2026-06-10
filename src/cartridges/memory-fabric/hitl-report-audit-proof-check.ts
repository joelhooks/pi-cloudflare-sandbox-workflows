import type { ArtifactStoreContract } from "../../app/application/ports.ts";
import type {
  ArtifactRef,
  WorkflowExecutionProofDocument,
} from "../../app/domain/schemas.ts";
import type { MemoryGeneratedWorkflowAdditionalProofCheck } from "../../app/workflow-nodes/generated-workflow-proof.ts";
import { WorkflowHitlReportDocumentSchema } from "./schemas.ts";

const requiredReportAuditRequirementIds = [
  "workflow-cartridge-package",
  "worker-facing-relay-capability-lease",
  "live-cloudflare-execution",
  "generated-machine-and-harness",
  "t-shaped-memory-coverage",
  "findings-and-refinement-proposals",
  "hitl-refinement-loop",
  "workflow-owned-wzrrd-output",
  "public-private-redaction-boundary",
] as const;

const reportAuditPostReportRequirementIds = [
  "worker-facing-relay-capability-lease",
  "live-cloudflare-execution",
  "hitl-refinement-loop",
  "workflow-owned-wzrrd-output",
] as const;

const reportAuditSummaryMatchesItems = (
  audit: ReturnType<
    typeof WorkflowHitlReportDocumentSchema.parse
  >["definitionOfDoneAudit"]
): boolean =>
  audit.summary.blockedCount ===
    audit.items.filter((item) => item.status === "blocked").length &&
  audit.summary.capturedCount ===
    audit.items.filter((item) => item.status === "captured").length &&
  audit.summary.missingCount ===
    audit.items.filter((item) => item.status === "missing").length &&
  audit.summary.notProvenCount ===
    audit.items.filter((item) => item.status === "not-proven").length &&
  audit.summary.totalCount === audit.items.length;

const reportAuditRequirementStatusById = (
  audit: ReturnType<
    typeof WorkflowHitlReportDocumentSchema.parse
  >["definitionOfDoneAudit"]
): Map<string, string> =>
  new Map(
    audit.items.map((item) => [item.requirementId, item.status] as const)
  );

const reportAuditCheckSummaryFor = (input: {
  readonly missingRequirementIds: readonly string[];
  readonly overclaimedPostReportRequirementIds: readonly string[];
  readonly reportAuditStatus?: string;
  readonly reportRef: ArtifactRef;
  readonly summaryMatches: boolean;
}): string => {
  if (input.missingRequirementIds.length > 0) {
    return `Workflow HITL report ${input.reportRef} is missing definition-of-done audit requirement(s): ${input.missingRequirementIds.join(", ")}.`;
  }

  if (input.overclaimedPostReportRequirementIds.length > 0) {
    return `Workflow HITL report ${input.reportRef} overclaims post-report proof gate(s): ${input.overclaimedPostReportRequirementIds.join(", ")}.`;
  }

  if (!input.summaryMatches) {
    return `Workflow HITL report ${input.reportRef} definition-of-done audit summary does not match its items.`;
  }

  return `Workflow HITL report ${input.reportRef} carries ${input.reportAuditStatus ?? "unknown"} definition-of-done audit without overclaiming post-report gates.`;
};

export const buildWorkflowHitlReportAuditProofCheck = async (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly executionProof: WorkflowExecutionProofDocument;
}): Promise<MemoryGeneratedWorkflowAdditionalProofCheck> => {
  const reportRef = input.executionProof.workflowNodeOutputRefs.find(
    (artifactRef) => artifactRef.endsWith("/report/hitl-report.json")
  );
  if (reportRef === undefined) {
    return {
      checkId: "report:definition-of-done-audit",
      evidenceRefs: [],
      passed: false,
      summary:
        "Execution proof did not include the generated HITL report JSON artifact.",
    };
  }

  try {
    const report = WorkflowHitlReportDocumentSchema.parse(
      await input.artifacts.readJson({ artifactRef: reportRef })
    );
    const audit = report.definitionOfDoneAudit;
    const statusById = reportAuditRequirementStatusById(audit);
    const missingRequirementIds = requiredReportAuditRequirementIds.filter(
      (requirementId) => !statusById.has(requirementId)
    );
    const overclaimedPostReportRequirementIds =
      reportAuditPostReportRequirementIds.filter(
        (requirementId) => statusById.get(requirementId) !== "not-proven"
      );
    const summaryMatches = reportAuditSummaryMatchesItems(audit);

    return {
      checkId: "report:definition-of-done-audit",
      evidenceRefs: [reportRef],
      passed:
        missingRequirementIds.length === 0 &&
        overclaimedPostReportRequirementIds.length === 0 &&
        summaryMatches,
      summary: reportAuditCheckSummaryFor({
        missingRequirementIds,
        overclaimedPostReportRequirementIds,
        reportAuditStatus: audit.status,
        reportRef,
        summaryMatches,
      }),
    };
  } catch {
    return {
      checkId: "report:definition-of-done-audit",
      evidenceRefs: [reportRef],
      passed: false,
      summary:
        "Workflow HITL report JSON artifact could not be parsed as workflow.hitl-report.v1 with a definition-of-done audit.",
    };
  }
};
