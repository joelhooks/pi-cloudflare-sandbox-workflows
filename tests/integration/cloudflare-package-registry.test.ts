import { describe, expect, it } from "vitest";

import { D1PackageRowSchema } from "../../src/app/control-plane/d1-schema.ts";
import { hashJson } from "../../src/app/domain/hash.ts";
import type { Actor, PackageMetadata } from "../../src/app/domain/schemas.ts";
import { createCloudflareD1PackageRegistryActor } from "../../src/app/infrastructure/cloudflare-package-registry.ts";
import { createMemoryArtifactStore } from "../../src/app/infrastructure/memory-adapters.ts";
import {
  integrationTestActor,
  integrationTestPackageMetadata,
} from "./workflow-app-fixtures.ts";

type D1QueryValue = null | number | string;
type D1PackageRow = ReturnType<typeof D1PackageRowSchema.parse>;

interface EntitlementRow {
  readonly can_discover: 0 | 1;
  readonly can_mount: 0 | 1;
  readonly package_id: string;
  readonly subject_id: string;
  readonly subject_type: "actor" | "organization" | "role" | "service";
}

interface D1ResultLike {
  readonly results?: readonly unknown[];
}

interface D1PreparedStatementLike {
  all(): Promise<D1ResultLike>;
  bind(...values: D1QueryValue[]): D1PreparedStatementLike;
  run(): Promise<{ readonly success: true }>;
}

const subjectTypes = new Set(["actor", "organization", "role", "service"]);

const packageRowFor = (
  metadata: PackageMetadata,
  manifestHash = hashJson(metadata)
): D1PackageRow =>
  D1PackageRowSchema.parse({
    artifact_ref: metadata.latestArtifactRef,
    kind: metadata.kind,
    latest_version: metadata.latestVersion,
    manifest_hash: manifestHash,
    manifest_path: metadata.manifestPath,
    owner_ref: metadata.ownerRef,
    package_id: metadata.packageId,
    title: metadata.title,
    trust_tier: metadata.trustTier,
  });

const queryRows = (input: {
  readonly entitlements: readonly EntitlementRow[];
  readonly packages: readonly D1PackageRow[];
  readonly query: string;
  readonly values: readonly D1QueryValue[];
}): readonly D1PackageRow[] => {
  const firstSubjectIndex = input.values.findIndex(
    (value) => typeof value === "string" && subjectTypes.has(value)
  );
  const packageIds =
    firstSubjectIndex === -1
      ? new Set<string>()
      : new Set(
          input.values
            .slice(0, firstSubjectIndex)
            .filter((value): value is string => typeof value === "string")
        );
  const subjects = new Set<string>();
  for (let index = firstSubjectIndex; index < input.values.length; index += 2) {
    const subjectType = input.values[index];
    const subjectId = input.values[index + 1];
    if (typeof subjectType === "string" && typeof subjectId === "string") {
      subjects.add(`${subjectType}:${subjectId}`);
    }
  }

  const entitlementFlag = input.query.includes("e.can_mount")
    ? "can_mount"
    : "can_discover";
  const entitledPackageIds = new Set(
    input.entitlements
      .filter((entitlement) => entitlement[entitlementFlag] === 1)
      .filter(
        (entitlement) =>
          packageIds.size === 0 || packageIds.has(entitlement.package_id)
      )
      .filter((entitlement) =>
        subjects.has(`${entitlement.subject_type}:${entitlement.subject_id}`)
      )
      .map((entitlement) => entitlement.package_id)
  );

  return input.packages
    .filter((row) => entitledPackageIds.has(row.package_id))
    .toSorted((left, right) => left.package_id.localeCompare(right.package_id));
};

