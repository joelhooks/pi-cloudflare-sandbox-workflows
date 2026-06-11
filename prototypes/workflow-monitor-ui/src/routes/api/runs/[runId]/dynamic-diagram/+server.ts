import {
  WorkflowEventStreamDocumentSchema,
  WorkflowRunStatusDocumentSchema,
} from "$lib/schemas";
import type { WorkflowTerminalBlocker } from "$lib/schemas";
import {
  buildDynamicWorkflowDiagramSource,
  deriveDynamicWorkflowView,
} from "$lib/server/dynamic-workflow-diagram";
import { fetchFromWorker } from "$lib/server/worker-client";
import { error } from "@sveltejs/kit";
import type { RequestHandler } from "@sveltejs/kit";
import { D2 } from "@terrastruct/d2";

/**
 * Live D2 render of the *generated dynamic workflow* for a single run — the
 * per-run node chain the planner synthesised, walking inside the fixed safety
 * envelope. This is the primary live chart on the run page.
 *
 * Flow: fetch the run's event stream server-side (runs-token gated — the token
 * never leaves this process) to reconstruct the executed node chain + current
 * node, plus the status doc (best-effort) for the blocker reason on a blocked
 * run. Derive the dynamic view, generate D2 source with per-node classes, render
 * to SVG, and return it. The browser embeds it inline and re-fetches on its poll
 * loop, so the chart tracks the run live.
 *
 * Renderer instance is created lazily and reused across requests (the WASM init
 * is the expensive part; the per-render compile/render is cheap).
 */

let renderer: D2 | null = null;

/** Lazily constructs (and caches) the shared D2 renderer. */
const getRenderer = (): D2 => {
  renderer ??= new D2();

  return renderer;
};

export const GET: RequestHandler = async ({ params }) => {
  const runId = params.runId ?? "";
  const eventsResult = await fetchFromWorker(
    {
      path: `/runs/${encodeURIComponent(runId)}/events`,
      token: "runs",
    },
    WorkflowEventStreamDocumentSchema
  );

  if (!eventsResult.ok) {
    error(eventsResult.status, eventsResult.message);
  }

  // Best-effort blocker detail. A non-blocked run carries no blocker; a status
  // fetch failure simply omits the reason rather than failing the whole chart.
  let blocker: WorkflowTerminalBlocker | null = null;
  const statusResult = await fetchFromWorker(
    {
      path: `/runs/${encodeURIComponent(runId)}/status`,
      token: "runs",
    },
    WorkflowRunStatusDocumentSchema
  );
  if (statusResult.ok && statusResult.value.blocker !== undefined) {
    ({ blocker } = statusResult.value);
  }

  const view = deriveDynamicWorkflowView(
    eventsResult.value.events,
    eventsResult.value.latestStatus ?? null,
    blocker
  );
  const source = buildDynamicWorkflowDiagramSource(view);

  const d2 = getRenderer();
  let svg: string;
  try {
    const compiled = await d2.compile({
      fs: { index: source },
      inputPath: "index",
      options: { layout: "elk", pad: 36, scale: 1, themeID: 0 },
    });
    svg = await d2.render(compiled.diagram, {
      ...compiled.renderOptions,
      noXMLTag: true,
      salt: `${runId}-dynamic`,
    });
  } catch {
    error(500, "Failed to render the generated dynamic-workflow diagram.");
  }

  return new Response(svg, {
    headers: {
      "cache-control": "no-store",
      "content-type": "image/svg+xml; charset=utf-8",
    },
  });
};
