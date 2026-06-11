import { WorkflowRunStatusDocumentSchema } from "$lib/schemas";
import { proxyResponse } from "$lib/server/proxy-response";
import { fetchFromWorker } from "$lib/server/worker-client";
import type { RequestHandler } from "@sveltejs/kit";

/**
 * Proxies `GET /runs/:runId/status` (runs-token gated). Returns the run's
 * current safety-envelope state, whether it is terminal, and the blocker detail
 * when blocked.
 */
export const GET: RequestHandler = async ({ params }) => {
  const result = await fetchFromWorker(
    {
      path: `/runs/${encodeURIComponent(params.runId ?? "")}/status`,
      token: "runs",
    },
    WorkflowRunStatusDocumentSchema
  );

  return proxyResponse(result);
};