const createFakeD1Database = (input: {
  readonly entitlements: readonly EntitlementRow[];
  readonly packages: readonly D1PackageRow[];
}) => ({
  prepare(query: string): D1PreparedStatementLike {
    const statementFor = (
      values: readonly D1QueryValue[] = []
    ): D1PreparedStatementLike => ({
      all() {
        return Promise.resolve({
          results: queryRows({
            entitlements: input.entitlements,
            packages: input.packages,
            query,
            values,
          }),
        });
      },
      bind(...boundValues: D1QueryValue[]) {
        return statementFor(boundValues);
      },
      run() {
        return Promise.resolve({ success: true });
      },
    });

    return statementFor();
  },
});

const seedPackageManifests = (
  artifacts: ReturnType<typeof createMemoryArtifactStore>,
  metadata: readonly PackageMetadata[]
): void => {
  for (const packageRecord of metadata) {
    artifacts.setJson(packageRecord.latestArtifactRef, packageRecord);
  }
};

const entitlementFor = (input: {
  readonly actor: Actor;
  readonly canMount?: 0 | 1;
  readonly packageId: string;
  readonly subject?: "actor" | "organization" | "role";
}): EntitlementRow => {
  const subject = input.subject ?? "actor";
  let subjectId = input.actor.id;
  if (subject === "organization") {
    subjectId = input.actor.organizationId;
  }
  if (subject === "role") {
    subjectId = input.actor.roleIds[0] ?? "missing-role";
  }

  return {
    can_discover: 1,
    can_mount: input.canMount ?? 1,
    package_id: input.packageId,
    subject_id: subjectId,
    subject_type: subject,
  };
};

const integrationTestPackageAt = (index: number): PackageMetadata => {
  const packageRecord = integrationTestPackageMetadata.at(index);
  if (packageRecord === undefined) {
    throw new Error(`Missing integration test package at index ${index}`);
  }

  return packageRecord;
};

