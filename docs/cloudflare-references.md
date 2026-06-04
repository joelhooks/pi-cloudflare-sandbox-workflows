# Cloudflare References

## Runtime substrate

- **Sandbox** runs real Linux container processes. Use for Pi CLI, git, installs, test runs, and long-ish bounded execution.
- **Durable Objects** should own capsule/run lifecycle, locks, active sandbox handle, streaming, and cancellation.
- **D1** should hold queryable control-plane state and indexes.
- **R2** should hold large blobs and eventually snapshots/backup bundles.
- **Artifacts** should hold versioned file trees and outputs.

## Key links

- Sandbox concepts: `https://developers.cloudflare.com/sandbox/concepts/sandboxes/`
- Sandbox lifecycle: `https://developers.cloudflare.com/sandbox/api/lifecycle/`
- Sandbox GA post: `https://blog.cloudflare.com/sandbox-ga/`
- Sandbox auth/outbound Workers: `https://blog.cloudflare.com/sandbox-auth/`
- Artifacts concepts: `https://developers.cloudflare.com/artifacts/concepts/how-artifacts-works/`
- Artifacts + Sandbox SDK example: `https://developers.cloudflare.com/artifacts/examples/sandbox-sdk-artifacts/`
- Artifacts best practices: `https://developers.cloudflare.com/artifacts/concepts/best-practices/`
- Dynamic Workers: `https://blog.cloudflare.com/dynamic-workers/`
- Dynamic Workflows: `https://blog.cloudflare.com/dynamic-workflows/`
- Secrets Store: `https://developers.cloudflare.com/secrets-store/`

## Current design reads

- Sandbox IDs are compute handles, not durable identity.
- Artifacts repo/ref is the durable filesystem memory.
- Workflow runs should use a tiny active concurrency cap and destroy/sleep aggressively.
- Outbound Workers are the long-term place for network-level credential injection. Kody-style placeholders are the app-level equivalent.
- Cloudflare Secrets Store is too small/static for full Pi OAuth blobs, but useful for root keys or small reusable secrets.

## First dogfood rule

Do not build a pretty Cloudflare UI first. The first valuable slice is a bounded workflow run that returns receipts and outputs.
