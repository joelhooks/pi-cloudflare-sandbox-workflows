import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { z } from "zod";

import {
  defaultWorkflowAppPackagesDir,
  installedPackageManifestFileName,
  installedPackageSourceProfileFileName,
  InstalledPackageManifestSchema,
  InstalledPackageSchema,
  workflowAppPackagesDirEnvName,
} from "../src/app/domain/installed-packages.ts";
import type {
  InstalledPackage,
  InstalledPackageManifest,
} from "../src/app/domain/installed-packages.ts";
import { MemorySourceProfileSchema } from "../src/app/domain/source-profile.ts";
import type { MemorySourceProfile } from "../src/app/domain/source-profile.ts";

export const installLocalPackagesHint =
  "Run `pnpm app:packages:install-local` to materialize the in-repo cartridge packages.";

export interface WorkflowAppPackagesDirInput {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly repoRoot?: string;
}

export const resolveWorkflowAppPackagesDir = (
  input?: WorkflowAppPackagesDirInput
): string => {
  const env = input?.env ?? process.env;
  const repoRoot = input?.repoRoot ?? process.cwd();
  const configured = env[workflowAppPackagesDirEnvName];
  if (configured !== undefined && configured.trim().length > 0) {
    return resolve(repoRoot, configured);
  }

  return resolve(repoRoot, defaultWorkflowAppPackagesDir);
};

const manifestDirsUnder = (root: string): readonly string[] => {
  const manifestDirs: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop();
    if (dir === undefined) {
      break;
    }

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        pending.push(join(dir, entry.name));
        continue;
      }

      if (entry.isFile() && entry.name === installedPackageManifestFileName) {
        manifestDirs.push(dir);
      }
    }
  }

  return manifestDirs.toSorted();
};

const readInstalledJson = (path: string): unknown => {
  const text = readFileSync(path, "utf-8");
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `Installed package file ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
};

const parseInstalledJson = <Schema extends z.ZodType>(
  path: string,
  schema: Schema
): z.infer<Schema> => {
  const parsed = schema.safeParse(readInstalledJson(path));
  if (!parsed.success) {
    throw new Error(
      `Installed package file ${path} failed validation:\n${z.prettifyError(parsed.error)}`,
      { cause: parsed.error }
    );
  }

  return parsed.data;
};

const loadInstalledPackage = (input: {
  readonly packageDir: string;
  readonly packagesDir: string;
}): InstalledPackage => {
  const manifestPath = join(input.packageDir, installedPackageManifestFileName);
  const sourceProfilePath = join(
    input.packageDir,
    installedPackageSourceProfileFileName
  );
  const manifest = parseInstalledJson(
    manifestPath,
    InstalledPackageManifestSchema
  );
  const sourceProfile = existsSync(sourceProfilePath)
    ? parseInstalledJson(sourceProfilePath, MemorySourceProfileSchema)
    : undefined;
  const parsed = InstalledPackageSchema.safeParse({
    manifest,
    ...(sourceProfile === undefined ? {} : { sourceProfile }),
  });
  if (!parsed.success) {
    throw new Error(
      `Installed package at ${input.packageDir} failed validation:\n${z.prettifyError(parsed.error)}`,
      { cause: parsed.error }
    );
  }

  const expectedRelativeDir = relative(input.packagesDir, input.packageDir)
    .split(sep)
    .join("/");
  if (parsed.data.manifest.packageId !== expectedRelativeDir) {
    throw new Error(
      `Installed package directory ${input.packageDir} holds manifest packageId "${parsed.data.manifest.packageId}"; expected "${expectedRelativeDir}" from its path.`
    );
  }

  return parsed.data;
};

export const listInstalledWorkflowPackages = (
  packagesDir: string
): readonly InstalledPackage[] => {
  if (!existsSync(packagesDir)) {
    return [];
  }

  return manifestDirsUnder(packagesDir).map((packageDir) =>
    loadInstalledPackage({ packageDir, packagesDir })
  );
};

const requireInstalledWorkflowPackages = (
  packagesDir: string
): readonly InstalledPackage[] => {
  const installedPackages = listInstalledWorkflowPackages(packagesDir);
  if (installedPackages.length === 0) {
    throw new Error(
      `No installed workflow packages found in ${packagesDir}. ${installLocalPackagesHint}`
    );
  }

  return installedPackages;
};

export const requireInstalledPackageManifest = (input: {
  readonly packageId: string;
  readonly packagesDir: string;
}): InstalledPackageManifest => {
  const installedPackages = requireInstalledWorkflowPackages(input.packagesDir);
  const installedPackage = installedPackages.find(
    (candidate) => candidate.manifest.packageId === input.packageId
  );
  if (installedPackage === undefined) {
    const installedPackageIds = installedPackages
      .map((candidate) => candidate.manifest.packageId)
      .join(", ");
    throw new Error(
      `No installed package "${input.packageId}" in ${input.packagesDir}. Installed packages: ${installedPackageIds}. ${installLocalPackagesHint}`
    );
  }

  return installedPackage.manifest;
};

export const resolveInstalledSourceProfile = (input: {
  readonly packagesDir: string;
  readonly profileId: string;
}): MemorySourceProfile => {
  const installedProfiles = requireInstalledWorkflowPackages(input.packagesDir)
    .map((installedPackage) => installedPackage.sourceProfile)
    .filter((profile): profile is MemorySourceProfile => profile !== undefined);
  if (installedProfiles.length === 0) {
    throw new Error(
      `No installed source profiles found in ${input.packagesDir}. ${installLocalPackagesHint}`
    );
  }

  const profile = installedProfiles.find(
    (candidate) => candidate.profileId === input.profileId
  );
  if (profile === undefined) {
    const installedProfileIds = installedProfiles
      .map((candidate) => candidate.profileId)
      .join(", ");
    throw new Error(
      `Unknown source profile "${input.profileId}". Installed source profiles: ${installedProfileIds}.`
    );
  }

  return profile;
};

export const installedSourceProfileIds = (
  packagesDir: string
): readonly string[] =>
  listInstalledWorkflowPackages(packagesDir)
    .map((installedPackage) => installedPackage.sourceProfile?.profileId)
    .filter((profileId): profileId is string => profileId !== undefined);
