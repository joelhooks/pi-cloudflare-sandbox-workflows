# Prototype: sandbox-workflow-spike

Status: active

## Question

Can a real Cloudflare Worker plan a dynamic XState-shaped workflow before sandbox creation, pin plan artifacts to Artifacts, run a fixed reader → verifier pipeline in a Cloudflare Sandbox, publish a Wzrrd review, destroy the sandbox with receipts, and prove the same machine can persist/restore a supervisor snapshot mid-run in the dry harness?

## Run

Set the Codex auth seed once. This pipes base64 into Wrangler and does not print the raw token bundle:

```bash
pnpm prototype:spike:auth:put
```

For deployed workers, set an `ACCESS_TOKEN` secret. Local `localhost` dev is allowed without it; public workers are not. The script leases Cloudflare credentials from agent-secrets when `CLOUDFLARE_API_TOKEN` is not already set:

```bash
export ACCESS_TOKEN="$(openssl rand -hex 32)"
pnpm prototype:spike:access:put
```

Override the agent-secrets names when needed:

```bash
CLOUDFLARE_API_TOKEN_SECRET_NAME=<secret-name> \
CLOUDFLARE_ACCOUNT_ID_SECRET_NAME=<account-id-secret-name> \
pnpm prototype:spike:access:put
```

Deploy the real Worker/Sandbox prototype:

```bash
pnpm prototype:spike:deploy
```

Then invoke the bounded workflow:

```bash
curl -X POST https://pi-sandbox-workflow-spike.joelhooks.workers.dev/api/real-run \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"task":"Produce the research-claude-workflows spike report"}'
```

Local dev is still available with `pnpm prototype:spike`, but a real Pi run needs `PI_AUTH_JSON_B64` in local Wrangler vars. Prefer deploy for the current real receipt so we do not write the OAuth blob to `.dev.vars`.

Keep the dry receipt when we need a no-Cloudflare sanity check. It now persists the actor at `committingReaderOutputs`, restores with `createActor(machine, { snapshot })`, then continues to `captured`:

```bash
pnpm prototype:spike:dry
```

## Success signal

The `/api/real-run` response ends at `captured` and includes:

- capsule id
- context pack ref
- task-scoped auth lease/materialization ref
- real Cloudflare Sandbox id
- real Artifacts repo remote and commit SHAs, without repo token leakage
- plan-phase commit before sandbox creation
- pinned `run/plan.json`, `workflows/machine.ts`, `workflows/harness.js`, `run/verification-contract.json`, and `run/manifest.json`
- separate reader and verifier lane commits/receipts
- Zod-validated verification result
- real Wzrrd static Site URL
- Wzrrd `claimUrl` when published anonymously
- destroy receipt

The dry run also writes ignored local receipts under `prototypes/sandbox-workflow-spike/out/`:

- `latest-persisted-snapshot.json`
- `latest-resume-receipt.json`
- `latest-run.json`

## Capture target

- `.brain/projects/pi-sandbox-workflows.svx`
- `docs/production-vs-prototypes.md`

## Delete/absorb rule

Delete this prototype after one of these happens:

1. the real Cloudflare Sandbox workflow spine is rewritten into `src/`, or
2. we decide this route shape is wrong and create the next spike.

Do not move this code into `src/`. Rewrite production code from the captured state/data model.
