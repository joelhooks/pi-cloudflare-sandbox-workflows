/// <reference types="@cloudflare/workers-types" />

import { clone, readBlob } from "isomorphic-git";
import http from "isomorphic-git/http/web";

import type { ArtifactStoreContract } from "../application/ports.ts";
import { ArtifactRefSchema } from "../domain/schemas.ts";
import type { ArtifactRef } from "../domain/schemas.ts";
import {
  cloudflareArtifactsGitRemoteForRepo,
  resolveArtifactsRepoGitFields,
} from "./cloudflare-artifacts-repo-fields.ts";
import { GitMemoryFS } from "./git-memory-fs.ts";

export interface CloudflarePackageArtifactsReaderConfig {
  readonly artifacts: Artifacts;
  readonly artifactsAccountId?: string | undefined;
  readonly artifactsNamespace?: string | undefined;
  readonly readTokenTtlSeconds?: number;
}

interface ParsedCloudflarePackageArtifactRef {
  readonly path: string;
  readonly repoName: string;
}

const defaultManifestPath = "package.json";
const defaultPackageBranch = "main";
const defaultReadTokenTtlSeconds = 900;
const repoNamePattern = /^[A-Za-z0-9._-]+$/u;
const textDecoder = new TextDecoder();

const assertSafePath = (path: string): void => {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.split("/").includes("..")
  ) {
    throw new TypeError(`Unsafe package artifact path: ${path}`);
  }
};

export const parseCloudflarePackageArtifactRef = (
  artifactRef: ArtifactRef
): ParsedCloudflarePackageArtifactRef => {
  const parsedRef = ArtifactRefSchema.parse(artifactRef);
  const url = new URL(parsedRef);
  if (url.protocol !== "artifact:" || url.hostname !== "cloudflare-artifacts") {
    throw new TypeError(
      "Cloudflare package artifact refs must use artifact://cloudflare-artifacts/<repo-name>/<path>."
    );
  }

  const pathParts: string[] = [];
  for (const part of url.pathname.split("/")) {
    if (part.length > 0) {
      pathParts.push(part);
    }
  }
  const repoName = pathParts.at(0);
  const artifactPathParts = pathParts.slice(1);
  if (repoName === undefined || !repoNamePattern.test(repoName)) {
    throw new TypeError(`Invalid Cloudflare Artifacts repo name: ${repoName}`);
  }

  const path =
    artifactPathParts.length === 0
      ? defaultManifestPath
      : artifactPathParts.join("/");
  assertSafePath(path);

  return { path, repoName };
};

const cloneRepo = async (input: {
  readonly dir: string;
  readonly fs: GitMemoryFS;
  readonly noCheckout?: boolean;
  readonly ref?: string;
  readonly remote: string;
  readonly singleBranch: boolean;
  readonly token: string;
}): Promise<void> => {
  await input.fs.promises.mkdir(input.dir, { recursive: true });
  await clone({
    dir: input.dir,
    fs: input.fs,
    http,
    noCheckout: input.noCheckout,
    onAuth: () => ({ password: input.token, username: "x" }),
    ref: input.ref,
    singleBranch: input.singleBranch,
    url: input.remote,
  });
};

const readPackageFile = async (input: {
  readonly artifactCommitSha?: string;
  readonly artifactsAccountId?: string | undefined;
  readonly artifactsNamespace?: string | undefined;
  readonly path: string;
  readonly repo: ArtifactsRepo;
  readonly repoName: string;
  readonly token: string;
}): Promise<string> => {
  const dir = `/package-${crypto.randomUUID()}`;
  const fs = new GitMemoryFS();
  const remote =
    input.artifactsAccountId === undefined
      ? undefined
      : cloudflareArtifactsGitRemoteForRepo({
          accountId: input.artifactsAccountId,
          namespace: input.artifactsNamespace,
          repoName: input.repoName,
        });
  const gitFields = resolveArtifactsRepoGitFields(input.repo, {
    defaultBranch: defaultPackageBranch,
    remote,
  });
  if (input.artifactCommitSha !== undefined) {
    await cloneRepo({
      dir,
      fs,
      noCheckout: true,
      remote: gitFields.remote,
      singleBranch: false,
      token: input.token,
    });
    const { blob } = await readBlob({
      dir,
      filepath: input.path,
      fs,
      oid: input.artifactCommitSha,
    });

    return textDecoder.decode(blob);
  }

  await cloneRepo({
    dir,
    fs,
    ref: gitFields.defaultBranch,
    remote: gitFields.remote,
    singleBranch: true,
    token: input.token,
  });

  return String(
    await fs.promises.readFile(`${dir}/${input.path}`, {
      encoding: "utf-8",
    })
  );
};

export const createCloudflarePackageArtifactsReader = (
  config: CloudflarePackageArtifactsReaderConfig
): Pick<ArtifactStoreContract, "readJson"> => ({
  async readJson(input) {
    const parsed = parseCloudflarePackageArtifactRef(input.artifactRef);
    const repo = await config.artifacts.get(parsed.repoName);
    const token = await repo.createToken(
      "read",
      config.readTokenTtlSeconds ?? defaultReadTokenTtlSeconds
    );
    const text = await readPackageFile({
      ...(input.artifactCommitSha === undefined
        ? {}
        : { artifactCommitSha: input.artifactCommitSha }),
      artifactsAccountId: config.artifactsAccountId,
      artifactsNamespace: config.artifactsNamespace,
      path: parsed.path,
      repo,
      repoName: parsed.repoName,
      token: token.plaintext,
    });
    const parsedJson: unknown = JSON.parse(text);

    return parsedJson;
  },
});
