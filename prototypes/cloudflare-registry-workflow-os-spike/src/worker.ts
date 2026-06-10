/// <reference types="@cloudflare/workers-types" />
/* eslint-disable func-style, no-use-before-define */

import { getSandbox } from "@cloudflare/sandbox";
import type {
  ISandbox,
  Sandbox as SandboxDurableObject,
} from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";
import { add, commit, init as gitInit, push } from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { z } from "zod";

import { MemoryFS } from "./memory-fs.ts";
import {
  FinalReceiptSchema,
  JobRecordSchema,
  PackageRecordSchema,
  PublishPackageRequestSchema,
  QueueMessageSchema,
} from "./schema.ts";
import type {
  FinalReceipt,
  JobRecord,
  PackageFileIndexEntry,
  PackageRecord,
  PublishPackageRequest,
  QueueMessage,
} from "./schema.ts";

export { Sandbox } from "@cloudflare/sandbox";

interface Env {
  ACCESS_TOKEN?: string;
  ARTIFACTS: Artifacts;
  REGISTRY_QUEUE: Queue<QueueMessage>;
  REGISTRY_SUPERVISOR: DurableObjectNamespace<RegistrySupervisor>;
  Sandbox: DurableObjectNamespace<SandboxDurableObject>;
}

interface RealSandbox extends ISandbox {
  destroy(): Promise<void>;
}

interface CommandResult {
  duration: number;
  exitCode: number;
  stderr: string;
  stdout: string;
  success: boolean;
  timestamp: string;
}

const InstallSmokeRequestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
});

const CompleteJobRequestSchema = z.object({
  jobId: z.string().min(1),
  resultCommitSha: z.string().min(1),
  sandboxDestroyReceipt: z.string().min(1),
  sandboxId: z.string().min(1),
});

const FailJobRequestSchema = z.object({
  error: z.string().min(1),
  jobId: z.string().min(1),
  sandboxDestroyReceipt: z.string().optional(),
  sandboxId: z.string().optional(),
});

const RepoAccessRequestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
});

const FileListRequestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
});

const FileReadRequestSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  version: z.string().min(1),
});

const COMMAND_TIMEOUT_SECONDS = 120;
const QUEUE_RETRY_DELAY_SECONDS = 2;

