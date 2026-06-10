import { z } from "zod";

import type {
  ArtifactStoreContract,
  PackageRegistryActorContract,
} from "../application/ports.ts";
import { D1PackageRowSchema } from "../control-plane/d1-schema.ts";
import { hashJson } from "../domain/hash.ts";
import {
  PackageMetadataSchema,
  PinnedPackageSchema,
} from "../domain/schemas.ts";
import type {
  Actor,
  CapabilityBlocker,
  PackageMetadata,
  PinnedPackage,
} from "../domain/schemas.ts";

type D1QueryValue = null | number | string;

export interface D1ResultLike {
  readonly results?: readonly unknown[];
}

export interface D1RunResultLike {
  readonly success?: boolean;
}

export interface D1PreparedStatementLike {
  all(): Promise<D1ResultLike>;
  bind(...values: D1QueryValue[]): D1PreparedStatementLike;
  run(): Promise<D1RunResultLike>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
}

export interface CloudflareD1PackageRegistryConfig {
  readonly artifacts: Pick<ArtifactStoreContract, "readJson">;
  readonly d1: D1DatabaseLike;
  readonly manifestReadTimeoutMs?: number;
  readonly now?: () => string;
}

type D1PackageRow = ReturnType<typeof D1PackageRowSchema.parse>;

const defaultNow = (): string => new Date().toISOString();
const defaultManifestReadTimeoutMs = 15_000;

const withTimeout = async <Value>(
  promise: Promise<Value>,
  input: {
    readonly label: string;
    readonly timeoutMs: number;
  }
): Promise<Value> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  // oxlint-disable-next-line promise/avoid-new -- Workers have no built-in Promise timeout primitive.
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(
        new Error(
          `${input.label} timed out after ${String(input.timeoutMs)}ms.`
        )
      );
    }, input.timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
};

const blocker = (
  code: CapabilityBlocker["code"],
  message: string
): CapabilityBlocker => ({
  code,
  message,
  redacted: true,
});

const actorEntitlementSubjects = (
  actor: Actor
): { readonly subjectId: string; readonly subjectType: string }[] => [
  {
    subjectId: actor.id,
    subjectType: actor.type === "service" ? "service" : "actor",
  },
  {
    subjectId: actor.organizationId,
    subjectType: "organization",
  },
  ...actor.roleIds.map((roleId) => ({
    subjectId: roleId,
    subjectType: "role",
  })),
];

const subjectPredicateSql = (subjects: readonly unknown[]): string =>
  subjects.map(() => "(e.subject_type = ? and e.subject_id = ?)").join(" or ");

const parsePackageRow = (value: unknown): D1PackageRow => {
  const row = z.record(z.string(), z.unknown()).parse(value);
  const manifestHash =
    row["manifest_hash"] === null || row["manifest_hash"] === undefined
      ? {}
      : { manifest_hash: row["manifest_hash"] };

  return D1PackageRowSchema.parse({
    ...row,
    ...manifestHash,
  });
};

const validateManifestAgainstIndex = (input: {
  readonly manifest: PackageMetadata;
  readonly row: D1PackageRow;
}): void => {
  const { manifest, row } = input;
  if (
    manifest.packageId !== row.package_id ||
    manifest.latestArtifactRef !== row.artifact_ref ||
    manifest.latestVersion !== row.latest_version ||
    manifest.manifestPath !== row.manifest_path ||
    manifest.kind !== row.kind ||
    manifest.ownerRef !== row.owner_ref ||
    manifest.title !== row.title ||
    manifest.trustTier !== row.trust_tier
  ) {
    throw new Error(
      `Package manifest does not match D1 index row: ${row.package_id}`
    );
  }

  if (
    row.manifest_hash !== undefined &&
    hashJson(manifest) !== row.manifest_hash
  ) {
    throw new Error(`Package manifest hash mismatch: ${row.package_id}`);
  }
};

const packageIdsPredicateSql = (packageIds: readonly string[]): string =>
  packageIds.map(() => "?").join(", ");

const packageReadFailureBlocker = (
  packageId: string,
  error: unknown
): CapabilityBlocker =>
  blocker(
    "stale_package",
    `Package manifest could not be verified for ${packageId}: ${
      error instanceof Error ? error.message : String(error)
    }`
  );

