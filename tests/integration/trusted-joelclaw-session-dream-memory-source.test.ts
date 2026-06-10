import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Actor } from "../../src/app/domain/schemas.ts";
import { trustedJoelClawSessionMachineCoverageFor } from "../../src/cartridges/memory-fabric/trusted-joelclaw-session-source.ts";
import type { TrustedJoelClawSessionBridgeCommand } from "../../src/cartridges/memory-fabric/trusted-joelclaw-session-source.ts";
import { createTrustedLocalMemoryRetrievalAdapter } from "../../src/cartridges/memory-fabric/trusted-local-memory-retrieval.ts";

const timestamp = "2026-06-09T20:00:00.000Z";

const actor: Actor = {
  id: "actor:joelclaw-session-source-test",
  organizationId: "org:joelhooks",
  roleIds: ["dream.operator"],
  sessionId: "session:joelclaw-session-source-test",
  trustTier: "manual",
  type: "agent",
};

const indexSourceRoot = {
  authorityRoot: "joelclaw+index://sessions?machine=all&runtime=all",
  family: "agent-transcripts" as const,
  label: "JoelClaw session index",
  privacyTier: "private" as const,
  scope: {
    organizationId: "org:joelhooks",
  },
  sourceId: "source:agent-transcripts:joelclaw-index",
  sourceSystem: "joelclaw:session-index",
};

const indexHits = [
  {
    id: "chunk-1",
    machineId: "blaine",
    role: "assistant",
    runId: "run-1",
    sessionId: "session-1",
    snippets: [
      "Dream workflow session from /Users/joel/private with joel@example.com and abcdefghijklmnopqrstuvwxyz123456.",
    ],
    source: "typesense",
    startedAt: timestamp,
  },
  {
    id: "chunk-2",
    machineId: "flagg",
    role: "user",
    runId: "run-2",
    sessionId: "session-2",
    snippets: ["Dream workflow friction captured on flagg."],
    source: "typesense",
    startedAt: timestamp,
  },
  {
    id: "chunk-3",
    machineId: "blaine",
    role: "assistant",
    runId: "run-3",
    sessionId: "session-3",
    snippets: ["Dream workflow correction captured on blaine."],
    source: "typesense",
    startedAt: timestamp,
  },
];

const commandWithIndexHits =
  (commands: string[][]): TrustedJoelClawSessionBridgeCommand =>
  (input) => {
    commands.push([...input.args]);
    const query = input.args[2] ?? "";
    const shouldReturnHits = query.includes("dream");

    return Promise.resolve({
      stdout: JSON.stringify({
        ok: true,
        result: {
          hits: shouldReturnHits ? indexHits : [],
          typesense: {
            found: shouldReturnHits ? indexHits.length : 0,
            returned: shouldReturnHits ? indexHits.length : 0,
          },
        },
      }),
    });
  };

