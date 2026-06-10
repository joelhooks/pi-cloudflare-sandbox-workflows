import {
  AgentLanePackageMountIndexSchema,
  PinnedPackageSchema,
} from "../domain/schemas.ts";
import type {
  AgentLanePackageMountIndex,
  PinnedPackage,
} from "../domain/schemas.ts";

const safePackagePathSegment = (value: string): string =>
  value.replaceAll(/[^A-Za-z0-9_.-]/gu, "_");

export const mountedPackagePathFor = (packageId: string): string =>
  `packages/${safePackagePathSegment(packageId)}`;

export const buildAgentLanePackageMountIndex = (
  packageMounts: readonly PinnedPackage[]
): AgentLanePackageMountIndex => {
  const mountedPackageIdsByPath = new Map<string, string>();
  const mounts = packageMounts.map((packageMount) => {
    const pinnedPackage = PinnedPackageSchema.parse(packageMount);
    const mountPath = mountedPackagePathFor(pinnedPackage.metadata.packageId);
    const mountedPackageId = mountedPackageIdsByPath.get(mountPath);
    if (
      mountedPackageId !== undefined &&
      mountedPackageId !== pinnedPackage.metadata.packageId
    ) {
      throw new Error(
        `Package mount path collision: ${mountedPackageId} and ${pinnedPackage.metadata.packageId} both resolve to ${mountPath}.`
      );
    }
    mountedPackageIdsByPath.set(mountPath, pinnedPackage.metadata.packageId);

    return {
      ...pinnedPackage,
      mountPath,
    };
  });

  return AgentLanePackageMountIndexSchema.parse({
    mounts,
    redacted: true,
    schemaVersion: "agent-lane.package-mounts.v1",
  });
};

export const agentLanePackageMountWriterNodeScript = String.raw`const fs = require("fs");
const path = require("path");

const index = JSON.parse(
  process.env.LANE_PACKAGE_MOUNT_INDEX_JSON ||
    '{"mounts":[],"redacted":true,"schemaVersion":"agent-lane.package-mounts.v1"}'
);

if (index.schemaVersion !== "agent-lane.package-mounts.v1") {
  throw new Error("Unsupported package mount index schemaVersion.");
}

if (index.redacted !== true || !Array.isArray(index.mounts)) {
  throw new Error("Package mount index must be redacted and contain mounts.");
}

fs.mkdirSync("packages", { recursive: true });
const seenMountPaths = new Set();

for (const mount of index.mounts) {
  if (
    typeof mount.mountPath !== "string" ||
    !/^packages\/[A-Za-z0-9_.-]+$/u.test(mount.mountPath)
  ) {
    throw new Error("Package mount path failed sandbox path validation.");
  }

  if (seenMountPaths.has(mount.mountPath)) {
    throw new Error("Package mount index contains a duplicate mount path.");
  }
  seenMountPaths.add(mount.mountPath);

  const mountDir = path.join(process.cwd(), mount.mountPath);
  fs.mkdirSync(mountDir, { recursive: true });
  fs.writeFileSync(
    path.join(mountDir, "package.json"),
    JSON.stringify(mount.metadata, null, 2) + "\n"
  );
  fs.writeFileSync(
    path.join(mountDir, "pin.json"),
    JSON.stringify(
      {
        artifactRef: mount.artifactRef,
        fileHashes: mount.fileHashes,
        manifestHash: mount.manifestHash,
        pinnedAt: mount.pinnedAt,
        redacted: true,
        version: mount.version
      },
      null,
      2
    ) + "\n"
  );
}

fs.writeFileSync(
  path.join(process.cwd(), "packages", "pinned-packages.json"),
  JSON.stringify(index, null, 2) + "\n"
);
`;
