import type { OutputTarget, WorkflowPattern } from "./schema.ts";

export interface PatternDefinition {
  description: string;
  eventDrivenLineage: string[];
  id: WorkflowPattern;
  requiredStates: string[];
  supportedTargets: OutputTarget["kind"][];
}

export const PATTERN_LIBRARY: Record<WorkflowPattern, PatternDefinition> = {
  artifact_only_capture: {
    description:
      "Read/analyze, verify artifact presence, keep delivery inside the Artifacts repo.",
    eventDrivenLineage: ["sequential pipeline", "retry-safe side effects"],
    id: "artifact_only_capture",
    requiredStates: [
      "planning",
      "resolvingContext",
      "materializingSecrets",
      "preparingWorkspace",
      "runningPrimaryLane",
      "capturingArtifacts",
      "runningVerifier",
      "evaluatingVerification",
      "deliveringOutput",
      "destroyingSandbox",
      "captured",
      "blocked",
      "cancelled",
    ],
    supportedTargets: ["artifact_only", "implementation_plan"],
  },
  edit_verify_pr: {
    description:
      "Edit a repo, run tests, verify the diff, then deliver a GitHub PR through an approved bot/app identity.",
    eventDrivenLineage: [
      "sequential pipeline",
      "approval gate",
      "retry-safe side effects",
    ],
    id: "edit_verify_pr",
    requiredStates: [
      "planning",
      "resolvingContext",
      "materializingSecrets",
      "preparingWorkspace",
      "runningEditLane",
      "runningTests",
      "runningVerifier",
      "evaluatingVerification",
      "deliveringOutput",
      "destroyingSandbox",
      "captured",
      "blocked",
      "cancelled",
    ],
    supportedTargets: ["github_pr", "issue_comment"],
  },
  fanout_synthesis: {
    description:
      "Fan out bounded lanes, wait for all useful outputs, synthesize, verify, then deliver.",
    eventDrivenLineage: [
      "coordinator / fan-out-fan-in",
      "rate-limited batching",
      "progress streaming",
    ],
    id: "fanout_synthesis",
    requiredStates: [
      "planning",
      "resolvingContext",
      "materializingSecrets",
      "preparingWorkspace",
      "runningFanout",
      "synthesizingResults",
      "runningVerifier",
      "evaluatingVerification",
      "deliveringOutput",
      "destroyingSandbox",
      "captured",
      "blocked",
      "cancelled",
    ],
    supportedTargets: [
      "wzrrd_review",
      "artifact_only",
      "implementation_plan",
      "prototype",
    ],
  },
  generate_filter: {
    description:
      "Generate candidate outputs, filter/rank them, verify the winner, then deliver.",
    eventDrivenLineage: ["generate-and-filter", "tournament", "approval gate"],
    id: "generate_filter",
    requiredStates: [
      "planning",
      "resolvingContext",
      "materializingSecrets",
      "preparingWorkspace",
      "generatingCandidates",
      "filteringCandidates",
      "runningVerifier",
      "evaluatingVerification",
      "deliveringOutput",
      "destroyingSandbox",
      "captured",
      "blocked",
      "cancelled",
    ],
    supportedTargets: ["wzrrd_review", "email_draft", "prototype"],
  },
  human_review_gate: {
    description:
      "Produce a reviewable artifact, wait for human approve/reject, then deliver or block.",
    eventDrivenLineage: [
      "supervisor with approval gate",
      "long delay orchestration",
    ],
    id: "human_review_gate",
    requiredStates: [
      "planning",
      "resolvingContext",
      "materializingSecrets",
      "preparingWorkspace",
      "runningPrimaryLane",
      "runningVerifier",
      "evaluatingVerification",
      "waitingHumanReview",
      "deliveringOutput",
      "destroyingSandbox",
      "captured",
      "blocked",
      "cancelled",
    ],
    supportedTargets: ["wzrrd_review", "linear_update", "email_draft"],
  },
  reader_verifier: {
    description:
      "Run a primary read/report lane, verify against a job-specific contract, then deliver output.",
    eventDrivenLineage: ["sequential pipeline", "adversarial verification"],
    id: "reader_verifier",
    requiredStates: [
      "planning",
      "resolvingContext",
      "materializingSecrets",
      "preparingWorkspace",
      "runningPrimaryLane",
      "runningVerifier",
      "evaluatingVerification",
      "deliveringOutput",
      "destroyingSandbox",
      "captured",
      "blocked",
      "cancelled",
    ],
    supportedTargets: [
      "wzrrd_review",
      "artifact_only",
      "linear_update",
      "issue_comment",
      "email_draft",
      "implementation_plan",
    ],
  },
};

export const getPatternDefinition = (
  pattern: WorkflowPattern
): PatternDefinition => PATTERN_LIBRARY[pattern];
