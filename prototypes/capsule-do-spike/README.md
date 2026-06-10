# Prototype: capsule-do-spike

Status: active

## Question

Can a real Cloudflare Durable Object own a context capsule, persist XState snapshots/events in DO storage, restore the supervisor on each request, and coordinate disposable sandbox/artifact/auth/review handles through a Worker API?

## Run

```bash
pnpm prototype:capsule-do:local
```

## Success signal

The local Wrangler proof response proves:

- Worker routes by external `workItemId`
- Durable Object storage owns the capsule record
- XState persisted snapshot is stored in DO storage
- each DO request restores the actor from persisted snapshot instead of relying on an in-memory actor field
- capsule owns artifact repo, context pack refs, secret lease refs, Wzrrd ref, latest run id, event log, and snapshot
- sandbox id is a disposable run handle, not capsule identity
- success path reaches `captured`
- cancel path reaches `cancelled` and destroys sandbox
- post-cancel work event does not restart work
- public worker is auth-gated when `ACCESS_TOKEN` is configured; local dev is allowed without it

## Capture target

- `.brain/projects/pi-sandbox-workflows.svx`
- `docs/production-vs-prototypes.md`
- `docs/dogfood-plan.md`
- `docs/dynamic-workflow-machine.md`

## Delete/absorb rule

Delete after the real Durable Object supervisor is rewritten into `src/` and integrated with the real sandbox/artifacts/wzrrd route.

Do not move this prototype into `src/`.
