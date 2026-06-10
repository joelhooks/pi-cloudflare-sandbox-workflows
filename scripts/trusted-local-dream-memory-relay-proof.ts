#!/usr/bin/env tsx

import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import { ActorSchema, ArtifactRefSchema } from "../src/app/domain/schemas.ts";
import { MemorySourceFamilySchema } from "../src/app/domain/source-profile.ts";
import type {
  MemoryRelayOperation,
  MemorySourceFamily,
} from "../src/app/domain/source-profile.ts";
import { memoryRelayEndpointCatalog } from "../src/cartridges/memory-fabric/cloudflare-relay.ts";
import {
  MemoryCaptureReceiptDocumentSchema,
  MemoryCorrelationGraphDocumentSchema,
  MemoryHydrationDocumentSchema,
  MemoryRelayRequestEnvelopeSchema,
  MemorySearchDocumentSchema,
  MemorySignalDocumentSchema,
  memoryRelayResponseEnvelopeSchema,
} from "../src/cartridges/memory-fabric/schemas.ts";
import type {
  MemoryCaptureReceiptDocument,
  MemoryCorrelationGraphDocument,
  MemoryHydrationDocument,
  MemorySearchDocument,
  MemoryReceiptRef,
  MemorySignalDocument,
} from "../src/cartridges/memory-fabric/schemas.ts";
import { dreamTranscriptReviewSourceProfile } from "../src/cartridges/memory-fabric/source-profile.ts";
import {
  startTrustedLocalMemoryRelayHttpServer,
  trustedLocalMemoryRelayHttpConfigFromEnv,
  TrustedLocalMemoryRelayReadinessReceiptSchema,
} from "../src/cartridges/memory-fabric/trusted-local-relay-http.ts";

const DEFAULT_SOURCE_ROOTS_PATH =
  ".wrangler/workflow-app/dream-relay/source-roots.json";
const DEFAULT_RECEIPT_PATH =
  ".wrangler/workflow-app/dream-relay/latest-local-proof.json";
const DEFAULT_DOCS_API_BASE_URL = "https://joelclaw.com/api/docs";
const DEFAULT_QUERY = dreamTranscriptReviewSourceProfile.defaultQuery;
const runId = `run:dream-relay-local-proof:${new Date()
  .toISOString()
  .replaceAll(/[^0-9A-Za-z]+/gu, "")}`;
const workItemId = "work:dream-relay-local-proof";
const relaySecretRef = "secretref:memory-relay-local-proof";

const SourceRootsJsonSchema = z.array(
  z.object({
    authorityRoot: z.string().min(1),
  })
);

const ReceiptFamilyCountSchema = z.object({
  family: MemorySourceFamilySchema,
  receiptCount: z.number().int().min(0),
});

const ReceiptSourceCountSchema = z.object({
  family: MemorySourceFamilySchema,
  receiptCount: z.number().int().min(0),
  sourceId: z.string().min(1),
});

const SourceFamilyCoverageSchema = z.object({
  family: MemorySourceFamilySchema,
  missingReason: z.string().min(1).optional(),
  receiptCount: z.number().int().min(0),
  sourceIds: z.array(z.string().min(1)).default([]),
  status: z.enum(["captured", "missing"]),
});

const LocalRelayProofReceiptSchema = z.object({
  capture: z.object({
    artifactCaptureKind: z.literal("artifact"),
    artifactCapturedRef: ArtifactRefSchema,
    runCaptureKind: z.literal("run"),
    runCapturedRef: ArtifactRefSchema,
  }),
  checkedAt: z.string().min(1),
  correlation: z.object({
    edgeCount: z.number().int().min(0),
    nodeCount: z.number().int().min(0),
  }),
  query: z.string().min(1),
  rawCredentialsReturned: z.literal(false),
  rawPathLeaked: z.literal(false),
  rawPathsReturned: z.literal(false),
  redacted: z.literal(true),
  relay: z.object({
    healthUrl: z.string().min(1),
    supportedOperations: z.array(z.string().min(1)),
  }),
  runId: z.string().min(1),
  schemaVersion: z.literal("trusted.dream-memory-relay.local-proof.v1"),
  search: z.object({
    hitCount: z.number().int().min(0),
    hydratedCount: z.number().int().min(0),
    hydratedFamilyCounts: z.array(ReceiptFamilyCountSchema),
    hydratedSourceCounts: z.array(ReceiptSourceCountSchema),
    receiptFamilyCounts: z.array(ReceiptFamilyCountSchema),
    receiptSourceCounts: z.array(ReceiptSourceCountSchema),
    skippedSourceCount: z.number().int().min(0),
  }),
  signals: z.object({
    receiptFamilyCounts: z.array(ReceiptFamilyCountSchema),
    signalCount: z.number().int().min(0),
    signalKinds: z.array(z.string().min(1)),
  }),
  sourceFamilyCoverage: z.array(SourceFamilyCoverageSchema),
  sourceRootCount: z.number().int().min(1),
  workItemId: z.string().min(1),
});

