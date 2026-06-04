# Prototype: integrated-capsule-run-spike

Status: active

## Question

Can a real local Durable Object capsule orchestrate the already-proven deployed real sandbox workflow endpoint and persist one integrated capsule record containing supervisor snapshot/events plus real Sandbox/Artifacts/Wzrrd/verification receipts?

## Run

Requires ignored `.env.local` with `ACCESS_TOKEN` for the deployed `sandbox-workflow-spike` Worker.

```bash
pnpm prototype:integrated:real
```

## Success signal

The receipt proves one request shape:

```json
{
  "workItemId": "thread-or-issue-123",
  "task": "research this and produce a report",
  "contextPackRefs": ["research-claude-workflows@0.1.0"],
  "secretRefs": ["piCodexAuth"],
  "verificationContract": "source-grounded-report-v1"
}
```

Produces:

- Durable Object capsule record keyed by `workItemId`
- persisted XState snapshot in DO storage
- event log in DO storage
- real Artifacts repo/commits from deployed sandbox Worker
- real Sandbox run/destroy receipt from deployed sandbox Worker
- task-scoped auth materialization lease ref from capsule metadata
- verification result from deployed sandbox Worker
- real Wzrrd review URL
- capsule final state `captured`

## Limitation

This prototype is an integration bridge: the capsule DO calls the deployed `sandbox-workflow-spike` Worker over HTTP. It does not yet combine the DO binding and Sandbox/Artifacts bindings inside one deployed Worker module.

## Capture target

- `.brain/projects/pi-sandbox-workflows.svx`
- `docs/dynamic-workflow-machine.md`
- `docs/dogfood-plan.md`
- `docs/production-vs-prototypes.md`

## Delete/absorb rule

Delete after the integrated Worker is rewritten into `src/` or after the same-Worker binding prototype replaces it.

Do not move this prototype into `src/`.
