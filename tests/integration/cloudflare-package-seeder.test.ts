import { describe, expect, it } from "vitest";

import { hashJson } from "../../src/app/domain/hash.ts";
import { seedCloudflarePackages } from "../../src/app/infrastructure/cloudflare-package-seeder.ts";
import type { PackageManifestWriteInput } from "../../src/app/infrastructure/cloudflare-package-seeder.ts";

type D1QueryValue = null | number | string;

interface D1Operation {
  readonly query: string;
  readonly values: readonly D1QueryValue[];
}

interface FakeD1Statement {
  bind(...boundValues: D1QueryValue[]): FakeD1Statement;
  run(): Promise<{ readonly success: true }>;
}

const createFakeD1 = () => {
  const operations: D1Operation[] = [];

  return {
    d1: {
      prepare(query: string): FakeD1Statement {
        const statementFor = (
          values: readonly D1QueryValue[] = []
        ): FakeD1Statement => ({
          bind(...boundValues) {
            return statementFor(boundValues);
          },
          run() {
            operations.push({ query, values });

            return Promise.resolve({ success: true });
          },
        });

        return statementFor();
      },
    },
    operations,
  };
};

const createdRepoResult = (
  name: string
): Awaited<ReturnType<Artifacts["create"]>> => {
  const remote = `https://artifacts.example.invalid/${name}.git`;
  const result = {
    defaultBranch() {
      return "main";
    },
    description: null,
    id: `repo:${name}`,
    name,
    remote() {
      return remote;
    },
    token: `token:${name}`,
    tokenExpiresAt: "2026-06-08T23:00:00.000Z",
  };

  // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion -- The live Artifacts binding can return function-backed fields even though generated types say strings.
  return result as unknown as Awaited<ReturnType<Artifacts["create"]>>;
};

const createFakeArtifacts = () => {
  const createdRepos: string[] = [];
  const artifacts: Artifacts = {
    create(name, _options) {
      createdRepos.push(name);

      return Promise.resolve(createdRepoResult(name));
    },
    delete(_name) {
      return Promise.resolve(false);
    },
    get(name) {
      return Promise.resolve({
        createToken() {
          return Promise.resolve({
            expiresAt: "2026-06-08T23:00:00.000Z",
            id: `token:${name}`,
            plaintext: `token:${name}`,
            scope: "write",
          });
        },
        createdAt: "2026-06-08T22:00:00.000Z",
        defaultBranch: "main",
        description: null,
        fork() {
          return Promise.reject(new Error("fork not used in seed test"));
        },
        id: `repo:${name}`,
        lastPushAt: null,
        listTokens() {
          return Promise.resolve({ tokens: [], total: 0 });
        },
        name,
        readOnly: false,
        remote: `https://artifacts.example.invalid/${name}.git`,
        revokeToken() {
          return Promise.resolve(false);
        },
        source: null,
        updatedAt: "2026-06-08T22:00:00.000Z",
      });
    },
    import(_params) {
      return Promise.reject(new Error("import not used in seed test"));
    },
    list() {
      return Promise.resolve({ repos: [], total: 0 });
    },
  };

  return { artifacts, createdRepos };
};

describe("Cloudflare package seeder", () => {
  it("creates package Artifacts repos and D1 rows for core default packages", async () => {
    const fakeArtifacts = createFakeArtifacts();
    const fakeD1 = createFakeD1();
    const manifestWrites: PackageManifestWriteInput[] = [];

    const receipt = await seedCloudflarePackages(
      {
        artifacts: fakeArtifacts.artifacts,
        artifactsAccountId: "baac0d692a7fb14f11b159b48b13055e",
        artifactsNamespace: "default",
        d1: fakeD1.d1,
        writeManifest(input) {
          manifestWrites.push(input);

          return Promise.resolve(`commit:${input.manifest.packageId}`);
        },
      },
      {
        subjects: [
          {
            subjectId: "actor:seed-admin",
            subjectType: "actor",
          },
          {
            canInvoke: true,
            subjectId: "org:badass-courses",
            subjectType: "organization",
            versionRange: "^1.0.0",
          },
        ],
      }
    );

    const packageInsertOperations = fakeD1.operations.filter((operation) =>
      operation.query.includes("insert or replace into packages")
    );
    const entitlementInsertOperations = fakeD1.operations.filter((operation) =>
      operation.query.includes("insert or replace into package_entitlements")
    );

    expect({
      createdRepos: fakeArtifacts.createdRepos,
      entitlementWrites: entitlementInsertOperations.length,
      manifestRefs: receipt.packages.map(
        (packageReceipt) => packageReceipt.manifestArtifactRef
      ),
      packageHashes: receipt.packages.map(
        (packageReceipt, index) =>
          packageReceipt.manifestHash ===
          hashJson(manifestWrites[index]?.manifest)
      ),
      packageWrites: packageInsertOperations.length,
      seedCommitShas: receipt.packages.map(
        (packageReceipt) => packageReceipt.seedCommitSha
      ),
    }).toStrictEqual({
      createdRepos: [
        "pkg-badass-courses-claw-kernel",
        "pkg-joelhooks-configured-familiar-kernel",
        "pkg-workflow-research-review-discord",
      ],
      entitlementWrites: 6,
      manifestRefs: [
        "artifact://cloudflare-artifacts/pkg-badass-courses-claw-kernel/package.json",
        "artifact://cloudflare-artifacts/pkg-joelhooks-configured-familiar-kernel/package.json",
        "artifact://cloudflare-artifacts/pkg-workflow-research-review-discord/package.json",
      ],
      packageHashes: [true, true, true],
      packageWrites: 3,
      seedCommitShas: [
        "commit:badass-courses/claw-kernel",
        "commit:joelhooks/configured-familiar-kernel",
        "commit:workflow/research-review-discord",
      ],
    });
  });
});
