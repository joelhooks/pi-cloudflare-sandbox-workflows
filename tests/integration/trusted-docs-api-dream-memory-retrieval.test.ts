import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTrustedLocalMemoryRetrievalAdapter } from "../../src/cartridges/memory-fabric/trusted-local-memory-retrieval.ts";

const urlForFetchInput = (input: Parameters<typeof fetch>[0]): string => {
  if (input instanceof Request) {
    const { url } = input;
    return url;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  return input;
};

const actor = {
  id: "actor:docs-api-dream-test",
  organizationId: "org:joelhooks",
  roleIds: ["tester"],
  sessionId: "session:docs-api-dream-test",
  trustTier: "manual" as const,
  type: "agent" as const,
};

describe("trusted docs API Dream memory retrieval", () => {
  it("searches and hydrates docs/pdf-brain through redacted relay receipts", async () => {
    const requestedUrls: string[] = [];
    const fetcher: typeof fetch = (input) => {
      const url = urlForFetchInput(input);
      requestedUrls.push(url);
      if (url.includes("/search?")) {
        return Promise.resolve(
          Response.json({
            ok: true,
            result: {
              hits: [
                {
                  docId: "2502-12110-fec32b521c4a",
                  headingPath: ["A-Mem", "3.4 Retrieve Relative Memory"],
                  id: "2502-12110-fec32b521c4a:s24:n0",
                  score: "42",
                  snippet:
                    "context-aware <mark>memory</mark> retrieval for an agent",
                  title: "A-Mem",
                },
              ],
            },
          })
        );
      }

      return Promise.resolve(
        Response.json({
          ok: true,
          result: {
            contentPreview:
              "In each interaction, A-Mem performs context-aware memory retrieval.",
            doc_id: "2502-12110-fec32b521c4a",
            heading_path: ["A-Mem", "3.4 Retrieve Relative Memory"],
            id: "2502-12110-fec32b521c4a:s24:n0",
            title: "A-Mem",
          },
        })
      );
    };
    const adapter = createTrustedLocalMemoryRetrievalAdapter({
      docsApi: {
        baseUrl: "https://joelclaw.com/api/docs",
        fetch: fetcher,
      },
      now: () => "2026-06-09T10:00:00.000Z",
      sourceRoots: [],
    });
    const search = await adapter.searchMemories({
      actor,
      maxHits: 3,
      query: "agent memory retrieval",
      runId: "run:docs-api-dream-test",
      sourceFamilies: ["docs-pdf-brain"],
      workItemId: "work:docs-api-dream-test",
    });
    const receipt =
      search.status === "ready"
        ? search.document.hits[0]?.receipts[0]
        : undefined;
    const hydration =
      receipt === undefined
        ? null
        : await adapter.hydrateMemories({
            actor,
            receipts: [receipt],
            runId: "run:docs-api-dream-test",
            workItemId: "work:docs-api-dream-test",
          });

    expect({
      family:
        search.status === "ready"
          ? search.document.hits[0]?.receipts[0]?.family
          : null,
      hydrated:
        hydration?.status === "ready"
          ? hydration.document.hydrated.length
          : null,
      markTagLeaked:
        search.status === "ready"
          ? JSON.stringify(search.document).includes("<mark>")
          : true,
      redactedLocator:
        search.status === "ready"
          ? search.document.hits[0]?.receipts[0]?.redactedLocator
          : null,
      requestedChunk: requestedUrls.some((url) => url.includes("/chunks/")),
      requestedSearch: requestedUrls.some((url) => url.includes("/search?")),
      sourceId:
        search.status === "ready"
          ? search.document.hits[0]?.receipts[0]?.sourceId
          : null,
    }).toStrictEqual({
      family: "docs-pdf-brain",
      hydrated: 1,
      markTagLeaked: false,
      redactedLocator:
        "redacted://docs-api/chunks/2502-12110-fec32b521c4a%3As24%3An0",
      requestedChunk: true,
      requestedSearch: true,
      sourceId: "source:docs-pdf-brain:joelclaw-api",
    });
  });

  it("keeps docs/pdf-brain from monopolizing mixed Dream retrieval", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "dream-docs-balance-"));
    try {
      const brainRoot = join(tempRoot, "brain");
      await mkdir(brainRoot, { recursive: true });
      await writeFile(
        join(brainRoot, "decision.md"),
        "brain note: memory retrieval for dynamic dream workflow design.",
        "utf-8"
      );

      const fetcher: typeof fetch = (input) => {
        const url = urlForFetchInput(input);
        if (!url.includes("/search?")) {
          return Promise.resolve(Response.json({ ok: false }, { status: 404 }));
        }

        return Promise.resolve(
          Response.json({
            ok: true,
            result: {
              hits: [1, 2, 3, 4].map((index) => ({
                docId: `docs-${index}`,
                headingPath: ["Docs", `Section ${index}`],
                id: `docs-${index}:s1:n0`,
                score: "1000",
                snippet: "docs memory retrieval dream workflow",
                title: `Docs ${index}`,
              })),
            },
          })
        );
      };
      const adapter = createTrustedLocalMemoryRetrievalAdapter({
        docsApi: {
          baseUrl: "https://joelclaw.com/api/docs",
          fetch: fetcher,
        },
        now: () => "2026-06-09T10:00:00.000Z",
        sessionBridgeCommand: () =>
          Promise.resolve({
            stdout: JSON.stringify({
              ok: true,
              result: {
                hits: [
                  {
                    id: "chunk-1",
                    machineId: "blaine",
                    role: "assistant",
                    sessionId: "session-1",
                    snippets: [
                      "codex transcript: agent memory retrieval dream workflow relay.",
                    ],
                    source: "typesense",
                    startedAt: "2026-06-09T09:00:00.000Z",
                  },
                ],
                typesense: { found: 1, returned: 1 },
              },
            }),
          }),
        sourceRoots: [
          {
            authorityRoot: "joelclaw+index://sessions?machine=all",
            family: "agent-transcripts",
            label: "JoelClaw session index",
            privacyTier: "private",
            sourceId: "source:test-agent-transcripts",
            sourceSystem: "joelclaw:session-index",
          },
          {
            authorityRoot: brainRoot,
            family: "brain",
            includeExtensions: [".md"],
            label: "Brain notes",
            privacyTier: "private",
            sourceId: "source:test-brain",
            sourceSystem: "brain",
          },
        ],
      });

      const search = await adapter.searchMemories({
        actor,
        maxHits: 4,
        query: "agent memory retrieval dream workflow",
        runId: "run:docs-api-balance-test",
        sourceFamilies: ["agent-transcripts", "brain", "docs-pdf-brain"],
        workItemId: "work:docs-api-balance-test",
      });
      const families =
        search.status === "ready"
          ? search.document.hits.map((hit) => hit.receipts.at(0)?.family)
          : [];

      expect(families).toStrictEqual([
        "agent-transcripts",
        "brain",
        "docs-pdf-brain",
        "docs-pdf-brain",
      ]);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});
