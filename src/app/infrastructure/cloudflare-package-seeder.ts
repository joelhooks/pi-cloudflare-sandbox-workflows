/// <reference types="@cloudflare/workers-types" />

import {
  add,
  branch as gitBranch,
  clone,
  commit as gitCommit,
  currentBranch,
  init as gitInit,
  push,
} from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { z } from "zod";

import {
  D1EntitlementRowSchema,
  D1PackageRowSchema,
} from "../control-plane/d1-schema.ts";
import { hashJson } from "../domain/hash.ts";
import { ArtifactRefSchema, PackageMetadataSchema } from "../domain/schemas.ts";
import type { PackageMetadata } from "../domain/schemas.ts";
import {
  cloudflareArtifactsGitRemoteForRepo,
  resolveArtifactsRepoGitFields,
} from "./cloudflare-artifacts-repo-fields.ts";
import { GitMemoryFS } from "./git-memory-fs.ts";

type D1QueryValue = null | number | string;

interface D1RunResultLike {
  readonly success?: boolean;
}

interface D1PreparedStatementLike {
  bind(...values: D1QueryValue[]): D1PreparedStatementLike;
  run(): Promise<D1RunResultLike>;
}

interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
}

export interface CloudflarePackageSeederConfig {
  readonly artifacts: Artifacts;
  readonly artifactsAccountId?: string | undefined;
  readonly artifactsNamespace?: string | undefined;
  readonly d1: D1DatabaseLike;
  readonly tokenTtlSeconds?: number;
  readonly writeManifest?: (
    input: PackageManifestWriteInput
  ) => Promise<string>;
}

export type PackageSeedReceipt = z.infer<typeof PackageSeedReceiptSchema>;
export type PackageSeedPreparationReceipt = z.infer<
  typeof PackageSeedPreparationReceiptSchema
>;

export interface PackageManifestWriteInput {
  readonly defaultBranch: string;
  readonly manifest: PackageMetadata;
  readonly remote: string;
  readonly status: "created" | "updated";
  readonly token: string;
}

const defaultTokenTtlSeconds = 900;
const defaultPackageBranch = "main";
const packageManifestPath = "package.json";
const repoNamePattern = /^[A-Za-z0-9._-]+$/u;

export const PackageSeedSubjectSchema = z.object({
  canDiscover: z.boolean().default(true),
  canInvoke: z.boolean().default(false),
  canMount: z.boolean().default(true),
  subjectId: z.string().min(1),
  subjectType: z.enum(["actor", "organization", "role", "service"]),
  versionRange: z.string().min(1).default("*"),
});

export const PackageSeedTemplateSchema = PackageMetadataSchema.omit({
  latestArtifactRef: true,
}).extend({
  repoName: z.string().regex(repoNamePattern),
});
export type PackageSeedTemplate = z.infer<typeof PackageSeedTemplateSchema>;

export const DefaultPackageSeedTemplatesSchema = z
  .array(PackageSeedTemplateSchema)
  .min(1);

