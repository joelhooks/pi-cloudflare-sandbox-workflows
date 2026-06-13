#!/usr/bin/env tsx

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { ArtifactStoreContract } from "../src/app/application/ports.ts";
import { createCloudflareArtifactsGitStore } from "../src/app/infrastructure/cloudflare-artifacts-store.ts";
import { MemoryHitlDecisionDocumentSchema } from "../src/cartridges/memory-fabric/schemas.ts";
import type { MemoryHitlDecisionDocument } from "../src/cartridges/memory-fabric/schemas.ts";

const defaultArtifactPath = "report/hitl-decision.json";
const defaultTokenEnv = "WORKFLOW_APP_ARTIFACTS_TOKEN";

interface WriteHitlDecisionArgs {
  readonly artifactPath: string;
  readonly artifactRemote: string;
  readonly artifactTokenEnv: string;
  readonly decisionPath: string;
  readonly namespace: string;
  readonly runId?: string;
}

export interface WriteHitlDecisionCliInput {
  readonly argv: readonly string[];
  readonly log?: (message: string) => void;
  readonly processEnv: Readonly<Record<string, string | undefined>>;
  readonly repoRoot: string;
}

export interface WriteHitlDecisionInput {
  readonly artifactPath?: string;
  readonly artifactRemote: string;
  readonly artifactTokenSecret: string;
  readonly decisionPath: string;
  readonly namespace: string;
  readonly runId?: string;
}

export interface WriteHitlDecisionReceipt {
  readonly artifactCommitSha: string;
  readonly artifactPath: string;
  readonly artifactRef: string;
  readonly contentHash: string;
  readonly decisionCount: number;
  readonly mediaType: "application/json";
  readonly redacted: true;
  readonly runId: string;
  readonly schemaVersion: "workflow.hitl-decision-ingestion.v1";
  readonly workItemId: string;
}

const isMain = (): boolean =>
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

const argValue = (
  argv: readonly string[],
  name: string
): string | undefined => {
  const prefix = `${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  if (inline !== undefined) {
    return inline.slice(prefix.length);
  }

  const index = argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }

  return argv[index + 1];
};

const requiredArg = (argv: readonly string[], name: string): string => {
  const value = argValue(argv, name);
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Missing required ${name} <value>.`);
  }

  return value;
};

const parseArgs = (argv: readonly string[]): WriteHitlDecisionArgs => {
  const runId = argValue(argv, "--run-id");

  return {
    artifactPath: argValue(argv, "--artifact-path") ?? defaultArtifactPath,
    artifactRemote: requiredArg(argv, "--artifact-remote"),
    artifactTokenEnv: argValue(argv, "--artifact-token-env") ?? defaultTokenEnv,
    decisionPath: requiredArg(argv, "--decision-path"),
    namespace: requiredArg(argv, "--artifact-namespace"),
    ...(runId === undefined ? {} : { runId }),
  };
};

const readDecisionDocument = async (
  path: string
): Promise<MemoryHitlDecisionDocument> =>
  MemoryHitlDecisionDocumentSchema.parse(
    JSON.parse(await readFile(path, "utf-8"))
  );

export const writeHitlDecisionToArtifacts = async (input: {
  readonly artifactPath?: string;
  readonly artifacts: Pick<ArtifactStoreContract, "writeJson">;
  readonly decision: MemoryHitlDecisionDocument;
  readonly runId?: string;
}): Promise<WriteHitlDecisionReceipt> => {
  const runId = input.runId ?? input.decision.runId;
  if (runId !== input.decision.runId) {
    throw new Error(
      `Decision document runId ${input.decision.runId} does not match target runId ${runId}.`
    );
  }

  const artifactPath = input.artifactPath ?? defaultArtifactPath;
  const write = await input.artifacts.writeJson({
    path: artifactPath,
    redacted: true,
    runId,
    value: input.decision,
  });
  if (write.artifactCommitSha === undefined) {
    throw new Error(
      "HITL decision artifact write did not return a commit SHA."
    );
  }

  return {
    artifactCommitSha: write.artifactCommitSha,
    artifactPath,
    artifactRef: write.artifactRef,
    contentHash: write.contentHash,
    decisionCount: input.decision.decisionCount,
    mediaType: "application/json",
    redacted: true,
    runId,
    schemaVersion: "workflow.hitl-decision-ingestion.v1",
    workItemId: input.decision.workItemId,
  };
};

export const writeHitlDecision = async (
  input: WriteHitlDecisionInput
): Promise<WriteHitlDecisionReceipt> => {
  const decision = await readDecisionDocument(input.decisionPath);
  const store = createCloudflareArtifactsGitStore({
    artifactRemote: input.artifactRemote,
    artifactTokenSecret: input.artifactTokenSecret,
    namespace: input.namespace,
    seedFromRemote: true,
  });

  return await writeHitlDecisionToArtifacts({
    ...(input.artifactPath === undefined
      ? {}
      : { artifactPath: input.artifactPath }),
    artifacts: store,
    decision,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
  });
};

export const runWriteHitlDecisionCli = async (
  input: WriteHitlDecisionCliInput
): Promise<WriteHitlDecisionReceipt> => {
  const args = parseArgs(input.argv);
  const token = input.processEnv[args.artifactTokenEnv];
  if (token === undefined || token.length === 0) {
    throw new Error(
      `Missing artifact write token in environment variable ${args.artifactTokenEnv}.`
    );
  }

  const receipt = await writeHitlDecision({
    artifactPath: args.artifactPath,
    artifactRemote: args.artifactRemote,
    artifactTokenSecret: token,
    decisionPath: resolve(input.repoRoot, args.decisionPath),
    namespace: args.namespace,
    ...(args.runId === undefined ? {} : { runId: args.runId }),
  });
  const log = input.log ?? console.log;
  log(JSON.stringify(receipt, null, 2));

  return receipt;
};

if (isMain()) {
  try {
    await runWriteHitlDecisionCli({
      argv: process.argv.slice(2),
      processEnv: process.env,
      repoRoot: resolve(import.meta.dirname, ".."),
    });
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "HITL decision ingestion failed."
    );
    process.exitCode = 1;
  }
}
