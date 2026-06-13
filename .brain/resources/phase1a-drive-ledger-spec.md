# Phase 1a: Drive ledger in DO storage + write fencing

## Why (context you must internalize before coding)

This repo is a durable dynamic-workflow engine on Cloudflare (Workers, Durable Objects, D1, Sandbox, per-run git-backed Artifacts repos). A Pi planner lane generates an XState machine per job; the plan is pinned as `run/plan.json` in the run's artifacts repo; nodes execute with receipts; a verifier lane judges evidence.

Live runs 8–17 produced six durable-execution failure classes. Runs 15/16/17 are ONE class: **re-drive is not a pure resume from a single state authority**. Run state is scattered across D1, DO storage, the git remote, and a per-drive in-memory worktree. When a Durable Object instance is evicted and a re-drive starts on a fresh instance, the new drive can re-execute phases that already completed (planner replay → `already-completed` admission guard → spurious `adapter_unavailable` stomping good state) or two drives can interleave and the stale one stomps the newer one's status writes.

Run 17's immediate read-consistency bug (fresh empty worktree per drive, never cloned) is already fixed and live (see `.brain/resources/dream-pilot-progress-2026-06-11.svx`, runs 17–18). Your job is the **class fix**: make re-drive a pure resume.

## What to build

### 1. Drive ledger in DO storage

In `CloudflareWorkflowCapsuleSupervisor` (`src/app/infrastructure/cloudflare-capsule-supervisor.ts`, class at ~:262, `alarm()` at ~:555, run-start record + re-arm on paused ~:616, eviction watchdog ~:906):

- A per-runId ledger record in DO storage: `{ driveGeneration: number, phases: { [phaseId]: { completedAt, artifactCommitSha, receiptKind, ... } } }`.
- Every phase completion (plan pinned, agent lanes done, verification done, capture done — match the actual phase boundaries in `run()` in `src/app/workflow-app.ts`) is recorded in the ledger **including the artifact commit sha** of the pinned artifact that proves it (e.g. the commit that pinned `run/plan.json`, the lane release sha, the verification result sha).
- `run()` consults the ledger before each phase. Completed phases are **skipped**, and their outputs are reconstructed from pinned artifacts read **at the recorded commit sha** (the store already supports `readTextAtCommit` / `readJson({ artifactCommitSha, ... })` — see `src/app/infrastructure/cloudflare-artifacts-store.ts`). The existing best-effort reload helpers (`loadExistingPinnedPlan` ~:3461, `loadExistingVerificationResult` in `workflow-app.ts`) become ledger-driven: ledger says done → read at sha (loud failure if unreadable); ledger silent → run the phase.
- DO storage is the single state authority for "what has this run completed". D1 remains a projection; git remains the artifact store. Do not add a third authority.

### 2. Write fencing (drive generations)

- A drive obtains its generation at drive admission (increment + persist atomically in DO storage when a drive starts).
- All run status writes and terminal-state writes carry the drive's generation.
- A write whose generation is stale (a newer drive has been admitted) is rejected with a **typed error**; the stale drive aborts quietly. It must NOT stomp status, must NOT write a blocker, must NOT touch the ledger.

## Acceptance (all must pass)

1. `pnpm verify` green (lint + typecheck + full test suite; lefthook also gates commits with oxfmt/oxlint/tsgo over all files).
2. New integration tests (follow the style of `tests/integration/*.test.ts`):
   - **Interleaved drives can't stomp**: admit drive A, admit drive B (newer), let A attempt a status/terminal write → typed stale-generation rejection; final status reflects B only.
   - **Re-drive skips each completed phase**: complete through phase N, simulate eviction (fresh app/store instance over the same DO storage + artifact remote), re-drive → phases ≤ N are not re-executed (planner not re-invoked, lanes not re-admitted), run resumes at N+1 and reaches terminal.
   - **Ledger survives DO instance swap**: write ledger, construct a fresh supervisor instance over the same storage, read ledger back intact.
3. No regression in existing 339 tests.

## Constraints

- Branch: you are on `phase1a-drive-ledger` in this worktree. Commit here. Do NOT push, do NOT touch other worktrees or the main checkout.
- Do NOT build chaos-testing fakes or a lifecycle-faithful fake harness — that is Phase 1b, running in parallel elsewhere. Use the existing test fakes; if you need a seam (e.g. constructor injection for storage), add the minimal seam.
- Do NOT touch: memory-fabric seed nodes (`workflow-node-adapter.ts` HITL paths), the capability lease broker's wzrrd path, deploy scripts.
- TypeScript: make impossible states impossible; discriminated unions over optional fields; parse, don't validate. The repo uses oxlint + tsgo; match existing idioms.
- The planner is a one-shot, never-replayed lane by design. The ledger is what makes that safe — a re-drive must never reach the planner admission path when the plan is already pinned.
