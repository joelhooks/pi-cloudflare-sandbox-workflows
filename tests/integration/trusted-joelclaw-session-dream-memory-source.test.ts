import { describe, expect, it } from "vitest";

import type { Actor } from "../../src/app/domain/schemas.ts";
import type { TrustedJoelClawSessionBridgeCommand } from "../../src/cartridges/dream-memory-fabric/trusted-joelclaw-session-source.ts";
import { createTrustedLocalDreamMemoryRetrievalAdapter } from "../../src/cartridges/dream-memory-fabric/trusted-local-memory-retrieval.ts";

const timestamp = "2026-06-09T20:00:00.000Z";

const actor: Actor = {
  id: "actor:joelclaw-session-source-test",
  organizationId: "org:joelhooks",
  roleIds: ["dream.operator"],
  sessionId: "session:joelclaw-session-source-test",
  trustTier: "manual",
  type: "agent",
};

const remoteSourceRoot = {
  authorityRoot: "joelclaw+ssh://flagg?machine=flagg&runtime=all&maxFiles=37",
  family: "agent-transcripts" as const,
  label: "Flagg JoelClaw session bridge",
  privacyTier: "private" as const,
  scope: {
    machineId: "flagg",
    organizationId: "org:joelhooks",
  },
  sourceId: "source:agent-transcripts:joelclaw-ssh:flagg",
  sourceSystem: "joelclaw:sessions:ssh",
};

const commandWithSearchHits =
  (commands: string[][]): TrustedJoelClawSessionBridgeCommand =>
  (input) => {
    commands.push([...input.args]);
    const query = input.args[2] ?? "";
    const shouldReturnHit = query.includes("dream");

    return Promise.resolve({
      stdout: JSON.stringify({
        ok: true,
        result: {
          hits: shouldReturnHit
            ? [
                {
                  id: "hit-1",
                  machineId: "flagg",
                  role: "pi",
                  sessionId: "session-1",
                  snippets: [
                    "Dream workflow session from /Users/joel/private with joel@example.com and abcdefghijklmnopqrstuvwxyz123456.",
                  ],
                  source: "ssh",
                  startedAt: timestamp,
                },
              ]
            : [],
          ssh: {
            emittedHits: shouldReturnHit ? 1 : 0,
            found: shouldReturnHit ? 1 : 0,
            rawReturned: shouldReturnHit ? 1 : 0,
            searchedFiles: 37,
          },
        },
      }),
    });
  };

describe("trusted JoelClaw session Dream memory source", () => {
  it("searches joelclaw+ssh authority roots and hydrates cached redacted receipts", async () => {
    const commands: string[][] = [];
    const adapter = createTrustedLocalDreamMemoryRetrievalAdapter({
      now: () => timestamp,
      sessionBridgeCommand: commandWithSearchHits(commands),
      sourceRoots: [remoteSourceRoot],
    });
    const search = await adapter.searchMemories({
      actor,
      maxHits: 1,
      query: "dream workflow",
      runId: "run:joelclaw-session-source-search-test",
      sourceFamilies: ["agent-transcripts"],
      workItemId: "work:joelclaw-session-source-search-test",
    });
    const receipt =
      search.status === "ready"
        ? search.document.hits.at(0)?.receipts.at(0)
        : undefined;
    const hydration =
      receipt === undefined
        ? null
        : await adapter.hydrateMemories({
            actor,
            receipts: [receipt],
            runId: "run:joelclaw-session-source-search-test",
            workItemId: "work:joelclaw-session-source-search-test",
          });
    const serialized = JSON.stringify({
      hydration,
      search,
    });

    expect({
      commandArgs: commands[0],
      fullTranscriptReturned:
        hydration?.status === "ready"
          ? hydration.document.hydrated.at(0)?.fullTranscriptReturned
          : null,
      hydratedCount:
        hydration?.status === "ready" ? hydration.document.hydrated.length : 0,
      rawEmailLeaked: serialized.includes("joel@example.com"),
      rawPathLeaked: serialized.includes("/Users/joel/private"),
      rawTokenLeaked: serialized.includes("abcdefghijklmnopqrstuvwxyz123456"),
      receiptSourceId: receipt?.sourceId,
      redactedExcerpt:
        search.status === "ready"
          ? search.document.hits.at(0)?.redactedExcerpt
          : null,
    }).toStrictEqual({
      commandArgs: [
        "sessions",
        "search",
        "dream workflow",
        "--source",
        "ssh",
        "--machine",
        "flagg",
        "--ssh-target",
        "flagg",
        "--runtime",
        "all",
        "--limit",
        "1",
        "--max-files",
        "37",
      ],
      fullTranscriptReturned: false,
      hydratedCount: 1,
      rawEmailLeaked: false,
      rawPathLeaked: false,
      rawTokenLeaked: false,
      receiptSourceId: remoteSourceRoot.sourceId,
      redactedExcerpt:
        "Dream workflow session from [redacted-path] with [redacted-email] and [redacted-token].",
    });
  });
});