export const defaultPackageSeedTemplates =
  DefaultPackageSeedTemplatesSchema.parse([
    {
      description:
        "Default operating law, receipt-first behavior, package mount rules, and capability lease vocabulary.",
      exports: [
        {
          contractRef: "contract://claw-kernel/operator-law.v1",
          exportId: "operator-law",
          kind: "prompt",
        },
        {
          // Fixture kernel skill proving the kernel-consumption wire end to end.
          // The planner prompt builder reads this body into a real "Kernel
          // Skills" section and the agentic node-adapter input carries it; the
          // next stage replaces this placeholder with authored workflow-design /
          // analysis skills. Keep it minimal but real so a pinned claw-kernel
          // always exercises the consumption path.
          contractRef: "contract://claw-kernel/workflow-shape-skill.v1",
          exportId: "workflow-shape-skill",
          kind: "skill",
          skill: {
            body: [
              "# Dream Workflow Shape",
              "",
              "Shape a transcript-review dream as a deterministic envelope around stochastic reasoning:",
              "search -> hydrate -> correlate -> propose-refinements -> hitl-report -> STOP.",
              "Fan out source families in the search node; fan in receipts at hydrate.",
              "Never render a confident review over a primary source that resolved zero receipts;",
              "block instead. Capture the generated machine as durable memory before the report.",
            ].join("\n"),
            skillId: "dream.workflow-shape",
            title: "Dream Workflow Shape",
          },
        },
      ],
      kind: "kernel",
      latestVersion: "1.0.0",
      manifestPath: packageManifestPath,
      ownerRef: "org:badass-courses",
      packageId: "badass-courses/claw-kernel",
      repoName: "pkg-badass-courses-claw-kernel",
      title: "Claw Kernel",
      trustTier: "reviewed",
    },
    {
      description:
        "Configured familiar identity, voice, memory habits, adapter rules, and personal kernel overlays.",
      exports: [
        {
          contractRef: "contract://joelhooks/kernel-overlay.v1",
          exportId: "kernel-overlay",
          kind: "prompt",
        },
      ],
      kind: "kernel",
      latestVersion: "1.0.0",
      manifestPath: packageManifestPath,
      ownerRef: "user:joel",
      packageId: "joelhooks/configured-familiar-kernel",
      repoName: "pkg-joelhooks-configured-familiar-kernel",
      title: "Configured Familiar Kernel",
      trustTier: "reviewed",
    },
    {
      description:
        "Research/review workflow with optional Discord notification through a capability lease.",
      exports: [
        {
          contractRef: "contract://workflow/research-review-discord.v1",
          exportId: "research-review-discord",
          kind: "workflow",
        },
      ],
      kind: "workflow-pack",
      latestVersion: "1.0.0",
      manifestPath: packageManifestPath,
      ownerRef: "org:badass-courses",
      packageId: "workflow/research-review-discord",
      repoName: "pkg-workflow-research-review-discord",
      title: "Research Review Discord Workflow",
      trustTier: "reviewed",
    },
  ]);

export const PackageSeedRequestSchema = z.object({
  packages: z
    .array(PackageSeedTemplateSchema)
    .default(defaultPackageSeedTemplates),
  subjects: z.array(PackageSeedSubjectSchema).min(1),
});

export const PackageSeedReceiptSchema = z.object({
  packages: z
    .array(
      z.object({
        entitlementCount: z.number().int().min(0),
        manifestArtifactRef: ArtifactRefSchema,
        manifestHash: z.string().regex(/^[a-f0-9]{64}$/u),
        packageId: z.string().min(1),
        repoName: z.string().regex(repoNamePattern),
        seedCommitSha: z.string().min(1),
        status: z.enum(["created", "updated"]),
      })
    )
    .min(1),
  schemaVersion: z.literal("workflow.package-seed.v1"),
});

export const PackageSeedPreparedPackageSchema = z.object({
  defaultBranch: z.string().min(1),
  manifest: PackageMetadataSchema,
  manifestArtifactRef: ArtifactRefSchema,
  manifestHash: z.string().regex(/^[a-f0-9]{64}$/u),
  remote: z.url(),
  repoName: z.string().regex(repoNamePattern),
  status: z.enum(["created", "updated"]),
  writeToken: z.string().min(1),
});

export const PackageSeedPreparationReceiptSchema = z.object({
  packages: z.array(PackageSeedPreparedPackageSchema).min(1),
  schemaVersion: z.literal("workflow.package-seed-preparation.v1"),
  subjects: z.array(PackageSeedSubjectSchema).min(1),
});

export const PackageSeedFinalizeRequestSchema = z.object({
  packages: z
    .array(
      PackageSeedPreparedPackageSchema.omit({
        writeToken: true,
      }).extend({
        seedCommitSha: z.string().min(1),
      })
    )
    .min(1),
  subjects: z.array(PackageSeedSubjectSchema).min(1),
});

