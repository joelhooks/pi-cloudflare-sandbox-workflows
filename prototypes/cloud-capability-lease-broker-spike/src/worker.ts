/// <reference types="@cloudflare/workers-types" />
/* eslint-disable class-methods-use-this, complexity, curly, func-style, import/consistent-type-specifier-style, max-lines, no-use-before-define, require-await, sort-keys, unicorn/no-useless-fallback-in-spread, unicorn/prefer-code-point, unicorn/prefer-string-replace-all */
/* eslint-disable complexity, max-lines, no-use-before-define */

import { getSandbox } from "@cloudflare/sandbox";
import type {
  ISandbox,
  Sandbox as SandboxDurableObject,
} from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";
import { add, clone, commit, init as gitInit, push } from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { z } from "zod";

import { ArtifactsFilesRefResolver } from "./adapters/artifacts-files-ref.ts";
import { CloudflareSecretMaterialStore } from "./adapters/cloudflare-secret-material-store.ts";
import { DurableObjectCapabilityReceiptSink } from "./adapters/durable-object-capability-receipt-sink.ts";
import { GitHubAppPullRequestOutput } from "./adapters/github-app-pull-request-output.ts";
import { PrototypePolicyAuthorizer } from "./adapters/prototype-policy-authorizer.ts";
import {
  buildPrototypePrBody,
  CapabilityLeaseRequestSchema,
  type CapabilityLeaseReceipt,
  type CapabilityBlocker,
  type CapabilityLeaseRequest,
  type CapabilityLeaseResult,
  type GeneratedFile,
  GeneratedFileSchema,
  PayloadBoundCapabilityLeaseBroker,
  ResolvedFilesPayloadSchema,
  type ResolvedFilesPayload,
} from "./core/index.ts";
import { MemoryFS } from "./memory-fs.ts";

export { Sandbox } from "@cloudflare/sandbox";

interface Env {
  ACCESS_TOKEN?: string;
  ARTIFACTS: Artifacts;
  CAPABILITY_QUEUE: Queue<CapabilityQueueMessage>;
  CAPABILITY_RUNS: DurableObjectNamespace<CapabilityRun>;
  GITHUB_APP_ID?: string;
  GITHUB_APP_INSTALLATION_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  Sandbox: DurableObjectNamespace<SandboxDurableObject>;
}

interface RealSandbox extends ISandbox {
  destroy(): Promise<void>;
}

interface CapabilityQueueMessage {
  runId: string;
  type: "execute";
  workItemId: string;
}

interface CommandResult {
  command: string;
  duration: number;
  exitCode: number;
  stderr: string;
  stdout: string;
  success: boolean;
  timestamp: string;
}

interface CapabilityRunRecord {
  artifactCommitSha?: string;
  artifactRemote: string;
  artifactRepoName: string;
  branch: string;
  blocker?: CapabilityBlocker;
  capabilityRequest?: CapabilityLeaseRequest;
  cleanupReceipts: string[];
  deniedProbeResults: Record<string, CapabilityLeaseResult>;
  events: WorkflowEvent[];
  filesRef?: string;
  payloadHash?: string;
  planCommitSha: string;
  prBodyHash?: string;
  prTitle: string;
  proposedFiles?: GeneratedFile[];
  receipt?: CapabilityLeaseReceipt;
  runId: string;
  sandboxCommand?: CommandResult;
  sandboxId?: string;
  startedAt: string;
  status:
    | "blocked"
    | "captured"
    | "executing"
    | "payload_pinned"
    | "planning"
    | "queued";
  updatedAt: string;
  workItemId: string;
}

interface WorkflowEvent {
  actor: string;
  event: string;
  message: string;
  severity: "error" | "info" | "warn";
  timestamp: string;
}

const StartRunRequestSchema = z.object({
  files: z.array(GeneratedFileSchema).optional(),
  prTitle: z
    .string()
    .min(1)
    .default("prototype: prove cloud capability lease broker"),
  workItemId: z.string().min(1).optional(),
});

const ExecuteRequestSchema = z.object({
  runId: z.string().min(1),
});

