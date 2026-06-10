import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { hashJson, sha256Hex } from "../../app/domain/hash.ts";
import { ArtifactPinSchema } from "../../app/domain/schemas.ts";
import {
  DreamBackfillPlanDocumentSchema,
  DreamBackfillRunReceiptDocumentSchema,
  DreamCaptureReceiptDocumentSchema,
  DreamSourceHealthDocumentSchema,
  DreamSourceInventoryDocumentSchema,
} from "../../app/workflow-nodes/dream-memory-fabric-schemas.ts";
import type {
  DreamAdapterHealthStatus,
  DreamBackfillPlanAction,
  DreamBackfillRunReceiptDocument,
  DreamCaptureFix,
  DreamCaptureReceiptDocument,
  DreamDerivedIndex,
  DreamDerivedIndexStatus,
  DreamMemoryRelayCaptureArtifactPayload,
  DreamMemoryRelayCaptureRunPayload,
  DreamPrivacyTier,
  DreamRuntime,
  DreamRuntimeCoverage,
  DreamSourceFamily,
  DreamSourceHealthStatus,
  DreamSourceInventoryDocument,
  DreamSourceInventoryItem,
  DreamSourceScope,
} from "../../app/workflow-nodes/dream-memory-fabric-schemas.ts";
import type {
  DreamMemoryBackfillPort,
  DreamMemoryCapturePort,
  DreamMemoryFabricPort,
} from "../../app/workflow-nodes/dream-memory-fabric.ts";
import {
  scanTrustedJoelClawSessionSource,
  trustedJoelClawSessionSourceForAuthorityRoot,
} from "./trusted-joelclaw-session-source.ts";
import type { TrustedJoelClawSessionBridgeCommand } from "./trusted-joelclaw-session-source.ts";

export interface TrustedLocalDreamDerivedIndexConfig {
  readonly derivedCount?: number;
  readonly indexId: string;
  readonly indexKind: DreamDerivedIndex["indexKind"];
  readonly root?: string;
  readonly status?: DreamDerivedIndexStatus;
}

export interface TrustedLocalDreamSourceRoot {
  readonly authorityRoot: string;
  readonly derivedIndexes?: readonly TrustedLocalDreamDerivedIndexConfig[];
  readonly family: DreamSourceFamily;
  readonly includeExtensions?: readonly string[];
  readonly label: string;
  readonly privacyTier: DreamPrivacyTier;
  readonly runtime?: DreamRuntime;
  readonly scope?: DreamSourceScope;
  readonly sourceId: string;
  readonly sourceSystem: string;
}

export interface TrustedLocalDreamMemoryFabricConfig {
  readonly maxFilesPerSource?: number;
  readonly now?: () => string;
  readonly sessionBridgeCommand?: TrustedJoelClawSessionBridgeCommand;
  readonly sourceRoots: readonly TrustedLocalDreamSourceRoot[];
}

interface LocalFileScan {
  readonly count: number;
  readonly earliestAt?: string;
  readonly health: DreamAdapterHealthStatus;
  readonly latestAt?: string;
  readonly truncated: boolean;
}

interface LocalSourceInventory {
  readonly config: TrustedLocalDreamSourceRoot;
  readonly item: DreamSourceInventoryItem;
}

const DEFAULT_MAX_FILES_PER_SOURCE = 10_000;
const TRUSTED_LOCAL_PORT = "TrustedLocalDreamMemoryFabricPort";

const captureArtifactRefSegment = (value: string): string =>
  encodeURIComponent(value);

const containsExtension = (input: {
  readonly fileName: string;
  readonly includeExtensions: readonly string[] | undefined;
}): boolean => {
  if (input.includeExtensions === undefined) {
    return true;
  }

  for (const extension of input.includeExtensions) {
    if (input.fileName.endsWith(extension)) {
      return true;
    }
  }

  return false;
};

const isMissingRootError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT";

const localFileScanResult = (input: {
  readonly count: number;
  readonly earliestMs: number | null;
  readonly health: DreamAdapterHealthStatus;
  readonly latestMs: number | null;
  readonly truncated: boolean;
}): LocalFileScan => ({
  count: input.count,
  ...(input.earliestMs === null
    ? {}
    : { earliestAt: new Date(input.earliestMs).toISOString() }),
  health: input.health,
  ...(input.latestMs === null
    ? {}
    : { latestAt: new Date(input.latestMs).toISOString() }),
  truncated: input.truncated,
});

