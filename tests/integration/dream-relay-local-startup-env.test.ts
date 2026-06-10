import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { runMemoryRelayLocalStartupEnvCli } from "../../scripts/workflow-app-relay-local-startup-env.ts";
import { dreamTranscriptReviewSourceProfile } from "../../src/cartridges/memory-fabric/source-profile.ts";

const StartupEnvArtifactSchema = z.record(z.string(), z.string());

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
};

const readStartupEnv = async (
  path: string
): Promise<Readonly<Record<string, string>>> =>
  StartupEnvArtifactSchema.parse(JSON.parse(await readFile(path, "utf-8")));

describe("Memory relay local startup env", () => {
  it("writes a private startup env artifact and redacted receipt", async () => {
    const repoRoot = await mkdtemp(resolve(tmpdir(), "dream-relay-env-"));
    const sourceRootsPath =
      ".wrangler/workflow-app/memory-relay/source-roots.json";
    const startupEnvPath =
      ".wrangler/workflow-app/memory-relay/local-relay-startup-env.json";
    const receiptPath =
      ".wrangler/workflow-app/memory-relay/latest-local-startup-env-receipt.json";
    const rawAuthorityRoot = "/private/tmp/dream-relay-sensitive-source";
    const logs: string[] = [];

    await writeJson(resolve(repoRoot, sourceRootsPath), [
      {
        authorityRoot: "joelclaw+index://sessions?machine=all&runtime=all",
        family: "agent-transcripts",
        label: "JoelClaw session index",
        privacyTier: "private",
        sourceId: "source:agent-transcripts:joelclaw-index:test",
        sourceSystem: "joelclaw:session-index",
      },
      {
        authorityRoot: rawAuthorityRoot,
        family: "brain",
        includeExtensions: [".svx"],
        label: "Sensitive local brain notes",
        privacyTier: "private",
        sourceId: "source:brain:test",
        sourceSystem: "local:brain",
      },
    ]);

    const receipt = await runMemoryRelayLocalStartupEnvCli({
      argv: [
        "--profile",
        dreamTranscriptReviewSourceProfile.profileId,
        `--source-roots=${sourceRootsPath}`,
        `--out=${startupEnvPath}`,
        `--receipt=${receiptPath}`,
      ],
      log: (message) => {
        logs.push(message);
      },
      now: () => "2026-06-10T09:30:00.000Z",
      processEnv: {},
      repoRoot,
    });
    const startupEnv = await readStartupEnv(resolve(repoRoot, startupEnvPath));
    const startupEnvStats = await stat(resolve(repoRoot, startupEnvPath));
    const startupEnvMode = startupEnvStats.mode % 0o1000;
    const serializedReceipt = JSON.stringify(receipt);
    const serializedLogs = logs.join("\n");

    expect({
      docsApiConfigured: receipt.docsApiConfigured,
      envContainsRawRoot:
        startupEnv["MEMORY_RELAY_SOURCE_ROOTS_JSON"]?.includes(
          rawAuthorityRoot
        ),
      receiptContainsRawRoot: serializedReceipt.includes(rawAuthorityRoot),
      receiptContainsToken: serializedReceipt.includes(
        startupEnv["MEMORY_RELAY_TOKEN"] ?? ""
      ),
      sourceRootCount: receipt.sourceRootCount,
      startupEnvMode,
      tokenGenerated: receipt.tokenGenerated,
      tokenLength: startupEnv["MEMORY_RELAY_TOKEN"]?.length,
      tokenPreserved: receipt.tokenPreserved,
    }).toStrictEqual({
      docsApiConfigured: true,
      envContainsRawRoot: true,
      receiptContainsRawRoot: false,
      receiptContainsToken: false,
      sourceRootCount: 2,
      startupEnvMode: 0o600,
      tokenGenerated: true,
      tokenLength: 64,
      tokenPreserved: false,
    });
    expect(serializedLogs).not.toContain(rawAuthorityRoot);
    expect(serializedLogs).not.toContain(startupEnv["MEMORY_RELAY_TOKEN"]);
  });

  it("preserves the existing token unless rotation is requested", async () => {
    const repoRoot = await mkdtemp(resolve(tmpdir(), "dream-relay-env-"));
    const sourceRootsPath =
      ".wrangler/workflow-app/memory-relay/source-roots.json";
    const startupEnvPath =
      ".wrangler/workflow-app/memory-relay/local-relay-startup-env.json";
    const existingToken = "existing-dream-relay-token";

    await writeJson(resolve(repoRoot, sourceRootsPath), [
      {
        authorityRoot: "/private/tmp/dream-relay-source",
        family: "brain",
        includeExtensions: [".svx"],
        label: "Sensitive local brain notes",
        privacyTier: "private",
        sourceId: "source:brain:test",
        sourceSystem: "local:brain",
      },
    ]);
    await writeJson(resolve(repoRoot, startupEnvPath), {
      MEMORY_RELAY_SOURCE_ROOTS_JSON: "[]",
      MEMORY_RELAY_TOKEN: existingToken,
    });

    const receipt = await runMemoryRelayLocalStartupEnvCli({
      argv: [
        "--profile",
        dreamTranscriptReviewSourceProfile.profileId,
        `--source-roots=${sourceRootsPath}`,
        `--out=${startupEnvPath}`,
      ],
      log: () => {},
      now: () => "2026-06-10T09:31:00.000Z",
      processEnv: {},
      repoRoot,
    });
    const startupEnv = await readStartupEnv(resolve(repoRoot, startupEnvPath));

    expect({
      token: startupEnv["MEMORY_RELAY_TOKEN"],
      tokenGenerated: receipt.tokenGenerated,
      tokenPreserved: receipt.tokenPreserved,
    }).toStrictEqual({
      token: existingToken,
      tokenGenerated: false,
      tokenPreserved: true,
    });
  });
});