describe("trusted JoelClaw session Dream memory source", () => {
  it("searches the JoelClaw index, hydrates cached redacted receipts, and reports machine coverage as a caveat", async () => {
    const commands: string[][] = [];
    const adapter = createTrustedLocalMemoryRetrievalAdapter({
      now: () => timestamp,
      sessionBridgeCommand: commandWithIndexHits(commands),
      sourceRoots: [indexSourceRoot],
    });
    const search = await adapter.searchMemories({
      actor,
      maxHits: 3,
      query: "dream workflow",
      runId: "run:joelclaw-session-source-search-test",
      sourceFamilies: ["agent-transcripts"],
      workItemId: "work:joelclaw-session-source-search-test",
    });
    const searchReceipts =
      search.status === "ready"
        ? search.document.hits.flatMap((hit) => hit.receipts)
        : [];
    const receipt = searchReceipts.at(0);
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
      machineCoverage: trustedJoelClawSessionMachineCoverageFor(searchReceipts),
      rawEmailLeaked: serialized.includes("joel@example.com"),
      rawPathLeaked: serialized.includes("/Users/joel/private"),
      rawTokenLeaked: serialized.includes("abcdefghijklmnopqrstuvwxyz123456"),
      receiptMachineId: receipt?.machineId,
      receiptSourceId: receipt?.sourceId,
      redactedExcerpt:
        search.status === "ready"
          ? search.document.hits.at(0)?.redactedExcerpt
          : null,
      skippedSources:
        search.status === "ready" ? search.document.skippedSources : null,
    }).toStrictEqual({
      commandArgs: [
        "sessions",
        "search",
        "dream workflow",
        "--source",
        "typesense",
        "--machine",
        "all",
        "--runtime",
        "all",
        "--limit",
        "3",
      ],
      fullTranscriptReturned: false,
      hydratedCount: 1,
      machineCoverage: [
        { machineId: "blaine", receiptCount: 2 },
        { machineId: "flagg", receiptCount: 1 },
      ],
      rawEmailLeaked: false,
      rawPathLeaked: false,
      rawTokenLeaked: false,
      receiptMachineId: "blaine",
      receiptSourceId: indexSourceRoot.sourceId,
      redactedExcerpt:
        "Dream workflow session from [redacted-path] with [redacted-email] and [redacted-token].",
      skippedSources: [],
    });
  });

  it("never walks transcript file roots and reports the dead root as skipped", async () => {
    const transcriptRoot = await mkdtemp(
      join(tmpdir(), "joelclaw-transcript-root-")
    );

    try {
      await writeFile(
        join(transcriptRoot, "session.jsonl"),
        "dream workflow transcript that must never be file-walked",
        "utf-8"
      );

      const adapter = createTrustedLocalMemoryRetrievalAdapter({
        now: () => timestamp,
        sessionBridgeCommand: () =>
          Promise.resolve({
            stdout: JSON.stringify({
              ok: true,
              result: { hits: [] },
            }),
          }),
        sourceRoots: [
          {
            authorityRoot: transcriptRoot,
            family: "agent-transcripts",
            includeExtensions: [".jsonl"],
            label: "Legacy per-machine transcript root",
            privacyTier: "private",
            runtime: "pi",
            sourceId: "source:agent-transcripts:legacy-files",
            sourceSystem: "local:pi-transcripts",
          },
        ],
      });
      const search = await adapter.searchMemories({
        actor,
        maxHits: 3,
        query: "dream workflow transcript",
        runId: "run:joelclaw-session-source-file-root-test",
        sourceFamilies: ["agent-transcripts"],
        workItemId: "work:joelclaw-session-source-file-root-test",
      });

      expect({
        hitCount: search.status === "ready" ? search.document.hits.length : -1,
        skippedSources:
          search.status === "ready" ? search.document.skippedSources : null,
      }).toStrictEqual({
        hitCount: 0,
        skippedSources: [
          "source:agent-transcripts:legacy-files:transcript-file-roots-removed",
        ],
      });
    } finally {
      await rm(transcriptRoot, { force: true, recursive: true });
    }
  });

  it("reports an unavailable index as a skipped source instead of failing the search", async () => {
    const adapter = createTrustedLocalMemoryRetrievalAdapter({
      now: () => timestamp,
      sessionBridgeCommand: () =>
        Promise.resolve({
          stdout: JSON.stringify({
            ok: true,
            result: {
              hits: [],
              typesenseUnavailable:
                "Typesense session search failed (0): Unable to connect.",
            },
          }),
        }),
      sourceRoots: [indexSourceRoot],
    });
    const search = await adapter.searchMemories({
      actor,
      maxHits: 3,
      query: "dream workflow",
      runId: "run:joelclaw-session-source-unavailable-test",
      sourceFamilies: ["agent-transcripts"],
      workItemId: "work:joelclaw-session-source-unavailable-test",
    });

    expect({
      hitCount: search.status === "ready" ? search.document.hits.length : -1,
      skippedSources:
        search.status === "ready" ? search.document.skippedSources : null,
    }).toStrictEqual({
      hitCount: 0,
      skippedSources: [
        "source:agent-transcripts:joelclaw-index:joelclaw-index-unavailable",
      ],
    });
  });
});
