# Dream Report — Run 13 UI

## What this is

A by-hand publication of a REAL dream report. The live Dreamer run
`run-live-20260611T183704995Z-a42c60e7` rendered `report/hitl-report.mdsvx`, but
the run blocked before reaching the workflow's own `wzrrd-publish` node, so the
operator never got a rendered surface. This prototype reuses the
`prototypes/dream-pilot-001-ui` SvelteKit + MDSvX + `@terrastruct/d2` Tufte
renderer to publish that artifact as a Wzrrd page.

The report content in `src/routes/+page.svx` is verbatim from the artifact:
ten 10/10 findings, eight refinement proposals, hash-pinned generation proof,
and a not-proven 4/9-captured definition-of-done audit. It is not cleaned up.

## Source shape

- Report body: `src/routes/+page.svx`
- Report layout/marginalia: `src/lib/ReportLayout.svelte`, `src/lib/margin-note.svelte`
- State-machine figure source: `figures/generated-machine.d2` (extracted from the
  report's `<D2Fig>` block — the 14-state planner-generated machine)
- Figure renderer: `scripts/render-d2.mjs` → `static/figures/generated-machine.svg`
- Wzrrd site/template metadata: `wzrrd.config.json`

## Run commands

Use `pnpm`, not Bun:

```bash
pnpm --filter dream-report-run13-ui figures
pnpm --filter dream-report-run13-ui build
```

Publish the built static site:

```bash
cd prototypes/dream-report-run13-ui
wzrrd publish --file build --slug dream-report-run13
```

The published page is `noindex` and expiring — an operator review surface, not
the canonical artifact. The canonical source is the run's `hitl-report.mdsvx`.

## Deletion trigger

Delete or absorb this prototype once the workflow's own leased `wzrrd.site.publish`
node delivers HITL report pages, so reports no longer have to be published by hand.
