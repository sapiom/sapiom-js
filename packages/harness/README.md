# Agent Studio

Agent Studio is a local web app for building on Sapiom with your own coding agent.

```bash
npx @sapiom/agent-studio@latest [dir]
# supported direct implementation command:
npx @sapiom/harness@latest [dir]
# also available via the Sapiom CLI (npm i -g @sapiom/cli @sapiom/harness):
sapiom dev [dir]
```

One command checks your environment, signs you in, and opens Agent Studio
with your coding agent (Claude Code or Codex) running in an embedded
terminal — pre-wired with the Sapiom MCP servers and an agent-authoring
system prompt, in whatever project directory you choose.

## What you get

- **Terminal sessions** — your agent, your subscription, your machine; the
  Agent Studio only configures it. The `+` beside a project starts a session at
  that project root; the tab-strip `+` starts a sibling session. Sessions have
  resumable chat history.
- **Agents rail** — agent projects (`sapiom.json`) discovered and
  tracked, with one-click local test run, deploy, production run, and
  open-in-Sapiom actions. How that discovery is rooted and bounded, how a
  newly-created agent gets registered, and how a stale entry leaves:
  [docs/agent-discovery.md](docs/agent-discovery.md).
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

Project bootstrap adds content-free `project_bootstrap.*` lifecycle events, and
navigation distinguishes `agent_map.entered` from `session.switched`. These
events contain bounded project/session/attempt identifiers, retry ordinals,
queue depths, outcomes, and error codes only. They never contain prompts,
assistant text, source text, local paths, connector payloads, secrets, or raw
provider errors. Hook projections reduce session-start source to a fixed enum,
model identity to a presence boolean, and usage to allowlisted, clamped token
counters; arbitrary provider strings and usage fields remain local.

## Outbound requests

Agent Studio makes one Sapiom request of its own, separate from telemetry
(above), from the calls your own actions make (sign-in, Deploy, Prod Run), and
from what its other components do on their own (the app's product analytics, and
`npx @sapiom/mcp@latest` fetching and running the local MCP server each session):

Project bootstrap makes no additional network request. Its attempt
coordination, durable input ordering, and lifecycle persistence stay inside the
local server. Existing outbound surfaces remain the system-prompt fetch below,
the coding agent's ordinary provider traffic, and opt-in telemetry.

- **System prompt, on every session start** — an unauthenticated
  `GET https://api.sapiom.ai/v1/harness/system-prompt`, so the Studio conventions
  your coding agent is told about can improve without you upgrading this package.
  It sends no session content, no identifiers and no API key, and it is _not_
  gated on the telemetry opt-in — it fetches configuration rather than reporting
  usage. It is bounded at 5 seconds and falls back to the prompt bundled in this
  package on any failure, so an offline session behaves exactly as before.
  `SAPIOM_HARNESS_PROMPT_FETCH_DISABLED=1` (or `true`) skips the request entirely
  and always uses the bundled prompt.

## Development

```bash
pnpm --filter @sapiom/harness dev        # server (tsx) on :4100
pnpm --filter @sapiom/harness dev:web    # Vite dev server, proxies to :4100
pnpm --filter @sapiom/harness build      # server (tsc) + SPA (vite) → dist/
```

Architecture: a single Node process (Express + ws + node-pty) serves the built
SPA, a small REST API, terminal WebSocket streams, and the local telemetry
ingest endpoint. The interface contract lives in `src/shared/types.ts`.

### Project sessions and Agent Map bootstrap

Every session whose working directory resolves to a Studio project is an
ordinary writable coding session with the same server-derived
`{ projectId, userId, sessionId }` principal, project-agent prompt appendix, and
Agent Map tools. Assignment or bootstrap metadata is context only and cannot
change the prompt profile, tools, filesystem policy, or implementation
authority.

Clicking a project name opens its durable Agent Map without creating, resuming,
focusing, or prompting a session. Every tab represents one real session ID and
opens that session's ordinary conversation and Canvas/Steps experience. A new
project's first ordinary session is initially titled **Plan Agents**; the title
does not confer a role and can be renamed like any other session.

