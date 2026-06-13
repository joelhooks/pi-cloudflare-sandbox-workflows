import type { ArtifactStoreContract } from "../../app/application/ports.ts";
import type {
  ArtifactRef,
  WorkflowExecutionProofDocument,
} from "../../app/domain/schemas.ts";
import type { MemoryGeneratedWorkflowAdditionalProofCheck } from "../../app/workflow-nodes/generated-workflow-proof.ts";
import {
  AiHeroSupportSweepDraftSideEffectDocumentSchema,
  AiHeroSupportSweepRecommendationDocumentSchema,
} from "./schemas.ts";

const outputRefEnding = (
  executionProof: WorkflowExecutionProofDocument,
  ending: string
): ArtifactRef | undefined =>
  executionProof.workflowNodeOutputRefs.find((artifactRef) =>
    artifactRef.endsWith(ending)
  );

export const buildAiHeroSupportSweepAuditProofCheck = async (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly executionProof: WorkflowExecutionProofDocument;
}): Promise<MemoryGeneratedWorkflowAdditionalProofCheck> => {
  const recommendationsRef = outputRefEnding(
    input.executionProof,
    "/aihero/recommendations.json"
  );
  const draftSideEffectsRef = outputRefEnding(
    input.executionProof,
    "/aihero/draft-side-effects.json"
  );
  const evidenceRefs = [
    ...(recommendationsRef === undefined ? [] : [recommendationsRef]),
    ...(draftSideEffectsRef === undefined ? [] : [draftSideEffectsRef]),
  ];
  if (recommendationsRef === undefined || draftSideEffectsRef === undefined) {
    return {
      checkId: "aihero-support-sweep:hitl-draft-boundary",
      evidenceRefs,
      passed: false,
      summary:
        "Execution proof did not include both AIHero recommendations and draft-side-effects artifacts.",
    };
  }

  try {
    const recommendations =
      AiHeroSupportSweepRecommendationDocumentSchema.parse(
        await input.artifacts.readJson({ artifactRef: recommendationsRef })
      );
    const drafts = AiHeroSupportSweepDraftSideEffectDocumentSchema.parse(
      await input.artifacts.readJson({ artifactRef: draftSideEffectsRef })
    );
    const allDraftOnly =
      !drafts.submitted &&
      drafts.privateReviewSurface.noindex &&
      drafts.draftActions.every(
        (action) =>
          !action.submitted &&
          action.leaseGate.leaseRequired &&
          !action.leaseGate.leaseGranted &&
          action.leaseGate.reviewRequired
      );
    const recommendationsHaveReceipts = recommendations.recommendations.every(
      (recommendation) => recommendation.receiptTrail.length > 0
    );

    return {
      checkId: "aihero-support-sweep:hitl-draft-boundary",
      evidenceRefs,
      passed: allDraftOnly && recommendationsHaveReceipts,
      summary:
        allDraftOnly && recommendationsHaveReceipts
          ? `AIHero support sweep emitted ${recommendations.recommendationCount} receipt-backed recommendation(s) and ${drafts.draftActions.length} lease-gated draft action(s), all submitted:false.`
          : "AIHero support sweep overclaimed HITL/draft-only proof; recommendations need receipts and every draft action must be unsubmitted behind an ungranted lease gate.",
    };
  } catch {
    return {
      checkId: "aihero-support-sweep:hitl-draft-boundary",
      evidenceRefs,
      passed: false,
      summary:
        "AIHero support sweep recommendation or draft-side-effects artifact could not be parsed for audit proof.",
    };
  }
};
