#!/usr/bin/env node
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  add,
  branch as gitBranch,
  clone,
  commit as gitCommit,
  currentBranch,
  init as gitInit,
  push,
} from "isomorphic-git";
import http from "isomorphic-git/http/node";

const repoRoot = resolve(import.meta.dirname, "..");
const configPath = "wrangler.jsonc";
const defaultReceiptPath =
  ".wrangler/workflow-app/latest-deploy-seed-receipt.json";
const packageSeedAdminAuthRetryDelaysMs = [2000, 5000, 10_000];
const deploySecretNames = [
  "PI_AUTH_JSON_B64",
  "WORKFLOW_APP_MODEL",
  "DREAM_MEMORY_RELAY_TOKEN",
  "DISCORD_BOT_TOKEN",
  "WZRRD_API_TOKEN",
  "GITHUB_TOKEN",
  "LINEAR_API_TOKEN",
  "WORKFLOW_APP_ADMIN_TOKEN",
];

const cliArgs = new Set(process.argv.slice(2));
const hasArg = (name) => cliArgs.has(name);
const getArgValue = (name) => {
  const prefix = `${name}=`;
  const value = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return value?.slice(prefix.length);
};

const readDotEnvLocal = async () => {
  const parsed = {};
  const path = resolve(repoRoot, ".env.local");
  const content = await readFile(path, "utf-8").catch(() => "");
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index);
    let value = trimmed.slice(index + 1);
    value = value.replaceAll(/^['"]|['"]$/gu, "");
    parsed[key] = value;
  }
  return parsed;
};

const envFile = await readDotEnvLocal();
const env = {
  ...envFile,
  ...process.env,
};
const startedAt = new Date().toISOString();
const receiptPath = resolve(
  repoRoot,
  getArgValue("--receipt-path") ?? defaultReceiptPath
);

