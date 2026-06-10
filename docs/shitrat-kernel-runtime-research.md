# ShitRat Kernel Runtime Research

Date: 2026-06-08
Status: research only
Boundary: no runtime implementation, no raw secrets, no raw prompts, no private transcript bodies, no Brain dumps.

This answers the runtime substrate questions for a ShitRat kernel, a default Badass Courses claw kernel, and versioned runtime packs.

## Executive Summary

The right shape is a small always-loaded kernel plus pinned, versioned packs. The kernel should define identity, adapter rules, memory policy, trust defaults, capability-lease vocabulary, and a tiny writing-style hot path. Packs should carry project, workflow, org, personal, support, research, code-stack, and communication context. Packs should be visible by title/description first, then mounted only after entitlement, trust, version pinning, and manifest verification.

Use Cloudflare Artifacts as the canonical runtime source for kernels, packs, run repos, plan artifacts, receipts, review pages, and rollback refs. GitHub should be a collaboration and mirror surface, not the canonical runtime store. This matches the proposal direction and Cloudflare Artifacts' model of isolated Git repos with repo-scoped tokens and durable state.

Workers should be the stateless front door and policy boundary. Durable Objects should own per-entity coordination: context capsules, sessions, lease brokers, pack registry actors, and review gates. Workflows should handle long-running durable sequences after a plan is pinned. Sandboxes and Containers should execute heavyweight CLI/filesystem work, then commit outputs back to Artifacts/R2/D1 before teardown. D1 should index global queryable state. R2 should hold large blobs. DO SQLite should hold hot actor state and locks.

Do not put secret material in prompts, sandboxes, workflow metadata, D1 rows, R2 logs, or pack manifests. Copy Kody's metadata-only secret discovery and host-resolved placeholders, Crabfleet's Worker-owned credential mediation, Crabbox's broker-owned lease lifecycle, and the local capability-lease proof's payload-bound operation envelope.

The clean capability model is a lease for one exact operation, not a token lease. The lease binds actor, auth session, role/entitlement, capability, resource, payload hash, expiry, optional review approval, rollback ref, policy version, and receipt sink. Secret refs remain references; the trusted Worker/DO boundary executes the secret-bearing operation or mints a derived, task-scoped credential only when unavoidable.

Better Auth is a plausible auth spine, but not the policy engine. Use its organization plugin for humans, orgs, teams, invitations, and roles; device authorization for CLI/Pi/local harness login; org-owned API keys for service-account bootstrap; and consider Agent Auth only as an external agent discovery/grant bridge. The ShitRat runtime still needs its own D1/DO entitlement tables and capability-lease policy evaluator.

Use static registered Workflows first. Dynamic Workers, Dynamic Workflows, and Durable Object Facets are promising for later package-owned services, tenant-defined harnesses, retrievers, and validators, but they are too new and too privileged to be the first production core. Prototype them behind hard isolation, no secrets in metadata, and no direct supervisor DB access.

The first production dogfood target should be one low-risk research workflow pack: pack registry read, version pin, plan-pin-before-run, sandbox execution, Wzrrd/GitHub review output, and redacted receipts. Do not start with deploy/apply/write capabilities.

## Source Receipts

### Local Project Receipts

| Source                                                                                                                            | Receipt                                                     | Takeaway                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`VISION.md`](../VISION.md)                                                                                                       | Read local file.                                            | The project boundary is public agent-workflow infrastructure: source receipts, schema contracts, capability leases, review gates, rollback, and no raw token handoff. |
| [`BRAIN.md`](../BRAIN.md)                                                                                                         | Read local file.                                            | Durable decisions belong in `.brain/`; docs and source maps are the receipt trail.                                                                                    |
| [`.brain/projects/pi-sandbox-workflows.svx`](../.brain/projects/pi-sandbox-workflows.svx)                                         | Read local Brain summary, not copied here.                  | Accepted architecture terms: context capsule, Artifacts/D1/R2/DO split, context packs, plan-pin-before-run, bounded hot concurrency.                                  |
| [`docs/production-vs-prototypes.md`](production-vs-prototypes.md)                                                                 | Read local file.                                            | Production belongs in `src/`, prototypes stay under `prototypes/`, lifecycle code should use explicit state machines.                                                 |
| [`docs/source-map.md`](source-map.md)                                                                                             | Read local file.                                            | Existing project receipts already map Kody, Cloudflare, and local prototype references.                                                                               |
| [`docs/dynamic-workflow-machine.md`](dynamic-workflow-machine.md)                                                                 | Read local file.                                            | Generated harness and trusted lifecycle machine must stay separate; plan artifacts are pinned before sandbox creation.                                                |
| [`docs/kody-secrets-pattern.md`](kody-secrets-pattern.md)                                                                         | Read local file.                                            | Secret discovery should return metadata only; trusted gateways resolve refs into derived use at execution time.                                                       |
| [`docs/dogfood-plan.md`](dogfood-plan.md)                                                                                         | Read local file.                                            | Dogfood ladder already points at review gates, capability leases, dynamic machines, and registry/context-pack proof.                                                  |
| [`docs/shitrat-operating-graph-artifacts.md`](shitrat-operating-graph-artifacts.md)                                               | Read local file.                                            | ShitRat's operating graph should be artifact-backed: prompts, skills, scripts, memory, workflow, capabilities, and host state need explicit edges.                    |
| [`.brain/resources/decisions/cloud-capability-lease-broker.svx`](../.brain/resources/decisions/cloud-capability-lease-broker.svx) | Read local Brain decision summary, not copied here.         | Accepted model is capability leases with payload binding and redacted receipts, not raw token leases.                                                                 |
| [`prototypes/cloud-capability-lease-broker-spike/README.md`](../prototypes/cloud-capability-lease-broker-spike/README.md)         | Read prototype README and production-relevant source files. | Local proof already proves a payload-bound GitHub PR capability broker with policy denial codes and receipt sinks.                                                    |

