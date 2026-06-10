import type { z } from "zod";

import { defaultPackageSeedTemplates } from "../app/infrastructure/cloudflare-package-seeder.ts";
import type { PackageSeedTemplate } from "../app/infrastructure/cloudflare-package-seeder.ts";
import { combineCloudflareWorkflowCartridgeDependencies } from "../app/infrastructure/cloudflare-workflow-cartridge-installer.ts";
import type { CloudflareWorkflowCartridgeDependencies } from "../app/infrastructure/cloudflare-workflow-cartridge-installer.ts";
import {
  DreamMemoryFabricCloudflareEnvBindingSchema,
  dreamMemoryFabricCloudflareCartridgeInstaller,
} from "./dream-memory-fabric/cloudflare-installer.ts";
import { dreamMemoryFabricPackageSeedTemplate } from "./dream-memory-fabric/package-seed.ts";

export const InstalledWorkflowCartridgeEnvBindingSchema =
  DreamMemoryFabricCloudflareEnvBindingSchema;

export type InstalledWorkflowCartridgeEnvBindings = z.infer<
  typeof InstalledWorkflowCartridgeEnvBindingSchema
>;

export const installedCloudflareWorkflowCartridgeInstallers = [
  dreamMemoryFabricCloudflareCartridgeInstaller,
] as const;

export const installedWorkflowCartridgePackageSeedTemplates = [
  dreamMemoryFabricPackageSeedTemplate,
] as const satisfies readonly PackageSeedTemplate[];

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
