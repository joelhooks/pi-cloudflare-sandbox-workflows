# Dynamic Workflow Machine Prototype

This document captures the current answer from `prototypes/sandbox-workflow-spike/`.

## Short version

The next production spine is not one fixed workflow. It is a supervisor-shaped system that can generate or select an **XState v5 workflow machine** for the job, pin that plan before sandbox creation, then execute trusted lanes against the pinned plan.

The prototype proves this with a constrained `reader -> verifier` pattern. The final delivery step should be modeled as an instruction-selected **output target**. Wzrrd is a good review/output target, not a hardcoded core subsystem; another run might deliver a GitHub PR, issue comment, Linear update, artifact-only capture, or email draft.

## Receipts

Real run:

- run id: `run-mpyzrsfj-48078d74`
- Artifacts repo: `piwf-run-mpyzrsfj-48078d74`
- plan commit: `c91139e1213b7f7834d112b45a49b6e6ad45fe08`
- reader commit: `6a0a2784358aab89677512cc566aaca2470bf9b8`
- verifier commit: `2b97b2f277909b9b8be10b471752e6add5e7e78e`
- capture status: `verified`
- destroy receipt: `destroy:run-mpyzrsfj-48078d74:ok`
- Wzrrd review: `https://piwf-run-mpyzrsfj-48078d74.wzrrd.sh/`

Verification files served from Wzrrd:

- `/run/plan.json` returned `schemaVersion: plan.v1`, `pattern: reader-verifier`, `executor: fixed-prototype-reader-verifier`, and `generatedMachineRuntime: receipt-only`.
- `/artifacts/verification/result.json` returned `status: verified`, two checks, no warnings, and no blocking failures.

Dry snapshot-resume run:

- command: `pnpm prototype:spike:dry`
- receipt: `prototypes/sandbox-workflow-spike/out/latest-resume-receipt.json` ignored by git
- persisted with `actor.getPersistedSnapshot()` at state `committingReaderOutputs`
- restored with `createActor(machine, { snapshot })` at state `committingReaderOutputs`
- continued through reader commit, verifier run, verifier commit, verification acceptance, Wzrrd publication, sandbox destruction, and final `captured`
- final actor status: `done`
- event log length: `14`
- receipt schema: `prototype-snapshot-resume-receipt.v1`

Capsule supervisor dry run:

- command: `pnpm prototype:capsule:dry`
- receipt: `prototypes/capsule-supervisor-spike/out/latest-receipt.json` ignored by git
- capsule id derives from external `workItemId`
- sandbox id is a separate disposable handle
- capsule record owns artifact repo ref, context pack refs, latest run id, persisted snapshot, event log, Wzrrd ref, and secret lease refs
- new supervisor instance restores the actor from persisted snapshot at `runningSandbox`
- success path reaches `captured`
- cancel path destroys sandbox and reaches `cancelled`
- post-cancel work event stays in `cancelled`
- receipt schema: `capsule-supervisor-receipt.v1`

Capsule Durable Object local run:

- command: `pnpm prototype:capsule-do:local`
- receipt: `prototypes/capsule-do-spike/out/latest-receipt.json` ignored by git
- local Wrangler Worker routes by external `workItemId` to a real Durable Object
- Durable Object stores persisted XState snapshot, event log, and capsule record in DO storage
- DO handler restores actor from storage on each state transition request rather than relying on an in-memory actor field
- success path reaches `captured`
- cancel path destroys sandbox and post-cancel work event stays `cancelled`
- receipt schema: `capsule-do-receipt.v1`

Secret lease broker dry run:

- command: `pnpm prototype:secrets:dry`
- receipt: `prototypes/secret-lease-broker-spike/out/latest-receipt.json` ignored by git
- request carries `secretRefs`, not plaintext values
- broker mints a run-scoped lease for `/workspace/.pi/agent/auth.json`
- lease exposes `contentSha256`, expiry, purpose, materialized path, and lease ref, not auth JSON
- Artifacts manifest, Wzrrd payload, and event log contain lease metadata only
- unapproved secret returns `missing_secret_approval` with approval URL
- receipt schema: `secret-lease-broker-receipt.v1`

Integrated capsule run:

