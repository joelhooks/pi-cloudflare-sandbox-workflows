#!/usr/bin/env tsx
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { hashJson } from "../src/app/domain/hash.ts";
import {
  installedPackageManifestFileName,
  installedPackageSourceProfileFileName,
  InstalledPackageSchema,
} from "../src/app/domain/installed-packages.ts";
import type { InstalledPackage } from "../src/app/domain/installed-packages.ts";
import { packageMetadataForSeedTemplate } from "../src/app/infrastructure/cloudflare-package-seeder.ts";
import {
  installedWorkflowCartridgePackageSeedTemplates,
  installedWorkflowCartridgeSourceProfiles,
} from "../src/cartridges/cloudflare-workflow-cartridges.ts";
import { resolveWorkflowAppPackagesDir } from "./workflow-app-installed-packages.ts";

export interface InstallLocalWorkflowPackagesFileReceipt {
  readonly path: string;
  readonly status: "unchanged" | "written";
}

export interface InstallLocalWorkflowPackagesReceipt {
  readonly files: readonly InstallLocalWorkflowPackagesFileReceipt[];
  readonly packageIds: readonly string[];
  readonly packagesDir: string;
}

const installedPackageForSeedTemplate = (
  template: (typeof installedWorkflowCartridgePackageSeedTemplates)[number]
): InstalledPackage => {
  const metadata = packageMetadataForSeedTemplate(template);
  const sourceProfiles = installedWorkflowCartridgeSourceProfiles.filter(
    (profile) => profile.packageId === metadata.packageId
  );
  if (sourceProfiles.length > 1) {
    throw new Error(
      `Package ${metadata.packageId} declares ${sourceProfiles.length} source profiles; the installed-packages layout holds one source-profile.json per package.`
    );
  }

  const [sourceProfile] = sourceProfiles;

  return InstalledPackageSchema.parse({
    manifest: {
      artifactRef: metadata.latestArtifactRef,
      contentHash: hashJson(metadata),
      exports: metadata.exports,
      packageId: metadata.packageId,
      schemaVersion: "workflow.installed-package-manifest.v1",
      version: metadata.latestVersion,
    },
    ...(sourceProfile === undefined ? {} : { sourceProfile }),
  });
};

const writeJsonIfChanged = async (
  path: string,
  value: unknown
): Promise<InstallLocalWorkflowPackagesFileReceipt> => {
  const next = `${JSON.stringify(value, null, 2)}\n`;
  const existing = await readFile(path, "utf-8").catch(() => null);
  if (existing === next) {
    return { path, status: "unchanged" };
  }

  await writeFile(path, next, "utf-8");

  return { path, status: "written" };
};

export const installLocalWorkflowPackages = async (input?: {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly log?: (message: string) => void;
  readonly repoRoot?: string;
}): Promise<InstallLocalWorkflowPackagesReceipt> => {
  const log = input?.log ?? console.log;
  const packagesDir = resolveWorkflowAppPackagesDir({
    ...(input?.env === undefined ? {} : { env: input.env }),
    ...(input?.repoRoot === undefined ? {} : { repoRoot: input.repoRoot }),
  });
  const files: InstallLocalWorkflowPackagesFileReceipt[] = [];
  const packageIds: string[] = [];
  for (const template of installedWorkflowCartridgePackageSeedTemplates) {
    const installedPackage = installedPackageForSeedTemplate(template);
    const packageDir = join(packagesDir, installedPackage.manifest.packageId);
    await mkdir(packageDir, { recursive: true });
    files.push(
      await writeJsonIfChanged(
        join(packageDir, installedPackageManifestFileName),
        installedPackage.manifest
      )
    );
    if (installedPackage.sourceProfile !== undefined) {
      files.push(
        await writeJsonIfChanged(
          join(packageDir, installedPackageSourceProfileFileName),
          installedPackage.sourceProfile
        )
      );
    }

    packageIds.push(installedPackage.manifest.packageId);
  }

  for (const file of files) {
    log(`${file.status === "written" ? "wrote" : "unchanged"} ${file.path}`);
  }

  log(
    `installed ${packageIds.length} local workflow package(s) into ${packagesDir}: ${packageIds.join(", ")}`
  );

  return { files, packageIds, packagesDir };
};

const isMainModule = (): boolean =>
  process.argv[1] !== undefined &&
  import.meta.filename === resolve(process.argv[1]);

if (isMainModule()) {
  try {
    await installLocalWorkflowPackages({
      env: process.env,
      repoRoot: resolve(import.meta.dirname, ".."),
    });
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "Local workflow package install failed."
    );
    process.exitCode = 1;
  }
}
