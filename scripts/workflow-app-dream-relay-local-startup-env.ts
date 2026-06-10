#!/usr/bin/env tsx

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import { trustedLocalMemoryRelayHttpConfigFromEnv } from "../src/cartridges/memory-fabric/trusted-local-relay-http.ts";

const defaultSourceRootsPath =
  ".wrangler/workflow-app/dream-relay/source-roots.json";
const defaultStartupEnvPath =
  ".wrangler/workflow-app/dream-relay/local-relay-startup-env.json";
const defaultReceiptPath =
  ".wrangler/workflow-app/dream-relay/latest-local-startup-env-receipt.json";
const defaultDocsApiBaseUrl = "https://joelclaw.com/api/docs";
const defaultDocsApiUserAgent =
  "pi-cloudflare-sandbox-workflows-dream-relay/0.0.0";

const StartupEnvArtifactSchema = z.record(z.string(), z.string());

export const DreamRelayLocalStartupEnvReceiptSchema = z.object({
  docsApiConfigured: z.boolean(),
  envRef: z.string().min(1),
  generatedAt: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().min(1),
  rawCredentialsReturned: z.literal(false),
  rawPathsReturned: z.literal(false),
  redacted: z.literal(true),
  schemaVersion: z.literal(
    "trusted.dream-memory-relay.local-startup-env-receipt.v1"
  ),
  sourceRootCount: z.number().int().min(1),
  sourceRootsRef: z.string().min(1),
  tokenConfigured: z.literal(true),
  tokenGenerated: z.boolean(),
  tokenPreserved: z.boolean(),
});

export type DreamRelayLocalStartupEnvReceipt = z.infer<
  typeof DreamRelayLocalStartupEnvReceiptSchema
>;

export interface DreamRelayLocalStartupEnvCliInput {
  readonly argv: readonly string[];
  readonly log?: (message: string) => void;
  readonly now?: () => string;
  readonly processEnv?: Readonly<Record<string, string | undefined>>;
  readonly repoRoot: string;
}

interface DreamRelayLocalStartupEnvArgs {
  readonly receiptPath: string;
  readonly rotateToken: boolean;
  readonly sourceRootsPath: string;
  readonly startupEnvPath: string;
}

interface StartupEnvBuildResult {
  readonly startupEnv: Readonly<Record<string, string>>;
  readonly tokenPreserved: boolean;
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
  if (index !== -1 && index + 1 < argv.length) {
    return argv[index + 1];
  }

  return undefined;
};

const hasFlag = (argv: readonly string[], name: string): boolean =>
  argv.includes(name);

const parseArgs = (argv: readonly string[]): DreamRelayLocalStartupEnvArgs => ({
  receiptPath: argValue(argv, "--receipt") ?? defaultReceiptPath,
  rotateToken: hasFlag(argv, "--rotate-token"),
  sourceRootsPath: argValue(argv, "--source-roots") ?? defaultSourceRootsPath,
  startupEnvPath: argValue(argv, "--out") ?? defaultStartupEnvPath,
});

const safeLocalArtifactRef = (path: string): string =>
  path.startsWith(".wrangler/") ? path : "<redacted-local-operator-artifact>";

const readExistingStartupEnv = async (
  path: string
): Promise<Readonly<Record<string, string>> | undefined> => {
  try {
    return StartupEnvArtifactSchema.parse(
      JSON.parse(await readFile(path, "utf-8"))
    );
  } catch {
    return undefined;
  }
};

const writeJson = async (
  path: string,
  value: unknown,
  options: { readonly mode?: number } = {}
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (options.mode === undefined) {
    await writeFile(path, serialized, "utf-8");

    return;
  }

  const temporaryPath = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporaryPath, serialized, {
    encoding: "utf-8",
    flag: "wx",
    mode: options.mode,
  });
  await rename(temporaryPath, path);
};

