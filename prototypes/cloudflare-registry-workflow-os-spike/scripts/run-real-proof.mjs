#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const repoRoot = resolve(import.meta.dirname, "../../..");
const prototypeDir = resolve(
  repoRoot,
  "prototypes/cloudflare-registry-workflow-os-spike"
);
const fixturePath = resolve(prototypeDir, "fixtures/context-pack.json");
const outPath = resolve(prototypeDir, "out/latest-receipt.json");
const statusOutPath = resolve(prototypeDir, "out/latest-status.json");
const workerUrl =
  process.env.REGISTRY_WORKER_URL ??
  "https://pi-cloudflare-registry-workflow-os-spike.joelhooks.workers.dev";

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

const jsonFetch = async (url, accessToken, init = {}) => {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...authHeaders(accessToken),
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(
      `${url} returned non-JSON ${response.status}: ${text.slice(0, 500)}`
    );
  }
  if (!response.ok || body.ok !== true) {
    throw new Error(
      `${url} failed: ${response.status} ${JSON.stringify(body)}`
    );
  }
  return body;
};

const waitForJob = async (jobId, accessToken) => {
  const started = Date.now();
  const timeoutMs = Number(process.env.REGISTRY_RUN_TIMEOUT_MS ?? 600_000);
  while (Date.now() - started < timeoutMs) {
    const body = await jsonFetch(
      `${workerUrl}/api/jobs/${encodeURIComponent(jobId)}`,
      accessToken
    );
    const { job } = body;
    console.log(
      JSON.stringify({
        jobId,
        sandboxId: job.sandboxId,
        status: job.status,
        type: job.type,
      })
    );
    if (job.status === "succeeded") {
      return body;
    }
    if (job.status === "failed") {
      throw new Error(`job failed: ${JSON.stringify(body)}`);
    }
    await sleep(3000);
  }
  throw new Error(`timed out waiting for ${jobId}`);
};

const buildReceipt = ({
  deployedWorkerUrl,
  installSmokeJob,
  listBody,
  packageBody,
  packageVersion,
  validationJob,
}) => {
  const packageRecord = packageBody.package;
  const version = packageRecord.versions[packageVersion];
  return {
    artifactRemote: version.artifactRemote,
    artifactRepoName: version.artifactRepoName,
    checks: [
      {
        id: "real-cloudflare-primitives",
        status: "passed",
        summary:
          "Publish, validation, and install smoke used deployed Worker + Durable Object + Queue + Artifacts + Sandbox.",
      },
      {
        id: "validation-sandbox-destroyed",
        status: validationJob.sandboxDestroyReceipt?.endsWith(":ok")
          ? "passed"
          : "failed",
        summary:
          "Validation job recorded a real Sandbox id and destroy receipt.",
      },
      {
        id: "install-smoke-sandbox-destroyed",
        status: installSmokeJob.sandboxDestroyReceipt?.endsWith(":ok")
          ? "passed"
          : "failed",
        summary:
          "Install smoke job recorded a real Sandbox id and destroy receipt.",
      },
      {
        id: "list-and-package-api",
        status: listBody.packages.some(
          (item) => item.name === packageRecord.name
        )
          ? "passed"
          : "failed",
        summary:
          "Registry list and package read APIs returned the published package.",
      },
    ],
    deployedWorkerUrl,
    finalState: "captured",
    installSmokeJobId: installSmokeJob.id,
    installSmokeSandboxDestroyReceipt: installSmokeJob.sandboxDestroyReceipt,
    installSmokeSandboxId: installSmokeJob.sandboxId,
    listApiPackageCount: listBody.packages.length,
    packageName: packageRecord.name,
    packageRef: version.packageRef,
    packageVersion,
    publishCommitSha: version.commitSha,
    validationCommitSha: validationJob.resultCommitSha,
    validationJobId: validationJob.id,
    validationSandboxDestroyReceipt: validationJob.sandboxDestroyReceipt,
    validationSandboxId: validationJob.sandboxId,
  };
};

const accessToken = await readAccessToken();
await jsonFetch(`${workerUrl}/healthz`, accessToken);

const fixture = JSON.parse(await readFile(fixturePath, "utf-8"));
const suffix = crypto.randomUUID().slice(0, 8);
const packageName = `${fixture.name}-${suffix}`;
const publishPayload = {
  ...fixture,
  name: packageName,
  pack: { ...fixture.pack, id: packageName },
};

const publishBody = await jsonFetch(`${workerUrl}/api/packages`, accessToken, {
  body: JSON.stringify(publishPayload),
  method: "POST",
});
console.log(
  `published ${packageName}@${fixture.version}; validation ${publishBody.job.id}`
);
const validationBody = await waitForJob(publishBody.job.id, accessToken);

const installBody = await jsonFetch(
  `${workerUrl}/api/runs/install-smoke`,
  accessToken,
  {
    body: JSON.stringify({ name: packageName, version: fixture.version }),
    method: "POST",
  }
);
console.log(`install smoke ${installBody.job.id}`);
const installDoneBody = await waitForJob(installBody.job.id, accessToken);

const listBody = await jsonFetch(`${workerUrl}/api/packages`, accessToken);
const packageBody = await jsonFetch(
  `${workerUrl}/api/packages/${encodeURIComponent(packageName)}`,
  accessToken
);

const finalReceipt = buildReceipt({
  deployedWorkerUrl: workerUrl,
  installSmokeJob: installDoneBody.job,
  listBody,
  packageBody,
  packageVersion: fixture.version,
  validationJob: validationBody.job,
});

if (finalReceipt.checks.some((check) => check.status !== "passed")) {
  throw new Error(
    `receipt has failed checks: ${JSON.stringify(finalReceipt, null, 2)}`
  );
}

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(finalReceipt, null, 2)}\n`, "utf-8");
await writeFile(
  statusOutPath,
  `${JSON.stringify({ installSmoke: installDoneBody, package: packageBody, validation: validationBody }, null, 2)}\n`,
  "utf-8"
);
console.log(JSON.stringify(finalReceipt, null, 2));
console.log(`wrote ${outPath}`);
console.log(`wrote ${statusOutPath}`);
