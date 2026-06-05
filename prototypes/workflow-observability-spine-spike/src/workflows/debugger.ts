export interface DebuggerDiagnosis {
  canExplainRun: boolean;
  currentState: string;
  nextSafeAction: string;
  riskNotes: string[];
}

export const diagnoseFromPack = (pack: { status: { state: string }; metrics: { lanes: number } }): DebuggerDiagnosis => ({
  canExplainRun: true,
  currentState: pack.status.state,
  nextSafeAction: "Review generated PR and run checks before merge.",
  riskNotes: pack.metrics.lanes > 0 ? [] : ["No lane metrics found"],
});
