# Prototype: joelclaw-research-swarm-spike

Status: active

## Question

Can an operator-shaped adaptive workflow use JoelClaw as a seed corpus, expand into source-classed broader research, launch hot Cloudflare Sandbox research lanes, and deliver a verified Brain page with Artifacts-backed receipts?

This is not a tiny source-adapter slice. The prototype exists to prove end-to-end full-task practice with real production-grade primitives.

## Run

Pre-launch planning/review:

```bash
pnpm prototype:joelclaw-swarm:plan
```

After reviewing the generated pi-notes/Brain review page, record hash-bound approval:

```bash
JOELCLAW_SWARM_APPROVE=1 pnpm prototype:joelclaw-swarm:plan
```

Deploy/run shape, once the Worker is wired:

```bash
pnpm prototype:joelclaw-swarm:deploy
pnpm prototype:joelclaw-swarm:real
```

## Success signal

Latest real run is captured.

```txt
run: run-joelclaw-research-swarm-workflow-verifier-evals-96a02bd9
Worker: https://pi-joelclaw-research-swarm-spike.joelhooks.workers.dev
public research output: https://pi-joelclaw-research-swarm-spike.joelhooks.workers.dev/research/joelclaw-research-swarm-workflow-verifier-evals
public observer: https://pi-joelclaw-research-swarm-spike.joelhooks.workers.dev/observer/joelclaw-research-swarm-workflow-verifier-evals
Artifacts repo: jcrs-run-joelclaw-research-swarm-workflow-verifier-evals-96a02bd9
research lanes: 6 real Pi internet-research agent lanes
model: openai-codex/gpt-5.5
max observed active lanes: 3
verifier: verified
final state: captured
cleanup receipts: 9
output refs: .brain/resources/workflow-verifier-evals-playbook.svx, capsule:inline-bibliography, capsule:inline-source-map
Brain page: .brain/resources/workflow-verifier-evals-playbook.svx
Brain URL: https://pi-notes-4188.localhost/notes/resources/workflow-verifier-evals-playbook
```

Final acceptance requires:

- pre-launch Brain review page generated
- operator approval recorded with artifact hashes
- scouts search JoelClaw and produce a theme map
- dynamic lane plan derived from scout evidence
- hot Cloudflare Sandbox research lanes run real `pi -e .pi/extensions/research-tools.ts --provider openai-codex --model gpt-5.5` internet-research agents for each chosen theme
- lanes use JoelClaw plus broader source-classed web/official sources
- fan-in synthesis writes `.brain/resources/workflow-verifier-evals-playbook.svx`
- verifier checks claims, source classes, fair-use attribution, and freshness
- `pi_notes_brain_check` passes
- final receipt includes Brain page URL, Artifacts refs, lane receipts, verifier result, and cleanup receipts

Ignored local receipts:

```txt
prototypes/joelclaw-research-swarm-spike/out/latest-receipt.json
prototypes/joelclaw-research-swarm-spike/out/latest-status.json
```

The pre-launch planning gate is also captured:

```txt
prototypes/joelclaw-research-swarm-spike/out/latest-prelaunch-plan.json
prototypes/joelclaw-research-swarm-spike/out/latest-operator-approval.json
.brain/reviews/joelclaw-research-swarm-joelclaw-research-swarm-workflow-verifier-evals.svx
```

## Cloudflare primitives target

The full real-run prototype should use:

- Worker HTTP API
- Durable Object capsule supervisor
- Queue-backed child workflow scheduling
- real Cloudflare Sandbox research, synthesis, verifier, and delivery lanes
- Artifacts commits for pre-launch artifacts, lane outputs, source maps, synthesis, verification, delivery, and cleanup receipts

## Capture target

- `.brain/projects/joelclaw-research-swarm-spike.svx`
- `.brain/resources/joelclaw-docs-api-research-backlog.svx`
- `.brain/resources/workflow-verifier-evals-playbook.svx`
- `docs/dynamic-workflow-machine.md` after the full real run answers the control-shape question

## Delete/absorb rule

Delete or rewrite after the adaptive research-swarm control shape is captured. Absorb only the state/event names, source-class contracts, approval-boundary receipts, lane planning shape, and verification contract into production `src/`; do not promote this prototype directly.
