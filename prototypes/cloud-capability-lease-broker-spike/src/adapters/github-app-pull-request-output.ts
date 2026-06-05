/* eslint-disable class-methods-use-this, curly, func-style, no-use-before-define, prefer-destructuring, unicorn/no-await-expression-member */
import type { PullRequestOutputPort } from "../core/pull-request-output-port.ts";
import type {
  OpenPullRequestCapabilityPayload,
  PullRequestReceipt,
} from "../core/schemas.ts";
import type { GitHubAppSigningHandle } from "../core/secret-material-store.ts";

interface GitHubRefResponse {
  object: { sha: string };
}

interface GitHubCommitResponse {
  sha: string;
  tree: { sha: string };
}

interface GitHubBlobResponse {
  sha: string;
}

interface GitHubTreeResponse {
  sha: string;
}

interface GitHubPullResponse {
  html_url: string;
  head: { sha: string };
  number: number;
  user: { login: string };
}

interface GitHubInstallationTokenResponse {
  token: string;
}

const githubApiBase = "https://api.github.com";
const textEncoder = new TextEncoder();

export class GitHubAppPullRequestOutput implements PullRequestOutputPort {
  async openPullRequest(
    input: OpenPullRequestCapabilityPayload,
    signingHandle: GitHubAppSigningHandle
  ): Promise<PullRequestReceipt> {
    const actualPrBodyHash = await sha256(input.prBody);
    if (actualPrBodyHash !== input.prBodyHash) {
      throw new Error("pr_body_hash_mismatch");
    }

    const token = await mintInstallationToken(signingHandle);
    const [owner, repo] = parseRepo(input.repo);
    const repoPath = buildRepoPath(owner, repo);
    const auth = { token };
    const baseRef = await githubJson<GitHubRefResponse>(
      `${repoPath}/git/ref/heads/main`,
      auth
    );
    const baseCommitSha = baseRef.object.sha;
    const baseCommit = await githubJson<GitHubCommitResponse>(
      `${repoPath}/git/commits/${baseCommitSha}`,
      auth
    );
    const blobs = await Promise.all(
      input.files.map(async (file) => ({
        mode: "100644" as const,
        path: file.path,
        sha: (
          await githubJson<GitHubBlobResponse>(`${repoPath}/git/blobs`, auth, {
            content: file.content,
            encoding: "utf-8",
          })
        ).sha,
        type: "blob" as const,
      }))
    );
    const tree = await githubJson<GitHubTreeResponse>(
      `${repoPath}/git/trees`,
      auth,
      {
        base_tree: baseCommit.tree.sha,
        tree: blobs,
      }
    );
    const commit = await githubJson<GitHubCommitResponse>(
      `${repoPath}/git/commits`,
      auth,
      {
        author: {
          date: new Date().toISOString(),
          email: "shitratgit[bot]@users.noreply.github.com",
          name: "shitratgit[bot]",
        },
        committer: {
          date: new Date().toISOString(),
          email: "shitratgit[bot]@users.noreply.github.com",
          name: "shitratgit[bot]",
        },
        message: `prototype: cloud capability lease broker proof\n\nrun: ${input.runId}\npayloadHash: ${input.payloadHash}`,
        parents: [baseCommitSha],
        tree: tree.sha,
      }
    );

    await upsertBranch({
      auth,
      branch: input.branch,
      commitSha: commit.sha,
      owner,
      repo,
    });

    const pull = await upsertPullRequest({
      auth,
      body: input.prBody,
      branch: input.branch,
      owner,
      repo,
      title: input.prTitle,
    });

    if (pull.user.login !== "shitratgit[bot]") {
      throw new Error("unexpected_pr_actor");
    }

    return {
      actor: "shitratgit[bot]",
      branch: input.branch,
      commitSha: commit.sha,
      payloadHash: input.payloadHash,
      prNumber: pull.number,
      prUrl: pull.html_url,
      repo: input.repo,
    };
  }
}

async function mintInstallationToken(
  signingHandle: GitHubAppSigningHandle
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const jwt = await signingHandle.signJwt({
    expiresAtEpochSeconds: now + 540,
    issuedAtEpochSeconds: now - 30,
  });
  const response = await fetch(
    `${githubApiBase}/app/installations/${signingHandle.installationId}/access_tokens`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${jwt}`,
        "user-agent": "pi-cloud-capability-lease-broker-spike",
        "x-github-api-version": "2022-11-28",
      },
      method: "POST",
    }
  );
  if (!response.ok) {
    throw new Error(`github_installation_token_failed:${response.status}`);
  }
  return ((await response.json()) as GitHubInstallationTokenResponse).token;
}

async function upsertBranch(input: {
  auth: { token: string };
  branch: string;
  commitSha: string;
  owner: string;
  repo: string;
}): Promise<void> {
  const repoPath = buildRepoPath(input.owner, input.repo);
  const createResponse = await fetch(`${githubApiBase}${repoPath}/git/refs`, {
    body: JSON.stringify({
      ref: `refs/heads/${input.branch}`,
      sha: input.commitSha,
    }),
    headers: githubHeaders(input.auth.token),
    method: "POST",
  });
  if (createResponse.ok) return;
  if (createResponse.status !== 422) {
    throw new Error(`github_create_ref_failed:${createResponse.status}`);
  }
  await githubJson(
    `${repoPath}/git/refs/heads/${encodeURIComponent(input.branch)}`,
    input.auth,
    { force: true, sha: input.commitSha },
    "PATCH"
  );
}

async function upsertPullRequest(input: {
  auth: { token: string };
  body: string;
  branch: string;
  owner: string;
  repo: string;
  title: string;
}): Promise<GitHubPullResponse> {
  const repoPath = buildRepoPath(input.owner, input.repo);
  const query = new URLSearchParams({
    base: "main",
    head: `${input.owner}:${input.branch}`,
    state: "open",
  });
  const existing = await githubJson<GitHubPullResponse[]>(
    `${repoPath}/pulls?${query.toString()}`,
    input.auth
  );
  if (existing.length > 0) {
    const pull = existing[0];
    if (!pull) throw new Error("github_existing_pr_missing");
    return githubJson<GitHubPullResponse>(
      `${repoPath}/pulls/${pull.number}`,
      input.auth,
      { body: input.body, title: input.title },
      "PATCH"
    );
  }
  return githubJson<GitHubPullResponse>(
    `${repoPath}/pulls`,
    input.auth,
    {
      base: "main",
      body: input.body,
      head: input.branch,
      title: input.title,
    },
    "POST"
  );
}

async function githubJson<Result>(
  path: string,
  auth: { token: string },
  body?: unknown,
  method = body ? "POST" : "GET"
): Promise<Result> {
  const init: RequestInit = {
    headers: githubHeaders(auth.token),
    method,
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${githubApiBase}${path}`, init);
  if (!response.ok) {
    throw new Error(
      `github_api_failed:${method}:${path.split("?")[0]}:${response.status}`
    );
  }
  return (await response.json()) as Result;
}

function githubHeaders(token: string): HeadersInit {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "user-agent": "pi-cloud-capability-lease-broker-spike",
    "x-github-api-version": "2022-11-28",
  };
}

function buildRepoPath(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function parseRepo(repo: string): [owner: string, repo: string] {
  const parts = repo.split("/");
  if (parts.length !== 2) throw new Error("invalid_repo");
  const [owner, name] = parts;
  if (!owner || !name) throw new Error("invalid_repo");
  return [owner, name];
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(value)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
