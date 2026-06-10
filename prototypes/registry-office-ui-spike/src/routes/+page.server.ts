import {
  jobsByNewest,
  latestVersion,
  listPackages,
  registryUrl,
} from "$lib/registry.server";

export const load = async (event) => {
  const registryBinding = event.platform?.env?.REGISTRY_WORKER;
  const packages = await listPackages(registryBinding);
  const cards = packages.map((pack) => ({
    description: pack.description,
    latest: latestVersion(pack),
    name: pack.name,
    updatedAt: pack.updatedAt,
  }));
  const successfulPackages = packages.filter(
    (pack) => latestVersion(pack)?.validationStatus === "succeeded"
  );
  const latestJobs = packages.flatMap((pack) => jobsByNewest(pack).slice(0, 3));

  return {
    cards,
    latestJobs: latestJobs.slice(0, 8),
    registryUrl,
    stats: {
      packageCount: packages.length,
      succeededCount: successfulPackages.length,
      versionCount: packages.reduce(
        (count, pack) => count + Object.keys(pack.versions).length,
        0
      ),
    },
  };
};