const scanDirectory = async (input: {
  readonly includeExtensions: readonly string[] | undefined;
  readonly maxFiles: number;
  readonly root: string;
}): Promise<LocalFileScan> => {
  try {
    const rootStats = await stat(input.root);
    if (!rootStats.isDirectory()) {
      return {
        count: 0,
        health: "missing",
        truncated: false,
      };
    }
  } catch (error) {
    return {
      count: 0,
      health: isMissingRootError(error) ? "missing" : "unavailable",
      truncated: false,
    };
  }

  const pendingDirectories = [input.root];
  let count = 0;
  let earliestMs: number | null = null;
  let latestMs: number | null = null;
  let truncated = false;

  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop();
    if (directory === undefined) {
      continue;
    }

    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return localFileScanResult({
        count,
        earliestMs,
        health: "unavailable",
        latestMs,
        truncated,
      });
    }

    for (const entry of entries) {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        pendingDirectories.push(entryPath);
        continue;
      }

      if (
        !entry.isFile() ||
        !containsExtension({
          fileName: entry.name,
          includeExtensions: input.includeExtensions,
        })
      ) {
        continue;
      }

      if (count >= input.maxFiles) {
        truncated = true;
        continue;
      }

      try {
        const entryStats = await stat(entryPath);
        const modifiedMs = entryStats.mtime.getTime();
        count += 1;
        earliestMs =
          earliestMs === null ? modifiedMs : Math.min(earliestMs, modifiedMs);
        latestMs =
          latestMs === null ? modifiedMs : Math.max(latestMs, modifiedMs);
      } catch {
        return localFileScanResult({
          count,
          earliestMs,
          health: "unavailable",
          latestMs,
          truncated,
        });
      }
    }
  }

  return localFileScanResult({
    count,
    earliestMs,
    health: count === 0 ? "stale" : "healthy",
    latestMs,
    truncated,
  });
};

const scanAuthorityRoot = (input: {
  readonly command: TrustedJoelClawSessionBridgeCommand | undefined;
  readonly includeExtensions: readonly string[] | undefined;
  readonly maxFiles: number;
  readonly sourceRoot: TrustedLocalDreamSourceRoot;
}): Promise<LocalFileScan> => {
  const joelClawSessionSource = trustedJoelClawSessionSourceForAuthorityRoot(
    input.sourceRoot.authorityRoot,
    input.sourceRoot.runtime
  );

  if (joelClawSessionSource !== null) {
    return scanTrustedJoelClawSessionSource({
      ...(input.command === undefined ? {} : { command: input.command }),
      maxFiles: input.maxFiles,
      source: joelClawSessionSource,
    });
  }

  return scanDirectory({
    includeExtensions: input.includeExtensions,
    maxFiles: input.maxFiles,
    root: input.sourceRoot.authorityRoot,
  });
};

const redactedLocatorFor = (sourceId: string): string =>
  `redacted://dream-source/${encodeURIComponent(sourceId)}`;

const sourceScopeFor = (input: {
  readonly fallbackScope: DreamSourceScope;
  readonly sourceRoot: TrustedLocalDreamSourceRoot;
}): DreamSourceScope => input.sourceRoot.scope ?? input.fallbackScope;

const missingDerivedIndexFor = (input: {
  readonly checkedAt: string;
  readonly count: number;
  readonly sourceId: string;
}): DreamDerivedIndex => ({
  authorityCount: input.count,
  derivedCount: 0,
  freshnessCheckedAt: input.checkedAt,
  indexId: `${input.sourceId}:missing-derived-index`,
  indexKind: "view",
  status: "missing",
});

const derivedIndexStatusFor = (input: {
  readonly authorityCount: number;
  readonly derivedCount: number | undefined;
  readonly explicitStatus: DreamDerivedIndexStatus | undefined;
  readonly rootHealth: DreamAdapterHealthStatus | undefined;
}): DreamDerivedIndexStatus => {
  if (input.explicitStatus !== undefined) {
    return input.explicitStatus;
  }

  if (input.rootHealth === "missing") {
    return "missing";
  }

  if (input.rootHealth === "unavailable") {
    return "unavailable";
  }

  if (input.derivedCount === undefined) {
    return "missing";
  }

  if (input.derivedCount >= input.authorityCount) {
    return "fresh";
  }

  return "stale";
};

