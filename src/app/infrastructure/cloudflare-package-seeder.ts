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

/**
 * Real kernel skill: WORKFLOW-DESIGN patterns the planner reads to shape the
 * generated machine. This is authored content (not a fixture); the kernel
 * consumption path injects this body verbatim into the planner prompt's
 * "## Kernel Skills" section. It names the patterns the planner should reach
 * for and the anti-patterns that produced the linear-checklist, post-review-node
 * dreams that flaw B of the system-design gap diagnosed. Kept under
 * KERNEL_SKILL_BODY_MAX_CHARS (16k); the schema rejects it otherwise.
 */
const dreamWorkflowDesignSkillBody = [
  "# Workflow Design: Shaping the Dream Machine",
  "",
  "You are designing an XState machine for a transcript-review dream. The dream is",
  "stochastic in HOW it reasons and deterministic in its ENVELOPE: explore real",
  "evidence, correlate it, propose changes, report, then STOP for a human. Use the",
  "patterns below by name. They exist because earlier dreams degraded into linear",
  "checklists that mechanically ran one node per source and stapled post-review",
  "work onto the end of the same machine.",
  "",
  "## Pattern: fan-out search, fan-in correlate",
  "",
  "Do NOT search one source, then the next, then the next in a single chain. Fan",
  "OUT: emit one search step per source family / horizon / machine you intend to",
  "cover, with no dependsOn between them, so they are independent and the executor",
  "can run them as parallel siblings. Then fan IN: a single correlate step that",
  "dependsOn every search/hydrate step, taking all of their outputs as input. The",
  "shape is map (search per source) -> reduce (correlate across all). A correlate",
  "step that dependsOn only one search is a smell — it means you collapsed the",
  "fan-out and the dream will only ever see one source at a time.",
  "",
  "Concretely, for a dream over agent transcripts across several sessions:",
  "- search-transcripts-recent  (dependsOn: [])",
  "- search-transcripts-archive (dependsOn: [])",
  "- search-brain-decisions     (dependsOn: [])",
  "- hydrate-transcripts        (dependsOn: [search-transcripts-recent, search-transcripts-archive])",
  "- correlate                  (dependsOn: [hydrate-transcripts, search-brain-decisions])",
  "",
  "## Pattern: explore -> correlate -> propose -> report -> STOP",
  "",
  "Every dream machine is exactly these five phases and ends. There is NO sixth",
  "phase. The terminal report is a HITL report: a human reads it and decides. The",
  "machine's job is to produce that report and reach `done`. It does not act on",
  "its own findings.",
  "",
  "1. explore  — fan-out search + redacted hydrate. Pull REAL receipts.",
  "2. correlate — fan-in. Cluster evidence into themes (see the analysis skill).",
  "3. propose  — turn clusters into concrete kernel/workflow/schema change proposals.",
  "4. report   — render the HITL report card surface. Tie every claim to receipts.",
  "5. STOP     — reach the `done` final state. Hand control to the human.",
  "",
  "## Anti-pattern: the post-acceptance node belongs to a DIFFERENT workflow",
  "",
  "Do NOT put hitl-decision-seed, hitl-follow-up-run-request, or any 'apply the",
  "accepted finding' node into the dream machine. Those nodes run AFTER a human",
  "accepts a finding — they belong to a separate, post-acceptance workflow that a",
  "human (or the app) triggers once the report is reviewed. Stapling them onto the",
  "dream machine makes the dream act on findings it only just proposed, with no",
  "human in the loop. The dream proposes; a second workflow disposes. If the run",
  "binding explicitly asks you to also model the post-acceptance seed, model it as",
  "its OWN machine with its own runId — never as trailing states after `report`.",
  "",
  "## Pattern: add a think-lane when a node needs judgment, not a template",
  "",
  "The analytical nodes (correlate, propose-refinements, report) must REASON over",
  "the hydrated evidence, not fill a template. When a step's job is 'decide what",
  "matters here' rather than 'transform this shape into that shape', mark it as a",
  "node whose config carries the analysis intent so the executor runs it as an",
  "agent (think) lane with the analysis-method skill in scope. A correlate step",
  "that just buckets search hits by score, or a report step that rates every",
  "finding 10/10, is a template-filler masquerading as analysis — that is the",
  "exact failure this design is meant to kill. Reserve think-lanes for the three",
  "analytical nodes; keep the search/hydrate/capture nodes deterministic.",
  "",
  "## Envelope invariants (never violate)",
  "",
  "- A primary source that resolved ZERO receipts blocks the report. Never render",
  "  a confident review over a source the dream could not actually read.",
  "- Capture the generated machine and its plan as durable memory before the",
  "  report, so the dream that produced a finding is itself reviewable.",
  "- Every external apply/send is a capability step behind a lease + review gate,",
  "  never direct tool access. The dream reports; it does not deploy.",
].join("\n");

/**
 * Real kernel skill: ANALYSIS-METHOD the agentic correlate/propose/report nodes
 * read to turn hydrated transcript evidence into discriminating findings. This
 * is the antidote to the "every search hit -> 'X needs review', rating
 * round(score*10), every finding 10/10" template slop that flaw B diagnosed.
 * Authored content, injected verbatim by the consumption path.
 */
