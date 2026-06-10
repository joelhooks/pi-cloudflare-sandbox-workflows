#!/usr/bin/env tsx

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import {
  startTrustedLocalMemoryRelayHttpServer,
  trustedLocalMemoryRelayHttpConfigFromEnv,
  trustedLocalMemoryRelayReadinessReceipt,
} from "../src/cartridges/memory-fabric/trusted-local-relay-http.ts";

const defaultLocalRelayStartupEnvPath =
  ".wrangler/workflow-app/dream-relay/local-relay-startup-env.json";
const StartupEnvArtifactSchema = z.record(z.string(), z.string());

const isMain = (): boolean =>
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

const argValue = (name: string): string | undefined => {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline !== undefined) {
    return inline.slice(prefix.length);
  }

  const index = process.argv.indexOf(name);
  if (index !== -1 && index + 1 < process.argv.length) {
    return process.argv[index + 1];
  }

  return undefined;
};

const readStartupEnvArtifact = async (
  path: string
): Promise<Readonly<Record<string, string>>> => {
  try {
    return StartupEnvArtifactSchema.parse(
      JSON.parse(await readFile(path, "utf-8"))
    );
  } catch {
    return {};
  }
};

const start = async (): Promise<void> => {
  const startupEnvPath = resolve(
    argValue("--local-relay-startup-env-path") ??
      defaultLocalRelayStartupEnvPath
  );
  const startupEnvArtifact = await readStartupEnvArtifact(startupEnvPath);
  const config = trustedLocalMemoryRelayHttpConfigFromEnv({
    ...startupEnvArtifact,
    ...process.env,
  });
  const relay = await startTrustedLocalMemoryRelayHttpServer(config);
  const receipt = trustedLocalMemoryRelayReadinessReceipt({ config });

  console.log(
    JSON.stringify(
      {
        healthUrl: `${relay.url}/healthz`,
        redacted: true,
        schemaVersion: "trusted.dream-memory-relay.startup.v1",
        sourceRootCount: receipt.adapter.sourceRoots.length,
        supportedOperations: receipt.supportedOperations,
        url: relay.url,
      },
      null,
      2
    )
  );
};

if (isMain()) {
  try {
    await start();
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          error: {
            code: "relay_startup_failed",
            message:
              error instanceof Error
                ? error.message
                : "Trusted local Memory relay failed to start.",
            redacted: true,
          },
          redacted: true,
          schemaVersion: "trusted.dream-memory-relay.startup-error.v1",
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  }
}
