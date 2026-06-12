import {
  add,
  clone,
  commit as gitCommit,
  init as gitInit,
  push,
  readBlob,
} from "isomorphic-git";
import http from "isomorphic-git/http/web";

import type { ArtifactStoreContract } from "../application/ports.ts";
import { hashJson, sha256Hex } from "../domain/hash.ts";
import {
  ArtifactRefSchema,
  ArtifactWriteReceiptSchema,
} from "../domain/schemas.ts";
import type { ArtifactRef, ArtifactWriteReceipt } from "../domain/schemas.ts";
import { GitMemoryFS } from "./git-memory-fs.ts";

interface CloudflareArtifactsGitStoreConfig {
  readonly artifactRemote: string;
  readonly artifactTokenSecret: string;
  readonly author?: {
    readonly email: string;
    readonly name: string;
  };
  readonly defaultBranch?: string;
  readonly namespace: string;
}

interface CloudflareArtifactsRunRepoHandle {
  readonly name?: string;
  readonly remote: string;
  createToken(
    scope: "write" | "read",
    ttl?: number
  ): Promise<{
    readonly expiresAt: string;
    readonly plaintext: string;
  }>;
}

interface CloudflareArtifactsRunProvisionInput {
  readonly artifacts: {
    create(
      name: string,
      opts: {
        readonly description: string;
        readonly readOnly: boolean;
        readonly setDefaultBranch: string;
      }
    ): Promise<{
      readonly name?: string;
      readonly remote: string;
      readonly token: string;
      readonly tokenExpiresAt: string;
    }>;
    get(name: string): Promise<CloudflareArtifactsRunRepoHandle>;
  };
  readonly description: string;
  readonly repoName: string;
}

export interface CloudflareArtifactsRunStore {
  readonly artifactRemote: string;
  readonly artifactRepoName: string;
  readonly artifactTokenSecret: string;
  readonly artifactTokenExpiresAt: string;
  readonly store: ArtifactStoreContract;
}

const textDecoder = new TextDecoder();

const tokenSecretForGit = (token: string): string =>
  token.split("?expires=").at(0) ?? token;

const invalidNamespaceValues = new Set(["", "undefined"]);

const repoNameFromArtifactsRemote = (remote: string): string | null => {
  const match = /\/git\/[^/]+\/([^/?#]+)\.git(?:[?#].*)?$/u.exec(remote);
  return match?.[1] === undefined ? null : decodeURIComponent(match[1]);
};

const resolveArtifactStoreNamespace = (input: {
  readonly namespace: string;
  readonly remote: string;
}): string => {
  if (!invalidNamespaceValues.has(input.namespace)) {
    return input.namespace;
  }

  const repoName = repoNameFromArtifactsRemote(input.remote);
  if (repoName !== null && !invalidNamespaceValues.has(repoName)) {
    return repoName;
  }

  throw new TypeError(
    "Cloudflare Artifacts store namespace must be non-empty."
  );
};

const assertRunRepoName = (repoName: string): string => {
  if (repoName.length === 0) {
    throw new TypeError("Artifacts run repo name must be non-empty.");
  }

  return repoName;
};

const assertSafeArtifactPath = (path: string): void => {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.split("/").includes("..")
  ) {
    throw new TypeError(`Unsafe artifact path: ${path}`);
  }
};

const parseArtifactRef = (
  namespace: string,
  artifactRef: ArtifactRef
): { readonly path: string; readonly runId: string } => {
  const parsed = ArtifactRefSchema.parse(artifactRef);
  const prefix = `artifact://${namespace}/runs/`;
  if (!parsed.startsWith(prefix)) {
    throw new TypeError(`Artifact ref is outside this store: ${artifactRef}`);
  }

  const [runId, ...pathParts] = parsed.slice(prefix.length).split("/");
  const path = pathParts.join("/");
  if (runId === undefined || runId.length === 0) {
    throw new TypeError(`Artifact ref is missing a run id: ${artifactRef}`);
  }
  assertSafeArtifactPath(path);

  return { path, runId };
};

const artifactRefFor = (
  namespace: string,
  input: { readonly path: string; readonly runId: string }
): ArtifactRef => {
  assertSafeArtifactPath(input.path);
  return ArtifactRefSchema.parse(
    `artifact://${namespace}/runs/${input.runId}/${input.path}`
  );
};

class CloudflareArtifactsGitStore implements ArtifactStoreContract {
  private readonly author: { readonly email: string; readonly name: string };
  private readonly defaultBranch: string;
  private readonly dir = "/repo";
  private readonly fs = new GitMemoryFS();
  private initialized = false;
  private readonly namespace: string;
  private readonly remote: string;
  private readonly tokenSecret: string;

  constructor(config: CloudflareArtifactsGitStoreConfig) {
    this.author = config.author ?? {
      email: "pi-workflow-app@example.invalid",
      name: "pi-workflow-app",
    };
    this.defaultBranch = config.defaultBranch ?? "main";
    this.namespace = resolveArtifactStoreNamespace({
      namespace: config.namespace,
      remote: config.artifactRemote,
    });
    this.remote = config.artifactRemote;
    this.tokenSecret = config.artifactTokenSecret;
  }

  artifactRef(input: {
    readonly path: string;
    readonly runId: string;
  }): ArtifactRef {
    return artifactRefFor(this.namespace, input);
  }

  async readJson(input: {
    readonly artifactCommitSha?: string;
    readonly artifactRef: ArtifactRef;
  }): Promise<unknown> {
    return JSON.parse(await this.readText(input));
  }

  async readText(input: {
    readonly artifactCommitSha?: string;
    readonly artifactRef: ArtifactRef;
  }): Promise<string> {
    const parsed = parseArtifactRef(this.namespace, input.artifactRef);
    if (input.artifactCommitSha !== undefined) {
      return await this.readTextAtCommit(parsed.path, input.artifactCommitSha);
    }

    await this.ensureWritableWorktree();
    return String(
      await this.fs.promises.readFile(`${this.dir}/${parsed.path}`, {
        encoding: "utf-8",
      })
    );
  }

  writeJson(input: {
    readonly path: string;
    readonly redacted: true;
    readonly runId: string;
    readonly value: unknown;
  }): Promise<ArtifactWriteReceipt> {
    return this.writeText({
      mediaType: "application/json",
      path: input.path,
      redacted: input.redacted,
      runId: input.runId,
      value: JSON.stringify(input.value, null, 2),
    }).then((receipt) =>
      ArtifactWriteReceiptSchema.parse({
        ...receipt,
        contentHash: hashJson(input.value),
      })
    );
  }

  async writeText(input: {
    readonly mediaType: string;
    readonly path: string;
    readonly redacted: true;
    readonly runId: string;
    readonly value: string;
  }): Promise<ArtifactWriteReceipt> {
    assertSafeArtifactPath(input.path);
    await this.ensureWritableWorktree();
    const pathParts = input.path.split("/");
    pathParts.pop();
    if (pathParts.length > 0) {
      await this.fs.promises.mkdir(`${this.dir}/${pathParts.join("/")}`, {
        recursive: true,
      });
    }
    await this.fs.promises.writeFile(`${this.dir}/${input.path}`, input.value);
    await add({ dir: this.dir, filepath: input.path, fs: this.fs });
    await gitCommit({
      author: this.author,
      dir: this.dir,
      fs: this.fs,
      message: `artifact: ${input.runId} ${input.path}`,
    });
    await push({
      dir: this.dir,
      fs: this.fs,
      http,
      onAuth: () => ({ password: this.tokenSecret, username: "x" }),
      ref: this.defaultBranch,
      url: this.remote,
    });

    return ArtifactWriteReceiptSchema.parse({
      artifactRef: this.artifactRef({
        path: input.path,
        runId: input.runId,
      }),
      contentHash: sha256Hex(input.value),
      mediaType: input.mediaType,
      redacted: input.redacted,
    });
  }

  private async ensureWritableWorktree(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.fs.promises.mkdir(this.dir, { recursive: true });
    await gitInit({
      defaultBranch: this.defaultBranch,
      dir: this.dir,
      fs: this.fs,
    });
    this.initialized = true;
  }

  private async readTextAtCommit(
    path: string,
    commitSha: string
  ): Promise<string> {
    const fs = new GitMemoryFS();
    const dir = "/read";
    await fs.promises.mkdir(dir, { recursive: true });
    await clone({
      dir,
      fs,
      http,
      noCheckout: true,
      onAuth: () => ({ password: this.tokenSecret, username: "x" }),
      singleBranch: false,
      url: this.remote,
    });
    const { blob } = await readBlob({
      dir,
      filepath: path,
      fs,
      oid: commitSha,
    });

    return textDecoder.decode(blob);
  }
}

export const createCloudflareArtifactsGitStore = (
  config: CloudflareArtifactsGitStoreConfig
): ArtifactStoreContract => new CloudflareArtifactsGitStore(config);

const isArtifactsErrorCode = (
  error: unknown,
  code: string
): error is { readonly code: string } =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { readonly code?: unknown }).code === code;

