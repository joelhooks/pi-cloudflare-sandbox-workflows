#!/usr/bin/env tsx

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import {
  startTrustedLocalMemoryRelayHttpServer,
  trustedLocalMemoryRelayHttpConfigFromEnv,
  TrustedLocalMemoryRelayReadinessReceiptSchema,
} from "../src/cartridges/memory-fabric/trusted-local-relay-http.ts";

const defaultLocalRelayStartupEnvPath =
  ".wrangler/workflow-app/dream-relay/local-relay-startup-env.json";
const defaultReceiptPath =
  ".wrangler/workflow-app/dream-relay/latest-local-readiness.json";

const StartupEnvArtifactSchema = z.record(z.string(), z.string());

export const DreamRelayLocalReadinessProofReceiptSchema = z.object({
  boundHost: z.string().min(1),
  boundPort: z.number().int().min(1),
  checkedAt: z.string().min(1),
  configuredHost: z.string().min(1),
  configuredPort: z.number().int().min(1),
  healthz: z.object({
    authRequired: z.literal(true),
    httpStatus: z.literal(200),
    rawCredentialsReturned: z.literal(false),
    rawPathsReturned: z.literal(false),
    schemaVersion: z.literal("trusted.memory-relay.readiness.v1"),
    sourceRootCount: z.number().int().min(1),
    status: z.literal("passed"),
    supportedOperationCount: z.number().int().min(1),
  }),
  rawCredentialsReturned: z.literal(false),
  rawPathsReturned: z.literal(false),
  redacted: z.literal(true),
  schemaVersion: z.literal(
    "trusted.dream-memory-relay.local-readiness-proof.v1"
  ),
  sourceRootCount: z.number().int().min(1),
  startupEnvRef: z.string().min(1),
  status: z.literal("passed"),
  tokenConfigured: z.literal(true),
  usedConfiguredPort: z.boolean(),
});

export type DreamRelayLocalReadinessProofReceipt = z.infer<
  typeof DreamRelayLocalReadinessProofReceiptSchema
>;

export interface DreamRelayLocalReadinessCliInput {
  readonly argv: readonly string[];
  readonly log?: (message: string) => void;
  readonly now?: () => string;
  readonly processEnv?: Readonly<Record<string, string | undefined>>;
  readonly repoRoot: string;
}

interface DreamRelayLocalReadinessArgs {
  readonly bindConfiguredPort: boolean;
  readonly receiptPath: string;
  readonly startupEnvPath: string;
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

const parseArgs = (argv: readonly string[]): DreamRelayLocalReadinessArgs => ({
  bindConfiguredPort: hasFlag(argv, "--bind-configured-port"),
  receiptPath: argValue(argv, "--out") ?? defaultReceiptPath,
  startupEnvPath:
    argValue(argv, "--local-relay-startup-env-path") ??
    defaultLocalRelayStartupEnvPath,
});

const safeLocalArtifactRef = (path: string): string =>
  path.startsWith(".wrangler/") ? path : "<redacted-local-operator-artifact>";

const readStartupEnvArtifact = async (
  path: string
): Promise<Readonly<Record<string, string>>> =>
  StartupEnvArtifactSchema.parse(JSON.parse(await readFile(path, "utf-8")));

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
};

const fetchHealthz = async (input: {
  readonly relayUrl: string;
  readonly token: string;
}) => {
  const response = await fetch(new URL("/healthz", input.relayUrl), {
    headers: {
      authorization: `Bearer ${input.token}`,
    },
    method: "GET",
  });

  if (!response.ok) {
    throw new Error(
      `Local Memory relay /healthz returned HTTP ${response.status}.`
    );
  }

  return TrustedLocalMemoryRelayReadinessReceiptSchema.parse(
    await response.json()
  );
};

export const runDreamRelayLocalReadinessCli = async (
  input: DreamRelayLocalReadinessCliInput
): Promise<DreamRelayLocalReadinessProofReceipt> => {
  const args = parseArgs(input.argv);
  const startupEnv = {
    ...(await readStartupEnvArtifact(
      resolve(input.repoRoot, args.startupEnvPath)
    )),
    ...(input.processEnv ?? process.env),
  };
  const config = trustedLocalMemoryRelayHttpConfigFromEnv(startupEnv);
  const serverConfig = {
    ...config,
    port: args.bindConfiguredPort ? config.port : 0,
  };
  const relay = await startTrustedLocalMemoryRelayHttpServer(serverConfig);

  try {
    const readiness = await fetchHealthz({
      relayUrl: relay.url,
      token: config.expectedBearerToken,
    });
    const url = new URL(relay.url);
    const receipt = DreamRelayLocalReadinessProofReceiptSchema.parse({
      boundHost: url.hostname,
      boundPort: Number.parseInt(url.port, 10),
      checkedAt: input.now?.() ?? new Date().toISOString(),
      configuredHost: config.host,
      configuredPort: config.port,
      healthz: {
        authRequired: readiness.auth.required,
        httpStatus: 200,
        rawCredentialsReturned: readiness.rawCredentialsReturned,
        rawPathsReturned: readiness.rawPathsReturned,
        schemaVersion: readiness.schemaVersion,
        sourceRootCount: readiness.adapter.sourceRoots.length,
        status: "passed",
        supportedOperationCount: readiness.supportedOperations.length,
      },
      rawCredentialsReturned: readiness.rawCredentialsReturned,
      rawPathsReturned: readiness.rawPathsReturned,
      redacted: true,
      schemaVersion: "trusted.dream-memory-relay.local-readiness-proof.v1",
      sourceRootCount: readiness.adapter.sourceRoots.length,
      startupEnvRef: safeLocalArtifactRef(args.startupEnvPath),
      status: "passed",
      tokenConfigured: true,
      usedConfiguredPort: args.bindConfiguredPort,
    });

    await writeJson(resolve(input.repoRoot, args.receiptPath), receipt);

    const log = input.log ?? console.log;
    log(JSON.stringify(receipt, null, 2));
    log(`wrote ${resolve(input.repoRoot, args.receiptPath)}`);

    return receipt;
  } finally {
    await relay.close();
  }
};

if (isMain()) {
  try {
    await runDreamRelayLocalReadinessCli({
      argv: process.argv.slice(2),
      repoRoot: process.cwd(),
    });
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          error: {
            code: "dream_relay_local_readiness_failed",
            message:
              error instanceof Error
                ? error.message
                : "Memory relay local readiness proof failed.",
            redacted: true,
          },
          redacted: true,
          schemaVersion: "trusted.dream-memory-relay.local-readiness-error.v1",
          status: "failed",
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  }
}
