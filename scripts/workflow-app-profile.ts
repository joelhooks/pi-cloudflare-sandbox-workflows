import type { MemorySourceProfile } from "../src/app/domain/source-profile.ts";
import { installedWorkflowCartridgeSourceProfiles } from "../src/cartridges/cloudflare-workflow-cartridges.ts";

export interface WorkflowProfileWorkspacePaths {
  readonly preflightReceiptPath: string;
  readonly readinessReportOutRoot: string;
  readonly runReceiptDir: string;
}

const installedProfileIds = (): readonly string[] =>
  installedWorkflowCartridgeSourceProfiles.map((profile) => profile.profileId);

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
  argv: readonly string[]
): MemorySourceProfile => {
  const profileId = profileArgValue(argv, "--profile");
  if (profileId === undefined || profileId.trim().length === 0) {
    throw new Error(
      `Missing required --profile <id>. Installed source profiles: ${installedProfileIds().join(", ")}.`
    );
  }

  const profile = installedWorkflowCartridgeSourceProfiles.find(
    (candidate) => candidate.profileId === profileId
  );
  if (profile === undefined) {
    throw new Error(
      `Unknown source profile "${profileId}". Installed source profiles: ${installedProfileIds().join(", ")}.`
    );
  }

  return profile;
};

export const workflowProfileWorkspacePaths = (
  profileId: string
): WorkflowProfileWorkspacePaths => ({
  preflightReceiptPath: `.wrangler/workflow-app/profiles/${profileId}/preflight/latest-preflight.json`,
  readinessReportOutRoot: `.wrangler/workflow-app/profiles/${profileId}/readiness-reports`,
  runReceiptDir: `.wrangler/workflow-app/profiles/${profileId}/runs`,
});
