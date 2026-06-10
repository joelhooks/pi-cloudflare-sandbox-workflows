# ShitRat Operating Graph Artifacts

This belongs in `pi-cloudflare-sandbox-workflows`, not a separate dream app.

## Thesis

ShitRat is a connected graph of **prompts, skills, scripts, access, capabilities, and memory**.

The Cloudflare workflow rig is the deployment/control arm for that graph: it can assemble dynamic workflow lanes, validate component changes in sandboxes, publish artifact versions, and coordinate node runners on Blaine, Panda, Flagg, and Cloudflare workflow runtimes.

## Dreams are dynamic workflows

A dream is not a report, a search query, or a static batch of proposed memories.

A dream is a **dynamic workflow** that crawls through near-term and long-term session history, connects dots across machines and projects, ratifies or rejects remembered flows, and sorts candidate core memories.

Important correction: the dream itself should stay **stochastic**. It can invent phases, propose strange graph edges, and assemble unexpected workflow lanes. The deterministic part is the safety envelope around mutation: receipt requirements, capability leases, review gates, artifact commits, validation, rollback, and final status. A fixed dream-state enum defeats the point.

Useful lifecycle:

```txt
crawl sessions
  -> hydrate transcript receipts
  -> connect dots across machines/projects/time
  -> classify candidate memories and flow corrections
  -> rank by repetition, recency, severity, and source diversity
  -> assemble workflow lanes
  -> review per item
  -> apply/deploy/test accepted changes
  -> approve or rollback
```

Near-term memory is the last few active sessions and recent friction. Long-term memory is the full JoelClaw/Typesense transcript substrate. A good dream deliberately moves between both: recent context explains the immediate problem; long-term history prevents recency from becoming fake truth.

Dream output should therefore be a workflow artifact:

```txt
dream-runs/<run-id>/crawl-plan.json
dream-runs/<run-id>/hydration-receipts.jsonl
dream-runs/<run-id>/candidate-core-memories.jsonl
dream-runs/<run-id>/flow-ratifications.jsonl
dream-runs/<run-id>/workflow-plan.json
dream-runs/<run-id>/review-decisions.json
dream-runs/<run-id>/patches/*.diff
dream-runs/<run-id>/rollback/*.diff
dream-runs/<run-id>/apply-receipts/*.json
```

The dream surface feeds dynamic workflows. It is not the final memory.

## Memory split

ShitRat's broad memory substrate is JoelClaw/Typesense:

```txt
JoelClaw/Typesense = full indexed session history across machines
JoelClaw hydration = raw transcript receipts for durable claims
Cloudflare Artifacts = distilled core memories + deployable component graph
Brain/SVX = human-readable review/durable memory surface
```

Artifacts should not duplicate every transcript. They should store **core memories** distilled by dream loops: accepted, versioned, source-backed claims with pointers back to JoelClaw transcript receipts.

## Graph nodes

```txt
prompt        system/developer/project prompt layers and prompt templates
skill         Pi skills and runbooks
script        CLIs, glue scripts, cron jobs, local tools, worker handlers
access        secret refs, service tokens, GitHub app installs, tailnet routes, Cloudflare bindings
capability    named thing ShitRat can do by combining prompts/skills/scripts/access/memory
memory        core memories, Brain notes, JoelClaw/Typesense indexes, transcript receipts, source maps
workflow      dynamic workflow patterns, XState machines, lane plans, verification contracts
host          blaine, panda, flagg, Cloudflare workflow runtime
artifact      component pack versions, snapshots, dream runs, deployment receipts
```

## Graph edges

```txt
capability -> uses -> prompt|skill|script|access|memory
skill -> reads -> memory
script -> requires -> access
workflow -> runs -> capability
artifact -> versions -> prompt|skill|script|memory|workflow
artifact -> deploys_to -> host
host -> observes -> artifact
memory -> supports -> candidate dream item
dream item -> proposes_patch -> artifact|memory|prompt|skill|script|workflow
receipt -> proves -> edge or node
```

Receipts are not decoration. They are what keeps graph changes from becoming vibes with JSON cosplay.

## Artifact families

### ShitRat snapshot