describe("Cloudflare D1 package registry adapter", () => {
  it("discovers package metadata from entitled Artifacts manifests", async () => {
    const artifacts = createMemoryArtifactStore("cloudflare-package-registry");
    seedPackageManifests(artifacts, integrationTestPackageMetadata);
    const rows = integrationTestPackageMetadata.map((metadata) =>
      packageRowFor(metadata)
    );
    const registry = createCloudflareD1PackageRegistryActor({
      artifacts,
      d1: createFakeD1Database({
        entitlements: [
          entitlementFor({
            actor: integrationTestActor,
            packageId: integrationTestPackageAt(0).packageId,
          }),
          entitlementFor({
            actor: integrationTestActor,
            packageId: integrationTestPackageAt(1).packageId,
            subject: "organization",
          }),
          entitlementFor({
            actor: integrationTestActor,
            packageId: integrationTestPackageAt(2).packageId,
            subject: "role",
          }),
        ],
        packages: rows,
      }),
    });

    const discovered = await registry.discoverMetadata({
      actor: integrationTestActor,
    });

    expect({
      descriptions: discovered.map((metadata) => metadata.description),
      packageIds: discovered.map((metadata) => metadata.packageId),
      sourceObject: discovered.at(0),
    }).toStrictEqual({
      descriptions: integrationTestPackageMetadata
        .toSorted((left, right) =>
          left.packageId.localeCompare(right.packageId)
        )
        .map((metadata) => metadata.description),
      packageIds: integrationTestPackageMetadata
        .map((metadata) => metadata.packageId)
        .toSorted(),
      sourceObject: integrationTestPackageMetadata
        .toSorted((left, right) =>
          left.packageId.localeCompare(right.packageId)
        )
        .at(0),
    });
  });

  it("pins requested packages in request order with manifest hashes", async () => {
    const artifacts = createMemoryArtifactStore("cloudflare-package-registry");
    seedPackageManifests(artifacts, integrationTestPackageMetadata);
    const requested = [
      integrationTestPackageAt(2),
      integrationTestPackageAt(0),
    ];
    const registry = createCloudflareD1PackageRegistryActor({
      artifacts,
      d1: createFakeD1Database({
        entitlements: requested.map((metadata) =>
          entitlementFor({
            actor: integrationTestActor,
            packageId: metadata.packageId,
          })
        ),
        packages: integrationTestPackageMetadata.map((metadata) =>
          packageRowFor(metadata)
        ),
      }),
      now: () => "2026-06-08T22:00:00.000Z",
    });

    const result = await registry.pinPackages({
      actor: integrationTestActor,
      packageIds: requested.map((metadata) => metadata.packageId),
    });

    expect(result).toStrictEqual({
      pinnedPackages: requested.map((metadata) => ({
        artifactRef: metadata.latestArtifactRef,
        fileHashes: {
          [metadata.manifestPath]: hashJson(metadata),
        },
        manifestHash: hashJson(metadata),
        metadata,
        pinnedAt: "2026-06-08T22:00:00.000Z",
        version: metadata.latestVersion,
      })),
      status: "pinned",
    });
  });

  it("blocks mounting packages without mount entitlement", async () => {
    const artifacts = createMemoryArtifactStore("cloudflare-package-registry");
    seedPackageManifests(artifacts, integrationTestPackageMetadata);
    const packageRecord = integrationTestPackageAt(0);
    const registry = createCloudflareD1PackageRegistryActor({
      artifacts,
      d1: createFakeD1Database({
        entitlements: [
          entitlementFor({
            actor: integrationTestActor,
            canMount: 0,
            packageId: packageRecord.packageId,
          }),
        ],
        packages: [packageRowFor(packageRecord)],
      }),
    });

    const result = await registry.pinPackages({
      actor: integrationTestActor,
      packageIds: [packageRecord.packageId],
    });

    expect(result).toStrictEqual({
      blocker: {
        code: "entitlement_missing",
        message: `Actor cannot mount requested packages: ${packageRecord.packageId}`,
        redacted: true,
      },
      status: "blocked",
    });
  });

  it("blocks stale package rows when the Artifacts manifest hash changes", async () => {
    const artifacts = createMemoryArtifactStore("cloudflare-package-registry");
    seedPackageManifests(artifacts, integrationTestPackageMetadata);
    const packageRecord = integrationTestPackageAt(0);
    const registry = createCloudflareD1PackageRegistryActor({
      artifacts,
      d1: createFakeD1Database({
        entitlements: [
          entitlementFor({
            actor: integrationTestActor,
            packageId: packageRecord.packageId,
          }),
        ],
        packages: [packageRowFor(packageRecord, "0".repeat(64))],
      }),
    });

    const result = await registry.pinPackages({
      actor: integrationTestActor,
      packageIds: [packageRecord.packageId],
    });

    expect(result).toStrictEqual({
      blocker: {
        code: "stale_package",
        message: `Package manifest could not be verified for ${packageRecord.packageId}: Package manifest hash mismatch: ${packageRecord.packageId}`,
        redacted: true,
      },
      status: "blocked",
    });
  });

  it("blocks package pinning when a manifest read times out", async () => {
    const packageRecord = integrationTestPackageAt(0);
    const registry = createCloudflareD1PackageRegistryActor({
      artifacts: {
        readJson: () => Promise.race([]),
      },
      d1: createFakeD1Database({
        entitlements: [
          entitlementFor({
            actor: integrationTestActor,
            packageId: packageRecord.packageId,
          }),
        ],
        packages: [packageRowFor(packageRecord)],
      }),
      manifestReadTimeoutMs: 1,
    });

    const result = await registry.pinPackages({
      actor: integrationTestActor,
      packageIds: [packageRecord.packageId],
    });

    expect(result).toStrictEqual({
      blocker: {
        code: "stale_package",
        message: `Package manifest could not be verified for ${packageRecord.packageId}: Package manifest read for ${packageRecord.packageId} timed out after 1ms.`,
        redacted: true,
      },
      status: "blocked",
    });
  });
});