const scanDerivedIndex = async (input: {
  readonly authorityCount: number;
  readonly checkedAt: string;
  readonly config: TrustedLocalDreamDerivedIndexConfig;
  readonly maxFiles: number;
}): Promise<DreamDerivedIndex> => {
  const rootScan =
    input.config.root === undefined
      ? undefined
      : await scanDirectory({
          includeExtensions: undefined,
          maxFiles: input.maxFiles,
          root: input.config.root,
        });
  const derivedCount = input.config.derivedCount ?? rootScan?.count;

  return {
    authorityCount: input.authorityCount,
    derivedCount,
    freshnessCheckedAt: input.checkedAt,
    indexId: input.config.indexId,
    indexKind: input.config.indexKind,
    status: derivedIndexStatusFor({
      authorityCount: input.authorityCount,
      derivedCount,
      explicitStatus: input.config.status,
      rootHealth: rootScan?.health,
    }),
  };
};

const blindSpotsFor = (input: {
  readonly derivedIndexes: readonly DreamDerivedIndex[];
  readonly scan: LocalFileScan;
  readonly sourceId: string;
}): string[] => {
  const blindSpots: string[] = [];

  if (input.scan.health === "missing") {
    blindSpots.push(
      `Authority source ${input.sourceId} is configured but missing from the trusted relay host.`
    );
  }

  if (input.scan.health === "stale") {
    blindSpots.push(
      `Authority source ${input.sourceId} exists but has no matching files.`
    );
  }

  if (input.scan.health === "unavailable") {
    blindSpots.push(
      `Authority source ${input.sourceId} could not be read by the trusted relay host.`
    );
  }

  if (input.scan.truncated) {
    blindSpots.push(
      `Authority source ${input.sourceId} hit the trusted relay scan cap.`
    );
  }

  for (const derivedIndex of input.derivedIndexes) {
    if (derivedIndex.status !== "fresh") {
      blindSpots.push(
        `Derived index ${derivedIndex.indexId} is ${derivedIndex.status}.`
      );
    }
  }

  return blindSpots;
};

const inventoryItemFor = async (input: {
  readonly checkedAt: string;
  readonly command: TrustedJoelClawSessionBridgeCommand | undefined;
  readonly fallbackScope: DreamSourceScope;
  readonly maxFiles: number;
  readonly sourceRoot: TrustedLocalDreamSourceRoot;
}): Promise<DreamSourceInventoryItem> => {
  const scan = await scanAuthorityRoot({
    command: input.command,
    includeExtensions: input.sourceRoot.includeExtensions,
    maxFiles: input.maxFiles,
    sourceRoot: input.sourceRoot,
  });
  const configuredDerivedIndexes = input.sourceRoot.derivedIndexes ?? [];
  const derivedIndexes =
    configuredDerivedIndexes.length === 0
      ? [
          missingDerivedIndexFor({
            checkedAt: input.checkedAt,
            count: scan.count,
            sourceId: input.sourceRoot.sourceId,
          }),
        ]
      : [];

  for (const derivedIndexConfig of configuredDerivedIndexes) {
    derivedIndexes.push(
      await scanDerivedIndex({
        authorityCount: scan.count,
        checkedAt: input.checkedAt,
        config: derivedIndexConfig,
        maxFiles: input.maxFiles,
      })
    );
  }

  return {
    adapter: {
      checkedAt: input.checkedAt,
      health: scan.health,
      port: TRUSTED_LOCAL_PORT,
    },
    authority: {
      count: scan.count,
      locatorHash: sha256Hex(
        `${input.sourceRoot.sourceId}:${input.sourceRoot.authorityRoot}`
      ),
      redactedLocator: redactedLocatorFor(input.sourceRoot.sourceId),
      sourceSystem: input.sourceRoot.sourceSystem,
    },
    blindSpots: blindSpotsFor({
      derivedIndexes,
      scan,
      sourceId: input.sourceRoot.sourceId,
    }),
    derivedIndexes,
    family: input.sourceRoot.family,
    freshness: {
      ...(scan.earliestAt === undefined ? {} : { earliestAt: scan.earliestAt }),
      indexedAt: input.checkedAt,
      ...(scan.latestAt === undefined ? {} : { latestAt: scan.latestAt }),
    },
    label: input.sourceRoot.label,
    privacyTier: input.sourceRoot.privacyTier,
    scope: sourceScopeFor({
      fallbackScope: input.fallbackScope,
      sourceRoot: input.sourceRoot,
    }),
    sourceId: input.sourceRoot.sourceId,
  };
};