Top-level provenance record for the familiar/workflow graph.

```txt
shitrat-snapshots/<snapshot-id>/manifest.json
shitrat-snapshots/<snapshot-id>/graph/nodes.json
shitrat-snapshots/<snapshot-id>/graph/components.json
shitrat-snapshots/<snapshot-id>/graph/capabilities.json
shitrat-snapshots/<snapshot-id>/graph/memory.json
shitrat-snapshots/<snapshot-id>/graph/access.json
shitrat-snapshots/<snapshot-id>/graph/edges.jsonl
shitrat-snapshots/<snapshot-id>/graph/deployments.json
shitrat-snapshots/<snapshot-id>/receipts.jsonl
```

### Core memory pack

Accepted distilled memories from dream loops.

```txt
memory-packs/core-memory-pack/pack.json
memory-packs/core-memory-pack/memories.jsonl
memory-packs/core-memory-pack/source-receipts.jsonl
memory-packs/core-memory-pack/graph-edges.jsonl
memory-packs/core-memory-pack/summaries/core-memory.md
```

Each memory row should include:

```txt
memoryId
claim
scope: system | project | capability
status: active | superseded | contradicted | archived
confidence
sourceReceiptIds[]
affectedGraphNodes[]
createdByDreamRunId
artifactCommitSha
```

### Component packs

Small versioned units validated and deployed independently.

```txt
component-packs/system-prompt-pack/
component-packs/skills-pack/
component-packs/scripts-pack/
component-packs/access-pack/
component-packs/capabilities-pack/
component-packs/extensions-pack/
component-packs/joelclaw-index-pack/
component-packs/workflow-patterns-pack/
component-packs/runner-config-pack/
```

### Deployment manifests

Desired vs observed state per node.

```txt
deployments/blaine/desired.json
deployments/blaine/observed.json
deployments/blaine/apply-plan.json
deployments/blaine/receipts.jsonl

deployments/panda/desired.json
deployments/flagg/desired.json
deployments/cloudflare-workflows/desired.json
```

## Deployment model

First deployment path should be pull/lease based:

```txt
publish pack
  -> validate in sandbox or local runner
  -> register pack version
  -> assemble rollout plan
  -> write desired deployment manifest
  -> node runner pulls/leases work
  -> pre-apply hash check
  -> apply patch/config
  -> smoke test
  -> report observed state + receipt
  -> approve or rollback
```

Do not start with blind remote mutation. Blaine/Panda/Flagg know their local filesystem, auth, tailnet, and rollback constraints.

## Named prototype

This docs/design migration is captured under:

```txt
prototypes/shitrat-dream-workflow-spike/
```

Question:

```txt
Can a Dream be modeled as a dynamic workflow that crawls near-term and long-term session history, hydrates transcript receipts, connects dots, ratifies flows, sorts core memories, and emits artifact-backed review/apply/rollback lanes for the ShitRat operating graph?
```

Future success output:

```txt
out/latest-receipt.json
out/artifacts/<run-id>/manifest.json
out/artifacts/<run-id>/crawl-plan.json
out/artifacts/<run-id>/hydration-receipts.jsonl
out/artifacts/<run-id>/candidate-core-memories.jsonl
out/artifacts/<run-id>/flow-ratifications.jsonl
out/artifacts/<run-id>/workflow-plan.json
out/artifacts/<run-id>/review-decisions.json
out/artifacts/<run-id>/graph/nodes.json
out/artifacts/<run-id>/graph/components.json
out/artifacts/<run-id>/graph/capabilities.json
out/artifacts/<run-id>/graph/memory.json
out/artifacts/<run-id>/graph/access.json
out/artifacts/<run-id>/graph/edges.jsonl
out/artifacts/<run-id>/deployments/*/desired.json
out/artifacts/<run-id>/patches/*.diff
out/artifacts/<run-id>/rollback/*.diff
out/artifacts/<run-id>/apply-receipts/*.json
out/artifacts/<run-id>/summaries/review.md
```

No deployment yet. The point is to make the graph concrete enough that dynamic dream/workflow lanes can propose component-pack, memory-pack, capability, access, and deployment changes against it.
