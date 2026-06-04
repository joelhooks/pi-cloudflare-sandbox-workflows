# Thariq Source Map

Thariq Shihipar's public material is useful because it keeps pointing at the same pattern: give agents enough agency, make work visible/reviewable, verify hard, and delete scaffolding as models improve.

## Copied local sources

- `sources/thariq/skills-on-demand-tasks-as-dags.md`
  - source X thread: `https://x.com/trq212/status/2033949937936085378`
  - useful ideas: progressive skill disclosure, tasks as DAG primitives, session-boundary persistence
- `sources/thariq/claude-agent-sdk-full-workshop-thariq-shihipar.md`
  - source video: `https://www.youtube.com/watch?v=TqC1qOfiVcQ`
  - useful ideas: agent harness, bash/general computer use, file system as context/memory, verification loop

## Web references

- Workflows are the biggest Claude Code upgrade since skills/subagents: `https://digg.com/ai/qgxmwxjf`
- Original X article target from that Digg story: `https://x.com/i/article/2061850535708483585`
- Workshop recap: `https://howborisusesclaudecode.com/recap`
- Vibe Code Camp distilled Thariq interview notes: `https://davidguttman.github.io/every-vibe-code-camp-distilled/14_thariq_shihipar.html`
- Anthropic dynamic workflows blog: `https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code`

## Design implications for us

- **Progressive context disclosure**: context packs should be selected, pinned, and loaded only when a capsule needs them.
- **Tasks as DAGs**: workflow runs should model dependencies, not flat todos.
- **Harness as code**: generated workflows should be pinned artifacts, not hidden prompt state.
- **HTML/Wzrrd review surfaces**: review artifacts should be readable and visual enough that humans actually inspect them.
- **Verification environments**: every prototype and workflow should define how it proves its output.
- **Delete scaffolding**: once a model/runtime primitive makes our workaround obsolete, delete the workaround and keep only the learning.
