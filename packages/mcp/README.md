# @sapiom/mcp

The **local developer** MCP server for Sapiom. It runs on your machine over
stdio under the server name `sapiom-dev`. Today it gives a coding agent the
tools to scaffold, test, deploy, and inspect Sapiom agents, and to put a web app
behind a live sandbox URL or a durable App Link; the namespace leaves room for
other developer tooling later.

> **Not the capability surface.** This is _not_ the remote "Sapiom" MCP (the
> hosted connector with `sapiom_sandbox_*`, scrape, search, … capability tools).
> `sapiom-dev` exposes no direct capability tools. Its local check and Local
> Run path uses stubbed capabilities without Sapiom capability spend; deploys,
> cloud builds, production runs, signals, and schedules operate Sapiom cloud
> state and may be metered. See
> [the two Sapiom MCP servers](../../docs/mcp-servers.md) for which to use when.

## Install

No global install — run it on demand with `npx`:

```jsonc
{
  "mcpServers": {
    "sapiom-dev": {
      "command": "npx",
      "args": ["-y", "@sapiom/mcp"],
    },
  },
}
```

In Claude Code:

```sh
claude mcp add sapiom -- npx -y @sapiom/mcp
```

## Configuration

The server targets the `production` environment by default. Override it with the
`SAPIOM_ENVIRONMENT` environment variable:

```jsonc
{
  "mcpServers": {
    "sapiom-dev": {
      "command": "npx",
      "args": ["-y", "@sapiom/mcp"],
      "env": { "SAPIOM_ENVIRONMENT": "staging" },
    },
  },
}
```

- `production` (alias `prod`) → `app.sapiom.ai` / `api.sapiom.ai` — the default.
- `staging` (alias `dev`) → `app.sapiom.dev` / `api.sapiom.dev`.

Both resolve from built-in presets, so no config file is required. A custom
target can be defined in `~/.sapiom/credentials.json` (the server prints the
expected shape if it encounters an unknown environment name).

## Authentication

The first networked call (`link`, `deploy`, `run`, `inspect`, `signal`) needs a
Sapiom API key. Run **`sapiom_authenticate`** and the server opens a browser
login flow, then caches the resulting key per environment in
`~/.sapiom/credentials.json`. After that, tools work without re-authenticating.
`sapiom_status` reports who you're authenticated as; `sapiom_logout` clears the
cached credentials.

The local authoring tools (`scaffold`, `check`, `run_local`) need no Sapiom
authentication. `scaffold` may query npm for current dependency versions;
`check` imports the definition; and `run_local` executes the author's ordinary
local code. Only `ctx.sapiom.*` calls are replaced by stubs, so direct network,
filesystem, environment, and process effects in author code remain real.

## Tools

