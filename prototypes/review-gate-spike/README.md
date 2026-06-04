# Prototype: review-gate-spike

Status: active

## Question

Can a Wzrrd-style review gate present the right run artifacts, model verification outcomes including `needs_human_review`, and accept/reject human decisions without leaking claim URLs or treating unreviewed output as trusted?

## Run

```bash
pnpm prototype:review:dry
```

## Success signal

The dry receipt proves:

- verifier statuses are modeled: `verified`, `warnings`, `blocked`, `needs_human_review`
- review payload includes report, source map, plan, event log, machine receipt, and verification result refs
- `needs_human_review` stays pending until a human decision arrives
- approve transitions to accepted
- reject transitions to rejected
- claim URL is excluded from public review payload and receipt

## Capture target

- `.brain/projects/pi-sandbox-workflows.svx`
- `docs/dynamic-workflow-machine.md`
- `docs/dogfood-plan.md`

## Delete/absorb rule

Delete after the review gate shape is rewritten into `src/` or folded into a real Wzrrd review integration.

Do not move this prototype into `src/`.
