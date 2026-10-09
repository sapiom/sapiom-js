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

Assistant summaries use the existing `/api/state` seed and `/ws/events` full snapshots. The browser preserves the last known state as uncertain until a validated current socket snapshot arrives; account changes clear it immediately. Summaries contain activity and pending counts only.

Session tabs and retained-session rows show independent Assistant activity. Hover or use the accessible label for Working, Waiting for input, Checking status or Unavailable. Terminal output keeps its existing pulse; an idle Assistant has no success badge. See the [native acceptance record](docs/assistant-background-acceptance.md) for the combined integration checks.

## What you get

- **Terminal sessions** — your agent, your subscription, your machine; the
  Agent Studio only configures it. The `+` beside a project starts a session at
  that project root; the tab-strip `+` starts a sibling session. Sessions have
  resumable chat history. See [Sessions](#sessions).
- **Templates** — quick starts, the template gallery, and bundled starters use
  your selected coding agent.
- **Rail** — agent projects (`sapiom.json`) discovered and tracked, each with
  its sessions. Click a project to open its map. How that discovery is rooted
  and bounded, how a newly-created agent gets registered, and how a stale entry
  leaves: [docs/agent-discovery.md](docs/agent-discovery.md).
- **Project view** — the project's Agent Map, computed from its code, a floating
  card for the picked agent, a per-project map chat, the project's App Links in its header, and an
  agent modal with the agent's Canvas, Runs, Secrets, Run and Deploy. See
  [The project view](#the-project-view).
- **Zero config mutation** — everything is injected per-session via flags;
  your global agent settings are never touched.

## The project view

Click a project on the rail. The centre shows its Agent Map at full width. A
card floats over the map's bottom-right corner; it never changes the map's
width.

| You pick                                   | The card shows                                                                                                                                                                                                   |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nothing (the project)                      | One composer, **Ask about this project**                                                                                                                                                                         |
| An agent                                   | One row: the agent's name, **Deployed** or **Draft**, **Open agent** (↗ icon), and **Open in Finder** (folder icon; Windows: **Show in Explorer**; Linux: **Open folder**). Below it, **Ask about &lt;name&gt;** |
| An agent Studio's agent list does not hold | The same row without the two buttons, and the composer                                                                                                                                                           |

Escape or a click on the empty map returns the card to the project. Double-click
an agent node to open it, the same as **Open agent**.

Open in Finder reveals the agent's folder in the OS file manager. In the desktop
app it goes through the app's bridge; in a browser it calls
`POST /api/fs/reveal`, which accepts only a registered agent folder.

### App Links in the project header

After the project name and **Agent Map**, the header carries the map's ref
selector (in a git project) and refresh ([Agent Map](#agent-map)), then lists
the project's App Links:

- each linked agent's published App Link, labelled with the agent's name;
- each dev server a live session of this project started, as
  `localhost:PORT · not deployed`.

There is no separate Preview chip. Limits: dev-server links live in the page, so
a reload forgets them until a session announces one again; a session that
starts two dev servers lists only the latest. Detection reads the coding
agent's tool calls (Claude Code or Codex): any `localhost:PORT` in a tool call's
input or output becomes a link, even one that is not a server, except Studio's
own ports. A server started
in the terminal outside a tool call (for example with `!`) is not detected.

### Map chat

Press Enter in the card's composer to ask the project's **map chat**. It is an
Assistant conversation (OpenCode on `gpt-luna`, see [Assistant](#assistant))
that belongs to the project:

- It is not a session and never appears on the rail.
- Every question extends the same conversation, across node picks and while
  it is minimized, until you press **New chat**. It survives a restart. Each
  project has its own.
- Each message carries a chip naming the selection it was asked about
  ("Asking about …"); the node's name, kind and path go into the prompt.
- The chat opens in the card, over the map. **Stop** (the send button while a
  reply streams) interrupts the answer. **Minimize** (the minus icon, or
  Escape) shrinks the chat to a **Map chat** row beside the zoom controls, below
  the picked node's header when there is one; that row brings the same
  conversation back. There is no close: **New chat** starts over.
- **Open in session** (the terminal-square icon) starts a new terminal session
  at the project root whose first message points at an attached `map-chat.md`
  holding the transcript and the selection, then shows that session.

The map chat's OpenCode process starts on the first question in a project and
stops after 15 minutes with no open request.

**What the map chat can do.** Read the project and call the hosted Sapiom
tools. It never edits files: OpenCode's `edit`, `write` and `apply_patch` tools
are removed from its tool list, and any change request (add or edit a step, an
agent, a file or a setting; fix, build or create) becomes a
[hand-off](#hand-off-card).

**What it cannot do.**

- It has no shell. The `bash` tool is removed from its tool list.
- It never asks for a permission. Every rule that would ask (files outside the
  project, `.env` reads, repeated identical tool calls, questions) is denied,
  because the map chat has no way to reply to a prompt.
- When a request needs any of those, or changes anything, it offers a
  **hand-off** instead of doing it.

### Hand-off card

A hand-off is a card in the map chat with a title, the prompt the chat wrote
for the job, and **Start session**. The map chat offers one on its own for the
work above, and when you ask for it.

**Start session** creates a Claude Code terminal session at the project root
with that prompt as its first message. Adding a project to Studio marks its root
as trusted for Claude Code, so this session (and **Open in session**) starts
without the "Do you trust the files in this folder?" dialog, including in
projects added earlier. The session appears on the rail and its
row pulses once. Nothing navigates: you stay on the map with the chat open. The
card then shows **Open session**, which takes you to it.

### Agent modal

**Open agent** opens a modal over the map. The rail and a margin of the map stay
visible. Closing it (×, Escape, or a click on the scrim) returns you to the map
exactly as you left it: the same pick and the same map chat. The modal has no
breadcrumbs. Its tabs are **Canvas | Runs | Secrets**.

- **Canvas** — the agent's step graph, rendered from source by the agent's path
  through the session-free graph route
  ([docs/agent-canvas-graph.md](docs/agent-canvas-graph.md)). No session is
  needed. Click a step for a small card with its description, inputs, outputs,
  and what it calls; a launched child agent opens in place.
- **Runs** — the agent's runs, newest first. Pick one for its workspace:
  timeline, result, and the attempt inspector for a picked attempt.
- **Secrets** — the values this agent's runs receive, by name: **Add secret**
  or **Import .env**. Values are write-only. Before the agent is linked, they
  are held on this machine, injected into local runs, and uploaded when it
  deploys.
- Header: the agent's name and **Draft** or **Deployed** ("Deployed {when}"
  only for a deploy watched in the current tab), then icons labelled on hover:
  **`</>`** (integration snippets), **Visualize** (re-read the graph),
  **Run locally**, **Run** (production) and **Deploy**, with progress beside
  them. **Run** needs a
  signed-in account and a ready cloud build; **Deploy** needs a signed-in
  account. A disabled verb says why on hover. The run picker sits on the
  board's header.
- **`</>`** — for a deployed agent with a ready cloud build, the integration
  snippets (TypeScript SDK and cURL). Otherwise it says why, e.g. "Deploy
  &lt;name&gt; first. Its snippets appear once it has a ready cloud build."
  Escape closes it before the modal.

Every verb is addressed by the agent's path. No verb needs a session, starts
one, or binds one. Runs are filed under the agent. The actions that need a
coding agent each start a new Claude Code session at the project root, whose
first message names the agent, and open it:

- Every prompt from the Canvas (the chat panel's Ask, Explain this step, Debug
  this step, Why slow / stuck?, and Ask coding agent to fix on a render error)
  is sent as an **ask**: the session is told to answer from the agent's source
  and change no files unless you ask. Fix and debug are not told apart from an
  ask. Ask coding agent to fix still gets a fix, because its own text asks for
  one; after Debug this step, tell the session to make the fix if you want it.
- Describe with AI sends its own prompt, which edits the agent's descriptions.

The run workspace's Focus mode and the **Prod** globe were removed (SAP-3875).
A run started from a session's terminal (for example, the coding agent calling
the local run tool) is not filed under an agent, so neither the Runs tab nor the
run picker lists it.

## Sessions

A session is one Claude Code or Codex terminal, usually at a project root. Its
view opens on **Terminal**. Studio does not bind a session to an agent (the
one exception is the draft build that **Start from an idea** creates), and
nothing about an agent sits beside a session: agent detail lives in the
[agent modal](#agent-modal). The server no longer binds a new session to an
agent it finds under the session's folder.

To end a live session, press **×** on its rail row or **End session** in the
session menu. It ends at once, with no confirmation. The row stays, marked
exited; **×** on the exited row hides it, and History keeps it.

Uninstall: `rm -rf ~/.sapiom/harness` (all harness-owned state lives there).

## Assistant

The Assistant is Studio's own chat view, an OpenCode conversation on Sapiom's
`gpt-luna` model. It powers the [map chat](#map-chat) and the **Assistant**
side of a session's **Terminal | Assistant** switch. It is separate from the
Claude Code or Codex conversation in the terminal.

**Who has it.** The Sapiom backend grants the Assistant to a browser sign-in
(not an API-key-only login) on harness 0.16 or later, for a user with a verified
email who is a current member of the signed-in organization, when the PostHog
flag `studio-opencode-assistant` is on for that user. There is no internal-account
or email-domain requirement. The flag is on for everyone, so every user who meets
those requirements has the Assistant and the map chat; it stays as the kill
switch. Without access,
the project card shows no composer and sessions show no switch; Terminal works
as before. Each Assistant turn is `gpt-luna` spend on the signed-in account's
organization.

Studio browser sign-in also stores a renewable user credential for
Assistant eligibility checks. Existing organization-only logins keep working for
Terminal; sign out and sign in again to obtain the user credential. It stays in
the shared local credential store and is never returned by Studio's browser auth
API. Sign-out clears it locally and attempts to revoke its token family remotely.

The Studio host refreshes the Assistant capability at most every 30
seconds and expires an enabled decision within 60 seconds. Missing identity,
offline startup, unsupported backends, and unavailable flags leave it off.
These access checks are independent of optional telemetry and never prevent
ordinary Terminal startup. The browser receives only the resolved boolean and a
random, process-memory `authorityRevision`; it never receives principal fields,
credentials, identity hashes, or grant diagnostics. The revision stays stable
through polling, reconnects, transient retention, and renewed leases for the
same authority. A verified principal crossover or actual revocation, denial,
expiry, or sign-out rotates it before the new state is observable. Disabled
responses carry the current retirement barrier, and repeated disabled polls do
not rotate it. Browser draft stores use this opaque boundary to prevent text
from crossing authorities without persisting it.

After a successful check, timeout, network, or HTTP 5xx failures from credential
or capability refresh may retain that exact grant only while its original lease
and observed user credential remain unexpired. A transient failure never moves
either expiry. Sign-out, credential expiry, API key/environment/tenant/user
change, an authentication rejection, an explicit `assistant: false`, or a
malformed/ambiguous response revokes the grant. Thus an offline first launch
cannot invent eligibility, while a short outage does not interrupt an unchanged
verified principal before the server-issued lease ends.

Eligible users see a **Terminal | Assistant** switch, with Terminal
selected initially. Assistant sends prompts and streams Sapiom responses in the
selected project. Returning to a session reopens its OpenCode conversation;
switching views detaches the display while execution continues. Connection errors
offer **Reconnect**, which reloads history without resending accepted prompts.
Initial attachment and reconnect synchronize status after a real native event
frame. Newer activity wins over old status snapshots; disconnecting or detaching
the display invalidates outstanding status/history reads.
History catch-up uses one active read and bounded follow-ups. Disconnecting the
display cancels queued reads; failed or malformed reads preserve visible history.
Native updates and removals received during a history read survive its response.
Queued stream frames preserve completed content, and history merging preserves
newer execution status.
After a stream gap, Assistant retains visible output and shows **Catching up…**
until native history or a complete stream update repairs its text baseline.
Disconnecting also cancels outstanding catch-up requests before reconnection.
Attachment and reconnect also reconcile pending permissions and questions.
Assistant shows **Waiting for input** for current pending requests; failed request
reads retain last-known state while the status remains uncertain.
Event transport scopes each frame to the authorized conversation and cancels
its reader and status catch-up when the browser connection ends.
The shared observer module derives activity and pending-request counts without
storing transcript content or issuing execution commands.
Host observation starts after an authorized conversation attaches and ends with
runtime retirement. Reading summaries never launches inactive conversations.
This first slice includes basic tool status; richer controls arrive separately.
An unconfirmed response keeps the answer and tool results visible as **Stopped**.
Studio hides its internal completion markers even if the model supplies an
incorrect turn ID, including extra markers inside a confirmed answer.
Literal prose and invalid marker syntax remain visible. Incomplete marker
candidates are hidden while streaming and restored when the response ends.
After automatic answer recovery, Studio reconnects the conversation's event
stream to reconcile history and status while keeping the chat and draft visible.
Studio actions reveal Terminal after a foreground CLI prompt is accepted; a
rejected send shows its error and keeps the selected view. Unsent chat text is
keyed by authenticated principal and Studio session above the centre pane, so it
survives Terminal/Assistant and session switches, reconnects, exited-session
views, and temporary New Session or past-session review navigation. It is never
persisted: actual Assistant-access retirement, authority crossover, sign-out,
session deletion, and page/app reload clear the applicable in-memory draft.
Same-authority renewals, polls, and reconnects retain it. Conversation view is
a separate, unpersisted mount-local preference: Terminal is the initial/reset
view, while a foreground CLI prompt accepted by Studio explicitly reveals it.
Background actions keep the selected view. A failed UI access poll retains the
open draft for at most 60 seconds after the last success; explicit
revocation/sign-out takes effect immediately when observed. The host continues
enforcing its own capability expiry independently.

The current `@assistant-ui/react-opencode` integration stays behind
`OpenCodeChat`, the host-to-UI adapter. The host exposes only the shared,
strictly parsed transport-error contract; the adapter selects trusted static
copy and maps its bounded actions to the existing sign-in, Settings, Terminal,
or reconnect surfaces. Replacing the pinned UI library means replacing that
adapter, not changing the host association/runtime protocol or adopting native
events directly. Confirmed missing native history leaves the Studio session and
record intact and opens Terminal; it never fabricates Continue/Resume or a new
native conversation.

The Assistant's model and remote MCP requests use a Studio-owned local bridge.
Its short-lived runtime credential is separate from browser authentication;
Studio adds the Sapiom key only when forwarding to the configured services.
Production sends Responses API requests to `https://router.sapiom.ai/v1/responses`
with the explicit `gpt-luna` model and the signed-in account's `x-api-key`. Luna uses
low reasoning effort and streams both tool calls and answers. Responses are not
stored by the provider; encrypted reasoning travels with native conversation
history. Other environments must explicitly set `services.llm` to a router origin
that supports `/v1/responses` in the matching credentials-file environment entry;
Studio never falls back from a custom environment to production.

Studio owns each Assistant runtime for the authorized session and working
directory. Browser detachment leaves it running; sign-out, access revocation,
and Studio shutdown stop it. Runtime state is isolated by user, organization,
session, and directory under `~/.sapiom/harness/opencode`. A process lock prevents
two Studio hosts from opening the same runtime state concurrently.

Transport failures use fixed, credential-free codes and copy. HTTP responses
carry a nested typed error; an already-open event stream receives the same error
as a host-generated `studio.error` before closing when possible. Native events
cannot claim that host-only type. Ordinary native events require matching
session IDs, including every nested ID. The only session-less native failure
converted to a terminal Studio error is a Sapiom provider-auth error received
from the currently bound runtime and authority with an exact authorized-directory
envelope; unknown, conflicting, stale-runtime, and differently scoped events are
dropped. Reconnect reattaches and reloads history; it never replays an accepted
prompt or tool call.

The Studio session record remains authoritative for session identity, project,
and working directory. Its authority-scoped runtime directory owns a versioned
`association.json` sidecar that maps that Studio session to one native
conversation. The host serializes creation and atomic commit under the same
lifecycle that owns the native runtime; browser mounts do not own the mapping.
Retirement, sign-out, missing native history, and transient lookup failures do
not delete or replace it. A native 404 is reported as confirmed unavailable,
while network and other transport failures remain retryable; neither path
creates a second conversation. There is no implicit legacy scan or cleanup in
this correction: a future migration adapter must validate both identities,
commit a versioned mapping atomically, preserve the old history until verified,
and make cleanup an explicit post-migration operation.

The rail's cloud icon marks an agent as deployed once Studio confirms a ready
hosted build. Failed checks silently retain the last confirmed indicator, and changing
accounts clears this evidence. Retained indicators do not enable cloud runs.

Codex receives the generated remote Sapiom and local `sapiom-dev` MCP
configuration on every session launch and resume. Studio uses session-specific
server names such as `sapiom-dev-<session suffix>` and identifies them in the
agent's instructions. This keeps existing Codex MCP registrations intact and
avoids inheriting old credentials or conflicting transports from a server with
the same name. Credentials are passed through Codex's environment and cleared from
shell-tool environments; they never appear in command arguments. Authoring-process
settings stay on the MCP server. Studio does not write to your Codex `config.toml`. If a generated MCP
file cannot be read or parsed, the session reports an error so you can start a
new session to regenerate it.

## Telemetry

With explicit opt-in, Agent Studio collects usage events (prompts, tool calls,
session lifecycle) to improve Sapiom. Opt out any time; `--no-telemetry`
disables collection entirely. Events are also written locally to
`~/.sapiom/harness/events.ndjson` for your own inspection.

Identity migration adds content-free `project_agent.identity_*` lifecycle
events. Navigation distinguishes
`agent_map.entered` from `session.switched`. These events contain bounded
project/session/attempt identifiers, retry ordinals, queue depths, outcomes, and
error codes only. Prompts, assistant text, source text, local paths, connector
payloads, secrets, and raw provider errors remain local. The same telemetry
opt-in controls whether lifecycle events leave the machine. Hook projections
reduce session-start source to a fixed enum, model identity to a presence
boolean, and usage to allowlisted, clamped token counters; arbitrary provider
strings and usage fields remain local.

## Outbound requests

Agent Studio makes two Sapiom requests of its own, separate from telemetry
(above), from the calls your own actions make (sign-in, Deploy, Prod Run), and
from what its other components do on their own (the app's product analytics, and
`npx @sapiom/mcp@latest` fetching and running the local MCP server each session):

- **System prompt, on every session start** — an unauthenticated
  `GET https://api.sapiom.ai/v1/harness/system-prompt`, so the Studio conventions
  your coding agent is told about can improve without you upgrading this package.
  It sends no session content, no identifiers and no API key, and it is _not_
  gated on the telemetry opt-in — it fetches configuration rather than reporting
  usage. It is bounded at 5 seconds and falls back to the prompt bundled in this
  package on any failure, so an offline session behaves exactly as before.
  `SAPIOM_HARNESS_PROMPT_FETCH_DISABLED=1` (or `true`) skips the request entirely
  and always uses the bundled prompt.
- **Platform authoring rules, on every session start** — an unauthenticated
  `GET https://api.sapiom.ai/v1/agents/authoring-rules`, inlined into the
  session's copy of the `sapiom-agent-authoring` skill so a change to Sapiom's
  platform rules reaches your coding agent without you upgrading. Same terms as
  the system prompt: no session content, identifiers or API key, not gated on
  telemetry, bounded at 5 seconds, and on any failure the session gets the
  skill bundled in this package. The skill's last line says which it got
  (`source: served` or `source: bundled`). `SAPIOM_AUTHORING_RULES_FETCH_DISABLED=1`
  (or `true`) skips the request.

## Development

```bash
pnpm --filter @sapiom/harness dev        # server (tsx) on :4100
pnpm --filter @sapiom/harness dev:web    # Vite dev server, proxies to :4100
pnpm --filter @sapiom/harness build      # server (tsc) + SPA (vite) → dist/
```

Architecture: a single Node process (Express + ws + node-pty) serves the built
SPA, a small REST API, terminal WebSocket streams, and the local telemetry
ingest endpoint. The interface contract lives in `src/shared/types.ts`.

### Codex MCP validation

The ordinary unit and server tests cover launch/resume conversion, login and
credential refresh, logout, and error reporting. To verify actual tool discovery
with an installed Codex CLI, build the harness's workspace dependencies, then
run the opt-in test:

```bash
pnpm --filter "@sapiom/harness^..." build
RUN_CODEX_MCP_INTEGRATION=1 pnpm --filter @sapiom/harness exec vitest run src/core/adapters/codex-mcp.integration.test.ts
```

The test runs the `codex` binary found on `PATH`. Set `CODEX_TEST_BINARY` to the
path of a different installed version to test that one instead.

This test uses a temporary Codex home, the built `sapiom-dev` server, and local
HTTP fixtures. It requires no Codex login or model request and checks both a
fresh home and an existing configuration with conflicting server registrations.
It also checks that command environments exclude MCP credentials and the Electron
launch flag while preserving unrelated user shell settings.

### Project sessions

Every session whose working directory resolves to a Studio project is an
ordinary writable coding session with the same server-derived
`{ projectId, sessionId }` identity and the project-agent prompt appendix. Its persisted `userId` field is attribution only (`local:<machineId>`
for new identities, or the account at creation) and is never compared with the
signed-in account. Session metadata is context only and cannot change the
prompt profile, tools, filesystem policy, or implementation authority.

Clicking a project name opens its Agent Map without creating, resuming,
focusing, or prompting a session. Every tab represents one real session ID and
opens that session's ordinary conversation; agent detail is in the
[agent modal](#agent-modal), not beside the session. Sessions
created before this change may still carry the **Plan Agents** title of the
retired automatic first session; the title does not confer a role and can be
renamed like any other session.

Empty projects have no inline first-agent creation button, including after a
session ends. Use the project's session shortcut or its menu to start work;
warnings about separate checkouts that were not searched remain visible.

Opening or adding a project never starts a session. Sessions saved by older
installs with project-bootstrap metadata load as ordinary sessions: the metadata
is dropped on load and the session ID, provider binding, working directory,
title, transcript, and Canvas are unchanged. Files left under
`<state-root>/agent-map/project-bootstrap/` and
`<sessions file>.subsession-bindings.json` are no longer read and can be
removed. Malformed or ambiguous legacy identity is retained and rejected safely
rather than deleting or duplicating the session. Retired record strings live
only in dedicated, tested migration decoders.

#### Embedder migration

The public `HarnessSession.agentMapIdentity` is now the exported
`ProjectAgentSession { projectId, userId, sessionId }`; `userId` is attribution,
not authority. Embedders must stop reading the removed `role` and `assignment`
fields; those fields no longer describe live authority. `AgentMapToolEvent.role`
is also removed; consumers use neutral project, session, tool, and outcome
fields. Persisted pre-upgrade project-session data is migration input only.
`HarnessSession.projectBootstrap` is removed; opening or adding a project
creates no session (the user's first idea starts the first session). If an embedder already owns the first prompt for a session, set
`initialUserInputPending: true` in that session's `CreateSessionRequest`; this
content-free flag never changes the session's authority or tools.

Creating an agent is two requests, in this order: `POST /api/agents/scaffold`
`{ root, name, template? }` creates the agent in the project (a 409 duplicate
or 400 invalid name is the refusal; nothing starts), then `POST /api/sessions`
opens one ordinary session in the project folder. To deliver the first task
as part of that session's creation, send `initialPrompt` with optional
`initialAttachments`, `initialSources` (URLs, handed over as text and never
fetched by the harness) and `initialSetup` (instructions the harness appends
after the user's words, shown in Studio as a collapsed setup disclosure) in
`CreateSessionRequest`. Attachments accept `{ kind: "path", path }` references
or inline `{ kind: "inline", filename, dataUrl }` data. The first turn is
composed in one order (`buildFirstPrompt`): idea, attached files, linked
sources, setup. There is no session-side `scaffold` option and no English
scaffold prompt on any creation path. Adapter authors receive the composed
turn as `LaunchOpts.initialPrompt` on fresh launches; resume does not replay
it. Embedders that configure their own HTTP body parser can use the
exported `CREATE_SESSION_JSON_LIMIT_BYTES` for this route. Session creation
and attachment uploads each allow 30 requests per minute in independent
buckets.

The browser/host token gates `/api` routes and is never injected into a coding
agent PTY. Each PTY instead receives session-bound ingest capabilities. Project scope is re-derived from trusted server state before every
launch or resume; capabilities rotate on resume, revoke on exit, expire when
inactive, and fail closed outside their project. Signing in or out does not
revoke a session's capabilities. Disconnecting an account only restarts
credential-bearing runtimes without the removed key; the session ID and
conversation are preserved.

### Project contract helpers

`@sapiom/harness` exports the project map's types (`AgentMap`, `MapSystem`,
`MapAgent`, `MapEdge`, `ProjectMapResponse`). The stored map's record types,
codecs, digest helpers and version references are removed with the stored map.

For offline prompt composition, `PROJECT_AGENT_PROMPT_APPENDIX` and
`projectAgentPromptAppendix()` provide the common Studio project guidance. These
supported exports let an embedder reuse Studio's instructions without starting
a server. Use the returned string as prompt content; its wording evolves with
Studio guidance.

The build-plan, brief, focused-context and sub-session delegation exports are
removed, along with their MCP tools.

### Existing projects after an update

The stored Agent Map is removed. Studio no longer reads
`<state-root>/agent-map/projects/` (each project's `workspace.json`,
`initialization.json` and `legacy-reset.json`); those folders can be deleted.
Project identity (`studio-projects.json`) and the current-workspace preference
are unchanged.

### Agent Map

The map is computed from the project's code by `sapiom_dev_map` in
`@sapiom/mcp`, the same tool a coding agent can call; nothing about agents or
edges is stored. `GET /api/projects/:projectId/map` (optionally `?ref=`) runs the
tool's scan in process for the project's folder and returns its output with the
folder's git refs ([`docs/agent-map-api.md`](docs/agent-map-api.md)). While a
map is open, Studio watches the folder and the map reads again after a change.

- **Systems** are agents joined by code-proven launches, events, signals and
  timers, drawn as containers with a name and agent count. Agents in no system
  stand alone. ELK arranges each system (layered) and packs the systems and
  loose agents together (rectpacking); a read with no structural change reuses
  the positions, so nothing moves.
- **Agents** show **Deployed** or **Draft** (from the signed-in account, else the
  agent's `sapiom.json` `definitionId`; no badge when unknown), a dot when the
  agent changed since the drawn ref (at Working copy, since `HEAD`), and the
  resources it shares with another agent as chips.
- **Edges** are only the calls the code proves. Hover one for its kind and the
  file and line that prove it.
- The project bar carries a **ref selector** in a git project (Working copy,
  `HEAD`, branches; the choice is the project's and survives leaving it) and a
  **refresh**.
- Click an agent to show it in the [project card](#the-project-view); **Open
  agent** or a double-click opens the [agent modal](#agent-modal); **Open in
  Finder** opens its folder. An agent folder Studio's agent list does not hold is
  named on the card without those actions, and the map header says why.

Opening a map loads the bundled ELK worker (about 1.6 MB raw / 467 kB gzip). If
arrangement fails, **Retry layout** tries again.

HTTP contracts that need more than a type to use are written up under `docs/`:

- [`docs/agent-canvas-graph.md`](docs/agent-canvas-graph.md) — the session-free
  `GET /api/workflows/:path/graph` Canvas route keyed by an agent's path.
- [`docs/agent-map-api.md`](docs/agent-map-api.md) — the project map route, its
  reload event, and the removed stored-map routes and tools.

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
