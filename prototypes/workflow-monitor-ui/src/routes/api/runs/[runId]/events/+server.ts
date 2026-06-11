import { WorkflowEventStreamDocumentSchema } from "$lib/schemas";
import { proxyResponse } from "$lib/server/proxy-response";
import { fetchFromWorker } from "$lib/server/worker-client";
import type { RequestHandler } from "@sveltejs/kit";

/**
 * Proxies `GET /runs/:runId/events` (runs-token gated, JSON form). Always asks
 * the Worker for the JSON snapshot — the live-tail SSE/WebSocket transports are
 * out of scope for the board's poll loop.
 */
export const GET: RequestHandler = async ({ params }) => {
  const result = await fetchFromWorker(
    {
      path: `/runs/${encodeURIComponent(params.runId ?? "")}/events`,
      token: "runs",
    },
    WorkflowEventStreamDocumentSchema
  );

  return proxyResponse(result);
};