const RUN_ID_RE = /^[a-z0-9][a-z0-9-]{2,95}$/u;
const WORKER_URL =
  "https://pi-cloud-capability-lease-broker-spike.joelhooks.workers.dev";
const ALLOWED_REPO = "joelhooks/pi-cloudflare-sandbox-workflows";
const ALLOWED_SECRET_REF = "githubApp:shitrat";
const BRANCH_PREFIX = "cloud-capability-lease-";
const POLICY_ID = "policy:prototype-github-pr-v0";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/api/capability-runs") {
      if (!isAuthorized(request, env)) {
        return json({ error: "unauthorized", ok: false }, { status: 401 });
      }
      const rawBody = await request.json().catch(() => ({}));
      const parsed = StartRunRequestSchema.parse(rawBody);
      const workItemId =
        parsed.workItemId ??
        `cloud-capability-lease-${crypto.randomUUID().slice(0, 8)}`;
      const stub = capabilityRunStub(env, workItemId);
      return stub.fetch(
        new Request("https://capability-run.local/start", {
          body: JSON.stringify({ ...parsed, workItemId }),
          method: "POST",
        })
      );
    }

    const runMatch = url.pathname.match(/^\/api\/capability-runs\/([^/]+)$/u);
    if (request.method === "GET" && runMatch?.[1]) {
      if (!isAuthorized(request, env)) {
        return json({ error: "unauthorized", ok: false }, { status: 401 });
      }
      return capabilityRunStub(env, decodeURIComponent(runMatch[1])).fetch(
        new Request("https://capability-run.local/record")
      );
    }

    const observerMatch = url.pathname.match(/^\/observer\/([^/]+)$/u);
    if (request.method === "GET" && observerMatch?.[1]) {
      return capabilityRunStub(env, decodeURIComponent(observerMatch[1])).fetch(
        new Request("https://capability-run.local/observer")
      );
    }

    return json({ error: "not found", ok: false }, { status: 404 });
  },

  async queue(batch: MessageBatch<CapabilityQueueMessage>, env: Env) {
    for (const message of batch.messages) {
      try {
        const stub = capabilityRunStub(env, message.body.workItemId);
        const response = await stub.fetch(
          new Request("https://capability-run.local/execute", {
            body: JSON.stringify({ runId: message.body.runId }),
            method: "POST",
          })
        );
        if (!response.ok) throw new Error(await response.text());
        message.ack();
      } catch (error) {
        message.retry({ delaySeconds: 5 });
        console.error(
          `capability queue failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  },
};

export class CapabilityRun extends DurableObject<Env> {
  override fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method === "POST" && pathname === "/start") {
      return this.start(request);
    }
    if (request.method === "POST" && pathname === "/execute") {
      return this.execute(request);
    }
    if (request.method === "GET" && pathname === "/record") {
      return this.record();
    }
    if (request.method === "GET" && pathname === "/observer") {
      return this.observer();
    }
    return Promise.resolve(
      json({ error: "not found", ok: false }, { status: 404 })
    );
  }

  async appendReceipt(receipt: CapabilityLeaseReceipt): Promise<void> {
    const record = await this.requireRecord();
    await this.putRecord({
      ...this.recordEvent(record, {
        actor: "broker",
        event: "RECEIPT_RECORDED",
        message:
          "Redacted capability receipt recorded in Durable Object state.",
        severity: "info",
      }),
      receipt,
      status: "captured",
    });
  }

  private async start(request: Request): Promise<Response> {
    const body = StartRunRequestSchema.required({ workItemId: true }).parse(
      await request.json()
    );
    const runId = `run-${slugify(body.workItemId)}-${crypto.randomUUID().slice(0, 8)}`;
    const branch = `${BRANCH_PREFIX}${runId.slice(-8)}`;
    const artifactRepoName = `piclb-${slugify(runId)}`;
    const createdRepo = await this.env.ARTIFACTS.create(artifactRepoName, {
      description: `cloud capability lease broker proof ${runId}`,
      readOnly: false,
      setDefaultBranch: "main",
    });
    const authedRemote = toAuthenticatedRemote(
      createdRepo.remote,
      createdRepo.token
    );
    const planCommit = await commitArtifacts({
      files: {
        "README.md": `# ${runId}\n\nCloud capability lease broker proof Artifacts repo.\n`,
        "run/plan.json": JSON.stringify(
          {
            branch,
            capability: "github.openPullRequest",
            localRole: "start-poll-verify-only",
            repo: ALLOWED_REPO,
            runId,
            workItemId: body.workItemId,
          },
          null,
          2
        ),
      },
      message: "pin capability broker plan",
      remote: createdRepo.remote,
      tokenSecret: authedRemote.tokenSecret,
    });
    await this.ctx.storage.put("artifactTokenSecret", createdRepo.token);
    const record: CapabilityRunRecord = this.recordEvent(
      {
        artifactRemote: createdRepo.remote,
        artifactRepoName,
        branch,
        cleanupReceipts: [],
        deniedProbeResults: {},
        events: [],
        planCommitSha: planCommit.commit,
        prTitle: body.prTitle,
        ...(body.files ? { proposedFiles: body.files } : {}),
        runId,
        startedAt: new Date().toISOString(),
        status: "queued",
        updatedAt: new Date().toISOString(),
        workItemId: body.workItemId,
      },
      {
        actor: "control-plane",
        event: "PLAN_PINNED",
        message:
          "Plan committed to Artifacts before sandbox payload generation.",
        severity: "info",
      }
    );
    await this.putRecord(record);
    await this.env.CAPABILITY_QUEUE.send({
      runId,
      type: "execute",
      workItemId: body.workItemId,
    });
    return json({
      ok: true,
      record: sanitizeRecord(record),
      runId,
      workerUrl: WORKER_URL,
      workItemId: body.workItemId,
    });
  }

  private async execute(request: Request): Promise<Response> {
    const body = ExecuteRequestSchema.parse(await request.json());
    const record = await this.requireRecord();
    if (body.runId !== record.runId) {
      return json({ ok: true, reason: "stale-run-message" });
    }
    if (record.status === "captured" || record.status === "blocked") {
      return json({ ok: true, record: sanitizeRecord(record) });
    }

    try {
      const executing = this.recordEvent(
        { ...record, status: "executing" },
        {
          actor: "control-plane",
          event: "SANDBOX_PAYLOAD_STARTING",
          message:
            "Sandbox will prepare payload files and push them to Artifacts.",
          severity: "info",
        }
      );
      await this.putRecord(executing);

      const prepared = await preparePayloadInSandbox(
        this.env,
        executing,
        requireValue(
          await this.ctx.storage.get<string>("artifactTokenSecret"),
          "artifactTokenSecret"
        )
      );
      const requestEnvelope = await buildCapabilityRequest({
        filesRef: prepared.filesRef,
        payloadHash: prepared.payloadHash,
        prTitle: executing.prTitle,
        record: executing,
      });
      const payloadPinned = this.recordEvent(
        {
          ...executing,
          artifactCommitSha: prepared.artifactCommitSha,
          capabilityRequest: requestEnvelope,
          cleanupReceipts: [
            ...executing.cleanupReceipts,
            prepared.destroyReceipt,
          ],
          filesRef: prepared.filesRef,
          payloadHash: prepared.payloadHash,
          prBodyHash: requestEnvelope.prBodyHash,
          sandboxCommand: prepared.command,
          sandboxId: prepared.sandboxId,
          status: "payload_pinned",
        },
        {
          actor: "sandbox",
          event: "PAYLOAD_PINNED",
          message:
            "Sandbox committed payload and capability request to Artifacts.",
          severity: "info",
        }
      );
      await this.putRecord(payloadPinned);

      const broker = await this.createBroker(payloadPinned);
      const deniedProbeResults = await runDeniedProbes(broker, requestEnvelope);
      const result = await broker.requestCapability(requestEnvelope);
      const next = this.recordEvent(
        {
          ...(await this.requireRecord()),
          ...(result.status === "blocked" ? { blocker: result.blocker } : {}),
          deniedProbeResults,
          status: result.status === "blocked" ? "blocked" : "captured",
        },
        {
          actor: "broker",
          event:
            result.status === "blocked"
              ? "CAPABILITY_BLOCKED"
              : "CAPABILITY_EXECUTED",
          message:
            result.status === "blocked"
              ? result.blocker.message
              : "Cloud broker executed GitHub PR capability.",
          severity: result.status === "blocked" ? "error" : "info",
        }
      );
      await this.putRecord(
        result.status === "executed"
          ? { ...next, receipt: result.receipt }
          : next
      );
      return json({
        ok: true,
        record: sanitizeRecord(await this.requireRecord()),
      });
    } catch (error) {
      const failed = this.recordEvent(
        { ...(await this.requireRecord()), status: "blocked" },
        {
          actor: "control-plane",
          event: "RUN_BLOCKED",
          message: redactError(error),
          severity: "error",
        }
      );
      await this.putRecord(failed);
      return json({ ok: true, record: sanitizeRecord(failed) });
    }
  }

  private async record(): Promise<Response> {
    return json({ ok: true, record: sanitizeRecord(await this.getRecord()) });
  }

  private async observer(): Promise<Response> {
    return json({
      ok: true,
      record: sanitizeObserverRecord(await this.getRecord()),
    });
  }

  private async createBroker(
    record: CapabilityRunRecord
  ): Promise<PayloadBoundCapabilityLeaseBroker> {
    const artifactTokenSecret = requireValue(
      await this.ctx.storage.get<string>("artifactTokenSecret"),
      "artifactTokenSecret"
    );
    return new PayloadBoundCapabilityLeaseBroker({
      authorizer: new PrototypePolicyAuthorizer({
        allowedRepo: ALLOWED_REPO,
        allowedSecretRef: ALLOWED_SECRET_REF,
        branchPrefix: BRANCH_PREFIX,
        policyId: POLICY_ID,
      }),
      filesRefResolver: new ArtifactsFilesRefResolver({
        artifactRemote: record.artifactRemote,
        artifactTokenSecret,
      }),
      pullRequestOutput: new GitHubAppPullRequestOutput(),
      receiptSink: new DurableObjectCapabilityReceiptSink(this),
      secretMaterialStore: new CloudflareSecretMaterialStore({
        appId: this.env.GITHUB_APP_ID,
        installationId: this.env.GITHUB_APP_INSTALLATION_ID,
        privateKeyPem: this.env.GITHUB_APP_PRIVATE_KEY,
      }),
    });
  }

  private async getRecord(): Promise<CapabilityRunRecord | undefined> {
    return this.ctx.storage.get<CapabilityRunRecord>("record");
  }

  private async requireRecord(): Promise<CapabilityRunRecord> {
    return requireValue(await this.getRecord(), "record");
  }

  private async putRecord(record: CapabilityRunRecord): Promise<void> {
    await this.ctx.storage.put("record", {
      ...record,
      updatedAt: new Date().toISOString(),
    });
  }

  private recordEvent(
    record: CapabilityRunRecord,
    event: Omit<WorkflowEvent, "timestamp">
  ): CapabilityRunRecord {
    return {
      ...record,
      events: [
        ...record.events,
        { ...event, timestamp: new Date().toISOString() },
      ],
      updatedAt: new Date().toISOString(),
    };
  }
}

