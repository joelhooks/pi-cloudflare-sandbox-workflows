import type { ZodType } from "zod";

import { loadMonitorConfig } from "./config";

/**
 * Server-only client for the deployed Worker monitor endpoints. Each call reads
 * the config (and therefore the tokens) here, injects the correct bearer, and
 * returns a discriminated result so the `+server.ts` routes can map upstream
 * failures to a clean local response. The browser never sees a token because it
 * only ever calls the local `/api/*` proxy that wraps these functions.
 */

export type WorkerFetchResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: string;
      readonly message: string;
    };

type TokenKind = "admin" | "runs";

interface WorkerRequest {
  readonly path: string;
  readonly query?: Record<string, string>;
  readonly token: TokenKind;
}

const buildUrl = (
  baseUrl: string,
  path: string,
  query: Record<string, string> | undefined
): string => {
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value);
  }

  return url.toString();
};

/**
 * Performs an authenticated GET against the Worker and validates the JSON body
 * with the supplied schema. Network errors, non-2xx responses, and schema
 * mismatches all collapse into a structured `{ ok: false }` result rather than
 * throwing, so the proxy routes stay simple and never leak a stack trace.
 *
 * @param request Upstream path, optional query, and which token to send.
 * @param schema Zod schema the response body must satisfy.
 */
export const fetchFromWorker = async <Value>(
  request: WorkerRequest,
  schema: ZodType<Value>
): Promise<WorkerFetchResult<Value>> => {
  let config;
  try {
    config = loadMonitorConfig();
  } catch (error) {
    return {
      code: "monitor_unconfigured",
      message:
        error instanceof Error ? error.message : "Monitor is not configured.",
      ok: false,
      status: 503,
    };
  }

  const bearer =
    request.token === "admin" ? config.adminToken : config.runsToken;
  const url = buildUrl(config.workerBaseUrl, request.path, request.query);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${bearer}`,
      },
    });
  } catch (error) {
    return {
      code: "worker_unreachable",
      message:
        error instanceof Error ? error.message : "Could not reach the Worker.",
      ok: false,
      status: 502,
    };
  }

  if (!response.ok) {
    let code = "worker_error";
    let message = `Worker responded with ${response.status}.`;
    try {
      const body: unknown = await response.json();
      if (
        typeof body === "object" &&
        body !== null &&
        "error" in body &&
        typeof body.error === "object" &&
        body.error !== null
      ) {
        const errorBody = body.error as Record<string, unknown>;
        if (typeof errorBody.code === "string") {
          ({ code } = errorBody);
        }
        if (typeof errorBody.message === "string") {
          ({ message } = errorBody);
        }
      }
    } catch {
      // Non-JSON error body; keep the generic message.
    }

    return {
      code,
      message,
      ok: false,
      status: response.status,
    };
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return {
      code: "worker_invalid_json",
      message: "Worker returned a body that was not JSON.",
      ok: false,
      status: 502,
    };
  }

  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return {
      code: "worker_contract_mismatch",
      message: "Worker response did not match the expected monitor schema.",
      ok: false,
      status: 502,
    };
  }

  return { ok: true, value: parsed.data };
};
