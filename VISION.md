# Vision

Scope: this repo, `pi-cloudflare-sandbox-workflows`.

Audience: contributors, reviewers, future agents, and operators trying to understand what belongs here. This is product/project intent, not an operational runbook. Commands and agent rules live in `AGENTS.md`, prototype READMEs, and skills.

This project is the public incubator for Cloudflare-backed agent workflow patterns: contextual Pi runs, dynamic workflow planning, capability leases, Artifacts-backed receipts, bounded sandbox execution, and reviewable output delivery.

The point is not to build one polished app. The point is to prove small, real substrate patterns that can later be rewritten into private production systems without dragging prototype guts behind us like a cursed wagon.

## Who We Serve

- Primary users: Joel and ShitRat as operators of agent workflows across local machines and Cloudflare runtimes.
- Secondary users: agent builders who need concrete, source-backed examples of Cloudflare Sandbox, Durable Objects, Queues, Artifacts, and capability leasing.
- Not for: generic SaaS workflow automation, public memory hosting, customer/support production logic, or dumping private operator state into a public repo.

## Outcomes

- Ephemeral compute can perform bounded agent work and leave durable, inspectable receipts.
- Dynamic workflows can stay flexible without turning into unauditable vibes.
- Secrets become capability leases, not raw token handoffs.
- Cloudflare Artifacts become the versioned substrate for plans, graph snapshots, outputs, rollbacks, and review receipts.
- Prototype learning can be captured, deleted, and rewritten into production seams cleanly.

## Current Priorities

1. Prove dynamic workflow shapes with real substrate receipts before productionizing anything.
2. Keep the prototype/production boundary sharp.
3. Make ShitRat’s operating graph concrete enough to version, inspect, review, deploy, and roll back.
4. Keep public artifacts sanitized while preserving useful generic patterns.

## Core Boundary: Stochastic Dream, Deterministic Safety

Dreams should be stochastic. They are allowed to wander across near-term and long-term evidence, connect weird dots, propose unexpected graph edges, and assemble new workflow lanes.

The deterministic part is the safety envelope:

- source receipts,
- schema validation,
- artifact commits,
- capability leases,
- per-item review gates,
- forward and rollback patches,
- validation output,
- final run status.

If a prototype turns the dream itself into a fixed enum of lifecycle states, it is missing the point. Fixed states are for mutation safety, not for the creative/scouting surface.

## System Operating Graph

Dynamic workflows should have access to a system operating graph when the job needs one.

For ShitRat, that graph includes:

- prompts,
- skills,
- scripts,
- access refs,
- capabilities,
- memory surfaces,
- workflow patterns,
- hosts/runners,
- Artifacts,
- receipts,
- deployment state.

Brain/SVX is a human-readable memory and review surface inside that graph. It is not the whole graph.

## Merge by Default

Safe by default:

- docs that clarify existing intent without changing policy,
- prototype-only fixes that improve receipts or validation,
- schema/type fixes that preserve existing behavior,
- sanitized examples that strengthen public learning,
- TODOs that clearly label fake, fixture, local-only, or unproven seams.

## Needs Sign-Off

Stop for owner sign-off before:

- deploying new Cloudflare Workers or changing live bindings,
- adding or widening secret/capability access,
- mutating system Brain, prompts, skills, or global ShitRat behavior,
- exposing JoelClaw/Typesense over a new network boundary,
- moving prototype code into `src/`,
- committing private topology, raw transcript content, tokens, bearer URLs, or production-only policy.

## Will Not Do For Now

- No raw token handoff to sandboxes.
- No raw Typesense exposure from Cloudflare.
- No cron/scheduled dreams until manual focused dreaming is useful.
- No automatic global memory or prompt edits without per-item approval, forward diff, rollback diff, hash check, validation, and apply receipt.
- No prototype promotion by copy-paste into production.
- No broad platform ceremony just because a prototype worked once.

## Decision Boundaries

Safe by default:

- local fixture/recorded-receipt prototypes,
- artifact-only outputs,
- review-only system graph proposals,
- schema and receipt shape experiments under `prototypes/`.

Needs sign-off:

- live deploys,
- real external writes,
- access/capability expansion,
- production absorption,
- public/private boundary changes.

Evidence expected for meaningful changes:

- command output,
- artifact repo path and commit SHA,
- schema validation,
- leak/scrub checks when access is involved,
- Brain/docs capture for durable decisions.

## Amendment Policy

This document can change when evidence shows the project direction is wrong. Agents may propose amendments with receipts. Joel approves the change.