async function preparePayloadInSandbox(
  env: Env,
  record: CapabilityRunRecord,
  tokenSecret: string
): Promise<{
  artifactCommitSha: string;
  command: CommandResult;
  destroyReceipt: string;
  filesRef: string;
  payloadHash: string;
  sandboxId: string;
}> {
  const sandboxId = buildSandboxId(record.runId);
  const sandbox = getSandbox(env.Sandbox, sandboxId) as RealSandbox;
  const authedRemote = toAuthenticatedRemote(
    record.artifactRemote,
    tokenSecret
  );
  const files = buildGeneratedPrFiles(record);
  const payloadHash = await sha256(JSON.stringify(files));
  const filesRef = "artifacts:run/payload.json";
  const payload: ResolvedFilesPayload = ResolvedFilesPayloadSchema.parse({
    files,
    filesRef,
    payloadHash,
  });
  const requestPreview = await buildCapabilityRequest({
    filesRef,
    payloadHash,
    prTitle: record.prTitle,
    record,
  });
  await appendArtifacts({
    files: {
      "run/capability-request.json": `${JSON.stringify(requestPreview, null, 2)}\n`,
      "run/payload.json": `${JSON.stringify(payload, null, 2)}\n`,
    },
    message: "pin payload-bound capability request",
    remote: record.artifactRemote,
    tokenSecret,
  });
  const command = buildPayloadSandboxCommand();
  let result: CommandResult | undefined;
  let destroyReceipt = `destroy:${sandboxId}:not-attempted`;
  try {
    result = await runCommand(sandbox, command, {
      ARTIFACTS_GIT_REMOTE: authedRemote.remote,
      FILES_REF: filesRef,
      PAYLOAD_HASH: payloadHash,
      PIWF_COMMAND_TIMEOUT_SECONDS: "240",
      RUN_ID: record.runId,
    });
  } finally {
    destroyReceipt = await destroySandbox(sandbox, sandboxId);
  }
  if (!result) {
    throw new Error(`sandbox_payload_result_missing\n${destroyReceipt}`);
  }
  if (!result.success) {
    throw new Error(
      [
        `sandbox_payload_failed:${result.exitCode}`,
        redactText(result.stdout).slice(0, 1200),
        redactText(result.stderr).slice(0, 1200),
      ]
        .filter((part) => part.length > 0)
        .join("\n")
    );
  }
  const commitMatch = result.stdout.match(
    /__CAPABILITY_COMMIT__:([a-f0-9]{40})/u
  );
  if (!commitMatch?.[1]) {
    throw new Error("sandbox_payload_commit_missing");
  }
  return {
    artifactCommitSha: commitMatch[1],
    command: result,
    destroyReceipt,
    filesRef,
    payloadHash,
    sandboxId,
  };
}

