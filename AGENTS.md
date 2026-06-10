# Agent Notes

This repo is explicitly prototype-to-production. Keep the boundary sharp.

## Read first

- `VISION.md` for project intent and decision boundaries; do not treat it as an ops runbook.
- `BRAIN.md`
- `.brain/projects/pi-sandbox-workflows.svx`
- `docs/production-vs-prototypes.md`
- `PROTOTYPES.md`
- `docs/source-map.md`

## Tooling law

- Use `pnpm`, not npm/yarn/bun, for this repo.
- When adding dependencies, use `pnpm add` / `pnpm add -D` instead of hand-editing guessed package versions.
- Use `pnpm typecheck` for fast TS7/tsgo checks.
- Use `pnpm typecheck:tsc` when verifying compatibility with classic TypeScript tooling.
- Use `pnpm check` / `pnpm fix` for direct `oxlint` + `oxfmt`; `.oxlintrc.json` contains the cloned Ultracite rule policy and `.oxlintrc.type-aware.json` enables the `oxlint-tsgolint` extension for production TypeScript surfaces.
- Lefthook runs on pre-commit: format staged files, full lint, full typecheck.
- Turborepo is present as a light workspace spine; do not turn it into ceremony until packages/apps actually exist.

## Prototype law

- Put throwaway code only under `prototypes/<name>/`.
- Every prototype needs a README with:
  - question answered
  - run command
  - deletion trigger
  - capture target
- Do not import prototype code from `src/`.
- Do not move prototype code into `src/` directly. Rewrite the production version after capturing the learning.
- At closeout, capture learning into `.brain/` or `docs/`, then delete or explicitly mark what remains.

## Production law

- `src/` is production-intended code only.
- Lifecycle code should use explicit state machines, not boolean soup.
- Secrets are references and leases, not strings passed through prompts.
- Context packs are selected/pinned by the supervisor/control plane, not discovered by dumping everything into a sandbox.

## Current spine

The first dogfood target is `research-claude-workflows`: a wide-but-capped fan-out research workflow that produces a source-backed report, reusable context pack, and Wzrrd review page.
