/// <reference types="@cloudflare/workers-types" />
/* eslint-disable func-style, no-use-before-define, sort-keys */

import { getSandbox, proxyToSandbox } from "@cloudflare/sandbox";
import type {
  ISandbox,
  Sandbox as SandboxDurableObject,
} from "@cloudflare/sandbox";
import { add, commit, init as gitInit, push } from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { createActor } from "xstate";

import { sandboxWorkflowMachine } from "./machine.ts";
import type { RunEvent } from "./machine.ts";
import { MemoryFS } from "./memory-fs.ts";
import {
  PlanSchema,
  RunManifestSchema,
  VerificationContractSchema,
  VerificationResultSchema,
  WzrrdPublishResultSchema,
} from "./schema.ts";
import type {
  Plan,
  RunManifest,
  VerificationContract,
  VerificationResult,
  WzrrdPublishResult,
} from "./schema.ts";

export { Sandbox } from "@cloudflare/sandbox";

interface Env {
  Sandbox: DurableObjectNamespace<SandboxDurableObject>;
  ARTIFACTS: Artifacts;
  ACCESS_TOKEN?: string;
  PI_AUTH_JSON_B64?: string;
  PI_REAL_MODEL?: string;
  WZRRD_API_TOKEN?: string;
}

interface RealSandbox extends ISandbox {
  destroy(): Promise<void>;
}

