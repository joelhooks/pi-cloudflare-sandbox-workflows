#!/usr/bin/env node
/* eslint-disable func-style, no-promise-executor-return, no-shadow, promise/avoid-new */

import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../..");
const prototypeDir = resolve(
  repoRoot,
  "prototypes/integrated-capsule-run-spike"
);
const devVarsPath = resolve(prototypeDir, ".dev.vars");
const outPath = resolve(prototypeDir, "out/latest-receipt.json");
const port = 8798;
const url = `http://127.0.0.1:${port}`;

const accessToken = await readAccessToken();
await writeFile(devVarsPath, `ACCESS_TOKEN=${JSON.stringify(accessToken)}\n`, {
  mode: 0o600,
});

const child = spawn(
  "pnpm",
  [
    "exec",
    "wrangler",
    "dev",
    "--config",
    "prototypes/integrated-capsule-run-spike/wrangler.jsonc",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
  ],
  {
    cwd: repoRoot,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  }
);

let logs = "";
child.stdout.on("data", (chunk) => {
  logs += String(chunk);
});
child.stderr.on("data", (chunk) => {
  logs += String(chunk);
});

try {
  await waitForHealth();
  const response = await fetch(`${url}/api/integrated-run`, {
    body: JSON.stringify({
      contextPackRefs: ["research-claude-workflows@0.1.0"],
      secretRefs: ["piCodexAuth"],
      task: "Produce the integrated capsule run proof: durable capsule, real sandbox run, verification, Wzrrd review.",
      verificationContract: "source-grounded-report-v1",
      workItemId: `thread-or-issue-integrated-${crypto.randomUUID().slice(0, 8)}`,
    }),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
  const body = await response.json();
  if (!response.ok || !body.ok) {
    throw new Error(
      `integrated proof failed: ${response.status} ${JSON.stringify(body)}`
    );
  }
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(
    outPath,
    `${JSON.stringify(body.receipt, null, 2)}\n`,
    "utf-8"
  );
  console.log(JSON.stringify(body.receipt, null, 2));
  console.log(`wrote ${outPath}`);
} finally {
  child.kill("SIGTERM");
  await rm(devVarsPath, { force: true });
}

async function readAccessToken() {
  if (process.env.ACCESS_TOKEN) {
    return process.env.ACCESS_TOKEN;
  }
  const envLocal = await readFile(resolve(repoRoot, ".env.local"), "utf-8");
  const match = envLocal.match(/^ACCESS_TOKEN=(.*)$/mu);
  if (!match?.[1]) {
    throw new Error("Missing ACCESS_TOKEN in .env.local");
  }
  return match[1].replaceAll(/^['"]|['"]$/gu, "");
}

async function waitForHealth() {
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    if (child.exitCode !== null) {
      throw new Error(`wrangler exited early with ${child.exitCode}\n${logs}`);
    }
    try {
      const response = await fetch(`${url}/healthz`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (response.ok) {
        return;
      }
    } catch {
      // keep waiting
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`wrangler did not become ready\n${logs}`);
}
