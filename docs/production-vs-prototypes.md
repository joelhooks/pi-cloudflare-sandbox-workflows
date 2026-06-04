# Production vs Prototypes

## Production-intended code

Lives in `src/`.

Production code must be written to survive:

- retries
- cancellation
- resumability
- secrets policy changes
- sandbox sleep/destroy
- multiple capsules and concurrent runs
- Wzrrd publication/review loops

Production lifecycle logic should be modeled as an explicit state machine.

## Prototype code

Lives in `prototypes/`.

Prototype code may:

- fake Cloudflare APIs
- use fixture secrets or secret references only
- hard-code one context pack
- write local output under `out/`
- skip polish/tests when the prototype question is answered

Prototype code may not:

- become an imported dependency of `src/`
- store real secrets
- mutate production resources without a clear manual gate
- pretend a mocked seam is validated
- stay alive after learning is captured without a deletion date

## Rewrite boundary

When a prototype wins, only move these into durable surfaces:

- state names and transitions
- data shapes
- source-backed decisions
- run receipts
- minimal interfaces

Rewrite implementation into `src/`. Do not drag the spike with us like a corpse in a wagon.

## First production seams to prove

1. capsule identity keyed by external work item/thread
2. context-pack refs pinned by immutable source
3. secret reference to task-scoped `auth.json` lease
4. bounded sandbox run with explicit destroy/sleep
5. Artifacts-backed output commit
6. Wzrrd review page publication metadata

## Current prototype receipts

`prototypes/sandbox-workflow-spike/` has now proved seams 2, 4, 5, and 6 against real Cloudflare Sandbox + Artifacts + Wzrrd for one bounded Pi print-mode run, then deepened into a dynamic verification-machine receipt: plan-phase Artifacts commit before sandbox creation, fixed reader → verifier executor, Zod-validated verification result, and separate reader/verifier commits.

Partially proved:

- seam 1: `capsule-supervisor-spike/` proves the control-plane shape in dry mode, and `capsule-do-spike/` proves the same boundary in local Wrangler with a real Cloudflare Durable Object: capsule keyed by external work item, capsule-owned artifact/context/run/snapshot/event/Wzrrd refs, disposable sandbox ID, per-request actor restore from DO storage, success capture, and cancel cleanup. It is not yet deployed as the production Worker path.
- seam 3: auth is materialized as a task-scoped `/workspace/.pi/agent/auth.json` in the real sandbox spike, and `secret-lease-broker-spike/` proves the broker data shape in dry mode: harness sees `secretRef`, broker records a run-scoped lease, public Artifacts/Wzrrd/event payloads carry lease metadata only, and missing approval returns an explicit blocker. It is not yet connected to real encrypted secret storage or the deployed Worker.

Dynamic planning proof:

- `machine-planner-spike/` proves a safe planner can turn job specs into validated plans by selecting from a known pattern library. It emits JSON/config-like XState v5 machine receipts, harness steps, verification criteria, output target metadata, and policy checks. Latest receipt: `machine-planner-receipt.v1`; planned `reader_verifier + wzrrd_review`, `edit_verify_pr + github_pr`, and `artifact_only_capture + artifact_only`; rejected unsafe `requestedMachineCode` / `machineTs` fixture before planning. It does not execute generated TypeScript.

Integrated proof:

- `integrated-capsule-run-spike/` proves one end-to-end request shape in local Wrangler: a real Durable Object capsule routes by `workItemId`, persists snapshot/event/capsule state, calls the deployed real sandbox Worker, and captures real Sandbox/Artifacts/Wzrrd/verification receipts. Receipt: `integrated-capsule-run-receipt.v1`, latest run repo `piwf-run-mpz1z9vz-29d06a92`, plan commit `5177b6b834a0b8580bb10806c9fdc6547b8aa419`, reader commit `a8fd1cf660e2e165a6255e78ed876b76ed8a5aab`, verifier commit `daf3e3d97ee24ac28b5ff3314cf7b5589cfa3bef`, lease ref `lease:piCodexAuth:run-mpz1z9vz-29d06a92:task-scoped-auth-json`, Wzrrd URL `https://piwf-run-mpz1z9vz-29d06a92.wzrrd.sh/`, HTTP `200` verified.

Parallel Cloudflare proof:

- `cloudflare-parallel-workflow-spike/` proves the deployed real Cloudflare control shape for dynamic parallel workflows: Worker API + queue consumer, Durable Object capsule supervisor, Queue-backed lane scheduling/backpressure, real Sandbox lanes, Artifacts plan/lane/synthesis/verifier/output receipts, fan-in, verification, generic `implementation_plan` delivery, and cleanup. Receipt: `cloudflare-parallel-workflow-receipt.v1`, latest run `run-parallel-cloudflare-patterns-3e945e7e-887dd5a9`, repo `piwfp-run-parallel-cloudflare-patterns-3e945e7e-887dd5a9`, plan commit `4e8ec58ee343e6f3fa6adf190e02607c28a0706c`, synthesis commit `03c30e7a847e33f23790aeea8b5464782cbf8727`, lanes `8`, cap `3`, max observed active lanes `3`, final state `captured`, verifier `verified`, cleanup all `:ok`.

Do not promote prototype code. Rewrite production interfaces around these receipts instead.
