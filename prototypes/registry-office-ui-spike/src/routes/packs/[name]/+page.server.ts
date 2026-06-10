import {
  getPackContentsSummary,
  getPackage,
  jobsByNewest,
} from "$lib/registry.server";
import { error as kitError } from "@sveltejs/kit";

export const load = async ({ params, platform }) => {
  try {
    const registryBinding = platform?.env?.REGISTRY_WORKER;
    const pack = await getPackage(params.name, registryBinding);
    const versions = Object.values(pack.versions).toSorted((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    );
    return {
      contents: await getPackContentsSummary(
        params.name,
        versions[0]?.version,
        registryBinding
      ),
      events: pack.eventLog.toReversed(),
      jobs: jobsByNewest(pack),
      pack,
      versions,
    };
  } catch (error) {
    throw kitError(
      404,
      error instanceof Error ? error.message : "Package not found"
    );
  }
};