When a new project gains its first active root binding, Studio durably schedules
one evidence-first map bootstrap for that first session. The model reads the
current map and uses the same structured tools available to every project
session. It only proposes an initial map while the durable map remains
meaningfully empty. Attempt IDs, retry ordinals, readiness and model-turn
timeouts, terminal outcomes, and input-delivery acknowledgements survive
restart. Real user input has priority: an initial prompt prevents bootstrap
from starting, and later input preempts a pending or still-staged attempt. If
the bootstrap Enter may already have crossed the PTY boundary, the user input
is durably accepted and held until a correlated completion or process restart
proves that turn cannot overlap; prompts are never concatenated or blindly
interleaved. Opening the map never schedules bootstrap.

Bootstrap state lives under
`<state-root>/agent-map/project-bootstrap/`. Valid pre-upgrade session metadata
and queue files are read and normalized without changing the session ID,
provider binding, working directory, title, transcript, or Canvas. Malformed or
ambiguous legacy identity is retained and rejected safely rather than deleting
or duplicating the session. Retired record strings live only in dedicated,
tested migration decoders. Live clients use the generic session routes.

#### Embedder migration

The public `HarnessSession.agentMapIdentity` is now the exported
`ProjectAgentSession { projectId, userId, sessionId }`. Embedders must stop
reading legacy authority fields; those fields no longer describe live
authority. Persisted pre-upgrade project-session data is migration input only.
Read the optional `projectBootstrap` field when displaying bootstrap lifecycle
state. If an embedder already owns the first prompt for a session, set
`initialUserInputPending: true` in that session's `CreateSessionRequest`; this
content-free flag makes project bootstrap yield before launch and never changes
the session's authority or tools.

The browser/host token gates `/api` routes and is never injected into a coding
agent PTY. Each PTY instead receives session-bound ingest and Agent Map
capabilities. Project scope is re-derived from trusted server state before every
launch or resume; capabilities rotate on resume, revoke on exit or principal
change, expire when inactive, and fail closed outside their project.

### Agent Map MCP

Studio exposes a stateful Streamable HTTP MCP endpoint at `/mcp/agent-map` for
the coding-agent processes it launches. `POST` initializes and calls the
protocol; `GET` and `DELETE` support the protocol's live stream and session
shutdown. This route is separate from the browser-token-protected `/api`
surface. It requires a Studio-issued bearer capability scoped to one trusted
project/session identity; callers cannot supply or change that identity.

Studio injects the capability privately at process launch. Successful use
renews its inactivity lease, while session exit, resume rotation, signed-in
principal changes, and server shutdown revoke it. Consumers should not copy,
persist, log, or reuse the capability outside the launched session.

Every project session receives the same project-wide tools:

- `agent_map_read` reads the current confirmed workspace and shared proposal.
- `agent_map_validate` validates one complete operation batch without mutating
  shared state or allocating permanent IDs.
- `agent_map_propose` atomically and idempotently applies one validated batch
  to the shared Proposed map.
- `build_plan_read` reads the current plan or one exact immutable historical
  version.
- `build_plan_validate` previews the same strict request accepted by apply
  without writing state or consuming IDs.
- `build_plan_apply` atomically appends an idempotent plan version using exact
  expected map and plan references.
- `build_plan_rebase` moves the current plan between exact map versions using
  explicit remap or removal resolutions.

The map and plan use append-only immutable histories with optimistic
concurrency. Roles, assignment completeness, proposal state, and focused brief
availability never determine whether a session may use these tools or write
code. See [`docs/shared-build-plan.md`](docs/shared-build-plan.md) for the
version, replay, rebase, and reserved brief-storage contracts.

HTTP contracts that need more than a type to use are written up under `docs/`:

- [`docs/agent-canvas-graph.md`](docs/agent-canvas-graph.md) — the session-free
  `GET /api/workflows/:path/graph` Canvas route keyed by an agent's path.
- [`docs/workspace-system-graph.md`](docs/workspace-system-graph.md) — the
  Project dependency-graph endpoints, lifecycle states, cache signal, warnings,
  and `system-graph.changed` event.

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