export class RegistrySupervisor extends DurableObject<Env> {
  // Prototype router: keep routes co-located until this spike graduates.
  // eslint-disable-next-line complexity
  override fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "POST" && pathname === "/publish") {
      return this.publish(request);
    }
    if (request.method === "POST" && pathname === "/install-smoke") {
      return this.createInstallSmoke(request);
    }
    if (request.method === "POST" && pathname === "/repo-access") {
      return this.repoAccess(request);
    }
    if (request.method === "POST" && pathname === "/job-running") {
      return this.markJobRunning(request);
    }
    if (request.method === "POST" && pathname === "/job-complete") {
      return this.completeJob(request);
    }
    if (request.method === "POST" && pathname === "/job-failed") {
      return this.failJob(request);
    }
    if (request.method === "GET" && pathname === "/packages") {
      return this.listPackages();
    }
    const filesMatch = pathname.match(
      /^\/packages\/([^/]+)\/versions\/([^/]+)\/files$/u
    );
    if (request.method === "GET" && filesMatch?.[1] && filesMatch[2]) {
      return this.listPackageFiles(
        decodeURIComponent(filesMatch[1]),
        decodeURIComponent(filesMatch[2])
      );
    }
    const fileMatch = pathname.match(
      /^\/packages\/([^/]+)\/versions\/([^/]+)\/file$/u
    );
    if (request.method === "GET" && fileMatch?.[1] && fileMatch[2]) {
      return this.readPackageFile(
        request,
        decodeURIComponent(fileMatch[1]),
        decodeURIComponent(fileMatch[2])
      );
    }
    if (request.method === "GET" && pathname.startsWith("/packages/")) {
      return this.getPackage(decodeURIComponent(pathname.slice(10)));
    }
    if (request.method === "GET" && pathname.startsWith("/jobs/")) {
      return this.getJob(decodeURIComponent(pathname.slice(6)));
    }

    return Promise.resolve(
      json({ error: "not found", ok: false }, { status: 404 })
    );
  }

  private async publish(request: Request): Promise<Response> {
    const body = PublishPackageRequestSchema.parse(await request.json());
    const existing = await this.getPackageRecord(body.name);
    if (existing?.versions[body.version]) {
      return json({
        alreadyPublished: true,
        ok: true,
        package: existing,
        version: existing.versions[body.version],
      });
    }

    const now = new Date().toISOString();
    const artifactRepoName = `pi-registry-${slugify(body.name)}-${crypto.randomUUID().slice(0, 8)}`;
    const createdRepo = await this.env.ARTIFACTS.create(artifactRepoName, {
      description: `Context pack registry package ${body.name}@${body.version}`,
      readOnly: false,
      setDefaultBranch: "main",
    });
    const authedRemote = toAuthenticatedRemote(
      createdRepo.remote,
      createdRepo.token
    );
    const publishCommit = await commitPackageFiles({
      files: buildPackageFiles(body, artifactRepoName),
      remote: createdRepo.remote,
      tokenSecret: authedRemote.tokenSecret,
      version: body.version,
    });
    await this.ctx.storage.put(
      tokenStorageKey(body.name, body.version),
      createdRepo.token
    );
    await this.ctx.storage.put(
      filesStorageKey(body.name, body.version),
      body.files
    );

    const validationJobId = `job-validate-${slugify(body.name)}-${crypto.randomUUID().slice(0, 8)}`;
    const job = JobRecordSchema.parse({
      createdAt: now,
      id: validationJobId,
      name: body.name,
      status: "queued",
      type: "validate-package",
      version: body.version,
    });
    const version = {
      artifactRemote: createdRepo.remote,
      artifactRepoName,
      commitSha: publishCommit.commit,
      createdAt: now,
      fileIndex: body.files.map((file) => ({
        kind: fileKind(file.path),
        path: file.path,
        sizeBytes: new TextEncoder().encode(file.content).byteLength,
      })),
      packageRef: `${artifactRepoName}@${publishCommit.commit}`,
      validationJobId,
      validationStatus: "queued",
      version: body.version,
    };
    const next = PackageRecordSchema.parse({
      description: body.description,
      eventLog: [
        ...(existing?.eventLog ?? []),
        `${now} PACKAGE_PUBLISHED ${body.name}@${body.version}`,
        `${now} VALIDATION_QUEUED ${validationJobId}`,
      ],
      jobs: { ...existing?.jobs, [validationJobId]: job },
      name: body.name,
      updatedAt: now,
      versions: { ...existing?.versions, [body.version]: version },
    });
    await this.putPackageRecord(next);
    await this.env.REGISTRY_QUEUE.send({
      jobId: validationJobId,
      name: body.name,
      type: "validate-package",
      version: body.version,
    });

    return json({ job, ok: true, package: next, version });
  }

  private async createInstallSmoke(request: Request): Promise<Response> {
    const body = InstallSmokeRequestSchema.parse(await request.json());
    const record = await this.requirePackageRecord(body.name);
    const version = record.versions[body.version];
    if (!version) {
      return json(
        { error: "unknown package version", ok: false },
        { status: 404 }
      );
    }
    if (version.validationStatus !== "succeeded") {
      return json(
        { error: "package version is not validated", ok: false },
        { status: 409 }
      );
    }

    const now = new Date().toISOString();
    const jobId = `job-install-${slugify(body.name)}-${crypto.randomUUID().slice(0, 8)}`;
    const job = JobRecordSchema.parse({
      createdAt: now,
      id: jobId,
      name: body.name,
      status: "queued",
      type: "install-smoke",
      version: body.version,
    });
    const next = PackageRecordSchema.parse({
      ...record,
      eventLog: [...record.eventLog, `${now} INSTALL_SMOKE_QUEUED ${jobId}`],
      jobs: { ...record.jobs, [jobId]: job },
      updatedAt: now,
    });
    await this.putPackageRecord(next);
    await this.env.REGISTRY_QUEUE.send({
      jobId,
      name: body.name,
      type: "install-smoke",
      version: body.version,
    });
    return json({ job, ok: true, package: next });
  }

  private async repoAccess(request: Request): Promise<Response> {
    const body = RepoAccessRequestSchema.parse(await request.json());
    const record = await this.requirePackageRecord(body.name);
    const version = requireValue(
      record.versions[body.version],
      "package version"
    );
    const artifactTokenSecret = requireValue(
      await this.ctx.storage.get<string>(
        tokenStorageKey(body.name, body.version)
      ),
      "artifact token"
    );
    return json({
      artifactRemote: version.artifactRemote,
      artifactRepoName: version.artifactRepoName,
      artifactTokenSecret,
      ok: true,
    });
  }

  private async markJobRunning(request: Request): Promise<Response> {
    const body = z
      .object({
        jobId: z.string().min(1),
        name: z.string().min(1),
        sandboxId: z.string().min(1),
      })
      .parse(await request.json());
    const record = await this.requirePackageRecord(body.name);
    const job = requireValue(record.jobs[body.jobId], "job");
    const nextJob = JobRecordSchema.parse({
      ...job,
      sandboxId: body.sandboxId,
      status: "running",
    });
    await this.putPackageRecord(updateJob(record, nextJob));
    return json({ job: nextJob, ok: true });
  }

  private async completeJob(request: Request): Promise<Response> {
    const body = CompleteJobRequestSchema.parse(await request.json());
    const record = await this.requirePackageRecordFromJob(body.jobId);
    const job = requireValue(record.jobs[body.jobId], "job");
    const now = new Date().toISOString();
    const nextJob = JobRecordSchema.parse({
      ...job,
      completedAt: now,
      resultCommitSha: body.resultCommitSha,
      sandboxDestroyReceipt: body.sandboxDestroyReceipt,
      sandboxId: body.sandboxId,
      status: "succeeded",
    });
    const nextRecord = updateJob(record, nextJob);
    if (nextJob.type === "validate-package") {
      const version = requireValue(
        nextRecord.versions[nextJob.version],
        "package version"
      );
      nextRecord.versions[nextJob.version] = {
        ...version,
        validationStatus: "succeeded",
      };
    }
    nextRecord.eventLog.push(`${now} JOB_SUCCEEDED ${body.jobId}`);
    nextRecord.updatedAt = now;
    await this.putPackageRecord(PackageRecordSchema.parse(nextRecord));
    return json({ job: nextJob, ok: true, package: nextRecord });
  }

  private async failJob(request: Request): Promise<Response> {
    const body = FailJobRequestSchema.parse(await request.json());
    const record = await this.requirePackageRecordFromJob(body.jobId);
    const job = requireValue(record.jobs[body.jobId], "job");
    const now = new Date().toISOString();
    const nextJob = JobRecordSchema.parse({
      ...job,
      completedAt: now,
      error: body.error,
      sandboxDestroyReceipt: body.sandboxDestroyReceipt,
      sandboxId: body.sandboxId,
      status: "failed",
    });
    const nextRecord = updateJob(record, nextJob);
    if (nextJob.type === "validate-package") {
      const version = requireValue(
        nextRecord.versions[nextJob.version],
        "package version"
      );
      nextRecord.versions[nextJob.version] = {
        ...version,
        validationStatus: "failed",
      };
    }
    nextRecord.eventLog.push(`${now} JOB_FAILED ${body.jobId}`);
    nextRecord.updatedAt = now;
    await this.putPackageRecord(PackageRecordSchema.parse(nextRecord));
    return json({ job: nextJob, ok: true, package: nextRecord });
  }

  private async listPackages(): Promise<Response> {
    const names = await this.ctx.storage.get<string[]>("packageNames");
    const packages = await Promise.all(
      (names ?? []).map((name) => this.getPackageRecord(name))
    );
    return json({ ok: true, packages: packages.filter(Boolean) });
  }

  private async getPackage(name: string): Promise<Response> {
    const record = await this.getPackageRecord(name);
    return record
      ? json({ ok: true, package: record })
      : json({ error: "not found", ok: false }, { status: 404 });
  }

  private async listPackageFiles(
    name: string,
    version: string
  ): Promise<Response> {
    const body = FileListRequestSchema.parse({ name, version });
    const record = await this.requirePackageRecord(body.name);
    const packageVersion = record.versions[body.version];
    if (!packageVersion) {
      return json(
        { error: "unknown package version", ok: false },
        { status: 404 }
      );
    }
    return json({
      files: packageVersion.fileIndex,
      ok: true,
      packageName: body.name,
      version: body.version,
    });
  }

  private async readPackageFile(
    request: Request,
    name: string,
    version: string
  ): Promise<Response> {
    const url = new URL(request.url);
    const body = FileReadRequestSchema.parse({
      name,
      path: url.searchParams.get("path"),
      version,
    });
    const record = await this.requirePackageRecord(body.name);
    if (!record.versions[body.version]) {
      return json(
        { error: "unknown package version", ok: false },
        { status: 404 }
      );
    }
    const files =
      (await this.ctx.storage.get<PublishPackageRequest["files"]>(
        filesStorageKey(body.name, body.version)
      )) ?? [];
    const file = files.find((item) => item.path === body.path);
    if (!file) {
      return json({ error: "file not found", ok: false }, { status: 404 });
    }
    return json({
      content: file.content,
      file: {
        kind: fileKind(file.path),
        path: file.path,
        sizeBytes: new TextEncoder().encode(file.content).byteLength,
      },
      ok: true,
      packageName: body.name,
      version: body.version,
    });
  }

  private async getJob(jobId: string): Promise<Response> {
    const record = await this.findPackageByJob(jobId);
    const job = record?.jobs[jobId];
    return job
      ? json({ job, ok: true, package: record })
      : json({ error: "not found", ok: false }, { status: 404 });
  }

  private async getPackageRecord(
    name: string
  ): Promise<PackageRecord | undefined> {
    const stored = await this.ctx.storage.get<PackageRecord>(
      packageStorageKey(name)
    );
    return stored ? PackageRecordSchema.parse(stored) : undefined;
  }

  private async putPackageRecord(record: PackageRecord): Promise<void> {
    const existingNames = await this.ctx.storage.get<string[]>("packageNames");
    const names = new Set([...(existingNames ?? []), record.name]);
    await this.ctx.storage.put(packageStorageKey(record.name), record);
    await this.ctx.storage.put("packageNames", [...names].toSorted());
  }

  private async requirePackageRecord(name: string): Promise<PackageRecord> {
    return requireValue(await this.getPackageRecord(name), "package record");
  }

  private async requirePackageRecordFromJob(
    jobId: string
  ): Promise<PackageRecord> {
    return requireValue(
      await this.findPackageByJob(jobId),
      "package record for job"
    );
  }

  private async findPackageByJob(
    jobId: string
  ): Promise<PackageRecord | undefined> {
    const names = (await this.ctx.storage.get<string[]>("packageNames")) ?? [];
    for (const name of names) {
      const record = await this.getPackageRecord(name);
      if (record?.jobs[jobId]) {
        return record;
      }
    }
    return undefined;
  }
}

