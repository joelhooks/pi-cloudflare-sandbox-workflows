import {
  jobsByNewest,
  latestVersion,
  listPackages,
} from "$lib/registry.server";

export const load = async (event) => {
  const registryBinding = event.platform?.env?.REGISTRY_WORKER;
  const packages = await listPackages(registryBinding);
  return {
    packages: packages.map((pack) => ({
      description: pack.description,
      jobCount: jobsByNewest(pack).length,
      latest: latestVersion(pack),
      name: pack.name,
      updatedAt: pack.updatedAt,
      versionCount: Object.keys(pack.versions).length,
    })),
  };
};
