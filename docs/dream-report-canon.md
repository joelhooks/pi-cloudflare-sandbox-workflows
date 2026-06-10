# Dream Report Canon

This is the canonical shape for Dreaming HITL output.

A dream report is not an audit log with prose sprinkled on top. It is a human review surface. The job is to help Joel decide what to accept, hold, reject, or turn into work without decoding the artifact graph first.

Use this for future system, project, kernel, package, and memory-distillation dream runs.

## Source pattern

Current source pattern:

```txt
prototypes/system-dream-review-ui/
```

Current live receipt:

```txt
https://dream-hunt-2026-06-09-998d4b.wzrrd.sh/
```

Current renderer/template seed:

```txt
joel/tufte-mdsvx@0.1.0
```

Current production-intended rendering seam:

```txt
wzrrd.report.render -> hash-pinned static files
wzrrd.site.publish -> leased side-effect publish
```

`src/app/infrastructure/cloudflare-wzrrd-publish-adapter.ts` accepts a `primaryDocumentRenderer` for package-style report renderers. The default renderer is `joel/static-tufte-mdsvx-preview@0.1.0`: it renders a safe static preview from a hash-pinned `text/mdsvx`/markdown artifact, preserves the canonical source file beside `review-surface.json`, writes `report-rendering.json` with the actual renderer/template/source metadata, and does not pretend to be a full SvelteKit/MDSvX compiler. A real `@joelhooks/wzrrd-hitl-report` package can replace this renderer without owning Wzrrd publication.

When a Wzrrd primary document declares a template, the publish payload carries the template id/version/format/noindex/default-expiry/renderer hint, the publisher verifies `text/mdsvx` frontmatter declares the matching template label, and the published delivery receipt records the renderer id that actually produced `index.html`.

## Required order

Dream reports must render in this order:

1. **Run context**
   - Plain headline.
   - One or two short paragraphs saying whether the run is actionable.
   - Tiny stat line: run id, dream count, receipt count, expiry/status.
   - One margin note only if it protects privacy or explains a boundary.

2. **The actual dreams**
   - This is the first item of interest.
   - Every dream gets a human-readable review card.
   - Do not call this section `Candidate review`.
   - Do not make the human scroll through proof before seeing the dreams.

3. **What to do with these dreams**
   - Short synthesis after the dream cards.
   - Say what to accept, hold, reject, or turn into work.
   - Keep it under three paragraphs.

4. **Actionable line items**
   - Optional rollup when multiple dreams point at the same work item.
   - Use the same Three-R shape.
   - Link back to the specific dream receipt.

5. **Proof**
   - State-machine figure.
   - Dynamic-generation proof level.
   - Run coverage.
   - Receipt counts.
   - What this does not prove.

6. **Technical appendix**
   - Adapter shape.
   - Report-node contract.
   - Artifact schema.
   - Anything useful for agents but not needed for the first human decision.

## Dream card contract

Each dream card must include:

```txt
title
summary
reasoning
rating
recommendation
receipt metadata
```

The user-visible card should read like this:

```txt
Build the memory lease boundary.

Build the memory lease boundary. Cloudflare can run the work, but JoelClaw and
Typesense access need to stay behind a trusted relay.

Reasoning
This is the highest-signal dream. It points at the runtime boundary that decides
whether Cloudflare becomes useful or becomes a credential leak machine.

Rating
10/10

Recommendation
Accept. Turn this into the next engineering task: a leased memory port plus
trusted relay.

Receipt: hunt-system-shitrat-deployment-arm.
Call: accept direction.
Evidence: 7 Typesense chunks, 1 hydrated JoelClaw session.
Target: .brain/resources/memory-distillation-dreams.svx.
```

Receipt metadata should be visually secondary. It proves the card is worth review. It is not the main event.

## HITL decision receipt

The report is review input. The human call is a separate artifact:

```txt
dream.hitl-decision.v1
```

Use this when Joel accepts, holds, rejects, or turns a dream/proposal into work. Do not bury acceptance inside report prose or a Slack reply.

Every `dream.hitl-report.v1` JSON artifact must carry `hitlDecisionContract`. The contract points at the package schema export, suggested decision artifact path, valid decision target kinds, and which decisions must seed the next generated workflow. The MDSvX should also mention the decision contract in the "What to do" section so the human sees the call-to-action before the proof maze.

Each decision records:

