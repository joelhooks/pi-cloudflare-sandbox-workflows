import { renderMarkdown } from "$lib/markdown.server";
import { getSkillContent, getSkillSummary } from "$lib/registry.server";
import { error } from "@sveltejs/kit";

export const load = async ({ params, platform }) => {
  const registryBinding = platform?.env?.REGISTRY_WORKER;
  const skill = await getSkillSummary(params.id, registryBinding);
  if (!skill) {
    throw error(404, "Skill not found");
  }
  const content = await getSkillContent(skill.latest, registryBinding);
  const rendered = content ? await renderMarkdown(content.content) : undefined;
  return {
    renderedSkill:
      content && rendered
        ? {
            frontmatter: rendered.data,
            html: rendered.html,
            path: content.path,
          }
        : undefined,
    skill,
  };
};
