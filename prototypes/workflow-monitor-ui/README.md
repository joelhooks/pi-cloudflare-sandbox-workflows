# workflow-monitor-ui

A **local** SvelteKit dashboard for watching deployed workflow runs so the
operator stops `curl`-ing the Worker by hand. It answers three questions at a
glance:

- **Is a run progressing or wedged?** — live status badge + a stale flag when an
  in-flight run hasn't advanced in 90s.
- **Where is it?** — the safety-envelope state and a coarse phase hint
  (planning / executing / gating).
- **Why did it block?** — the blocker `code` + `message` (and step/node when
  present) rendered inline on `blocked` rows.

This app is a dev tool. It runs with `vite dev` and is **never deployed**. The
Worker's runs/admin tokens stay **server-side**: the page only ever calls the
local `/api/*` proxy, and the bearer is injected in the `+server.ts` routes.

## Run it

From the repo root:

```bash
pnpm install                                # once, to link the workspace
pnpm --filter workflow-monitor-ui dev       # http://localhost:5173
```

Build / preview (the server-capable Node adapter is used so the proxy routes
have a runtime when built):

```bash
pnpm --filter workflow-monitor-ui build
pnpm --filter workflow-monitor-ui preview
```

## Configuration

Tokens are read **server-side** from the repo-root `.env.local` (falling back to
`process.env`). Nothing here ships to the browser.

| Variable                   | Required | Default                                                         | Purpose                                                      |
| -------------------------- | -------- | --------------------------------------------------------------- | ------------------------------------------------------------ |
| `WORKFLOW_APP_ADMIN_TOKEN` | yes      | —                                                               | Bearer for `GET /admin/runs` (the run list).                 |
| `WORKFLOW_APP_RUNS_TOKEN`  | yes      | —                                                               | Bearer for `GET /runs/:id/status`, `/events`, `/durability`. |
| `MONITOR_WORKER_BASE_URL`  | no       | `https://pi-cloudflare-sandbox-workflows.joelhooks.workers.dev` | Override the Worker origin (e.g. a local `wrangler dev`).    |
| `MONITOR_ADMIN_TOKEN`      | no       | falls back to `WORKFLOW_APP_ADMIN_TOKEN`                        | Per-monitor admin token override.                            |
| `MONITOR_RUNS_TOKEN`       | no       | falls back to `WORKFLOW_APP_RUNS_TOKEN`                         | Per-monitor runs token override.                             |

The repo-root `.env.local` already carries `WORKFLOW_APP_ADMIN_TOKEN` and
`WORKFLOW_APP_RUNS_TOKEN`, so a plain `pnpm --filter workflow-monitor-ui dev`
works against the deployed Worker with no extra setup.

## Local proxy surface

| Local route                    | Worker upstream            | Token |
| ------------------------------ | -------------------------- | ----- |
| `GET /api/runs?limit&status`   | `GET /admin/runs`          | admin |
| `GET /api/runs/:id/status`     | `GET /runs/:id/status`     | runs  |
| `GET /api/runs/:id/events`     | `GET /runs/:id/events`     | runs  |
| `GET /api/runs/:id/durability` | `GET /runs/:id/durability` | runs  |

The board page (`/`) currently consumes `/api/runs`, polling every 4s. The
per-run status / events / durability proxies are wired and validated for the
next stage (run detail / wedge diagnosis).