const packageArtifactRefFor = (input: {
  readonly manifestPath: string;
  readonly repoName: string;
}) =>
  ArtifactRefSchema.parse(
    `artifact://cloudflare-artifacts/${input.repoName}/${input.manifestPath}`
  );

export const packageMetadataForSeedTemplate = (
  template: z.infer<typeof PackageSeedTemplateSchema>
): PackageMetadata =>
  PackageMetadataSchema.parse({
    ...template,
    latestArtifactRef: packageArtifactRefFor({
      manifestPath: template.manifestPath,
      repoName: template.repoName,
    }),
  });

const isArtifactsErrorCode = (
  error: unknown,
  code: string
): error is { readonly code: string } =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { readonly code?: unknown }).code === code;

const assertD1Write = async (
  statement: D1PreparedStatementLike,
  message: string
): Promise<void> => {
  const result = await statement.run();
  if (result.success === false) {
    throw new Error(message);
  }
};

const ensurePackageRepo = async (input: {
  readonly artifactsAccountId?: string | undefined;
  readonly artifactsNamespace?: string | undefined;
  readonly artifacts: Artifacts;
  readonly description: string;
  readonly repoName: string;
  readonly tokenTtlSeconds: number;
}): Promise<{
  readonly defaultBranch: string;
  readonly remote: string;
  readonly status: "created" | "updated";
  readonly token: string;
}> => {
  try {
    const created = await input.artifacts.create(input.repoName, {
      description: input.description,
      readOnly: false,
      setDefaultBranch: defaultPackageBranch,
    });
    const remote =
      input.artifactsAccountId === undefined
        ? undefined
        : cloudflareArtifactsGitRemoteForRepo({
            accountId: input.artifactsAccountId,
            namespace: input.artifactsNamespace,
            repoName: input.repoName,
          });
    const gitFields = resolveArtifactsRepoGitFields(created, {
      defaultBranch: defaultPackageBranch,
      remote,
    });

    return {
      defaultBranch: gitFields.defaultBranch,
      remote: gitFields.remote,
      status: "created",
      token: created.token,
    };
  } catch (error) {
    if (!isArtifactsErrorCode(error, "ALREADY_EXISTS")) {
      throw error;
    }

    const repo = await input.artifacts.get(input.repoName);
    const token = await repo.createToken("write", input.tokenTtlSeconds);
    const remote =
      input.artifactsAccountId === undefined
        ? undefined
        : cloudflareArtifactsGitRemoteForRepo({
            accountId: input.artifactsAccountId,
            namespace: input.artifactsNamespace,
            repoName: input.repoName,
          });
    const gitFields = resolveArtifactsRepoGitFields(repo, {
      defaultBranch: defaultPackageBranch,
      remote,
    });

    return {
      defaultBranch: gitFields.defaultBranch,
      remote: gitFields.remote,
      status: "updated",
      token: token.plaintext,
    };
  }
};

const isMissingDefaultBranchError = (error: unknown): boolean =>
  /Could not find .+\.$/u.test(
    error instanceof Error ? error.message : String(error)
  );

const initializePackageManifestRepo = async (input: {
  readonly defaultBranch: string;
  readonly dir: string;
  readonly fs: GitMemoryFS;
}): Promise<void> => {
  await input.fs.promises.mkdir(input.dir, { recursive: true });
  await gitInit({
    defaultBranch: input.defaultBranch,
    dir: input.dir,
    fs: input.fs,
  });
};

const clonePackageManifestRepo = async (input: {
  readonly defaultBranch: string;
  readonly dir: string;
  readonly fs: GitMemoryFS;
  readonly remote: string;
  readonly token: string;
}): Promise<void> => {
  try {
    await input.fs.promises.mkdir(input.dir, { recursive: true });
    await clone({
      dir: input.dir,
      fs: input.fs,
      http,
      onAuth: () => ({ password: input.token, username: "x" }),
      ref: input.defaultBranch,
      singleBranch: true,
      url: input.remote,
    });
  } catch (error) {
    if (!isMissingDefaultBranchError(error)) {
      throw error;
    }

    await initializePackageManifestRepo(input);
  }
};