async function buildCapabilityRequest(input: {
  filesRef: string;
  payloadHash: string;
  prTitle: string;
  record: CapabilityRunRecord;
}): Promise<CapabilityLeaseRequest> {
  const baseRequest: CapabilityLeaseRequest = {
    actor: { id: "cloud-workflow", kind: "agent" },
    branch: input.record.branch,
    capability: "github.openPullRequest",
    expiresInSeconds: 900,
    filesRef: input.filesRef,
    payloadHash: input.payloadHash,
    prBodyHash: "0".repeat(64),
    prTitle: input.prTitle,
    repo: ALLOWED_REPO,
    runId: input.record.runId,
    secretRef: ALLOWED_SECRET_REF,
    workItemId: input.record.workItemId,
  };
  return CapabilityLeaseRequestSchema.parse({
    ...baseRequest,
    prBodyHash: await sha256(buildPrototypePrBody(baseRequest)),
  });
}

async function runDeniedProbes(
  broker: PayloadBoundCapabilityLeaseBroker,
  request: CapabilityLeaseRequest
): Promise<Record<string, CapabilityLeaseResult>> {
  return {
    capabilityDenied: await broker.requestCapability({
      ...request,
      branch: "unapproved-branch",
    }),
    missingSecretApproval: await broker.requestCapability({
      ...request,
      secretRef: "githubApp:not-approved",
    }),
    payloadHashMismatch: await broker.requestCapability({
      ...request,
      payloadHash: "0".repeat(64),
    }),
  };
}

