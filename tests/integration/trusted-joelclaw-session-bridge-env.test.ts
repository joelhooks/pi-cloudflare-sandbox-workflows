import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  JoelClawSessionBridgeError,
  loadJoelClawBridgeEnv,
  parseJoelClawSystemBusEnv,
  searchTrustedJoelClawSessionSource,
  trustedJoelClawSessionSourceForAuthorityRoot,
} from "../../src/cartridges/memory-fabric/trusted-joelclaw-session-source.ts";
import type { TrustedJoelClawSessionBridgeCommand } from "../../src/cartridges/memory-fabric/trusted-joelclaw-session-source.ts";

const timestamp = "2026-06-11T20:00:00.000Z";

const indexSource = trustedJoelClawSessionSourceForAuthorityRoot(
  "joelclaw+index://sessions?machine=all&runtime=all"
);

if (indexSource === null) {
  throw new Error("expected the JoelClaw index authority root to parse");
}

const sourceId = "source:agent-transcripts:joelclaw-index";

const cliNotFoundCommand: TrustedJoelClawSessionBridgeCommand = () =>
  Promise.reject(
    new JoelClawSessionBridgeError(
      "joelclaw-cli-not-found",
      "joelclaw CLI invocation failed at /Users/joel/secret/path"
    )
  );

const unparseableCommand: TrustedJoelClawSessionBridgeCommand = () =>
  Promise.resolve({ stdout: "not json at all" });

const SYSTEM_BUS_ENV_FIXTURE = [
  "# system bus env (fixture)",
  "",
  "export TYPESENSE_URL=http://panda:8108",
  'TYPESENSE_API_KEY="fixture-typesense-key"',
  "JOELCLAW_CENTRAL_URL='http://panda:7700'",
  "UNRELATED_SECRET=must-not-leak-into-child-env",
].join("\n");

describe("JoelClaw session bridge env loading", () => {
  it("parses the system-bus.env allowlist and ignores unrelated secrets", () => {
    expect(parseJoelClawSystemBusEnv(SYSTEM_BUS_ENV_FIXTURE)).toStrictEqual({
      JOELCLAW_CENTRAL_URL: "http://panda:7700",
      TYPESENSE_API_KEY: "fixture-typesense-key",
      TYPESENSE_URL: "http://panda:8108",
    });
  });

  it("merges system-bus.env over process.env from a temp file fixture", async () => {
    const dir = await mkdtemp(join(tmpdir(), "joelclaw-system-bus-env-"));
    const envPath = join(dir, "system-bus.env");

    try {
      await writeFile(envPath, SYSTEM_BUS_ENV_FIXTURE, "utf-8");

      const merged = loadJoelClawBridgeEnv({
        envPath,
        processEnv: {
          PATH: "/usr/bin",
          TYPESENSE_URL: "http://localhost:8108",
        },
      });

      expect({
        keptProcessEnv: merged["PATH"],
        leakedUnrelated: "UNRELATED_SECRET" in merged,
        overrodeTypesenseUrl: merged["TYPESENSE_URL"],
        suppliedApiKey: merged["TYPESENSE_API_KEY"],
        suppliedCentralUrl: merged["JOELCLAW_CENTRAL_URL"],
      }).toStrictEqual({
        keptProcessEnv: "/usr/bin",
        leakedUnrelated: false,
        overrodeTypesenseUrl: "http://panda:8108",
        suppliedApiKey: "fixture-typesense-key",
        suppliedCentralUrl: "http://panda:7700",
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("falls back to process.env unchanged when system-bus.env is absent", () => {
    const merged = loadJoelClawBridgeEnv({
      envPath: join(tmpdir(), "joelclaw-definitely-missing-env-file.env"),
      processEnv: { ONLY: "process-env" },
    });

    expect(merged).toStrictEqual({ ONLY: "process-env" });
  });

  it("resolves agent-transcripts receipts through an injected command", async () => {
    const seenArgs: string[][] = [];
    const command: TrustedJoelClawSessionBridgeCommand = (input) => {
      seenArgs.push([...input.args]);

      return Promise.resolve({
        stdout: JSON.stringify({
          ok: true,
          result: {
            hits: [
              {
                id: "chunk-1",
                machineId: "blaine",
                role: "assistant",
                runId: "run-1",
                sessionId: "session-1",
                snippets: ["Dream workflow session captured on blaine."],
                source: "typesense",
                startedAt: timestamp,
              },
            ],
            typesense: { found: 1, returned: 1 },
          },
        }),
      });
    };

    const result = await searchTrustedJoelClawSessionSource({
      command,
      family: "agent-transcripts",
      label: "JoelClaw session index",
      maxHits: 3,
      now: timestamp,
      query: "dream workflow",
      source: indexSource,
      sourceId,
    });

    expect({
      commandInvoked: seenArgs.length,
      hitCount: result.hits.length,
      receiptFamily: result.hits.at(0)?.receipts.at(0)?.family,
      receiptMachineId: result.hits.at(0)?.receipts.at(0)?.machineId,
      receiptSourceId: result.hits.at(0)?.receipts.at(0)?.sourceId,
      skippedSources: result.skippedSources,
    }).toStrictEqual({
      commandInvoked: 1,
      hitCount: 1,
      receiptFamily: "agent-transcripts",
      receiptMachineId: "blaine",
      receiptSourceId: sourceId,
      skippedSources: [],
    });
  });

  it("enriches the skip reason with a redacted cause when the CLI is missing", async () => {
    const result = await searchTrustedJoelClawSessionSource({
      command: cliNotFoundCommand,
      family: "agent-transcripts",
      label: "JoelClaw session index",
      maxHits: 3,
      now: timestamp,
      query: "dream workflow",
      source: indexSource,
      sourceId,
    });

    const skip = result.skippedSources.at(0) ?? "";

    expect({
      hitCount: result.hits.length,
      leaksPath: skip.includes("/Users/joel"),
      skip,
    }).toStrictEqual({
      hitCount: 0,
      leaksPath: false,
      skip: `${sourceId}:joelclaw-cli-not-found`,
    });
  });

  it("categorizes unparseable CLI stdout as a distinct redacted skip cause", async () => {
    const result = await searchTrustedJoelClawSessionSource({
      command: unparseableCommand,
      family: "agent-transcripts",
      label: "JoelClaw session index",
      maxHits: 3,
      now: timestamp,
      query: "dream workflow",
      source: indexSource,
      sourceId,
    });

    expect(result.skippedSources).toStrictEqual([
      `${sourceId}:joelclaw-output-unparseable`,
    ]);
  });
});
