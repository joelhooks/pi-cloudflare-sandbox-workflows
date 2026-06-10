# Production Code

Production-intended code goes here.

Do not import from `../prototypes`. Rewrite from captured learning.

First production modules expected later:

- `app/domain/` — Zod schemas, inferred TypeScript types, artifact refs, leases, packages, lane receipts, workflow events
- `app/application/` — use cases and ports
- `app/workflow/` — deterministic safety envelope plus generated-machine adapter
- `app/control-plane/` — D1/table adapter contracts
- `app/infrastructure/` — concrete adapters and test-only memory adapters

Domain rules:

- Zod owns runtime contracts; TypeScript types are inferred from Zod.
- Generated XState machines own run-specific workflow order.
- Dynamic workflow plans own typed run data, refs, hashes, leases, and review gates.
- The fixed XState machine owns the deterministic safety envelope around generated-machine execution.
- Ports point inward; adapters implement Cloudflare, Discord, Artifacts, D1, and memory behavior outward.
- Configured familiar names belong in seed data and package metadata, not core domain concepts.
- Package is the top-level saved primitive: repo-backed, rooted at `package.json`, and pinned by manifest/hash before mount or invocation.
- Context packs, workflow packs, tool packs, support packs, adapters, and kernels are package categories.
- D1 indexes package metadata and entitlements; D1 is not the package.
- Agent lanes carry runtime evidence. `integration-test` must be marked `realAgent: false`; real Pi or future Think lanes must be marked `realAgent: true`.

Cloudflare entrypoint:

- `app/worker.ts` exports the Worker handler, Sandbox class, and capsule Durable Object class.
- `app/infrastructure/cloudflare-worker-route.ts` validates `POST /runs` requests and delegates to the front-door contract.
- `../wrangler.jsonc` is the binding source of truth; regenerate `../worker-configuration.d.ts` with `pnpm exec wrangler types` after binding changes.
