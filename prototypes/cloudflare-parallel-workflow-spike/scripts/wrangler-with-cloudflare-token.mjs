#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const defaultTokenSecretName = "wzrrd::cloudflare_api_token";
const defaultAccountIdSecretName = "wzrrd::cloudflare_account_id";

const leaseSecret = (name) => {
  const result = spawnSync("secrets", ["lease", name], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    return;
  }

  const value = result.stdout.trim();
  return value.length > 0 ? value : undefined;
};

const env = { ...process.env };

if (!env.CLOUDFLARE_API_TOKEN) {
  const tokenSecretName =
    env.CLOUDFLARE_API_TOKEN_SECRET_NAME ?? defaultTokenSecretName;
  env.CLOUDFLARE_API_TOKEN = leaseSecret(tokenSecretName);
}

if (!env.CLOUDFLARE_ACCOUNT_ID) {
  const accountIdSecretName =
    env.CLOUDFLARE_ACCOUNT_ID_SECRET_NAME ?? defaultAccountIdSecretName;
  env.CLOUDFLARE_ACCOUNT_ID = leaseSecret(accountIdSecretName);
}

if (!env.CLOUDFLARE_API_TOKEN) {
  console.error(
    [
      "Missing CLOUDFLARE_API_TOKEN.",
      "Set it directly, or set CLOUDFLARE_API_TOKEN_SECRET_NAME to an agent-secrets entry.",
      "Example: CLOUDFLARE_API_TOKEN=$(secrets lease <secret-name>) pnpm prototype:parallel:deploy",
    ].join("\n")
  );
  process.exit(1);
}

const wrangler = spawnSync(
  "pnpm",
  ["exec", "wrangler", ...process.argv.slice(2)],
  {
    env,
    stdio: "inherit",
  }
);

if (wrangler.error) {
  console.error(wrangler.error.message);
  process.exit(1);
}

process.exit(wrangler.status ?? 1);
