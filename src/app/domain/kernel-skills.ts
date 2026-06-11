import { z } from "zod";

import { KernelSkillContentSchema } from "./schemas.ts";
import type { PinnedPackage } from "./schemas.ts";

/**
 * Kernel-skill consumption: the wire from a pinned kernel ref to shaped
 * reasoning. Flaw C of the system-design gap was that kernels are empty tokens
 * with no consumption path — even a real workflow-design skill in a kernel
 * changed nothing because no code read mounted kernel content into the planner
 * or nodes. This module resolves the inline skill exports (kind "skill") of the
 * pinned kernel packages into a bounded, provenance-tagged list both the
 * planner prompt builder and the agentic node-adapter execution input consume.
 *
 * The body is read straight from `pinnedPackages[*].metadata.exports[*].skill`,
 * which already carries inline content in-memory by the time the supervisor
 * pins packages, so there is no second artifact-store round-trip and no
 * dependence on the sandbox mount filesystem. The same metadata is written to
 * the mount's package.json by the package mount writer, so a lane can also see
 * the body on disk if it inspects the mount directly.
 */

/**
 * Run-level total budget across ALL resolved skill bodies, in characters. Each
 * individual body is already capped at `KERNEL_SKILL_BODY_MAX_CHARS` by the
 * schema; this second cap bounds the total a single run can inject so a kit
 * of many skills cannot blow out the planner prompt. Resolution stops adding
 * whole skills once the next body would exceed this budget (it never truncates
 * a body mid-way — a partial skill is worse than an omitted one).
 */
export const KERNEL_SKILLS_TOTAL_BUDGET_CHARS = 48_000;

/** Maximum number of resolved skills injected into a single run. */
export const KERNEL_SKILLS_MAX_COUNT = 24;

/**
 * One resolved kernel skill ready for injection: the inline content plus the
 * provenance (which pinned package and export it came from) so prompts and node
 * inputs can cite the source kernel instead of presenting anonymous text.
 */
export const ResolvedKernelSkillSchema = z.object({
  body: KernelSkillContentSchema.shape.body,
  exportId: z.string().min(1),
  packageId: z.string().min(1),
  redacted: z.literal(true),
  skillId: KernelSkillContentSchema.shape.skillId,
  title: KernelSkillContentSchema.shape.title,
  trustTier: z.enum(["manual", "reviewed", "bounded-auto"]),
});

export type ResolvedKernelSkill = z.infer<typeof ResolvedKernelSkillSchema>;

/**
 * Resolve the inline skill exports of the pinned packages into a bounded,
 * deterministically ordered list. Packages are walked in pin order, exports in
 * declaration order, and a skill is included only while the running total stays
 * within {@link KERNEL_SKILLS_TOTAL_BUDGET_CHARS} and the count stays within
 * {@link KERNEL_SKILLS_MAX_COUNT}. Duplicate (packageId, skillId) pairs are kept
 * once. A pinned set with no skill exports resolves to `[]`, which the prompt
 * builder renders as "no Kernel Skills section" — graceful degradation, never a
 * crash. The body is re-parsed through the schema so a malformed inline export
 * cannot smuggle oversized or empty content past the cap.
 */
export const resolveKernelSkills = (
  pinnedPackages: readonly PinnedPackage[]
): ResolvedKernelSkill[] => {
  const resolved: ResolvedKernelSkill[] = [];
  const seen = new Set<string>();
  let totalChars = 0;

  for (const pinnedPackage of pinnedPackages) {
    for (const packageExport of pinnedPackage.metadata.exports) {
      if (packageExport.kind !== "skill" || packageExport.skill === undefined) {
        continue;
      }

      const dedupeKey = `${pinnedPackage.metadata.packageId}:${packageExport.skill.skillId}`;
      if (seen.has(dedupeKey)) {
        continue;
      }

      if (resolved.length >= KERNEL_SKILLS_MAX_COUNT) {
        return resolved;
      }

      const nextTotal = totalChars + packageExport.skill.body.length;
      if (nextTotal > KERNEL_SKILLS_TOTAL_BUDGET_CHARS) {
        continue;
      }

      seen.add(dedupeKey);
      totalChars = nextTotal;
      resolved.push(
        ResolvedKernelSkillSchema.parse({
          body: packageExport.skill.body,
          exportId: packageExport.exportId,
          packageId: pinnedPackage.metadata.packageId,
          redacted: true,
          skillId: packageExport.skill.skillId,
          title: packageExport.skill.title,
          trustTier: pinnedPackage.metadata.trustTier,
        })
      );
    }
  }

  return resolved;
};

/**
 * Render resolved kernel skills as the planner-prompt section
 * "## Kernel Skills (use these to design the workflow)". Returns `[]` when no
 * skills resolved so the caller appends nothing — a run with no kernel skills
 * reads exactly as it did before this wire existed. Each skill is rendered with
 * its provenance header (skillId, title, source packageId + trust tier) and its
 * full inline body, so the planner reasons over the actual skill content
 * instead of a bare package ref and "copy these refs."
 */
export const renderKernelSkillsPromptSection = (
  skills: readonly ResolvedKernelSkill[]
): string[] => {
  if (skills.length === 0) {
    return [];
  }

  return [
    "## Kernel Skills (use these to design the workflow)",
    "",
    "The pinned kernel packages export the skills below. Treat them as authoritative guidance for how to shape this workflow, access data, and structure analysis. They are the reason these kernels are pinned; do not ignore them in favor of guessing.",
    ...skills.flatMap((skill) => [
      "",
      `### ${skill.skillId} — ${skill.title}`,
      `Source: ${skill.packageId} (trust tier ${skill.trustTier})`,
      "",
      skill.body,
    ]),
  ];
};
