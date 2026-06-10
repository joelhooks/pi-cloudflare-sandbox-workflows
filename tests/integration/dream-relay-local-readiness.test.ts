import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { runDreamRelayLocalReadinessCli } from "../../scripts/workflow-app-dream-relay-local-readiness.ts";

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
};

describe("Dream relay local readiness", () => {
  it("boots from the local startup env and writes a redacted healthz proof", async () => {
    const repoRoot = await mkdtemp(resolve(tmpdir(), "dream-relay-ready-"));
    const startupEnvPath =
      ".wrangler/workflow-app/dream-relay/local-relay-startup-env.json";
    const receiptPath =
      ".wrangler/workflow-app/dream-relay/latest-local-readiness.json";
    const rawAuthorityRoot = "/private/tmp/dream-relay-readiness-source";
    const relayToken = "local-readiness-relay-token";
    const logs: string[] = [];

    await writeJson(resolve(repoRoot, startupEnvPath), {
      MEMORY_RELAY_SOURCE_ROOTS_JSON: JSON.stringify([
        {
          authorityRoot: rawAuthorityRoot,
          family: "agent-transcripts",
          includeExtensions: [".jsonl"],
          label: "Sensitive local transcripts",
          privacyTier: "private",
          runtime: "codex",
          sourceId: "source:agent-transcripts:codex:readiness",
          sourceSystem: "codex",
        },
      ]),
      MEMORY_RELAY_TOKEN: relayToken,
    });

    const receipt = await runDreamRelayLocalReadinessCli({
      argv: [
        `--local-relay-startup-env-path=${startupEnvPath}`,
        `--out=${receiptPath}`,
      ],
      log: (message) => {
        logs.push(message);
      },
      now: () => "2026-06-10T10:30:00.000Z",
      processEnv: {},
      repoRoot,
    });
    const writtenReceipt = await readFile(
      resolve(repoRoot, receiptPath),
      "utf-8"
    );
    const serializedLogs = logs.join("\n");

    expect({
      healthzStatus: receipt.healthz.status,
      rawCredentialsReturned: receipt.rawCredentialsReturned,
      rawPathsReturned: receipt.rawPathsReturned,
      sourceRootCount: receipt.sourceRootCount,
      status: receipt.status,
      supportedOperationCount: receipt.healthz.supportedOperationCount,
      tokenConfigured: receipt.tokenConfigured,
      usedConfiguredPort: receipt.usedConfiguredPort,
    }).toStrictEqual({
      healthzStatus: "passed",
      rawCredentialsReturned: false,
      rawPathsReturned: false,
      sourceRootCount: 1,
      status: "passed",
      supportedOperationCount: 6,
      tokenConfigured: true,
      usedConfiguredPort: false,
    });
    expect(writtenReceipt).not.toContain(rawAuthorityRoot);
    expect(writtenReceipt).not.toContain(relayToken);
    expect(serializedLogs).not.toContain(rawAuthorityRoot);
    expect(serializedLogs).not.toContain(relayToken);
  });
});