### Public Codebase Receipts

Refs were checked with `git ls-remote` on 2026-06-08 and shallow local clones under `/tmp`.

| Source                                                                                                                                                                                  | Ref                                        | Takeaway                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`openclaw/crabfleet` README](https://github.com/openclaw/crabfleet/blob/6994827254cf115f84ce9f3648d0075a9d6df531/README.md)                                                            | `6994827254cf115f84ce9f3648d0075a9d6df531` | Mission-control pattern for agent runs: Worker/API, D1, sandbox sessions, runtime adapter descriptors, R2 archives, GitHub integration.                                     |
| [`openclaw/crabfleet` architecture](https://github.com/openclaw/crabfleet/blob/6994827254cf115f84ce9f3648d0075a9d6df531/docs/architecture.md)                                           | Same ref.                                  | Worker/DO keeps model and GitHub credentials; sandbox env gets placeholders; approved upstream requests receive mediated credentials.                                       |
| [`openclaw/crabfleet` spec](https://github.com/openclaw/crabfleet/blob/6994827254cf115f84ce9f3648d0075a9d6df531/docs/spec.md)                                                           | Same ref.                                  | Card/run state, terminal replay, diffs, session control, runtime caps, allowlists, read-only shares, and optional repo instructions.                                        |
| [`openclaw/crabfleet` fleet state](https://github.com/openclaw/crabfleet/blob/6994827254cf115f84ce9f3648d0075a9d6df531/src/fleet-state.ts)                                              | Same ref.                                  | Session summaries include runtime type, status, policy summary, parent/root session IDs, and credential source metadata.                                                    |
| [`openclaw/crabfleet` sandbox security](https://github.com/openclaw/crabfleet/blob/6994827254cf115f84ce9f3648d0075a9d6df531/src/sandbox-security.ts)                                    | Same ref.                                  | Host matching and GitHub endpoint scoping are explicit security primitives.                                                                                                 |
| [`openclaw/crabbox` README](https://github.com/openclaw/crabbox/blob/ad17221b11f7afeec883e8534ba5e09c8918490f/README.md)                                                                | `ad17221b11f7afeec883e8534ba5e09c8918490f` | Broker owns provider credentials and lease state; runner is a leaf; CLI data plane talks directly to runner.                                                                |
| [`openclaw/crabbox` how it works](https://github.com/openclaw/crabbox/blob/ad17221b11f7afeec883e8534ba5e09c8918490f/docs/how-it-works.md)                                               | Same ref.                                  | Plan, lease, sync, run, release phases with stale-lease expiry and cleanup as normal path.                                                                                  |
| [`openclaw/crabbox` coordinator](https://github.com/openclaw/crabbox/blob/ad17221b11f7afeec883e8534ba5e09c8918490f/docs/features/coordinator.md)                                        | Same ref.                                  | Worker plus Fleet DO owns auth, provider creds, lease lifecycle, cost guardrails, run records, events, telemetry, bridges, artifacts, and cleanup.                          |
| [`openclaw/crabbox` observability](https://github.com/openclaw/crabbox/blob/ad17221b11f7afeec883e8534ba5e09c8918490f/docs/observability.md)                                             | Same ref.                                  | Keep lease ID and run ID together; log metadata but never env values; failure bundles are secret-bearing unless scrubbed.                                                   |
| [`openclaw/crabbox` capabilities](https://github.com/openclaw/crabbox/blob/ad17221b11f7afeec883e8534ba5e09c8918490f/docs/features/capabilities.md)                                      | Same ref.                                  | Capabilities are declared at lease creation and not flipped on live leases.                                                                                                 |
| [`openclaw/crabbox` artifacts](https://github.com/openclaw/crabbox/blob/ad17221b11f7afeec883e8534ba5e09c8918490f/docs/features/artifacts.md)                                            | Same ref.                                  | Brokered artifact publishing uses signed upload grants, size caps, manifests, and hashes.                                                                                   |
| [`kentcdodds/kody` README](https://github.com/kentcdodds/kody/blob/209406aba3b0277c922e1cf4c854cbff80bbeb6f/README.md)                                                                  | `209406aba3b0277c922e1cf4c854cbff80bbeb6f` | Cloudflare assistant runtime with user isolation across packages, jobs, secrets, values, and memories.                                                                      |
| [`kody` packages docs](https://github.com/kentcdodds/kody/blob/209406aba3b0277c922e1cf4c854cbff80bbeb6f/docs/use/packages.md)                                                           | Same ref.                                  | Package manifest is source of truth; static dependencies pin published snapshots; dynamic invocation resolves current target.                                               |
| [`kody` package/manifest contributing docs](https://github.com/kentcdodds/kody/blob/209406aba3b0277c922e1cf4c854cbff80bbeb6f/docs/contributing/packages-and-manifests.md)               | Same ref.                                  | Published bundles execute at runtime; package source lives in Cloudflare Artifacts; workflows carry small non-secret routing metadata; idempotency and depth limits matter. |
| [`kody` secrets docs](https://github.com/kentcdodds/kody/blob/209406aba3b0277c922e1cf4c854cbff80bbeb6f/docs/use/secrets-and-values.md)                                                  | Same ref.                                  | `secret_list` returns metadata, `secret_set` is write-only, host resolves placeholders for approved destinations.                                                           |
| [`kody` workflows docs](https://github.com/kentcdodds/kody/blob/209406aba3b0277c922e1cf4c854cbff80bbeb6f/docs/use/workflows.md)                                                         | Same ref.                                  | Runtime exposes Cloudflare Workflows with idempotency keys, scheduling, params, and per-user concurrency limit.                                                             |
| [`kody` package service](https://github.com/kentcdodds/kody/blob/209406aba3b0277c922e1cf4c854cbff80bbeb6f/packages/worker/src/package-runtime/package-service.ts)                       | Same ref.                                  | Package services are DO-backed with status, timeout, alarms, and recovery behavior after restoration.                                                                       |
| [`kody` published bundle artifacts](https://github.com/kentcdodds/kody/blob/209406aba3b0277c922e1cf4c854cbff80bbeb6f/packages/worker/src/package-runtime/published-bundle-artifacts.ts) | Same ref.                                  | Bundle artifacts are keyed by source/published commit/kind/artifact/entrypoint and validated before load.                                                                   |
| [`kody` package workflows](https://github.com/kentcdodds/kody/blob/209406aba3b0277c922e1cf4c854cbff80bbeb6f/packages/worker/src/package-runtime/package-workflows.ts)                   | Same ref.                                  | Dynamic callable workflow payloads have small params, idempotency metadata, hash helpers, retries, backoff, and timeouts.                                                   |
| [`kody` secret service](https://github.com/kentcdodds/kody/blob/209406aba3b0277c922e1cf4c854cbff80bbeb6f/packages/worker/src/mcp/secrets/service.ts)                                    | Same ref.                                  | Secret values decrypt only at the trusted service boundary; listing is metadata-only.                                                                                       |
| [`kody` fetch gateway](https://github.com/kentcdodds/kody/blob/209406aba3b0277c922e1cf4c854cbff80bbeb6f/packages/worker/src/mcp/fetch-gateway.ts)                                       | Same ref.                                  | Gateway expands secret placeholders, checks approved hosts, and avoids leaking secrets through normal fetch flow.                                                           |

### Vendor Docs Receipts

| Source                                                                                                                                                                                     | Takeaway                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Cloudflare Agents overview](https://developers.cloudflare.com/agents/) and [Agent class lifecycle](https://developers.cloudflare.com/agents/runtime/lifecycle/agent-class/)               | Agents are DO-backed stateful sessions with SQL, state, WebSockets, queues, schedules, and recoverable execution. Useful for agent-session UX, but still a DO model under the hood.     |
| [Cloudflare Durable Objects rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)                                                             | Use DOs for stateful coordination, one object per entity, not one global coordinator; persist important state and use transactions carefully.                                           |
| [Cloudflare Workflows](https://developers.cloudflare.com/workflows/) and [Rules of Workflows](https://developers.cloudflare.com/workflows/build/rules-of-workflows/)                       | Workflows are for durable sequences; side effects belong inside steps; step names and deterministic control flow matter; large data should live outside step return values.             |
| [Cloudflare Dynamic Workflows](https://developers.cloudflare.com/dynamic-workers/usage/dynamic-workflows/)                                                                                 | Dynamic Workers can run runtime-loaded workflow code, but workflow metadata is persisted and visible to dynamic code; do not put secrets in metadata.                                   |
| [Cloudflare Dynamic Workers](https://developers.cloudflare.com/dynamic-workers/)                                                                                                           | Isolated runtime-loaded Workers can run arbitrary untrusted code with controlled bindings, data, and network access.                                                                    |
| [Cloudflare Durable Object Facets](https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/)                                                                         | A supervisor DO can load dynamic DO classes as facets with isolated SQLite; supervisor controls access and can block network.                                                           |
| [Cloudflare Sandbox architecture](https://developers.cloudflare.com/sandbox/concepts/architecture/) and [Sandbox lifecycle](https://developers.cloudflare.com/sandbox/concepts/sandboxes/) | Sandboxes combine Worker, DO, and Container; they have isolated filesystems and lifecycle state, but state is not the durable source of truth.                                          |
| [Cloudflare Containers lifecycle](https://developers.cloudflare.com/containers/platform-details/architecture/)                                                                             | Containers are routed through Workers/DOs, run in isolated VMs, support hooks, and have ephemeral disk unless externalized.                                                             |
| [Cloudflare Artifacts overview](https://developers.cloudflare.com/artifacts/) and [How Artifacts works](https://developers.cloudflare.com/artifacts/concepts/how-artifacts-works/)         | Artifacts is Git-compatible versioned storage; repos are isolated, durable, and have repo-scoped tokens.                                                                                |
| [Cloudflare D1](https://developers.cloudflare.com/d1/)                                                                                                                                     | D1 is serverless SQLite with Worker access, disaster recovery, and many isolated databases. Good for queryable indexes and auth/policy tables.                                          |
| [Cloudflare R2](https://developers.cloudflare.com/r2/)                                                                                                                                     | R2 is large unstructured object storage. Good for blobs, screenshots, logs, datasets, and large report artifacts.                                                                       |
| [Better Auth organization plugin](https://better-auth.com/docs/plugins/organization)                                                                                                       | Organizations, teams, invitations, members, roles, custom permissions, and hooks map cleanly to human/org entitlement management.                                                       |
| [Better Auth device authorization](https://better-auth.com/docs/plugins/device-authorization)                                                                                              | OAuth device flow maps to CLI/Pi/local agent login where the user approves a device with a browser.                                                                                     |
| [Better Auth API key plugin](https://better-auth.com/docs/plugins/api-key) and [API key reference](https://better-auth.com/docs/plugins/api-key/reference)                                 | API keys can be user-owned or organization-owned with expiration, rate limits, metadata, and permissions. Use as service-account bootstrap, not as side-effect authorization.           |
| [Better Auth Agent Auth plugin](https://better-auth.com/docs/plugins/agent-auth)                                                                                                           | Agent-facing discovery, capability grants, approval flows, and short-lived JWT invocation are promising as an external bridge, but ShitRat still needs an internal policy/lease engine. |

## Pattern Cards

### 1. Small Kernel, Pinned Packs

Source: proposal page, local Brain summaries, Kody package docs.

Why it matters: if every context blob becomes "the system prompt," you get drift, leaks, stale behavior, and no reliable rollback. Kody's package model proves that manifests, static dependency pins, and published bundle refs are the right shape for reusable runtime context.

Where it belongs: `badass-courses/claw-kernel` carries the org default; `@joelhooks/shitrat-kernel` extends it; packs hold everything else.

### 2. Metadata-First Pack Discovery

Source: proposal page dynamic pack section, Kody package docs, Kody secret discovery.

Why it matters: agents should see pack titles, descriptions, trust tier, owner, and public mount conditions before they see full content. This prevents dumping private personal/project context into every run.

Where it belongs: Worker pack registry API plus D1 index. Full pack mount requires entitlement, version pin, manifest verification, and policy.

### 3. Artifacts as Canonical Runtime Source

Source: Cloudflare Artifacts docs, proposal page, Kody package source docs.

Why it matters: Artifacts gives per-pack/per-run Git history, isolated repos, repo-scoped tokens, fork/diff/merge, and durable state. That is closer to "runtime filesystem with receipts" than GitHub alone.

Where it belongs: kernel repos, pack repos, run repos, pinned plan artifacts, generated harnesses, review pages, receipts, rollback refs.

### 4. GitHub as Collaboration Surface

Source: local capability-lease proof, Crabfleet GitHub integration, Artifacts docs.

Why it matters: GitHub PRs are excellent for human review and collaboration, but they are not the trusted runtime package source and must not hold secrets.

Where it belongs: mirror, pull requests, review discussion, public changelog, release coordination. The runtime reads pinned Artifacts refs.

### 5. Context Capsule Actor

Source: local Brain architecture, Cloudflare DO rules, Crabfleet SessionControl shape, Kody package-service DO.

Why it matters: the durable unit should be external work item/thread/context, not a sandbox ID. A context capsule needs one writer, locks, hot state, event log, active run refs, pending reviews, and receipts.

Where it belongs: Durable Object or Agent class per capsule. Use raw DOs for core supervisor logic; use Agents when the session UX/state abstraction is useful.

### 6. Worker-Owned Credential Mediation

Source: Crabfleet architecture, Crabbox coordinator, Kody fetch gateway, local capability-lease proof.

Why it matters: if a sandbox or model gets long-lived tokens, the whole system is fucked. The safe pattern is Worker/DO owning secrets and issuing only approved, payload-bound operations or tightly scoped derived credentials.

Where it belongs: Worker/DO trusted boundary, secret broker, GitHub App adapter, fetch gateway, artifact token issuer.

### 7. Capability Leases, Not Token Leases

Source: Crabbox lease lifecycle, local broker proof, Better Auth Agent Auth concepts.

Why it matters: "can do X to Y with payload hash Z until T" is auditable. "Here is a token" is an incident report waiting to happen.

Where it belongs: central capability broker, policy evaluator, receipt sink, and every side-effect adapter.

### 8. Plan-Pin-Before-Run

Source: `docs/dynamic-workflow-machine.md`, Cloudflare Workflows rules, Kody workflow idempotency docs.

Why it matters: durable execution only helps if the plan is stable. Runtime-generated harness code should not also define the trusted lifecycle.

Where it belongs: every workflow that creates a sandbox, applies a patch, opens a PR, publishes a pack, or mutates a review surface.

### 9. Static Workflows First, Dynamic Workflows Later

Source: Cloudflare Workflows, Dynamic Workflows, Dynamic Workers, DO Facets docs.

Why it matters: static workflows are easier to test, reason about, and permission. Dynamic Workflows are attractive for generated plans, but their metadata and runtime code boundaries need a separate spike.

Where it belongs: v0 production uses registered Workflows. Dynamic Workers/Workflows/Facets belong behind prototype gates until receipts prove they do not leak or bypass policy.

### 10. Disposable Sandboxes, Durable Outputs

Source: Cloudflare Sandbox and Containers docs, Crabfleet sandbox sessions, Crabbox run/lease/artifact flow.

Why it matters: sandbox filesystem state is execution scratch, not memory. Containers can sleep/restart; disks are ephemeral unless externalized.

Where it belongs: sandboxes/containers execute; Artifacts/R2/D1/DO store outputs, indexes, receipts, and state.

### 11. Brokered Artifacts and Evidence

Source: Crabbox artifacts docs, Crabbox observability docs, Cloudflare Artifacts docs.

Why it matters: evidence needs size caps, hashes, manifests, lease/run correlation, redaction, and upload grants. Failure bundles should be treated as secret-bearing until scrubbed.

Where it belongs: artifact upload broker, R2 for large blobs, Artifacts for versioned trees, D1 for searchable metadata, Wzrrd/GitHub for reviewed summaries.

### 12. Auth Is Identity, Policy Is Runtime

Source: Better Auth org/device/API-key/Agent Auth docs, local capability proof.

Why it matters: Better Auth can answer "who is this human/device/service/agent session?" It should not be the only place deciding whether an agent can mutate GitHub, publish packs, spend money, or mount personal context.

Where it belongs: Better Auth for identity/session/org membership; ShitRat D1/DO policy for pack entitlements, trust tier, capability leases, and review gates.

## Kernel and Pack Boundaries

### `badass-courses/claw-kernel`

This is the org default every Badass Courses claw-family agent inherits.

Belongs here:

- receipt-first operating law
- harness-honesty/tool honesty
- public/private boundary
- minimal writing style constraints that apply across org work
- memory policy vocabulary
- pack discovery and mount contract
- capability-lease contract
- review/rollback defaults
- VISION core contract
- adapter compile rules for Pi, Claude, Codex, Cloudflare Agents, and workflow agents

Does not belong here:

- Joel-only topology
- private Brain surfaces
- personal inbox/comms habits
- project-specific source maps
- raw prompts, transcripts, logs, or secrets

### `@joelhooks/shitrat-kernel`

This is Joel's familiar/personality layer on top of the org default.

Belongs here:

- ShitRat identity and tone
- compact writing-style hot path
- Joel's default memory and receipt habits
- default pack dependencies by category, not the full pack contents
- trust/todo/review metadata for kernel evolution
- adapter-specific voice compilation
- drift detection rules: dream may propose patches, never silently mutate the live kernel

Does not belong here:

- the whole JoelClaw runtime topology
- per-project state
- support inbox details
- course-specific/customer-specific context
- secrets or secret-adjacent configuration

### Personal JoelClaw Runtime Pack

This is not a universal kernel dependency. It is Joel's private operating environment pack.

Belongs here:

- JoelClaw topology summaries
- gateway/system-bus/k8s/tailnet references
- personal Brain and memory surface references
- personal comms preferences
- private capability policy summaries
- support/ops source maps

Mount rule: only for Joel-authorized sessions, with explicit context need and private-boundary handling.

### Org Packs

Belongs here:

- Badass Courses operating defaults
- support policies
- publishing/content workflows
- research and monitoring workflows
- course/business strategy context
- non-secret reusable docs
- standard checks and evidence requirements

Mount rule: org membership plus role/team entitlement plus pack trust tier.

### Project Packs

Belongs here:

- `VISION.md`
- `AGENTS.md`
- project source maps
- repo-specific checks
- trust gates
- project-local Brain summaries
- prototype/production boundary
- project-specific workflows

Mount rule: project access plus task relevance. Project packs should not float to latest during a run.

### Workflow Packs

Belongs here:

- research fan-out
- support triage
- review gate
- deploy repair
- pack publish
- rollback
- capability broker adapters
- dynamic machine templates

Mount rule: selected by supervisor/control plane, pinned by immutable ref, then used by Workflows/Sandboxes with explicit leases.

## Recommended Runtime Architecture

| Layer                 | Use for                                                                                                                                                                | Do not use for                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Workers               | Stateless front door, Better Auth integration, request validation, policy calls, pack registry API, lease broker API, artifact token minting, GitHub adapter boundary. | Long-running state, raw dynamic code execution, broad secret fan-out.       |
| Durable Objects       | Context capsules, session actors, lease broker actors, pack registry actors, locks, hot state, event log, active sandbox handle, review gate coordination.             | Global reporting queries, one giant coordinator, large blobs.               |
| Cloudflare Agents     | Agent-session UX, stateful chat/session runtime, WebSockets, schedules, queues, SQL-backed session state.                                                              | Replacing explicit supervisor state machines when raw DO control is needed. |
| Workflows             | Durable deterministic sequences: pack publish, research run, sandbox lifecycle, review waits, apply/rollback after plan pin.                                           | Arbitrary unpinned planning, huge data returns, secret-bearing metadata.    |
| Dynamic Workflows     | Later: tenant/project-defined plan execution after manifest validation and metadata scrub.                                                                             | v0 production core, secretful dynamic execution, generated policy code.     |
| Dynamic Workers       | Later: isolated runtime-loaded validators, pack tools, generated harnesses with controlled bindings/network.                                                           | Secret broker, auth core, policy evaluator, privileged supervisor.          |
| Durable Object Facets | Later: package-owned persistent services/retrievers/apps with isolated SQLite under a supervisor.                                                                      | Shared supervisor state, cross-pack secret access, v0 critical path.        |
| Sandboxes             | Per-task CLI/filesystem/toolchain work, agent execution, previews, tests, report generation.                                                                           | Durable memory, canonical package storage, long-lived secret storage.       |
| Containers            | Custom images, heavier isolated execution, stateful runtime instances with hooks.                                                                                      | Durable disk unless explicitly backed by Artifacts/R2.                      |
| D1                    | Global queryable index: users, orgs, roles, devices, agents, service accounts, pack manifests, entitlements, leases, trust, usage, workflow runs.                      | Raw secret values, raw transcript bodies, huge logs/blobs.                  |
| DO SQLite             | Per-actor state, event queue, locks, schedules, hot snapshots, facet storage.                                                                                          | Global analytics and cross-tenant search.                                   |
| R2                    | Large blobs: screenshots, videos, datasets, log bundles, generated archives, transcript extracts after scrub.                                                          | Versioned runtime manifests or policy source of truth.                      |
| Artifacts             | Canonical kernel/pack/run repos, pinned plans, harnesses, diffs, receipts, rollback refs, review-page source.                                                          | Raw object blobs better suited to R2, secret values.                        |
| GitHub                | Public/collab mirror, PRs, issues, reviews, release coordination, human discussion.                                                                                    | Canonical runtime source, secret store, unmediated write path.              |

### Runtime Flow

1. User/device/agent authenticates through Better Auth.
2. Worker validates session and resolves org/team/user/device/service-account identity.
3. Worker asks D1/DO policy for visible pack metadata.
4. Supervisor pins selected pack versions from Artifacts and verifies manifests.
5. Supervisor pins a plan artifact before sandbox/workflow execution.
6. Workflow executes deterministic lifecycle steps and calls DOs for state transitions.
7. Sandbox/container performs scratch work with no broad secrets.
8. Side effects request capability leases.
9. Trusted Worker/DO adapter executes exact payload-bound operation or denies it.
10. Receipts land in Artifacts/D1/R2 and surface through Wzrrd/GitHub as redacted summaries.

## Better Auth Mapping

Better Auth should own identity and session mechanics. ShitRat owns runtime policy.

| Runtime concept     | Better Auth mapping                                                                                      | ShitRat policy mapping                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Human user          | Better Auth user.                                                                                        | `actor.type = "human"`, org/team/member roles, review authority, spend tier.                                      |
| Organization        | Organization plugin org.                                                                                 | Pack namespace, entitlement scope, policy namespace, billing/spend envelope.                                      |
| Team                | Organization plugin team.                                                                                | Pack access group and workflow/capability policy group.                                                           |
| Role                | Organization plugin role/custom permission.                                                              | Eligibility for pack visibility, approval authority, trust-tier ceiling.                                          |
| CLI/Pi/local device | Device Authorization plugin plus bearer/session token.                                                   | Device identity in D1, bound to user/org/session, scoped to requested packs/capabilities.                         |
| Agent session       | Either internal session row or Better Auth Agent Auth session when exposing external agent capabilities. | `actor.type = "agent"`, parent human/org, trust tier, current context capsule, pack refs.                         |
| Service account     | Org-owned API key with permissions, expiration, metadata, and rate limits.                               | `actor.type = "service"`, bootstrap only; every side effect still needs a capability lease.                       |
| Pack entitlement    | Not native Better Auth.                                                                                  | D1 table keyed by org/user/team/agent/service account plus pack ref, version range, trust tier, mount conditions. |
| Capability grant    | Agent Auth can expose/discover grants externally.                                                        | Internal lease row/DO state remains source of truth for payload-bound side effects.                               |

Rules:

- Do not let Better Auth roles directly imply write authority. Roles grant eligibility; leases authorize exact operations.
- Treat org-owned API keys as service-account login, not mutation rights.
- Device authorization is for pairing local/limited-input clients to a human/org. The device token should request leases; it should not carry broad GitHub or Cloudflare authority.
- Agent Auth is interesting for external agents discovering ShitRat capabilities. Keep it outside the first core unless a spike proves Worker compatibility, storage fit, and approval UX.
- Store Better Auth IDs in D1 policy tables, but keep pack entitlement, trust tier, policy version, spend limits, and lease decisions in ShitRat-owned tables.

## Capability Lease Schema Sketch

This is intentionally a sketch, not a generated schema.

```json
{
  "leaseId": "lease_...",
  "runId": "run_...",
  "workItemId": "issue-or-thread-or-capsule",
  "idempotencyKey": "hash-or-client-key",
  "actor": {
    "id": "actor_...",
    "type": "human|agent|service",
    "userId": "user_...",
    "organizationId": "org_...",
    "teamIds": ["team_..."],
    "deviceId": "device_...",
    "sessionId": "session_..."
  },
  "auth": {
    "provider": "better-auth",
    "sessionRef": "session_...",
    "authStrength": "web|device|api-key|agent-grant"
  },
  "policy": {
    "policyId": "capability-policy",
    "policyVersion": "2026-06-08",
    "roleIds": ["operator"],
    "trustTier": "manual|reviewed|bounded-auto",
    "spendLimitRef": "spend_..."
  },
  "capability": {
    "name": "github.pull_request.create",
    "mode": "read|write|publish|execute",
    "resource": {
      "type": "github.repo",
      "id": "owner/repo",
      "branch": "agent/branch",
      "paths": ["docs/report.md"]
    }
  },
  "payload": {
    "payloadRef": "artifact://namespace/repo/ref/path",
    "payloadHash": "sha256:...",
    "filesRef": "artifact://namespace/repo/ref/files.json",
    "bodyHash": "sha256:..."
  },
  "secretRefs": ["secretref:github-app-installation:..."],
  "constraints": {
    "expiresAt": "2026-06-08T20:00:00Z",
    "maxUses": 1,
    "networkAllowlist": ["api.github.com"],
    "hostAllowlist": ["github.com"],
    "rollbackRef": "artifact://namespace/repo/ref/rollback.patch"
  },
  "reviewGate": {
    "required": true,
    "approvalRef": "review_...",
    "reviewSurface": "wzrrd-or-github-url"
  },
  "receipt": {
    "required": true,
    "sink": "artifact://namespace/run-repo/ref/receipts/lease.json",
    "d1AuditId": "audit_...",
    "redacted": true
  }
}
```

Decision outcomes:

- `issued`: policy, entitlement, hash, expiry, and review gate pass.
- `denied`: policy says no; include stable denial code.
- `blocked`: missing review, missing entitlement, missing secret approval, hash mismatch, stale pack ref, spend cap, or unsafe payload.
- `expired`: lease was not used in time.
- `revoked`: human/policy revoked before execution.
- `executed`: adapter completed operation and receipt was persisted.
- `rollback_required`: verification failed after operation.

Minimum denial codes:

- `actor_not_authenticated`
- `org_membership_missing`
- `pack_entitlement_missing`
- `capability_denied`
- `review_required`
- `review_rejected`
- `payload_hash_mismatch`
- `stale_pack_ref`
- `secret_approval_missing`
- `secret_scope_denied`
- `resource_scope_denied`
- `expiry_out_of_bounds`
- `spend_cap_exceeded`
- `receipt_sink_unavailable`

## Required State Machines

Use explicit state machines for lifecycle code. XState v5 is a good fit where visualizable machines help, but the important part is explicit states and receipts, not the library.

### Pack Mount

`discovered -> entitlement_check -> version_selected -> manifest_loaded -> hash_verified -> adapter_compiled -> mounted`

Terminal/alternate states:

- `denied`
- `stale`
- `manifest_invalid`
- `hash_mismatch`
- `adapter_compile_failed`
- `unmounted`

Receipts: selected pack ref, manifest hash, file hashes, entitlement decision, adapter output hash.

### Capability Lease

`requested -> policy_evaluating -> review_waiting? -> payload_resolving -> hash_verifying -> issued -> executing -> receipt_persisting -> executed`

Terminal/alternate states:

- `denied`
- `blocked`
- `expired`
- `revoked`
- `adapter_failed`
- `receipt_failed`
- `rollback_required`

Receipts: request envelope, policy decision, approval ref, payload hash, adapter result, redacted receipt.

### Sandbox Run

`planned -> admitted -> artifacts_ready -> sandbox_creating -> hydrating -> executing -> outputs_collecting -> verifying -> capturing -> destroying -> captured`

Terminal/alternate states:

- `queued`
- `blocked`
- `failed`
- `cancelled`
- `destroy_failed`
- `capture_failed`

Receipts: pinned plan, sandbox ID, artifact repo/ref, command summary, exit status, output refs, destroy receipt.

### Human Review

`proposed -> review_surface_published -> awaiting_decision -> decision_recorded`

Decision states:

- `approved`
- `rejected`
- `changes_requested`
- `timed_out`
- `superseded`

Receipts: review URL, reviewer actor, decision hash, exact artifact ref approved.

### Apply

`prepared -> preflight -> lease_requested -> lease_issued -> applying -> verifying -> receipt_persisting -> accepted`

Terminal/alternate states:

- `blocked`
- `rejected`
- `apply_failed`
- `verification_failed`
- `rollback_pending`

Receipts: forward patch/ref, preflight summary, lease ID, applied commit/ref, verification output, rollback ref.

### Rollback

`requested -> rollback_ref_resolved -> review_waiting? -> lease_requested -> applying_rollback -> verifying -> receipt_persisting -> rolled_back`

Terminal/alternate states:

- `blocked`
- `rollback_ref_missing`
- `rollback_failed`
- `verification_failed`
- `manual_recovery_required`

Receipts: rollback ref, approval ref if any, lease ID, applied rollback commit/ref, verification output.

### Trust Upgrade

`evidence_collected -> evaluated -> policy_change_proposed -> human_review -> policy_updated -> probation -> stable`

Terminal/alternate states:

- `rejected`
- `insufficient_evidence`
- `regression_detected`
- `reverted`

Receipts: run set, pass/fail evidence, leak scan result, spend behavior, policy diff, reviewer decision.

### Pack Publish

`draft -> static_checks -> leak_scan -> manifest_hashing -> artifact_publish -> smoke_mount -> index_update -> available`

Terminal/alternate states:

- `blocked`
- `leak_detected`
- `checks_failed`
- `publish_failed`
- `smoke_failed`
- `deprecated`

Receipts: source ref, checks, leak scan, manifest hash, Artifacts repo/ref, D1 index row, smoke run.

## Trust and Autonomy Gates

### Manual

Allowed:

- read public/project-approved context
- search and summarize
- propose plans
- create review surfaces
- draft diffs without applying them

Denied:

- external side effects
- secret materialization
- pack publishing
- applying patches
- sending messages
- spending money

### Reviewed

Allowed:

- run sandboxed research
- generate artifacts
- publish Wzrrd/GitHub review drafts
- request capability leases

Requires human approval:

- GitHub PR creation
- pack publication
- apply/rollback
- outbound messages
- private pack mount if not already authorized
- spend above tiny default limits

### Bounded Auto

Allowed only when all are true:

- exact capability and resource are pre-approved
- payload hash is pinned
- expiry is short
- max uses is one or tightly capped
- rollback ref exists when mutation is possible
- verification contract exists
- spend cap exists
- receipt sink is healthy
- policy version is pinned

Examples:

- create a PR for an approved doc-only payload
- publish a redacted run report to an approved Artifacts repo
- upload known artifact blobs through signed upload grants

### Hard Deny

Always deny:

- raw secret exposure to prompt, model, sandbox, public logs, D1, R2, or workflow metadata
- raw private Brain dumps or transcript bodies in public artifacts
- floating pack versions during a run
- generated code inside the privileged Worker/DO policy boundary
- dynamic workflow metadata containing secrets
- broad GitHub or Cloudflare token handoff
- unbounded concurrency, spend, or retries
- hidden apply without review or lease
- silent kernel mutation by dreams or background agents

## Implementation Sequence

No more than seven steps, and the first two are still design/validation.

1. Define documents and schemas only: kernel manifest, pack manifest, VISION core, public/private scrub line, capability lease envelope, state names, receipt schema.
2. Build a static pack registry validator over local fixtures and Artifacts-shaped refs. No dynamic code execution, no secret material, no pack auto-mount.
3. Spike Better Auth integration on Cloudflare Workers: org roles, teams, device authorization, org-owned API keys, schema storage, and session verification. Produce a mapping doc before wiring policy.
4. Rewrite production ports from prototype learning: pack registry, context capsule, capability broker, receipt sink, artifact store, review gate. Do not copy prototype code directly into `src/`.
5. Build one static Workflow plus DO supervisor for a low-risk research pack: plan-pin, sandbox run, capture outputs, publish redacted Wzrrd/GitHub review. No apply capability.
6. Add one bounded capability: payload-bound GitHub PR creation using the existing broker proof shape, Better Auth actor identity, short expiry, policy denial codes, and redacted receipts.
7. Only after receipts from steps 1-6, prototype Dynamic Workers, Dynamic Workflows, and DO Facets for package-owned services/harnesses under isolated bindings, no secrets in metadata, and explicit rollback/delete semantics.

## Do Not Build Yet: Risks and Open Questions

Better Auth compatibility needs a real Cloudflare Worker spike. The docs support the conceptual model, but we still need receipts for storage adapter choice, migration shape, device flow UX, org-owned API keys, Agent Auth compatibility, and how session verification behaves at the Worker boundary.

Cloudflare Artifacts is still beta/preview territory. It is the right conceptual source of truth, but production work needs access, limits, pricing, token lifetime, namespace strategy, retention, and failure-mode receipts.

Dynamic Workers, Dynamic Workflows, and DO Facets are powerful but dangerous. Do not put policy, auth, secrets, or privileged supervisor state in dynamic code. Prove isolation, network blocking, metadata scrubbing, and version pinning in prototypes first.

Secret leakage remains the highest-severity risk. Metadata-only discovery is necessary but not enough. Need leak scans for artifacts, logs, review pages, prompts, pack manifests, workflow metadata, D1 rows, R2 bundles, and GitHub PR bodies.

Prompt/context leakage is the second big risk. Pack discovery must not reveal sensitive full content. Mount decisions need entitlement, task relevance, pack trust tier, and immutable version refs.

Stale pack versions can cause agents to act with old policy. Every run needs pinned pack refs and policy version. Floating dependencies should only resolve before the plan is pinned.

Runaway spend needs a first-class budget state machine. Crabbox's cost guardrail pattern should be copied before any container-heavy or agent-fan-out workflow gets bounded-auto authority.

Human review can become fake safety theater. Review pages must show exact payload refs, hashes, diff, policy decision, rollback ref, and what capability will execute. "Looks good" without payload binding does not count.

Capability leases need revocation and replay protection. Idempotency keys, max uses, expiry, payload hashes, and receipt persistence must be enforced at the trusted boundary.

Artifacts/R2/D1/DO split needs retention policy. Some data should be durable, some should be scrubbed, and some should never be written. Decide before collecting large logs and traces.

Agent Auth may overlap with internal leases. Use it only as an external discovery/grant bridge unless a spike proves it can carry the same payload-bound semantics without weakening the lease model.

The kernel split could get too clever. Start with the org kernel, ShitRat kernel, one personal runtime pack, one project pack, and one workflow pack. Add categories lazily when repeated work proves they are needed.
