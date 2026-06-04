---
title: How We Claude Code — Thariq's Workshop Recap
source: https://howborisusesclaudecode.com/recap
observed: 2026-06-04
status: copied-summary
---

# How We Claude Code — Thariq's Workshop Recap

Notes from Thariq Shihipar's Code w/ Claude Extended workshop.

## Extracted useful points

- Agents can now run for 8-10 hours, which makes staying in the loop and verification more important.
- Prompting move: ask Claude to **"interview me"** when the request is vague. It shifts Claude into question mode and surfaces missing constraints.
- Thariq prefers HTML plans over Markdown when Claude is doing the editing because HTML can include diagrams, mockups, code paths, and review affordances.
- Design exploration can be a cheap prototype: ask for multiple HTML mockup directions for 15 minutes instead of an 8-hour full build.
- Verification is the important frontier. The recap quotes: "Given that agents are so good at writing code, the most important thing to focus on is verification."
- Verification environments are like Storybook, but built to run actions and record evidence, not just browse UI.
- Code should be modularized by verifiability: state and UI split when that makes each part independently checkable.
- Skills should be for your particular workflows; the recap quotes Thariq as anti generic `npm install skills-dash-x` without reading/trusting the skill.

## Why this matters here

- Wzrrd pages are not decoration. They are the HTML review surface so humans actually inspect outputs.
- Prototype outputs should include verification evidence, not just generated text.
- Context packs should be narrow and inspectable, not magic installed skill soup.