| Tool                                 | Network          | What it does                                                                    |
| ------------------------------------ | ---------------- | ------------------------------------------------------------------------------- |
| `sapiom_authenticate`                | browser          | Log in and cache an API key for the current environment                         |
| `sapiom_status`                      | —                | Report authentication status                                                    |
| `sapiom_logout`                      | —                | Clear cached credentials                                                        |
| `sapiom_send_feedback`               | ✓                | Relay the user's product feedback to the Sapiom team                            |
| `sapiom_dev_agents_scaffold`         | npm optional     | Create a new agent project; may query npm for current dependency versions       |
| `sapiom_dev_agents_check`            | author code only | Typecheck, import, bundle, and validate the definition and step graph           |
| `sapiom_dev_agents_run_local`        | author code only | Run locally with `ctx.sapiom.*` calls stubbed (no Sapiom capability spend)      |
| `sapiom_dev_agents_link`             | ✓                | Resolve/create the hosted orchestration and cache its id                        |
| `sapiom_dev_agents_clone`            | ✓                | Fork a gallery template (or re-clone a fork) into a local project               |
| `sapiom_dev_agents_deploy`           | ✓                | Bundle current local source, build in the cloud, and wait                       |
| `sapiom_dev_agents_run`              | ✓                | Start a real cloud execution                                                    |
| `sapiom_dev_agents_inspect`          | ✓                | Inspect an execution or build (optionally waiting for it)                       |
| `sapiom_dev_agents_signal`           | ✓                | Resume a paused execution by delivering a signal                                |
| `sapiom_dev_agents_emit_event`       | ✓                | Emit a custom event; starts a run per active `event` trigger on that type (0..N) |
| `sapiom_dev_agents_schedule`         | ✓                | Create a trigger: cron, one-off, event (`eventType`), or webhook (URL + secret) |
| `sapiom_dev_agents_schedule_inspect` | ✓                | Inspect one trigger (with fire history) or list an agent's triggers             |
| `sapiom_dev_agents_schedule_cancel`  | ✓                | Cancel a trigger of any kind (stops all future fires)                           |
| `sapiom_dev_agents_schedule_secret`  | ✓                | Rotate, complete-rotate, or revoke a webhook trigger's signing secret           |
| `sapiom_dev_agents_cron_preview`     | ✓                | Validate a cron expression and preview its next occurrences                     |
| `sapiom_dev_sandbox_configure`       | —                | Write a validated `type: "sandbox"` preview resource into `sapiom.json`         |
| `sapiom_dev_sandbox_check`           | —                | Validate the project's sandbox resources without deploying                      |
| `sapiom_dev_sandbox_preview`         | ✓                | Deploy the app to a sandbox for a live URL that expires with its `ttl`          |
| `sapiom_dev_app_publish`             | ✓                | Publish the same app to a durable App Link (`apps.sapiom.ai/{org}/{slug}`)      |
| `sapiom_dev_app_list`                | ✓                | List the org's App Links: URL, visibility, webhooks, spend cap, wake state      |
| `sapiom_dev_app_settings`            | ✓                | Change a link's `webhooksEnabled`, visibility, spend cap, wake rate limit       |
| `sapiom_dev_app_delete`              | ✓                | Delete a link (URL stops resolving, slug freed); `confirm: true` required       |
| `sapiom_dev_map`                     | optional         | The agent map: systems, agents, steps and the code-proven edges between them    |

A typical loop: `scaffold` → write step code → `run_local` until green → `link`
→ `deploy` → `run` → `inspect`.

For a web app rather than an agent: `sandbox_configure` → `sandbox_preview`
while iterating (a throwaway URL that dies with the sandbox) → `app_publish`
once the link needs to be permanent or shared. `app_publish` reads the same
`sapiom.json` sandbox resource, uploads the source as a stored text-only bundle
(≤ 10 MiB), and returns a durable `https://apps.sapiom.ai/{org}/{slug}` URL that
wakes the app on demand — republishing the same slug updates it in place. See
the `sapiom-sandbox-preview` skill for the routing rules.

Once a link exists, `app_list`, `app_settings` and `app_delete` manage it without
leaving the terminal. Webhooks are **off by default**: `app_settings { slug,
webhooksEnabled: true }` turns them on, after which third parties POST to
`https://apps.sapiom.ai/{org}/{slug}/hook/<path>` (the `/hook` prefix is
stripped and the body forwarded byte-exact, so Slack/Stripe/GitHub signature
checks run inside the app). These settings need the `org.write` permission —
publish authority alone is not enough — and a refusal comes back as a message
naming the permission and the fields, for the agent to relay rather than retry.

## The agent map

`sapiom_dev_map` returns the map Agent Studio draws, computed from code on every
call; nothing about agents or edges is stored. Pass a project folder (`root`, default the working
directory) and optionally a git `ref` (`HEAD`, a branch, a commit) to draw that
version:

```json
{ "root": "~/agents/support-desk", "ref": "HEAD" }
```

The scan finds every folder with a `sapiom.json` or a `defineAgent` and reads:

- **Edges**, agent to agent, each with the file and line that proves it:
  `agents.run` / `agents.launch` (`launch`), `schedules.create` on another agent
  (`timer`), and `events.emit` matched to the agents an event type triggers
  (`event`). A target counts when the code makes it knowable: a literal, a const
  (local or imported), every value of a const map indexed at run time, a zod
  `.default()` on the input field the call reads, or a `process.env` key set in
  `sapiom.json`. Anything else is listed under `unresolved`.
