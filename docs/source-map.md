# Source Map

Source-backed reference list for building Pi sandbox workflows.

## Local project lineage

- Previous proof repo: `/Users/joel/Code/joelhooks/pi-cloudflare-sandbox`
  - proved Cloudflare Sandbox can run real Pi with Codex subscription auth
  - routes: browser terminal, `/api/status`, `/api/pi`
  - not the target UX
- New repo: `/Users/joel/Code/joelhooks/pi-cloudflare-sandbox-workflows`
  - owns contextual workflow architecture and prototype-to-production loop

## Pi receipts

- Pi providers/subscription auth: `/Users/joel/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/providers.md`
- Pi SDK / RPC / print mode: `/Users/joel/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/sdk.md`

## Cloudflare receipts

- Cloudflare Sandbox concepts: `https://developers.cloudflare.com/sandbox/concepts/sandboxes/`
- Sandbox lifecycle/destroy: `https://developers.cloudflare.com/sandbox/api/lifecycle/`
- Sandbox SDK + Artifacts example: `https://developers.cloudflare.com/artifacts/examples/sandbox-sdk-artifacts/`
- Artifacts concepts: `https://developers.cloudflare.com/artifacts/concepts/how-artifacts-works/`
- Artifacts Workers binding: `https://developers.cloudflare.com/artifacts/api/workers-binding/`
- Artifacts Workers get-started: `https://developers.cloudflare.com/artifacts/get-started/workers/`
- Artifacts best practices: `https://developers.cloudflare.com/artifacts/concepts/best-practices/`
- Artifacts limits: `https://developers.cloudflare.com/artifacts/platform/limits/`
- Containers pricing: `https://developers.cloudflare.com/containers/pricing/`
- Containers limits: `https://developers.cloudflare.com/containers/platform-details/limits/`
- Secrets Store overview: `https://developers.cloudflare.com/secrets-store/`
- Secrets Store Workers integration: `https://developers.cloudflare.com/secrets-store/integrations/workers/`
- Secrets Store manage/limits: `https://developers.cloudflare.com/secrets-store/manage-secrets/`
- Workers env var limits: `https://developers.cloudflare.com/workers/platform/limits/#environment-variables`
- Sandbox auth / outbound Workers: `https://blog.cloudflare.com/sandbox-auth/`
- Sandbox GA: `https://blog.cloudflare.com/sandbox-ga/`
- Dynamic Workers: `https://blog.cloudflare.com/dynamic-workers/`
- Dynamic Workflows: `https://blog.cloudflare.com/dynamic-workflows/`

## Claude / Thariq / workflow receipts

Copied local references:

- `sources/thariq/skills-on-demand-tasks-as-dags.md`
- `sources/thariq/claude-agent-sdk-full-workshop-thariq-shihipar.md`

Web references:

- Thariq workflow signal via Digg/X: `https://digg.com/ai/qgxmwxjf`
- Original X article target from Digg: `https://x.com/i/article/2061850535708483585`
- How We Claude Code recap: `https://howborisusesclaudecode.com/recap`
- Vibe Code Camp distilled Thariq notes: `https://davidguttman.github.io/every-vibe-code-camp-distilled/14_thariq_shihipar.html`
- Anthropic dynamic workflows blog: `https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code`
- Inngest patterns overview: `https://www.inngest.com/docs/patterns`
- Inngest durable execution model: `https://www.inngest.com/docs/learn/how-functions-are-executed`
- Inngest flow-control pattern: `https://www.inngest.com/patterns/flash-sales-and-bursty-workflows`
- XState v5 state persistence: `https://stately.ai/blog/2023-10-02-persisting-state`
- XState Store persistence strategies: `https://stately.ai/docs/xstate-store/persist#snapshot-strategy-options`

## Kody secret-management receipts

Repo: `https://github.com/kentcdodds/kody`
Local clone inspected at `/Users/joel/.repo-autopsy/kentcdodds/kody`.

Key files:

- `packages/worker/migrations/0008-secret-buckets.sql`
- `packages/worker/src/mcp/secrets/crypto.ts`
- `packages/worker/src/mcp/secrets/service.ts`
- `packages/worker/src/mcp/secrets/repo.ts`
- `packages/worker/src/mcp/fetch-gateway.ts`
- `packages/worker/src/mcp/secrets/placeholders.ts`
- `packages/worker/src/mcp/secrets/errors.ts`
- `packages/worker/src/mcp/capabilities/secrets/secret-list.ts`
- `packages/worker/src/mcp/capabilities/secrets/secret-set.ts`
- `docs/use/secrets-and-values.md`
- `docs/contributing/secret-host-approval.md`
- `docs/contributing/secret-rotation.md`

## Local prior art

- `joelhooks/pi-workflow-os` — state/evented workflow orchestration, fan-out, structured output, retries, supervision
- `Michaelliv/pi-dynamic-workflows` — Pi extension for generated deterministic JavaScript workflow scripts with `agent`, `parallel`, `pipeline`, phases, structured output, VM sandboxing, abort, and progress display; local clone inspected at `/Users/joel/.repo-autopsy/Michaelliv/pi-dynamic-workflows`
- `joelhooks/pi-discord-threads` — durable external thread mapping + lazy Pi runtime rehydration
- `joelhooks/wzrrd-sh-cli` — static Wzrrd publish API/CLI; `POST https://wzrrd.sh/api/sites` returns `url` and anonymous `claimUrl`
- `vercel-labs/just-bash` — versatile virtual bash environment with in-memory filesystem, shared files across exec calls, custom commands, broad Unix command support, optional JS/Python/sqlite/curl; useful controller/test harness for generated machines and shell-step simulation, not real Pi runtime
- `qaml-ai/pi-worker` — Worker-native reference, not real Pi CLI + Codex subscription runtime
- Cloudflare Artifacts isomorphic-git example — Workers can push commits to Artifacts without a Git binary by pairing `isomorphic-git/http/web` with an in-memory FS; used for plan-phase commits before sandbox creation. Source: `https://developers.cloudflare.com/artifacts/examples/isomorphic-git/`
