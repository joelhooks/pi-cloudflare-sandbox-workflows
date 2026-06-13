# Phase 1b: Lifecycle-faithful fakes + chaos-resume suite

## Why (context you must internalize before coding)

This repo is a durable dynamic-workflow engine on Cloudflare (Workers, Durable Objects, D1, Sandbox, per-run git-backed Artifacts repos). Live runs 8–17 produced six durable-execution failure classes, and the last three (15/16/17) were ONE class: re-drive is not a pure resume. Every one of those wounds shipped **through a green test suite** because the test fakes are too kind: they hold state in one long-lived in-memory instance, so they cannot represent what production does — Durable Object eviction, alarm refire, a fresh instance reattaching to the same DO storage, and a fresh per-drive `GitMemoryFS` worktree that must clone the artifact remote rather than starting empty (run 17's wound, now fixed in `src/app/infrastructure/cloudflare-artifacts-store.ts` via `seedFromRemote`; see `.brain/resources/dream-pilot-progress-2026-06-11.svx`).

Your job: make the test harness lifecycle-faithful so this class of bug cannot ship green again. This suite becomes the merge gate for all future carrier changes.

## What to build

### 1. Lifecycle-faithful fakes

- **Shared fake remote**: a fake artifacts "remote" holding per-run repo state that survives across simulated drives (mirroring the real per-run git remote). Each simulated drive gets a **fresh** store/`GitMemoryFS` worktree that must seed from the remote — never a shared worktree. Model the run-17 edge: reattach to an existing remote must clone; brand-new remote inits empty.
- **Fake DO harness**: simulates the Durable Object lifecycle around `CloudflareWorkflowCapsuleSupervisor` (`src/app/infrastructure/cloudflare-capsule-supervisor.ts`, `alarm()` ~:555): eviction (instance discarded, in-memory state lost), alarm refire (new `alarm()` invocation on a fresh instance), **fresh instance over the same persistent DO storage**. DO storage contents survive eviction; instance fields do not.
- Reuse/extend the existing fakes in `tests/` where possible rather than inventing a parallel universe; the goal is that existing integration tests can opt into lifecycle-faithful mode.

### 2. Chaos-resume suite

For the "dream" workflow shape (the default end-to-end shape exercised in the existing integration tests):

- Kill (simulate eviction) at **every phase boundary**: after submit/admission, after plan pinned, after each agent lane completes, after verification, before capture finalize. After each kill: re-drive (fresh instance, same DO storage, same fake remote).
- Assert after every kill+re-drive:
  - run eventually reaches terminal `captured`;
  - planner executed **exactly once** across all drives (one-shot by design — re-drive must never re-invoke it);
  - each agent lane admitted/executed exactly once;
  - no duplicate side-effect receipts (capture receipts, lease issuance, capsule events that matter);
  - no stale drive stomps a newer status (once write fencing exists).
- Tests that **require Phase 1a's drive ledger / write fencing** (being built in parallel on another branch — re-drive phase skipping, stale-generation rejection): still write them, but mark them `test.fails` (vitest) with a comment `// flips when phase1a drive ledger merges`, so the suite is green now and flips red→green visibility when 1a lands. Tests that only need the already-landed run-17/18 fixes (clone-on-reattach, non-terminal re-arm, verification-phase idempotency) must pass for real NOW.

## Acceptance (all must pass)

1. `pnpm verify` green (lint + typecheck + full test suite; lefthook gates commits with oxfmt/oxlint/tsgo over all files).
2. Chaos-resume suite runs in `pnpm test:integration`; deterministic (no real network, no real timers leaking).
3. At least one test reproduces the run-17 wound shape (re-drive reads through a fresh worktree against an existing remote) and passes against the landed fix — i.e. it would have caught run 17.
4. No regression in existing 339 tests.

## Constraints

- Branch: you are on `phase1b-chaos-harness` in this worktree. Commit here. Do NOT push, do NOT touch other worktrees or the main checkout.
- Do NOT implement the drive ledger or write fencing in production code — that is Phase 1a, running in parallel elsewhere. Production-code changes here must be limited to minimal test seams (e.g. injectable storage/clock) and must not change runtime behavior.
- Do NOT touch: memory-fabric seed nodes, the capability lease broker's wzrrd path, deploy scripts.
- TypeScript: match existing idioms; the repo uses oxlint + tsgo; vitest for tests.
