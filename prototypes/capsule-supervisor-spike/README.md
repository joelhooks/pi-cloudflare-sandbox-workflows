# Prototype: capsule-supervisor-spike

Status: active

## Question

Can a Durable-Object-shaped supervisor own a context capsule, persist XState snapshots/events, resume after instance churn, and coordinate disposable sandbox/artifact handles without treating sandbox ID as durable memory?

## Run

```bash
pnpm prototype:capsule:dry
```

## Success signal

The dry receipt proves:

- capsule is keyed by external `workItemId`
- capsule owns artifact repo ref, context pack refs, latest run id, persisted snapshot, event log, and Wzrrd refs
- sandbox run id is disposable and distinct from capsule id
- supervisor can restore from persisted XState snapshot after simulated instance churn
- success path reaches `captured`
- cancel path destroys the sandbox and reaches `cancelled`
- sending work events after cancel does not resume work
- secret refs are recorded without plaintext values

## Capture target

- `.brain/projects/pi-sandbox-workflows.svx`
- `docs/dynamic-workflow-machine.md`
- `docs/production-vs-prototypes.md`

## Delete/absorb rule

Delete after the capsule supervisor shape is rewritten into `src/` with a real Cloudflare Durable Object, or after the control-plane storage model is rejected.

Do not move this prototype into `src/`. Rewrite the production actor/storage shape from the receipts.
