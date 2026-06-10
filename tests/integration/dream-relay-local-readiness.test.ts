import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { runMemoryRelayLocalReadinessCli } from "../../scripts/workflow-app-relay-local-readiness.ts";
import { dreamTranscriptReviewSourceProfile } from "../../src/cartridges/memory-fabric/source-profile.ts";

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
};

describe("Memory relay local readiness", () => {
  it("boots from the local startup env and writes a redacted healthz proof", async () => {
    const repoRoot = await mkdtemp(resolve(tmpdir(), "dream-relay-ready-"));
    const startupEnvPath =
      ".wrangler/workflow-app/memory-relay/local-relay-startup-env.json";
    const receiptPath =
      ".wrangler/workflow-app/memory-relay/latest-local-readiness.json";
    const rawAuthorityRoot = "/private/tmp/dream-relay-readiness-source";
    const relayToken = "local-readiness-relay-token";
    const logs: string[] = [];

    await writeJson(resolve(repoRoot, startupEnvPath), {
      MEMORY_RELAY_SOURCE_ROOTS_JSON: JSON.stringify([
        {
          authorityRoot: "joelclaw+index://sessions?machine=all&runtime=all",
          family: "agent-transcripts",
          label: "JoelClaw session index",
          privacyTier: "private",
          sourceId: "source:agent-transcripts:joelclaw-index:readiness",
          sourceSystem: "joelclaw:session-index",
        },
        {
          authorityRoot: rawAuthorityRoot,
          family: "brain",
          includeExtensions: [".svx"],
          label: "Sensitive local brain notes",
          privacyTier: "private",
          sourceId: "source:brain:readiness",
          sourceSystem: "local:brain",
        },
      ]),
      MEMORY_RELAY_TOKEN: relayToken,
    });

    const receipt = await runMemoryRelayLocalReadinessCli({
      argv: [
        "--profile",
        dreamTranscriptReviewSourceProfile.profileId,
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
      sourceRootCount: 2,
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