const placeholderInventoryItemFor = (input: {
  readonly checkedAt: string;
  readonly fallbackScope: DreamSourceScope;
  readonly family: DreamSourceFamily;
}): DreamSourceInventoryItem => {
  const sourceId = `missing:${input.family}`;

  return {
    adapter: {
      checkedAt: input.checkedAt,
      health: "missing",
      port: TRUSTED_LOCAL_PORT,
    },
    authority: {
      count: 0,
      locatorHash: sha256Hex(sourceId),
      redactedLocator: redactedLocatorFor(sourceId),
      sourceSystem: "trusted-local:not-configured",
    },
    blindSpots: [
      `No trusted local source root is configured for expected source family ${input.family}.`,
    ],
    derivedIndexes: [
      missingDerivedIndexFor({
        checkedAt: input.checkedAt,
        count: 0,
        sourceId,
      }),
    ],
    family: input.family,
    freshness: {
      indexedAt: input.checkedAt,
    },
    label: `Missing ${input.family}`,
    privacyTier: "private",
    scope: input.fallbackScope,
    sourceId,
  };
};

const sourceMatchesRuntime = (input: {
  readonly runtime: DreamRuntime;
  readonly source: LocalSourceInventory;
}): boolean => {
  if (input.source.config.runtime === input.runtime) {
    return true;
  }

  return (
    input.runtime === "cloudflare" &&
    input.source.config.family === "cloudflare-runs"
  );
};

const minIso = (left: string | undefined, right: string | undefined) => {
  if (left === undefined) {
    return right;
  }

  if (right === undefined) {
    return left;
  }

  return left < right ? left : right;
};

const maxIso = (left: string | undefined, right: string | undefined) => {
  if (left === undefined) {
    return right;
  }

  if (right === undefined) {
    return left;
  }

  return left > right ? left : right;
};

const runtimeCoverageFor = (input: {
  readonly runtime: DreamRuntime;
  readonly sources: readonly LocalSourceInventory[];
}): DreamRuntimeCoverage => {
  const matchingSources = input.sources.filter((source) =>
    sourceMatchesRuntime({ runtime: input.runtime, source })
  );
  let count = 0;
  let earliestAt: string | undefined;
  let latestAt: string | undefined;
  let proofSource: LocalSourceInventory | undefined;
  let hasConfiguredNativeSource = false;

  for (const source of matchingSources) {
    hasConfiguredNativeSource = true;
    count += source.item.authority.count;
    earliestAt = minIso(earliestAt, source.item.freshness.earliestAt);
    latestAt = maxIso(latestAt, source.item.freshness.latestAt);
    if (proofSource === undefined && source.item.adapter.health === "healthy") {
      proofSource = source;
    }
  }

  if (count > 0 && proofSource !== undefined) {
    return {
      horizonCounts: [
        {
          ...(earliestAt === undefined ? {} : { earliestAt }),
          hitCount: count,
          horizon: "all-time",
          hydrationCount: 0,
          ...(latestAt === undefined ? {} : { latestAt }),
          queryCount: 0,
        },
      ],
      nativeProof: {
        evidenceRefs: [],
        ...(proofSource.item.authority.redactedLocator === undefined
          ? {}
          : { redactedLocator: proofSource.item.authority.redactedLocator }),
        sourceId: proofSource.item.sourceId,
      },
      runtime: input.runtime,
      sourceNative: true,
      status: "captured",
    };
  }

  if (hasConfiguredNativeSource) {
    return {
      horizonCounts: [],
      missingReason: `Trusted local ${input.runtime} source is configured but has no captured files.`,
      runtime: input.runtime,
      sourceNative: true,
      status: "stale",
    };
  }

  return {
    horizonCounts: [],
    missingReason: `Trusted local relay has no native ${input.runtime} source configured.`,
    runtime: input.runtime,
    sourceNative: false,
    status: "missing",
  };
};

const uniqueSourceFamilies = (
  families: readonly DreamSourceFamily[]
): DreamSourceFamily[] => {
  const seen = new Set<DreamSourceFamily>();
  const uniqueFamilies: DreamSourceFamily[] = [];

  for (const family of families) {
    if (seen.has(family)) {
      continue;
    }

    seen.add(family);
    uniqueFamilies.push(family);
  }

  return uniqueFamilies;
};

const expectedFamilySet = (
  families: readonly DreamSourceFamily[]
): ReadonlySet<DreamSourceFamily> => new Set(uniqueSourceFamilies(families));

const shouldIncludeSourceRoot = (input: {
  readonly expectedFamilies: ReadonlySet<DreamSourceFamily>;
  readonly sourceRoot: TrustedLocalDreamSourceRoot;
}): boolean => input.expectedFamilies.has(input.sourceRoot.family);

