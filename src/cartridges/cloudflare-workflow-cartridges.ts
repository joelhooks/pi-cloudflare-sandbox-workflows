import type { z } from "zod";

import type { MemorySourceProfile } from "../app/domain/source-profile.ts";
import { defaultPackageSeedTemplates } from "../app/infrastructure/cloudflare-package-seeder.ts";
import type { PackageSeedTemplate } from "../app/infrastructure/cloudflare-package-seeder.ts";
import { combineCloudflareWorkflowCartridgeDependencies } from "../app/infrastructure/cloudflare-workflow-cartridge-installer.ts";
import type { CloudflareWorkflowCartridgeDependencies } from "../app/infrastructure/cloudflare-workflow-cartridge-installer.ts";
import {
  MemoryFabricCloudflareEnvBindingSchema,
  memoryFabricCloudflareCartridgeInstaller,
} from "./memory-fabric/cloudflare-installer.ts";
import { memoryFabricPackageSeedTemplate } from "./memory-fabric/package-seed.ts";
import { memoryFabricSourceProfiles } from "./memory-fabric/source-profile.ts";

export const InstalledWorkflowCartridgeEnvBindingSchema =
  MemoryFabricCloudflareEnvBindingSchema;

export type InstalledWorkflowCartridgeEnvBindings = z.infer<
  typeof InstalledWorkflowCartridgeEnvBindingSchema
>;

export const installedCloudflareWorkflowCartridgeInstallers = [
  memoryFabricCloudflareCartridgeInstaller,
] as const;

export const installedWorkflowCartridgePackageSeedTemplates = [
  memoryFabricPackageSeedTemplate,
] as const satisfies readonly PackageSeedTemplate[];

export const installedWorkflowCartridgeSourceProfiles = [
  ...memoryFabricSourceProfiles,
] as const satisfies readonly MemorySourceProfile[];

export const installedSourceProfileById = (
  profileId: string
): MemorySourceProfile | undefined =>
  installedWorkflowCartridgeSourceProfiles.find(
    (profile) => profile.profileId === profileId
  );

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
