# Prototype: workflow-observability-spine-spike

Status: active

## Question

Can a real deployed Cloudflare workflow generate and execute its own TypeScript harness to build an observability feature, split code work across isolated sandbox lanes, emit a durable observability pack about itself, and deliver the generated prototype-only changes as a GitHub PR via ShitRat credentials?

This is intentionally **not** a static replay, local simulation, or hand-authored event fixture. The generated harness must actually run.

## Run

```bash
pnpm prototype:observability:deploy
pnpm prototype:observability:real
```

The real runner:

1. calls the deployed Worker
2. waits for the Durable Object/Queue/Sandbox/Artifacts run to capture
3. reads the final receipt
4. leases ShitRat GitHub App credentials locally
5. creates a branch + PR from the generated files

## Success signal

`pnpm prototype:observability:real` writes ignored local receipts:

```txt
prototypes/workflow-observability-spine-spike/out/latest-status.json
prototypes/workflow-observability-spine-spike/out/latest-receipt.json
prototypes/workflow-observability-spine-spike/out/latest-pr.json
```

The final receipt must show:

- generated plan/machine/harness artifacts were pinned
- `workflows/harness.ts` executed in the supervisor sandbox
- at least 5 isolated code lanes ran in real Cloudflare Sandboxes
- each lane produced generated prototype files and Artifacts receipts
- the finalizer wrote `run/events.jsonl`, `run/status.json`, metrics/cost/trace summaries, redaction policy, and agent summary
- debugger/verifier produced `artifacts/debugger/run-diagnosis.md` and `next-safe-action.json`
- the local ShitRat capability adapter opened a GitHub PR with generated prototype-only files

## Cloudflare primitives used

- Worker HTTP API and Queue consumer
- Durable Object capsule supervisor
- Cloudflare Queue for supervisor/lane/finalizer work
- Cloudflare Sandbox for generated harness, isolated code lanes, and finalizer/debugger
- Cloudflare Artifacts for plan, generated harness, lane outputs, observability pack, and final receipt

## Capture target

- `.brain/resources/workflow-observability-spine.svx`
- generated Brain page: `.brain/resources/workflow-observability-event-schema.svx`

## Delete/absorb rule

Delete or rewrite after the generated workflow execution + observability pack + PR output target shape is captured. Absorb only the winning port names, event schema, adapter boundaries, generated-harness execution contract, lane isolation contract, and verifier/debugger receipt shape into production `src/` later.

## Proven run receipt — 2026-06-05

Real deployed run succeeded:

- run: `run-workflow-observability-spine-86638042`
- Worker: `https://pi-workflow-observability-spine-spike.joelhooks.workers.dev`
- Artifacts repo: `piwfo-run-workflow-observability-spine-86638042`
- output target: `github_pr`
- GitHub PR: https://github.com/joelhooks/pi-cloudflare-sandbox-workflows/pull/1
- PR actor: `shitratgit[bot]`
- PR branch: `workflow-observability-spine-86638042`
- verifier status: `verified`
- total planned lanes: `5`
- max observed active lanes: `2`
- generated files in PR: `10`

Acceptance evidence from `prototypes/workflow-observability-spine-spike/out/latest-receipt.json`:

- `generated-harness-executed`: passed
- `isolated-lanes-generated-files`: passed
- `debugger-can-explain-run`: passed
- observability pack refs: `run/events.jsonl`, `run/status.json`, `run/metrics-summary.json`, `run/cost-summary.json`, `run/trace-summary.json`, `run/redaction-policy.json`, `run/agent-observability-summary.md`

Verification receipts:

```bash
pnpm check
pnpm typecheck
pnpm typecheck:tsc
pnpm verify:workspace
```

PR/readback checks performed after the run:

- GitHub API readback returned PR `#1` open on `main` from `workflow-observability-spine-86638042`.
- PR author readback: `shitratgit[bot]`.
- PR body includes `Run receipt`, `Generated files`, `Observability pack`, and `Debugger diagnosis` sections.
- PR diff is prototype/Brain scoped and contains no `BRAVE_SEARCH_API_KEY`, `ACCESS_TOKEN`, `PI_AUTH_JSON_B64`, `art_v1_`, `shitrat_github_private_key`, or private-key block text.

Runtime diagnosis learned during dogfood:

- `isomorphic-git.push()` needs `url`, not `remote`; the wrong option caused Worker 1101 on first start.
- Generated `tsx` harnesses should avoid top-level await unless the sandbox module mode is explicit; wrapping in `async main()` avoided the CJS transform trap.
- Generated shell/Node heredocs should use `String.raw` or `String.fromCharCode(10)` for embedded newlines; otherwise template rendering can turn `\n` into syntax-breaking literal newlines.
- Queue failures must update capsule state to `blocked`; silent queue retry loops make observability lie.
- Lane retry state must re-enqueue the lane message; `retry_queued` without a queue send is boolean-soup cosplay wearing a state-machine hat.
