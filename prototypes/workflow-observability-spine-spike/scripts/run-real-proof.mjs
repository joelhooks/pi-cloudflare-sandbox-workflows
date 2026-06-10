#!/usr/bin/env node
import { spawnSync } from "node:child_process";
/* eslint-disable func-style */
import { createSign } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const worker =
  process.env.OBSERVABILITY_WORKER_URL ??
  "https://pi-workflow-observability-spine-spike.joelhooks.workers.dev";
const workItemId = "workflow-observability-spine";
const repo = "joelhooks/pi-cloudflare-sandbox-workflows";
const outDir = resolve("prototypes/workflow-observability-spine-spike/out");
const env = loadEnvLocal();
const accessToken = env.ACCESS_TOKEN ?? process.env.ACCESS_TOKEN;

if (!accessToken) {
  console.error(
    "Missing ACCESS_TOKEN. Put it in .env.local or export ACCESS_TOKEN."
  );
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

const authHeaders = {
  Authorization: `Bearer ${accessToken}`,
  "content-type": "application/json",
};

const run = await readJson(
  await fetch(`${worker}/api/runs`, {
    body: JSON.stringify({
      task: "Generated workflow builds the workflow observability spine prototype feature and opens a GitHub PR via ShitRat capability.",
      workItemId,
    }),
    headers: authHeaders,
    method: "POST",
  }),
  "start run"
);

console.log(`started ${run.runId}`);

let lastProgressAttempt = 0;
let lastProgressKey = "";
let status;
for (let attempt = 0; attempt < 240; attempt += 1) {
  await delay(3000);
  status = await readJson(
    await fetch(`${worker}/api/runs/${encodeURIComponent(workItemId)}`, {
      headers: authHeaders,
    }),
    "read status"
  );
  writeFileSync(
    `${outDir}/latest-status.json`,
    `${JSON.stringify(status, null, 2)}\n`
  );
  const { record } = status;
  const laneSummary = {};
  if (record?.lanes) {
    for (const lane of Object.values(record.lanes)) {
      laneSummary[lane.status] = (laneSummary[lane.status] ?? 0) + 1;
    }
  }
  const eventCount = record?.eventLog?.length ?? 0;
  const progressKey = `${record?.currentState}:${record?.status}:${eventCount}:${JSON.stringify(laneSummary)}`;
  if (progressKey !== lastProgressKey) {
    lastProgressAttempt = attempt;
    lastProgressKey = progressKey;
  }
  console.log(
    `${attempt.toString().padStart(3, "0")} state=${record?.currentState} status=${record?.status} events=${eventCount} lanes=${JSON.stringify(laneSummary)}`
  );
  if (record?.finalReceipt) {
    break;
  }
  if (record?.status === "blocked" || record?.status === "cancelled") {
    throw new Error(
      `run ended ${record.status}: ${record.blockedReason ?? ""}`
    );
  }
  if (attempt - lastProgressAttempt > 40) {
    throw new Error(
      `run made no visible progress for ${attempt - lastProgressAttempt} polls; latest state=${record?.currentState} status=${record?.status} events=${eventCount}`
    );
  }
}

const finalReceipt = status?.record?.finalReceipt;
if (!finalReceipt) {
  throw new Error("run did not capture before timeout");
}

writeFileSync(
  `${outDir}/latest-receipt.json`,
  `${JSON.stringify(finalReceipt, null, 2)}\n`
);

const pullRequest = await createPullRequestFromReceipt(finalReceipt);
writeFileSync(
  `${outDir}/latest-pr.json`,
  `${JSON.stringify(pullRequest, null, 2)}\n`
);
console.log(
  JSON.stringify(
    {
      pr: pullRequest.html_url,
      runId: finalReceipt.runId,
      status: finalReceipt.verifierResult.status,
    },
    null,
    2
  )
);

function loadEnvLocal() {
  try {
    const content = readFileSync(".env.local", "utf-8");
    const result = {};
    for (const line of content.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
        continue;
      }
      const index = trimmed.indexOf("=");
      const key = trimmed.slice(0, index);
      let value = trimmed.slice(index + 1);
      value = value.replaceAll(/^['"]|['"]$/gu, "");
      result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

async function createPullRequestFromReceipt(receipt) {
  const generatedFiles = validateGeneratedFiles(receipt.generatedFiles ?? []);
  const token = await getInstallationToken();
  const [owner, name] = repo.split("/");
  const apiBase = `https://api.github.com/repos/${owner}/${name}`;
  const mainRef = await gh(token, `${apiBase}/git/ref/heads/main`);
  const baseSha = mainRef.object.sha;
  const baseCommit = await gh(token, `${apiBase}/git/commits/${baseSha}`);
  const treeItems = [];
  for (const file of generatedFiles) {
    const blob = await gh(token, `${apiBase}/git/blobs`, {
      content: file.content,
      encoding: "utf-8",
    });
    treeItems.push({
      mode: "100644",
      path: file.path,
      sha: blob.sha,
      type: "blob",
    });
  }
  const tree = await gh(token, `${apiBase}/git/trees`, {
    base_tree: baseCommit.tree.sha,
    tree: treeItems,
  });
  const branch = `workflow-observability-spine-${receipt.runId.split("-").at(-1)}`;
  const commit = await gh(token, `${apiBase}/git/commits`, {
    author: {
      email: "shitratgit[bot]@users.noreply.github.com",
      name: "shitratgit[bot]",
    },
    message: "feat: add generated workflow observability spine prototype",
    parents: [baseSha],
    tree: tree.sha,
  });
  await gh(token, `${apiBase}/git/refs`, {
    ref: `refs/heads/${branch}`,
    sha: commit.sha,
  });
  const body = buildPrBody(receipt, branch, generatedFiles);
  const pr = await gh(token, `${apiBase}/pulls`, {
    base: "main",
    body,
    head: branch,
    title: "feat: add generated workflow observability spine prototype",
  });
  return {
    branch,
    commit: commit.sha,
    html_url: pr.html_url,
    number: pr.number,
  };
}

function validateGeneratedFiles(files) {
  const allowedPrefixes = [
    "prototypes/workflow-observability-spine-spike/",
    ".brain/resources/workflow-observability-event-schema.svx",
  ];
  const valid = files.filter((file) =>
    allowedPrefixes.some(
      (prefix) => file.path === prefix || file.path.startsWith(prefix)
    )
  );
  if (valid.length !== files.length) {
    throw new Error(
      "Generated PR payload contains files outside approved prototype/Brain scope"
    );
  }
  if (valid.length === 0) {
    throw new Error("No generated files to publish");
  }
  const joined = valid
    .map((file) => `${file.path}\n${file.content}`)
    .join("\n");
  if (
    /ACCESS_TOKEN|PI_AUTH_JSON_B64|art_v1_|shitrat_github_private_key|-----BEGIN PRIVATE KEY-----/u.test(
      joined
    )
  ) {
    throw new Error("Generated files contain secret-shaped text");
  }
  return valid;
}

function buildPrBody(receipt, branch, files) {
  return [
    "Generated by `workflow-observability-spine-spike`.",
    "",
    "## Run receipt",
    "",
    `- run: \`${receipt.runId}\``,
    `- artifacts repo: \`${receipt.artifactsRepo}\``,
    `- output target: \`${receipt.outputTarget}\``,
    `- verifier: \`${receipt.verifierResult.status}\``,
    `- max observed active lanes: \`${receipt.maxObservedActiveLanes}\``,
    `- generated harness: \`${receipt.generatedHarnessRef}\``,
    `- generated machine: \`${receipt.generatedMachineRef}\``,
    "",
    "## Generated files",
    "",
    ...files.map((file) => `- \`${file.path}\``),
    "",
    "## Observability pack",
    "",
    ...Object.entries(receipt.observabilityPack).map(
      ([key, value]) => `- ${key}: \`${value}\``
    ),
    "",
    "## Debugger diagnosis",
    "",
    receipt.verifierResult.debuggerDiagnosis.summary,
    "",
    `Next safe action: ${receipt.verifierResult.debuggerDiagnosis.nextSafeAction}`,
    "",
    "## Branch",
    "",
    `\`${branch}\``,
  ].join("\n");
}

async function getInstallationToken() {
  const appId = lease("shitrat_github_app_id");
  const installationId = lease("shitrat_github_installation_id_joelhooks");
  const privateKey = lease("shitrat_github_private_key");
  const now = Math.floor(Date.now() / 1000);
  const jwt = signJwt(
    { alg: "RS256", typ: "JWT" },
    { exp: now + 540, iat: now - 60, iss: appId },
    privateKey
  );
  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      headers: {
        Authorization: `Bearer ${jwt}`,
        "X-GitHub-Api-Version": "2022-11-28",
        accept: "application/vnd.github+json",
      },
      method: "POST",
    }
  );
  const json = await readJson(response, "create installation token");
  return json.token;
}

function lease(name) {
  const result = spawnSync("secrets", ["lease", name], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`Could not lease ${name}`);
  }
  return result.stdout.trim();
}

function signJwt(header, payload, privateKey) {
  const input = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(input);
  signer.end();
  return `${input}.${base64url(signer.sign(privateKey))}`;
}

function base64url(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return buffer.toString("base64url");
}

async function gh(token, url, body) {
  const response = await fetch(url, {
    body: body ? JSON.stringify(body) : undefined,
    headers: {
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      accept: "application/vnd.github+json",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    method: body ? "POST" : "GET",
  });
  return readJson(response, url);
}

async function readJson(response, label) {
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(
      `${label} returned non-JSON ${response.status}: ${text.slice(0, 500)}`
    );
  }
  if (!response.ok) {
    throw new Error(
      `${label} failed ${response.status}: ${JSON.stringify(json).slice(0, 800)}`
    );
  }
  return json;
}