const isMain = (): boolean =>
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

const argValue = (name: string): string | undefined => {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline !== undefined) {
    return inline.slice(prefix.length);
  }

  const index = process.argv.indexOf(name);
  if (index !== -1) {
    return process.argv[index + 1];
  }

  return undefined;
};

const operationPath = (operation: MemoryRelayOperation): string => {
  const endpoint = memoryRelayEndpointCatalog.endpoints.find(
    (candidate) => candidate.operation === operation
  );
  if (endpoint === undefined) {
    throw new Error(`No Memory relay endpoint path for ${operation}.`);
  }

  return endpoint.path;
};

const actor = ActorSchema.parse({
  id: "actor:joel",
  organizationId: "org:joelhooks",
  roleIds: ["owner", "operator"],
  sessionId: "session:dream-relay-local-proof",
  trustTier: "manual",
  type: "human",
});

const dreamTranscriptReviewSourceFamilies =
  dreamTranscriptReviewSourceProfile.sourceFamiliesExpected;

const sourceFamiliesForPayload = (payload: {
  readonly sourceFamilies?: readonly MemorySourceFamily[] | undefined;
  readonly sourceFamiliesExpected?: readonly MemorySourceFamily[] | undefined;
}): readonly MemorySourceFamily[] =>
  payload.sourceFamilies ??
  payload.sourceFamiliesExpected ??
  dreamTranscriptReviewSourceFamilies;

const relayEnvelope = (input: {
  readonly operation: MemoryRelayOperation;
  readonly payload: unknown;
}) => {
  const payloadWithFamilies = z
    .object({
      sourceFamilies: z.array(MemorySourceFamilySchema).optional(),
      sourceFamiliesExpected: z.array(MemorySourceFamilySchema).optional(),
    })
    .passthrough()
    .parse(input.payload);

  return MemoryRelayRequestEnvelopeSchema.parse({
    actor,
    allowedSourceFamilies: [...sourceFamiliesForPayload(payloadWithFamilies)],
    budget: {
      maxFiles: 5000,
      maxRows: 1000,
      maxTokens: 100_000,
    },
    idempotencyKey: `${runId}:${input.operation}`,
    lease: {
      capability: "memory.relay",
      leaseId: `lease:dream-memory-relay-local-proof:${input.operation}`,
      redacted: true,
      secretRef: relaySecretRef,
    },
    operation: input.operation,
    payload: input.payload,
    purpose: `Local trusted Memory relay proof for ${input.operation}.`,
    redactionPolicy: {
      mode: "redacted-evidence",
      noCustomerDataInPublicArtifacts: true,
      noRawCredentials: true,
      noRawPrivatePaths: true,
      noRawTranscripts: true,
    },
    runId,
    schemaVersion: "memory.relay.request.v1",
    scope: {
      organizationId: actor.organizationId,
    },
    timeWindow: {
      label: "all-time",
    },
    traceContext: {
      parentSpanId: "span:dream-relay-local-proof:workflow",
      redacted: true,
      spanId: `span:dream-relay-local-proof:${input.operation}`,
      traceId: "trace:dream-relay-local-proof",
    },
    workItemId,
  });
};

