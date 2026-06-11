import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Server-side configuration for the workflow monitor proxy.
 *
 * Tokens are read here and never leave the server: the `+server.ts` routes call
 * `loadMonitorConfig()` and inject the bearer into the upstream fetch, so the
 * browser only ever talks to the local `/api/*` surface. Nothing in this module
 * is importable from client code (the `$lib/server` segment is enforced by
 * SvelteKit, and the values come from `process.env`).
 */
export interface MonitorConfig {
  readonly adminToken: string;
  readonly runsToken: string;
  readonly workerBaseUrl: string;
}

const DEFAULT_WORKER_BASE_URL =
  "https://pi-cloudflare-sandbox-workflows.joelhooks.workers.dev";

const moduleDir = import.meta.dirname;

/**
 * Repo-root `.env.local`. The monitor lives at
 * `prototypes/workflow-monitor-ui/src/lib/server`, so the root is five levels up.
 */
const repoRootEnvLocalPath = resolve(
  moduleDir,
  "..",
  "..",
  "..",
  "..",
  "..",
  ".env.local"
);

/**
 * Minimal `KEY=VALUE` parser for `.env.local`. Skips blank lines and comments,
 * strips a single pair of wrapping quotes, and only fills keys that are not
 * already present in `process.env` (real environment wins). Deliberately tiny so
 * the monitor has no runtime dependency on a dotenv package.
 *
 * @param contents Raw file contents of an env file.
 */
const parseEnvFile = (contents: string): Record<string, string> => {
  const parsed: Record<string, string> = {};
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }

    parsed[key] = value;
  }

  return parsed;
};

let envLocalCache: null | Record<string, string> = null;

/**
 * Reads and caches the repo-root `.env.local` so the proxy can pick up the
 * `WORKFLOW_APP_*` tokens without the operator exporting them by hand. Missing
 * file is fine — `process.env` / `MONITOR_*` overrides still apply.
 */
const readEnvLocal = (): Record<string, string> => {
  if (envLocalCache !== null) {
    return envLocalCache;
  }

  try {
    envLocalCache = parseEnvFile(readFileSync(repoRootEnvLocalPath, "utf-8"));
  } catch {
    envLocalCache = {};
  }

  return envLocalCache;
};

/**
 * Resolves a single setting, preferring the real process environment over the
 * `.env.local` fallback. Returns `undefined` when neither source has it.
 *
 * @param keys Ordered list of env var names to check (first hit wins).
 */
const readSetting = (keys: readonly string[]): string | undefined => {
  const envLocal = readEnvLocal();
  for (const key of keys) {
    const fromProcess = process.env[key];
    if (fromProcess !== undefined && fromProcess !== "") {
      return fromProcess;
    }

    const fromFile = envLocal[key];
    if (fromFile !== undefined && fromFile !== "") {
      return fromFile;
    }
  }

  return undefined;
};

export class MonitorConfigError extends Error {
  public readonly missing: readonly string[];

  public constructor(missing: readonly string[]) {
    super(
      `Workflow monitor is missing required configuration: ${missing.join(
        ", "
      )}. Set them in the repo-root .env.local or the process environment.`
    );
    this.name = "MonitorConfigError";
    this.missing = missing;
  }
}

/**
 * Builds the monitor proxy config from `process.env` + repo-root `.env.local`.
 *
 * - Worker base URL: `MONITOR_WORKER_BASE_URL` overrides; otherwise the deployed
 *   Worker URL. Trailing slashes are trimmed so path joins are clean.
 * - Runs token: `MONITOR_RUNS_TOKEN` overrides, else `WORKFLOW_APP_RUNS_TOKEN`.
 * - Admin token: `MONITOR_ADMIN_TOKEN` overrides, else `WORKFLOW_APP_ADMIN_TOKEN`.
 *
 * @throws {MonitorConfigError} When a required token is absent from every source.
 */
export const loadMonitorConfig = (): MonitorConfig => {
  const workerBaseUrl = (
    readSetting(["MONITOR_WORKER_BASE_URL"]) ?? DEFAULT_WORKER_BASE_URL
  ).replace(/\/+$/u, "");
  const runsToken = readSetting([
    "MONITOR_RUNS_TOKEN",
    "WORKFLOW_APP_RUNS_TOKEN",
  ]);
  const adminToken = readSetting([
    "MONITOR_ADMIN_TOKEN",
    "WORKFLOW_APP_ADMIN_TOKEN",
  ]);

  const missing: string[] = [];
  if (runsToken === undefined) {
    missing.push("WORKFLOW_APP_RUNS_TOKEN");
  }
  if (adminToken === undefined) {
    missing.push("WORKFLOW_APP_ADMIN_TOKEN");
  }
  if (
    missing.length > 0 ||
    runsToken === undefined ||
    adminToken === undefined
  ) {
    throw new MonitorConfigError(missing);
  }

  return {
    adminToken,
    runsToken,
    workerBaseUrl,
  };
};