const dreamAnalysisMethodSkillBody = [
  "# Analysis Method: Evidence to Findings",
  "",
  "You are reasoning over hydrated transcript receipts — real session evidence,",
  "not search-result metadata. Your job is to produce findings a human can act on.",
  "A finding is a claim about a recurring problem, tied to specific receipts, with",
  "a rating that means something and a concrete proposed change. The failure mode",
  "you are replacing rated every search hit 'needs review' at 10/10 by multiplying",
  "a similarity score by ten. Do none of that. Reason.",
  "",
  "## Step 1: cluster by theme, not by source",
  "",
  "Read the hydrated receipts and group them by the SAME underlying problem, even",
  "when they come from different sessions, sources, or horizons. A theme is 'the",
  "agent kept re-deriving the typesense env each session' or 'the planner kept",
  "emitting post-review nodes'. One receipt is an anecdote; a theme is a cluster.",
  "Discard singletons unless the single instance is high-impact on its own.",
  "",
  "## Step 2: identify repeated friction and corrections",
  "",
  "Within each cluster, look for the signals that mark a real problem:",
  "- friction: the same workaround, retry, or dead-end appears across sessions.",
  "- correction: the human corrected the agent the same way more than once.",
  "- abandonment: a path was started repeatedly and dropped.",
  "- contradiction: receipts disagree about how something works.",
  "A cluster with none of these is noise — say so and drop it. Do not invent a",
  "finding to fill a slot.",
  "",
  "## Step 3: rate by recurrence x impact (ratings MUST discriminate)",
  "",
  "Rating is on 1-10 and it must SPREAD. If every finding is 8+, your ratings are",
  "useless and you have not done the work. Derive the rating, do not assert it:",
  "",
  "  recurrence: 1 (one session) .. 5 (pervasive, most sessions)",
  "  impact:     1 (cosmetic)     .. 5 (blocks real work / corrupts output)",
  "  rating = recurrence + impact   (range 2..10)",
  "",
  "A one-off cosmetic nit is a 2-3. A pervasive nit, or a one-off that blocked a",
  "run, is a 5-6. A recurring problem that actively corrupts output or wastes the",
  "human's time every session is a 9-10 — those should be RARE. If you produce",
  "five findings and they are not spread across at least a 4-point range, re-rate:",
  "you have flattened real differences. The point of the rating is to tell the",
  "human what to fix FIRST.",
  "",
  "## Step 4: tie every finding to specific receipts",
  "",
  "Every finding cites the receipt refs that prove it — the actual hydrated",
  "session/artifact references, not 'the transcripts'. A claim with no receipt is",
  "a hallucination and must be dropped. The receipts are the difference between a",
  "finding and an opinion. If the strongest evidence for a cluster is weak, lower",
  "the recurrence score accordingly rather than overstating it.",
  "",
  "## Step 5: propose a concrete change",
  "",
  "Each finding ends in ONE concrete proposed change, named at the right altitude:",
  "- kernel-skill change: 'add a data-access skill documenting the typesense env'.",
  "- workflow change: 'planner should emit post-review nodes as a separate machine'.",
  "- schema change: 'source-profile needs a primary/supplementary tier'.",
  "- access change: 'the joelclaw CLI must self-load system-bus.env'.",
  "- report change: 'rating must derive from recurrence+impact, not score*10'.",
  "Vague proposals ('improve X', 'review Y') are not proposals. Name the artifact",
  "and the edit. The proposal's own rating inherits the finding's: do not inflate.",
  "",
  "## What a good finding set looks like",
  "",
  "Three to seven findings, ratings spread across the range, each clustered from",
  "multiple receipts, each ending in a named change. Fewer real findings beats a",
  "wall of 10/10 'needs review' cards. If the evidence only supports two findings,",
  "emit two. Honesty about thin evidence is the whole point of the dream.",
].join("\n");

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
        "Default operating law plus real authored kernel skills: a workflow-design skill that shapes the dream machine (fan-out/fan-in, explore->correlate->propose->report->STOP, post-acceptance as a separate workflow, think-lanes) and an analysis-method skill that turns hydrated evidence into discriminating, receipt-tied findings.",
      exports: [
        {
          contractRef: "contract://claw-kernel/operator-law.v1",
          exportId: "operator-law",
          kind: "prompt",
        },
        {
          // Real WORKFLOW-DESIGN kernel skill. The planner reads this body (via
          // the kernel-consumption path) to shape the generated machine:
          // fan-out/fan-in, the explore->correlate->propose->report->STOP shape,
          // post-acceptance nodes belonging to a separate workflow, and when to
          // add a think-lane. Authored content, not a fixture.
          contractRef: "contract://claw-kernel/workflow-design-skill.v1",
          exportId: "workflow-design-skill",
          kind: "skill",
          skill: {
            body: dreamWorkflowDesignSkillBody,
            skillId: "dream.workflow-design",
            title: "Workflow Design: Shaping the Dream Machine",
          },
        },
        {
          // Real ANALYSIS-METHOD kernel skill. The agentic correlate/propose/
          // report nodes read this body to turn hydrated transcript evidence
          // into discriminating findings (cluster -> friction -> rate by
          // recurrence+impact -> tie to receipts -> propose a concrete change),
          // the antidote to the "X needs review, 10/10" template slop.
          contractRef: "contract://claw-kernel/analysis-method-skill.v1",
          exportId: "analysis-method-skill",
          kind: "skill",
          skill: {
            body: dreamAnalysisMethodSkillBody,
            skillId: "dream.analysis-method",
            title: "Analysis Method: Evidence to Findings",
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