- **Systems**: connected components over those edges. Agents that only share a
  vault key, database or connector are not joined; the shared resource shows in
  each agent's `shared` list. Name a system in a committed `.sapiom/map.json`:
  `{ "systems": [{ "agent": "intake", "name": "Support desk" }] }`.
- **Steps** from `agents check` (needs the agent's dependencies installed).
- **Triggers and deploy state** from the signed-in account, plus a `fleet.json`'s
  declared triggers. Signed out, `platform` says so and the map still draws.
- **`changedSinceRef`**: the agent's folder differs from `ref` (from `HEAD` when
  drawing the working copy).

To map agents you describe yourself, without scanning, pass `agents`:

```json
{
  "agents": [
    { "slug": "intake", "emits": [{ "eventType": "ticket.opened" }] },
    {
      "slug": "triage",
      "triggers": [{ "kind": "event", "eventType": "ticket.opened" }],
      "calls": [{ "to": "notify", "kind": "launch" }]
    },
    { "slug": "notify", "resources": ["connector:slack"] }
  ]
}
```

Each agent takes `slug` and optionally `path`, `description`, `deployed`,
`steps` (`{ entry, steps: [{ id }], transitions: [{ from, to, kind }] }`),
`calls` (`{ to, kind: "launch" | "signal" | "timer", evidence? }`), `emits`,
`triggers` and `resources`. The same systems rule applies.

**Labels.** Signed in, the tool asks Jev (`jev-1.13.0`, one batched
`decisions.evaluate` call) for each described agent's `role` (intake, worker,
orchestrator, reporter, monitor or utility) and for the `label` of each launch or
event edge (hands work to, feeds data to or monitors). A label appears only when
its probability `p` is at least 0.8. Answers are cached in
`<root>/.sapiom/cache/map-labels.json` (ignored by git from inside the folder;
in memory for a described map), keyed by a hash of the question's facts, so an
unchanged agent is never re-asked and its label never flips. In a scanned
project, when an agent changes, the label it showed stays unless the new answer
differs and clears 0.8.
Signed out, with `platform: false`, or when Jev fails or takes over 5 s, the map
comes back with `labels: "unavailable"` and is otherwise the same.

## How capabilities fit in

Agents authored here call Sapiom capabilities — sandboxes, repositories,
coding agents, search, storage, content generation — through
[`@sapiom/tools`](../tools) (`ctx.sapiom.*`). `run_local` resolves those calls
from stubs; deploy and production run cross into authenticated cloud operations
and can be metered. This MCP never grows a per-capability tool of its own —
capabilities live in
`@sapiom/tools` and the remote `sapiom` MCP. See
[the positioning doc](../../docs/mcp-servers.md) for the full policy.

## Sending feedback

`sapiom_send_feedback` relays a user's product feedback (a bug, a rough edge, a
feature request) to the Sapiom team. The agent sends only what the user said;
the server attaches package version, platform, arch, node version, environment
and a timestamp itself, so the model never has to read those off the machine.

A host embedding this server can advertise its own version with
**`SAPIOM_HARNESS_VERSION`** — it rides along as `clientMeta.harnessVersion`,
which is what makes "which build is this user on" answerable during triage. The
field is omitted entirely when the variable is unset, never filled with a
placeholder. `@sapiom/harness` sets it automatically.

## Usage analytics

The server emits anonymous usage analytics (one `tool.call` event per tool
invocation: tool name, arguments, duration, ok/error class) via
[`@sapiom/analytics-core`](../analytics-core) to the hosted Sapiom collector
by default. Opt out at any time with `SAPIOM_TELEMETRY_DISABLED=1` or
`DO_NOT_TRACK=1` — either makes the emitter a complete no-op (nothing is sent,
nothing is written to disk). `SAPIOM_ANALYTICS_ENDPOINT` overrides the
destination. Telemetry is a synchronous in-memory enqueue that never throws,
never blocks a tool call, and can never change a tool result.

## License

MIT
