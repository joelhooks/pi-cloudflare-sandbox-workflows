import { execFileSync } from "node:child_process";
/* eslint-disable func-style, no-use-before-define, typescript/array-type */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

export interface SourceSnapshot {
  branch?: string;
  capturedAt: string;
  fileCount: number;
  files: Array<{ path: string; sha256: string; sizeBytes: number }>;
  gitHead?: string;
  gitStatus: string;
  repoPath: string;
  snapshotId: string;
}

export function captureGitManifestSnapshot(input: {
  repoPath: string;
  snapshotId: string;
}): SourceSnapshot {
  if (!existsSync(`${input.repoPath}/.git`)) {
    throw new Error(`source repo is not a git repo: ${input.repoPath}`);
  }

  const files = listGitFiles(input.repoPath).map((path) => {
    const content = readFileSync(`${input.repoPath}/${path}`);
    return {
      path,
      sha256: sha256(content),
      sizeBytes: content.byteLength,
    };
  });

  const branch = git(input.repoPath, ["branch", "--show-current"]).trim();
  const gitHead = safeGit(input.repoPath, ["rev-parse", "HEAD"]);
  return {
    ...(branch ? { branch } : {}),
    capturedAt: new Date().toISOString(),
    fileCount: files.length,
    files,
    ...(gitHead ? { gitHead } : {}),
    gitStatus: git(input.repoPath, ["status", "--short"]),
    repoPath: input.repoPath,
    snapshotId: input.snapshotId,
  };
}

export function fileReceipt(input: {
  id: string;
  label: string;
  locator: string;
  note?: string;
}): {
  id: string;
  kind: "file";
  label: string;
  locator: string;
  note?: string;
  sha256?: string;
} {
  const sha = existsSync(input.locator)
    ? sha256(readFileSync(input.locator))
    : undefined;
  return {
    id: input.id,
    kind: "file",
    label: input.label,
    locator: input.locator,
    ...(input.note ? { note: input.note } : {}),
    ...(sha ? { sha256: sha } : {}),
  };
}

export function sha256(input: Buffer | string): string {
  return createHash("sha256").update(input).digest("hex");
}

function listGitFiles(repoPath: string): string[] {
  const output = git(repoPath, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function safeGit(repoPath: string, args: string[]): string | undefined {
  try {
    return git(repoPath, args).trim() || undefined;
  } catch {
    return undefined;
  }
}

function git(repoPath: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repoPath, encoding: "utf-8" });
}
