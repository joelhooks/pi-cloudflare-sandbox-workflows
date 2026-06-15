import { describe, expect, it } from "vitest";

import {
  liveRunOperatorSubjectId,
  packageSeedSubjects,
} from "../../scripts/workflow-live-subjects.mjs";
import { hashJson } from "../../src/app/domain/hash.ts";
import type { Actor, PackageMetadata } from "../../src/app/domain/schemas.ts";
import { createCloudflareD1PackageRegistryActor } from "../../src/app/infrastructure/cloudflare-package-registry.ts";
import { finalizeCloudflarePackageSeed } from "../../src/app/infrastructure/cloudflare-package-seeder.ts";
import { createMemoryArtifactStore } from "../../src/app/infrastructure/memory-adapters.ts";
import { integrationTestMemoryWorkflowPackageMetadata } from "./workflow-app-fixtures.ts";

// Wound #40: the deploy-seed granted entitlements to `actor:operator`, but a live
// submitted run executes as `actor:workflow-live-operator` (the actor built by
// `actorForLiveRun` in `workflow-app-run.ts`, whose id is now the shared
// `liveRunOperatorSubjectId`). The two identities were hardcoded independently and
// drifted, so a freshly-seeded cartridge was silently un-mountable live despite a
// green seed receipt. This is a HOSTILE transport double, not a polite mock: the
// REAL seeder (`finalizeCloudflarePackageSeed` → `upsertEntitlements`) writes rows
// through the production insert column-order, and the REAL registry
// (`createCloudflareD1PackageRegistryActor` → mount-check SELECT) reads them back
// through the production subject-predicate join. Nothing pre-stages the rows; the
// seed→mount handoff is exercised end to end. If the seeded subject set and the
// executing actor identity drift apart again, this test goes red.

type D1QueryValue = null | number | string;
type PackageColumn =
  | "artifact_ref"
  | "kind"
  | "latest_version"
  | "manifest_hash"
  | "manifest_path"
  | "owner_ref"
  | "package_id"
  | "title"
  | "trust_tier";
type PackageRow = Record<PackageColumn, D1QueryValue>;