function buildGeneratedPrFiles(record: CapabilityRunRecord): GeneratedFile[] {
  const proofFiles: GeneratedFile[] = [
    {
      content: [
        "# Cloud capability lease broker proof",
        "",
        `Run: \`${record.runId}\``,
        `Work item: \`${record.workItemId}\``,
        "",
        "This file was generated inside a Cloudflare Sandbox, pinned to Cloudflare Artifacts, then published to GitHub by a Cloudflare Worker/Durable Object broker.",
        "",
        "The sandbox saw an Artifacts remote only. It did not receive GitHub App private key material, installation tokens, token-bearing GitHub remotes, or ShitRat credentials.",
        "",
        "Broker capability: `github.openPullRequest`",
        `Branch: \`${record.branch}\``,
        "",
      ].join("\n"),
      path: `prototypes/cloud-capability-lease-broker-spike/generated/${record.runId}.md`,
    },
    {
      content: `${JSON.stringify(
        {
          actor: "cloud-workflow",
          branch: record.branch,
          capability: "github.openPullRequest",
          publicSafe: true,
          runId: record.runId,
          workItemId: record.workItemId,
        },
        null,
        2
      )}\n`,
      path: `prototypes/cloud-capability-lease-broker-spike/generated/${record.runId}.json`,
    },
  ];
  return record.proposedFiles
    ? [...record.proposedFiles, ...proofFiles]
    : proofFiles;
}

