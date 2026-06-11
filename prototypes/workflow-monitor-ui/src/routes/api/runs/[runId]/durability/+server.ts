import { RunDurabilityDumpSchema } from "$lib/schemas";
import { proxyResponse } from "$lib/server/proxy-response";
import { fetchFromWorker } from "$lib/server/worker-client";
import type { RequestHandler } from "@sveltejs/kit";

/**
 * Proxies `GET /runs/:runId/durability` (runs-token gated). Surfaces the
 * supervisor DO durability dump — checkpoint counts, driving-marker staleness,
 * reaper/alarm timing, active-lane count — so the operator can tell a wedged run
 * from an advancing one. No raw snapshot bodies cross this boundary.
 */
export const GET: RequestHandler = async ({ params }) => {
  const result = await fetchFromWorker(
    {
      path: `/runs/${encodeURIComponent(params.runId ?? "")}/durability`,
      token: "runs",
    },
    RunDurabilityDumpSchema
  );

  return proxyResponse(result);
};
