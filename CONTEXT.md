# Context Map

This repo has one production-intended context today:

- **Workflow App**: dynamic stochastic planning with deterministic, stateful, receipt-backed execution.

Prototype directories are reference material only. Production code lives under `src/app/`.

## Domain Receipts

- JoelClaw Docs API discovery: `https://joelclaw.com/api/docs`
- JoelClaw Docs API OpenAPI: `https://joelclaw.com/api/docs/openapi.json`
- JoelClaw Docs search receipts:
  - `GET /search?q=domain%20driven%20design&semantic=false`
  - `GET /search?q=bounded%20context%20aggregate%20ubiquitous%20language&semantic=false`
  - `GET /search?q=event%20storming%20domain%20model&semantic=false`
- Local source receipts: `BRAIN.md`, `.brain/projects/pi-sandbox-workflows.svx`, `docs/shitrat-kernel-runtime-research.md`, `docs/dynamic-workflow-machine.md`, `docs/kody-secrets-pattern.md`.

## Ubiquitous Language

### Workflow App

The application that accepts a work request, discovers packs, pins payloads, asks a stochastic planner for a dynamic workflow blueprint, pins the generated XState machine and plan, drives the generated machine through the pinned steps, leases capabilities, records receipts, and produces a review summary.

Do not name the production app after launch-phase planning labels.

### Configured Familiar

The identity/personality configured by operator data and packs. “ShitRat” is one configured familiar, not a core domain type.

Core domain code should model actors, packs, plans, capabilities, leases, receipts, and reviews. Familiar names belong in seed data, pack metadata, fixtures, or operator configuration.

### Pack

A versioned context package used by the workflow app. The pack’s source of truth is an immutable Cloudflare Artifacts ref plus manifest/hash verification.

D1 indexes pack metadata and entitlements. D1 is not the pack.

### Pack Metadata

Discoverable summary data: pack id, title, description, kind, owner, latest version, latest Artifact ref, and trust tier.

Metadata discovery happens before full mount. It should be safe to show to an entitled actor.

### Pinned Pack

A pack selected for a run by immutable Artifact ref. A pinned pack carries the selected version, manifest hash, file hashes, and pinned timestamp.

Execution reads pinned pack refs. It must not float to latest during a run.

### Plan Proposal

Stochastic operator/agent intent before execution. It can contain exploratory notes and requested packs.

The proposal is not executable truth.

### Dynamic Workflow Blueprint

The stochastic planner output before artifact pinning.

It contains a generated XState workflow machine plus the dynamic plan data that binds steps, packs, payload refs, capability leases, review gates, and safety policy.

### Generated XState Workflow Machine

The pinned run-specific workflow machine generated or selected by a planner.

The planner can be stochastic. Execution is bounded by the pinned machine Artifact refs and hashes. The app pins both `workflows/machine.config.json` and generated `workflows/machine.ts` before execution.

The generated machine owns run-specific order. Each executable state carries `meta.stepId`; the app executes that step and sends `STEP_DONE` or `STEP_BLOCKED` back to the generated actor.

### Dynamic Workflow Plan

The pinned run data bound to the generated XState machine.

Dynamic plan steps describe run-specific work such as `research.review`, `capability.discord.message`, and `review.summary`. The plan does not own order once the generated machine exists; it owns typed step data, refs, hashes, leases, and review gates.

### Safety Envelope

The deterministic supervisor lifecycle around dynamic machine execution.

The safety envelope is not the workflow shape. It enforces capsule resolution, pack pinning, generated machine pinning/hash checks, dynamic plan pinning/hash checks, capability lease boundaries, receipt recording, review summary capture, and blocked/captured terminal states.

### Plan Artifact

The deterministic plan document committed before execution. Execution reads this pinned Artifact ref and hash.

The plan artifact may include refs and hashes for payloads. It should not duplicate payload bodies that belong in capability-specific payload artifacts.

### Context Capsule

The durable actor keyed by external work item/thread. It survives sandboxes and owns run history, event receipts, pinned pack refs, review state, and active run metadata.

### Capability

A named side-effect operation, for example `discord.message.send`.

Capabilities are not broad credentials or tool access.

### Capability Lease

Permission to perform one exact capability operation against one exact resource and payload hash before expiry, with actor, role context, review gate, secret ref, and receipt sink bound into the request.

Dry-run still uses the lease path. Dry-run changes review/secret requirements; it does not bypass capability leasing.

### Secret Ref

A reference to secret authority held by a trusted adapter. The domain carries refs, never raw secret material.

### Receipt

A redacted proof that a workflow step or capability operation happened. Receipts include refs, hashes, state, and outcome metadata. They do not include raw secrets, private transcripts, token-bearing URLs, or unnecessary payload bodies.

### Review Gate

The decision boundary for side effects. Discord dry-run can be explicitly exempt. Real Discord send requires an approval ref and reviewer actor id.

## Bounded Contexts In Code

```txt
src/app/domain          Zod schemas, inferred TypeScript types, canonical hashing
src/app/application     use cases and ports
src/app/workflow        safety envelope plus generated-machine adapter
src/app/control-plane   D1/table adapter contracts
src/app/infrastructure  concrete adapters and integration-test fakes
```

Rules:

- Zod schemas own runtime data contracts.
- TypeScript domain types are inferred from Zod, not written in parallel.
- Generated XState machines own run-specific workflow order.
- Dynamic workflow plans own typed run data, refs, hashes, leases, and review gates.
- The fixed XState machine owns the deterministic safety envelope around generated-machine execution.
- Ports point inward; adapters implement Cloudflare, Discord, Artifacts, D1, and memory behavior outward.
- Configured names and operator-specific data stay outside the core domain.