const missingExpectedFamilyItems = (input: {
  readonly checkedAt: string;
  readonly expectedFamilies: readonly DreamSourceFamily[];
  readonly fallbackScope: DreamSourceScope;
  readonly inventories: readonly LocalSourceInventory[];
}): DreamSourceInventoryItem[] => {
  const items: DreamSourceInventoryItem[] = [];

  for (const family of input.expectedFamilies) {
    const hasFamily = input.inventories.some(
      (inventory) => inventory.item.family === family
    );
    if (hasFamily) {
      continue;
    }

    items.push(
      placeholderInventoryItemFor({
        checkedAt: input.checkedAt,
        fallbackScope: input.fallbackScope,
        family,
      })
    );
  }

  return items;
};

const inventoryBlindSpotsFor = (input: {
  readonly runtimeCoverage: readonly DreamRuntimeCoverage[];
  readonly sources: readonly DreamSourceInventoryItem[];
}): string[] => {
  const blindSpots: string[] = [];

  for (const source of input.sources) {
    blindSpots.push(...source.blindSpots);
  }

  for (const coverage of input.runtimeCoverage) {
    if (coverage.status !== "captured") {
      blindSpots.push(
        `${coverage.runtime} native coverage is ${coverage.status}. ${coverage.missingReason ?? "The trusted relay must repair capture before Dream can treat it as source-native memory."}`
      );
    }
  }

  return blindSpots;
};

const failureMessagesFor = (
  inventory: DreamSourceInventoryDocument
): string[] => {
  const failures: string[] = [];

  for (const source of inventory.sources) {
    if (source.adapter.health !== "healthy") {
      failures.push(
        `Authority source ${source.sourceId} is ${source.adapter.health}.`
      );
    }

    for (const derivedIndex of source.derivedIndexes) {
      if (derivedIndex.status !== "fresh") {
        failures.push(
          `Derived index ${derivedIndex.indexId} is ${derivedIndex.status}.`
        );
      }
    }
  }

  for (const coverage of inventory.runtimeCoverage) {
    if (coverage.status !== "captured") {
      failures.push(
        `Runtime ${coverage.runtime} coverage is ${coverage.status}.`
      );
    }
  }

  return failures;
};

const indexHealthFor = (
  inventory: DreamSourceInventoryDocument
): DreamDerivedIndex[] => {
  const indexHealth: DreamDerivedIndex[] = [];

  for (const source of inventory.sources) {
    indexHealth.push(...source.derivedIndexes);
  }

  return indexHealth;
};

const healthStatusFor = (input: {
  readonly failures: readonly string[];
  readonly inventory: DreamSourceInventoryDocument;
}): DreamSourceHealthStatus => {
  const hasReadableAuthority = input.inventory.sources.some(
    (source) => source.adapter.health === "healthy"
  );

  if (!hasReadableAuthority) {
    return "blocked";
  }

  return input.failures.length === 0 ? "healthy" : "degraded";
};

const sourceFamilyPriority = (
  family: DreamSourceFamily
): DreamBackfillPlanAction["priority"] => {
  if (family === "agent-transcripts" || family === "cloudflare-runs") {
    return "high";
  }

  if (family === "brain" || family === "docs-pdf-brain") {
    return "medium";
  }

  return "low";
};

const backfillActionFor = (input: {
  readonly derivedIndex: DreamDerivedIndex;
  readonly source: DreamSourceInventoryItem;
}): DreamBackfillPlanAction => ({
  actionId: `backfill:${input.source.sourceId}:${input.derivedIndex.indexId}`,
  authoritySourceId: input.source.sourceId,
  controlledScriptRef: `joelclaw:dream/backfill/${input.source.sourceId}/${input.derivedIndex.indexId}`,
  derivedIndexId: input.derivedIndex.indexId,
  expectedAuthorityCount:
    input.derivedIndex.authorityCount ?? input.source.authority.count,
  priority: sourceFamilyPriority(input.source.family),
  reason: `Derived index ${input.derivedIndex.indexId} is ${input.derivedIndex.status}; authority has ${input.source.authority.count} item(s) and derived has ${input.derivedIndex.derivedCount ?? 0}.`,
  sourceFamily: input.source.family,
  timeWindow: {
    ...(input.source.freshness.earliestAt === undefined
      ? {}
      : { from: input.source.freshness.earliestAt }),
    ...(input.source.freshness.latestAt === undefined
      ? {}
      : { to: input.source.freshness.latestAt }),
  },
});

const sourceIdForRuntime = (input: {
  readonly coverage: DreamRuntimeCoverage;
  readonly inventory: DreamSourceInventoryDocument;
}): string => {
  if (input.coverage.nativeProof !== undefined) {
    return input.coverage.nativeProof.sourceId;
  }

  if (!input.coverage.sourceNative) {
    return `missing:${input.coverage.runtime}:native-source`;
  }

  const source = input.inventory.sources.find((candidate) => {
    if (
      input.coverage.runtime === "cloudflare" &&
      candidate.family === "cloudflare-runs"
    ) {
      return true;
    }

    return candidate.family === "agent-transcripts";
  });

  return source?.sourceId ?? `missing:${input.coverage.runtime}:native-source`;
};