const postOperation = async <TDocument>(input: {
  readonly baseUrl: string;
  readonly documentSchema: z.ZodType<TDocument>;
  readonly operation: MemoryRelayOperation;
  readonly payload: unknown;
  readonly token: string;
}): Promise<TDocument> => {
  const response = await fetch(
    new URL(operationPath(input.operation), input.baseUrl),
    {
      body: JSON.stringify(
        relayEnvelope({
          operation: input.operation,
          payload: input.payload,
        })
      ),
      headers: {
        authorization: `Bearer ${input.token}`,
        "content-type": "application/json",
      },
      method: "POST",
    }
  );
  if (!response.ok) {
    throw new Error(
      `Memory relay ${input.operation} returned HTTP ${response.status}.`
    );
  }

  return memoryRelayResponseEnvelopeSchema(input.documentSchema).parse(
    await response.json()
  ).document;
};

const healthz = async (input: {
  readonly baseUrl: string;
  readonly token: string;
}) => {
  const response = await fetch(new URL("/healthz", input.baseUrl), {
    headers: {
      authorization: `Bearer ${input.token}`,
    },
    method: "GET",
  });
  if (!response.ok) {
    throw new Error(`Memory relay /healthz returned HTTP ${response.status}.`);
  }

  return TrustedLocalMemoryRelayReadinessReceiptSchema.parse(
    await response.json()
  );
};

const artifactRef = (name: string) =>
  ArtifactRefSchema.parse(`artifact://local-dream-relay-proof/${name}.json`);

const rawRootsFromConfig = (sourceRootsJson: string): readonly string[] => {
  const sourceRoots = SourceRootsJsonSchema.parse(JSON.parse(sourceRootsJson));

  return sourceRoots.map((sourceRoot) => sourceRoot.authorityRoot);
};

const receiptCountsFor = (receipts: readonly MemoryReceiptRef[]) => {
  const familyCounts = new Map<MemorySourceFamily, number>();
  const sourceCounts = new Map<
    string,
    {
      family: MemorySourceFamily;
      receiptCount: number;
      sourceId: string;
    }
  >();

  for (const receipt of receipts) {
    familyCounts.set(
      receipt.family,
      (familyCounts.get(receipt.family) ?? 0) + 1
    );

    const sourceKey = `${receipt.family}:${receipt.sourceId}`;
    const sourceCount = sourceCounts.get(sourceKey);
    if (sourceCount === undefined) {
      sourceCounts.set(sourceKey, {
        family: receipt.family,
        receiptCount: 1,
        sourceId: receipt.sourceId,
      });
      continue;
    }

    sourceCounts.set(sourceKey, {
      ...sourceCount,
      receiptCount: sourceCount.receiptCount + 1,
    });
  }

  return {
    familyCounts: [...familyCounts.entries()]
      .map(([family, receiptCount]) => ({ family, receiptCount }))
      .toSorted((left, right) => left.family.localeCompare(right.family)),
    sourceCounts: [...sourceCounts.values()].toSorted(
      (left, right) =>
        left.family.localeCompare(right.family) ||
        left.sourceId.localeCompare(right.sourceId)
    ),
  };
};

const sourceFamilyCoverageFor = (input: {
  readonly evidenceReceipts: readonly MemoryReceiptRef[];
  readonly expectedSourceFamilies: readonly MemorySourceFamily[];
}): z.infer<typeof SourceFamilyCoverageSchema>[] => {
  const sourceIdsByFamily = new Map<MemorySourceFamily, Set<string>>();
  const receiptCountsByFamily = new Map<MemorySourceFamily, number>();

  for (const receipt of input.evidenceReceipts) {
    const sourceIds =
      sourceIdsByFamily.get(receipt.family) ?? new Set<string>();
    sourceIds.add(receipt.sourceId);
    sourceIdsByFamily.set(receipt.family, sourceIds);
    receiptCountsByFamily.set(
      receipt.family,
      (receiptCountsByFamily.get(receipt.family) ?? 0) + 1
    );
  }

  return input.expectedSourceFamilies.map((family) => {
    const sourceIds = [...(sourceIdsByFamily.get(family) ?? [])].toSorted();
    const receiptCount = receiptCountsByFamily.get(family) ?? 0;
    const captured = sourceIds.length > 0 && receiptCount > 0;

    return SourceFamilyCoverageSchema.parse({
      family,
      ...(captured
        ? {}
        : {
            missingReason:
              "No trusted relay retrieval receipt covered this source family; report this as a Dream coverage caveat.",
          }),
      receiptCount,
      sourceIds,
      status: captured ? "captured" : "missing",
    });
  });
};

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
};

