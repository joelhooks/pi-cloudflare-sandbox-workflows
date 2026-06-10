# ShitRat Dream Workflow Spike TODOs

This file is the delineation wall. If a future run blurs these lines, stop and fix the receipt instead of pretending the prototype proved more than it did.

## Proved locally

- [x] Fresh prototype lives under `prototypes/shitrat-dream-workflow-spike/`.
- [x] `pnpm prototype:shitrat-dream:local` writes a local Git artifact repo under `out/artifacts/<run-id>/`.
- [x] The artifact contains `manifest.json`, `crawl-plan.json`, `hydration-receipts.jsonl`, `candidate-core-memories.jsonl`, `flow-ratifications.jsonl`, `workflow-plan.json`, graph files, desired deployment manifests, events, receipts, and review summary.
- [x] The workflow plan separates stochastic `phases[]` / `lanes[]` from deterministic safety status.
- [x] No real system Brain, prompt, skill, Slack, GitHub, Typesense, or Cloudflare mutation happens.
- [x] Metadata-only identity inventory scanned this machine, `flagg`, and `panda` into ignored local artifacts under `out/identity-inventory/`.

## Deliberately fake / fixture / local-only

- [ ] `hydration-receipts.jsonl` currently uses doc/file receipts, not real hydrated JoelClaw transcript receipts.
- [ ] The ShitRat graph is a hand-shaped prototype graph, not a discovered complete graph.
- [ ] Deployment manifests are desired-state examples, not observed runner state.
- [ ] `workflow-plan.json` is a receipt/config artifact; generated workflow code is not executed.
- [ ] Local Git artifact repos mimic Cloudflare Artifacts but are not Cloudflare Artifacts yet.
- [ ] Identity inventory is metadata-only and incomplete until every host has an observed runner receipt and content-pack extraction rules.

## Next safe TODOs

- [ ] Turn the metadata inventory into candidate `identity-pack`, `soul-pack`, `tools-pack`, `skills-pack`, `memory-pack`, `actor-runtime-pack`, and `access-pack` review items for Joel approval.
- [ ] Add recorded/fixture JoelClaw hydration receipts so stochastic candidate lanes can be tested without private network access.
- [ ] Add a tailnet pull-runner proof that leases a dream job, queries JoelClaw/Typesense locally, and pushes sanitized receipts back to the artifact bundle.
- [ ] Add explicit scrub/leak checks for artifact files before any Cloudflare publish.
- [ ] Add per-item review decisions to the local artifact flow without applying real system changes.
- [ ] Add forward/rollback patch generation against a sandbox copy only.
- [ ] Add validation output and apply receipts for sandbox-only accepted items.

## Blocked until explicit approval

- [ ] Cloudflare deploy of this dream prototype.
- [ ] Real Cloudflare Artifacts publish for dream bundles.
- [ ] Discord/Slack/DM review notification using real tokens.
- [ ] GitHub PR output from dream lanes using ShitRat GitHub capability leases.
- [ ] Any real system Brain, prompt, skill, or global ShitRat mutation.
- [ ] Cron/scheduled dreams.
- [ ] Public authenticated JoelClaw bridge or any raw Typesense exposure.

## Hard rule

The dream surface stays stochastic. The safety envelope stays deterministic. Do not convert the whole dream into a fixed DAG just to make the code feel tidy. Tidy-but-wrong is still wrong. 🐀
