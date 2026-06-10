# Dream Sequence Vision UI

## Question answered

Can the Dreaming goal be rendered as a concise Wzrrd-compatible reference page using the project report pattern?

Yes. This prototype turns `.brain/resources/dream-sequence-memory-fabric.svx` into a human-readable goal, workflow shape, proof contract, and next build slice.

## Source shape

- Report body: `src/routes/+page.svx`
- Report layout: `src/lib/ReportLayout.svelte`
- Reusable report components: `src/lib/*.svelte`
- Dynamic-workflow figure source: `figures/dream-workflow-state-machine.d2`
- Figure renderer: `scripts/render-d2.mjs`
- Page styling: `src/app.css`
- Wzrrd site/template metadata: `wzrrd.config.json`

## Run command

Use `pnpm`, not Bun:

```bash
pnpm --filter dream-sequence-vision-ui figures
pnpm --filter dream-sequence-vision-ui check
pnpm --filter dream-sequence-vision-ui build
```

Publish the built static site as a short-lived review surface:

```bash
wzrrd publish --file prototypes/dream-sequence-vision-ui/build --slug dream-sequence-memory-fabric-2026-06-09
```

## Deletion trigger

Delete or absorb this prototype after the Dream report renderer is represented as a package-backed workflow node in the workflow app package registry.

## Capture target

- `.brain/resources/dream-sequence-memory-fabric.svx`
- `docs/dream-report-canon.md`
- future package spec for a `DreamReportPort` / Wzrrd HITL workflow node

## Proof rule

The D2 figure shows the target dynamic workflow state machine shape. It is not proof that this run executed a generated XState artifact.

The real proof contract still needs the planner prompt/transcript, generated machine config, generated TypeScript, harness source, hashes, Cloudflare run/event receipts, capability lease receipts, and verifier proof that Cloudflare executed the generated artifacts. A local harness, static branch table, or hand-written `if`/`else`/`switch` dispatcher fails the definition of done.
