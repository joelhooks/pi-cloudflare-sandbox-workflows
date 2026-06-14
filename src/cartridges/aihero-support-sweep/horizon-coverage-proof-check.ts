import type {
  ArtifactRef,
  DynamicWorkflowPlanDocument,
  PlanArtifact,
} from "../../app/domain/schemas.ts";
import { MemoryCoverageHorizonSchema } from "../../app/domain/source-profile.ts";
import type { MemoryCoverageHorizon } from "../../app/domain/source-profile.ts";
import type { MemoryGeneratedWorkflowAdditionalProofCheck } from "../../app/workflow-nodes/generated-workflow-proof.ts";
import { aiHeroSupportSweepSourceProfile } from "./source-profile.ts";
import { AiHeroSignalSearchNodeConfigSchema } from "./workflow-node-adapter.ts";

const SIGNAL_SEARCH_NODE_TYPE = "aihero.support-sweep.signal-search";

type DynamicWorkflowStep = DynamicWorkflowPlanDocument["steps"][number];

const horizonOrder = (horizon: MemoryCoverageHorizon): number =>
  MemoryCoverageHorizonSchema.options.indexOf(horizon);

const sortHorizons = (
  horizons: Iterable<MemoryCoverageHorizon>
): MemoryCoverageHorizon[] =>
  [...new Set(horizons)].toSorted(
    (left, right) => horizonOrder(left) - horizonOrder(right)
  );

const isSignalSearchStep = (step: DynamicWorkflowStep): boolean =>
  step.kind === "workflow.node.invoke" &&
  step.nodeType === SIGNAL_SEARCH_NODE_TYPE;

/**
 * Effective horizons are read THROUGH the same schema the executor parses with
 * (`AiHeroSignalSearchNodeConfigSchema`), so the `.default([...all five...])`
 * is applied exactly as it is at run time. A plan that OMITS `horizons` (or
 * supplies only garbage tokens that filter out) genuinely searches all five —
 * so the check must read all five and PASS, not demand a config key the planner
 * never needs to emit. A plan that NARROWS to a strict subset (e.g. `["24h"]`)
 * genuinely drops horizons — so the check reads the subset and FAILs.
 */
const effectiveHorizonsForStep = (
  step: DynamicWorkflowStep
): MemoryCoverageHorizon[] => {
  if (!isSignalSearchStep(step) || step.kind !== "workflow.node.invoke") {
    return [];
  }

  const parsed = AiHeroSignalSearchNodeConfigSchema.safeParse(step.config);

  return parsed.success ? parsed.data.horizons : [];
};

const summarize = (input: {
  readonly covered: readonly MemoryCoverageHorizon[];
  readonly missing: readonly MemoryCoverageHorizon[];
  readonly required: readonly MemoryCoverageHorizon[];
  readonly signalSearchStepCount: number;
}): string => {
  if (input.signalSearchStepCount === 0) {
    return `Generated support-sweep plan declares no ${SIGNAL_SEARCH_NODE_TYPE} step, so it covers none of the required time horizons (required: ${input.required.join(", ")}).`;
  }

  if (input.missing.length === 0) {
    return `Generated support-sweep plan searches across every required time horizon (required: ${input.required.join(", ")}; covered: ${input.covered.join(", ")}) so it cannot collapse into recent-only retrieval.`;
  }

  return `Generated support-sweep plan narrows time-horizon coverage and would collapse into recent-only retrieval. Required: ${input.required.join(", ")}; covered: ${input.covered.join(", ") || "none"}; missing: ${input.missing.join(", ")}.`;
};

/**
 * Cartridge-injected proof check enforcing that a generated AIHero support-sweep
 * plan retrieves T-shaped across every time horizon the source profile requires.
 *
 * This lives in the cartridge — NOT the platform — because the time-horizon
 * model belongs to the cartridge. The signal-search node declares a real
 * `horizons` config field with an all-five default; the platform carries no
 * horizon model and must not hardcode one. The failure `summary` names required,
 * covered, and missing horizons so the operator-facing blocker (which joins the
 * failed checks' summaries verbatim) is legible on its own.
 */
export const buildAiHeroSupportSweepHorizonCoverageProofCheck = (input: {
  readonly plan: DynamicWorkflowPlanDocument;
  readonly planArtifact: PlanArtifact;
}): MemoryGeneratedWorkflowAdditionalProofCheck => {
  const required = sortHorizons(aiHeroSupportSweepSourceProfile.timeHorizons);
  const signalSearchStepCount =
    input.plan.steps.filter(isSignalSearchStep).length;
  const covered = sortHorizons(
    input.plan.steps.flatMap(effectiveHorizonsForStep)
  );
  const missing = required.filter((horizon) => !covered.includes(horizon));
  const evidenceRefs: ArtifactRef[] = [input.planArtifact.artifactRef];

  return {
    checkId: "aihero-support-sweep:horizon-coverage",
    evidenceRefs,
    passed: signalSearchStepCount > 0 && missing.length === 0,
    summary: summarize({ covered, missing, required, signalSearchStepCount }),
  };
};
