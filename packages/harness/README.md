# Agent Studio

Agent Studio is a local workspace for building, testing, deploying, and running
Sapiom agents with Claude Code or Codex.

```bash
npx @sapiom/agent-studio@latest [dir]
```

The optional directory defaults to the current working directory. The command
requires Node.js 20 or newer and at least one supported coding agent on `PATH`:
Claude Code or Codex. It reports environment checks, starts a token-protected
loopback server, and opens the complete local URL in your browser. It does not
install a coding agent, require Sapiom sign-in, or start a coding-agent session
automatically. Sign in before the first cloud action, then choose a folder or
template when you are ready to start a session.

## What you get

- **Terminal sessions** — Claude Code or Codex runs on your machine and account.
  Studio can manage multiple sessions and resume only when the coding agent's
  recorded conversation is still available.
- **Agents rail** — agent projects (`sapiom.json`) discovered and
  tracked, with direct Local Run, Deploy, production run, and
  open-in-Sapiom actions.
- **Canvas** — a deterministic projection generated from the current agent
  source. Studio-generated renders live under `.sapiom/canvas/renders/` and are
  not an authoring surface.
- **Zero config mutation** — everything is injected per-session via flags;
  your global agent settings are never touched.

Local Run replaces `ctx.sapiom.*` calls with configured stubs and creates no
Sapiom capability request or spend. It still runs authored JavaScript on your
machine, including ordinary file, process, and network side effects. Deploy and
production runs require authentication and operate on Sapiom cloud resources.

## Privacy and local state

Detailed prompts, tool calls, and session events are shared only with explicit
opt-in. Product interaction analytics are a separate setting. Normalized
events are written locally whether remote sharing is enabled or not.

Removing `~/.sapiom/harness` removes Harness-owned global state only. It does
not remove project `.sapiom/` directories, shared credentials, or coding-agent
history. Read [Install Agent Studio](https://docs.sapiom.ai/agent-studio/install),
[Account and privacy](https://docs.sapiom.ai/agent-studio/account-and-privacy),
and the [CLI and files reference](https://docs.sapiom.ai/reference/agent-studio)
before deleting state.

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

**E2E live tier** (real agent binary, real pty, no CI). Requires Claude Code
and a valid `SAPIOM_API_KEY` in your environment.

```bash
pnpm --filter @sapiom/harness e2e:live
```
