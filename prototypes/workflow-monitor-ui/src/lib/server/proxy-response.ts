import { json } from "@sveltejs/kit";

import type { WorkerFetchResult } from "./worker-client";

/**
 * Maps a `WorkerFetchResult` into a JSON `Response` for a proxy `+server.ts`
 * route. Success passes the validated value through; failure surfaces the
 * upstream status plus a redacted `{ error: { code, message } }` body so the
 * client can render a meaningful error without ever seeing a token or stack.
 *
 * @param result The upstream fetch result to serialize.
 */
export const proxyResponse = <Value>(
  result: WorkerFetchResult<Value>
): Response => {
  if (result.ok) {
    return json(result.value, {
      headers: { "cache-control": "no-store" },
    });
  }

  return json(
    {
      error: {
        code: result.code,
        message: result.message,
      },
    },
    {
      headers: { "cache-control": "no-store" },
      status: result.status,
    }
  );
};
