#!/usr/bin/env node
/* eslint-disable curly, func-style, no-plusplus, no-promise-executor-return, prefer-destructuring, promise/avoid-new, promise/param-names, sort-keys, unicorn/no-useless-undefined, unicorn/prefer-string-replace-all */
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../..");
const outDir = resolve(
  repoRoot,
  "prototypes/cloud-capability-lease-broker-spike/out"
);
const workerUrl =
  process.env.CAPABILITY_BROKER_WORKER_URL ??
  "https://pi-cloud-capability-lease-broker-spike.joelhooks.workers.dev";
const accessToken = process.env.ACCESS_TOKEN ?? (await readDotEnvAccessToken());

if (!accessToken) {
  console.error(
    "Missing ACCESS_TOKEN. Set it in the environment or .env.local before running prototype:capability:real."
  );
  process.exit(1);
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const proposedFiles = await collectProposedFiles();
  const started = await postJson(`${workerUrl}/api/capability-runs`, {
    files: proposedFiles,
    prTitle: "prototype: prove cloud capability lease broker",
  });
  await writeJson(resolve(outDir, "latest-start.json"), started);
  const workItemId = required(started.workItemId, "workItemId");
  console.log(
    `started ${started.runId} (${workItemId}) with ${proposedFiles.length} proposed files`
  );

  let status = started;
  for (let attempt = 1; attempt <= 120; attempt++) {
    await sleep(3000);
    status = await getJson(
      `${workerUrl}/api/capability-runs/${encodeURIComponent(workItemId)}`
    );
    const record = status.record ?? {};
    console.log(
      `${attempt.toString().padStart(3, "0")} status=${record.status ?? "unknown"} events=${record.events?.length ?? 0}`
    );
    await writeJson(resolve(outDir, "latest-status.json"), status);
    if (record.status === "captured" || record.status === "blocked") break;
  }

  const record = status.record;
  if (!record) throw new Error("missing final record");
  if (record.status !== "captured") {
    throw new Error(`run did not capture: ${record.status ?? "unknown"}`);
  }
  if (!record.receipt) throw new Error("missing capability receipt");

  const pr = await fetchPullRequest(record.receipt.prUrl);
  const files = await fetchPullRequestFiles(record.receipt.prUrl);
  const publicObserver = await getPublicJson(
    `${workerUrl}/observer/${encodeURIComponent(workItemId)}`
  );
  const leakScan = scanForLeaks({ files, pr, publicObserver, record });
  const verification = {
    actorMatches: pr.user?.login === "shitratgit[bot]",
    branchMatches: pr.head?.ref === record.receipt.branch,
    commitMatches: pr.head?.sha === record.receipt.commitSha,
    deniedProbeCodes: Object.fromEntries(
      Object.entries(record.deniedProbeResults ?? {}).map(([key, value]) => [
        key,
        value?.blocker?.code ?? value?.status,
      ])
    ),
    leakScan,
    prUrl: record.receipt.prUrl,
  };

  if (!verification.actorMatches) throw new Error("PR actor mismatch");
  if (!verification.branchMatches) throw new Error("PR branch mismatch");
  if (!verification.commitMatches) throw new Error("PR commit mismatch");
  if (!leakScan.passed) throw new Error("leak scan failed");

  const finalReceipt = { record, verification, workerUrl, workItemId };
  await writeJson(resolve(outDir, "latest-receipt.json"), finalReceipt);
  console.log(JSON.stringify(finalReceipt, null, 2));
}

async function postJson(url, body) {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
  if (!response.ok) throw new Error(`${url} failed: ${response.status}`);
  return response.json();
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`${url} failed: ${response.status}`);
  return response.json();
}

async function getPublicJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} failed: ${response.status}`);
  return response.json();
}

async function fetchPullRequest(prUrl) {
  const { owner, repo, number } = parsePrUrl(prUrl);
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`,
    { headers: { "user-agent": "capability-broker-runner" } }
  );
  if (!response.ok)
    throw new Error(`GitHub PR readback failed: ${response.status}`);
  return response.json();
}

