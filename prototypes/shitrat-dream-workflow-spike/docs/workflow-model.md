# Dream Workflow Model v0

Dreams are dynamic workflows, not static memory reports.

## Core shape

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

The dream surface is the ranked/classified candidate set plus receipts. The workflow rig assembles lanes around that surface.

## Stochastic surface, deterministic safety envelope

A dream must stay stochastic. If we pre-enumerate the whole dream as fixed states, we kill the useful part: weird connection-making across machines, projects, failures, prompts, skills, access, and memory.

The deterministic part is only the safety envelope:

- receipt requirements,
- capability leases,
- artifact commits,
- per-item review gates,
- forward/rollback patches,
- validation output,
- final run status.

The stochastic part is data: generated/proposed `phaseId`s, `laneId`s, graph edges, candidate memories, and workflow lanes. The runner can constrain mutation without pretending the dream itself is a static DAG.

## Near-term + long-term memory

A useful dream deliberately moves between two memory horizons:

- **Near-term**: recent active sessions, fresh operator corrections, current repo state, current project Brain, recent failed/working flows.
- **Long-term**: the full JoelClaw/Typesense indexed transcript substrate across machines.

Near-term context explains the immediate problem. Long-term history prevents recency from becoming fake truth.

## Dynamic assembly

A dream can flow in and out of:

- system memory: ShitRat/Pi Brain, prompts, skills, extension behavior, model policy, URL handoff law,
- active projects: repo docs/code/issues, project Brain, review surfaces, deploy targets,
- capabilities: prompt/skill/script/access/memory bundles that produce a named behavior,
- deployment lanes: sandbox validation, preview deploys, smoke tests, rollback checks.

The classifier decides which lanes exist. A system correction might produce:

- a system Brain patch lane,
- a project docs/code patch lane,
- a prompt/skill component-pack lane,
- a Cloudflare Sandbox validation lane,
- a private review/approval lane,
- a rollback lane.

The plan is pinned into `workflow-plan.json` before execution.

## ShitRat deployment arm

The workflow rig is an arm of ShitRat, not a separate SaaS brain.

Implications:

- It inherits ShitRat actor policy, source-grounding rules, receipt shape, and rollback law.
- It has controlled access to JoelClaw/Typesense for scout/hydration work.
- It does not print or store plaintext secrets in Artifacts, review payloads, events, or logs.
- It uses task-scoped secret leases and commits only lease metadata/receipts.

## Typesense / tailnet access model

Cloudflare Workers should not be assumed to live inside the tailnet. Private MagicDNS/tailnet addresses are not a safe default from Workers.

Reasonable access patterns:

1. **Preferred first cut: tailnet pull worker.** A ShitRat runner inside the tailnet polls/leases Cloudflare workflow jobs, uses local JoelClaw/Typesense directly, and pushes receipts back to Artifacts.
2. **Public authenticated JoelClaw bridge.** Expose a narrow HTTPS API, protected by service tokens/HMAC/Access. Workers call that bridge for scout/hydration.
3. **Cloudflare Tunnel / Workers VPC.** Run `cloudflared` near JoelClaw/Typesense and expose only a narrow internal service through Cloudflare access controls.
4. **Tailscale Funnel.** Possible for public HTTPS exposure, but it is public edge exposure, not “Cloudflare joined the tailnet.” Treat it as another authenticated bridge option.

Do not expose raw Typesense directly if JoelClaw can enforce query shape, redact secrets, and return transcript receipts.

Current tailnet Typesense facts:

```txt
TYPESENSE_URL=http://panda:8108
alternate: http://panda.tail7af24.ts.net:8108
avoid: https://panda.tail7af24.ts.net:8108
```

Typesense serves plain HTTP on port `8108`; HTTPS fails there because that port is not TLS. Local ShitRat runners may load these values from `~/.config/system-bus.env`. Never print the key.

## Apply / deploy / rollback law

Accepted improvements should run lanes, not just write notes:

1. build forward patch,
2. build rollback patch,
3. check current target hash,
4. apply to sandbox or branch,
5. run validation/deploy smoke,
6. present review result,
7. approve, merge/apply, or roll back,
8. write apply/rollback receipts to Artifacts.

System lanes are sharper knives than project lanes. They require per-item approval and rollback receipts before touching Brain, prompts, skills, or deployed ShitRat component packs.
