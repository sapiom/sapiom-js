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

Project bootstrap adds content-free `project_bootstrap.*` and
`project_agent.identity_*` lifecycle events. They contain bounded project,
session, attempt, retry, queue-depth, and error-code fields. Prompts, assistant
text, local paths, and provider error text remain local. The same telemetry
opt-in controls whether lifecycle events leave the machine. Project hook
projections reduce session-start source to a fixed enum, model identity to a
presence boolean, and usage to allowlisted, clamped token counters; arbitrary
provider strings and usage fields remain local.

## Outbound requests

Agent Studio makes one Sapiom request of its own, separate from telemetry
(above), from the calls your own actions make (sign-in, Deploy, Prod Run), and
from what its other components do on their own (the app's product analytics, and
`npx @sapiom/mcp@latest` fetching and running the local MCP server each session):

Project bootstrap adds no separate network endpoint. Its state, durable input
FIFO, and recovery stay inside the local server. The initial map seed uses the
coding agent's ordinary provider traffic and existing project tools.

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

### Project sessions and Agent Map navigation

Every coding-agent session in a project uses the same writable
`ProjectAgentSession { projectId, userId, sessionId }` identity and common
project instructions. Map access comes from that trusted identity. Roles and
agent assignments do not grant a separate kind of session or capability.

Click the project name to open its shared Agent Map without starting a coding
agent. Conversation tabs identify exact sessions, and selecting a session
restores its own terminal and Canvas. The map selection and agent Steps
view remain independent of the selected conversation. There is no pinned
planning-session tab; existing session titles and conversations are preserved.

The authenticated local API resolves project identity from durable project
roots. New sessions, resume, and transcript adoption use the generic session
routes. Resuming a project session revalidates its current signed-in owner and
active root binding before launching a process. Nested coding-agent directories
resolve to their containing project instead of inventing duplicate roots.

**Migration note (breaking):** `HarnessSession.agentMapIdentity` now contains
only project, user, and session IDs. Stop branching on its former `role` or
`assignment` fields. Valid persisted legacy metadata is normalized while
preserving the session/provider IDs, cwd, title, transcript, and Canvas;
conflicting or malformed authority fails closed. Optional `projectBootstrap`
is lifecycle metadata, not an authority or session type. On upgrade, the server migrates legacy startup queues into the durable bootstrap
FIFO. The old planner-session create, message, and retry routes are removed.
Use the ordinary `/api/sessions` create, resume, and input routes.

When Studio opens a new project, it schedules one automatic first conversation,
named **Plan Agents**, to seed an evidence-supported Agent Map. The catalog
outbox and first-session claim keep this lifecycle recoverable across restart.
The complete coordinator handles readiness, interrupted delivery, retries,
user-input preemption, and shutdown before another turn may be sent. Existing
projects are not enrolled merely by reading their map.

`POST /api/sessions` accepts the content-free
`initialUserInputPending: true` hint when the caller owns the first prompt.
Client-authored authority and other unknown fields are rejected. The browser
still submits that prompt to the returned exact session after readiness.

The browser/host token gates `/api` routes and is never injected into a
coding-agent PTY. Each PTY receives a separate `/ingest` capability bound to its
session ID. Vendor resume pointers remain pinned to one harness session;
current owners and durable historical aliases cannot be adopted into another
session. Duplicate persisted provider IDs are repaired conservatively during
boot, preserving the first owner and clearing the later duplicate pointer.

### Project contract helpers

`@sapiom/harness` exports immutable map, plan and brief record types, exact-version
references, strict codecs and canonical digest helpers for offline validation.
For example, use `parseProjectBuildPlanVersion` to validate a plan record and
`computeBuildPlanSemanticDigest` to compare its authored meaning independently
of timestamps or attribution. These data contracts do not require a live session
or an active MCP tool. Store and tool activation are separate integrations.

`BuildPlanId`, `ArchitectureSourceRef`, `AgentMapRevisionId`,
`AgentBriefVersionRecord`, and `computeArchitectureGraphDigest` are supported
aliases for the corresponding neutral plan, map and brief contracts; they do
not introduce a second data model.

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

Every trusted project session receives the same three project-wide tools:

- `agent_map_read` reads the current confirmed workspace and shared proposal.
- `agent_map_validate` validates one complete operation batch without mutating
  shared state or allocating permanent IDs.
- `agent_map_propose` atomically and idempotently applies one validated batch
  to the shared Proposed map.

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
