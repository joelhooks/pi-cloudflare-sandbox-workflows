---
type: discovery
slug: skills-on-demand-tasks-as-dags-claude-code
source: "https://x.com/trq212/status/2033949937936085378"
discovered: "2026-03-17"
site: "joelclaw"
visibility: "public"
tags:
  [
    article,
    ai,
    agent-loops,
    skills,
    anthropic,
    claude-code,
    dag,
    memory,
    context-management,
  ]
relevance: "Progressive skill disclosure matches joelclaw's SKILL.md pattern exactly; task DAGs map directly to the Restate dagOrchestrator in the workload rig"
---

# Skills on Demand, Tasks as DAGs: How Claude Code Manages Agent Context

[Thariq Shihipar](https://x.com/trq212) is on the [Claude Code](https://docs.anthropic.com/en/docs/claude-code) team at [Anthropic](https://anthropic.com), and this X article lays out how they actually use the skills system inside Claude Code itself. Two patterns stand out: **progressive skill disclosure** — loading skills contextually rather than dumping everything into context at once — and **tasks replacing todos** as a DAG-based coordination primitive across sessions.

The progressive disclosure idea is elegant and practically necessary. Instead of front-loading an agent with every possible instruction, skills get loaded when a task matches. Context stays small until you actually need the depth. [joelclaw's skills architecture](/adrs) is already built on this pattern: 76 skills live in the canonical `skills/` directory, each with a `SKILL.md`, but only the relevant ones get surfaced per task via the `<available_skills>` manifest injected into the system prompt. You don't carry every book to your desk — the library exists, you just fetch what the task calls for.

The tasks-as-DAGs piece is the more novel articulation. Traditional agent todo lists are flat and ephemeral — a list of things to check off that dissolves between sessions. Tasks as DAG primitives means each task carries its dependencies and successors, enabling coordination that persists across session boundaries. This is structurally identical to how the [joelclaw workload rig](/adrs/workflow-rig) operates: a `plan.json` describes a DAG of stages, dispatched through Redis to the [Restate](https://restate.dev) `dagOrchestrator`, where every stage is a node with explicit dependency tracking and handoff contracts. The shape of the solution is the same.

What makes this worth saving isn't just the pattern validation — it's the source. The [Claude Code](https://claude.ai/code) team isn't describing an abstract recommendation. They're describing what they built for themselves, then shipped. When the people building the tool use the same architectural patterns in their own workflows, that's a meaningful signal about what actually holds up under load.

## Key Ideas

- **Progressive skill disclosure** — skills load when task context matches, not upfront; keeps the context window efficient until depth is actually required
- **Tasks as DAG primitives** — replace flat todo lists with structured nodes that know their dependencies and successors, enabling cross-session coordination
- **Session-boundary persistence** — DAG task structures survive where ephemeral todos don't; coordination state doesn't dissolve when the session ends
- **Dogfooding the pattern** — [Anthropic](https://anthropic.com)'s own team uses the skill architecture that [Claude Code](https://docs.anthropic.com/en/docs/claude-code) ships, which is meaningful validation
- **Context efficiency as a design constraint** — progressive loading isn't just ergonomic, it's architectural; massive context dumps degrade performance and coherence
- **DAG vs. linear coordination** — the shift from todos to DAGs is about dependency awareness, not just task tracking; unlocks parallel and conditional execution across agents

## Links

- [Source — Thariq Shihipar on X](https://x.com/trq212/status/2033949937936085378)
- [Thariq Shihipar (@trq212)](https://x.com/trq212)
- [Anthropic](https://anthropic.com)
- [Claude Code docs](https://docs.anthropic.com/en/docs/claude-code)
- [Claude Code](https://claude.ai/code)
- [Restate — durable workflow runtime](https://restate.dev)
- [joelclaw skills directory](https://github.com/joelhooks/joelclaw/tree/main/skills)
- [joelclaw workload rig — `joelclaw workload plan`](https://joelclaw.com/adrs/workflow-rig)