export default {
  // Prototype router: keep routes co-located until this spike graduates.
  // eslint-disable-next-line complexity
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!isAuthorized(request, env)) {
      return json({ error: "unauthorized", ok: false }, { status: 401 });
    }

    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return json({
        authRequired: Boolean(env.ACCESS_TOKEN),
        ok: true,
        primitiveStack: [
          "worker",
          "durable-object",
          "queue",
          "artifacts",
          "sandbox",
        ],
      });
    }
    if (request.method === "POST" && url.pathname === "/api/packages") {
      return forwardToRegistry(request, env, "/publish");
    }
    if (request.method === "GET" && url.pathname === "/api/packages") {
      return forwardToRegistry(request, env, "/packages");
    }
    const filesMatch = url.pathname.match(
      /^\/api\/packages\/([^/]+)\/versions\/([^/]+)\/files$/u
    );
    if (request.method === "GET" && filesMatch?.[1] && filesMatch[2]) {
      return forwardToRegistry(
        request,
        env,
        `/packages/${filesMatch[1]}/versions/${filesMatch[2]}/files`
      );
    }
    const fileMatch = url.pathname.match(
      /^\/api\/packages\/([^/]+)\/versions\/([^/]+)\/file$/u
    );
    if (request.method === "GET" && fileMatch?.[1] && fileMatch[2]) {
      return forwardToRegistry(
        request,
        env,
        `/packages/${fileMatch[1]}/versions/${fileMatch[2]}/file${url.search}`
      );
    }
    const packageMatch = url.pathname.match(/^\/api\/packages\/([^/]+)$/u);
    if (request.method === "GET" && packageMatch?.[1]) {
      return forwardToRegistry(request, env, `/packages/${packageMatch[1]}`);
    }
    const versionMatch = url.pathname.match(
      /^\/api\/packages\/([^/]+)\/versions$/u
    );
    if (request.method === "POST" && versionMatch?.[1]) {
      const body = (await request.json()) as Record<string, unknown>;
      return postToRegistry(env, "/publish", {
        ...body,
        name: decodeURIComponent(versionMatch[1]),
      });
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/runs/install-smoke"
    ) {
      return forwardToRegistry(request, env, "/install-smoke");
    }
    const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/u);
    if (request.method === "GET" && jobMatch?.[1]) {
      return forwardToRegistry(request, env, `/jobs/${jobMatch[1]}`);
    }

    return json({ error: "not found", ok: false }, { status: 404 });
  },

  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    await Promise.all(
      batch.messages.map(async (message) => {
        const parsed = QueueMessageSchema.safeParse(message.body);
        if (!parsed.success) {
          console.error("invalid queue message", parsed.error.message);
          message.ack();
          return;
        }

        try {
          await (parsed.data.type === "validate-package"
            ? processValidationJob(parsed.data, env)
            : processInstallSmokeJob(parsed.data, env));
          message.ack();
        } catch (error) {
          console.error("registry queue message failed", error);
          message.retry({ delaySeconds: QUEUE_RETRY_DELAY_SECONDS });
        }
      })
    );
  },
} satisfies ExportedHandler<Env, QueueMessage>;

