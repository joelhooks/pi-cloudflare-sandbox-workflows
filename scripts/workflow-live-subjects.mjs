// Single source of truth for the workflow subject identities that the deploy-seed
// path provisions and the live-run submit path executes as. Wound #40: these two
// identities were hardcoded independently in `workflow-app-deploy-and-seed.mjs`
// (seed) and `workflow-app-run.ts` (submit) and drifted — the seed granted
// entitlements to `actor:operator` while live runs execute as
// `actor:workflow-live-operator`, so every newly-installed cartridge was silently
// un-mountable live despite a green seed receipt. Both scripts now import these
// constants so the seeded subject set and the executing actor cannot drift apart.

/** Operator identity used by hand-driven admin/seed flows. */
export const defaultOperatorSubjectId = "actor:operator";
export const defaultOperatorSubjectType = "actor";

/** Internal identity the workflow assumes for in-graph package mounts. */
export const workflowInternalSubjectId = "actor:workflow";

/**
 * Identity a LIVE submitted run executes as (see `actorForLiveRun` in
 * `workflow-app-run.ts`). This is the subject that must hold `can_mount` for any
 * package a live run pins, or admission blocks `entitlement_missing`.
 */
export const liveRunOperatorSubjectId = "actor:workflow-live-operator";

/**
 * Build the seed subject set granted to EVERY package on `pnpm app:deploy:seed`.
 * Mirrors the proven-working memory-fabric grant: operator + internal workflow
 * actors get mount (no invoke), and the live-run operator gets mount AND invoke
 * so a live submitted run can both mount and invoke any seeded cartridge.
 *
 * @param {{ operatorSubjectId?: string, operatorSubjectType?: string }} [overrides]
 *   Optional operator-subject override (env-driven), defaulting to
 *   `actor:operator` / `actor`. The internal and live-run subjects are fixed —
 *   they are the identities the carrier itself assumes, not operator choices.
 * @returns {ReadonlyArray<{
 *   subjectId: string, subjectType: "actor" | "organization" | "role" | "service",
 *   canDiscover: boolean, canMount: boolean, canInvoke: boolean, versionRange: string
 * }>} the per-package entitlement subject set to seed for every package.
 */
export const packageSeedSubjects = (overrides = {}) => {
  const operatorSubjectId =
    overrides.operatorSubjectId ?? defaultOperatorSubjectId;
  const operatorSubjectType =
    overrides.operatorSubjectType ?? defaultOperatorSubjectType;

  return [
    {
      canDiscover: true,
      canInvoke: false,
      canMount: true,
      subjectId: operatorSubjectId,
      subjectType: operatorSubjectType,
      versionRange: "*",
    },
    {
      canDiscover: true,
      canInvoke: false,
      canMount: true,
      subjectId: workflowInternalSubjectId,
      subjectType: "actor",
      versionRange: "*",
    },
    {
      canDiscover: true,
      canInvoke: true,
      canMount: true,
      subjectId: liveRunOperatorSubjectId,
      subjectType: "actor",
      versionRange: "*",
    },
  ];
};
