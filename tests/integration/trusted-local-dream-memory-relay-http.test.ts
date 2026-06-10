import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Actor } from "../../src/app/domain/schemas.ts";
import type {
  MemoryRelayOperation,
  MemorySourceFamily,
} from "../../src/app/domain/source-profile.ts";
import {
  MemoryCaptureReceiptDocumentSchema,
  MemoryCorrelationGraphDocumentSchema,
  MemoryHydrationDocumentSchema,
  MemoryRelayRequestEnvelopeSchema,
  MemorySearchDocumentSchema,
  memoryRelayResponseEnvelopeSchema,
} from "../../src/cartridges/memory-fabric/schemas.ts";
import {
  startTrustedLocalMemoryRelayHttpServer,
  TrustedLocalMemoryRelayReadinessReceiptSchema,
} from "../../src/cartridges/memory-fabric/trusted-local-relay-http.ts";

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

const operationPath = (operation: MemoryRelayOperation): string => {
  if (operation === "capture-run") {
    return "/memory/capture/run";
  }

  if (operation === "capture-artifact") {
    return "/memory/capture/artifact";
  }

  return `/memory/${operation}`;
};

const relayEnvelope = (input: {
  readonly allowedSourceFamilies: readonly MemorySourceFamily[];
  readonly operation: MemoryRelayOperation;
  readonly payload: unknown;
}) =>
  MemoryRelayRequestEnvelopeSchema.parse({
    actor,
    allowedSourceFamilies: [...input.allowedSourceFamilies],
    budget: {
      maxFiles: 50,
      maxRows: 100,
      maxTokens: 10_000,
    },
    idempotencyKey: `trusted-local-relay-http:${input.operation}`,
    lease: {
      capability: "memory.relay",
      leaseId: `lease:trusted-local-relay-http:${input.operation}`,
      redacted: true,
      secretRef: "secretref:memory-relay",
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
    schemaVersion: "memory.relay.request.v1",
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
  readonly allowedSourceFamilies: readonly MemorySourceFamily[];
  readonly operation: MemoryRelayOperation;
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

describe("trusted local Memory relay HTTP server", () => {
  it("serves auth-gated health and memory relay operations without leaking local authority paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "trusted-dream-relay-http-"));

    try {
      const brainRoot = join(root, "brain");
      const cloudflareRoot = join(root, "cloudflare");
      const repoOutputsRoot = join(root, "repo-outputs");
      const rawRoots = [brainRoot, cloudflareRoot, repoOutputsRoot, root];
      const rawTranscriptPath = "/Users/joel/.pi/agent/sessions/session.jsonl";

      await mkdir(brainRoot, { recursive: true });
      await mkdir(cloudflareRoot, { recursive: true });
      await mkdir(repoOutputsRoot, { recursive: true });
      await writeTextFile({
        content: "cloudflare run artifact",
        path: join(cloudflareRoot, "cloudflare-run.json"),
      });
      await writeTextFile({
        content: "project brain update",
        path: join(brainRoot, "dream-memory.svx"),
      });
      await writeTextFile({
        content: "dream workflow report canon",
        path: join(repoOutputsRoot, "dream-report-canon.md"),
      });
      const relay = await startTrustedLocalMemoryRelayHttpServer({
        expectedBearerToken: relayToken,
        host: "127.0.0.1",
        memoryFabric: {
          maxFilesPerSource: 100,
          sessionBridgeCommand: () =>
            Promise.resolve({
              stdout: JSON.stringify({
                ok: true,
                result: {
                  hits: [
                    {
                      id: "chunk-1",
                      machineId: "flagg",
                      role: "assistant",
                      runId: "run-1",
                      sessionId: "session-1",
                      snippets: [
                        `codex transcript from ${rawTranscriptPath} indexed by JoelClaw`,
                      ],
                      source: "typesense",
                      startedAt: timestamp,
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
              sourceId: "source:agent-transcripts:joelclaw-index",
              sourceSystem: "joelclaw:session-index",
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
        const readiness = TrustedLocalMemoryRelayReadinessReceiptSchema.parse(
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
        const captureRunEnvelope = memoryRelayResponseEnvelopeSchema(
          MemoryCaptureReceiptDocumentSchema
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
        const captureArtifactEnvelope = memoryRelayResponseEnvelopeSchema(
          MemoryCaptureReceiptDocumentSchema
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
        const searchEnvelope = memoryRelayResponseEnvelopeSchema(
          MemorySearchDocumentSchema
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
        const hydrationEnvelope = memoryRelayResponseEnvelopeSchema(
          MemoryHydrationDocumentSchema
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
        const correlationEnvelope = memoryRelayResponseEnvelopeSchema(
          MemoryCorrelationGraphDocumentSchema
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
          rawTranscriptPathLeaked: serialized.includes(rawTranscriptPath),
          readinessSchema: readiness.schemaVersion,
          responseLeaksToken: serialized.includes(relayToken),
          searchHitCount: searchEnvelope.document.hits.length,
          searchReceiptMachineId: receipt.machineId,
          searchReceiptSourceId: receipt.sourceId,
          sourceRootCount: readiness.adapter.sourceRoots.length,
          supportedOperations: readiness.supportedOperations,
        }).toStrictEqual({
          captureArtifactKind: "artifact",
          captureRunCapturedRunId: "run:trusted-local-relay-http",
          captureRunKind: "run",
          correlationEdgeCount: 4,
          correlationSchema: "memory.correlation-graph.v1",
          deniedHealthStatus: 401,
          hydratedFullTranscriptReturned: false,
          operationCatalogCount: 6,
          rawPathLeaked: false,
          rawTranscriptPathLeaked: false,
          readinessSchema: "trusted.memory-relay.readiness.v1",
          responseLeaksToken: false,
          searchHitCount: 1,
          searchReceiptMachineId: "flagg",
          searchReceiptSourceId: "source:agent-transcripts:joelclaw-index",
          sourceRootCount: 4,
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
