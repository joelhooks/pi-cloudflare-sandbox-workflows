# Dream Workflow Artifact Format v0

Agent-first means another agent can inspect, diff, replay, and apply the run without trusting prose.

## Files

```txt
manifest.json                         current run truth: id, scope, focus, status, refs
crawl-plan.json                       query/facet/machine plan for near-term + long-term session crawl
snapshot.json                         optional ShitRat operating graph snapshot manifest
workflow-plan.json                    pinned dynamic workflow lanes assembled from candidate classification
events.jsonl                          append-only lifecycle events
candidate-core-memories.jsonl         proposed distilled memories, not accepted truth yet
flow-ratifications.jsonl              remembered flows accepted/rejected/contradicted by receipts
hydration-receipts.jsonl              JoelClaw transcript hydration receipts
items.jsonl                           candidate memory/change items for review
receipts.jsonl                        deduped source receipts
review-decisions.json                 per-item operator decisions
patches/<item-id>.diff                forward patch for an accepted item
rollback/<item-id>.diff               inverse patch for item-level rollback
apply-receipts/<item-id>.json         old/new hashes, validation, and apply receipt
summaries/review.md                   generated human review surface seed
summaries/commit-message.md           generated commit message seed
```

## Scope

Every run and item carries a `scope`:

- `project`: candidates improve the current repo/product docs, code, review UX, scoring, or issues.
- `system`: candidates improve ShitRat/Pi/global operating memory: Brain, prompts, skills, extension behavior, or cross-project rules.
- `capability`: candidates improve one named ShitRat capability and its prompt/skill/script/access/memory dependencies.
- `mixed`: schema-legal only when the review UI can separate approvals by scope.

Do not smuggle project TODOs into system memory. That is how memory turns into wet cardboard.

## Workflow law

Dreams are dynamic workflows, not static memory batches. The artifact pins the assembled plan in `workflow-plan.json` before execution.

Core shape:

```txt
crawl sessions
  -> hydrate transcript receipts
  -> connect dots across near-term and long-term memory
  -> classify candidate memories and flow corrections
  -> rank by repetition, recency, severity, and source diversity
  -> assemble workflow lanes
  -> review per item
  -> apply/deploy/test accepted changes
  -> approve or rollback
```

Generated workflow code is not trusted runtime code. It is a receipt/config until a constrained executor validates it.

Do not freeze dreams into a fixed lifecycle enum. The artifact should preserve stochastic `phases[]` and `lanes[]` proposed by the dream, while the runner enforces only the deterministic safety envelope: receipts, leases, review gates, artifact commits, rollback, validation, and final status.

## Memory law

```txt
JoelClaw/Typesense = broad episodic memory / full indexed transcript history / scout retrieval
JoelClaw hydration = raw transcript receipts for durable claims
Cloudflare Artifacts = distilled core memory / accepted graph state / deployable components / rollback receipts
Brain/SVX = human-readable durable memory surface generated from or linked to the artifact graph
```

Artifacts store accepted core memories and pointers back to source receipts. They do not duplicate the full transcript substrate.

## Apply law

Auto-apply is allowed only when:

1. the item is explicitly accepted,
2. a forward patch exists,
3. a rollback patch exists,
4. old target hash matches the snapshot or current pre-apply state,
5. an apply receipt is written,
6. validation passes.

If any condition fails, the item fails closed as `needs_rebase`, `needs_more_evidence`, or `blocked`.