const captureFixesFor = (
  inventory: DreamSourceInventoryDocument
): DreamCaptureFix[] => {
  const fixes: DreamCaptureFix[] = [];

  for (const coverage of inventory.runtimeCoverage) {
    if (coverage.status === "captured") {
      continue;
    }

    fixes.push({
      fixId: `capture:${coverage.runtime}:trusted-local-relay`,
      ownerRef: "system:joelclaw",
      reasonBackfillWasNeeded:
        coverage.missingReason ??
        `Native ${coverage.runtime} coverage was not captured by the trusted local relay.`,
      targetSourceId: sourceIdForRuntime({ coverage, inventory }),
    });
  }

  return fixes;
};

const backfillActionsFor = (
  inventory: DreamSourceInventoryDocument
): DreamBackfillPlanAction[] => {
  const actions: DreamBackfillPlanAction[] = [];

  for (const source of inventory.sources) {
    for (const derivedIndex of source.derivedIndexes) {
      if (derivedIndex.status === "fresh") {
        continue;
      }

      actions.push(backfillActionFor({ derivedIndex, source }));
    }
  }

  return actions;
};

const backfillPlanStatusFor = (input: {
  readonly actionCount: number;
  readonly captureFixCount: number;
  readonly healthStatus: DreamSourceHealthStatus;
}): "backfill-required" | "blocked" | "no-backfill-needed" => {
  if (input.healthStatus === "blocked") {
    return "blocked";
  }

  if (input.actionCount === 0 && input.captureFixCount === 0) {
    return "no-backfill-needed";
  }

  return "backfill-required";
};

const sourceRootForAction = (input: {
  readonly action: DreamBackfillPlanAction;
  readonly sourceRoots: readonly TrustedLocalDreamSourceRoot[];
}): TrustedLocalDreamSourceRoot | undefined =>
  input.sourceRoots.find(
    (sourceRoot) => sourceRoot.sourceId === input.action.authoritySourceId
  );

const derivedIndexConfigForAction = (input: {
  readonly action: DreamBackfillPlanAction;
  readonly sourceRoot: TrustedLocalDreamSourceRoot | undefined;
}): TrustedLocalDreamDerivedIndexConfig | undefined =>
  input.sourceRoot?.derivedIndexes?.find(
    (derivedIndex) => derivedIndex.indexId === input.action.derivedIndexId
  );

const backfillActionResultFor = (input: {
  readonly action: DreamBackfillPlanAction;
  readonly sourceRoots: readonly TrustedLocalDreamSourceRoot[];
}): DreamBackfillRunReceiptDocument["actionResults"][number] => {
  const sourceRoot = sourceRootForAction({
    action: input.action,
    sourceRoots: input.sourceRoots,
  });
  if (sourceRoot === undefined) {
    return {
      actionId: input.action.actionId,
      failures: [
        `No trusted local authority source is configured for ${input.action.authoritySourceId}.`,
      ],
      indexedCount: 0,
      skippedReasons: [],
      status: "blocked",
    };
  }

  if ((input.action.expectedAuthorityCount ?? 0) === 0) {
    return {
      actionId: input.action.actionId,
      failures: [],
      indexedCount: 0,
      skippedReasons: [
        "No authority records were available for this recovery action.",
      ],
      status: "skipped",
    };
  }

  const derivedIndex = derivedIndexConfigForAction({
    action: input.action,
    sourceRoot,
  });
  const writerReason =
    derivedIndex === undefined || derivedIndex.root === undefined
      ? "No controlled derived-index writer is registered for this action."
      : "The trusted relay can inspect this derived index, but this adapter has no controlled writer registered yet.";

  return {
    actionId: input.action.actionId,
    failures: [],
    indexedCount: 0,
    skippedReasons: [writerReason],
    status: "skipped",
  };
};