const runCommand = async (command, commandArgs, options = {}) => {
  const started = Date.now();
  const child = spawn(command, commandArgs, {
    cwd: repoRoot,
    env: {
      ...process.env,
      CI: "1",
      NO_COLOR: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  if (options.stdin === undefined) {
    child.stdin.end();
  } else {
    child.stdin.end(options.stdin);
  }
  const [exitCode] = await once(child, "close");
  const result = {
    args: commandArgs,
    command,
    durationMs: Date.now() - started,
    exitCode,
    stderr: redact(stderr),
    stdout: redact(stdout),
  };
  if (exitCode !== 0) {
    const error = new Error(`${command} ${commandArgs.join(" ")} failed`);
    error.result = result;
    throw error;
  }
  return result;
};

const redact = (value) => {
  let redacted = value;
  for (const secret of deploySecretNames) {
    const material = env[secret];
    if (material) {
      redacted = redacted.replaceAll(material, `[redacted:${secret}]`);
    }
  }
  return redacted;
};

const putSecret = async (name) => {
  const value = env[name];
  if (!value) {
    return {
      name,
      status: "missing-local-value",
    };
  }
  const result = await runCommand(
    "pnpm",
    ["exec", "wrangler", "secret", "put", name, "--config", configPath],
    { stdin: value }
  );
  return {
    durationMs: result.durationMs,
    name,
    status: "put",
  };
};

const deploySecretsFileSummary = () =>
  deploySecretNames.map((name) => ({
    name,
    status: env[name]
      ? "included-in-deploy-secrets-file"
      : "missing-local-value",
  }));

const writeDeploySecretsFile = async () => {
  const secrets = Object.fromEntries(
    deploySecretNames
      .map((name) => [name, env[name]])
      .filter(([, value]) => Boolean(value))
  );
  if (Object.keys(secrets).length === 0) {
    return null;
  }

  const path = resolve(repoRoot, ".wrangler/workflow-app/deploy-secrets.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(secrets)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
  return path;
};

const parseWorkerUrl = (deployOutput) => {
  const explicit = getArgValue("--worker-url") ?? env.WORKFLOW_APP_URL;
  if (explicit) {
    return explicit;
  }
  const match = /https:\/\/[^\s]+\.workers\.dev/u.exec(deployOutput);
  if (match?.[0]) {
    return match[0];
  }
  return "https://pi-cloudflare-sandbox-workflows.joelhooks.workers.dev";
};

const postAdminJson = async (workerUrl, path, body) => {
  const adminToken = env.WORKFLOW_APP_ADMIN_TOKEN;
  if (!adminToken) {
    return {
      reason: "WORKFLOW_APP_ADMIN_TOKEN missing from environment or .env.local",
      status: "skipped",
    };
  }

  for (
    let attempt = 0;
    attempt <= packageSeedAdminAuthRetryDelaysMs.length;
    attempt += 1
  ) {
    const response = await fetch(`${workerUrl}${path}`, {
      body: JSON.stringify(body),
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    const text = await response.text();
    const parsedBody = parseJson(text);
    if (response.ok) {
      return parsedBody;
    }

    if (
      response.status === 401 &&
      parsedBody?.error?.code === "missing_auth" &&
      attempt < packageSeedAdminAuthRetryDelaysMs.length
    ) {
      await sleep(packageSeedAdminAuthRetryDelaysMs[attempt]);
      continue;
    }

    throw new Error(
      `${path} failed: ${response.status} ${redact(JSON.stringify(parsedBody ?? text))}`
    );
  }

  throw new Error(`${path} failed after admin auth propagation retries`);
};

const packageSeedRequestBody = () => ({
  subjects: [
    {
      subjectId: env.WORKFLOW_APP_SEED_SUBJECT_ID ?? "actor:operator",
      subjectType: env.WORKFLOW_APP_SEED_SUBJECT_TYPE ?? "actor",
    },
  ],
});

const isMissingDefaultBranchError = (error) =>
  /Could not find .+\.$/u.test(
    error instanceof Error ? error.message : String(error)
  );

const initializePackageRepo = async (input) => {
  await gitInit({
    defaultBranch: input.defaultBranch,
    dir: input.dir,
    fs,
  });
};

const clonePackageRepo = async (input) => {
  try {
    await clone({
      dir: input.dir,
      fs,
      http,
      onAuth: () => ({
        password: input.writeToken,
        username: "x",
      }),
      ref: input.defaultBranch,
      singleBranch: true,
      url: input.remote,
    });
  } catch (error) {
    if (!isMissingDefaultBranchError(error)) {
      throw error;
    }

    await initializePackageRepo(input);
  }
};

const ensurePackageDefaultBranch = async (input) => {
  const current = await currentBranch({
    dir: input.dir,
    fs,
    fullname: false,
  }).catch(() => null);
  if (current === input.defaultBranch) {
    return;
  }

  await gitBranch({
    checkout: true,
    dir: input.dir,
    fs,
    ref: input.defaultBranch,
  });
};

const pushPackageManifest = async (preparedPackage) => {
  const dir = await mkdtemp(resolve(tmpdir(), "piwf-package-seed-"));
  try {
    await (preparedPackage.status === "created"
      ? initializePackageRepo({
          defaultBranch: preparedPackage.defaultBranch,
          dir,
        })
      : clonePackageRepo({
          defaultBranch: preparedPackage.defaultBranch,
          dir,
          remote: preparedPackage.remote,
          writeToken: preparedPackage.writeToken,
        }));
    await ensurePackageDefaultBranch({
      defaultBranch: preparedPackage.defaultBranch,
      dir,
    });
    await writeFile(
      resolve(dir, "package.json"),
      `${JSON.stringify(preparedPackage.manifest, null, 2)}\n`,
      "utf-8"
    );
    await add({ dir, filepath: "package.json", fs });
    const seedCommitSha = await gitCommit({
      author: {
        email: "pi-workflow-package-seeder@example.invalid",
        name: "pi-workflow-package-seeder",
      },
      dir,
      fs,
      message: `package seed: ${preparedPackage.manifest.packageId}@${preparedPackage.manifest.latestVersion}`,
    });
    await push({
      dir,
      fs,
      http,
      onAuth: () => ({
        password: preparedPackage.writeToken,
        username: "x",
      }),
      ref: preparedPackage.defaultBranch,
      url: preparedPackage.remote,
    });

    return {
      defaultBranch: preparedPackage.defaultBranch,
      manifest: preparedPackage.manifest,
      manifestArtifactRef: preparedPackage.manifestArtifactRef,
      manifestHash: preparedPackage.manifestHash,
      remote: preparedPackage.remote,
      repoName: preparedPackage.repoName,
      seedCommitSha,
      status: preparedPackage.status,
    };
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
};

const redactedPreparationSummary = (preparation) => ({
  packageCount: preparation.packages.length,
  packages: preparation.packages.map((preparedPackage) => ({
    defaultBranch: preparedPackage.defaultBranch,
    manifestArtifactRef: preparedPackage.manifestArtifactRef,
    manifestHash: preparedPackage.manifestHash,
    packageId: preparedPackage.manifest.packageId,
    repoName: preparedPackage.repoName,
    status: preparedPackage.status,
  })),
  schemaVersion: preparation.schemaVersion,
  subjectCount: preparation.subjects.length,
});

const seedPackages = async (workerUrl) => {
  const requestBody = packageSeedRequestBody();
  const preparation = await postAdminJson(
    workerUrl,
    "/admin/packages/prepare-seed",
    requestBody
  );
  if (preparation.status === "skipped") {
    return preparation;
  }

  const finalizedPackages = [];
  for (const preparedPackage of preparation.packages) {
    finalizedPackages.push(await pushPackageManifest(preparedPackage));
  }

  const finalReceipt = await postAdminJson(
    workerUrl,
    "/admin/packages/finalize-seed",
    {
      packages: finalizedPackages,
      subjects: preparation.subjects,
    }
  );

  return {
    finalReceipt,
    preparation: redactedPreparationSummary(preparation),
    status: "seeded",
  };
};

const parseJson = (value) => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const steps = [];
const addStep = (name, result) => {
  steps.push({
    name,
    result,
  });
};

let workerUrl = getArgValue("--worker-url") ?? env.WORKFLOW_APP_URL ?? null;
let deployedWithSecretsFile = false;
let status = "completed";
try {
  if (!hasArg("--skip-migrations")) {
    addStep(
      "d1-migrations",
      await runCommand("pnpm", [
        "exec",
        "wrangler",
        "d1",
        "migrations",
        "apply",
        "pi-cloudflare-sandbox-workflows",
        "--remote",
        "--config",
        configPath,
      ])
    );
  }

  if (!hasArg("--skip-deploy")) {
    const deploySecretsPath = await writeDeploySecretsFile();
    deployedWithSecretsFile = deploySecretsPath !== null;
    const deployArgs = [
      "exec",
      "wrangler",
      "deploy",
      "--config",
      configPath,
      "--message",
      "deploy workflow app spine",
    ];
    const containersRollout = getArgValue("--containers-rollout");
    if (containersRollout !== undefined) {
      deployArgs.push("--containers-rollout", containersRollout);
    }
    if (deploySecretsPath !== null) {
      deployArgs.push("--secrets-file", deploySecretsPath);
    }
    let deployResult;
    try {
      deployResult = await runCommand("pnpm", deployArgs);
    } finally {
      if (deploySecretsPath !== null) {
        await rm(deploySecretsPath, { force: true });
      }
    }
    workerUrl = parseWorkerUrl(
      `${deployResult.stdout}\n${deployResult.stderr}`
    );
    addStep("worker-deploy", deployResult);
  }

  if (!hasArg("--skip-secrets")) {
    if (deployedWithSecretsFile) {
      addStep("worker-secrets", deploySecretsFileSummary());
    } else {
      const secretResults = [];
      for (const name of deploySecretNames) {
        secretResults.push(await putSecret(name));
      }
      addStep("worker-secrets", secretResults);
    }
  }

  if (!hasArg("--skip-seed")) {
    if (!workerUrl) {
      throw new Error(
        "package seed requires --worker-url or deploy output URL"
      );
    }
    addStep("package-seed", await seedPackages(workerUrl));
  }
} catch (error) {
  status = "failed";
  addStep("failure", {
    message: error instanceof Error ? error.message : String(error),
    result: error?.result,
  });
}

const receipt = {
  completedAt: new Date().toISOString(),
  d1DatabaseId: "72ab80e4-600d-4dd8-b581-8560eff16967",
  redacted: true,
  schemaVersion: "workflow-app.deploy-seed-receipt.v1",
  startedAt,
  status,
  steps,
  workerUrl,
};

await mkdir(dirname(receiptPath), { recursive: true });
await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
console.log(JSON.stringify(receipt, null, 2));
console.log(`wrote ${receiptPath}`);

if (status !== "completed") {
  process.exitCode = 1;
}
