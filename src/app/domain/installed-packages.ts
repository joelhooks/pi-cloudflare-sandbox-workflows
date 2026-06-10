import { z } from "zod";

import {
  ArtifactRefSchema,
  PackageExportSchema,
  Sha256HexSchema,
} from "./schemas.ts";
import { MemorySourceProfileSchema } from "./source-profile.ts";

/**
 * Local installed-packages layout (decisions/kernel-package-overlays.svx,
 * "Local install contract — first instance").
 *
 * `<packagesDir>/<packageId>/manifest.json` plus
 * `<packagesDir>/<packageId>/source-profile.json` when the package exports a
 * source profile. Package ids such as `workflow/memory-fabric` nest naturally
 * as directories. Local scripts resolve profiles from this directory only; the
 * Worker resolves the same shapes from D1/Artifacts.
 */
export const workflowAppPackagesDirEnvName = "WORKFLOW_APP_PACKAGES_DIR";
export const defaultWorkflowAppPackagesDir =
  ".wrangler/workflow-app/installed-packages";
export const installedPackageManifestFileName = "manifest.json";
export const installedPackageSourceProfileFileName = "source-profile.json";

export const InstalledPackageManifestSchema = z.object({
  artifactRef: ArtifactRefSchema,
  contentHash: Sha256HexSchema,
  exports: z.array(PackageExportSchema).min(1),
  packageId: z.string().min(1),
  schemaVersion: z.literal("workflow.installed-package-manifest.v1"),
  version: z.string().min(1),
});

export const InstalledPackageSchema = z
  .object({
    manifest: InstalledPackageManifestSchema,
    sourceProfile: MemorySourceProfileSchema.optional(),
  })
  .superRefine((installedPackage, context) => {
    const exportsSourceProfile = installedPackage.manifest.exports.some(
      (exportRecord) => exportRecord.kind === "source-profile"
    );
    if (exportsSourceProfile && installedPackage.sourceProfile === undefined) {
      context.addIssue({
        code: "custom",
        message:
          "Installed packages that export a source profile must include source-profile.json.",
        path: ["sourceProfile"],
      });
    }

    if (
      installedPackage.sourceProfile !== undefined &&
      installedPackage.sourceProfile.packageId !==
        installedPackage.manifest.packageId
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Installed source-profile.json packageId must match manifest.json packageId.",
        path: ["sourceProfile", "packageId"],
      });
    }
  });

export type InstalledPackage = z.infer<typeof InstalledPackageSchema>;
export type InstalledPackageManifest = z.infer<
  typeof InstalledPackageManifestSchema
>;