const captureFixResultFor = (input: {
  readonly fix: DreamCaptureFix;
  readonly sourceRoots: readonly TrustedLocalDreamSourceRoot[];
}): DreamBackfillRunReceiptDocument["captureFixResults"][number] => {
  const sourceRoot = input.sourceRoots.find(
    (candidate) => candidate.sourceId === input.fix.targetSourceId
  );
  if (sourceRoot === undefined) {
    return {
      failures: [
        `No trusted local capture source is configured for ${input.fix.targetSourceId}.`,
      ],
      fixId: input.fix.fixId,
      ownerRef: input.fix.ownerRef,
      repairAction:
        "Provision or repair the native capture adapter before treating this runtime as Dream-covered.",
      skippedReasons: [],
      status: "blocked",
      targetSourceId: input.fix.targetSourceId,
    };
  }

  return {
    failures: [],
    fixId: input.fix.fixId,
    ownerRef: input.fix.ownerRef,
    repairAction: `Repair native capture for ${sourceRoot.sourceSystem} so future Dream runs do not need recovery backfills for ${sourceRoot.sourceId}.`,
    skippedReasons: [
      "The trusted relay can identify this capture gap, but this adapter has no controlled capture-path repair writer registered yet.",
    ],
    status: "skipped",
    targetSourceId: input.fix.targetSourceId,
  };
};

const capturedRunPinFor = (input: {
  readonly capturedAt: string;
  readonly payload: DreamMemoryRelayCaptureRunPayload;
}) =>
  ArtifactPinSchema.parse({
    artifactRef: `artifact://trusted-dream-memory-relay/captures/${captureArtifactRefSegment(
      input.payload.sourceSystem
    )}/runs/${captureArtifactRefSegment(
      input.payload.targetRunId ?? input.payload.runId
    )}.json`,
    hash: hashJson({
      capturedAt: input.capturedAt,
      redacted: true,
      runId: input.payload.runId,
      schemaVersion: "dream.capture-target.run.v1",
      sourceSystem: input.payload.sourceSystem,
      targetRunId: input.payload.targetRunId ?? input.payload.runId,
      workItemId: input.payload.workItemId,
    }),
    mediaType: "application/json",
  });

const captureReceiptFor = (input: {
  readonly captureKind: DreamCaptureReceiptDocument["captureKind"];
  readonly capturedAt: string;
  readonly capturedRef: DreamCaptureReceiptDocument["capturedRef"];
  readonly payload:
    | DreamMemoryRelayCaptureArtifactPayload
    | DreamMemoryRelayCaptureRunPayload;
}): DreamCaptureReceiptDocument => {
  const baseReceipt = {
    capturedAt: input.capturedAt,
    capturedRef: input.capturedRef,
    readability: input.payload.readability,
    redacted: true,
    runId: input.payload.runId,
    schemaVersion: "dream.capture-receipt.v1",
    sourceSystem: input.payload.sourceSystem,
    workItemId: input.payload.workItemId,
  } as const;

  if (input.captureKind === "run") {
    const capturedRunId =
      "targetRunId" in input.payload && input.payload.targetRunId !== undefined
        ? input.payload.targetRunId
        : input.payload.runId;

    return DreamCaptureReceiptDocumentSchema.parse({
      ...baseReceipt,
      captureKind: "run",
      capturedRunId,
    });
  }

  return DreamCaptureReceiptDocumentSchema.parse({
    ...baseReceipt,
    captureKind: input.captureKind,
  });
};

