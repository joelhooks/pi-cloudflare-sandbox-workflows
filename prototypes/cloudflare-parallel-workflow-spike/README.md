# Prototype: cloudflare-parallel-workflow-spike

Status: active

## Question

Can a real deployed Cloudflare Worker own an end-to-end massively parallel dynamic Pi workflow using Worker + Durable Object + Queue + Sandbox + Artifacts, with bounded hot concurrency and Artifacts-backed receipts?

## Run

```bash
pnpm prototype:parallel:deploy
pnpm prototype:parallel:real
```

## Success signal

`pnpm prototype:parallel:real` writes:

```txt
prototypes/cloudflare-parallel-workflow-spike/out/latest-receipt.json
prototypes/cloudflare-parallel-workflow-spike/out/latest-status.json
```

The receipt must show:

- deployed Worker URL
- capsule id
- Artifacts repo/remote
- plan commit SHA
- generated machine and harness refs
- total planned lanes greater than concurrency cap
- max observed active lanes no greater than the cap
- lane receipts with real Cloudflare Sandbox IDs and Artifacts commit SHAs
- synthesis commit SHA
- verifier result
- output target delivery receipt for `implementation_plan`
- sandbox destroy receipts
- final state `captured`

## Cloudflare primitives used

- **Workers**: HTTP API + Queue consumer
- **Durable Objects**: per-work-item capsule supervisor and active lane registry
- **Queues**: lane and finalization scheduling
- **Cloudflare Sandbox**: admitted lane, synthesis, verifier, and delivery execution
- **Artifacts**: plan, machine, harness, lane outputs, synthesis, verification, delivery receipts

## Latest clean receipt

Command:

```bash
pnpm prototype:parallel:real
```

Receipt:

- run: `run-parallel-cloudflare-patterns-3e945e7e-887dd5a9`
- deployed Worker: `https://pi-cloudflare-parallel-workflow-spike.joelhooks.workers.dev`
- capsule: `capsule:parallel-cloudflare-patterns-3e945e7e`
- Artifacts repo: `piwfp-run-parallel-cloudflare-patterns-3e945e7e-887dd5a9`
- plan commit: `4e8ec58ee343e6f3fa6adf190e02607c28a0706c`
- synthesis commit: `03c30e7a847e33f23790aeea8b5464782cbf8727`
- total lanes: `8`
- concurrency cap: `3`
- max observed active lanes: `3`
- verifier status: `verified`
- output target: `implementation_plan`
- final state: `captured`
- cleanup receipts: all lane, synthesis, verifier, and delivery sandboxes destroyed with `:ok`

The ignored local receipt files are:

```txt
prototypes/cloudflare-parallel-workflow-spike/out/latest-receipt.json
prototypes/cloudflare-parallel-workflow-spike/out/latest-status.json
```

## Runtime note

Default lane runtime is bounded shell inside real Cloudflare Sandbox. Set `LANE_RUNTIME=pi` and provide `PI_AUTH_JSON_B64` if this spike should spend real Pi/model calls per lane. The Cloudflare control proof does not depend on local simulation or fake adapters.

## Capture target

- `.brain/projects/pi-sandbox-workflows.svx`
- `docs/dynamic-workflow-machine.md`
- `docs/dogfood-plan.md`
- `docs/production-vs-prototypes.md`

## Delete/absorb rule

Delete or rewrite after the real Cloudflare control shape is captured. Absorb only the state/event names, lane/admission/fan-in receipt shapes, and primitive boundaries into production `src/`; do not promote this Worker directly.
