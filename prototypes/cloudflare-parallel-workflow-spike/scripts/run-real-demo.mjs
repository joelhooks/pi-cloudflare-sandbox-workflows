#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const repoRoot = resolve(import.meta.dirname, "../../..");
const prototypeDir = resolve(
  repoRoot,
  "prototypes/cloudflare-parallel-workflow-spike"
);
const fixturePath = resolve(
  prototypeDir,
  "fixtures/parallel-cloudflare-patterns.json"
);
const outPath = resolve(prototypeDir, "out/latest-receipt.json");
const statusOutPath = resolve(prototypeDir, "out/latest-status.json");
const workerUrl =
  process.env.PARALLEL_WORKER_URL ??
  "https://pi-cloudflare-parallel-workflow-spike.joelhooks.workers.dev";

const readAccessToken = async () => {
  if (process.env.ACCESS_TOKEN) {
    return process.env.ACCESS_TOKEN;
  }
  const envLocal = await readFile(resolve(repoRoot, ".env.local"), "utf-8");
  const match = envLocal.match(/^ACCESS_TOKEN=(.*)$/mu);
  if (!match?.[1]) {
    throw new Error("Missing ACCESS_TOKEN in .env.local");
  }
  return match[1].replaceAll(/^['"]|['"]$/gu, "");
};

const authHeaders = (accessToken) => ({
  Authorization: `Bearer ${accessToken}`,
});

const assertHealth = async (accessToken) => {
  const response = await fetch(`${workerUrl}/healthz`, {
    headers: authHeaders(accessToken),
  });
  if (!response.ok) {
    throw new Error(
      `health failed: ${response.status} ${await response.text()}`
    );
  }
};

const summarizeLaneStates = (lanes) => {
  const counts = {};
  for (const lane of Object.values(lanes ?? {})) {
    counts[lane.status] = (counts[lane.status] ?? 0) + 1;
  }
  return counts;
};

const waitForFinalRecord = async (workItemId, accessToken) => {
  const started = Date.now();
  const timeoutMs = Number(process.env.PARALLEL_RUN_TIMEOUT_MS ?? 900_000);
  while (Date.now() - started < timeoutMs) {
    const response = await fetch(
      `${workerUrl}/api/runs/${encodeURIComponent(workItemId)}`,
      { headers: authHeaders(accessToken) }
    );
    const body = await response.json();
    if (!response.ok || !body.ok) {
      throw new Error(
        `status failed: ${response.status} ${JSON.stringify(body)}`
      );
    }
    const { record } = body;
    if (record?.status === "captured" || record?.status === "blocked") {
      return record;
    }
    console.log(
      JSON.stringify({
        active: record?.activeLaneIds?.length ?? 0,
        laneStates: summarizeLaneStates(record?.lanes),
        maxObservedActiveLanes: record?.maxObservedActiveLanes,
        state: record?.currentState,
        status: record?.status,
      })
    );
    await sleep(5000);
  }
  throw new Error(`timed out waiting for ${workItemId}`);
};

const accessToken = await readAccessToken();
const fixture = JSON.parse(await readFile(fixturePath, "utf-8"));
const suffix = crypto.randomUUID().slice(0, 8);
const jobSpec = {
  ...fixture,
  workItemId: `parallel-cloudflare-patterns-${suffix}`,
};

await assertHealth(accessToken);
const startResponse = await fetch(`${workerUrl}/api/runs`, {
  body: JSON.stringify(jobSpec),
  headers: {
    ...authHeaders(accessToken),
    "content-type": "application/json",
  },
  method: "POST",
});
const startBody = await startResponse.json();
if (!startResponse.ok || !startBody.ok) {
  throw new Error(
    `parallel run start failed: ${startResponse.status} ${JSON.stringify(startBody)}`
  );
}
console.log(`started ${startBody.runId} for ${jobSpec.workItemId}`);

const finalRecord = await waitForFinalRecord(jobSpec.workItemId, accessToken);
if (finalRecord.status !== "captured" || !finalRecord.finalReceipt) {
  throw new Error(`run did not capture: ${JSON.stringify(finalRecord)}`);
}

await mkdir(dirname(outPath), { recursive: true });
await writeFile(
  outPath,
  `${JSON.stringify(finalRecord.finalReceipt, null, 2)}\n`,
  "utf-8"
);
await writeFile(
  statusOutPath,
  `${JSON.stringify(finalRecord, null, 2)}\n`,
  "utf-8"
);
console.log(JSON.stringify(finalRecord.finalReceipt, null, 2));
console.log(`wrote ${outPath}`);
console.log(`wrote ${statusOutPath}`);