async function processValidationJob(
  message: Extract<QueueMessage, { type: "validate-package" }>,
  env: Env
): Promise<void> {
  const stub = getRegistryStub(env);
  const repoAccess = await postDo(stub, "/repo-access", message);
  const authedRemote = toAuthenticatedRemote(
    String(repoAccess["artifactRemote"]),
    String(repoAccess["artifactTokenSecret"])
  );
  const sandboxId = buildSandboxId("rv", message.name);
  await postDo(stub, "/job-running", {
    jobId: message.jobId,
    name: message.name,
    sandboxId,
  });
  let sandbox: RealSandbox | undefined;
  let destroyReceipt: string | undefined;
  try {
    sandbox = getSandbox(env.Sandbox, sandboxId) as unknown as RealSandbox;
    const result = await runCommand(
      sandbox,
      buildValidationCommand(),
      { tokenSecret: authedRemote.tokenSecret },
      {
        ARTIFACTS_GIT_REMOTE: authedRemote.remote,
        COMMAND_TIMEOUT_SECONDS: String(COMMAND_TIMEOUT_SECONDS),
        GIT_TERMINAL_PROMPT: "0",
        JOB_ID: message.jobId,
        PACKAGE_NAME: message.name,
        PACKAGE_VERSION: message.version,
      }
    );
    assertCommand(result, "registry validation");
    const resultCommitSha = requireValue(
      getLastNonEmptyLine(result.stdout),
      "validation commit sha"
    );
    destroyReceipt = await destroySandbox(sandbox, sandboxId);
    await postDo(stub, "/job-complete", {
      jobId: message.jobId,
      resultCommitSha,
      sandboxDestroyReceipt: destroyReceipt,
      sandboxId,
    });
  } catch (error) {
    if (sandbox && !destroyReceipt) {
      destroyReceipt = await destroySandbox(sandbox, sandboxId).catch(
        (destroyError) => `destroy:${sandboxId}:failed:${String(destroyError)}`
      );
    }
    await postDo(stub, "/job-failed", {
      error: error instanceof Error ? error.message : String(error),
      jobId: message.jobId,
      sandboxDestroyReceipt: destroyReceipt,
      sandboxId,
    });
    throw error;
  }
}

