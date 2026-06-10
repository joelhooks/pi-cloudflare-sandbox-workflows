#!/usr/bin/env tsx

import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import { ActorSchema, ArtifactRefSchema } from "../src/app/domain/schemas.ts";
import { dreamMemoryRelayEndpointCatalog } from "../src/app/infrastructure/cloudflare-dream-memory-fabric-relay.ts";
import {
  DreamBackfillPlanDocumentSchema,
  DreamBackfillRunReceiptDocumentSchema,
  DreamCaptureReceiptDocumentSchema,
  DreamCorrelationGraphDocumentSchema,
  DreamHydrationDocumentSchema,
  DreamMemoryRelayRequestEnvelopeSchema,
  DreamMemorySearchDocumentSchema,
  DreamSignalDocumentSchema,
  DreamSourceFamilySchema,
  DreamSourceHealthDocumentSchema,
  DreamSourceInventoryDocumentSchema,
  dreamMemoryRelayResponseEnvelopeSchema,
} from "../src/app/workflow-nodes/dream-memory-fabric-schemas.ts";
import type {
  DreamBackfillPlanDocument,
  DreamBackfillRunReceiptDocument,
  DreamCaptureReceiptDocument,
  DreamCorrelationGraphDocument,
  DreamHydrationDocument,
  DreamMemoryRelayOperation,
  DreamMemorySearchDocument,
  DreamReceiptRef,
  DreamSignalDocument,
  DreamSourceFamily,
  DreamSourceHealthDocument,
  DreamSourceInventoryDocument,
} from "../src/app/workflow-nodes/dream-memory-fabric-schemas.ts";
import {
  dreamTranscriptReviewRequiredMachineIds,
  dreamTranscriptReviewSourceProfile,
} from "../src/cartridges/dream-memory-fabric/source-profile.ts";
import {
  startTrustedLocalDreamMemoryRelayHttpServer,
  trustedLocalDreamMemoryRelayHttpConfigFromEnv,
  TrustedLocalDreamMemoryRelayReadinessReceiptSchema,
} from "../src/cartridges/dream-memory-fabric/trusted-local-relay-http.ts";

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
const relaySecretRef = "secretref:dream-memory-relay-local-proof";

const SourceRootsJsonSchema = z.array(
  z.object({
    authorityRoot: z.string().min(1),
    derivedIndexes: z
      .array(
        z.object({
          root: z.string().min(1).optional(),
        })
      )
      .optional(),
  })
);

const ReceiptFamilyCountSchema = z.object({
  family: DreamSourceFamilySchema,
  receiptCount: z.number().int().min(0),
});

const ReceiptSourceCountSchema = z.object({
  family: DreamSourceFamilySchema,
  receiptCount: z.number().int().min(0),
  sourceId: z.string().min(1),
});

const RequiredMachineIdSchema = z.enum(dreamTranscriptReviewRequiredMachineIds);

const requiredMachineIds = RequiredMachineIdSchema.options;

const MachineCoverageSchema = z.object({
  authorityCount: z.number().int().min(0),
  machineId: RequiredMachineIdSchema,
  missingReason: z.string().min(1).optional(),
  sourceCount: z.number().int().min(0),
  sourceIds: z.array(z.string().min(1)).default([]),
  status: z.enum(["captured", "missing"]),
});

const SourceFamilyCoverageSchema = z.object({
  authorityCount: z.number().int().min(0),
  family: DreamSourceFamilySchema,
  missingReason: z.string().min(1).optional(),
  sourceCount: z.number().int().min(0),
  sourceIds: z.array(z.string().min(1)).default([]),
  status: z.enum(["captured", "missing"]),
});

