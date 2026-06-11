import { WorkflowRunsListDocumentSchema } from "$lib/schemas";
import { proxyResponse } from "$lib/server/proxy-response";
import { fetchFromWorker } from "$lib/server/worker-client";
import type { RequestHandler } from "@sveltejs/kit";

/**
 * Proxies `GET /admin/runs` on the Worker (admin-token gated) to the local
 * `/api/runs`. Forwards the `limit` and `status` query params the run board
 * uses; the admin bearer is injected server-side and never reaches the browser.
 */
export const GET: RequestHandler = async ({ url }) => {
  const query: Record<string, string> = {};
  const limit = url.searchParams.get("limit");
  if (limit !== null) {
    query.limit = limit;
  }
  const status = url.searchParams.get("status");
  if (status !== null) {
    query.status = status;
  }

  const result = await fetchFromWorker(
    {
      path: "/admin/runs",
      query,
      token: "admin",
    },
    WorkflowRunsListDocumentSchema
  );

  return proxyResponse(result);
};
