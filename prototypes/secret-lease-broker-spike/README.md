# Prototype: secret-lease-broker-spike

Status: active

## Question

Can a broker accept `secretRef` inputs, check policy, mint a task-scoped Pi `auth.json` materialization receipt, and keep plaintext secret values out of artifacts, Wzrrd payloads, event logs, and public receipts?

## Run

```bash
pnpm prototype:secrets:dry
```

## Success signal

The dry receipt proves:

- harness/request sees only `secretRef`
- broker records a task-scoped lease
- materialization target is `/workspace/.pi/agent/auth.json`
- receipt includes a content hash, never the plaintext secret value
- public artifact/Wzrrd/event-log payloads contain lease metadata only
- missing approval returns an explicit blocker
- receipt scan fails if known plaintext markers leak

## Capture target

- `.brain/projects/pi-sandbox-workflows.svx`
- `docs/production-vs-prototypes.md`
- `docs/dynamic-workflow-machine.md`

## Delete/absorb rule

Delete after a real control-plane secret broker is rewritten into `src/`, likely borrowing Kody's separation of encrypted storage, metadata discovery, approval policy, and derived-use gateways.

Do not move this prototype into `src/`.
