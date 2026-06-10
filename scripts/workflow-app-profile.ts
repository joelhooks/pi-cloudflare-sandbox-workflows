import type { MemorySourceProfile } from "../src/app/domain/source-profile.ts";
import {
  installedSourceProfileIds,
  installLocalPackagesHint,
  resolveInstalledSourceProfile,
  resolveWorkflowAppPackagesDir,
} from "./workflow-app-installed-packages.ts";
import type { WorkflowAppPackagesDirInput } from "./workflow-app-installed-packages.ts";

export interface WorkflowProfileWorkspacePaths {
  readonly preflightReceiptPath: string;
  readonly readinessReportOutRoot: string;
  readonly runReceiptDir: string;
}

export const profileArgValue = (
  argv: readonly string[],
  name: string
): string | undefined => {
  const prefix = `${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  if (inline !== undefined) {
    return inline.slice(prefix.length);
  }

  const index = argv.indexOf(name);
  if (index !== -1 && index + 1 < argv.length) {
    return argv[index + 1];
  }

  return undefined;
};

export const requireInstalledSourceProfile = (
  argv: readonly string[],
  options?: WorkflowAppPackagesDirInput
): MemorySourceProfile => {
  const packagesDir = resolveWorkflowAppPackagesDir(options);
  const profileId = profileArgValue(argv, "--profile");
  if (profileId === undefined || profileId.trim().length === 0) {
    const profileIds = installedSourceProfileIds(packagesDir);
    throw new Error(
      profileIds.length === 0
        ? `Missing required --profile <id>. No installed source profiles found in ${packagesDir}. ${installLocalPackagesHint}`
        : `Missing required --profile <id>. Installed source profiles: ${profileIds.join(", ")}.`
    );
  }

  return resolveInstalledSourceProfile({ packagesDir, profileId });
};

export const workflowProfileWorkspacePaths = (
  profileId: string
): WorkflowProfileWorkspacePaths => ({
  preflightReceiptPath: `.wrangler/workflow-app/profiles/${profileId}/preflight/latest-preflight.json`,
  readinessReportOutRoot: `.wrangler/workflow-app/profiles/${profileId}/readiness-reports`,
  runReceiptDir: `.wrangler/workflow-app/profiles/${profileId}/runs`,
});
