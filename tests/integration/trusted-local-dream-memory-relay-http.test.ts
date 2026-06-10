import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Actor } from "../../src/app/domain/schemas.ts";
import {
  DreamBackfillPlanDocumentSchema,
  DreamBackfillRunReceiptDocumentSchema,
  DreamCorrelationGraphDocumentSchema,
  DreamHydrationDocumentSchema,
  DreamMemoryRelayRequestEnvelopeSchema,
  DreamMemorySearchDocumentSchema,
  DreamSourceHealthDocumentSchema,
  DreamSourceInventoryDocumentSchema,
  dreamMemoryRelayResponseEnvelopeSchema,
} from "../../src/app/workflow-nodes/dream-memory-fabric-schemas.ts";
import type {
  DreamMemoryRelayOperation,
  DreamSourceFamily,
} from "../../src/app/workflow-nodes/dream-memory-fabric-schemas.ts";
import {
  startTrustedLocalDreamMemoryRelayHttpServer,
  TrustedLocalDreamMemoryRelayReadinessReceiptSchema,
} from "../../src/cartridges/dream-memory-fabric/trusted-local-relay-http.ts";

const actor: Actor = {
  id: "actor:trusted-local-relay-http",
  organizationId: "org:joelhooks",
  roleIds: ["dream.operator"],
  sessionId: "session:trusted-local-relay-http",
  trustTier: "reviewed",
  type: "agent",
};

const relayToken = "trusted-local-relay-token-never-returned";
const timestamp = "2026-06-09T20:30:00.000Z";

const operationPath = (operation: DreamMemoryRelayOperation): string => {
  if (operation === "inventory") {
    return "/memory/inventory";
  }

  if (operation === "source-health") {
    return "/memory/source-health";
  }

  if (operation === "backfill-plan") {
    return "/memory/backfill/plan";
  }

  if (operation === "backfill-run") {
    return "/memory/backfill/run";
  }

  return `/memory/${operation}`;
};

const relayEnvelope = (input: {
  readonly allowedSourceFamilies: readonly DreamSourceFamily[];
  readonly operation: DreamMemoryRelayOperation;
  readonly payload: unknown;
}) =>
  DreamMemoryRelayRequestEnvelopeSchema.parse({
    actor,
    allowedSourceFamilies: [...input.allowedSourceFamilies],
    budget: {
      maxFiles: 50,
      maxRows: 100,
      maxTokens: 10_000,
    },
    idempotencyKey: `trusted-local-relay-http:${input.operation}`,
    lease: {
      capability: "dream.memory.relay",
      leaseId: `lease:trusted-local-relay-http:${input.operation}`,
      redacted: true,
      secretRef: "secretref:dream-memory-relay",
    },
    operation: input.operation,
    payload: input.payload,
    purpose: `HTTP relay test ${input.operation}.`,
    redactionPolicy: {
      mode: "redacted-evidence",
      noCustomerDataInPublicArtifacts: true,
      noRawCredentials: true,
      noRawPrivatePaths: true,
      noRawTranscripts: true,
    },
    runId: "run:trusted-local-relay-http",
    schemaVersion: "dream.memory-relay.request.v1",
    scope: {
      organizationId: actor.organizationId,
      projectId: "project:system-dreaming",
    },
    timeWindow: {
      label: "all-time",
    },
    traceContext: {
      parentSpanId: "span:trusted-local-relay-http:workflow",
      redacted: true,
      spanId: `span:trusted-local-relay-http:${input.operation}`,
      traceId: "trace:trusted-local-relay-http",
    },
    workItemId: "work:trusted-local-relay-http",
  });

const postRelay = async (input: {
  readonly allowedSourceFamilies: readonly DreamSourceFamily[];
  readonly operation: DreamMemoryRelayOperation;
  readonly payload: unknown;
  readonly url: string;
}): Promise<unknown> => {
  const response = await fetch(
    `${input.url}${operationPath(input.operation)}`,
    {
      body: JSON.stringify(
        relayEnvelope({
          allowedSourceFamilies: input.allowedSourceFamilies,
          operation: input.operation,
          payload: input.payload,
        })
      ),
      headers: {
        authorization: `Bearer ${relayToken}`,
        "content-type": "application/json",
      },
      method: "POST",
    }
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text);
  }

  return JSON.parse(text);
};

