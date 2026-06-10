import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { installLocalWorkflowPackages } from "../../scripts/workflow-app-install-local-packages.ts";
import { requireInstalledSourceProfile } from "../../scripts/workflow-app-profile.ts";
import {
  defaultWorkflowAppPackagesDir,
  installedPackageSourceProfileFileName,
} from "../../src/app/domain/installed-packages.ts";
import { dreamTranscriptReviewSourceProfile } from "../../src/cartridges/memory-fabric/source-profile.ts";

const profileArgs = [
  "--profile",
  dreamTranscriptReviewSourceProfile.profileId,
] as const;

const withTempRepoRoot = async (
  run: (repoRoot: string) => Promise<void> | void
): Promise<void> => {
  const repoRoot = await mkdtemp(resolve(tmpdir(), "installed-packages-"));
  try {
    await run(repoRoot);
  } finally {
    await rm(repoRoot, { force: true, recursive: true });
  }
};

describe("installed-packages profile resolution", () => {
  it("materializes the in-repo cartridge packages idempotently and resolves the installed profile", async () => {
    await withTempRepoRoot(async (repoRoot) => {
      const first = await installLocalWorkflowPackages({
        log: () => {},
        repoRoot,
      });
      const second = await installLocalWorkflowPackages({
        log: () => {},
        repoRoot,
      });
      const profile = requireInstalledSourceProfile([...profileArgs], {
        env: {},
        repoRoot,
      });

      expect({
        firstStatuses: first.files.map((file) => file.status),
        packageIds: first.packageIds,
        packagesDir: first.packagesDir,
        profile,
        secondStatuses: second.files.map((file) => file.status),
      }).toStrictEqual({
        firstStatuses: ["written", "written"],
        packageIds: ["workflow/memory-fabric"],
        packagesDir: resolve(repoRoot, defaultWorkflowAppPackagesDir),
        profile: dreamTranscriptReviewSourceProfile,
        secondStatuses: ["unchanged", "unchanged"],
      });
    });
  });

  it("lists the installed profile ids when the requested profile is unknown", async () => {
    await withTempRepoRoot(async (repoRoot) => {
      await installLocalWorkflowPackages({ log: () => {}, repoRoot });

      expect(() =>
        requireInstalledSourceProfile(["--profile", "joelhooks/unknown"], {
          env: {},
          repoRoot,
        })
      ).toThrow(
        'Unknown source profile "joelhooks/unknown". Installed source profiles: joelhooks/dream-transcript-review.'
      );
    });
  });

  it("points at the local installer when no packages are installed", async () => {
    await withTempRepoRoot((repoRoot) => {
      expect(() =>
        requireInstalledSourceProfile([...profileArgs], { env: {}, repoRoot })
      ).toThrow(
        `No installed workflow packages found in ${resolve(repoRoot, defaultWorkflowAppPackagesDir)}. Run \`pnpm app:packages:install-local\` to materialize the in-repo cartridge packages.`
      );
    });
  });

  it("fails with the Zod error when an installed source profile is malformed", async () => {
    await withTempRepoRoot(async (repoRoot) => {
      const { packagesDir } = await installLocalWorkflowPackages({
        log: () => {},
        repoRoot,
      });
      const sourceProfilePath = join(
        packagesDir,
        "workflow/memory-fabric",
        installedPackageSourceProfileFileName
      );
      await writeFile(
        sourceProfilePath,
        `${JSON.stringify({ schemaVersion: "memory.source-profile.v1" }, null, 2)}\n`,
        "utf-8"
      );

      const failure = (): unknown =>
        requireInstalledSourceProfile([...profileArgs], { env: {}, repoRoot });

      expect(failure).toThrow(
        `Installed package file ${sourceProfilePath} failed validation:`
      );
      expect(failure).toThrow("profileId");
    });
  });

  it("fails loudly when an installed package file is not valid JSON", async () => {
    await withTempRepoRoot(async (repoRoot) => {
      const { packagesDir } = await installLocalWorkflowPackages({
        log: () => {},
        repoRoot,
      });
      const sourceProfilePath = join(
        packagesDir,
        "workflow/memory-fabric",
        installedPackageSourceProfileFileName
      );
      await writeFile(sourceProfilePath, "{not-json", "utf-8");

      expect(() =>
        requireInstalledSourceProfile([...profileArgs], { env: {}, repoRoot })
      ).toThrow(
        `Installed package file ${sourceProfilePath} is not valid JSON:`
      );
    });
  });

  it("respects the WORKFLOW_APP_PACKAGES_DIR env override", async () => {
    await withTempRepoRoot(async (repoRoot) => {
      const overrideDir = await mkdtemp(
        resolve(tmpdir(), "installed-packages-override-")
      );
      try {
        const env = { WORKFLOW_APP_PACKAGES_DIR: overrideDir };
        const receipt = await installLocalWorkflowPackages({
          env,
          log: () => {},
          repoRoot,
        });
        const profile = requireInstalledSourceProfile([...profileArgs], {
          env,
          repoRoot,
        });

        expect({
          packagesDir: receipt.packagesDir,
          profileId: profile.profileId,
        }).toStrictEqual({
          packagesDir: overrideDir,
          profileId: dreamTranscriptReviewSourceProfile.profileId,
        });
        expect(() =>
          requireInstalledSourceProfile([...profileArgs], { env: {}, repoRoot })
        ).toThrow("No installed workflow packages found");
      } finally {
        await rm(overrideDir, { force: true, recursive: true });
      }
    });
  });
});
