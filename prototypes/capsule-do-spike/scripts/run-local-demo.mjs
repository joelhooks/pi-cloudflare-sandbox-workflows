#!/usr/bin/env node
/* eslint-disable func-style, no-promise-executor-return, no-shadow, promise/avoid-new */

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../..");
const outPath = resolve(
  repoRoot,
  "prototypes/capsule-do-spike/out/latest-receipt.json"
);
const port = 8797;
const url = `http://127.0.0.1:${port}`;

const child = spawn(
  "pnpm",
  [
    "exec",
    "wrangler",
    "dev",
    "--config",
    "prototypes/capsule-do-spike/wrangler.jsonc",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
  ],
  {
    cwd: repoRoot,
    env: {
      ...process.env,
      NO_COLOR: "1",
    },
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
  const response = await fetch(`${url}/api/demo`, { method: "POST" });
  const body = await response.json();
  if (!response.ok || !body.ok) {
    throw new Error(`demo failed: ${response.status} ${JSON.stringify(body)}`);
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
}

async function waitForHealth() {
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    if (child.exitCode !== null) {
      throw new Error(`wrangler exited early with ${child.exitCode}\n${logs}`);
    }
    try {
      const response = await fetch(`${url}/healthz`);
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