```txt
decision id
target kind: dream-card or refinement-proposal
target id/title
decision: accept, hold, reject, or turn-into-work
summary
reasoning
rating
recommendation
receipt trail
source refs
reviewer actor
```

Accepted or work-conversion decisions must also feed the next generated workflow seed. The seed needs planner instructions, source refs, required capability kinds when relevant, and Brain/package/workflow/schema/report/capability update targets.

The next artifact after a ready seed is a follow-up run request draft:

```txt
dream.hitl-follow-up-run-request.v1
```

That draft wraps a normal `workflow.run-request.v1` body, records the seed ref and update targets, and sets `submitted: false`. It is planner input, not execution. Submission still goes through the normal front door, generated machine proof, capability leases, review gates, and receipts.

Held and rejected decisions should not silently seed future work. They stay as review receipts until their blocker changes.

## Three Rs

Every dream and rollup item uses the Three Rs:

| Field          | Job                                                                    |
| -------------- | ---------------------------------------------------------------------- |
| Reasoning      | Why this dream matters, in plain human language.                       |
| Rating         | How strong the dream is as a decision input. Use `10/10`, `8/10`, etc. |
| Recommendation | The human call: accept, hold, reject, or turn into work.               |

Ratings are not confidence scores. They are review usefulness scores.

Examples:

```txt
10/10 = accept and build next
8/10 = accept as policy or design pressure
6/10 = useful, but needs proof before promotion
5/10 = hold; likely idea, weak evidence
```

## Voice

Use Joel-style report prose:

- Short paragraphs.
- Direct language.
- No fake warmth.
- No academic proof maze before the human decision.
- Use profanity only if it clarifies the actual problem.
- Say what the system did, not what Joel thinks unless Joel said it.

Good:

```txt
This is the highest-signal dream.
Good idea, weak proof.
The dream can put work on the table; it does not get to silently patch the system.
```

Bad:

```txt
The artifact demonstrates a potentially valuable candidate for future memory
surface optimization across dynamic workflow substrates.
```

That is artifact fog. Do not ship that shit to a human reviewer.

## Proof rules

Proof belongs below the dreams.

The proof section should answer:

- What artifacts changed the output?
- How many events/receipts supported the run?
- Was there hydrated evidence?
- Was the state machine generated, plan-derived, or hand-authored?
- What is not proven yet?

Do not overclaim.

If the run only proves dynamic evidence-driven lane assembly over a static theme/pattern library, say that. Do not call it a generated XState workflow machine.

For a generated-machine claim, require:

```txt
planner prompt/transcript receipt
workflow.xstate-machine.v1 config artifact
workflow.dynamic-plan.v1 binding machine states -> steps -> package exports/adapters
verification contract
artifact hashes
verifier acceptance
D2 figure generated from the pinned machine artifact
```

Generated TypeScript source is optional inspection output. It is not required for runtime execution.

## Layout rules

- Use the Tufte/MDSvX report pattern.
- Use margin notes sparingly for privacy and boundary notes.
- A margin note without an explicit `href` must not render a `back`, arrow, or fake source link.
- Use D2 for workflow/state-machine figures.
- In MDSvX, wrap the D2 source fence in `D2Fig` with `aspectRatio`, `machineId`, `sourceKind`, `stateCount`, and `transitionCount`. The fenced `d2` source remains the canonical fallback; the component metadata gives the Wzrrd renderer the readable aspect ratio and proof metadata.
- The report JSON must carry a D2 source hash plus a generated-machine binding: machine artifact ref/hash, generated machine source ref/hash, and binding status. A report that cannot bind its figure back to the pinned `workflow.xstate-machine.v1` artifact should not claim `generated-machine`.
- Pick the readable aspect ratio. Do not force horizontal or vertical layout.
- Keep public Wzrrd reports `noindex` and expiring by default.

## Anti-patterns

Do not:

- Put `Candidate review` before the dreams.
- Make artifact ids the card titles.
- Start with the state-machine diagram.
- Start with proof.
- Hide recommendations under tables.
- Publish raw transcript paths, local absolute paths, secret refs, or token-bearing strings.
- Treat public Wzrrd as the canonical artifact.

## Canonical sections

Use these headings unless the report has a concrete reason to vary:

```txt
# This dream found work to do.

The actual dreams
What to do with these dreams
Actionable line items
Report node
Workflow state machine
Dynamic generation proof
Run coverage
Access adapter shape
Report standard
What did not happen
```

The exact headline can change. The order should not.
