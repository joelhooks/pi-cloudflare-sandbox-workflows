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
9. **Real Cloudflare parallel workflow**
   - active prototype: `prototypes/cloudflare-parallel-workflow-spike/`
   - deploy command: `pnpm prototype:parallel:deploy`
   - real receipt command: `pnpm prototype:parallel:real`
   - proves Worker API + queue consumer, Durable Object supervisor, Queue-backed lane scheduling/backpressure, real Cloudflare Sandbox execution, and Artifacts-backed receipts in one deployed Worker module
   - latest clean receipt: `cloudflare-parallel-workflow-receipt.v1`
   - latest run: `run-parallel-cloudflare-patterns-3e945e7e-887dd5a9`, capsule `capsule:parallel-cloudflare-patterns-3e945e7e`, repo `piwfp-run-parallel-cloudflare-patterns-3e945e7e-887dd5a9`
   - plan commit `4e8ec58ee343e6f3fa6adf190e02607c28a0706c`, synthesis commit `03c30e7a847e33f23790aeea8b5464782cbf8727`
   - planned lanes `8`, concurrency cap `3`, max observed active lanes `3`
   - all lane, synthesis, verifier, and delivery sandboxes destroyed with `:ok`
   - final state `captured`, verifier status `verified`, output target `implementation_plan`
   - current limitation: lane runtime defaults to bounded shell in real Sandbox; set `LANE_RUNTIME=pi` + `PI_AUTH_JSON_B64` when the next question is model spend rather than Cloudflare control shape

## Stop conditions

- secret handling requires broadening beyond static `PI_AUTH_JSON_B64`
- Cloudflare container quota blocks repeatable runs
- outputs are not source-backed enough to review
- prototype state gets too large to delete cleanly

If any stop condition triggers, capture the learning and delete/rewrite the spike.

## Next required prototype: Cloud Capability Lease Broker + PR output

Joel correction, 2026-06-05: the observability PR proof was still hybrid. The workflow build ran in Cloudflare, but GitHub PR publication happened from a local ShitRat adapter. That is not acceptable for the real product standard. Secrets are a pillar, but the workflow should not lease raw secrets or broad tokens. It should lease **permission to perform one exact operation** through a trusted broker.

Canonical term: **capability lease**.

Ports/adapters requirement: the prototype must code against interfaces. Core capability workflow code defines portable ports such as `CapabilityLeaseBroker`, `CapabilityPolicyAuthorizer`, `SecretMaterialStore`, `PullRequestOutputPort`, and `CapabilityReceiptSink`. Cloudflare Worker/DO/storage, GitHub App/API calls, Artifacts `filesRef` resolution, and observability writes are adapters behind those ports. Core code must not import `cloudflare:workers`, the Sandbox SDK, Wrangler, `@octokit/*`, raw GitHub clients, Node filesystem/shell helpers, or concrete secret storage implementations.

Interface-prototyping stance: this prototype is explicitly allowed to focus on the interface shape. The main artifact is the portable core contract plus one real Cloudflare/GitHub adapter path that proves the interface is not fantasy. Do not promote the prototype interfaces into production `src/` by copy/paste; after the proof, rewrite the winning interface names, request/receipt schemas, policy boundaries, and adapter seams into production.

Expected prototype layout:

```txt
prototypes/cloud-capability-lease-broker-spike/
  src/core/
    capability-lease-broker.ts
    capability-policy-authorizer.ts
    secret-material-store.ts
    pull-request-output-port.ts
    capability-receipt-sink.ts
    schemas.ts
  src/adapters/
    cloudflare-capability-lease-broker.ts
    cloudflare-secret-material-store.ts
    github-app-pull-request-output.ts
    artifacts-files-ref.ts
    observability-receipt-sink.ts
  src/worker.ts
```

Create a new prototype instead of patching this into the observability spike:

```txt
prototypes/cloud-capability-lease-broker-spike/
```

Question:

```txt
Can a deployed Cloudflare Worker/Durable Object broker accept secretRef + payload-bound capability requests, keep root GitHub App material and installation tokens inside the trusted boundary, execute PR publication from Cloudflare, and prove no plaintext secret, broad token, bearer-ish URL, or raw Worker secret name/value leaks into Artifacts, logs, public observers, prompts, PR body, or final receipts?
```

Required real path:

