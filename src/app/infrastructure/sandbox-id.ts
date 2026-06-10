import { sha256Hex } from "../domain/hash.ts";

export const safeGitRefSegment = (value: string): string => {
  const slug = value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-|-$/gu, "")
    .slice(0, 60)
    .replaceAll(/^-|-$/gu, "");
  return slug.length === 0 ? sha256Hex(value).slice(0, 8) : slug;
};

export const buildSandboxId = (runId: string, laneId: string): string => {
  const runParts = safeGitRefSegment(runId).split("-");
  const runToken = runParts.slice(-2).join("-").slice(0, 24);
  const laneToken = safeGitRefSegment(laneId).slice(0, 28);

  return `pa-${runToken}-${laneToken}`.slice(0, 63).replaceAll(/^-|-$/gu, "");
};