const LocalRelayProofReceiptSchema = z.object({
  backfill: z.object({
    actionCount: z.number().int().min(0),
    captureFixCount: z.number().int().min(0),
    status: z.string().min(1),
  }),
  backfillRun: z.object({
    blockedCount: z.number().int().min(0),
    captureFixBlockedCount: z.number().int().min(0),
    captureFixCompletedCount: z.number().int().min(0),
    captureFixFailedCount: z.number().int().min(0),
    captureFixSkippedCount: z.number().int().min(0),
    completedCount: z.number().int().min(0),
    failedCount: z.number().int().min(0),
    skippedCount: z.number().int().min(0),
  }),
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
  health: z.object({
    blindSpotCount: z.number().int().min(0),
    degradedSourceCount: z.number().int().min(0),
    status: z.string().min(1),
  }),
  inventory: z.object({
    machineCoverage: z.array(MachineCoverageSchema),
    runtimeCoverage: z.array(
      z.object({
        count: z.number().int().min(0),
        runtime: z.string().min(1),
        status: z.string().min(1),
      })
    ),
    sourceCount: z.number().int().min(0),
    sourceFamilyCoverage: z.array(SourceFamilyCoverageSchema),
    sources: z.array(
      z.object({
        authorityCount: z.number().int().min(0),
        derivedIndexCount: z.number().int().min(0),
        family: z.string().min(1),
        sourceId: z.string().min(1),
      })
    ),
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

const operationPath = (operation: DreamMemoryRelayOperation): string => {
  const endpoint = dreamMemoryRelayEndpointCatalog.endpoints.find(
    (candidate) => candidate.operation === operation
  );
  if (endpoint === undefined) {
    throw new Error(`No Dream relay endpoint path for ${operation}.`);
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
  readonly sourceFamilies?: readonly DreamSourceFamily[] | undefined;
  readonly sourceFamiliesExpected?: readonly DreamSourceFamily[] | undefined;
}): readonly DreamSourceFamily[] =>
  payload.sourceFamilies ??
  payload.sourceFamiliesExpected ??
  dreamTranscriptReviewSourceFamilies;

const relayEnvelope = (input: {
  readonly operation: DreamMemoryRelayOperation;
  readonly payload: unknown;
}) => {
  const payloadWithFamilies = z
    .object({
      sourceFamilies: z.array(DreamSourceFamilySchema).optional(),
      sourceFamiliesExpected: z.array(DreamSourceFamilySchema).optional(),
    })
    .passthrough()
    .parse(input.payload);

  return DreamMemoryRelayRequestEnvelopeSchema.parse({
    actor,
    allowedSourceFamilies: [...sourceFamiliesForPayload(payloadWithFamilies)],
    budget: {
      maxFiles: 5000,
      maxRows: 1000,
      maxTokens: 100_000,
    },
    idempotencyKey: `${runId}:${input.operation}`,
    lease: {
      capability: "dream.memory.relay",
      leaseId: `lease:dream-memory-relay-local-proof:${input.operation}`,
      redacted: true,
      secretRef: relaySecretRef,
    },
    operation: input.operation,
    payload: input.payload,
    purpose: `Local trusted Dream memory relay proof for ${input.operation}.`,
    redactionPolicy: {
      mode: "redacted-evidence",
      noCustomerDataInPublicArtifacts: true,
      noRawCredentials: true,
      noRawPrivatePaths: true,
      noRawTranscripts: true,
    },
    runId,
    schemaVersion: "dream.memory-relay.request.v1",
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
  readonly operation: DreamMemoryRelayOperation;
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
      `Dream relay ${input.operation} returned HTTP ${response.status}.`
    );
  }

  return dreamMemoryRelayResponseEnvelopeSchema(input.documentSchema).parse(
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
    throw new Error(`Dream relay /healthz returned HTTP ${response.status}.`);
  }

  return TrustedLocalDreamMemoryRelayReadinessReceiptSchema.parse(
    await response.json()
  );
};

const artifactRef = (name: string) =>
  ArtifactRefSchema.parse(`artifact://local-dream-relay-proof/${name}.json`);

const runtimeCoverageCount = (input: {
  readonly coverage: DreamSourceInventoryDocument["runtimeCoverage"][number];
  readonly inventory: DreamSourceInventoryDocument;
}): number => {
  const sourceId = input.coverage.nativeProof?.sourceId;
  if (sourceId === undefined) {
    return 0;
  }

  return (
    input.inventory.sources.find((source) => source.sourceId === sourceId)
      ?.authority.count ?? 0
  );
};

const rawRootsFromConfig = (sourceRootsJson: string): readonly string[] => {
  const sourceRoots = SourceRootsJsonSchema.parse(JSON.parse(sourceRootsJson));

  return sourceRoots.flatMap((sourceRoot) => [
    sourceRoot.authorityRoot,
    ...(sourceRoot.derivedIndexes ?? []).flatMap((derivedIndex) =>
      derivedIndex.root === undefined ? [] : [derivedIndex.root]
    ),
  ]);
};

const receiptCountsFor = (receipts: readonly DreamReceiptRef[]) => {
  const familyCounts = new Map<DreamSourceFamily, number>();
  const sourceCounts = new Map<
    string,
    {
      family: DreamSourceFamily;
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

const machineIdForSource = (
  source: DreamSourceInventoryDocument["sources"][number]
): z.infer<typeof RequiredMachineIdSchema> | undefined => {
  const scopedMachineId = source.scope.machineId;
  const machineResult = RequiredMachineIdSchema.safeParse(scopedMachineId);
  if (machineResult.success) {
    return machineResult.data;
  }

  if (source.family === "cloudflare-runs") {
    return "cloudflare";
  }

  return undefined;
};

const machineCoverageFor = (
  inventory: DreamSourceInventoryDocument
): z.infer<typeof MachineCoverageSchema>[] => {
  const sourceIdsByMachine = new Map<string, Set<string>>();
  const authorityCountsByMachine = new Map<string, number>();

  for (const source of inventory.sources) {
    const machineId = machineIdForSource(source);
    if (machineId === undefined) {
      continue;
    }

    const sourceIds = sourceIdsByMachine.get(machineId) ?? new Set<string>();
    sourceIds.add(source.sourceId);
    sourceIdsByMachine.set(machineId, sourceIds);
    authorityCountsByMachine.set(
      machineId,
      (authorityCountsByMachine.get(machineId) ?? 0) + source.authority.count
    );
  }

  return requiredMachineIds.map((machineId) => {
    const sourceIds = [...(sourceIdsByMachine.get(machineId) ?? [])].toSorted();
    const authorityCount = authorityCountsByMachine.get(machineId) ?? 0;
    const captured = sourceIds.length > 0 && authorityCount > 0;

    return MachineCoverageSchema.parse({
      authorityCount,
      machineId,
      ...(captured
        ? {}
        : {
            missingReason:
              "No configured trusted Dream source root produced native evidence for this required machine.",
          }),
      sourceCount: sourceIds.length,
      sourceIds,
      status: captured ? "captured" : "missing",
    });
  });
};

const sourceFamilyCoverageFor = (input: {
  readonly evidenceReceipts: readonly DreamReceiptRef[];
  readonly expectedSourceFamilies: readonly DreamSourceFamily[];
  readonly inventory: DreamSourceInventoryDocument;
}): z.infer<typeof SourceFamilyCoverageSchema>[] => {
  const sourceIdsByFamily = new Map<DreamSourceFamily, Set<string>>();
  const authorityCountsByFamily = new Map<DreamSourceFamily, number>();
  const inventorySourceIds = new Set<string>();

  for (const source of input.inventory.sources) {
    inventorySourceIds.add(source.sourceId);
    const sourceIds = sourceIdsByFamily.get(source.family) ?? new Set<string>();
    sourceIds.add(source.sourceId);
    sourceIdsByFamily.set(source.family, sourceIds);
    authorityCountsByFamily.set(
      source.family,
      (authorityCountsByFamily.get(source.family) ?? 0) + source.authority.count
    );
  }

  for (const receipt of input.evidenceReceipts) {
    const sourceIds =
      sourceIdsByFamily.get(receipt.family) ?? new Set<string>();
    sourceIds.add(receipt.sourceId);
    sourceIdsByFamily.set(receipt.family, sourceIds);

    if (!inventorySourceIds.has(receipt.sourceId)) {
      authorityCountsByFamily.set(
        receipt.family,
        (authorityCountsByFamily.get(receipt.family) ?? 0) + 1
      );
    }
  }

  return input.expectedSourceFamilies.map((family) => {
    const sourceIds = [...(sourceIdsByFamily.get(family) ?? [])].toSorted();
    const authorityCount = authorityCountsByFamily.get(family) ?? 0;
    const captured = sourceIds.length > 0 && authorityCount > 0;

    return SourceFamilyCoverageSchema.parse({
      authorityCount,
      family,
      ...(captured
        ? {}
        : {
            missingReason:
              "No configured trusted Dream source root produced authority evidence for this source family.",
          }),
      sourceCount: sourceIds.length,
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
  const config = trustedLocalDreamMemoryRelayHttpConfigFromEnv({
    DREAM_DOCS_API_BASE_URL:
      process.env["DREAM_DOCS_API_BASE_URL"] ?? DEFAULT_DOCS_API_BASE_URL,
    DREAM_DOCS_API_USER_AGENT:
      process.env["DREAM_DOCS_API_USER_AGENT"] ??
      "pi-cloudflare-sandbox-workflows-dream-relay-proof/0.0.0",
    DREAM_MEMORY_RELAY_MAX_FILES_PER_SOURCE:
      process.env["DREAM_MEMORY_RELAY_MAX_FILES_PER_SOURCE"] ?? "5000",
    DREAM_MEMORY_RELAY_SOURCE_ROOTS_JSON: sourceRootsJson,
    DREAM_MEMORY_RELAY_TOKEN: token,
  });
  const relay = await startTrustedLocalDreamMemoryRelayHttpServer({
    ...config,
    port: 0,
  });

  try {
    const readiness = await healthz({ baseUrl: relay.url, token });
    const inventory = await postOperation<DreamSourceInventoryDocument>({
      baseUrl: relay.url,
      documentSchema: DreamSourceInventoryDocumentSchema,
      operation: "inventory",
      payload: {
        actor,
        requiredRuntimes: dreamTranscriptReviewSourceProfile.requiredRuntimes,
        runId,
        sourceFamiliesExpected: dreamTranscriptReviewSourceFamilies,
        workItemId,
      },
      token,
    });
    const health = await postOperation<DreamSourceHealthDocument>({
      baseUrl: relay.url,
      documentSchema: DreamSourceHealthDocumentSchema,
      operation: "source-health",
      payload: {
        actor,
        inventory,
        inventoryRef: artifactRef("source-inventory"),
        runId,
        workItemId,
      },
      token,
    });
    const backfill = await postOperation<DreamBackfillPlanDocument>({
      baseUrl: relay.url,
      documentSchema: DreamBackfillPlanDocumentSchema,
      operation: "backfill-plan",
      payload: {
        actor,
        health,
        healthRef: artifactRef("source-health"),
        inventory,
        inventoryRef: artifactRef("source-inventory"),
        runId,
        workItemId,
      },
      token,
    });
    const backfillRun = await postOperation<DreamBackfillRunReceiptDocument>({
      baseUrl: relay.url,
      documentSchema: DreamBackfillRunReceiptDocumentSchema,
      operation: "backfill-run",
      payload: {
        actor,
        plan: backfill,
        planRef: artifactRef("backfill-plan"),
        runId,
        workItemId,
      },
      token,
    });
    const captureRun = await postOperation<DreamCaptureReceiptDocument>({
      baseUrl: relay.url,
      documentSchema: DreamCaptureReceiptDocumentSchema,
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
    const captureArtifact = await postOperation<DreamCaptureReceiptDocument>({
      baseUrl: relay.url,
      documentSchema: DreamCaptureReceiptDocumentSchema,
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
    const signals = await postOperation<DreamSignalDocument>({
      baseUrl: relay.url,
      documentSchema: DreamSignalDocumentSchema,
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
    const search = await postOperation<DreamMemorySearchDocument>({
      baseUrl: relay.url,
      documentSchema: DreamMemorySearchDocumentSchema,
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
        ? DreamHydrationDocumentSchema.parse({
            generatedAt: new Date().toISOString(),
            hydrated: [],
            redacted: true,
            runId,
            schemaVersion: "dream.hydration.v1",
            workItemId,
          })
        : await postOperation<DreamHydrationDocument>({
            baseUrl: relay.url,
            documentSchema: DreamHydrationDocumentSchema,
            operation: "hydrate",
            payload: {
              actor,
              receipts: search.hits.flatMap((hit) => hit.receipts).slice(0, 12),
              runId,
              workItemId,
            },
            token,
          });
    const correlation = await postOperation<DreamCorrelationGraphDocument>({
      baseUrl: relay.url,
      documentSchema: DreamCorrelationGraphDocumentSchema,
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
      backfill,
      backfillRun,
      captureArtifact,
      captureRun,
      correlation,
      health,
      hydration,
      inventory,
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

    const degradedSourceCount = health.indexHealth.filter(
      (index) => index.status !== "fresh"
    ).length;
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
      backfill: {
        actionCount: backfill.actions.length,
        captureFixCount: backfill.captureFixes.length,
        status: backfill.status,
      },
      backfillRun: {
        blockedCount: backfillRun.actionResults.filter(
          (action) => action.status === "blocked"
        ).length,
        captureFixBlockedCount: backfillRun.captureFixResults.filter(
          (captureFix) => captureFix.status === "blocked"
        ).length,
        captureFixCompletedCount: backfillRun.captureFixResults.filter(
          (captureFix) => captureFix.status === "completed"
        ).length,
        captureFixFailedCount: backfillRun.captureFixResults.filter(
          (captureFix) => captureFix.status === "failed"
        ).length,
        captureFixSkippedCount: backfillRun.captureFixResults.filter(
          (captureFix) => captureFix.status === "skipped"
        ).length,
        completedCount: backfillRun.actionResults.filter(
          (action) => action.status === "completed"
        ).length,
        failedCount: backfillRun.actionResults.filter(
          (action) => action.status === "failed"
        ).length,
        skippedCount: backfillRun.actionResults.filter(
          (action) => action.status === "skipped"
        ).length,
      },
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
      health: {
        blindSpotCount:
          inventory.blindSpots.length +
          inventory.sources.reduce(
            (count, source) => count + source.blindSpots.length,
            0
          ),
        degradedSourceCount,
        status: health.status,
      },
      inventory: {
        machineCoverage: machineCoverageFor(inventory),
        runtimeCoverage: inventory.runtimeCoverage.map((coverage) => ({
          count: runtimeCoverageCount({ coverage, inventory }),
          runtime: coverage.runtime,
          status: coverage.status,
        })),
        sourceCount: inventory.sources.length,
        sourceFamilyCoverage: sourceFamilyCoverageFor({
          evidenceReceipts: hydration.hydrated.map((item) => item.receipt),
          expectedSourceFamilies: dreamTranscriptReviewSourceFamilies,
          inventory,
        }),
        sources: inventory.sources.map((source) => ({
          authorityCount: source.authority.count,
          derivedIndexCount: source.derivedIndexes.length,
          family: source.family,
          sourceId: source.sourceId,
        })),
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