const run = async (): Promise<void> => {
  const sourceRootsPath = resolve(
    argValue("--source-roots") ?? DEFAULT_SOURCE_ROOTS_PATH
  );
  const receiptPath = resolve(argValue("--out") ?? DEFAULT_RECEIPT_PATH);
  const query = argValue("--query") ?? DEFAULT_QUERY;
  const sourceRootsJson = await readFile(sourceRootsPath, "utf-8");
  const token = randomBytes(32).toString("hex");
  const config = trustedLocalMemoryRelayHttpConfigFromEnv({
    MEMORY_DOCS_API_BASE_URL:
      process.env["MEMORY_DOCS_API_BASE_URL"] ?? DEFAULT_DOCS_API_BASE_URL,
    MEMORY_DOCS_API_USER_AGENT:
      process.env["MEMORY_DOCS_API_USER_AGENT"] ??
      "pi-cloudflare-sandbox-workflows-dream-relay-proof/0.0.0",
    MEMORY_RELAY_MAX_FILES_PER_SOURCE:
      process.env["MEMORY_RELAY_MAX_FILES_PER_SOURCE"] ?? "5000",
    MEMORY_RELAY_SOURCE_ROOTS_JSON: sourceRootsJson,
    MEMORY_RELAY_TOKEN: token,
  });
  const relay = await startTrustedLocalMemoryRelayHttpServer({
    ...config,
    port: 0,
  });

  try {
    const readiness = await healthz({ baseUrl: relay.url, token });
    const captureRun = await postOperation<MemoryCaptureReceiptDocument>({
      baseUrl: relay.url,
      documentSchema: MemoryCaptureReceiptDocumentSchema,
      operation: "capture-run",
      payload: {
        actor,
        readability: "actor-private",
        runId,
        sourceFamilies: dreamTranscriptReviewSourceFamilies,
        sourceSystem: "cloudflare-workflow-run",
        targetRunId: runId,
        workItemId,
      },
      token,
    });
    const captureArtifact = await postOperation<MemoryCaptureReceiptDocument>({
      baseUrl: relay.url,
      documentSchema: MemoryCaptureReceiptDocumentSchema,
      operation: "capture-artifact",
      payload: {
        actor,
        capturedRef: {
          artifactRef: artifactRef("hitl-report"),
          hash: "f".repeat(64),
          mediaType: "application/json",
        },
        readability: "actor-private",
        runId,
        sourceFamilies: ["repo-outputs", "cloudflare-runs"],
        sourceSystem: "cloudflare-artifacts",
        workItemId,
      },
      token,
    });
    const signals = await postOperation<MemorySignalDocument>({
      baseUrl: relay.url,
      documentSchema: MemorySignalDocumentSchema,
      operation: "signals",
      payload: {
        actor,
        maxSignals: 8,
        query,
        runId,
        sourceFamilies: dreamTranscriptReviewSourceFamilies,
        workItemId,
      },
      token,
    });
    const search = await postOperation<MemorySearchDocument>({
      baseUrl: relay.url,
      documentSchema: MemorySearchDocumentSchema,
      operation: "search",
      payload: {
        actor,
        maxHits: 12,
        query,
        runId,
        sourceFamilies: dreamTranscriptReviewSourceFamilies,
        workItemId,
      },
      token,
    });
    const hydration =
      search.hits.length === 0
        ? MemoryHydrationDocumentSchema.parse({
            generatedAt: new Date().toISOString(),
            hydrated: [],
            redacted: true,
            runId,
            schemaVersion: "memory.hydration.v1",
            workItemId,
          })
        : await postOperation<MemoryHydrationDocument>({
            baseUrl: relay.url,
            documentSchema: MemoryHydrationDocumentSchema,
            operation: "hydrate",
            payload: {
              actor,
              receipts: search.hits.flatMap((hit) => hit.receipts).slice(0, 12),
              runId,
              workItemId,
            },
            token,
          });
    const correlation = await postOperation<MemoryCorrelationGraphDocument>({
      baseUrl: relay.url,
      documentSchema: MemoryCorrelationGraphDocumentSchema,
      operation: "correlate",
      payload: {
        actor,
        hydration,
        hydrationRef: artifactRef("hydration"),
        runId,
        search,
        searchRef: artifactRef("memory-search"),
        workItemId,
      },
      token,
    });
    const serialized = JSON.stringify({
      captureArtifact,
      captureRun,
      correlation,
      hydration,
      readiness,
      search,
      signals,
    });
    const rawPathLeaked = rawRootsFromConfig(sourceRootsJson).some((rawRoot) =>
      serialized.includes(rawRoot)
    );
    if (rawPathLeaked) {
      throw new Error(
        "Trusted relay proof leaked a raw configured source path."
      );
    }

    const searchReceiptCounts = receiptCountsFor(
      search.hits.flatMap((hit) => hit.receipts)
    );
    const hydrationReceiptCounts = receiptCountsFor(
      hydration.hydrated.map((item) => item.receipt)
    );
    const signalReceiptCounts = receiptCountsFor(
      signals.signals.flatMap((signal) => signal.receipts)
    );
    const receipt = LocalRelayProofReceiptSchema.parse({
      capture: {
        artifactCaptureKind: captureArtifact.captureKind,
        artifactCapturedRef: captureArtifact.capturedRef.artifactRef,
        runCaptureKind: captureRun.captureKind,
        runCapturedRef: captureRun.capturedRef.artifactRef,
      },
      checkedAt: new Date().toISOString(),
      correlation: {
        edgeCount: correlation.edges.length,
        nodeCount: correlation.nodes.length,
      },
      query,
      rawCredentialsReturned: readiness.rawCredentialsReturned,
      rawPathLeaked,
      rawPathsReturned: readiness.rawPathsReturned,
      redacted: true,
      relay: {
        healthUrl: `${relay.url}/healthz`,
        supportedOperations: readiness.supportedOperations,
      },
      runId,
      schemaVersion: "trusted.dream-memory-relay.local-proof.v1",
      search: {
        hitCount: search.hits.length,
        hydratedCount: hydration.hydrated.length,
        hydratedFamilyCounts: hydrationReceiptCounts.familyCounts,
        hydratedSourceCounts: hydrationReceiptCounts.sourceCounts,
        receiptFamilyCounts: searchReceiptCounts.familyCounts,
        receiptSourceCounts: searchReceiptCounts.sourceCounts,
        skippedSourceCount: search.skippedSources.length,
      },
      signals: {
        receiptFamilyCounts: signalReceiptCounts.familyCounts,
        signalCount: signals.signals.length,
        signalKinds: [
          ...new Set(signals.signals.map((signal) => signal.kind)),
        ].toSorted(),
      },
      sourceFamilyCoverage: sourceFamilyCoverageFor({
        evidenceReceipts: [
          ...search.hits.flatMap((hit) => hit.receipts),
          ...hydration.hydrated.map((item) => item.receipt),
        ],
        expectedSourceFamilies: dreamTranscriptReviewSourceFamilies,
      }),
      sourceRootCount: readiness.adapter.sourceRoots.length,
      workItemId,
    });

    await writeJson(receiptPath, receipt);
    console.log(
      JSON.stringify(
        {
          receiptPath,
          redacted: true,
          runId,
          schemaVersion: "trusted.dream-memory-relay.local-proof.completed.v1",
          status: "completed",
        },
        null,
        2
      )
    );
  } finally {
    await relay.close();
  }
};

if (isMain()) {
  try {
    await run();
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          error: {
            code: "trusted_local_relay_proof_failed",
            message:
              error instanceof Error
                ? error.message
                : "Trusted local relay proof failed.",
            redacted: true,
          },
          redacted: true,
          schemaVersion: "trusted.dream-memory-relay.local-proof-error.v1",
          status: "failed",
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  }
}
