# Prototype Deletion Contract

Prototype code is a learning instrument, not an asset.

## Required lifecycle

1. **Question** — one question only.
2. **Spike** — fastest useful throwaway path.
3. **Capture** — write the answer to `.brain/` or `docs/`.
4. **Checkpoint** — commit the captured prototype state before starting a new question.
5. **Decision** — delete, absorb by rewrite, or run one more spike.
6. **Tombstone** — if not deleted immediately, add a dated deletion trigger.

## Prototype README template

```md
# Prototype: <name>

Status: active | captured | delete-after:<date>

## Question

What one thing does this answer?

## Run

\`\`\`bash
pnpm prototype:<name>
\`\`\`

## Success signal

What output proves the question is answered?

## Capture target

Where the learning will live after this code dies.

## Delete/absorb rule

When this prototype must be deleted or rewritten into production code.
```

## Checkpoint and next-prototype rule

When a prototype answers its question, checkpoint it before the next question. If the next question changes the core axis, create a new `prototypes/<name>/` instead of mutating the old spike.

Mutate the same prototype only when the work is truly the same question deepening or a receipt fix. Examples: fixing the same real-run substrate, adding validation for the same pipeline, or tightening the same dry harness.

Spin up a new prototype when the question changes. Examples: moving from reader → verifier to lease broker, Durable Object capsule actor, generated-machine policy gate, multi-sandbox fan-out, or Wzrrd review UX.

## Promotion rule

Never promote prototype code by moving files into `src/`.

Acceptable promotion path:

1. capture the answer
2. write production interfaces in `src/`
3. reimplement only the winning shape
4. delete the prototype

## Why so strict?

We are dogfooding workflow systems. If the system cannot preserve learning while deleting spike code, it is lying about memory. 🐀
