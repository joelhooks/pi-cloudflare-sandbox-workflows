# Prototypes

Every directory here is disposable.

Rules:

- A prototype answers one question.
- Its durable output is a capture in `.brain/` or `docs/`.
- It is deleted or rewritten after capture.
- Production code must not import from here.

Active:

- `sandbox-workflow-spike/` — real Cloudflare Sandbox + Artifacts bounded Pi workflow spike, with dry snapshot-resume sanity path kept for cheap checks.
- `capsule-supervisor-spike/` — Durable-Object-shaped capsule supervisor dry spike for work-item-keyed capsule state, persisted XState snapshots/events, resume, and cancel cleanup.
- `capsule-do-spike/` — real local Wrangler Durable Object spike for work-item-keyed capsule state, DO storage snapshots/events, per-request actor restore, success, and cancel cleanup.
- `integrated-capsule-run-spike/` — local Durable Object capsule orchestrates the deployed real sandbox Worker, producing one integrated capsule + real Sandbox/Artifacts/Wzrrd receipt.
- `secret-lease-broker-spike/` — secretRef → task-scoped auth materialization dry spike that records lease metadata and scans public receipts for plaintext leakage.
- `review-gate-spike/` — Wzrrd-style review gate dry spike for verifier trust statuses, required review artifacts, human approve/reject, and claim URL redaction.
- `machine-planner-spike/` — safe dynamic planner dry spike that selects known workflow patterns, validates JSON-like XState v5 machine receipts, harness plans, verification contracts, and output targets without executing generated TypeScript.
- `cloudflare-parallel-workflow-spike/` — deployed Cloudflare Worker + Durable Object + Queue + Sandbox + Artifacts spike for 8 planned lanes with cap-3 bounded hot concurrency, fan-in, synthesis, verification, output delivery, and cleanup.
- `shitrat-dream-workflow-spike/` — local artifact-only prototype for ShitRat dreams as stochastic system-graph workflows with a deterministic safety envelope. See `TODO.md` for proved vs fake vs blocked seams.
- `shitrat-brain-proposal-ui/` — SvelteKit/Vite static review app for narrowing ShitRat into a versioned plugin family and curated system brain proposal, published through wzrrd for human review.
- `system-dream-review-ui/` — SvelteKit/MDSvX Wzrrd HITL report surface for the system Dream run; seed for an installable `wzrrd.report.render` workflow node, not a bespoke page generator.
