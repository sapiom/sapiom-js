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
  Agent Studio only configures it. Multiple sessions, resumable chat history.
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

Project planner sessions add content-free `planner_session.*` and
`planner_greeting.*` lifecycle events. Those events contain bounded project,
session, attempt, resolution, queue-depth, and error-code fields only. They never
contain planner prompts, assistant text, local paths, or provider error text;
the same telemetry opt-in controls whether they leave the machine. Planner hook
projections reduce session-start source to a fixed enum, model identity to a
presence boolean, and usage to allowlisted, clamped token counters; arbitrary
provider strings and usage fields remain local.

## Outbound requests

Agent Studio makes one Sapiom request of its own, separate from telemetry
(above), from the calls your own actions make (sign-in, Deploy, Prod Run), and
from what its other components do on their own (the app's product analytics, and
`npx @sapiom/mcp@latest` fetching and running the local MCP server each session):

Planner-session bootstrap makes no additional network request. Its focused
context, automatic empty-map inspection turn, FIFO, and lifecycle persistence
stay inside the local server. Existing outbound surfaces remain the system-prompt
fetch below, the coding agent's ordinary provider traffic, and opt-in telemetry.

- **System prompt, on every session start** — an unauthenticated
  `GET https://api.sapiom.ai/v1/harness/system-prompt`, so the Studio conventions
  your coding agent is told about can improve without you upgrading this package.
  It sends no session content, no identifiers and no API key, and it is *not*
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

### Agent Map planner sessions

The authenticated local API owns planner identity; a model or generic session
request cannot assign itself the `map-planner` role. The public planner surface
is project-scoped:

- `POST /api/projects/:projectId/planner-sessions` with
  `{ "mode": "resume-or-create" }` deterministically reuses the latest owned
  live/resumable planner or creates one. Use `{ "mode": "fresh" }` to always
  create a new planner.
- `POST /api/projects/:projectId/planner-sessions/:sessionId/messages` durably
  accepts planner input and releases it FIFO after startup-turn resolution.
- `POST /api/projects/:projectId/planner-sessions/:sessionId/greeting/retry`
  retries an eligible failed automatic startup turn.

When a newly created planner sees no confirmed revision, active proposal, or
project build plan, it dispatches one server-authored startup turn after CLI
readiness. The planner reads the authoritative map, inspects the project
read-only for existing agents and evidence-backed relationships, validates the
result, and creates a proposal for the user to review. It never confirms or
implements that proposal automatically. Live, resumed, and rehydrated sessions
preserve their prior startup state instead of replaying the turn. The automatic
turn uses the configured planning provider and may consume provider credits; a
real user message takes priority and skips or preempts unfinished startup work.

Planner metadata is part of the session registry. Its input FIFO and greeting
attempt state live at
`<state-root>/agent-map/planner-sessions/<sessionId>/input-queue.json`; corrupt
queue files are quarantined beside that file so one session cannot block boot.
An adjacent content-free `accepted-inputs.json` ledger commits PTY-accepted FIFO
entries before they are removed from the queue, so a failed queue rewrite can
finish after restart without replaying the message. A write-ahead dispatch
intent without that durable acknowledgement is never guessed or automatically
replayed: it is resolved at-most-once with a bounded
`planner_session.input_delivery_uncertain` event, then later FIFO entries may
continue. A PTY write and a filesystem write cannot provide true exactly-once
delivery without an idempotent external acknowledgement.
When vendor resume falls back to a replacement planner, the whole coordinator
directory is atomically handed to that exact successor before it can receive
input. A later replacement follows the queue-owning predecessor while its
focused rehydration brief may still come from an older recorded ancestor, so a
pre-ready exit cannot orphan or duplicate accepted FIFO work.

The focused system context contains only bounded project/session identity,
current workspace pointer IDs, and binding references. The current workspace
store does not yet own revision, proposal, or build-plan detail records, so
their bounded digest, summary, status, and warning slots are honestly
`null`/empty until those records land. Local root paths and source inventories
are never included.

The browser/host token gates every `/api` planner route and is never injected
into a coding-agent PTY. Each PTY instead receives a random `/ingest` capability
bound to its exact session ID; presenting it with another event `sessionId` is
rejected, it grants no `/api` authority, and it is rotated or revoked with the
process lifecycle. A vendor resume pointer is pinned to one harness session;
only a short-lived, one-shot `/clear` or `/resume` transition observed on the
trusted terminal/input path may rotate it, and a pointer already owned by
another harness session is always rejected. Current and rotated pointers are
reserved in a server-private, SHA-256-keyed, mode-`0600` sidecar next to the
session registry; raw historical aliases never enter a browser DTO. Planner
reuse and input additionally require the session cwd to remain one of the
project's current active root bindings and its owner to match the live signed-in
identity (or stable machine-local principal while signed out).

**Migration note (breaking):** `POST /api/sessions` now rejects unknown fields,
including client-authored planner metadata. Generic
`POST /api/sessions/:id/input`, `POST /api/sessions/:id/resume`, and
`POST /api/sessions/adopt` reject planner sessions. Adopt also returns a
bounded `AGENT_SESSION_IDENTITY_RESERVED` 409 for any ordinary current-owner
conflict or durable historical alias (including a pre-`/clear` or
pre-`/resume` identity), before probing or spawning an agent.
Clients must open, message, and retry planners through the project-scoped
routes above. Generic coding-agent sessions also use the durable vendor-ID pin;
their only rotation exception is the same trusted `/clear`/`/resume` gesture.
On upgrade, if legacy `sessions.json` rows contain the same vendor resume
pointer, the first persisted row keeps it and later duplicate rows are repaired
to `agentSessionId: null`. This does not delete the provider's transcript or
conversation history, but the losing local row can no longer resume or adopt
that fenced identity. Start a fresh session in the losing row's directory to
continue there.

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

Every trusted Agent Map role receives the same three project-wide tools:

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
