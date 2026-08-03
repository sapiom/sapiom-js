# Agent Studio

Agent Studio is a local web app for building on Sapiom with your own coding agent.

```bash
npx @sapiom/harness [dir]
# also available via the Sapiom CLI (npm i -g @sapiom/cli @sapiom/harness):
sapiom dev [dir]
```

One command checks your environment, signs you in, and opens Agent Studio
with your coding agent (Claude Code or Codex) running in an embedded
terminal — pre-wired with the Sapiom MCP servers and an agent-authoring
system prompt, in whatever project directory you choose.

## What you get

- **Terminal sessions** — your agent, your subscription, your machine; the
  Agent Studio only configures it. Multiple sessions, resumable chat history.
- **Agents rail** — agent projects (`sapiom.json`) discovered and
  tracked, with one-click local test run, deploy, production run, and
  open-in-Sapiom actions.
- **Canvas** — a live pane that renders static HTML your agent writes to
  `.sapiom/canvas/` (visualize your agent, your docs, anything), plus a
  preview mode for dev servers the agent starts.
- **Zero config mutation** — everything is injected per-session via flags;
  your global agent settings are never touched.

Uninstall: `rm -rf ~/.sapiom/harness` (all harness-owned state lives there).

## Telemetry

With explicit opt-in, Agent Studio collects usage events (prompts, tool calls,
session lifecycle) to improve Sapiom. Opt out any time; `--no-telemetry`
disables collection entirely. Events are also written locally to
`~/.sapiom/harness/events.ndjson` for your own inspection.

## Development

```bash
pnpm --filter @sapiom/harness dev        # server (tsx) on :4100
pnpm --filter @sapiom/harness dev:web    # Vite dev server, proxies to :4100
pnpm --filter @sapiom/harness build      # server (tsc) + SPA (vite) → dist/
```

Architecture: a single Node process (Express + ws + node-pty) serves the built
SPA, a small REST API, terminal WebSocket streams, and the local telemetry
ingest endpoint. The interface contract lives in `src/shared/types.ts`.

## Testing

Three tiers — run whatever fits your change:

**Unit tier** (vitest, no browser, no agent): covers server logic, adapters,
analytics, and canvas rendering. Runs in CI on every PR.

```bash
pnpm --filter @sapiom/harness test
```

**Playwright mock tier** (chromium, Vite dev server with `VITE_MOCK=1`, no
harness server or agent process). The full `web/e2e/` suite against the SPA in
mock mode. Runs in CI on every PR. For a fast watch loop locally, use UI mode:

```bash
# One-time browser install (not included in pnpm install):
pnpm --filter @sapiom/harness exec playwright install chromium

# Watch/UI mode — re-runs affected specs on save:
pnpm --filter @sapiom/harness exec playwright test \
  --config web/e2e/playwright.config.ts --ui

# Or run the full suite once (same command CI uses):
pnpm --filter @sapiom/harness test:ui
```

**E2E live tier** (real agent binaries, real pty, no CI). Requires Claude Code
or Codex installed and a valid `SAPIOM_API_KEY` in your environment.

```bash
pnpm --filter @sapiom/harness e2e:live
```
