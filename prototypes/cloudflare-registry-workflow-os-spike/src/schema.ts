import { z } from "zod";

export const PackMetadataSchema = z.object({
  compatibility: z.record(z.string(), z.string()).default({}),
  defaultVerificationContract: z.string().min(1),
  id: z.string().min(1),
  permissions: z
    .object({
      network: z.boolean().default(false),
      secrets: z.array(z.string()).default([]),
    })
    .default({ network: false, secrets: [] }),
  taskMatchers: z.array(z.string().min(1)).default([]),
  version: z.string().min(1),
});

export const PackageFileSchema = z.object({
  content: z.string(),
  path: z
    .string()
    .min(1)
    .refine((path) => !path.startsWith("/") && !path.includes(".."), {
      message: "file paths must be relative and stay inside the package",
    }),
});

export const PublishPackageRequestSchema = z.object({
  description: z.string().min(1),
  files: z.array(PackageFileSchema).min(1),
  name: z
    .string()
    .min(3)
    .regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/u),
  pack: PackMetadataSchema,
  version: z
    .string()
    .min(1)
    .regex(/^\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/iu),
});

export const QueueMessageSchema = z.discriminatedUnion("type", [
  z.object({
    jobId: z.string().min(1),
    name: z.string().min(1),
    type: z.literal("validate-package"),
    version: z.string().min(1),
  }),
  z.object({
    jobId: z.string().min(1),
    name: z.string().min(1),
    type: z.literal("install-smoke"),
    version: z.string().min(1),
  }),
]);

export const JobRecordSchema = z.object({
  completedAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
  error: z.string().optional(),
  id: z.string().min(1),
  name: z.string().min(1),
  resultCommitSha: z.string().optional(),
  sandboxDestroyReceipt: z.string().optional(),
  sandboxId: z.string().optional(),
  status: z.enum(["queued", "running", "succeeded", "failed"]),
  type: z.enum(["validate-package", "install-smoke"]),
  version: z.string().min(1),
});

export const PackageFileIndexEntrySchema = z.object({
  kind: z.enum(["doc", "prompt", "skill", "other"]),
  path: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
});

export const PackageVersionRecordSchema = z.object({
  artifactRemote: z.string().url(),
  artifactRepoName: z.string().min(1),
  commitSha: z.string().min(1),
  createdAt: z.string().datetime(),
  fileIndex: z.array(PackageFileIndexEntrySchema).default([]),
  packageRef: z.string().min(1),
  validationJobId: z.string().min(1),
  validationStatus: z.enum(["queued", "running", "succeeded", "failed"]),
  version: z.string().min(1),
});

export const PackageRecordSchema = z.object({
  description: z.string().min(1),
  eventLog: z.array(z.string()).default([]),
  jobs: z.record(z.string(), JobRecordSchema).default({}),
  name: z.string().min(1),
  updatedAt: z.string().datetime(),
  versions: z.record(z.string(), PackageVersionRecordSchema).default({}),
});

export const ValidationResultSchema = z.object({
  checkedAt: z.string().datetime(),
  checkedFiles: z.array(z.string()),
  packageName: z.string(),
  schemaVersion: z.literal("registry-validation-result.v1"),
  status: z.enum(["passed", "failed"]),
  version: z.string(),
  warnings: z.array(z.string()),
});

export const FinalReceiptSchema = z.object({
  artifactRemote: z.string().url(),
  artifactRepoName: z.string().min(1),
  checks: z.array(
    z.object({
      id: z.string().min(1),
      status: z.enum(["passed", "failed"]),
      summary: z.string().min(1),
    })
  ),
  deployedWorkerUrl: z.string().url(),
  finalState: z.literal("captured"),
  installSmokeJobId: z.string().min(1),
  installSmokeSandboxDestroyReceipt: z.string().min(1),
  installSmokeSandboxId: z.string().min(1),
  listApiPackageCount: z.number().int().nonnegative(),
  packageName: z.string().min(1),
  packageRef: z.string().min(1),
  packageVersion: z.string().min(1),
  publishCommitSha: z.string().min(1),
  validationCommitSha: z.string().min(1),
  validationJobId: z.string().min(1),
  validationSandboxDestroyReceipt: z.string().min(1),
  validationSandboxId: z.string().min(1),
});

export type FinalReceipt = z.infer<typeof FinalReceiptSchema>;
export type JobRecord = z.infer<typeof JobRecordSchema>;
export type PackageFileIndexEntry = z.infer<typeof PackageFileIndexEntrySchema>;
export type PackageRecord = z.infer<typeof PackageRecordSchema>;
export type PackageVersionRecord = z.infer<typeof PackageVersionRecordSchema>;
export type PublishPackageRequest = z.infer<typeof PublishPackageRequestSchema>;
export type QueueMessage = z.infer<typeof QueueMessageSchema>;