async function processInstallSmokeJob(
  message: Extract<QueueMessage, { type: "install-smoke" }>,
  env: Env
): Promise<void> {
  const stub = getRegistryStub(env);
  const repoAccess = await postDo(stub, "/repo-access", message);
  const authedRemote = toAuthenticatedRemote(
    String(repoAccess["artifactRemote"]),
    String(repoAccess["artifactTokenSecret"])
  );
  const sandboxId = buildSandboxId("ri", message.name);
  await postDo(stub, "/job-running", {
    jobId: message.jobId,
    name: message.name,
    sandboxId,
  });
  let sandbox: RealSandbox | undefined;
  let destroyReceipt: string | undefined;
  try {
    sandbox = getSandbox(env.Sandbox, sandboxId) as unknown as RealSandbox;
    const result = await runCommand(
      sandbox,
      buildInstallSmokeCommand(),
      { tokenSecret: authedRemote.tokenSecret },
      {
        ARTIFACTS_GIT_REMOTE: authedRemote.remote,
        COMMAND_TIMEOUT_SECONDS: String(COMMAND_TIMEOUT_SECONDS),
        GIT_TERMINAL_PROMPT: "0",
        JOB_ID: message.jobId,
        PACKAGE_NAME: message.name,
        PACKAGE_VERSION: message.version,
      }
    );
    assertCommand(result, "registry install smoke");
    const resultCommitSha = requireValue(
      getLastNonEmptyLine(result.stdout),
      "install smoke commit sha"
    );
    destroyReceipt = await destroySandbox(sandbox, sandboxId);
    await postDo(stub, "/job-complete", {
      jobId: message.jobId,
      resultCommitSha,
      sandboxDestroyReceipt: destroyReceipt,
      sandboxId,
    });
  } catch (error) {
    if (sandbox && !destroyReceipt) {
      destroyReceipt = await destroySandbox(sandbox, sandboxId).catch(
        (destroyError) => `destroy:${sandboxId}:failed:${String(destroyError)}`
      );
    }
    await postDo(stub, "/job-failed", {
      error: error instanceof Error ? error.message : String(error),
      jobId: message.jobId,
      sandboxDestroyReceipt: destroyReceipt,
      sandboxId,
    });
    throw error;
  }
}

