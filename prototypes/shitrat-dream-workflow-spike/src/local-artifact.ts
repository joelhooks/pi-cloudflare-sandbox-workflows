/* eslint-disable func-style, no-use-before-define */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ArtifactFile } from "./artifact-files.ts";

export function createLocalArtifactRepo(input: {
  files: ArtifactFile[];
  message: string;
  repoPath: string;
}): string {
  rmSync(input.repoPath, { force: true, recursive: true });
  mkdirSync(input.repoPath, { recursive: true });
  git(input.repoPath, ["init", "-b", "main"]);
  git(input.repoPath, ["config", "user.name", "shitrat-dream-workflow-spike"]);
  git(input.repoPath, [
    "config",
    "user.email",
    "shitrat-dream-workflow-spike@example.invalid",
  ]);
  return commitLocalArtifact(input);
}

function commitLocalArtifact(input: {
  files: ArtifactFile[];
  message: string;
  repoPath: string;
}): string {
  for (const file of input.files) {
    assertSafeArtifactPath(file.path);
    const fullPath = join(input.repoPath, file.path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, file.content);
  }
  git(input.repoPath, ["add", "."]);
  git(input.repoPath, ["commit", "-m", input.message]);
  return git(input.repoPath, ["rev-parse", "HEAD"]).trim();
}

function assertSafeArtifactPath(path: string): void {
  if (!path || path.startsWith("/") || path.split("/").includes("..")) {
    throw new Error(`unsafe artifact path: ${path}`);
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}
