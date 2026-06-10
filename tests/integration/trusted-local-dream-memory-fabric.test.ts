import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Actor } from "../../src/app/domain/schemas.ts";
import type { DreamMemoryFabricResult } from "../../src/app/workflow-nodes/dream-memory-fabric.ts";
import { createTrustedLocalDreamMemoryFabricAdapter } from "../../src/cartridges/dream-memory-fabric/trusted-local-memory-fabric.ts";

const timestamp = "2026-06-09T19:45:00.000Z";

const actor: Actor = {
  id: "actor:trusted-local-dream",
  organizationId: "org:joelhooks",
  roleIds: ["dream.operator"],
  sessionId: "session:trusted-local-dream-test",
  trustTier: "reviewed",
  type: "agent",
};

const readyDocument = <TDocument>(
  result: DreamMemoryFabricResult<TDocument>
): TDocument => {
  if (result.status === "blocked") {
    throw new Error(result.blocker.message);
  }

  return result.document;
};

const writeTextFile = async (input: {
  readonly content: string;
  readonly path: string;
}): Promise<void> => {
  await writeFile(input.path, input.content, "utf-8");
};

describe("trusted local Dream memory fabric", () => {
  it("inventories local authority roots with redacted locators and plans recovery backfills for stale indexes", async () => {
    const root = await mkdtemp(join(tmpdir(), "trusted-dream-memory-"));

    try {
      const brainRoot = join(root, "brain");
      const cloudflareDerivedRoot = join(root, "cloudflare-derived");
      const cloudflareRoot = join(root, "cloudflare");
      const codexDerivedRoot = join(root, "codex-derived");
      const codexRoot = join(root, "codex");
      const piDerivedRoot = join(root, "pi-derived");
      const piRoot = join(root, "pi");
      const repoOutputsDerivedRoot = join(root, "repo-outputs-derived");
      const repoOutputsRoot = join(root, "repo-outputs");
      const rawRoots = [
        brainRoot,
        cloudflareDerivedRoot,
        cloudflareRoot,
        codexDerivedRoot,
        codexRoot,
        piDerivedRoot,
        piRoot,
        repoOutputsDerivedRoot,
        repoOutputsRoot,
        root,
      ];

      await mkdir(brainRoot, { recursive: true });
      await mkdir(cloudflareDerivedRoot, { recursive: true });
      await mkdir(cloudflareRoot, { recursive: true });
      await mkdir(codexDerivedRoot, { recursive: true });
      await mkdir(codexRoot, { recursive: true });
      await mkdir(piDerivedRoot, { recursive: true });
      await mkdir(piRoot, { recursive: true });
      await mkdir(repoOutputsDerivedRoot, { recursive: true });
      await mkdir(repoOutputsRoot, { recursive: true });
      await writeTextFile({
        content: "codex session transcript",
        path: join(codexRoot, "codex-session.jsonl"),
      });
      await writeTextFile({
        content: "cloudflare run receipt",
        path: join(cloudflareDerivedRoot, "cloudflare-run.json"),
      });
      await writeTextFile({
        content: "cloudflare run transcript",
        path: join(cloudflareRoot, "cloudflare-run.json"),
      });
      await writeTextFile({
        content: "project brain update",
        path: join(brainRoot, "dream-memory.svx"),
      });
      await writeTextFile({
        content: "pi derived row 1",
        path: join(piDerivedRoot, "pi-session-1.json"),
      });
      await writeTextFile({
        content: "pi derived row 2",
        path: join(piDerivedRoot, "pi-session-2.json"),
      });
      await writeTextFile({
        content: "pi session transcript 1",
        path: join(piRoot, "pi-session-1.jsonl"),
      });
      await writeTextFile({
        content: "pi session transcript 2",
        path: join(piRoot, "pi-session-2.jsonl"),
      });
      await writeTextFile({
        content: "dream workflow report canon",
        path: join(repoOutputsRoot, "dream-report-canon.md"),
      });
      await writeTextFile({
        content: "dream workflow report canon derived view",
        path: join(repoOutputsDerivedRoot, "dream-report-canon.json"),
      });
      const adapter = createTrustedLocalDreamMemoryFabricAdapter({
        now: () => timestamp,
        sourceRoots: [
          {
            authorityRoot: piRoot,
            derivedIndexes: [
              {
                indexId: "index:pi:qmd",
                indexKind: "qmd",
                root: piDerivedRoot,
              },
            ],
            family: "agent-transcripts",
            includeExtensions: [".jsonl"],
            label: "Pi transcripts",
            privacyTier: "private",
            runtime: "pi",
            sourceId: "source:pi-transcripts",
            sourceSystem: "local:pi-transcripts",
          },
          {
            authorityRoot: codexRoot,
            derivedIndexes: [
              {
                indexId: "index:codex:qmd",
                indexKind: "qmd",
                root: codexDerivedRoot,
              },
            ],
            family: "agent-transcripts",
            includeExtensions: [".jsonl"],
            label: "Codex transcripts",
            privacyTier: "private",
            runtime: "codex",
            sourceId: "source:codex-transcripts",
            sourceSystem: "local:codex-transcripts",
          },
          {
            authorityRoot: brainRoot,
            family: "brain",
            includeExtensions: [".svx"],
            label: "Project Brain notes",
            privacyTier: "private",
            sourceId: "source:project-brain",
            sourceSystem: "local:brain",
          },
          {
            authorityRoot: cloudflareRoot,
            derivedIndexes: [
              {
                indexId: "index:cloudflare:view",
                indexKind: "view",
                root: cloudflareDerivedRoot,
              },
            ],
            family: "cloudflare-runs",
            includeExtensions: [".json"],
            label: "Cloudflare run artifacts",
            privacyTier: "private",
            runtime: "cloudflare",
            sourceId: "source:cloudflare-runs",
            sourceSystem: "local:cloudflare-runs",
          },
          {
            authorityRoot: repoOutputsRoot,
            derivedIndexes: [
              {
                indexId: "index:repo-outputs:view",
                indexKind: "view",
                root: repoOutputsDerivedRoot,
              },
            ],
            family: "repo-outputs",
            includeExtensions: [".md"],
            label: "Repo output artifacts",
            privacyTier: "private",
            sourceId: "source:repo-outputs",
            sourceSystem: "local:repo-outputs",
          },
        ],
      });

      const inventory = readyDocument(
        await adapter.inventorySources({
          actor,
          requiredRuntimes: ["pi", "codex", "claude", "cloudflare"],
          runId: "run:trusted-local-dream",
          sourceFamiliesExpected: [
            "agent-transcripts",
            "brain",
            "cloudflare-runs",
            "repo-outputs",
          ],
          workItemId: "work:trusted-local-dream",
        })
      );
      const health = readyDocument(
        await adapter.checkSourceHealth({
          actor,
          inventory,
          inventoryRef:
            "artifact://trusted-local-dream/run/source-inventory.json",
          runId: "run:trusted-local-dream",
          workItemId: "work:trusted-local-dream",
        })
      );
      const plan = readyDocument(
        await adapter.planBackfill({
          actor,
          health,
          healthRef: "artifact://trusted-local-dream/run/source-health.json",
          inventory,
          inventoryRef:
            "artifact://trusted-local-dream/run/source-inventory.json",
          runId: "run:trusted-local-dream",
          workItemId: "work:trusted-local-dream",
        })
      );
      const run = readyDocument(
        await adapter.runBackfill({
          actor,
          plan,
          planRef: "artifact://trusted-local-dream/run/backfill-plan.json",
          runId: "run:trusted-local-dream",
          workItemId: "work:trusted-local-dream",
        })
      );
      const serialized = JSON.stringify({ health, inventory, plan, run });

      expect({
        backfillActions: plan.actions.map((action) => action.actionId),
        backfillRunPlanRef: run.planRef.artifactRef,
        backfillRunStatuses: run.actionResults.map((action) => action.status),
        captureFixes: plan.captureFixes.map((fix) => fix.fixId),
        codexCoverage: inventory.runtimeCoverage.find(
          (coverage) => coverage.runtime === "codex"
        )?.status,
        healthStatus: health.status,
        piCount: inventory.sources.find(
          (source) => source.sourceId === "source:pi-transcripts"
        )?.authority.count,
        rawPathLeaked: rawRoots.some((rawRoot) => serialized.includes(rawRoot)),
        relayPort: inventory.sources.at(0)?.adapter.port,
        requiredRuntimeStatuses: inventory.runtimeCoverage.map(
          (coverage) => `${coverage.runtime}:${coverage.status}`
        ),
        sourceCount: inventory.sources.length,
        sourceLocators: inventory.sources.map(
          (source) => source.authority.redactedLocator
        ),
        status: plan.status,
      }).toStrictEqual({
        backfillActions: [
          "backfill:source:codex-transcripts:index:codex:qmd",
          "backfill:source:project-brain:source:project-brain:missing-derived-index",
        ],
        backfillRunPlanRef:
          "artifact://trusted-local-dream/run/backfill-plan.json",
        backfillRunStatuses: ["skipped", "skipped"],
        captureFixes: ["capture:claude:trusted-local-relay"],
        codexCoverage: "captured",
        healthStatus: "degraded",
        piCount: 2,
        rawPathLeaked: false,
        relayPort: "TrustedLocalDreamMemoryFabricPort",
        requiredRuntimeStatuses: [
          "pi:captured",
          "codex:captured",
          "claude:missing",
          "cloudflare:captured",
        ],
        sourceCount: 5,
        sourceLocators: [
          "redacted://dream-source/source%3Api-transcripts",
          "redacted://dream-source/source%3Acodex-transcripts",
          "redacted://dream-source/source%3Aproject-brain",
          "redacted://dream-source/source%3Acloudflare-runs",
          "redacted://dream-source/source%3Arepo-outputs",
        ],
        status: "backfill-required",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
