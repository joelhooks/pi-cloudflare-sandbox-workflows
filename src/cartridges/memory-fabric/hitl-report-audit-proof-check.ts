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

const genericReviewPattern = /\bneeds human review\b|\breview the receipts\b/iu;

const reportQualityFailuresFor = (
  report: ReturnType<typeof WorkflowHitlReportDocumentSchema.parse>
): string[] => {
  const ratings = report.findings.map((finding) => finding.rating);
  const uniqueRatings = new Set(ratings);
  const genericFindingTitles = report.findings.filter((finding) =>
    genericReviewPattern.test(`${finding.title} ${finding.recommendation}`)
  );
  const refinementProposalFindings = report.findings.filter(
    (finding) => finding.sourceKind === "refinement-proposal"
  );
  const failures: string[] = [];

  if (report.findingCount !== report.findings.length) {
    failures.push(
      `findingCount ${report.findingCount} does not match findings length ${report.findings.length}`
    );
  }

  if (report.findings.length > 7) {
    failures.push(`report contains ${report.findings.length} findings; max 7`);
  }

  if (genericFindingTitles.length > 0) {
    failures.push(
      `${genericFindingTitles.length} finding(s) use generic review wording instead of a concrete title/recommendation`
    );
  }

  if (report.findings.length > 1 && ratings.every((rating) => rating === 10)) {
    failures.push("all findings are rated 10/10");
  }

  if (report.findings.length >= 3 && uniqueRatings.size === 1) {
    failures.push("three or more findings share one undifferentiated rating");
  }

  if (
    report.refinementProposalCount > 0 &&
    refinementProposalFindings.length === 0
  ) {
    failures.push(
      "report has refinement proposals but no finding card sourced from them"
    );
  }

  return failures;
};

const reportAuditCheckSummaryFor = (input: {
  readonly qualityFailures: readonly string[];
  readonly missingRequirementIds: readonly string[];
  readonly overclaimedPostReportRequirementIds: readonly string[];
  readonly reportAuditStatus?: string;
  readonly reportRef: ArtifactRef;
  readonly summaryMatches: boolean;
}): string => {
  if (input.qualityFailures.length > 0) {
    return `Workflow HITL report ${input.reportRef} failed report-quality gate: ${input.qualityFailures.join("; ")}.`;
  }

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
    const qualityFailures = reportQualityFailuresFor(report);

    return {
      checkId: "report:definition-of-done-audit",
      evidenceRefs: [reportRef],
      passed:
        qualityFailures.length === 0 &&
        missingRequirementIds.length === 0 &&
        overclaimedPostReportRequirementIds.length === 0 &&
        summaryMatches,
      summary: reportAuditCheckSummaryFor({
        missingRequirementIds,
        overclaimedPostReportRequirementIds,
        qualityFailures,
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
