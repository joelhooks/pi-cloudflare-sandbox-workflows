# Prototype: cloud-capability-lease-broker-spike

Status: active

## Question

Can a deployed Cloudflare Worker/Durable Object broker accept a `secretRef` + payload-bound `github.openPullRequest` capability request, keep GitHub App material and installation tokens inside the trusted Worker/DO boundary, execute PR publication from Cloudflare, and emit redacted receipts proving the sandbox/generated workflow never saw raw GitHub credentials?

This is still prototype code. The reusable artifact is the interface shape, capability envelope, policy split, adapter seams, and receipts. Do not promote this code directly into production `src/`.

## Run

Dry interface proof:

```bash
pnpm prototype:capability:dry
```

Deploy the real Worker/DO/Queue/Sandbox/Artifacts proof and upload Worker secrets:

Prereqs:

- `.env.local` or shell env has `ACCESS_TOKEN`; deploy uploads it as the Worker API bearer secret and the real runner uses the same value to start/poll.
- `secrets lease shitrat_github_app_id`, `shitrat_github_installation_id_joelhooks`, and `shitrat_github_private_key` work locally.
- Cloudflare account/token secrets are configured for `scripts/wrangler-with-cloudflare-token.mjs`.

```bash
pnpm prototype:capability:deploy
```

Run the real cloud proof:

```bash
pnpm prototype:capability:real
```

The local runner only starts, polls, verifies GitHub readback, and writes ignored receipts under `out/`. It does not create commits, branches, tokens, or PRs.

## Real proof path

```txt
local runner
  -> auth-starts the deployed Worker
  -> polls status
  -> verifies PR readback and leak scan only

Cloudflare Worker/Durable Object
  -> creates run + Artifacts repo
  -> queues execution
  -> pins payload + capability request to Artifacts
  -> starts Sandbox receipt writer
  -> validates payload-bound capability envelope
  -> mints GitHub App installation token inside Worker/DO boundary
  -> creates/updates branch + commit + PR through GitHub API
  -> records redacted receipt

Cloudflare Sandbox
  -> receives only an authenticated Cloudflare Artifacts remote plus short run metadata
  -> clones the payload-bound Artifacts repo
  -> writes run/sandbox-receipt.json
  -> pushes receipt commit to Artifacts
  -> never sees GitHub App key/token/material
```

## Success signal

A captured run writes:

```txt
prototypes/cloud-capability-lease-broker-spike/out/latest-start.json
prototypes/cloud-capability-lease-broker-spike/out/latest-status.json
prototypes/cloud-capability-lease-broker-spike/out/latest-receipt.json
```

The final receipt must show:

- PR URL created/updated by `shitratgit[bot]`
- branch and commit readback match the capability receipt
- `payloadHash` and `prBodyHash` match the approved envelope
- denied probes produce visible blockers for:
  - `capability_denied`
  - `missing_secret_approval`
  - `payload_hash_mismatch`
- sandbox cleanup receipt exists
- leak scan passes for local receipt, public observer, PR body, and PR file list

## Capture target

- `.brain/resources/decisions/cloud-capability-lease-broker.svx`
- `.brain/projects/pi-sandbox-workflows.svx`
- `.brain/resources/workflow-observability-spine.svx`

## Delete/absorb rule

Delete or rewrite after the real Cloudflare adapter proof lands and the winning shape is captured. Absorb only the interface names, request/receipt schemas, policy boundary, state names, and adapter seams into production `src/`; do not copy prototype implementation directly.
