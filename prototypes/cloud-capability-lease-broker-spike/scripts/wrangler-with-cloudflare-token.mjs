#!/usr/bin/env node
/* eslint-disable curly, unicorn/no-useless-undefined */
import { spawnSync } from "node:child_process";

const defaultTokenSecretName = "wzrrd::cloudflare_api_token";
const defaultAccountIdSecretName = "wzrrd::cloudflare_account_id";

const leaseFailures = [];

const leaseSecret = (name) => {
  const result = spawnSync("secrets", ["lease", name], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    leaseFailures.push(`${name}: ${result.stderr.trim() || "lease failed"}`);
    return undefined;
  }

  const value = result.stdout.trim();
  return value.length > 0 ? value : undefined;
};

const env = { ...process.env };

if (!env.CLOUDFLARE_API_TOKEN) {
  env.CLOUDFLARE_API_TOKEN = leaseSecret(
    env.CLOUDFLARE_API_TOKEN_SECRET_NAME ?? defaultTokenSecretName
  );
}

if (!env.CLOUDFLARE_ACCOUNT_ID) {
  env.CLOUDFLARE_ACCOUNT_ID = leaseSecret(
    env.CLOUDFLARE_ACCOUNT_ID_SECRET_NAME ?? defaultAccountIdSecretName
  );
}

if (!env.CLOUDFLARE_API_TOKEN) {
  console.error(
    [
      "Missing CLOUDFLARE_API_TOKEN.",
      "Set it directly, or configure CLOUDFLARE_API_TOKEN_SECRET_NAME.",
      leaseFailures.length > 0
        ? `Secret lease failures:\n${leaseFailures.join("\n")}`
        : undefined,
    ]
      .filter(Boolean)
      .join("\n")
  );
  process.exit(1);
}

const pnpmBin = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const wrangler = spawnSync(
  pnpmBin,
  ["exec", "wrangler", ...process.argv.slice(2)],
  { env, stdio: "inherit" }
);

if (wrangler.error) {
  console.error(wrangler.error.message);
  process.exit(1);
}

if (wrangler.status === null && wrangler.signal) {
  const signalOffsets = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };
  process.exit(128 + (signalOffsets[wrangler.signal] ?? 1));
}

process.exit(wrangler.status ?? 1);
