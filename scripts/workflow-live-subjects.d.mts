// Type declarations for `workflow-live-subjects.mjs` so `.ts` callers typecheck
// cleanly under NodeNext (allowJs off). See the `.mjs` for the wound-#40 rationale.

export const defaultOperatorSubjectId: "actor:operator";
export const defaultOperatorSubjectType: "actor";
export const workflowInternalSubjectId: "actor:workflow";
export const liveRunOperatorSubjectId: "actor:workflow-live-operator";

export interface PackageSeedSubjectInput {
  readonly subjectId: string;
  readonly subjectType: "actor" | "organization" | "role" | "service";
  readonly canDiscover: boolean;
  readonly canMount: boolean;
  readonly canInvoke: boolean;
  readonly versionRange: string;
}

export const packageSeedSubjects: (overrides?: {
  readonly operatorSubjectId?: string;
  readonly operatorSubjectType?: string;
}) => readonly PackageSeedSubjectInput[];
