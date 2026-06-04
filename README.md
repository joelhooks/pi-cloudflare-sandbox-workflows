# Pi Cloudflare Sandbox Workflows

Contextual Pi runs in Cloudflare Sandboxes.

This repo is the next spine after the browser-terminal proof in `../pi-cloudflare-sandbox`. The target is not a persistent web terminal. The target is **ephemeral, contextual, bounded Pi execution** with context capsules, task-specific context packs, secret leases, Artifacts-backed outputs, and Wzrrd review pages.

## Non-negotiable split

```txt
src/          production-intended code only
prototypes/   throwaway experiments only
docs/         durable design docs and source maps
.brain/       canonical project memory and decisions
sources/      copied/source-backed reference material
```

Prototype code must either be deleted or rewritten into `src/`. Do not gradually polish a prototype until it becomes production by mold growth.

Read first:

1. `BRAIN.md`
2. `.brain/projects/pi-sandbox-workflows.svx`
3. `docs/production-vs-prototypes.md`
4. `PROTOTYPES.md`
5. `docs/source-map.md`
6. `docs/dynamic-workflow-machine.md`
7. `docs/tooling-baseline.md`

## First spike

```bash
pnpm install
pnpm prototype:spike:auth:put
export ACCESS_TOKEN="$(openssl rand -hex 32)"
pnpm prototype:spike:access:put # auto-leases Cloudflare credentials from agent-secrets if env vars are absent
pnpm prototype:spike:deploy
curl -X POST https://pi-sandbox-workflow-spike.joelhooks.workers.dev/api/real-run \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"task":"Produce the research-claude-workflows spike report"}'
pnpm verify
```

The active sandbox spike uses real Cloudflare Sandbox, Artifacts, Wzrrd, XState v5, Zod v4, isomorphic-git, and just-bash substrate. `/api/real-run` commits plan-phase artifacts before sandbox creation, then runs a fixed reader → verifier pipeline in the sandbox, commits separate lane outputs, returns the Artifacts repo/commits, publishes a live Wzrrd review URL, and returns an anonymous Wzrrd `claimUrl` when no Wzrrd auth token is configured. `pnpm prototype:spike` starts local Wrangler dev, but remote deployment is the cleaner real receipt because it uses Worker secrets without writing `.dev.vars`. `pnpm prototype:spike:dry` uses just-bash plus the XState machine as a cheap state/data simulation receipt, not the product proof.

The capsule supervisor spikes are the control-plane proof. `pnpm prototype:capsule:dry` proves the model cheaply in memory. `pnpm prototype:capsule-do:local` proves the same shape with a real local Wrangler Durable Object: work-item-keyed routing, DO storage for snapshots/events/capsule record, per-request actor restore, disposable sandbox handles, resume shape, and cancellation cleanup.

The secret lease broker spike covers the auth boundary. `pnpm prototype:secrets:dry` proves a broker can accept `secretRef`, mint a task-scoped `/workspace/.pi/agent/auth.json` lease receipt, keep plaintext out of public Artifacts/Wzrrd/event payloads, and return an explicit missing-approval blocker.

The review gate spike covers the trust boundary. `pnpm prototype:review:dry` proves verifier statuses route to accepted/warnings/blocked/pending states, review payloads include required artifact refs, human approve/reject decisions work, and Wzrrd claim URLs stay private.

The integrated capsule run spike bridges the real pieces. `pnpm prototype:integrated:real` runs a local Durable Object capsule that calls the deployed real sandbox Worker and captures one integrated capsule + real Sandbox/Artifacts/Wzrrd receipt. This proves the end-to-end request shape before rewriting the production Worker to own DO + Sandbox/Artifacts bindings together.

The machine planner spike covers dynamic planning without eval hell. `pnpm prototype:planner:dry` selects from a known pattern library and validates JSON-like XState v5 machine receipts, harness plans, verification contracts, and output targets for Wzrrd review, GitHub PR, and artifact-only jobs. It rejects arbitrary generated machine code before planning.

## Tooling baseline

- Package manager: `pnpm`
- Workspace/task runner: Turborepo, lightly installed up front so `apps/*`, `packages/*`, and `prototypes/*` can grow without repo surgery
- TypeScript: Matt Pocock's `@total-typescript/tsconfig` extended with stricter local flags
- Type checker: `tsgo` from `@typescript/native-preview` for the fast path, plus `pnpm typecheck:tsc` as compatibility fallback
- Lint/format: Ultracite with `oxlint` + `oxfmt`
- Git hooks: Lefthook formats staged files, then runs full lint and full typecheck before commit

## Production direction

Production code eventually owns:

- capsule identity and lifecycle
- context-pack resolution
- Artifacts repo/ref bindings
- run queue and concurrency leases
- sandbox role orchestration
- secret reference to task-scoped `auth.json` minting
- event logs and Wzrrd publication metadata

Anything else belongs in `prototypes/` until proven.
