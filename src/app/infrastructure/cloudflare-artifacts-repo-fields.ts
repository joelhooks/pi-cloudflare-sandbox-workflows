/// <reference types="@cloudflare/workers-types" />

export interface CloudflareArtifactsGitFields {
  readonly defaultBranch: string;
  readonly remote: string;
}

export interface CloudflareArtifactsGitFieldFallbacks {
  readonly defaultBranch?: string | undefined;
  readonly remote?: string | undefined;
}

export interface CloudflareArtifactsRemoteInput {
  readonly accountId: string;
  readonly namespace?: string | undefined;
  readonly repoName: string;
}

type ArtifactsRepoStringField = keyof CloudflareArtifactsGitFields;

type ArtifactsRepoFieldSource = Partial<
  Record<ArtifactsRepoStringField, unknown>
>;

const defaultArtifactsNamespace = "default";

export const cloudflareArtifactsGitRemoteForRepo = (
  input: CloudflareArtifactsRemoteInput
): string => {
  const namespace = input.namespace ?? defaultArtifactsNamespace;

  return `https://${input.accountId}.artifacts.cloudflare.net/git/${namespace}/${input.repoName}.git`;
};

const resolveArtifactsStringField = (
  source: ArtifactsRepoFieldSource,
  field: ArtifactsRepoStringField,
  fallback: string | undefined
): string => {
  const rawValue = source[field];
  if (typeof rawValue === "string" && rawValue.length > 0) {
    return rawValue;
  }

  if (fallback !== undefined && fallback.length > 0) {
    return fallback;
  }

  throw new TypeError(
    `Cloudflare Artifacts repo field ${field} must resolve to a non-empty string.`
  );
};

export const resolveArtifactsRepoGitFields = (
  repo: ArtifactsRepoFieldSource,
  fallbacks: CloudflareArtifactsGitFieldFallbacks = {}
): CloudflareArtifactsGitFields => ({
  defaultBranch: resolveArtifactsStringField(
    repo,
    "defaultBranch",
    fallbacks.defaultBranch
  ),
  remote: resolveArtifactsStringField(repo, "remote", fallbacks.remote),
});