export const createTrustedLocalDreamMemoryFabricAdapter = (
  config: TrustedLocalDreamMemoryFabricConfig
): DreamMemoryBackfillPort &
  DreamMemoryCapturePort &
  DreamMemoryFabricPort => ({
  captureArtifact(input) {
    const capturedAt = config.now?.() ?? new Date().toISOString();

    return Promise.resolve({
      document: captureReceiptFor({
        captureKind: "artifact",
        capturedAt,
        capturedRef: input.capturedRef,
        payload: input,
      }),
      status: "ready",
    });
  },
  captureRun(input) {
    const capturedAt = config.now?.() ?? new Date().toISOString();

    return Promise.resolve({
      document: captureReceiptFor({
        captureKind: "run",
        capturedAt,
        capturedRef:
          input.capturedRef ??
          capturedRunPinFor({ capturedAt, payload: input }),
        payload: input,
      }),
      status: "ready",
    });
  },
  checkSourceHealth(input) {
    const checkedAt = config.now?.() ?? new Date().toISOString();
    const failures = failureMessagesFor(input.inventory);
    const indexHealth = indexHealthFor(input.inventory);
    const status = healthStatusFor({
      failures,
      inventory: input.inventory,
    });

    return Promise.resolve({
      document: DreamSourceHealthDocumentSchema.parse({
        checkedAt,
        freshnessFailures: failures,
        indexHealth,
        inventoryRef: {
          artifactRef: input.inventoryRef,
          hash: hashJson(input.inventory),
          mediaType: "application/json",
        },
        redacted: true,
        runId: input.runId,
        schemaVersion: "dream.source-health.v1",
        status,
        summary:
          failures.length === 0
            ? "Trusted local Dream memory fabric reports all configured sources and derived indexes as healthy."
            : "Trusted local Dream memory fabric found missing, stale, or unavailable memory sources that require recovery.",
        workItemId: input.workItemId,
      }),
      status: "ready",
    });
  },
  async inventorySources(input) {
    const checkedAt = config.now?.() ?? new Date().toISOString();
    const expectedFamilies = uniqueSourceFamilies(input.sourceFamiliesExpected);
    const expectedFamiliesSet = expectedFamilySet(expectedFamilies);
    const fallbackScope = {
      organizationId: input.actor.organizationId,
      projectId: input.workItemId,
    };
    const inventories: LocalSourceInventory[] = [];

    for (const sourceRoot of config.sourceRoots) {
      if (
        !shouldIncludeSourceRoot({
          expectedFamilies: expectedFamiliesSet,
          sourceRoot,
        })
      ) {
        continue;
      }

      inventories.push({
        config: sourceRoot,
        item: await inventoryItemFor({
          checkedAt,
          command: config.sessionBridgeCommand,
          fallbackScope,
          maxFiles: config.maxFilesPerSource ?? DEFAULT_MAX_FILES_PER_SOURCE,
          sourceRoot,
        }),
      });
    }

    const sources = inventories.map((inventory) => inventory.item);
    sources.push(
      ...missingExpectedFamilyItems({
        checkedAt,
        expectedFamilies,
        fallbackScope,
        inventories,
      })
    );

    const runtimeCoverage = input.requiredRuntimes.map((runtime) =>
      runtimeCoverageFor({ runtime, sources: inventories })
    );

    return {
      document: DreamSourceInventoryDocumentSchema.parse({
        actor: input.actor,
        blindSpots: inventoryBlindSpotsFor({ runtimeCoverage, sources }),
        generatedAt: checkedAt,
        redacted: true,
        requiredRuntimes: input.requiredRuntimes,
        runId: input.runId,
        runtimeCoverage,
        schemaVersion: "dream.source-inventory.v1",
        scope: fallbackScope,
        sourceFamiliesExpected: input.sourceFamiliesExpected,
        sources,
        summary:
          "Trusted local Dream memory fabric inventoried configured authority roots with redacted locators and derived index freshness.",
        workItemId: input.workItemId,
      }),
      status: "ready",
    };
  },
  planBackfill(input) {
    const actions = backfillActionsFor(input.inventory);
    const captureFixes = captureFixesFor(input.inventory);
    const generatedAt = config.now?.() ?? new Date().toISOString();

    return Promise.resolve({
      document: DreamBackfillPlanDocumentSchema.parse({
        actions,
        captureFixes,
        generatedAt,
        healthRef: {
          artifactRef: input.healthRef,
          hash: hashJson(input.health),
          mediaType: "application/json",
        },
        inventoryRef: {
          artifactRef: input.inventoryRef,
          hash: hashJson(input.inventory),
          mediaType: "application/json",
        },
        mode: "recovery-not-normal-operation",
        redacted: true,
        runId: input.runId,
        schemaVersion: "dream.backfill-plan.v1",
        status: backfillPlanStatusFor({
          actionCount: actions.length,
          captureFixCount: captureFixes.length,
          healthStatus: input.health.status,
        }),
        summary:
          actions.length === 0 && captureFixes.length === 0
            ? "No trusted local Dream recovery backfill is required."
            : "Trusted local Dream memory fabric planned recovery-only backfills and capture fixes for memory gaps.",
        workItemId: input.workItemId,
      }),
      status: "ready",
    });
  },
  runBackfill(input) {
    const completedAt = config.now?.() ?? new Date().toISOString();

    return Promise.resolve({
      document: DreamBackfillRunReceiptDocumentSchema.parse({
        actionResults: input.plan.actions.map((action) =>
          backfillActionResultFor({
            action,
            sourceRoots: config.sourceRoots,
          })
        ),
        captureFixResults: input.plan.captureFixes.map((fix) =>
          captureFixResultFor({
            fix,
            sourceRoots: config.sourceRoots,
          })
        ),
        completedAt,
        planRef: {
          artifactRef: input.planRef,
          hash: hashJson(input.plan),
          mediaType: "application/json",
        },
        redacted: true,
        runId: input.runId,
        schemaVersion: "dream.backfill-run-receipt.v1",
        workItemId: input.workItemId,
      }),
      status: "ready",
    });
  },
});