const writeTextFile = async (input: {
  readonly content: string;
  readonly path: string;
}): Promise<void> => {
  await writeFile(input.path, input.content, "utf-8");
};

describe("trusted local Dream memory relay HTTP server", () => {
  it("serves auth-gated health and memory relay operations without leaking local authority paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "trusted-dream-relay-http-"));

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
        content: "cloudflare derived receipt",
        path: join(cloudflareDerivedRoot, "cloudflare-run.json"),
      });
      await writeTextFile({
        content: "cloudflare run artifact",
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
      const relay = await startTrustedLocalDreamMemoryRelayHttpServer({
        expectedBearerToken: relayToken,
        host: "127.0.0.1",
        memoryFabric: {
          maxFilesPerSource: 100,
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
        },
        now: () => timestamp,
        port: 0,
      });

      try {
        const deniedHealth = await fetch(`${relay.url}/healthz`);
        const healthResponse = await fetch(`${relay.url}/healthz`, {
          headers: {
            authorization: `Bearer ${relayToken}`,
          },
        });
        const healthText = await healthResponse.text();
        const readiness =
          TrustedLocalDreamMemoryRelayReadinessReceiptSchema.parse(
            JSON.parse(healthText)
          );
        const inventoryJson = await postRelay({
          allowedSourceFamilies: [
            "agent-transcripts",
            "brain",
            "cloudflare-runs",
            "repo-outputs",
          ],
          operation: "inventory",
          payload: {
            actor,
            requiredRuntimes: ["pi", "codex", "claude", "cloudflare"],
            runId: "run:trusted-local-relay-http",
            sourceFamiliesExpected: [
              "agent-transcripts",
              "brain",
              "cloudflare-runs",
              "repo-outputs",
            ],
            workItemId: "work:trusted-local-relay-http",
          },
          url: relay.url,
        });
        const inventoryEnvelope = dreamMemoryRelayResponseEnvelopeSchema(
          DreamSourceInventoryDocumentSchema
        ).parse(inventoryJson);
        const inventoryRef =
          "artifact://trusted-local-relay-http/source-inventory.json";
        const healthJson = await postRelay({
          allowedSourceFamilies: [
            "agent-transcripts",
            "brain",
            "cloudflare-runs",
            "repo-outputs",
          ],
          operation: "source-health",
          payload: {
            actor,
            inventory: inventoryEnvelope.document,
            inventoryRef,
            runId: "run:trusted-local-relay-http",
            workItemId: "work:trusted-local-relay-http",
          },
          url: relay.url,
        });
        const healthEnvelope = dreamMemoryRelayResponseEnvelopeSchema(
          DreamSourceHealthDocumentSchema
        ).parse(healthJson);
        const healthRef =
          "artifact://trusted-local-relay-http/source-health.json";
        const planJson = await postRelay({
          allowedSourceFamilies: [
            "agent-transcripts",
            "brain",
            "cloudflare-runs",
            "repo-outputs",
          ],
          operation: "backfill-plan",
          payload: {
            actor,
            health: healthEnvelope.document,
            healthRef,
            inventory: inventoryEnvelope.document,
            inventoryRef,
            runId: "run:trusted-local-relay-http",
            workItemId: "work:trusted-local-relay-http",
          },
          url: relay.url,
        });
        const planEnvelope = dreamMemoryRelayResponseEnvelopeSchema(
          DreamBackfillPlanDocumentSchema
        ).parse(planJson);
        const runJson = await postRelay({
          allowedSourceFamilies: [
            "agent-transcripts",
            "brain",
            "cloudflare-runs",
            "repo-outputs",
          ],
          operation: "backfill-run",
          payload: {
            actor,
            plan: planEnvelope.document,
            planRef: "artifact://trusted-local-relay-http/backfill-plan.json",
            runId: "run:trusted-local-relay-http",
            workItemId: "work:trusted-local-relay-http",
          },
          url: relay.url,
        });
        const runEnvelope = dreamMemoryRelayResponseEnvelopeSchema(
          DreamBackfillRunReceiptDocumentSchema
        ).parse(runJson);
        const searchJson = await postRelay({
          allowedSourceFamilies: ["agent-transcripts"],
          operation: "search",
          payload: {
            actor,
            maxHits: 1,
            query: "codex transcript",
            runId: "run:trusted-local-relay-http",
            sourceFamilies: ["agent-transcripts"],
            workItemId: "work:trusted-local-relay-http",
          },
          url: relay.url,
        });
        const searchEnvelope = dreamMemoryRelayResponseEnvelopeSchema(
          DreamMemorySearchDocumentSchema
        ).parse(searchJson);
        const receipt = searchEnvelope.document.hits.at(0)?.receipts.at(0);
        if (receipt === undefined) {
          throw new Error("Search did not return a receipt to hydrate.");
        }

        const hydrationJson = await postRelay({
          allowedSourceFamilies: ["agent-transcripts"],
          operation: "hydrate",
          payload: {
            actor,
            receipts: [receipt],
            runId: "run:trusted-local-relay-http",
            workItemId: "work:trusted-local-relay-http",
          },
          url: relay.url,
        });
        const hydrationEnvelope = dreamMemoryRelayResponseEnvelopeSchema(
          DreamHydrationDocumentSchema
        ).parse(hydrationJson);
        const correlationJson = await postRelay({
          allowedSourceFamilies: ["agent-transcripts"],
          operation: "correlate",
          payload: {
            actor,
            hydration: hydrationEnvelope.document,
            hydrationRef: "artifact://trusted-local-relay-http/hydration.json",
            runId: "run:trusted-local-relay-http",
            search: searchEnvelope.document,
            searchRef: "artifact://trusted-local-relay-http/memory-search.json",
            workItemId: "work:trusted-local-relay-http",
          },
          url: relay.url,
        });
        const correlationEnvelope = dreamMemoryRelayResponseEnvelopeSchema(
          DreamCorrelationGraphDocumentSchema
        ).parse(correlationJson);
        const serialized = JSON.stringify({
          correlation: correlationJson,
          health: healthJson,
          healthz: readiness,
          hydration: hydrationJson,
          inventory: inventoryJson,
          plan: planJson,
          run: runJson,
          search: searchJson,
        });

        expect({
          correlationEdgeCount: correlationEnvelope.document.edges.length,
          correlationSchema: correlationEnvelope.document.schemaVersion,
          deniedHealthStatus: deniedHealth.status,
          healthStatus: healthEnvelope.document.status,
          hydratedFullTranscriptReturned:
            hydrationEnvelope.document.hydrated.at(0)?.fullTranscriptReturned,
          operationCatalogCount: readiness.endpointCatalog.endpoints.length,
          planActions: planEnvelope.document.actions.map(
            (action) => action.actionId
          ),
          rawPathLeaked: rawRoots.some((rawRoot) =>
            serialized.includes(rawRoot)
          ),
          readinessSchema: readiness.schemaVersion,
          responseLeaksToken: serialized.includes(relayToken),
          runCaptureFixStatuses: runEnvelope.document.captureFixResults.map(
            (captureFix) => captureFix.status
          ),
          runStatuses: runEnvelope.document.actionResults.map(
            (action) => action.status
          ),
          runtimeCoverage: inventoryEnvelope.document.runtimeCoverage.map(
            (coverage) => `${coverage.runtime}:${coverage.status}`
          ),
          searchHitCount: searchEnvelope.document.hits.length,
          searchReceiptSourceId: receipt.sourceId,
          sourceRootCount: readiness.adapter.sourceRoots.length,
          supportedOperations: readiness.supportedOperations,
        }).toStrictEqual({
          correlationEdgeCount: 4,
          correlationSchema: "dream.correlation-graph.v1",
          deniedHealthStatus: 401,
          healthStatus: "degraded",
          hydratedFullTranscriptReturned: false,
          operationCatalogCount: 10,
          planActions: [
            "backfill:source:codex-transcripts:index:codex:qmd",
            "backfill:source:project-brain:source:project-brain:missing-derived-index",
          ],
          rawPathLeaked: false,
          readinessSchema: "trusted.dream-memory-relay.readiness.v1",
          responseLeaksToken: false,
          runCaptureFixStatuses: ["blocked"],
          runStatuses: ["skipped", "skipped"],
          runtimeCoverage: [
            "pi:captured",
            "codex:captured",
            "claude:missing",
            "cloudflare:captured",
          ],
          searchHitCount: 1,
          searchReceiptSourceId: "source:codex-transcripts",
          sourceRootCount: 5,
          supportedOperations: [
            "inventory",
            "source-health",
            "backfill-plan",
            "backfill-run",
            "search",
            "hydrate",
            "correlate",
          ],
        });
      } finally {
        await relay.close();
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
