import { WorkflowEventStreamDocumentSchema } from "$lib/schemas";
import {
  buildStateDiagramSource,
  deriveWalkSnapshot,
} from "$lib/server/state-diagram";
import { fetchFromWorker } from "$lib/server/worker-client";
import { error } from "@sveltejs/kit";
import type { RequestHandler } from "@sveltejs/kit";
import { D2 } from "@terrastruct/d2";

/**
 * Live D2 render of the safety-envelope state machine for a single run.
 *
 * Flow: fetch the run's event stream server-side (runs-token gated — the token
 * never leaves this process), derive the walked-state set + current state from
 * the events, generate the D2 source with per-node classes applied, render to
 * SVG via `@terrastruct/d2`, and return the SVG. The browser embeds it as inline
 * markup and re-fetches it on its poll loop, so the chart tracks the run live.
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
  const result = await fetchFromWorker(
    {
      path: `/runs/${encodeURIComponent(params.runId ?? "")}/events`,
      token: "runs",
    },
    WorkflowEventStreamDocumentSchema
  );

  if (!result.ok) {
    error(result.status, result.message);
  }

  const snapshot = deriveWalkSnapshot(
    result.value.events,
    result.value.latestStatus ?? null
  );
  const source = buildStateDiagramSource(snapshot);

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
      salt: params.runId ?? "run",
    });
  } catch {
    error(500, "Failed to render the state-machine diagram.");
  }

  return new Response(svg, {
    headers: {
      "cache-control": "no-store",
      "content-type": "image/svg+xml; charset=utf-8",
    },
  });
};
