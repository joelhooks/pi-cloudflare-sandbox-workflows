import type { z } from "zod";

import type { MemorySourceProfile } from "../app/domain/source-profile.ts";
import { defaultPackageSeedTemplates } from "../app/infrastructure/cloudflare-package-seeder.ts";
import type { PackageSeedTemplate } from "../app/infrastructure/cloudflare-package-seeder.ts";
import { combineCloudflareWorkflowCartridgeDependencies } from "../app/infrastructure/cloudflare-workflow-cartridge-installer.ts";
import type { CloudflareWorkflowCartridgeDependencies } from "../app/infrastructure/cloudflare-workflow-cartridge-installer.ts";
import {
  AiHeroSupportSweepCloudflareEnvBindingSchema,
  aiHeroSupportSweepCloudflareCartridgeInstaller,
} from "./aihero-support-sweep/cloudflare-installer.ts";
import { aiHeroSupportSweepPackageSeedTemplate } from "./aihero-support-sweep/package-seed.ts";
import { aiHeroSupportSweepSourceProfiles } from "./aihero-support-sweep/source-profile.ts";
import {
  MemoryFabricCloudflareEnvBindingSchema,
  memoryFabricCloudflareCartridgeInstaller,
} from "./memory-fabric/cloudflare-installer.ts";
import { memoryFabricPackageSeedTemplate } from "./memory-fabric/package-seed.ts";
import { memoryFabricSourceProfiles } from "./memory-fabric/source-profile.ts";

export const InstalledWorkflowCartridgeEnvBindingSchema =
  MemoryFabricCloudflareEnvBindingSchema.extend(
    AiHeroSupportSweepCloudflareEnvBindingSchema.shape
  );

export type InstalledWorkflowCartridgeEnvBindings = z.infer<
  typeof InstalledWorkflowCartridgeEnvBindingSchema
>;

export const installedCloudflareWorkflowCartridgeInstallers = [
  memoryFabricCloudflareCartridgeInstaller,
  aiHeroSupportSweepCloudflareCartridgeInstaller,
] as const;

export const installedWorkflowCartridgePackageSeedTemplates = [
  memoryFabricPackageSeedTemplate,
  aiHeroSupportSweepPackageSeedTemplate,
] as const satisfies readonly PackageSeedTemplate[];

/**
 * Compiled source for materializing the built-in cartridge packages via
 * `pnpm app:packages:install-local`. Local runtime profile resolution reads
 * only the installed-packages directory
 * (scripts/workflow-app-installed-packages.ts); the Worker treats this
 * compiled array as its installed profile set for fail-closed proof-recorder
 * enforcement.
 */
export const installedWorkflowCartridgeSourceProfiles = [
  ...memoryFabricSourceProfiles,
  ...aiHeroSupportSweepSourceProfiles,
] as const satisfies readonly MemorySourceProfile[];

export const defaultPackageSeedTemplatesWithInstalledCartridges = [
  ...defaultPackageSeedTemplates,
  ...installedWorkflowCartridgePackageSeedTemplates,
] as const satisfies readonly PackageSeedTemplate[];

export const workflowCartridgeDependenciesFromWorkerBindings = (
  bindings: InstalledWorkflowCartridgeEnvBindings
): CloudflareWorkflowCartridgeDependencies =>
  combineCloudflareWorkflowCartridgeDependencies(
    installedCloudflareWorkflowCartridgeInstallers.map((installer) =>
      installer.resolve({ bindings })
    )
  );
