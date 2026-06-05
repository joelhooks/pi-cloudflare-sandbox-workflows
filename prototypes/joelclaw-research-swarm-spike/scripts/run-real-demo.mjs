#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const repoRoot = resolve(import.meta.dirname, "../../..");
const prototypeDir = resolve(
  repoRoot,
  "prototypes/joelclaw-research-swarm-spike"
);
const planPath = resolve(prototypeDir, "out/latest-prelaunch-plan.json");
const outPath = resolve(prototypeDir, "out/latest-receipt.json");
const statusOutPath = resolve(prototypeDir, "out/latest-status.json");
const brainPagePath = resolve(
  repoRoot,
  ".brain/resources/workflow-verifier-evals-playbook.svx"
);
const workerUrl =
  process.env.JOELCLAW_SWARM_WORKER_URL ??
  "https://pi-joelclaw-research-swarm-spike.joelhooks.workers.dev";

const readAccessToken = async () => {
  const envLocal = await readFile(
    resolve(repoRoot, ".env.local"),
    "utf-8"
  ).catch(() => "");
  const match = envLocal.match(/^ACCESS_TOKEN=(.*)$/mu);
  if (match?.[1]) {
    return match[1].replaceAll(/^['"]|['"]$/gu, "");
  }
  if (process.env.ACCESS_TOKEN) {
    return process.env.ACCESS_TOKEN;
  }
  throw new Error("Missing ACCESS_TOKEN in .env.local or process env");
};

const authHeaders = (accessToken) => ({
  Authorization: `Bearer ${accessToken}`,
});

const readJson = async (response, label) => {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `${label} returned non-JSON: ${response.status} ${response.headers.get("content-type")} ${text.slice(0, 500)}`
    );
  }
};

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
  const timeoutMs = Number(process.env.JOELCLAW_SWARM_TIMEOUT_MS ?? 900_000);
  while (Date.now() - started < timeoutMs) {
    const response = await fetch(
      `${workerUrl}/api/runs/${encodeURIComponent(workItemId)}`,
      { headers: authHeaders(accessToken) }
    );
    const body = await readJson(response, "status");
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
        observer: record?.publicObserverUrl,
        state: record?.currentState,
        status: record?.status,
      })
    );
    await sleep(5000);
  }
  throw new Error(`timed out waiting for ${workItemId}`);
};

const accessToken = await readAccessToken();
const plan = JSON.parse(await readFile(planPath, "utf-8"));
if (plan.approval?.decision !== "approved") {
  throw new Error(
    "latest prelaunch plan is not approved. Run: JOELCLAW_SWARM_APPROVE=1 pnpm prototype:joelclaw-swarm:plan"
  );
}

await assertHealth(accessToken);
const startResponse = await fetch(`${workerUrl}/api/runs`, {
  body: JSON.stringify(plan),
  headers: { ...authHeaders(accessToken), "content-type": "application/json" },
  method: "POST",
});
const startBody = await readJson(startResponse, "start");
if (!startResponse.ok || !startBody.ok) {
  throw new Error(
    `swarm run start failed: ${startResponse.status} ${JSON.stringify(startBody)}`
  );
}
console.log(
  `started ${startBody.runId} for ${plan.researchEnvelope.workItemId}`
);
console.log(`observer ${startBody.publicObserverUrl}`);

const observerResponse = await fetch(startBody.publicObserverUrl);
if (!observerResponse.ok) {
  throw new Error(`observer failed: ${observerResponse.status}`);
}

const finalRecord = await waitForFinalRecord(
  plan.researchEnvelope.workItemId,
  accessToken
);
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
await mkdir(dirname(brainPagePath), { recursive: true });
await writeFile(
  brainPagePath,
  `${finalRecord.finalReceipt.brainPageContent}\n`,
  "utf-8"
);
execFileSync("pnpm", ["typecheck"], { cwd: repoRoot, stdio: "inherit" });
console.log(JSON.stringify(finalRecord.finalReceipt, null, 2));
console.log(`wrote ${outPath}`);
console.log(`wrote ${statusOutPath}`);
console.log(`wrote ${brainPagePath}`);