- command: `pnpm prototype:integrated:real`
- receipt: `prototypes/integrated-capsule-run-spike/out/latest-receipt.json` ignored by git
- local Durable Object capsule routes by external `workItemId`
- capsule persists supervisor state and event log while calling the deployed real sandbox Worker
- real Sandbox/Artifacts/Wzrrd receipts are captured into the capsule record
- latest repo: `piwf-run-mpz1z9vz-29d06a92`
- latest plan commit: `5177b6b834a0b8580bb10806c9fdc6547b8aa419`
- latest reader commit: `a8fd1cf660e2e165a6255e78ed876b76ed8a5aab`
- latest verifier commit: `daf3e3d97ee24ac28b5ff3314cf7b5589cfa3bef`
- latest lease ref: `lease:piCodexAuth:run-mpz1z9vz-29d06a92:task-scoped-auth-json`
- latest Wzrrd URL: `https://piwf-run-mpz1z9vz-29d06a92.wzrrd.sh/`, HTTP `200` verified
- final state: `captured`; real run state: `captured`; verification: `verified`
- receipt schema: `integrated-capsule-run-receipt.v1`
- limitation: bridge prototype calls the deployed sandbox Worker over HTTP; next production rewrite should combine DO + Sandbox/Artifacts bindings in one Worker module
- output-target correction: current prototype state names say Wzrrd in places; production language should use `outputTarget` / `deliverOutput`, with Wzrrd as one configured target.

Machine planner dry run:

- command: `pnpm prototype:planner:dry`
- receipt: `prototypes/machine-planner-spike/out/latest-receipt.json` ignored by git
- planner selects from a known pattern library instead of inventing arbitrary machines
- fixtures planned successfully:
  - `thread-report-123` -> `reader_verifier` + `wzrrd_review`
  - `issue-gh-pr-456` -> `edit_verify_pr` + `github_pr`
  - `internal-analysis-789` -> `artifact_only_capture` + `artifact_only`
- every plan emits a JSON/config-like XState v5 machine receipt with generic `deliveringOutput`, `destroyingSandbox`, `captured`, `blocked`, and `cancelled` lifecycle states
- GitHub PR plan has no Wzrrd-specific state names and carries GitHub App / broker / ShitRat actor policy instead of raw PAT handling
- Wzrrd target is represented as an output target with SvelteKit static HTML build + Wzrrd publish delivery steps, not a core lifecycle primitive
- artifact-only target has no external publish step
- unsafe arbitrary machine-code fixture with `requestedMachineCode` / `machineTs` is rejected before planning
- receipt schema: `machine-planner-receipt.v1`
- runtime stance: generated machine config is receipt-only; no arbitrary generated TypeScript is executed

Cloudflare parallel workflow real run:

- command: `pnpm prototype:parallel:real`
- receipt: `prototypes/cloudflare-parallel-workflow-spike/out/latest-receipt.json` ignored by git
- deployed Worker: `https://pi-cloudflare-parallel-workflow-spike.joelhooks.workers.dev`
- run id: `run-parallel-cloudflare-patterns-3e945e7e-887dd5a9`
- capsule: `capsule:parallel-cloudflare-patterns-3e945e7e`
- Artifacts repo: `piwfp-run-parallel-cloudflare-patterns-3e945e7e-887dd5a9`
- plan commit: `4e8ec58ee343e6f3fa6adf190e02607c28a0706c`
- synthesis commit: `03c30e7a847e33f23790aeea8b5464782cbf8727`
- lane count: `8`; concurrency cap: `3`; max observed active lanes: `3`
- all 8 lane receipts include real Cloudflare Sandbox IDs and Artifacts commit SHAs
- verifier result: `verified`, no warnings, no blocking failures
- output target: generic `implementation_plan`, not Wzrrd-specific lifecycle language
- final state: `captured`
- cleanup receipts: all lane, synthesis, verifier, and delivery sandboxes destroyed with `:ok`
- receipt schema: `cloudflare-parallel-workflow-receipt.v1`
- important runtime fix learned: Artifacts repos created in the start request expose a plain remote/token, but fetched repo fields can cross the Worker RPC boundary as promise-ish values. The prototype now keeps the initial Artifacts token in DO-private storage, never in public receipts, and uses it for queue/finalizer sandbox Git pushes.

Review gate dry run:

- command: `pnpm prototype:review:dry`
- receipt: `prototypes/review-gate-spike/out/latest-receipt.json` ignored by git
- status matrix routes `verified -> accepted`, `warnings -> accepted_with_warnings`, `blocked -> blocked`, and `needs_human_review -> pending_human_review`
- review payload includes report, source map, plan, event log, machine receipt, and verification result refs
- human approve transitions pending review to accepted
- human reject transitions pending review to rejected
- private Wzrrd claim URL is excluded from public payload and receipt
- receipt schema: `review-gate-receipt.v1`

## Lifecycle shapes

Serial reader/verifier prototype:

