---
title: Thariq Shihipar - Building Claude Code at Anthropic
source: https://davidguttman.github.io/every-vibe-code-camp-distilled/14_thariq_shihipar.html
observed: 2026-06-04
status: copied-summary
---

# Thariq Shihipar - Building Claude Code at Anthropic

Distilled notes from a Thariq interview/conversation.

## Extracted useful points

- **Unhobbling the model**: the constraint is often the scaffolding around the model, not the model itself.
- **Delete code as fast as you write it**: as models improve, old orchestration code should be removed when the model/runtime can do the job natively.
- **Moats are vectors, not points**: advantage is learning velocity and knowing what you threw away, not a static feature snapshot.
- Engineers on Claude Code directly read issues/talk to users; over-abstracting feedback loses product feel.
- Composable building blocks beat point solutions.
- Upcoming tasks replacing todos were described as dependency-aware, persistent across sessions, multi-agent, and project-shaped.
- Longer-running AI workflows require more human ambiguity reduction upfront, not less.

## Why this matters here

This strongly validates the deletion-first prototype loop:

1. build a small scaffold
2. learn from it
3. capture the learning
4. delete the scaffold when a better primitive or model behavior appears

For this repo, that means prototypes are not lesser production code. They are disposable probes whose durable value is the captured decision.