const buildStartupEnv = (input: {
  readonly existingEnv: Readonly<Record<string, string>> | undefined;
  readonly processEnv: Readonly<Record<string, string | undefined>>;
  readonly rotateToken: boolean;
  readonly sourceRootsJson: string;
}): StartupEnvBuildResult => {
  const { existingEnv, processEnv } = input;
  const existingToken = existingEnv?.["MEMORY_RELAY_TOKEN"];
  const tokenPreserved =
    !input.rotateToken &&
    existingToken !== undefined &&
    existingToken.length > 0;
  const token = tokenPreserved
    ? existingToken
    : randomBytes(32).toString("hex");
  const startupEnv = StartupEnvArtifactSchema.parse({
    MEMORY_DOCS_API_BASE_URL:
      processEnv["MEMORY_DOCS_API_BASE_URL"] ?? defaultDocsApiBaseUrl,
    MEMORY_DOCS_API_USER_AGENT:
      processEnv["MEMORY_DOCS_API_USER_AGENT"] ?? defaultDocsApiUserAgent,
    MEMORY_RELAY_HOST:
      processEnv["MEMORY_RELAY_HOST"] ??
      existingEnv?.["MEMORY_RELAY_HOST"] ??
      "127.0.0.1",
    MEMORY_RELAY_MAX_BODY_BYTES:
      processEnv["MEMORY_RELAY_MAX_BODY_BYTES"] ??
      existingEnv?.["MEMORY_RELAY_MAX_BODY_BYTES"] ??
      "4000000",
    MEMORY_RELAY_MAX_FILES_PER_SOURCE:
      processEnv["MEMORY_RELAY_MAX_FILES_PER_SOURCE"] ??
      existingEnv?.["MEMORY_RELAY_MAX_FILES_PER_SOURCE"] ??
      "5000",
    MEMORY_RELAY_PORT:
      processEnv["MEMORY_RELAY_PORT"] ??
      existingEnv?.["MEMORY_RELAY_PORT"] ??
      "8789",
    MEMORY_RELAY_SOURCE_ROOTS_JSON: input.sourceRootsJson,
    MEMORY_RELAY_TOKEN: token,
  });

  return { startupEnv, tokenPreserved };
};

const receiptFor = (input: {
  readonly config: ReturnType<typeof trustedLocalMemoryRelayHttpConfigFromEnv>;
  readonly generatedAt: string;
  readonly sourceRootsPath: string;
  readonly startupEnvPath: string;
  readonly tokenPreserved: boolean;
}): DreamRelayLocalStartupEnvReceipt =>
  DreamRelayLocalStartupEnvReceiptSchema.parse({
    docsApiConfigured: input.config.docsApi !== undefined,
    envRef: safeLocalArtifactRef(input.startupEnvPath),
    generatedAt: input.generatedAt,
    host: input.config.host,
    port: input.config.port,
    rawCredentialsReturned: false,
    rawPathsReturned: false,
    redacted: true,
    schemaVersion: "trusted.dream-memory-relay.local-startup-env-receipt.v1",
    sourceRootCount: input.config.memoryFabric.sourceRoots.length,
    sourceRootsRef: safeLocalArtifactRef(input.sourceRootsPath),
    tokenConfigured: true,
    tokenGenerated: !input.tokenPreserved,
    tokenPreserved: input.tokenPreserved,
  });

export const runDreamRelayLocalStartupEnvCli = async (
  input: DreamRelayLocalStartupEnvCliInput
): Promise<DreamRelayLocalStartupEnvReceipt> => {
  const args = parseArgs(input.argv);
  const sourceRootsPath = resolve(input.repoRoot, args.sourceRootsPath);
  const startupEnvPath = resolve(input.repoRoot, args.startupEnvPath);
  const receiptPath = resolve(input.repoRoot, args.receiptPath);
  const sourceRootsJson = await readFile(sourceRootsPath, "utf-8");
  const existingEnv = await readExistingStartupEnv(startupEnvPath);
  const { startupEnv, tokenPreserved } = buildStartupEnv({
    existingEnv,
    processEnv: input.processEnv ?? process.env,
    rotateToken: args.rotateToken,
    sourceRootsJson,
  });
  const config = trustedLocalMemoryRelayHttpConfigFromEnv(startupEnv);
  const receipt = receiptFor({
    config,
    generatedAt: input.now?.() ?? new Date().toISOString(),
    sourceRootsPath: args.sourceRootsPath,
    startupEnvPath: args.startupEnvPath,
    tokenPreserved,
  });

  await writeJson(startupEnvPath, startupEnv, { mode: 0o600 });
  await writeJson(receiptPath, receipt);

  const log = input.log ?? console.log;
  log(JSON.stringify(receipt, null, 2));
  log(`wrote ${receiptPath}`);

  return receipt;
};

if (isMain()) {
  try {
    await runDreamRelayLocalStartupEnvCli({
      argv: process.argv.slice(2),
      repoRoot: process.cwd(),
    });
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          error: {
            code: "dream_relay_local_startup_env_failed",
            message:
              error instanceof Error
                ? error.message
                : "Memory relay local startup env generation failed.",
            redacted: true,
          },
          redacted: true,
          schemaVersion:
            "trusted.dream-memory-relay.local-startup-env-error.v1",
          status: "failed",
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  }
}