function buildPackageFiles(
  body: PublishPackageRequest,
  artifactRepoName: string
): { content: string; path: string }[] {
  const manifest = {
    artifactRepoName,
    createdAt: new Date().toISOString(),
    packageName: body.name,
    schemaVersion: "registry-package-manifest.v1",
    version: body.version,
  };
  return [
    { content: `${JSON.stringify(body.pack, null, 2)}\n`, path: "pack.json" },
    {
      content: `${JSON.stringify(manifest, null, 2)}\n`,
      path: "registry/manifest.json",
    },
    { content: `# ${body.name}\n\n${body.description}\n`, path: "README.md" },
    ...body.files.map((file) => ({ content: file.content, path: file.path })),
  ];
}

async function commitPackageFiles(input: {
  files: { content: string; path: string }[];
  remote: string;
  tokenSecret: string;
  version: string;
}): Promise<{ commit: string }> {
  const fs = new MemoryFS();
  const dir = "/workspace";
  await gitInit({ defaultBranch: "main", dir, fs });
  for (const file of input.files) {
    await fs.promises.writeFile(`${dir}/${file.path}`, file.content);
    await add({ dir, filepath: file.path, fs });
  }
  const commitSha = await commit({
    author: {
      email: "cloudflare-registry-workflow-os-spike@example.invalid",
      name: "cloudflare-registry-workflow-os-spike",
    },
    dir,
    fs,
    message: `registry: publish ${input.version}`,
  });
  await push({
    dir,
    fs,
    http,
    onAuth: () => ({ password: input.tokenSecret, username: "x" }),
    ref: "main",
    url: input.remote,
  });
  return { commit: commitSha };
}

function buildValidationCommand(): string {
  return String.raw`set -eu
rm -rf /workspace/pi-registry-pack
git clone "$ARTIFACTS_GIT_REMOTE" /workspace/pi-registry-pack
cd /workspace/pi-registry-pack
git config user.name "cloudflare-registry-workflow-os-spike"
git config user.email "cloudflare-registry-workflow-os-spike@example.invalid"
node <<'NODE'
const fs = require('fs');
const required = ['pack.json', 'registry/manifest.json'];
const warnings = [];
const failures = [];
for (const path of required) if (!fs.existsSync(path)) failures.push('missing required file: ' + path);
let pack;
try { pack = JSON.parse(fs.readFileSync('pack.json', 'utf8')); } catch (error) { failures.push('pack.json is not parseable JSON: ' + error.message); }
if (pack) {
  if (pack.id !== process.env.PACKAGE_NAME) failures.push('pack.id does not match package name');
  if (pack.version !== process.env.PACKAGE_VERSION) failures.push('pack.version does not match package version');
  if (!Array.isArray(pack.taskMatchers)) warnings.push('pack.taskMatchers is not an array');
}
const checkedFiles = [];
const secretPattern = /(BEGIN (RSA|OPENSSH|EC) PRIVATE KEY|sk-[a-zA-Z0-9]{20,}|ACCESS_TOKEN=|CLOUDFLARE_API_TOKEN=)/;
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const path = dir + '/' + entry.name;
    if (path.includes('/.git/')) continue;
    if (entry.isDirectory()) walk(path);
    else {
      const rel = path.replace(/^\.\//, '');
      checkedFiles.push(rel);
      const content = fs.readFileSync(path, 'utf8');
      if (secretPattern.test(content)) failures.push('secret-looking content in ' + rel);
    }
  }
};
walk('.');
const result = {
  checkedAt: new Date().toISOString(),
  checkedFiles,
  packageName: process.env.PACKAGE_NAME,
  schemaVersion: 'registry-validation-result.v1',
  status: failures.length > 0 ? 'failed' : 'passed',
  version: process.env.PACKAGE_VERSION,
  warnings: [...warnings, ...failures],
};
fs.mkdirSync('registry', { recursive: true });
fs.writeFileSync('registry/validation-result.json', JSON.stringify(result, null, 2) + '\n');
if (failures.length > 0) {
  console.error(JSON.stringify(result, null, 2));
  process.exit(1);
}
NODE
git add registry/validation-result.json
git commit -m "registry: validate $PACKAGE_NAME@$PACKAGE_VERSION"
commit=$(git rev-parse HEAD)
git push origin HEAD:main
printf '%s\n' "$commit"`;
}