function buildPayloadSandboxCommand(): string {
  return String.raw`set -euo pipefail
rm -rf /workspace/capability-payload
mkdir -p /workspace/capability-payload
git clone "$ARTIFACTS_GIT_REMOTE" /workspace/capability-payload
cd /workspace/capability-payload
node <<'CAPABILITY_PAYLOAD_JS'
const fs = require('fs');
fs.mkdirSync('run', { recursive: true });
fs.writeFileSync('run/sandbox-receipt.json', JSON.stringify({
  generatedAt: new Date().toISOString(),
  note: 'Sandbox cloned the payload-bound Artifacts repo and added execution receipt metadata. GitHub capability execution happens in Worker/DO.',
  payloadHash: process.env.PAYLOAD_HASH,
  filesRef: process.env.FILES_REF,
  runId: process.env.RUN_ID
}, null, 2) + '\n');
CAPABILITY_PAYLOAD_JS
git add run/sandbox-receipt.json
git -c user.name='shitratgit[bot]' -c user.email='shitratgit[bot]@users.noreply.github.com' commit -m 'record sandbox payload receipt'
git push origin main
printf '__CAPABILITY_COMMIT__:%s\n' "$(git rev-parse HEAD)"
`;
}

async function appendArtifacts(input: {
  files: Record<string, string>;
  message: string;
  remote: string;
  tokenSecret: string;
}): Promise<{ commit: string }> {
  const fs = new MemoryFS();
  const dir = "/repo";
  await clone({
    depth: 1,
    dir,
    fs,
    http,
    onAuth: () => ({ password: input.tokenSecret, username: "x" }),
    singleBranch: true,
    url: input.remote,
  });
  for (const [path, content] of Object.entries(input.files)) {
    await fs.promises.writeFile(`${dir}/${path}`, content);
    await add({ dir, filepath: path, fs });
  }
  const sha = await commit({
    author: {
      email: "shitratgit[bot]@users.noreply.github.com",
      name: "shitratgit[bot]",
    },
    dir,
    fs,
    message: input.message,
  });
  await push({
    dir,
    fs,
    http,
    onAuth: () => ({ password: input.tokenSecret, username: "x" }),
    ref: "main",
    url: input.remote,
  });
  return { commit: sha };
}

async function commitArtifacts(input: {
  files: Record<string, string>;
  message: string;
  remote: string;
  tokenSecret: string;
}): Promise<{ commit: string }> {
  const fs = new MemoryFS();
  const dir = "/repo";
  await gitInit({ defaultBranch: "main", dir, fs });
  for (const [path, content] of Object.entries(input.files)) {
    await fs.promises.writeFile(`${dir}/${path}`, content);
    await add({ dir, filepath: path, fs });
  }
  const sha = await commit({
    author: {
      email: "shitratgit[bot]@users.noreply.github.com",
      name: "shitratgit[bot]",
    },
    dir,
    fs,
    message: input.message,
  });
  await push({
    dir,
    fs,
    http,
    onAuth: () => ({ password: input.tokenSecret, username: "x" }),
    ref: "main",
    url: input.remote,
  });
  return { commit: sha };
}

