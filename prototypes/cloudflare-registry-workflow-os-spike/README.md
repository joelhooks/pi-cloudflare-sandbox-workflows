# Prototype: cloudflare-registry-workflow-os-spike

Status: captured

## Question

Can a deployed Cloudflare Worker provide an internal GitHub-like registry for prompts, skills, and context packs where publish/install/search flows use Cloudflare primitives end to end: Worker API, Durable Object registry state/locks, Queue-backed validation jobs, Cloudflare Artifacts package repos, and real Cloudflare Sandbox smoke runs?

## Run

```bash
pnpm prototype:registry:deploy
pnpm prototype:registry:real
```

## Success signal

`pnpm prototype:registry:real` writes:

```txt
prototypes/cloudflare-registry-workflow-os-spike/out/latest-receipt.json
prototypes/cloudflare-registry-workflow-os-spike/out/latest-status.json
```

The receipt must show:

- deployed Worker URL
- package name/version
- Artifacts repo + commit SHA
- package ref
- Durable Object registry record persisted
- Queue validation job processed
- real Sandbox ID used for validation
- validation Sandbox destroyed
- validation result committed to Artifacts
- real Sandbox ID used for install smoke
- install smoke Sandbox destroyed
- list/package/job APIs return the published package
- final state `captured`

## Cloudflare primitives used

- **Workers**: HTTP registry API + Queue consumer
- **Durable Objects**: package registry state, version locks, job state, events
- **Queues**: async package validation and install-smoke work
- **Cloudflare Sandbox**: real validation/install-smoke runner
- **Artifacts**: one Git-compatible repo per package with versioned pack files and receipts

## Latest clean receipt

Command:

```bash
pnpm prototype:registry:real
```

Receipt:

- deployed Worker: `https://pi-cloudflare-registry-workflow-os-spike.joelhooks.workers.dev`
- package: `internal-context-pack-registry-f8be2fa6@0.1.0`
- Artifacts repo: `pi-registry-internal-context-pack-registry-f8be2fa6-cc3d6c9a`
- publish commit: `456312d52876ba81c32cabc4175ab1f81d6e50ea`
- validation job: `job-validate-internal-context-pack-registry-f8be2fa6-61d43d76`
- validation sandbox: `rv-internal-context-pack-registry-f8be2fa-b6ff9b7f`
- validation commit: `d4777c23df550575b60c9c6ff4cddebbb6af721b`
- install-smoke job: `job-install-internal-context-pack-registry-f8be2fa6-9e530ff7`
- install-smoke sandbox: `ri-internal-context-pack-registry-f8be2fa-be8a933a`
- final state: `captured`
- cleanup receipts: validation and install-smoke sandboxes destroyed with `:ok`

The ignored local receipt files are:

```txt
prototypes/cloudflare-registry-workflow-os-spike/out/latest-receipt.json
prototypes/cloudflare-registry-workflow-os-spike/out/latest-status.json
```

## Non-goals

- no registry UI
- no full package manager
- no model calls
- no local fake validation
- no generic enterprise CMS tarpit

## Capture target

- `.brain/projects/pi-sandbox-workflows.svx`
- `docs/production-vs-prototypes.md`

## Delete/absorb rule

Delete or rewrite after the real Cloudflare registry proof is captured. Absorb only the package/version/job data shapes, primitive boundaries, and receipt shape into production `src/`; do not promote this Worker directly.