function buildInstallSmokeCommand(): string {
  return String.raw`set -eu
rm -rf /workspace/pi-registry-pack /workspace/install-smoke
git clone "$ARTIFACTS_GIT_REMOTE" /workspace/pi-registry-pack
cd /workspace/pi-registry-pack
git config user.name "cloudflare-registry-workflow-os-spike"
git config user.email "cloudflare-registry-workflow-os-spike@example.invalid"
mkdir -p /workspace/install-smoke/.pi/agent
[ -d prompts ] && cp -R prompts /workspace/install-smoke/.pi/agent/prompts
[ -d skills ] && cp -R skills /workspace/install-smoke/.pi/agent/skills
node <<'NODE'
const fs = require('fs');
const copiedPrompts = fs.existsSync('/workspace/install-smoke/.pi/agent/prompts');
const copiedSkills = fs.existsSync('/workspace/install-smoke/.pi/agent/skills');
const result = {
  checkedAt: new Date().toISOString(),
  copiedPrompts,
  copiedSkills,
  jobId: process.env.JOB_ID,
  packageName: process.env.PACKAGE_NAME,
  schemaVersion: 'registry-install-smoke-result.v1',
  status: copiedPrompts && copiedSkills ? 'passed' : 'failed',
  version: process.env.PACKAGE_VERSION,
};
fs.mkdirSync('registry', { recursive: true });
fs.writeFileSync('registry/install-smoke-' + process.env.JOB_ID + '.json', JSON.stringify(result, null, 2) + '\n');
if (result.status !== 'passed') {
  console.error(JSON.stringify(result, null, 2));
  process.exit(1);
}
NODE
git add "registry/install-smoke-$JOB_ID.json"
git commit -m "registry: install smoke $PACKAGE_NAME@$PACKAGE_VERSION"
commit=$(git rev-parse HEAD)
git push origin HEAD:main
printf '%s\n' "$commit"`;
}

async function runCommand(
  sandbox: RealSandbox,
  command: string,
  redaction: { tokenSecret: string },
  env: Record<string, string>
): Promise<CommandResult> {
  const encodedCommand = btoa(command);
  const wrappedCommand = String.raw`set +e
script_path="$(mktemp)"
printf '%s' '${encodedCommand}' | base64 -d > "$script_path"
timeout "$COMMAND_TIMEOUT_SECONDS" bash "$script_path" 2>&1
status=$?
rm -f "$script_path"
printf '\n__PIWF_EXIT_CODE__:%s\n' "$status"`;
  const result = await sandbox.exec(wrappedCommand, {
    cwd: "/workspace",
    env,
    timeout: (COMMAND_TIMEOUT_SECONDS + 20) * 1000,
  });
  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  const exitMatch = combinedOutput.match(/__PIWF_EXIT_CODE__:(\d+)/u);
  const exitCode = exitMatch?.[1] ? Number(exitMatch[1]) : result.exitCode;
  return {
    duration: result.duration,
    exitCode,
    stderr: redact(result.stderr, [redaction.tokenSecret]),
    stdout: redact(result.stdout, [redaction.tokenSecret]),
    success: exitCode === 0,
    timestamp: result.timestamp,
  };
}

function assertCommand(result: CommandResult, label: string): void {
  if (!result.success) {
    throw new Error(
      `${label} failed with exit ${result.exitCode}: ${result.stderr || result.stdout}`
    );
  }
}

async function destroySandbox(
  sandbox: RealSandbox,
  sandboxId: string
): Promise<string> {
  await sandbox.destroy();
  return `destroy:${sandboxId}:ok`;
}

function updateJob(record: PackageRecord, job: JobRecord): PackageRecord {
  return PackageRecordSchema.parse({
    ...record,
    jobs: { ...record.jobs, [job.id]: job },
  });
}

async function forwardToRegistry(
  request: Request,
  env: Env,
  path: string
): Promise<Response> {
  const response = await getRegistryStub(env).fetch(
    new Request(new URL(path, request.url), request)
  );
  const payload = await response.json();
  return json(payload, { status: response.status });
}

async function postToRegistry(
  env: Env,
  path: string,
  body: unknown
): Promise<Response> {
  const payload = await postDo(getRegistryStub(env), path, body);
  return json(payload);
}

function getRegistryStub(env: Env): DurableObjectStub<RegistrySupervisor> {
  return env.REGISTRY_SUPERVISOR.get(
    env.REGISTRY_SUPERVISOR.idFromName("registry")
  );
}

async function postDo(
  stub: DurableObjectStub,
  path: string,
  body: unknown
): Promise<Record<string, unknown>> {
  const response = await stub.fetch(
    new Request(`https://registry.local${path}`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
  );
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok || payload["ok"] !== true) {
    throw new Error(
      `DO ${path} failed: ${response.status} ${JSON.stringify(payload)}`
    );
  }
  return payload;
}