export const createCloudflareD1PackageRegistryActor = (
  config: CloudflareD1PackageRegistryConfig
): PackageRegistryActorContract => {
  const now = config.now ?? defaultNow;

  const selectAuthorizedRows = async (input: {
    readonly actor: Actor;
    readonly entitlementColumn: "can_discover" | "can_mount";
    readonly packageIds?: readonly string[];
  }): Promise<D1PackageRow[]> => {
    const subjects = actorEntitlementSubjects(input.actor);
    const subjectValues = subjects.flatMap((subject) => [
      subject.subjectType,
      subject.subjectId,
    ]);
    const packageFilter =
      input.packageIds === undefined || input.packageIds.length === 0
        ? ""
        : `and p.package_id in (${packageIdsPredicateSql(input.packageIds)})`;
    const packageValues = input.packageIds ?? [];
    const result = await config.d1
      .prepare(
        `select distinct p.package_id, p.title, p.kind, p.owner_ref, p.latest_version, p.artifact_ref, p.manifest_path, p.manifest_hash, p.trust_tier
         from packages p
         inner join package_entitlements e on e.package_id = p.package_id
         where e.${input.entitlementColumn} = 1
           ${packageFilter}
           and (${subjectPredicateSql(subjects)})
         order by p.package_id`
      )
      .bind(...packageValues, ...subjectValues)
      .all();

    return (result.results ?? []).map(parsePackageRow);
  };

  const readManifest = async (row: D1PackageRow): Promise<PackageMetadata> => {
    const manifest = PackageMetadataSchema.parse(
      await withTimeout(
        config.artifacts.readJson({ artifactRef: row.artifact_ref }),
        {
          label: `Package manifest read for ${row.package_id}`,
          timeoutMs:
            config.manifestReadTimeoutMs ?? defaultManifestReadTimeoutMs,
        }
      )
    );
    validateManifestAgainstIndex({ manifest, row });

    return manifest;
  };

  return {
    async discoverMetadata(input): Promise<PackageMetadata[]> {
      const rows = await selectAuthorizedRows({
        actor: input.actor,
        entitlementColumn: "can_discover",
      });

      return await Promise.all(rows.map(readManifest));
    },

    async pinPackages(input) {
      const requestedPackageIds = [...new Set(input.packageIds)];
      if (requestedPackageIds.length !== input.packageIds.length) {
        return {
          blocker: blocker(
            "entitlement_missing",
            "Package pinning request contains duplicate package ids."
          ),
          status: "blocked",
        } as const;
      }

      const rows = await selectAuthorizedRows({
        actor: input.actor,
        entitlementColumn: "can_mount",
        packageIds: requestedPackageIds,
      });
      const rowsByPackageId = new Map(
        rows.map((row) => [row.package_id, row] as const)
      );
      const missingPackageIds = requestedPackageIds.filter(
        (packageId) => !rowsByPackageId.has(packageId)
      );
      if (missingPackageIds.length > 0) {
        return {
          blocker: blocker(
            "entitlement_missing",
            `Actor cannot mount requested packages: ${missingPackageIds.join(", ")}`
          ),
          status: "blocked",
        } as const;
      }

      const pinnedPackages: PinnedPackage[] = [];
      for (const packageId of requestedPackageIds) {
        const row = rowsByPackageId.get(packageId);
        if (row === undefined) {
          return {
            blocker: blocker(
              "entitlement_missing",
              `Actor cannot mount requested package: ${packageId}`
            ),
            status: "blocked",
          } as const;
        }

        let metadata: PackageMetadata;
        try {
          metadata = await readManifest(row);
        } catch (error) {
          return {
            blocker: packageReadFailureBlocker(packageId, error),
            status: "blocked",
          } as const;
        }

        const manifestHash = hashJson(metadata);
        pinnedPackages.push(
          PinnedPackageSchema.parse({
            artifactRef: metadata.latestArtifactRef,
            fileHashes: {
              [metadata.manifestPath]: manifestHash,
            },
            manifestHash,
            metadata,
            pinnedAt: now(),
            version: metadata.latestVersion,
          })
        );
      }

      return {
        pinnedPackages,
        status: "pinned",
      } as const;
    },
  };
};