interface RunRequest {
  capsuleId?: unknown;
  destroy?: unknown;
  model?: unknown;
  runId?: unknown;
  task?: unknown;
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

interface WorkflowEventReceipt {
  at: string;
  context: unknown;
  event: RunEvent["type"];
  state: unknown;
}

type WzrrdApiSite = WzrrdPublishResult & {
  claimTokenHash?: string;
  expiration?: unknown;
};

const DEFAULT_CAPSULE_ID = "capsule:research-claude-workflows";
const DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_TASK =
  "Produce a concise source-backed report on Claude dynamic workflows as a Pi sandbox workflow dogfood artifact.";
const RUN_ID_RE = /^[a-z0-9][a-z0-9-]{2,62}$/u;

const CONTEXT_PACK = {
  description:
    "Minimal real-prototype context pack for researching Claude dynamic workflows with source-backed verification.",
  id: "research-claude-workflows",
  kind: "pi-context-pack",
  outputs: {
    contextPack: "artifacts/context-pack/pack.json",
    report: "artifacts/report.md",
    sourceMap: "artifacts/sources.json",
    wzrrdPage: "artifacts/wzrrd/review.html",
  },
  permissions: {
    filesystem: "artifacts-worktree-write",
    network: "model-provider-through-pi-only",
    secrets: [
      {
        name: "piCodexAuth",
        scope: "user",
        use: "mint-task-scoped-auth-json",
      },
    ],
  },
  verificationDefault: {
    contractId: "research-source-grounding-v1",
    contractRef: "run/verification-contract.json",
    resultRef: "artifacts/verification/result.json",
  },
  sourceRules: [
    "Every visible factual claim in report.md must cite a source id from run/source-seed.json.",
    "Interpretation belongs under an Implications for Pi section.",
    "The generated report, source map, context pack manifest, Wzrrd review page, and run receipt must be committed to Artifacts.",
  ],
  status: "real-prototype",
  taskMatchers: [
    "research-claude-workflows",
    "dynamic workflows",
    "Claude Code workflows",
    "harness as code",
  ],
  version: "0.1.0-real-prototype",
} as const;

const SOURCE_SEED = [
  {
    id: "anthropic-dynamic-workflows-blog",
    title: "A harness for every task: dynamic workflows in Claude Code",
    url: "https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code",
    claims: [
      "Dynamic workflows let Claude Code write and orchestrate task-specific multi-agent JavaScript harnesses on the fly.",
      "The source names classify-and-act, fan-out-and-synthesize, adversarial verification, generate-and-filter, tournament, and loop-until-done as workflow patterns.",
      "The source warns workflows use more tokens and are not needed for every task.",
      "The source says workflow files or skills can save/share reusable workflows.",
    ],
  },
  {
    id: "cloudflare-sandbox-sdk-artifacts-doc",
    title: "Sandbox SDK + Artifacts",
    url: "https://developers.cloudflare.com/artifacts/examples/sandbox-sdk-artifacts/",
    claims: [
      "Cloudflare's example creates or reuses a sandbox and an Artifacts repo with the same ID.",
      "The example passes an authenticated Git remote into the sandbox as ARTIFACTS_GIT_REMOTE.",
      "Code inside the sandbox can use ARTIFACTS_GIT_REMOTE with normal git clone, fetch, pull, or push.",
    ],
  },
  {
    id: "cloudflare-artifacts-best-practices",
    title: "Best practices for Artifacts",
    url: "https://developers.cloudflare.com/artifacts/concepts/best-practices/",
    claims: [
      "Artifacts recommends creating one repo per agent, session, or application for isolation.",
      "Artifacts recommends short-lived least-privilege repo tokens.",
      "Artifacts recommends git notes for prompts, model output, run IDs, and harness metadata.",
    ],
  },
  {
    id: "project-brain-pi-sandbox-workflows",
    title: "Project Brain: Pi Sandbox Workflows",
    url: ".brain/projects/pi-sandbox-workflows.svx",
    claims: [
      "The desired product shape is contextual sandboxes for bounded runs, not a persistent browser TUI.",
      "Context capsules are durable records keyed by external work item or thread, while sandbox IDs are replaceable compute handles.",
      "The secret flow should remain secretRef to lease broker to task-scoped auth.json.",
    ],
  },
] as const;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!isAuthorized(request, env)) {
      return json({ error: "unauthorized" }, { status: 401 });
    }

    const proxyResponse = await proxyToSandbox(request, env);
    if (proxyResponse) {
      return proxyResponse;
    }

    const url = new URL(request.url);

    if (url.pathname === "/") {
      return html(
        renderIndex(Boolean(env.ACCESS_TOKEN), Boolean(env.PI_AUTH_JSON_B64))
      );
    }

    if (url.pathname === "/healthz") {
      return json({
        authRequired: Boolean(env.ACCESS_TOKEN),
        ok: true,
        piAuthConfigured: Boolean(env.PI_AUTH_JSON_B64),
      });
    }

    if (request.method === "POST" && url.pathname === "/api/real-run") {
      return runRealPrototype(request, env);
    }

    return json({ error: "not found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;

// eslint-disable-next-line complexity -- throwaway real-substrate prototype route keeps the receipt chain inline.
async function runRealPrototype(request: Request, env: Env): Promise<Response> {
  if (!env.PI_AUTH_JSON_B64) {
    return json(
      {
        error: "missing PI_AUTH_JSON_B64",
        howToSet:
          "node prototypes/sandbox-workflow-spike/scripts/extract-codex-auth.mjs | pnpm exec wrangler secret put PI_AUTH_JSON_B64 --config prototypes/sandbox-workflow-spike/wrangler.jsonc",
        ok: false,
      },
      { status: 412 }
    );
  }

  const body = await parseRunRequest(request);
  const runId = getRunId(body.runId);
  const capsuleId = getString(body.capsuleId) ?? DEFAULT_CAPSULE_ID;
  const model = getModel(body.model) ?? env.PI_REAL_MODEL ?? DEFAULT_MODEL;
  const task = getString(body.task) ?? DEFAULT_TASK;
  const shouldDestroy = body.destroy !== false;
  const sandboxId = runId;
  const artifactRepoName = `piwf-${runId}`;
  const contextPackRef = `artifacts:${artifactRepoName}/context-packs/${CONTEXT_PACK.id}@${CONTEXT_PACK.version}`;
  const authLeaseRef = `lease:piCodexAuth:${runId}:task-scoped-auth-json`;
  const actor = createActor(sandboxWorkflowMachine);
  const workflowEvents: WorkflowEventReceipt[] = [];
  let sandbox: RealSandbox | undefined;
  let destroyReceipt: string | undefined;
  let tokenSecret = "";

  actor.start();

  const send = (event: RunEvent) => {
    actor.send(event);
    workflowEvents.push({
      at: new Date().toISOString(),
      context: actor.getSnapshot().context,
      event: event.type,
      state: actor.getSnapshot().value,
    });
  };

  try {
    send({ runId, type: "START" });
    send({ capsuleId, type: "CAPSULE_RESOLVED" });
    send({ ref: contextPackRef, type: "CONTEXT_PACK_PINNED" });

    const createdRepo = await env.ARTIFACTS.create(artifactRepoName, {
      description: `Real Pi sandbox workflow prototype run ${runId}`,
      readOnly: false,
      setDefaultBranch: "main",
    });
    const authedRemote = toAuthenticatedRemote(
      createdRepo.remote,
      createdRepo.token
    );
    ({ tokenSecret } = authedRemote);

    const verificationContract = buildVerificationContract();
    const runManifest = buildRunManifest({
      artifactRepoName,
      capsuleId,
      contextPackRef,
      model,
      runId,
      task,
    });
    const plan = buildPlan({
      artifactRepoName,
      capsuleId,
      contextPackRef,
      model,
      runId,
      task,
    });
    const planFiles = buildPlanPhaseFiles({
      plan,
      runManifest,
      task,
      verificationContract,
    });
    const planCommit = await commitPlanPhaseArtifacts({
      files: planFiles,
      remote: createdRepo.remote,
      tokenSecret,
    });

    send({
      artifactRefs: planFiles.map(
        (file) =>
          `artifacts:${artifactRepoName}@${planCommit.commit}:${file.path}`
      ),
      harnessRef: plan.artifacts.harness,
      machineRef: plan.artifacts.machine,
      planRef: plan.artifacts.plan,
      type: "PLAN_COMMITTED",
      verificationContractRef: plan.artifacts.verificationContract,
    });

    send({ ref: authLeaseRef, type: "AUTH_LEASE_MINTED" });

    sandbox = getSandbox(env.Sandbox, sandboxId, {
      normalizeId: true,
    }) as unknown as RealSandbox;
    await sandbox.setEnvVars({ ARTIFACTS_GIT_REMOTE: authedRemote.remote });
    await seedPiAuth(sandbox, env.PI_AUTH_JSON_B64);
    send({ role: "reader", sandboxId, type: "SANDBOX_READY" });

    const setupResult = await runCommand(
      sandbox,
      buildSetupCommand(),
      { tokenSecret },
      { timeout: 120_000 }
    );
    assertCommand(setupResult, "artifact checkout");

    const readerResult = await runCommand(
      sandbox,
      buildReaderCommand(),
      { tokenSecret },
      {
        env: {
          CAPSULE_ID: capsuleId,
          CONTEXT_PACK_REF: contextPackRef,
          PI_MODEL: model,
          RUN_ID: runId,
        },
        timeout: 360_000,
      }
    );
    assertCommand(readerResult, "reader lane Pi run");

    send({
      artifactRefs: [
        `artifacts:${artifactRepoName}/artifacts/report.md`,
        `artifacts:${artifactRepoName}/artifacts/sources.json`,
        `artifacts:${artifactRepoName}/artifacts/context-pack/pack.json`,
        `artifacts:${artifactRepoName}/artifacts/reader/receipt.json`,
      ],
      type: "READER_RUN_COMPLETE",
    });

    const readerCommitResult = await runCommand(
      sandbox,
      buildCommitCommand("reader", "reader lane outputs"),
      { tokenSecret },
      {
        env: {
          CAPSULE_ID: capsuleId,
          CONTEXT_PACK_REF: contextPackRef,
          PI_MODEL: model,
          RUN_ID: runId,
          SANDBOX_ID: sandboxId,
        },
        timeout: 120_000,
      }
    );
    assertCommand(readerCommitResult, "reader artifact commit/push");
    const readerCommitSha =
      getLastNonEmptyLine(readerCommitResult.stdout) ?? "unknown-reader-commit";

    send({
      artifactRefs: [
        `artifacts:${artifactRepoName}@${readerCommitSha || "main"}:artifacts/report.md`,
        `artifacts:${artifactRepoName}@${readerCommitSha || "main"}:artifacts/sources.json`,
        `artifacts:${artifactRepoName}@${readerCommitSha || "main"}:artifacts/context-pack/pack.json`,
        `artifacts:${artifactRepoName}@${readerCommitSha || "main"}:artifacts/reader/receipt.json`,
      ],
      commitSha: readerCommitSha,
      type: "READER_OUTPUTS_COMMITTED",
    });

    const verifierResult = await runCommand(
      sandbox,
      buildVerifierCommand(),
      { tokenSecret },
      {
        env: {
          RUN_ID: runId,
        },
        timeout: 120_000,
      }
    );
    assertCommand(verifierResult, "verifier lane run");

    const verificationResultText = await readSandboxText(
      sandbox,
      "/workspace/piwf-run/artifacts/verification/result.json"
    );
    const verificationResult = VerificationResultSchema.parse(
      JSON.parse(verificationResultText)
    );

    send({
      artifactRefs: [
        `artifacts:${artifactRepoName}/artifacts/verification/result.json`,
        `artifacts:${artifactRepoName}/artifacts/verification/report.md`,
        `artifacts:${artifactRepoName}/artifacts/wzrrd/review.html`,
      ],
      result: verificationResult,
      type: "VERIFIER_RUN_COMPLETE",
    });

    const verifierCommitResult = await runCommand(
      sandbox,
      buildCommitCommand("verifier", "verifier lane outputs"),
      { tokenSecret },
      {
        env: {
          CAPSULE_ID: capsuleId,
          CONTEXT_PACK_REF: contextPackRef,
          PI_MODEL: model,
          RUN_ID: runId,
          SANDBOX_ID: sandboxId,
        },
        timeout: 120_000,
      }
    );
    assertCommand(verifierCommitResult, "verifier artifact commit/push");
    const verifierCommitSha =
      getLastNonEmptyLine(verifierCommitResult.stdout) ??
      "unknown-verifier-commit";

    send({
      artifactRefs: [
        `artifacts:${artifactRepoName}@${verifierCommitSha || "main"}:artifacts/verification/result.json`,
        `artifacts:${artifactRepoName}@${verifierCommitSha || "main"}:artifacts/verification/report.md`,
        `artifacts:${artifactRepoName}@${verifierCommitSha || "main"}:artifacts/wzrrd/review.html`,
      ],
      commitSha: verifierCommitSha,
      type: "VERIFIER_OUTPUTS_COMMITTED",
    });

    const captureStatus = evaluateVerification(verificationResult);
    if (captureStatus === "blocked") {
      send({
        reason:
          verificationResult.blockingFailures.join("; ") ||
          "verification blocked",
        type: "VERIFICATION_BLOCKED",
      });
      throw new Error("Verification blocked capture");
    }

    send({
      status: captureStatus,
      type: "VERIFICATION_ACCEPTED",
      warnings: verificationResult.warnings,
    });

    const report = await readSandboxText(
      sandbox,
      "/workspace/piwf-run/artifacts/report.md"
    );
    const sources = await readSandboxText(
      sandbox,
      "/workspace/piwf-run/artifacts/sources.json"
    );
    const wzrrd = await readSandboxText(
      sandbox,
      "/workspace/piwf-run/artifacts/wzrrd/review.html"
    );
    const contextPack = await readSandboxText(
      sandbox,
      "/workspace/piwf-run/artifacts/context-pack/pack.json"
    );
    const harness = await readSandboxText(
      sandbox,
      "/workspace/piwf-run/workflows/harness.js"
    );
    const machine = await readSandboxText(
      sandbox,
      "/workspace/piwf-run/workflows/machine.ts"
    );
    const manifest = await readSandboxText(
      sandbox,
      "/workspace/piwf-run/run/manifest.json"
    );
    const planText = await readSandboxText(
      sandbox,
      "/workspace/piwf-run/run/plan.json"
    );
    const verificationContractText = await readSandboxText(
      sandbox,
      "/workspace/piwf-run/run/verification-contract.json"
    );
    const verificationReport = await readSandboxText(
      sandbox,
      "/workspace/piwf-run/artifacts/verification/report.md"
    );

    const wzrrdPublish = await publishWzrrdReview({
      artifactRepoName,
      commitSha: verifierCommitSha,
      contextPack,
      harness,
      machine,
      manifest,
      plan: planText,
      report,
      runId,
      sources,
      token: env.WZRRD_API_TOKEN,
      verificationContract: verificationContractText,
      verificationReport,
      verificationResult: verificationResultText,
      wzrrdHtml: wzrrd,
    });

    send({
      ref: wzrrdPublish.url,
      type: "WZRRD_PUBLISHED",
    });

    if (shouldDestroy) {
      await sandbox.destroy();
      destroyReceipt = `destroy:${sandboxId}:ok`;
    } else {
      destroyReceipt = `destroy:${sandboxId}:skipped-debug`;
    }

    send({ receipt: destroyReceipt, type: "SANDBOX_DESTROYED" });
    send({ type: "CAPTURED" });

    return json({
      artifacts: {
        defaultBranch: createdRepo.defaultBranch,
        planCommitSha: planCommit.commit,
        readerCommitSha,
        remote: createdRepo.remote,
        repoName: createdRepo.name,
        tokenExpiresAt: getTokenExpiresAt(createdRepo.token),
        verifierCommitSha,
      },
      capsule: {
        capsuleId,
        contextPackRef,
      },
      commands: {
        reader: readerResult,
        readerCommit: readerCommitResult,
        setup: setupResult,
        verifier: verifierResult,
        verifierCommit: verifierCommitResult,
      },
      outputs: {
        reportPreview: truncate(report, 6000),
        sourcesPreview: truncate(sources, 4000),
        verificationPreview: truncate(verificationReport, 4000),
        wzrrdPreview: truncate(wzrrd, 2000),
      },
      run: {
        captureStatus,
        destroyReceipt,
        model: `openai-codex/${model}`,
        runId,
        sandboxId,
        task,
      },
      state: actor.getSnapshot().value,
      verification: verificationResult,
      workflowEvents,
      wzrrd: wzrrdPublish,
      ok: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (sandbox && shouldDestroy) {
      try {
        await sandbox.destroy();
        destroyReceipt = `destroy:${sandboxId}:ok-after-error`;
      } catch (destroyError) {
        const destroyMessage =
          destroyError instanceof Error
            ? destroyError.message
            : String(destroyError);
        destroyReceipt = `destroy:${sandboxId}:failed:${destroyMessage}`;
      }
    }

    return json(
      {
        destroyReceipt,
        error: redact(message, [tokenSecret]),
        ok: false,
        runId,
        sandboxId,
        state: actor.getSnapshot().value,
        workflowEvents,
      },
      { status: 500 }
    );
  }
}

async function parseRunRequest(request: Request): Promise<RunRequest> {
  try {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as RunRequest)
      : {};
  } catch {
    return {};
  }
}

function getRunId(value: unknown): string {
  if (typeof value === "string" && RUN_ID_RE.test(value)) {
    return value;
  }

  const random = crypto.randomUUID().slice(0, 8);
  return `run-${Date.now().toString(36)}-${random}`;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getModel(value: unknown): string | undefined {
  const model = getString(value);
  if (!model) {
    return undefined;
  }

  if (!/^[A-Za-z0-9._:/-]+$/u.test(model)) {
    throw new Error(`Invalid model string: ${model}`);
  }

  return model.startsWith("openai-codex/")
    ? model.slice("openai-codex/".length)
    : model;
}

interface PlanPhaseFile {
  content: string;
  path: string;
}

function buildVerificationContract(): VerificationContract {
  return VerificationContractSchema.parse({
    criteria: [
      {
        artifacts: ["artifacts/report.md", "artifacts/sources.json"],
        description:
          "Every factual bullet in the report's source-backed section cites a known source id.",
        id: "source-citation-coverage",
        severity: "blocking",
        type: "source-citation-coverage",
      },
      {
        artifacts: [
          "artifacts/report.md",
          "artifacts/sources.json",
          "artifacts/context-pack/pack.json",
        ],
        description: "Reader lane produced the required output artifacts.",
        id: "required-reader-artifacts",
        severity: "blocking",
        type: "artifact-presence",
      },
    ],
    description:
      "Research workload verifier contract for source-grounded dynamic workflow reports.",
    evidence: {
      reportRef: "artifacts/report.md",
      sourcesRef: "artifacts/sources.json",
    },
    id: "research-source-grounding-v1",
    schemaVersion: "verification-contract.v1",
    statusPolicy: {
      blockingStatus: "blocked",
      verifiedStatus: "verified",
      warningStatus: "warnings",
    },
    title: "Research Source Grounding",
  });
}

function buildRunManifest(input: {
  artifactRepoName: string;
  capsuleId: string;
  contextPackRef: string;
  model: string;
  runId: string;
  task: string;
}): RunManifest {
  return RunManifestSchema.parse({
    artifactRepoName: input.artifactRepoName,
    capsuleId: input.capsuleId,
    contextPackRef: input.contextPackRef,
    harnessRef: "workflows/harness.js",
    machineRef: "workflows/machine.ts",
    model: `openai-codex/${input.model}`,
    planRef: "run/plan.json",
    runId: input.runId,
    schemaVersion: "run-manifest.v1",
    sourceSeedRef: "run/source-seed.json",
    task: input.task,
    verificationContractRef: "run/verification-contract.json",
  });
}

function buildPlan(input: {
  artifactRepoName: string;
  capsuleId: string;
  contextPackRef: string;
  model: string;
  runId: string;
  task: string;
}): Plan {
  return PlanSchema.parse({
    artifactRepoName: input.artifactRepoName,
    artifacts: {
      harness: "workflows/harness.js",
      machine: "workflows/machine.ts",
      manifest: "run/manifest.json",
      plan: "run/plan.json",
      verificationContract: "run/verification-contract.json",
      verificationReport: "artifacts/verification/report.md",
      verificationResult: "artifacts/verification/result.json",
      wzrrdPage: "artifacts/wzrrd/review.html",
    },
    capsuleId: input.capsuleId,
    contextPackRef: input.contextPackRef,
    generatedAt: new Date().toISOString(),
    lanes: [
      {
        dependsOn: [],
        id: "reader",
        outputs: [
          "artifacts/report.md",
          "artifacts/sources.json",
          "artifacts/context-pack/pack.json",
          "artifacts/reader/receipt.json",
        ],
        role: "reader",
      },
      {
        dependsOn: ["reader"],
        id: "verifier",
        outputs: [
          "artifacts/verification/result.json",
          "artifacts/verification/report.md",
          "artifacts/wzrrd/review.html",
        ],
        role: "verifier",
      },
    ],
    model: `openai-codex/${input.model}`,
    pattern: "reader-verifier",
    planPhase: {
      executor: "fixed-prototype-reader-verifier",
      generatedMachineRuntime: "receipt-only",
      pinnedBeforeSandbox: true,
    },
    policies: {
      captureWarnings: true,
      cleanup: "destroy-sandbox",
      concurrencyCap: 2,
    },
    runId: input.runId,
    schemaVersion: "plan.v1",
    task: input.task,
  });
}

function buildPlanPhaseFiles(input: {
  plan: Plan;
  runManifest: RunManifest;
  task: string;
  verificationContract: VerificationContract;
}): PlanPhaseFile[] {
  const contextPack = {
    ...CONTEXT_PACK,
    verificationDefault: input.verificationContract,
  };

  return [
    {
      content: jsonString(input.plan),
      path: "run/plan.json",
    },
    {
      content: buildMachineReceipt(),
      path: "workflows/machine.ts",
    },
    {
      content: buildHarnessFixture(),
      path: "workflows/harness.js",
    },
    {
      content: jsonString(input.verificationContract),
      path: "run/verification-contract.json",
    },
    {
      content: jsonString(input.runManifest),
      path: "run/manifest.json",
    },
    {
      content: jsonString(SOURCE_SEED),
      path: "run/source-seed.json",
    },
    {
      content: buildReportPrompt(input.task, input.runManifest),
      path: "run/prompt.md",
    },
    {
      content: jsonString(contextPack),
      path: "context-packs/research-claude-workflows/pack.json",
    },
    {
      content:
        "# Plan Phase Receipt\n\nPinned before sandbox creation by the Worker control plane.\n",
      path: "README.md",
    },
  ];
}

async function commitPlanPhaseArtifacts(input: {
  files: PlanPhaseFile[];
  remote: string;
  tokenSecret: string;
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
      email: "pi-sandbox-workflow-spike@example.invalid",
      name: "pi-sandbox-workflow-spike",
    },
    dir,
    fs,
    message: "prototype: pin dynamic workflow plan",
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

function buildSetupCommand(): string {
  return [
    "set -eu",
    "rm -rf /workspace/piwf-run",
    'git clone "$ARTIFACTS_GIT_REMOTE" /workspace/piwf-run',
    "cd /workspace/piwf-run",
    'git config user.name "pi-sandbox-workflow-spike"',
    'git config user.email "pi-sandbox-workflow-spike@example.invalid"',
    "git checkout -B main",
    "mkdir -p artifacts/context-pack artifacts/reader artifacts/verification artifacts/wzrrd context-packs/research-claude-workflows run workflows",
  ].join("\n");
}

function buildReaderCommand(): string {
  return [
    "set -eu",
    "cd /workspace/piwf-run",
    'pi --provider openai-codex --model "$PI_MODEL" --thinking off --no-session -p @run/prompt.md > artifacts/report.md',
    "cp run/source-seed.json artifacts/sources.json",
    "cp context-packs/research-claude-workflows/pack.json artifacts/context-pack/pack.json",
    "node <<'NODE'",
    "const fs = require('fs');",
    "const manifest = JSON.parse(fs.readFileSync('run/manifest.json', 'utf8'));",
    "const report = fs.readFileSync('artifacts/report.md', 'utf8');",
    "const receipt = { role: 'reader', runId: manifest.runId, generatedAt: new Date().toISOString(), outputs: ['artifacts/report.md', 'artifacts/sources.json', 'artifacts/context-pack/pack.json'], reportBytes: Buffer.byteLength(report) };",
    "fs.writeFileSync('artifacts/reader/receipt.json', JSON.stringify(receipt, null, 2) + '\\n');",
    "NODE",
  ].join("\n");
}

function buildVerifierCommand(): string {
  return String.raw`set -eu
cd /workspace/piwf-run
node <<'NODE'
const fs = require('fs');
const reportPath = 'artifacts/report.md';
const sourcesPath = 'artifacts/sources.json';
const contractPath = 'run/verification-contract.json';
const manifest = JSON.parse(fs.readFileSync('run/manifest.json', 'utf8'));
const plan = JSON.parse(fs.readFileSync('run/plan.json', 'utf8'));
const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
const report = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, 'utf8') : '';
const sources = fs.existsSync(sourcesPath) ? JSON.parse(fs.readFileSync(sourcesPath, 'utf8')) : [];
const sourceIds = new Set(Array.isArray(sources) ? sources.map((source) => source.id).filter(Boolean) : []);
const warnings = [];
const blockingFailures = [];
const checks = [];

for (const criterion of contract.criteria) {
  if (criterion.type === 'artifact-presence') {
    const missing = criterion.artifacts.filter((path) => !fs.existsSync(path));
    const ok = missing.length === 0;
    if (!ok && criterion.severity === 'blocking') blockingFailures.push('Missing artifacts: ' + missing.join(', '));
    if (!ok && criterion.severity === 'warning') warnings.push('Missing artifacts: ' + missing.join(', '));
    checks.push({ criterionId: criterion.id, evidence: criterion.artifacts, severity: criterion.severity, status: ok ? 'verified' : criterion.severity === 'blocking' ? 'blocked' : 'warnings', summary: ok ? 'All required artifacts are present.' : 'Missing artifacts: ' + missing.join(', ') });
    continue;
  }

  if (criterion.type === 'source-citation-coverage') {
    const section = report.split('## What the sources say')[1]?.split('\n## ')[0] ?? '';
    const bullets = section.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('- '));
    const unsupported = [];
    const unknownSources = [];
    for (const bullet of bullets) {
      const matches = [...bullet.matchAll(/\[source:([^\]]+)\]/g)].map((match) => match[1]);
      if (matches.length === 0) unsupported.push(bullet);
      for (const id of matches) if (!sourceIds.has(id)) unknownSources.push(id);
    }
    if (unsupported.length > 0) blockingFailures.push('Unsupported source bullets: ' + unsupported.length);
    if (unknownSources.length > 0) blockingFailures.push('Unknown source ids: ' + [...new Set(unknownSources)].join(', '));
    checks.push({ criterionId: criterion.id, evidence: bullets, severity: criterion.severity, status: unsupported.length === 0 && unknownSources.length === 0 ? 'verified' : 'blocked', summary: unsupported.length === 0 && unknownSources.length === 0 ? 'Every source-backed bullet cites a known source id.' : 'Citation coverage failed.' });
  }
}

const status = blockingFailures.length > 0 ? 'blocked' : warnings.length > 0 ? 'warnings' : 'verified';
const result = {
  blockingFailures,
  checkedArtifacts: [reportPath, sourcesPath, contractPath],
  checks,
  contractRef: contractPath,
  generatedAt: new Date().toISOString(),
  schemaVersion: 'verification-result.v1',
  status,
  verifier: { kind: 'fixed-prototype-verifier', notes: 'Checks artifact presence and source citation coverage for the research workload.' },
  warnings,
};
fs.mkdirSync('artifacts/verification', { recursive: true });
fs.writeFileSync('artifacts/verification/result.json', JSON.stringify(result, null, 2) + '\n');
fs.writeFileSync('artifacts/verification/report.md', '# Verification Report\n\nStatus: ' + status + '\n\n## Checks\n\n' + checks.map((check) => '- ' + check.status + ': ' + check.criterionId + ' — ' + check.summary).join('\n') + '\n\n' + (blockingFailures.length ? '## Blocking failures\n\n' + blockingFailures.map((item) => '- ' + item).join('\n') + '\n' : ''));

const escapeHtml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const html = [
  '<!doctype html>',
  '<html lang="en">',
  '<meta charset="utf-8">',
  '<title>Wzrrd Review: ' + escapeHtml(manifest.runId) + '</title>',
  '<body style="font:16px/1.5 system-ui,sans-serif;margin:40px;max-width:1080px;background:#09090b;color:#f4f4f5">',
  '<p style="color:#a1a1aa">Dynamic workflow machine prototype. Capsule: <code>' + escapeHtml(manifest.capsuleId) + '</code></p>',
  '<h1>Wzrrd Review: ' + escapeHtml(manifest.runId) + '</h1>',
  '<h2>Capture status</h2><pre style="white-space:pre-wrap;background:#111827;padding:16px;border-radius:12px">' + escapeHtml(JSON.stringify({ verification: result.status, pattern: plan.pattern, machineRuntime: plan.planPhase.generatedMachineRuntime }, null, 2)) + '</pre>',
  '<h2>Report</h2><pre style="white-space:pre-wrap;background:#111827;padding:16px;border-radius:12px">' + escapeHtml(report) + '</pre>',
  '<h2>Verification</h2><pre style="white-space:pre-wrap;background:#111827;padding:16px;border-radius:12px">' + escapeHtml(JSON.stringify(result, null, 2)) + '</pre>',
  '<h2>Receipts</h2><ul><li><code>run/plan.json</code></li><li><code>workflows/machine.ts</code></li><li><code>workflows/harness.js</code></li><li><code>run/verification-contract.json</code></li><li><code>artifacts/verification/result.json</code></li></ul>',
  '</body></html>',
].join('\n');
fs.mkdirSync('artifacts/wzrrd', { recursive: true });
fs.writeFileSync('artifacts/wzrrd/review.html', html + '\n');
NODE`;
}

function buildCommitCommand(
  lane: "reader" | "verifier",
  label: string
): string {
  return [
    "set -eu",
    "cd /workspace/piwf-run",
    "git add .",
    `git commit -m "prototype: ${label} $RUN_ID"`,
    "commit=$(git rev-parse HEAD)",
    `git notes add -m "lane: ${lane}\ncapsule: $CAPSULE_ID\ncontextPack: $CONTEXT_PACK_REF\nsandbox: $SANDBOX_ID\nmodel: openai-codex/$PI_MODEL" "$commit" || git notes append -m "run: $RUN_ID" "$commit"`,
    "git push origin HEAD:main",
    "git push origin refs/notes/* || true",
    "printf '%s\\n' \"$commit\"",
  ].join("\n");
}

function buildReportPrompt(
  task: string,
  manifest: Record<string, unknown>
): string {
  return `You are Pi running inside a real Cloudflare Sandbox for a bounded workflow prototype.

Task:
${task}

Run manifest:
${JSON.stringify(manifest, null, 2)}

Source seed:
${JSON.stringify(SOURCE_SEED, null, 2)}

Write a concise Markdown report to stdout only. Do not claim you browsed the web. Use only the source seed above for factual claims.

Required sections:

# Claude Dynamic Workflows Research Spike

## What the sources say
- 4-7 bullets. Every factual bullet must include a citation in this exact form: [source:<source id>].

## Implications for Pi sandbox workflows
- Separate interpretation from source facts. Keep it practical.

## Context pack recommendation
- List what the reusable pack should contain.

## Verification notes
- State whether every factual claim above has a source id.
`;
}

function buildMachineReceipt(): string {
  return `// THROWAWAY DYNAMIC XSTATE V5 MACHINE RECEIPT
// Source receipt only. The Worker prototype executes a fixed constrained path.

import { setup } from "xstate";

export const machine = setup({
  types: {} as {
    context: {
      runId: string;
      captureStatus?: "verified" | "captured_with_warnings";
    };
    events:
      | { type: "PLAN_COMMITTED" }
      | { type: "READER_DONE" }
      | { type: "VERIFIER_DONE"; status: "verified" | "warnings" | "blocked" }
      | { type: "PUBLISHED" }
      | { type: "DESTROYED" };
  },
}).createMachine({
  id: "dynamicReaderVerifierPrototype",
  initial: "planPinned",
  states: {
    planPinned: { on: { PLAN_COMMITTED: "runningReader" } },
    runningReader: { on: { READER_DONE: "runningVerifier" } },
    runningVerifier: { on: { VERIFIER_DONE: "evaluatingVerification" } },
    evaluatingVerification: {
      always: [
        { guard: ({ event }) => event.type === "VERIFIER_DONE" && event.status === "blocked", target: "blocked" },
        { target: "publishingWzrrd" },
      ],
    },
    publishingWzrrd: { on: { PUBLISHED: "destroyingSandbox" } },
    destroyingSandbox: { on: { DESTROYED: "captured" } },
    blocked: { type: "final" },
    captured: { type: "final" },
  },
});
`;
}

function buildHarnessFixture(): string {
  return `// THROWAWAY REAL-PROTOTYPE HARNESS FIXTURE
// Pinned into Artifacts before any worker sandbox is created.

export const meta = {
  name: "research-claude-workflows-reader-verifier",
  description: "Plan, run reader, verify against job contract, commit Artifacts, publish Wzrrd receipts.",
  phases: ["plan", "reader", "commit-reader", "verifier", "commit-verifier", "publish-wzrrd", "destroy-sandbox"],
};

export default async function workflow({ supervisor }) {
  await supervisor.pinPlanArtifacts(["run/plan.json", "workflows/machine.ts", "workflows/harness.js", "run/verification-contract.json", "run/manifest.json"]);
  await supervisor.resolveCapsule("${DEFAULT_CAPSULE_ID}");
  await supervisor.requireContextPack("${CONTEXT_PACK.id}@${CONTEXT_PACK.version}");
  await supervisor.materializeTaskScopedAuthJson("secretRef:piCodexAuth");
  await supervisor.runReaderLane("openai-codex/${DEFAULT_MODEL}");
  await supervisor.commitLaneArtifacts("reader", ["artifacts/report.md", "artifacts/sources.json", "artifacts/context-pack/pack.json", "artifacts/reader/receipt.json"]);
  await supervisor.runVerifierLane("run/verification-contract.json");
  await supervisor.commitLaneArtifacts("verifier", ["artifacts/verification/result.json", "artifacts/verification/report.md", "artifacts/wzrrd/review.html"]);
  await supervisor.publishWzrrdReview();
  await supervisor.destroySandbox();
}
`;
}

function jsonString(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function publishWzrrdReview(input: {
  artifactRepoName: string;
  commitSha: string | undefined;
  contextPack: string;
  harness: string;
  machine: string;
  manifest: string;
  plan: string;
  report: string;
  runId: string;
  sources: string;
  token: string | undefined;
  verificationContract: string;
  verificationReport: string;
  verificationResult: string;
  wzrrdHtml: string;
}): Promise<WzrrdPublishResult> {
  const sourceRef = `artifacts:${input.artifactRepoName}@${input.commitSha || "main"}`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  if (input.token) {
    headers["authorization"] = `Bearer ${input.token}`;
  }

  const response = await fetch("https://wzrrd.sh/api/sites", {
    body: JSON.stringify({
      files: [
        {
          content: input.wzrrdHtml,
          contentType: "text/html; charset=utf-8",
          path: "index.html",
        },
        {
          content: input.report,
          contentType: "text/markdown; charset=utf-8",
          path: "report.md",
        },
        {
          content: input.sources,
          contentType: "application/json; charset=utf-8",
          path: "sources.json",
        },
        {
          content: input.contextPack,
          contentType: "application/json; charset=utf-8",
          path: "context-pack/pack.json",
        },
        {
          content: input.manifest,
          contentType: "application/json; charset=utf-8",
          path: "run/manifest.json",
        },
        {
          content: input.plan,
          contentType: "application/json; charset=utf-8",
          path: "run/plan.json",
        },
        {
          content: input.verificationContract,
          contentType: "application/json; charset=utf-8",
          path: "run/verification-contract.json",
        },
        {
          content: input.harness,
          contentType: "text/javascript; charset=utf-8",
          path: "workflows/harness.js",
        },
        {
          content: input.machine,
          contentType: "text/typescript; charset=utf-8",
          path: "workflows/machine.ts",
        },
        {
          content: input.verificationResult,
          contentType: "application/json; charset=utf-8",
          path: "artifacts/verification/result.json",
        },
        {
          content: input.verificationReport,
          contentType: "text/markdown; charset=utf-8",
          path: "artifacts/verification/report.md",
        },
      ],
      indexing: "noindex",
      slug: input.artifactRepoName,
      source: sourceRef,
    }),
    headers,
    method: "POST",
  });
  const body = (await response.json().catch(() => null)) as
    | { ok: true; site: WzrrdApiSite }
    | { ok: false; error: string }
    | null;

  if (!response.ok || !body?.ok) {
    const error = body && "error" in body ? body.error : "unknown_error";
    throw new Error(`Wzrrd publish failed: ${response.status} ${error}`);
  }

  return sanitizeWzrrdSite(body.site);
}

function sanitizeWzrrdSite(site: WzrrdApiSite): WzrrdPublishResult {
  const published: WzrrdPublishResult = {
    bytes: site.bytes,
    slug: site.slug,
    updatedAt: site.updatedAt,
    url: site.url,
  };

  if (site.claimUrl) {
    published.claimUrl = site.claimUrl;
  }
  if (site.createdAt) {
    published.createdAt = site.createdAt;
  }
  if (site.deleteAfter) {
    published.deleteAfter = site.deleteAfter;
  }
  if (site.expiresAt) {
    published.expiresAt = site.expiresAt;
  }
  if (site.fileCount !== undefined) {
    published.fileCount = site.fileCount;
  }
  if (site.indexing) {
    published.indexing = site.indexing;
  }
  if (site.lifecycle) {
    published.lifecycle = site.lifecycle;
  }
  if (site.source) {
    published.source = site.source;
  }
  if (site.status) {
    published.status = site.status;
  }

  return WzrrdPublishResultSchema.parse(published);
}

function evaluateVerification(
  result: VerificationResult
): "blocked" | "captured_with_warnings" | "verified" {
  if (result.status === "blocked") {
    return "blocked";
  }

  return result.status === "warnings" ? "captured_with_warnings" : "verified";
}

async function seedPiAuth(
  sandbox: RealSandbox,
  authJsonBase64: string
): Promise<void> {
  const result = await sandbox.exec(
    String.raw`set -eu
agent_dir="$PI_CODING_AGENT_DIR"
if [ -z "$agent_dir" ]; then
  agent_dir="/workspace/.pi/agent"
fi
auth_path="$agent_dir/auth.json"

if [ -s "$auth_path" ] && node -e 'const fs = require("fs"); const auth = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.exit(auth["openai-codex"] ? 0 : 1);' "$auth_path" 2>/dev/null; then
  echo "openai-codex auth already present"
else
  mkdir -p "$agent_dir"
  umask 077
  seed_b64="$(mktemp)"
  seed_json="$(mktemp)"
  printf '%s' "$PI_AUTH_JSON_B64" > "$seed_b64"
  base64 -d "$seed_b64" > "$seed_json"

  node - "$auth_path" "$seed_json" <<'NODE'
const fs = require("fs");
const [authPath, seedPath] = process.argv.slice(2);
const seed = JSON.parse(fs.readFileSync(seedPath, "utf8"));
if (!seed["openai-codex"]) throw new Error("PI_AUTH_JSON_B64 is missing openai-codex");
let current = {};
try {
  current = JSON.parse(fs.readFileSync(authPath, "utf8"));
} catch {}
current["openai-codex"] = seed["openai-codex"];
fs.writeFileSync(authPath, JSON.stringify(current, null, 2) + "\n", { mode: 0o600 });
NODE

  chmod 600 "$auth_path"
  rm -f "$seed_b64" "$seed_json"
  echo "openai-codex auth materialized"
fi`,
    {
      cwd: "/workspace",
      env: { PI_AUTH_JSON_B64: authJsonBase64 },
      timeout: 30_000,
    }
  );

  if (!result.success) {
    throw new Error(
      `Failed to seed Pi auth: ${result.stderr || result.stdout || result.exitCode}`
    );
  }
}

async function runCommand(
  sandbox: RealSandbox,
  command: string,
  redaction: { tokenSecret: string },
  options: { env?: Record<string, string>; timeout: number }
): Promise<CommandResult> {
  const execOptions = options.env
    ? { cwd: "/workspace", env: options.env, timeout: options.timeout }
    : { cwd: "/workspace", timeout: options.timeout };
  const result = await sandbox.exec(command, execOptions);

  return {
    command: result.command,
    duration: result.duration,
    exitCode: result.exitCode,
    stderr: redact(result.stderr, [redaction.tokenSecret]),
    stdout: redact(result.stdout, [redaction.tokenSecret]),
    success: result.success,
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

async function readSandboxText(
  sandbox: RealSandbox,
  path: string
): Promise<string> {
  const file = await sandbox.readFile(path);
  return file.content;
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

function getTokenExpiresAt(token: string): string | undefined {
  const match = token.match(/[?&]expires=(\d+)$/u);
  if (!match?.[1]) {
    return undefined;
  }

  return new Date(Number(match[1]) * 1000).toISOString();
}

function getLastNonEmptyLine(value: string): string | undefined {
  const lines = value.split("\n").map((line) => line.trim());

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line) {
      return line;
    }
  }

  return undefined;
}

function redact(value: string, secrets: string[]): string {
  let redacted = value;

  for (const secret of secrets) {
    if (secret) {
      redacted = redacted.replaceAll(secret, "[redacted]");
    }
  }

  return redacted.replaceAll(
    /art_v1_[A-Za-z0-9]+/gu,
    "[redacted-artifacts-token]"
  );
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength
    ? `${value.slice(0, maxLength)}\n...[truncated]`
    : value;
}

function isAuthorized(request: Request, env: Env): boolean {
  const url = new URL(request.url);

  if (!env.ACCESS_TOKEN) {
    return ["localhost", "127.0.0.1", "0.0.0.0"].includes(url.hostname);
  }

  const queryToken = url.searchParams.get("token");
  const headerToken = request.headers.get("X-Access-Token");
  const authorization = request.headers.get("Authorization");
  const bearerToken = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined;

  return [queryToken, headerToken, bearerToken].some(
    (token) => token === env.ACCESS_TOKEN
  );
}

function json(data: unknown, init: ResponseInit = {}): Response {
  return Response.json(data, {
    ...init,
    headers: {
      "Cache-Control": "no-store",
      ...init.headers,
    },
  });
}

function html(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    ...init,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8",
      ...init.headers,
    },
  });
}

function renderIndex(authRequired: boolean, piAuthConfigured: boolean): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Pi Sandbox Workflow Spike</title></head>
<body style="font:16px/1.5 system-ui,sans-serif;max-width:900px;margin:40px">
  <h1>Pi Sandbox Workflow Spike</h1>
  <p>This is the <strong>real</strong> prototype lane: Cloudflare Sandbox + Artifacts + task-scoped Pi auth materialization + bounded Pi print-mode run.</p>
  <ul>
    <li>Auth gate configured: <code>${authRequired}</code></li>
    <li>Pi auth secret configured: <code>${piAuthConfigured}</code></li>
  </ul>
  <pre>curl -X POST /api/real-run -H 'content-type: application/json' -d '{"task":"Produce the research spike report"}'</pre>
</body>
</html>`;
}