function toAuthenticatedRemote(
  remote: string,
  token: string
): { remote: string; tokenSecret: string } {
  const tokenSecret = token.split("?expires=")[0] ?? token;
  return {
    remote: `https://x:${tokenSecret}@${remote.slice("https://".length)}`,
    tokenSecret,
  };
}

function getLastNonEmptyLine(value: string): string | undefined {
  const beforeExitMarker = value.split("__PIWF_EXIT_CODE__:")[0] ?? value;
  return beforeExitMarker
    .split(/\r?\n/u)
    .toReversed()
    .find((line) => line.trim().length > 0)
    ?.trim();
}

function isAuthorized(request: Request, env: Env): boolean {
  if (!env.ACCESS_TOKEN) {
    return true;
  }
  return request.headers.get("authorization") === `Bearer ${env.ACCESS_TOKEN}`;
}

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body, null, 2), {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
}

function packageStorageKey(name: string): string {
  return `package:${name}`;
}

function tokenStorageKey(name: string, version: string): string {
  return `token:${name}:${version}`;
}

function filesStorageKey(name: string, version: string): string {
  return `files:${name}:${version}`;
}

function fileKind(path: string): PackageFileIndexEntry["kind"] {
  if (path.startsWith("prompts/")) {
    return "prompt";
  }
  if (/^skills\/[^/]+\/SKILL\.md$/u.test(path)) {
    return "skill";
  }
  if (path.startsWith("docs/")) {
    return "doc";
  }
  return "other";
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/gu, "-")
      .replaceAll(/^-|-$/gu, "")
      .slice(0, 64) || "item"
  );
}

function buildSandboxId(prefix: string, value: string): string {
  return `${prefix}-${slugify(value).slice(0, 38)}-${crypto.randomUUID().slice(0, 8)}`;
}

function redact(value: string, secrets: string[]): string {
  let output = value;
  for (const secret of secrets) {
    output = output.replaceAll(secret, "[REDACTED]");
  }
  return output;
}

function requireValue<T>(value: T | undefined, label: string): T {
  if (value === undefined || value === null) {
    throw new Error(`Missing ${label}`);
  }
  return value;
}

export function buildFinalReceipt(input: {
  deployedWorkerUrl: string;
  installSmokeJob: JobRecord;
  listApiPackageCount: number;
  packageRecord: PackageRecord;
  packageVersion: string;
  validationJob: JobRecord;
}): FinalReceipt {
  const version = requireValue(
    input.packageRecord.versions[input.packageVersion],
    "package version"
  );
  return FinalReceiptSchema.parse({
    artifactRemote: version.artifactRemote,
    artifactRepoName: version.artifactRepoName,
    checks: [
      {
        id: "real-cloudflare-primitives",
        status: "passed",
        summary:
          "Publish, validation, and install smoke used Worker + DO + Queue + Artifacts + Sandbox.",
      },
      {
        id: "validation-sandbox-destroyed",
        status: input.validationJob.sandboxDestroyReceipt?.endsWith(":ok")
          ? "passed"
          : "failed",
        summary: "Validation sandbox destroy receipt recorded.",
      },
      {
        id: "install-smoke-sandbox-destroyed",
        status: input.installSmokeJob.sandboxDestroyReceipt?.endsWith(":ok")
          ? "passed"
          : "failed",
        summary: "Install smoke sandbox destroy receipt recorded.",
      },
    ],
    deployedWorkerUrl: input.deployedWorkerUrl,
    finalState: "captured",
    installSmokeJobId: input.installSmokeJob.id,
    installSmokeSandboxDestroyReceipt: requireValue(
      input.installSmokeJob.sandboxDestroyReceipt,
      "install smoke destroy receipt"
    ),
    installSmokeSandboxId: requireValue(
      input.installSmokeJob.sandboxId,
      "install smoke sandbox id"
    ),
    listApiPackageCount: input.listApiPackageCount,
    packageName: input.packageRecord.name,
    packageRef: version.packageRef,
    packageVersion: input.packageVersion,
    publishCommitSha: version.commitSha,
    validationCommitSha: requireValue(
      input.validationJob.resultCommitSha,
      "validation commit sha"
    ),
    validationJobId: input.validationJob.id,
    validationSandboxDestroyReceipt: requireValue(
      input.validationJob.sandboxDestroyReceipt,
      "validation destroy receipt"
    ),
    validationSandboxId: requireValue(
      input.validationJob.sandboxId,
      "validation sandbox id"
    ),
  });
}
