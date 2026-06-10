# Prototype: shitrat-dream-workflow-spike

Status: active-local-artifact

## Question

Can a Dream be modeled as a dynamic workflow that crawls near-term and long-term session history, hydrates transcript receipts, connects dots, ratifies flows, sorts core memories, and emits artifact-backed review/apply/rollback lanes for the ShitRat operating graph?

## PARA placement

- Recommended bucket: Project
- Confidence: high
- Why: this has a concrete prototype outcome and finish point: prove the dream-as-dynamic-workflow shape inside the Cloudflare sandbox workflow rig.
- Missing fields: runnable command is not migrated yet; current migration is Brain/docs only.
- Smallest useful change: keep the old `pi-cloudflare-dream` repo as source evidence, but make this named prototype the owning surface.

## Run

Run the fresh workflow-owned local artifact prototype:

```bash
pnpm prototype:shitrat-dream:local
```

Existing source proof remains runnable in the old local spike if comparison is needed:

```bash
cd /Users/joel/Code/joelhooks/pi-cloudflare-dream
pnpm dream:hunt --scope system --focus system-network-graph
```

## Delineation

Read `TODO.md` before treating this prototype as evidence. It separates proved local behavior from fixture/local-only seams and blocked live mutations.

## Success signal

Current local artifact prototype is done when:

- this named prototype exists under `prototypes/`,
- the sandbox workflow Brain points here,
- dream artifact format and workflow model docs live under this prototype,
- top-level ShitRat operating graph docs remain in `docs/shitrat-operating-graph-artifacts.md`,
- `pnpm prototype:shitrat-dream:local` writes the artifact-shaped output below,
- validation/typecheck pass.

Success output:

```txt
out/latest-receipt.json
out/artifacts/<run-id>/manifest.json
out/artifacts/<run-id>/crawl-plan.json
out/artifacts/<run-id>/hydration-receipts.jsonl
out/artifacts/<run-id>/candidate-core-memories.jsonl
out/artifacts/<run-id>/flow-ratifications.jsonl
out/artifacts/<run-id>/workflow-plan.json
out/artifacts/<run-id>/review-decisions.json
out/artifacts/<run-id>/patches/*.diff
out/artifacts/<run-id>/rollback/*.diff
out/artifacts/<run-id>/apply-receipts/*.json
out/artifacts/<run-id>/summaries/review.md
```

## Capture target

- `.brain/projects/shitrat-dream-workflow-spike.svx`
- `docs/dynamic-workflow-machine.md`
- `docs/shitrat-operating-graph-artifacts.md`
- `prototypes/shitrat-dream-workflow-spike/docs/artifact-format.md`
- `prototypes/shitrat-dream-workflow-spike/docs/workflow-model.md`

## Delete/absorb rule

Delete or rewrite after the Dream workflow shape is captured by production interfaces. Absorb only the data contracts, state names, access boundaries, source-hydration rules, and artifact receipts into `src/`. Do not promote old `pi-cloudflare-dream` code directly.

## Source spike

Original local spike:

```txt
/Users/joel/Code/joelhooks/pi-cloudflare-dream
```

Relevant source docs migrated from:

```txt
README.md
docs/artifact-format.md
docs/dream-workflow-model.md
docs/shitrat-cloud-artifacts.md
```
