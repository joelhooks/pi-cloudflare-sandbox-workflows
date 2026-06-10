# Tooling Baseline

This repo starts strict because retrofitting strictness later is dumb tax.

## Decisions

- Package manager: `pnpm`
- Workspace runner: Turborepo, installed lightly up front
- TypeScript config: `@total-typescript/tsconfig/tsc/no-dom/app`
- Type checker: `tsgo` from `@typescript/native-preview`
- Compatibility checker: classic `tsc` via `pnpm typecheck:tsc`
- Lint/format: direct `oxlint` + `oxfmt`; `.oxlintrc.json` contains cloned Ultracite core and Vitest Oxlint rules
- Type-aware lint: `.oxlintrc.type-aware.json` extends the cloned rule policy and enables `oxlint-tsgolint` for `src`/`tests`
- Local Oxlint override: `typescript/promise-function-async` is disabled because it fights `require-await` on contextually typed port methods that honestly return existing promises.
- Git hooks: Lefthook pre-commit formats staged files, then runs full lint and full typecheck

## Receipts

- Matt Pocock's TSConfig cheat sheet recommends base options plus `strict`, `noUncheckedIndexedAccess`, and `noImplicitOverride`, and packages them as `@total-typescript/tsconfig`. Source: `https://www.totaltypescript.com/tsconfig-cheat-sheet`
- `@total-typescript/tsconfig` exports `./tsc/no-dom/app`, which this repo extends. Source: `https://github.com/total-typescript/tsconfig/blob/main/package.json`
- TypeScript 7 beta / native preview is installed through `@typescript/native-preview` and exposes `tsgo` as a faster `tsc`-compatible executable. Source: `https://devblogs.microsoft.com/typescript/announcing-typescript-7-0-beta/`
- Ultracite v7 ships reusable Oxlint/Oxfmt rule packs; this repo clones the Oxlint core and Vitest rule policy into `.oxlintrc.json` and keeps `oxfmt.config.ts` on Ultracite's formatter config. Source: `node_modules/ultracite/config/oxlint/core/index.mjs` and `node_modules/ultracite/config/oxlint/vitest/index.mjs`.
- Oxlint supports JSON/JSONC configuration, and its config schema exposes `options.typeAware` and `options.typeCheck` fields. Source: `node_modules/oxlint/configuration_schema.json`.
- `oxlint-tsgolint` is Oxlint's type-aware TypeScript backend, powered by `typescript-go`; `pnpm check` uses `.oxlintrc.type-aware.json` for `src`/`tests` while `pnpm typecheck` keeps the dedicated TS7/tsgo compiler pass. Source: `node_modules/oxlint-tsgolint/README.md`.
- Ultracite Ox core enables both `require-await` and `typescript/promise-function-async`; the local config keeps `require-await` and disables `promise-function-async` to avoid autofix churn on promise-returning adapters. Source: `node_modules/ultracite/config/oxlint/core/index.mjs`.
- Lefthook supports `{staged_files}` and `stage_fixed: true` so pre-commit formatting can re-stage fixed files. Source: `https://evilmartians.com/chronicles/5-cool-and-surprising-ways-to-configure-lefthook-for-automation-joy`
- pnpm v11 build-script approval is pinned in `pnpm-workspace.yaml` with `allowBuilds` for `esbuild` and `lefthook`, avoiding install-time security prompts. Source: `https://pnpm.io/cli/approve-builds`

## Commands

```bash
pnpm install
pnpm check
pnpm fix
pnpm typecheck
pnpm typecheck:tsc
pnpm verify:workspace
pnpm exec lefthook run pre-commit
```

## Tradeoff

Turborepo is worth adding now because we already know this will split into worker/control-plane/context-pack/prototype surfaces. Keep it boring: one root package, one workspace file, one `turbo.json`. Do not create packages until there is a real seam.
