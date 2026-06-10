/* eslint-disable func-style, no-use-before-define */

import { env } from "$env/dynamic/private";

export interface JobRecord {
  completedAt?: string;
  createdAt: string;
  error?: string;
  id: string;
  name: string;
  resultCommitSha?: string;
  sandboxDestroyReceipt?: string;
  sandboxId?: string;
  status: "queued" | "running" | "succeeded" | "failed";
  type: "validate-package" | "install-smoke";
  version: string;
}

export interface VersionRecord {
  artifactRemote: string;
  artifactRepoName: string;
  commitSha: string;
  createdAt: string;
  fileIndex?: FileIndexEntry[];
  packageRef: string;
  validationJobId: string;
  validationStatus: "queued" | "running" | "succeeded" | "failed";
  version: string;
}

export interface PackageRecord {
  description: string;
  eventLog: string[];
  jobs: Record<string, JobRecord>;
  name: string;
  updatedAt: string;
  versions: Record<string, VersionRecord>;
}

interface PackagesResponse {
  ok: true;
  packages: PackageRecord[];
}

interface PackageResponse {
  ok: true;
  package: PackageRecord;
}

interface FileIndexEntry {
  kind: "doc" | "prompt" | "skill" | "other";
  path: string;
  sizeBytes: number;
}

interface FilesResponse {
  files: FileIndexEntry[];
  ok: true;
  packageName: string;
  version: string;
}

interface FileResponse {
  content: string;
  file: FileIndexEntry;
  ok: true;
  packageName: string;
  version: string;
}

export interface PackContentsSummary {
  docs: string[];
  prompts: string[];
  skills: string[];
  source: "registry-api" | "unavailable";
}

export interface SkillVersionSummary {
  packName: string;
  packRef: string;
  path: string;
  sizeBytes: number;
  validationStatus: VersionRecord["validationStatus"];
  version: string;
}

export interface SkillSummary {
  id: string;
  latest?: SkillVersionSummary;
  versions: SkillVersionSummary[];
}

export interface SkillContent {
  content: string;
  path: string;
}

const DEFAULT_REGISTRY_URL =
  "https://pi-cloudflare-registry-workflow-os-spike.joelhooks.workers.dev";

export const registryUrl = env["REGISTRY_WORKER_URL"] ?? DEFAULT_REGISTRY_URL;

export interface RegistryBinding {
  fetch(request: Request): Promise<Response>;
}

export async function listPackages(
  registryBinding?: RegistryBinding
): Promise<PackageRecord[]> {
  const body = await registryFetch<PackagesResponse>(
    "/api/packages",
    registryBinding
  );
  return body.packages.toSorted((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt)
  );
}

export async function getPackage(
  name: string,
  registryBinding?: RegistryBinding
): Promise<PackageRecord> {
  const body = await registryFetch<PackageResponse>(
    `/api/packages/${encodeURIComponent(name)}`,
    registryBinding
  );
  return body.package;
}

export function latestVersion(pack: PackageRecord): VersionRecord | undefined {
  return Object.values(pack.versions).toSorted((a, b) =>
    b.createdAt.localeCompare(a.createdAt)
  )[0];
}

export function jobsByNewest(pack: PackageRecord): JobRecord[] {
  return Object.values(pack.jobs).toSorted((a, b) =>
    b.createdAt.localeCompare(a.createdAt)
  );
}

