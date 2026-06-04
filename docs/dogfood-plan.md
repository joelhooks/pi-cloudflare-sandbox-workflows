# Dogfood Plan

Goal: use `pi-sandbox-workflows` for real work as soon as the smallest safe lane exists.

## First workload

`research-claude-workflows`

Why:

- source-heavy
- low production risk
- exercises fan-out/verification/synthesis
- produces reusable context pack
- Wzrrd is a natural review surface

## Tiny ladder

1. **Dry-run state model**
   - kept as `pnpm prototype:spike:dry`
   - no Cloudflare mutation
   - proves state/data shape cheaply
2. **Single real sandbox lane**
   - active prototype: `prototypes/sandbox-workflow-spike`
   - real Cloudflare Sandbox + Artifacts binding
   - concurrency cap `1`
   - static `PI_AUTH_JSON_B64` auth materialization into task-scoped `auth.json`
   - one Pi `-p` bounded run
   - commit report/source-map/context-pack/Wzrrd outputs to Artifacts
   - explicit `destroy()` receipt
3. **Dynamic verification machine**
   - status: proven once by real run `run-mpyzrsfj-48078d74`
   - add a supervisor/control-plane plan phase before sandbox creation
   - plan phase commits `run/plan.json`, `workflows/machine.ts`, `workflows/harness.js`, `run/verification-contract.json`, and `run/manifest.json` before any sandbox wakes up
   - implement plan artifacts and reader → verifier in the same next prototype slice, but keep the order strict: pin plan first, then execute lanes
   - first prove generated/selected XState v5 workflow-machine shape, not a one-off hard-coded verifier forever
   - use the `reader → verifier` pattern from the workflow pattern library
   - concurrency cap stays `2` as a supervisor/backpressure invariant, not because this step must run hot in parallel
   - reader lane runs first and produces the job output plus verifier-readable receipts
   - verifier lane hydrates reader artifacts and evaluates them against a job-specific verification contract
   - reusable default contract lives in `context-pack/pack.json`; exact per-run contract is pinned in `run/manifest.json`
   - generated XState v5 machine and executable harness should both be committed to Artifacts
   - add Zod v4 schemas for plan, manifest, verification contract, verification result, and Wzrrd publish result
   - infer TypeScript types from schemas instead of hand-rolling duplicate interfaces for artifact data
   - for this prototype, `workflows/machine.ts` is a source receipt only; Worker execution stays on a fixed constrained executor/known machine path
   - persist runtime snapshots with XState actor snapshot semantics; use event logs for audit/replay receipts

- snapshot resume dry proof now persists at `committingReaderOutputs`, restores there, and continues to `captured`; receipts are ignored under `prototypes/sandbox-workflow-spike/out/`
- use `just-bash` only as a cheap local simulation/test harness, not as the real Pi runtime
- for `research-claude-workflows`, the first contract is source-grounding/citation coverage; other jobs can define different outcomes and evidence
- separate artifact commits/notes per lane

4. **Machine planner**
   - active prototype: `prototypes/machine-planner-spike/`
   - dry receipt command: `pnpm prototype:planner:dry`
   - proves job specs can select known workflow patterns without executing arbitrary generated TypeScript
   - planned fixtures:
     - source-backed report -> `reader_verifier` + `wzrrd_review`
     - GitHub PR -> `edit_verify_pr` + `github_pr`
     - private analysis -> `artifact_only_capture` + `artifact_only`
   - every plan emits a validated JSON/config-like XState v5 machine receipt, harness plan, verification contract, output target, and policy checks
   - output target delivery uses generic `deliveringOutput`; Wzrrd is target-specific delivery detail, not a required system state
   - unsafe code-bearing machine fixture is rejected before planning
   - current limitation: dry planner only; no model generation, structured-output prompt, or production policy gate yet
5. **Durable capsule supervisor**
   - active prototypes: `prototypes/capsule-supervisor-spike/` and `prototypes/capsule-do-spike/`
   - dry receipt command: `pnpm prototype:capsule:dry`
   - real local Durable Object receipt command: `pnpm prototype:capsule-do:local`
   - proves capsule id derives from external `workItemId`, not sandbox id
   - proves capsule-owned artifact repo ref, context pack refs, latest run id, persisted snapshot, event log, Wzrrd ref, and secret lease refs
   - proves a new supervisor instance can restore the XState actor from the persisted capsule snapshot at `runningSandbox`
   - proves success path reaches `captured`
   - proves cancel path destroys the sandbox and reaches `cancelled`
   - proves post-cancel work events do not restart the lifecycle
   - local Wrangler Durable Object proof now persists snapshot/event/capsule records in DO storage and restores the actor from storage on every state transition request
   - current limitation: local Worker/DO proof only; not yet integrated with the deployed real sandbox/artifacts/Wzrrd route
6. **Secret lease broker**
   - active prototype: `prototypes/secret-lease-broker-spike/`
   - dry receipt command: `pnpm prototype:secrets:dry`
   - proves harness/request sees only `secretRef`
   - proves broker records a task-scoped lease for `/workspace/.pi/agent/auth.json`
   - proves public Artifacts/Wzrrd/event-log payloads contain lease metadata only
   - proves missing approval returns `missing_secret_approval` with an approval URL
   - proves receipt scan fails if known plaintext marker leaks
   - current limitation: dry broker only; no real encrypted secret storage, policy UI, token refresh, or Worker integration yet
7. **Integrated capsule run**
   - active prototype: `prototypes/integrated-capsule-run-spike/`
   - real local integration command: `pnpm prototype:integrated:real`
   - local Durable Object capsule persists snapshot/event/capsule state and calls the deployed real sandbox Worker
   - latest receipt: `integrated-capsule-run-receipt.v1`
   - latest integrated run: capsule `capsule:thread-or-issue-integrated-50ce77b3`, repo `piwf-run-mpz1z9vz-29d06a92`, plan commit `5177b6b834a0b8580bb10806c9fdc6547b8aa419`, reader commit `a8fd1cf660e2e165a6255e78ed876b76ed8a5aab`, verifier commit `daf3e3d97ee24ac28b5ff3314cf7b5589cfa3bef`, lease ref `lease:piCodexAuth:run-mpz1z9vz-29d06a92:task-scoped-auth-json`, final state `captured`, verification `verified`, destroy receipt `destroy:run-mpz1z9vz-29d06a92:ok`, Wzrrd `https://piwf-run-mpz1z9vz-29d06a92.wzrrd.sh/`
   - verified Wzrrd URL returned HTTP `200`
   - current limitation: integration bridge calls the deployed `sandbox-workflow-spike` Worker over HTTP; DO + Sandbox/Artifacts bindings are not yet in one deployed Worker module
8. **Wzrrd review gate**
   - active prototype: `prototypes/review-gate-spike/`
   - dry receipt command: `pnpm prototype:review:dry`
   - proves verifier statuses route distinctly: `verified`, `warnings`, `blocked`, `needs_human_review`
   - proves review payload includes report, source map, plan, event log, machine receipt, and verification result refs
   - proves `needs_human_review` stays pending until human approve/reject
   - proves approve reaches accepted and reject reaches rejected
   - proves private Wzrrd claim URL is excluded from public payload and receipt
   - current limitation: Wzrrd-shaped dry payload only; no real hosted review action yet

## Stop conditions

- secret handling requires broadening beyond static `PI_AUTH_JSON_B64`
- Cloudflare container quota blocks repeatable runs
- outputs are not source-backed enough to review
- prototype state gets too large to delete cleanly

If any stop condition triggers, capture the learning and delete/rewrite the spike.
