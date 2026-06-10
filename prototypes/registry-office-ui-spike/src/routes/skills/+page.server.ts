import { listSkillSummaries } from "$lib/registry.server";

export const load = async (event) => ({
  skills: await listSkillSummaries(event.platform?.env?.REGISTRY_WORKER),
});
