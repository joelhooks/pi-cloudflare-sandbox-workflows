#!/usr/bin/env tsx

import { pathToFileURL } from "node:url";

import {
  startTrustedLocalDreamMemoryRelayHttpServer,
  trustedLocalDreamMemoryRelayHttpConfigFromEnv,
  trustedLocalDreamMemoryRelayReadinessReceipt,
} from "../src/cartridges/dream-memory-fabric/trusted-local-relay-http.ts";

const isMain = (): boolean =>
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

const start = async (): Promise<void> => {
  const config = trustedLocalDreamMemoryRelayHttpConfigFromEnv(process.env);
  const relay = await startTrustedLocalDreamMemoryRelayHttpServer(config);
  const receipt = trustedLocalDreamMemoryRelayReadinessReceipt({ config });

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
                : "Trusted local Dream relay failed to start.",
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