async function runCommand(
  sandbox: ISandbox,
  command: string,
  env: Record<string, string>
): Promise<CommandResult> {
  const started = Date.now();
  const timeoutSeconds = env["PIWF_COMMAND_TIMEOUT_SECONDS"] ?? "300";
  const wrapped = `cat > /tmp/piwf-command.sh <<'PIWF_SCRIPT'\n${command}\nPIWF_SCRIPT\nchmod +x /tmp/piwf-command.sh\ntimeout "${timeoutSeconds}" bash /tmp/piwf-command.sh 2>&1\nprintf '\n__PIWF_EXIT_CODE__:%s\n' "$?"`;
  const result = await sandbox.exec(wrapped, {
    env,
    timeout: Number(timeoutSeconds) * 1000 + 60_000,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const exitCode = parseExitCode(stdout);
  return {
    command: command.slice(0, 400),
    duration: Date.now() - started,
    exitCode,
    stderr,
    stdout,
    success: exitCode === 0,
    timestamp: new Date().toISOString(),
  };
}

async function destroySandbox(
  sandbox: RealSandbox,
  sandboxId: string
): Promise<string> {
  try {
    await sandbox.destroy();
    return `destroy:${sandboxId}:ok`;
  } catch (error) {
    return `destroy:${sandboxId}:error:${redactError(error)}`;
  }
}

function parseExitCode(stdout: string): number {
  const matches = [...stdout.matchAll(/__PIWF_EXIT_CODE__:(\d+)/gu)];
  const last = matches.at(-1)?.[1];
  return last ? Number(last) : 1;
}

function toAuthenticatedRemote(
  remote: string,
  tokenSecret: string
): { remote: string; tokenSecret: string } {
  return {
    remote: [
      "https://",
      "x:",
      encodeURIComponent(tokenSecret),
      "@",
      remote.slice("https://".length),
    ].join(""),
    tokenSecret,
  };
}

function capabilityRunStub(
  env: Env,
  workItemId: string
): DurableObjectStub<CapabilityRun> {
  return env.CAPABILITY_RUNS.get(env.CAPABILITY_RUNS.idFromName(workItemId));
}

function buildSandboxId(runId: string): string {
  const slug = slugify(runId).slice(0, 55);
  const id = `cap-${slug}`;
  if (!RUN_ID_RE.test(id)) throw new Error(`invalid sandbox id: ${id}`);
  return id;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 80);
}

function isAuthorized(request: Request, env: Env): boolean {
  if (!env.ACCESS_TOKEN) return false;
  const header = request.headers.get("authorization") ?? "";
  return header === `Bearer ${env.ACCESS_TOKEN}`;
}

function sanitizeRecord(
  record: CapabilityRunRecord | undefined
): CapabilityRunRecord | undefined {
  if (!record) return undefined;
  const sanitized: CapabilityRunRecord = { ...record };
  if (record.sandboxCommand) {
    sanitized.sandboxCommand = {
      ...record.sandboxCommand,
      stderr: redactText(record.sandboxCommand.stderr),
      stdout: redactText(record.sandboxCommand.stdout),
    };
  }
  return sanitized;
}

function sanitizeObserverRecord(
  record: CapabilityRunRecord | undefined
): unknown {
  if (!record) return undefined;
  return {
    artifactCommitSha: record.artifactCommitSha,
    artifactRepoName: record.artifactRepoName,
    branch: record.branch,
    cleanupReceipts: record.cleanupReceipts,
    deniedProbeResults: summarizeDeniedProbes(record.deniedProbeResults),
    events: record.events,
    filesRef: record.filesRef,
    payloadHash: record.payloadHash,
    planCommitSha: record.planCommitSha,
    prBodyHash: record.prBodyHash,
    receipt: record.receipt,
    runId: record.runId,
    sandboxId: record.sandboxId,
    status: record.status,
    updatedAt: record.updatedAt,
    workItemId: record.workItemId,
  };
}

function summarizeDeniedProbes(
  probes: Record<string, CapabilityLeaseResult>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(probes).map(([key, value]) => [
      key,
      value.status === "blocked"
        ? { blocker: value.blocker, status: value.status }
        : { status: value.status },
    ])
  );
}

function redactText(value: string): string {
  return value
    .replace(/https:\/\/x:[^@\s]+@/gu, "https://x:[REDACTED]@")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gu, "Bearer [REDACTED]")
    .replace(
      /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gu,
      "[REDACTED_PEM]"
    );
}

function redactError(error: unknown): string {
  return redactText(error instanceof Error ? error.message : String(error));
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function requireValue<T>(value: T | null | undefined, name: string): T {
  if (value === undefined || value === null) throw new Error(`${name} missing`);
  return value;
}

function json(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init?.headers ?? {}),
    },
  });
}