const ensurePackageManifestBranch = async (input: {
  readonly defaultBranch: string;
  readonly dir: string;
  readonly fs: GitMemoryFS;
}): Promise<void> => {
  const current = await currentBranch({
    dir: input.dir,
    fs: input.fs,
    fullname: false,
  }).catch(() => null);
  if (current === input.defaultBranch) {
    return;
  }

  await gitBranch({
    checkout: true,
    dir: input.dir,
    fs: input.fs,
    ref: input.defaultBranch,
  });
};

const writePackageManifest = async (
  input: PackageManifestWriteInput
): Promise<string> => {
  const dir = "/package-seed";
  const fs = new GitMemoryFS();
  await (input.status === "created"
    ? initializePackageManifestRepo({
        defaultBranch: input.defaultBranch,
        dir,
        fs,
      })
    : clonePackageManifestRepo({
        defaultBranch: input.defaultBranch,
        dir,
        fs,
        remote: input.remote,
        token: input.token,
      }));
  await ensurePackageManifestBranch({
    defaultBranch: input.defaultBranch,
    dir,
    fs,
  });

  await fs.promises.writeFile(
    `${dir}/${packageManifestPath}`,
    `${JSON.stringify(input.manifest, null, 2)}\n`
  );
  await add({ dir, filepath: packageManifestPath, fs });
  const commitSha = await gitCommit({
    author: {
      email: "pi-workflow-package-seeder@example.invalid",
      name: "pi-workflow-package-seeder",
    },
    dir,
    fs,
    message: `package seed: ${input.manifest.packageId}@${input.manifest.latestVersion}`,
  });
  await push({
    dir,
    fs,
    http,
    onAuth: () => ({ password: input.token, username: "x" }),
    ref: input.defaultBranch,
    url: input.remote,
  });

  return commitSha;
};

const upsertPackageRow = async (input: {
  readonly d1: D1DatabaseLike;
  readonly manifestHash: string;
  readonly metadata: PackageMetadata;
}): Promise<void> => {
  const row = D1PackageRowSchema.parse({
    artifact_ref: input.metadata.latestArtifactRef,
    kind: input.metadata.kind,
    latest_version: input.metadata.latestVersion,
    manifest_hash: input.manifestHash,
    manifest_path: input.metadata.manifestPath,
    owner_ref: input.metadata.ownerRef,
    package_id: input.metadata.packageId,
    title: input.metadata.title,
    trust_tier: input.metadata.trustTier,
  });
  await assertD1Write(
    input.d1
      .prepare(
        `insert or replace into packages
          (package_id, title, kind, owner_ref, latest_version, artifact_ref, manifest_path, manifest_hash, trust_tier, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
      )
      .bind(
        row.package_id,
        row.title,
        row.kind,
        row.owner_ref,
        row.latest_version,
        row.artifact_ref,
        row.manifest_path,
        row.manifest_hash ?? null,
        row.trust_tier
      ),
    "Package seed row could not be persisted."
  );
};

const upsertEntitlements = async (input: {
  readonly d1: D1DatabaseLike;
  readonly packageId: string;
  readonly subjects: readonly z.infer<typeof PackageSeedSubjectSchema>[];
}): Promise<void> => {
  for (const subject of input.subjects) {
    const row = D1EntitlementRowSchema.parse({
      can_discover: subject.canDiscover ? 1 : 0,
      can_invoke: subject.canInvoke ? 1 : 0,
      can_mount: subject.canMount ? 1 : 0,
      package_id: input.packageId,
      subject_id: subject.subjectId,
      subject_type: subject.subjectType,
      version_range: subject.versionRange,
    });
    await assertD1Write(
      input.d1
        .prepare(
          `insert or replace into package_entitlements
            (subject_type, subject_id, package_id, version_range, can_discover, can_mount, can_invoke)
           values (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          row.subject_type,
          row.subject_id,
          row.package_id,
          row.version_range,
          row.can_discover,
          row.can_mount,
          row.can_invoke
        ),
      "Package entitlement seed row could not be persisted."
    );
  }
};