export async function listSkillSummaries(
  registryBinding?: RegistryBinding
): Promise<SkillSummary[]> {
  const packages = await listPackages(registryBinding);
  const bySkill = new Map<string, SkillVersionSummary[]>();

  for (const pack of packages) {
    for (const version of Object.values(pack.versions)) {
      const fileIndex = await getVersionFileIndex(
        pack.name,
        version,
        registryBinding
      );
      for (const file of fileIndex.filter((entry) => entry.kind === "skill")) {
        const skillId = skillNameFromPath(file.path);
        if (!skillId) {
          continue;
        }
        const summaries = bySkill.get(skillId) ?? [];
        summaries.push({
          packName: pack.name,
          packRef: version.packageRef,
          path: file.path,
          sizeBytes: file.sizeBytes,
          validationStatus: version.validationStatus,
          version: version.version,
        });
        bySkill.set(skillId, summaries);
      }
    }
  }

  return [...bySkill.entries()]
    .map(([id, versions]) => {
      const sortedVersions = versions.toSorted((a, b) =>
        b.version.localeCompare(a.version)
      );
      return { id, latest: sortedVersions[0], versions: sortedVersions };
    })
    .toSorted((a, b) => a.id.localeCompare(b.id));
}

export async function getSkillSummary(
  id: string,
  registryBinding?: RegistryBinding
): Promise<SkillSummary | undefined> {
  const summaries = await listSkillSummaries(registryBinding);
  return summaries.find((skill) => skill.id === id);
}

export async function getSkillContent(
  version: SkillVersionSummary | undefined,
  registryBinding?: RegistryBinding
): Promise<SkillContent | undefined> {
  if (!version) {
    return undefined;
  }
  const body = await registryFetch<FileResponse>(
    `/api/packages/${encodeURIComponent(version.packName)}/versions/${encodeURIComponent(version.version)}/file?path=${encodeURIComponent(version.path)}`,
    registryBinding
  );
  return { content: body.content, path: body.file.path };
}

export async function getPackContentsSummary(
  name: string,
  version: string | undefined,
  registryBinding?: RegistryBinding
): Promise<PackContentsSummary> {
  if (!version) {
    return { docs: [], prompts: [], skills: [], source: "unavailable" };
  }

  const body = await registryFetch<FilesResponse>(
    `/api/packages/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}/files`,
    registryBinding
  );
  return {
    docs: body.files
      .filter((file) => file.kind === "doc")
      .map((file) => file.path)
      .toSorted(),
    prompts: body.files
      .filter((file) => file.kind === "prompt")
      .map((file) => file.path)
      .toSorted(),
    skills: body.files
      .filter((file) => file.kind === "skill")
      .map((file) => skillNameFromPath(file.path))
      .filter(
        (skillName): skillName is string =>
          skillName !== undefined && skillName.length > 0
      )
      .toSorted(),
    source: "registry-api",
  };
}

async function getVersionFileIndex(
  packName: string,
  version: VersionRecord,
  registryBinding?: RegistryBinding
): Promise<FileIndexEntry[]> {
  if (version.fileIndex && version.fileIndex.length > 0) {
    return version.fileIndex;
  }

  const body = await registryFetch<FilesResponse>(
    `/api/packages/${encodeURIComponent(packName)}/versions/${encodeURIComponent(version.version)}/files`,
    registryBinding
  );
  return body.files;
}

async function registryFetch<T>(
  path: string,
  registryBinding?: RegistryBinding
): Promise<T> {
  const accessToken = await readAccessToken();
  const request = new Request(
    registryBinding ? `https://registry.local${path}` : `${registryUrl}${path}`,
    { headers: { authorization: `Bearer ${accessToken}` } }
  );
  const response = registryBinding
    ? await registryBinding.fetch(request)
    : await fetch(request);
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(
      `Registry returned non-JSON ${response.status}: ${text.slice(0, 300)}`
    );
  }
  if (!response.ok || !body || typeof body !== "object" || !("ok" in body)) {
    throw new Error(
      `Registry request failed ${response.status}: ${text.slice(0, 500)}`
    );
  }
  return body as T;
}

function skillNameFromPath(path: string): string | undefined {
  const match = path.match(/^skills\/([^/]+)\/SKILL\.md$/u);
  return match?.[1];
}

function readAccessToken(): string {
  const accessToken = env["ACCESS_TOKEN"];
  if (accessToken) {
    return accessToken;
  }
  throw new Error(
    "Missing ACCESS_TOKEN. Set it as a private deployment env var."
  );
}
