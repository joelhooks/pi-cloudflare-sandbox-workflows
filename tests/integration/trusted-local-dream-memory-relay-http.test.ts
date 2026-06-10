import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Actor } from "../../src/app/domain/schemas.ts";
import {
  DreamCaptureReceiptDocumentSchema,
  DreamCorrelationGraphDocumentSchema,
  DreamHydrationDocumentSchema,
  DreamMemoryRelayRequestEnvelopeSchema,
  DreamMemorySearchDocumentSchema,
  dreamMemoryRelayResponseEnvelopeSchema,
} from "../../src/cartridges/dream-memory-fabric/schemas.ts";
import type {
  DreamMemoryRelayOperation,
  DreamSourceFamily,
} from "../../src/cartridges/dream-memory-fabric/schemas.ts";
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
  if (operation === "capture-run") {
    return "/memory/capture/run";
  }

  if (operation === "capture-artifact") {
    return "/memory/capture/artifact";
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
      const cloudflareRoot = join(root, "cloudflare");
      const codexRoot = join(root, "codex");
      const piRoot = join(root, "pi");
      const repoOutputsRoot = join(root, "repo-outputs");
      const rawRoots = [
        brainRoot,
        cloudflareRoot,
        codexRoot,
        piRoot,
        repoOutputsRoot,
        root,
      ];

      await mkdir(brainRoot, { recursive: true });
      await mkdir(cloudflareRoot, { recursive: true });
      await mkdir(codexRoot, { recursive: true });
      await mkdir(piRoot, { recursive: true });
      await mkdir(repoOutputsRoot, { recursive: true });
      await writeTextFile({
        content: "codex session transcript",
        path: join(codexRoot, "codex-session.jsonl"),
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
      const relay = await startTrustedLocalDreamMemoryRelayHttpServer({
        expectedBearerToken: relayToken,
        host: "127.0.0.1",
        memoryFabric: {
          maxFilesPerSource: 100,
          sourceRoots: [
            {
              authorityRoot: piRoot,
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
        const captureRunJson = await postRelay({
          allowedSourceFamilies: ["agent-transcripts", "cloudflare-runs"],
          operation: "capture-run",
          payload: {
            actor,
            readability: "actor-private",
            runId: "run:trusted-local-relay-http",
            sourceFamilies: ["agent-transcripts", "cloudflare-runs"],
            sourceSystem: "cloudflare-workflow-run",
            targetRunId: "run:trusted-local-relay-http",
            workItemId: "work:trusted-local-relay-http",
          },
          url: relay.url,
        });
        const captureRunEnvelope = dreamMemoryRelayResponseEnvelopeSchema(
          DreamCaptureReceiptDocumentSchema
        ).parse(captureRunJson);
        const captureArtifactJson = await postRelay({
          allowedSourceFamilies: ["repo-outputs", "cloudflare-runs"],
          operation: "capture-artifact",
          payload: {
            actor,
            capturedRef: {
              artifactRef:
                "artifact://trusted-local-relay-http/dream/hitl-report.json",
              hash: "b".repeat(64),
              mediaType: "application/json",
            },
            readability: "actor-private",
            runId: "run:trusted-local-relay-http",
            sourceFamilies: ["repo-outputs", "cloudflare-runs"],
            sourceSystem: "cloudflare-artifacts",
            workItemId: "work:trusted-local-relay-http",
          },
          url: relay.url,
        });
        const captureArtifactEnvelope = dreamMemoryRelayResponseEnvelopeSchema(
          DreamCaptureReceiptDocumentSchema
        ).parse(captureArtifactJson);
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
          captureArtifact: captureArtifactJson,
          captureRun: captureRunJson,
          correlation: correlationJson,
          healthz: readiness,
          hydration: hydrationJson,
          search: searchJson,
        });

        expect({
          captureArtifactKind: captureArtifactEnvelope.document.captureKind,
          captureRunCapturedRunId:
            captureRunEnvelope.document.captureKind === "run"
              ? captureRunEnvelope.document.capturedRunId
              : null,
          captureRunKind: captureRunEnvelope.document.captureKind,
          correlationEdgeCount: correlationEnvelope.document.edges.length,
          correlationSchema: correlationEnvelope.document.schemaVersion,
          deniedHealthStatus: deniedHealth.status,
          hydratedFullTranscriptReturned:
            hydrationEnvelope.document.hydrated.at(0)?.fullTranscriptReturned,
          operationCatalogCount: readiness.endpointCatalog.endpoints.length,
          rawPathLeaked: rawRoots.some((rawRoot) =>
            serialized.includes(rawRoot)
          ),
          readinessSchema: readiness.schemaVersion,
          responseLeaksToken: serialized.includes(relayToken),
          searchHitCount: searchEnvelope.document.hits.length,
          searchReceiptSourceId: receipt.sourceId,
          sourceRootCount: readiness.adapter.sourceRoots.length,
          supportedOperations: readiness.supportedOperations,
        }).toStrictEqual({
          captureArtifactKind: "artifact",
          captureRunCapturedRunId: "run:trusted-local-relay-http",
          captureRunKind: "run",
          correlationEdgeCount: 4,
          correlationSchema: "dream.correlation-graph.v1",
          deniedHealthStatus: 401,
          hydratedFullTranscriptReturned: false,
          operationCatalogCount: 6,
          rawPathLeaked: false,
          readinessSchema: "trusted.dream-memory-relay.readiness.v1",
          responseLeaksToken: false,
          searchHitCount: 1,
          searchReceiptSourceId: "source:codex-transcripts",
          sourceRootCount: 5,
          supportedOperations: [
            "capture-run",
            "capture-artifact",
            "signals",
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