interface EntitlementRow {
  readonly can_discover: 0 | 1;
  readonly can_invoke: 0 | 1;
  readonly can_mount: 0 | 1;
  readonly package_id: string;
  readonly subject_id: string;
  readonly subject_type: string;
  readonly version_range: string;
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

/**
 * Mutable D1 double that the real seeder writes into and the real registry reads
 * from, reproducing the production transport contract on both ends:
 * - entitlement insert column-order `(subject_type, subject_id, package_id,
 *   version_range, can_discover, can_mount, can_invoke)`
 * - the mount-check SELECT's package-id filter + subject-predicate bind layout
 */
const createMutableD1 = () => {
  const packageRows = new Map<string, PackageRow>();
  const entitlementRows = new Map<string, EntitlementRow>();

  const applyPackageInsert = (values: readonly D1QueryValue[]): void => {
    const row: PackageRow = {
      artifact_ref: values[5] ?? null,
      kind: values[2] ?? null,
      latest_version: values[4] ?? null,
      manifest_hash: values[7] ?? null,
      manifest_path: values[6] ?? null,
      owner_ref: values[3] ?? null,
      package_id: values[0] ?? null,
      title: values[1] ?? null,
      trust_tier: values[8] ?? null,
    };
    packageRows.set(String(row.package_id), row);
  };

  const applyEntitlementInsert = (values: readonly D1QueryValue[]): void => {
    const [
      subjectType,
      subjectId,
      packageId,
      versionRange,
      canDiscover,
      canMount,
      canInvoke,
    ] = values;
    const row: EntitlementRow = {
      can_discover: canDiscover === 1 ? 1 : 0,
      can_invoke: canInvoke === 1 ? 1 : 0,
      can_mount: canMount === 1 ? 1 : 0,
      package_id: String(packageId),
      subject_id: String(subjectId),
      subject_type: String(subjectType),
      version_range: String(versionRange),
    };
    entitlementRows.set(
      `${row.subject_type}:${row.subject_id}:${row.package_id}`,
      row
    );
  };

  const selectAuthorizedPackages = (
    query: string,
    values: readonly D1QueryValue[]
  ): readonly PackageRow[] => {
    const entitlementColumn: "can_discover" | "can_mount" = query.includes(
      "e.can_mount"
    )
      ? "can_mount"
      : "can_discover";
    const firstSubjectIndex = values.findIndex(
      (value) => typeof value === "string" && subjectTypes.has(value)
    );
    const packageIdFilter =
      firstSubjectIndex === -1
        ? new Set<string>()
        : new Set(
            values
              .slice(0, firstSubjectIndex)
              .filter((value): value is string => typeof value === "string")
          );
    const subjects = new Set<string>();
    for (
      let index = firstSubjectIndex;
      index !== -1 && index < values.length;
      index += 2
    ) {
      const subjectType = values[index];
      const subjectId = values[index + 1];
      if (typeof subjectType === "string" && typeof subjectId === "string") {
        subjects.add(`${subjectType}:${subjectId}`);
      }
    }

    const authorizedPackageIds = new Set(
      [...entitlementRows.values()]
        .filter((entitlement) => entitlement[entitlementColumn] === 1)
        .filter(
          (entitlement) =>
            packageIdFilter.size === 0 ||
            packageIdFilter.has(entitlement.package_id)
        )
        .filter((entitlement) =>
          subjects.has(`${entitlement.subject_type}:${entitlement.subject_id}`)
        )
        .map((entitlement) => entitlement.package_id)
    );

    return [...packageRows.values()]
      .filter((row) => authorizedPackageIds.has(String(row.package_id)))
      .toSorted((left, right) =>
        String(left.package_id).localeCompare(String(right.package_id))
      );
  };

  const database = {
    prepare(query: string): D1PreparedStatementLike {
      const statementFor = (
        values: readonly D1QueryValue[] = []
      ): D1PreparedStatementLike => ({
        all() {
          return Promise.resolve({
            results: selectAuthorizedPackages(query, values),
          });
        },
        bind(...boundValues: D1QueryValue[]) {
          return statementFor(boundValues);
        },
        run() {
          if (query.includes("insert or replace into package_entitlements")) {
            applyEntitlementInsert(values);
          } else if (query.includes("insert or replace into packages")) {
            applyPackageInsert(values);
          }

          return Promise.resolve({ success: true });
        },
      });

      return statementFor();
    },
  };

  return { database };
};

const seedPackageMetadata: PackageMetadata =
  integrationTestMemoryWorkflowPackageMetadata;

const finalizePackage = {
  defaultBranch: "main",
  manifest: seedPackageMetadata,
  manifestArtifactRef:
    "artifact://cloudflare-artifacts/pkg-workflow-memory-fabric/package.json",
  manifestHash: hashJson(seedPackageMetadata),
  remote: "https://artifacts.example.invalid/pkg-workflow-memory-fabric.git",
  repoName: "pkg-workflow-memory-fabric",
  seedCommitSha: "commit:wound-40-test",
  status: "created" as const,
};

// Faithful copy of the actor `actorForLiveRun` builds in `workflow-app-run.ts`:
// the id is the SHARED `liveRunOperatorSubjectId`, the same constant the submit
// path uses, so the test and production cannot disagree on the executing identity.
const liveRunActor: Actor = {
  id: liveRunOperatorSubjectId,
  organizationId: "org:joelhooks",
  roleIds: ["workflow.operator", "wzrrd.publish"],
  sessionId: "session:wound-40",
  trustTier: "reviewed",
  type: "agent",
};

interface SeedSubjectInput {
  readonly canDiscover?: boolean;
  readonly canInvoke?: boolean;
  readonly canMount?: boolean;
  readonly subjectId: string;
  readonly subjectType: string;
  readonly versionRange?: string;
}

const seedThenMount = async (subjects: readonly SeedSubjectInput[]) => {
  const { database } = createMutableD1();
  const artifacts = createMemoryArtifactStore(
    "package-seed-live-operator-entitlement"
  );
  artifacts.setJson(seedPackageMetadata.latestArtifactRef, seedPackageMetadata);

  await finalizeCloudflarePackageSeed(
    { d1: database },
    { packages: [finalizePackage], subjects }
  );

  const registry = createCloudflareD1PackageRegistryActor({
    artifacts,
    d1: database,
    now: () => "2026-06-14T18:00:00.000Z",
  });

  return await registry.pinPackages({
    actor: liveRunActor,
    packageIds: [seedPackageMetadata.packageId],
  });
};

describe("Wound #40: seed-subject drift — live-run actor entitlement", () => {
  it("grants the live-run operator mount via the shared seed subject set", async () => {
    // The shared subject builder must include the live-run operator with mount.
    expect(
      packageSeedSubjects().some(
        (subject) =>
          subject.subjectId === liveRunOperatorSubjectId &&
          subject.subjectType === "actor" &&
          subject.canMount
      )
    ).toBeTruthy();

    const result = await seedThenMount(packageSeedSubjects());

    expect(result).toStrictEqual({
      pinnedPackages: [
        {
          artifactRef: seedPackageMetadata.latestArtifactRef,
          fileHashes: {
            [seedPackageMetadata.manifestPath]: hashJson(seedPackageMetadata),
          },
          manifestHash: hashJson(seedPackageMetadata),
          metadata: seedPackageMetadata,
          pinnedAt: "2026-06-14T18:00:00.000Z",
          version: seedPackageMetadata.latestVersion,
        },
      ],
      status: "pinned",
    });
  });

  it("blocks the live-run operator when the seed grants only actor:operator (the wound)", async () => {
    // The pre-fix seed body: operator subject only, relying on schema defaults.
    const result = await seedThenMount([
      { subjectId: "actor:operator", subjectType: "actor" },
    ]);

    expect(result).toStrictEqual({
      blocker: {
        code: "entitlement_missing",
        message: `Actor cannot mount requested packages: ${seedPackageMetadata.packageId}`,
        redacted: true,
      },
      status: "blocked",
    });
  });
});