async function fetchPullRequestFiles(prUrl) {
  const { owner, repo, number } = parsePrUrl(prUrl);
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${number}/files`,
    { headers: { "user-agent": "capability-broker-runner" } }
  );
  if (!response.ok)
    throw new Error(`GitHub PR files readback failed: ${response.status}`);
  return response.json();
}

function parsePrUrl(prUrl) {
  const url = new URL(prUrl);
  const [, owner, repo, , number] = url.pathname.split("/");
  if (!owner || !repo || !number) throw new Error(`invalid PR URL: ${prUrl}`);
  return { number, owner, repo };
}

function scanForLeaks(value) {
  const text = JSON.stringify(value, null, 2);
  const checks = [
    {
      id: "pem-block",
      match:
        /-----BEGIN [A-Z ]+-----\s+[A-Za-z0-9+/=\s]{80,}-----END [A-Z ]+-----/u.test(
          text
        ),
    },
    {
      id: "github-token",
      match: /\b(?:ghs|ghu|ghp|github_pat)_[A-Za-z0-9_]+/u.test(text),
    },
    { id: "bearer-token", match: /Bearer\s+[A-Za-z0-9._-]{20,}/u.test(text) },
    {
      id: "token-bearing-url",
      match: /https:\/\/(?:x|oauth2|token):[^@\s]+@/u.test(text),
    },
    { id: "artifact-token", match: /\bart_v1_[A-Za-z0-9._-]+/u.test(text) },
    {
      id: "jwt",
      match: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/u.test(text),
    },
  ].map((check) => ({ ...check, status: check.match ? "failed" : "passed" }));
  return { checks, passed: checks.every((check) => !check.match) };
}

async function collectProposedFiles() {
  const prototypeRoot = resolve(
    repoRoot,
    "prototypes/cloud-capability-lease-broker-spike"
  );
  const files = [];
  for (const path of await listTextFiles(prototypeRoot)) {
    const repoPath = path.slice(repoRoot.length + 1).replaceAll("\\", "/");
    if (repoPath.includes("/out/") || repoPath.includes("/generated/")) {
      continue;
    }
    files.push({ content: await readFile(path, "utf-8"), path: repoPath });
  }
  files.push({ content: buildPackageJsonForPr(), path: "package.json" });
  return files.toSorted((a, b) => a.path.localeCompare(b.path));
}

async function listTextFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "out" || entry.name === "generated") {
        continue;
      }
      files.push(...(await listTextFiles(path)));
      continue;
    }
    if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function buildPackageJsonForPr() {
  const base = JSON.parse(
    execFileSync("git", ["show", "origin/main:package.json"], {
      cwd: repoRoot,
      encoding: "utf-8",
    })
  );
  const current = JSON.parse(
    execFileSync(
      "node",
      [
        "-e",
        "process.stdout.write(require('fs').readFileSync('package.json','utf8'))",
      ],
      { cwd: repoRoot, encoding: "utf-8" }
    )
  );
  for (const [key, value] of Object.entries(current.scripts)) {
    if (key.startsWith("prototype:capability")) {
      base.scripts[key] = value;
    }
  }
  return `${JSON.stringify(base, null, 2)}\n`;
}

async function readDotEnvAccessToken() {
  try {
    const envPath = resolve(repoRoot, ".env.local");
    const text = await readFile(envPath, "utf-8");
    const line = text
      .split(/\r?\n/u)
      .find((entry) => entry.startsWith("ACCESS_TOKEN="));
    if (!line) return undefined;
    return line.slice("ACCESS_TOKEN=".length).replace(/^['"]|['"]$/gu, "");
  } catch {
    return undefined;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function required(value, name) {
  if (!value) throw new Error(`${name} missing`);
  return value;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

await main();
