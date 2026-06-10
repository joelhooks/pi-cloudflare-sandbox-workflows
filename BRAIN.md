# Pi Sandbox Workflows Brain

Project memory lives in `.brain/`.

Start here:

- `.brain/projects/pi-sandbox-workflows.svx` — canonical architecture and decisions
- `docs/dream-report-canon.md` — canonical Dreaming HITL report style: dreams first, Three-R cards, proof below
- `docs/source-map.md` — source receipts and local copied references
- `docs/tooling-baseline.md` — pnpm, tsgo, Total TypeScript, Ultracite/Ox, Turborepo, Lefthook receipts
- `docs/production-vs-prototypes.md` — boundary between durable code and throwaway spikes
- `PROTOTYPES.md` — deletion-first prototype contract

Rule: prototype code is disposable. Capture learning into `.brain/` and `docs/`, then delete or absorb the prototype.

Tooling stance: pnpm workspace, light Turborepo, Matt Pocock tsconfig base plus stricter local flags, TS7/tsgo fast typecheck, direct oxlint/oxfmt with cloned Ultracite Oxlint rules in `.oxlintrc.json`, `oxlint-tsgolint` type-aware extension enabled for `src`/`tests` through `.oxlintrc.type-aware.json`, local override disabling `typescript/promise-function-async` to avoid fighting `require-await`, Lefthook pre-commit format + full lint + full typecheck.