```txt
idle
  -> resolvingCapsule
  -> pinningContextPack
  -> committingPlan
  -> mintingAuthLease
  -> hydratingSandbox
  -> runningReader
  -> committingReaderOutputs
  -> runningVerifier
  -> committingVerifierOutputs
  -> evaluatingVerification
  -> deliveringOutput
  -> destroyingSandbox
  -> captured
```

Parallel Cloudflare prototype:

```txt
planning
  -> validatingPlan
  -> committingPlanArtifacts
  -> admittingLanes
  -> enqueueingLaneJobs
  -> runningFanoutLanes
  -> waitingFanIn
  -> synthesizingResults
  -> runningVerifier
  -> evaluatingVerification
  -> deliveringOutput
  -> destroyingSandboxes
  -> captured
```

Failure/cancel paths exist. The useful artifact is the success receipt plus the concrete substrate failures fixed along the way: sandbox ID length limits, fetched Artifacts repo RPC fields, Git prompt hangs, and commit-SHA parsing through wrapped sandbox commands.

## Plan phase

The plan phase runs in the Worker/control plane before sandbox creation.

It commits these files to Artifacts using `isomorphic-git` and an in-memory filesystem:

```txt
run/plan.json
workflows/machine.ts
workflows/harness.js
run/verification-contract.json
run/manifest.json
run/source-seed.json
run/prompt.md
context-packs/research-claude-workflows/pack.json
```

This gives the receipt chain:

```txt
intent -> plan -> machine -> sandbox work -> verification -> Wzrrd
```

If the plan is not pinned before execution, the run is not auditable enough to trust.

## Trust boundary

For this prototype:

- `workflows/machine.ts` is a source receipt only.
- The Worker executes a fixed constrained `reader -> verifier` path.
- Generated lifecycle code is not runtime-loaded into the Worker yet.

Later production can consider executing generated machines only after policy validation exists.

## Type story

The current type split is intentional:

- **XState v5** owns workflow lifecycle: states, events, snapshots, transition decisions, cleanup, and capture status.
- **Zod v4** owns artifact data contracts: plan, manifest, verification contract, verification result, and Wzrrd publish result.
- **TypeScript** glues the two together. Artifact data types should be inferred from Zod schemas rather than duplicated by hand.
- **JSON Schema** should be exported from Zod when structured-output prompts, Wzrrd docs, or external contract displays need it.

Rule:

```txt
Zod validates the data moving through the machine.
XState models the machine.
```

## Snapshot persistence

XState snapshots are the operational resume surface.

The prototype now proves the minimum resume move:

```ts
const persistedSnapshot = actor.getPersistedSnapshot();
const restoredActor = createActor(machine, { snapshot: persistedSnapshot });
restoredActor.start();
```

The persisted snapshot resumes the actor's state and context. The event log remains separate because it is the audit/replay receipt, not the operational restore mechanism.

For production, store snapshots in the control plane. Commit selected snapshot/event receipts to Artifacts only when useful for audit, review, or debugging.

## just-bash role

`just-bash` is not the real Pi runtime.

It is useful as a cheap simulation substrate because it can exercise shell-ish step plans, environment variables, files, command ordering, and failure paths without spending Cloudflare/Sandbox cycles.

Current use:

- `pnpm prototype:spike:dry`
- creates simulated plan/workflow/artifact files
- drives the XState machine to a mid-run checkpoint
- persists and restores the actor snapshot
- continues through the `reader -> verifier` lifecycle
- validates a Zod verification result and a Zod resume receipt

Real proof still runs in Cloudflare Sandbox with the Pi CLI.

## Files worth absorbing later

Absorb by rewrite, not copy-paste:

- `prototypes/sandbox-workflow-spike/src/schema.ts`
- `prototypes/sandbox-workflow-spike/src/machine.ts`
- `commitPlanPhaseArtifacts()` using `isomorphic-git`
- `buildVerificationContract()` shape
- `artifacts/verification/result.json` shape
- `run/plan.json` shape
- `reader -> verifier` lane receipt shape

Do not absorb directly:

- hard-coded research source seed
- static `PI_AUTH_JSON_B64` Worker secret path
- inline shell strings
- generated Wzrrd HTML string
- prototype route glue

## Next production questions

1. Where does the supervisor/control-plane machine live durably?
2. Which generated machine policy checks must pass before runtime execution is allowed?
3. Should warning captures produce `captured_with_warnings` as a final state or as context on `captured`?
4. How should a verifier request human review without blocking cleanup?
5. Which workflow patterns belong in the first pattern library package?