```txt
workflow plan carries secretRef + requested capability only
→ Durable Object broker validates policy, run envelope, capability id, payload hash, repo allowlist, actor, and expiry
→ broker reads root GitHub App material from Worker secret/Secrets Store binding or encrypted private storage
→ broker mints any GitHub App installation token only inside the trusted Worker/DO boundary
→ generated harness/finalizer receives a capabilityRef and operation receipt, not root secret material or installation token
→ broker performs the exact GitHub API operation: create branch/tree/commit/PR from approved filesRef + payloadHash
→ receipt records actor, repo, branch, commit, PR URL, capabilityRef, lease expiry, policy id, payload hash, and cleanup/revoke status
→ public receipts leak no private key, installation token, bearer-ish URL, token-bearing remote, or raw Worker secret name/value
```

Capability request shape:

```ts
type CapabilityLeaseRequest = {
  runId: string;
  workItemId: string;
  secretRef: "githubApp:shitrat";
  capability: "github.openPullRequest";
  repo: "joelhooks/pi-cloudflare-sandbox-workflows";
  branch: string;
  filesRef: string;
  payloadHash: string;
  prTitle: string;
  prBodyHash: string;
  expiresInSeconds: number;
};
```

Acceptance gates:

- local runner may start/poll/verify only; it may not create commits, branches, tokens, or PRs
- no sandbox, generated harness, Artifacts repo, PR body, Brain note, logs, or public observer sees a GitHub App private key, installation token, token-bearing remote URL, or raw secret value
- the broker executes only the exact payload-bound operation; branch, repo, filesRef, PR title/body hash, and run id are part of the lease envelope
- a denied request returns `missing_secret_approval`, `capability_denied`, or `payload_hash_mismatch`, not a retry loop
- leases have expiry, scope, actor, purpose, run id, capability id, payload hash, and revoke/cleanup receipt
- verifier proves PR readback from GitHub API shows `shitratgit[bot]` and the expected branch/commit/payload hash
- failure modes are stateful and visible: blocked states, redacted error, approval URL/ref, no silent queue retry soup

Borrow from existing receipts:

- `prototypes/secret-lease-broker-spike/` for `secretRef -> task-scoped lease -> metadata-only receipt`
- `docs/kody-secrets-pattern.md` for encrypted storage, metadata discovery, placeholder references, approval errors, rotation doctrine, and derived secret use at a gateway
- `prototypes/workflow-observability-spine-spike/` for generated harness, isolated lanes, observability pack, verifier/debugger receipt, and the discovered anti-patterns

Hard line: the next proof must produce a PR without local GitHub credentials, local ShitRat API calls, or sandbox-visible GitHub tokens. Local can verify; the cloud broker must execute the output capability.

## Cloud capability broker proof receipt

Status: proved by `prototypes/cloud-capability-lease-broker-spike/` on 2026-06-05.

- Worker: `https://pi-cloud-capability-lease-broker-spike.joelhooks.workers.dev`
- run: `run-cloud-capability-lease-4dac021e-eecfdfb5`
- Artifacts repo: `piclb-run-cloud-capability-lease-4dac021e-eecfdfb5`
- sandbox receipt commit: `b2efdd6eebb2536114e7cf98d1659d039e6932bf`
- cleanup: `destroy:cap-run-cloud-capability-lease-4dac021e-eecfdfb5:ok`
- cloud-created PR: https://github.com/joelhooks/pi-cloudflare-sandbox-workflows/pull/9
- PR actor/readback: `shitratgit[bot]`
- PR branch: `cloud-capability-lease-eecfdfb5`
- PR commit: `2a8e7d648e4e77e467efef09e6e67246e2fb08c0`
- payload hash: `3be8433a5f04dc173dee3d0c27e91b39a0ca4325f77eef52959e01a3f403813a`
- PR body hash: `5ecbfe0ecd24c2f4747322bc5bdc1f2ebd6984d3cfcc4f13a6033f5f35cd0916`
- denied probes: `capability_denied`, `missing_secret_approval`, `payload_hash_mismatch`
- leak scan: passed for private-key/PAT/bearer/token-bearing-URL/Artifacts/JWT-shaped patterns

Review/verification:

```bash
pnpm check
pnpm typecheck
pnpm typecheck:tsc
coderabbit doctor
coderabbit review --agent # findings: 0
```

Macroscope is not part of the default loop after this receipt because it triggered multiple expensive invoices. Use CodeRabbit plus targeted local review unless explicitly asked.
