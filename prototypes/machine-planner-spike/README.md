# Prototype: machine-planner-spike

Status: active

## Question

Can a planner turn a job spec into a validated lifecycle plan using a known pattern library, without executing arbitrary generated machine code?

## Run

```bash
pnpm prototype:planner:dry
```

## Success signal

The dry receipt proves:

- Wzrrd report, GitHub PR, and artifact-only fixtures plan successfully
- each run chooses a known workflow pattern
- machine output is JSON/config-like, not executable TypeScript
- output delivery uses generic `deliveringOutput` state language
- GitHub PR output has no Wzrrd-specific state names
- GitHub PR auth is represented as secret refs / GitHub App install strategy, not raw tokens
- Wzrrd report output target includes SvelteKit static HTML build + Wzrrd publish steps as target-specific delivery details
- unsafe arbitrary machine code is rejected before planning
- receipt validates with Zod and records policy checks

## Capture target

- `.brain/projects/pi-sandbox-workflows.svx`
- `docs/dynamic-workflow-machine.md`
- `docs/dogfood-plan.md`
- `docs/production-vs-prototypes.md`
- `prototypes/README.md`

## Delete/absorb rule

Delete after the production planner is rewritten into `src/` with real policy gates and XState rendering.

Do not move this prototype into `src/`.