export const prepareCloudflarePackageSeed = async (
  config: CloudflarePackageSeederConfig,
  request: unknown
): Promise<PackageSeedPreparationReceipt> => {
  const parsed = PackageSeedRequestSchema.parse(request);
  const packages = [];
  for (const template of parsed.packages) {
    const metadata = packageMetadataForSeedTemplate(template);
    const manifestHash = hashJson(metadata);
    const repo = await ensurePackageRepo({
      artifacts: config.artifacts,
      artifactsAccountId: config.artifactsAccountId,
      artifactsNamespace: config.artifactsNamespace,
      description: `Workflow package: ${metadata.packageId}`,
      repoName: template.repoName,
      tokenTtlSeconds: config.tokenTtlSeconds ?? defaultTokenTtlSeconds,
    });
    packages.push({
      defaultBranch: repo.defaultBranch,
      manifest: metadata,
      manifestArtifactRef: metadata.latestArtifactRef,
      manifestHash,
      remote: repo.remote,
      repoName: template.repoName,
      status: repo.status,
      writeToken: repo.token,
    });
  }

  return PackageSeedPreparationReceiptSchema.parse({
    packages,
    schemaVersion: "workflow.package-seed-preparation.v1",
    subjects: parsed.subjects,
  });
};

export const finalizeCloudflarePackageSeed = async (
  config: Pick<CloudflarePackageSeederConfig, "d1">,
  request: unknown
): Promise<PackageSeedReceipt> => {
  const parsed = PackageSeedFinalizeRequestSchema.parse(request);
  const packages = [];
  for (const preparedPackage of parsed.packages) {
    await upsertPackageRow({
      d1: config.d1,
      manifestHash: preparedPackage.manifestHash,
      metadata: preparedPackage.manifest,
    });
    await upsertEntitlements({
      d1: config.d1,
      packageId: preparedPackage.manifest.packageId,
      subjects: parsed.subjects,
    });
    packages.push({
      entitlementCount: parsed.subjects.length,
      manifestArtifactRef: preparedPackage.manifestArtifactRef,
      manifestHash: preparedPackage.manifestHash,
      packageId: preparedPackage.manifest.packageId,
      repoName: preparedPackage.repoName,
      seedCommitSha: preparedPackage.seedCommitSha,
      status: preparedPackage.status,
    });
  }

  return PackageSeedReceiptSchema.parse({
    packages,
    schemaVersion: "workflow.package-seed.v1",
  });
};

export const seedCloudflarePackages = async (
  config: CloudflarePackageSeederConfig,
  request: unknown
): Promise<PackageSeedReceipt> => {
  const preparation = await prepareCloudflarePackageSeed(config, request);
  const finalizedPackages = [];
  for (const preparedPackage of preparation.packages) {
    const seedCommitSha = await (config.writeManifest ?? writePackageManifest)({
      defaultBranch: preparedPackage.defaultBranch,
      manifest: preparedPackage.manifest,
      remote: preparedPackage.remote,
      status: preparedPackage.status,
      token: preparedPackage.writeToken,
    });
    finalizedPackages.push({
      defaultBranch: preparedPackage.defaultBranch,
      manifest: preparedPackage.manifest,
      manifestArtifactRef: preparedPackage.manifestArtifactRef,
      manifestHash: preparedPackage.manifestHash,
      remote: preparedPackage.remote,
      repoName: preparedPackage.repoName,
      seedCommitSha,
      status: preparedPackage.status,
    });
  }

  return await finalizeCloudflarePackageSeed(config, {
    packages: finalizedPackages,
    subjects: preparation.subjects,
  });
};
