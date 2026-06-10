# ShitRat Brain Proposal UI

## Question answered

Can a ShitRat brain proposal be reviewed as an MDSvX report inside a SvelteKit/Vite static app instead of a generated HTML blob?

## Source shape

- Report body: `src/routes/+page.svx`
- Report layout/marginalia component: `src/lib/ReportLayout.svelte`
- Tall D2 flowchart sources: `figures/*.d2`
- Generated SVG figure assets: `static/figures/*.svg`
- Figure renderer: `scripts/render-d2.mjs`
- Page styling: `src/app.css`

Keep report implementation details out of the reader-facing essay. Put template notes here instead. Build workflow/lifecycle/approval/runtime paths as vertical D2 charts (`direction: down`) and reject wide diagrams unless the flow truly needs them.

## Run command

```bash
pnpm --filter shitrat-brain-proposal-ui dev
pnpm --filter shitrat-brain-proposal-ui figures
pnpm --filter shitrat-brain-proposal-ui build
```

Publish the built static site with:

```bash
wzrrd publish --file prototypes/shitrat-brain-proposal-ui/build --slug shitrat-brain-proposal --expires-in 7d
```

## Deletion trigger

Delete this prototype after the ShitRat brain proposal is accepted into a real versioned package/app surface or rejected.

## Capture target

Capture accepted decisions into the ShitRat brain package spec and the dream workflow artifact format before deleting this prototype.
