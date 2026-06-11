# System Dream Review UI

## Question answered

Can a Dream review be rendered as a Wzrrd-compatible human-in-the-loop report surface using the same SvelteKit/MDSvX Tufte pattern as `prototypes/shitrat-brain-proposal-ui/`?

Yes. The important next step is to make this a package-backed workflow node, not a copied report directory.

## Source shape

- Report body: `src/routes/+page.svx`
- Report layout/marginalia component: `src/lib/ReportLayout.svelte`
- Reusable report components: `src/lib/*.svelte`
- State-machine figure source: `figures/dream-workflow-state-machine.d2`
- Figure renderer: `scripts/render-d2.mjs`
- Page styling: `src/app.css`
- Wzrrd site/template metadata: `wzrrd.config.json`

This prototype was initialized with:

```bash
wzrrd init --template joel/tufte-mdsvx --slug system-dream-review-ui --title "System Dream Review" --emoji "🧠"
```

Local template receipt:

```txt
joel/tufte-mdsvx@0.1.0
```

## Workflow-node framing

The report renderer should become an installable workflow node package, roughly:

```txt
@joelhooks/wzrrd-hitl-report
  export renderReviewSurface
```

The node renders typed workflow artifacts into a review surface. It should not publish by itself.

Split the boundaries:

- `wzrrd.report.render`: package/workflow-node capability that turns typed artifacts into a static review surface.
- `review.gate.decide`: HITL gate that records accept/edit/reject/needs-more-evidence.
- `wzrrd.site.publish`: leased side-effect adapter that publishes the already-rendered, hash-pinned surface.

## Run command

Use `pnpm`, not Bun:

```bash
pnpm --filter system-dream-review-ui figures
pnpm --filter system-dream-review-ui check
pnpm --filter system-dream-review-ui build
```

Publish the built static site with explicit review expiry:

```bash
wzrrd publish --file prototypes/system-dream-review-ui/build --slug dream-hunt-2026-06-09-998d4b --expires-in 24h
```

## Deletion trigger

Delete or absorb this prototype after the Wzrrd HITL report renderer is represented as a real package/export/node in the workflow app package registry.

## Capture target

- `.brain/projects/shitrat-dream-workflow-spike.svx`
- `docs/workflow-app-spine.md`
- `docs/dynamic-workflow-machine.md`
- future package spec for `@joelhooks/wzrrd-hitl-report`

## State-machine proof rule

Wzrrd HITL reports should include a D2 state-machine figure for the workflow under review.

Preferred source order:

1. Render from pinned generated XState machine artifacts when they exist.
2. Render from pinned workflow-plan phases/steps when no generated machine artifact exists.
3. Label the proof level honestly. Do not call a static phase list a generated machine.

For this Dream run, the figure renders the pinned `workflow-plan.json` state path and marks accepted apply/deploy/rollback lanes as gated follow-ons. It does not prove fully generated XState execution because the current Dream hunt script still uses a static theme/pattern library.