// Tokens minted when re-attaching to an already-provisioned run repo. Mirrors
// the binding's `create` default (24h) so a re-driven run gets the same lease
// window as its first drive.
const runStoreTokenTtlSeconds = 86_400;

const runStoreFromRepoFields = (fields: {
  readonly remote: string;
  readonly repoName: string;
  readonly tokenExpiresAt: string;
  readonly tokenPlaintext: string;
}): CloudflareArtifactsRunStore => {
  const artifactTokenSecret = tokenSecretForGit(fields.tokenPlaintext);
  const artifactRepoName = assertRunRepoName(fields.repoName);

  return {
    artifactRemote: fields.remote,
    artifactRepoName,
    artifactTokenExpiresAt: fields.tokenExpiresAt,
    artifactTokenSecret,
    store: createCloudflareArtifactsGitStore({
      artifactRemote: fields.remote,
      artifactTokenSecret,
      namespace: artifactRepoName,
    }),
  };
};

// Provisioning a run store is re-entrant: the single-step driver re-enters
// `startRun` on every drive, so the second+ drive of any multi-node run hits an
// already-created repo. Treat `create` as a get-or-create — on ALREADY_EXISTS,
// re-attach via `get` and mint a fresh write token instead of going dark.
export const provisionCloudflareArtifactsRunStore = async (
  input: CloudflareArtifactsRunProvisionInput
): Promise<CloudflareArtifactsRunStore> => {
  try {
    const repo = await input.artifacts.create(input.repoName, {
      description: input.description,
      readOnly: false,
      setDefaultBranch: "main",
    });

    return runStoreFromRepoFields({
      remote: repo.remote,
      repoName:
        repo.name ?? repoNameFromArtifactsRemote(repo.remote) ?? input.repoName,
      tokenExpiresAt: repo.tokenExpiresAt,
      tokenPlaintext: repo.token,
    });
  } catch (error) {
    if (!isArtifactsErrorCode(error, "ALREADY_EXISTS")) {
      throw error;
    }

    const repo = await input.artifacts.get(input.repoName);
    const token = await repo.createToken("write", runStoreTokenTtlSeconds);

    return runStoreFromRepoFields({
      remote: repo.remote,
      repoName:
        repo.name ?? repoNameFromArtifactsRemote(repo.remote) ?? input.repoName,
      tokenExpiresAt: token.expiresAt,
      tokenPlaintext: token.plaintext,
    });
  }
};
