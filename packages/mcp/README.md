# @sapiom/mcp

The **local developer** MCP server for Sapiom. It runs on your machine over
stdio and should be registered under the client alias `sapiom`; the MCP handshake
still reports the internal wire identifier `sapiom-dev`. Today its `sapiom_dev_*`
tools let a coding agent scaffold, test, deploy, and inspect Sapiom agents; the
namespace leaves room for other non-capability developer tooling later.

> **Not the capability surface.** This is _not_ the remote "Sapiom" MCP (the
> hosted connector with `sapiom_sandbox_*`, scrape, search, … capability tools).
> Use `sapiom` for this local authoring connection and `sapiom-direct` for the
> hosted capability connection. The local server exposes no direct capability
> tools. Its check and Local Run path uses stubbed capabilities without Sapiom
> capability spend; deploys,
> cloud builds, production runs, signals, and schedules operate Sapiom cloud
> state and may be metered. See
> [the two Sapiom MCP servers](../../docs/mcp-servers.md) for which to use when.

## Install

No global install — run it on demand with `npx`:

```jsonc
{
  "mcpServers": {
    "sapiom": {
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
    "sapiom": {
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

The first networked call (`link`, `deploy`, `run`, `inspect`, `signal`, or a schedule tool) needs a
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

| Tool                                 | Network          | What it does                                                               |
| ------------------------------------ | ---------------- | -------------------------------------------------------------------------- |
| `sapiom_authenticate`                | browser          | Log in and cache an API key for the current environment                    |
| `sapiom_status`                      | —                | Report authentication status                                               |
| `sapiom_logout`                      | —                | Clear cached credentials                                                   |
| `sapiom_send_feedback`               | ✓                | Relay the user's product feedback to the Sapiom team                       |
| `sapiom_dev_agents_scaffold`         | npm optional     | Create a new agent project; may query npm for current dependency versions  |
| `sapiom_dev_agents_check`            | author code only | Typecheck, import, bundle, and validate the definition and step graph      |
| `sapiom_dev_agents_run_local`        | author code only | Run locally with `ctx.sapiom.*` calls stubbed (no Sapiom capability spend) |
| `sapiom_dev_agents_link`             | ✓                | Resolve/create the hosted agent and cache its id                           |
| `sapiom_dev_agents_clone`            | ✓                | Fork a gallery template (or re-clone a fork) into a local project          |
| `sapiom_dev_agents_deploy`           | ✓                | Bundle current local source, build in the cloud, and wait                  |
| `sapiom_dev_agents_run`              | ✓                | Start a real cloud execution                                               |
| `sapiom_dev_agents_inspect`          | ✓                | Inspect an execution or build (optionally waiting for it)                  |
| `sapiom_dev_agents_signal`           | ✓                | Deliver a tenant-framed signal and report how many paused runs resumed     |
| `sapiom_dev_agents_schedule`         | ✓                | Create a recurring (cron) or one-off schedule for a deployed agent         |
| `sapiom_dev_agents_schedule_inspect` | ✓                | Inspect one schedule (with fire history) or list an agent's schedules      |
| `sapiom_dev_agents_schedule_cancel`  | ✓                | Cancel a schedule (drops future unfired occurrences)                       |
| `sapiom_dev_agents_cron_preview`     | ✓                | Validate a cron expression and preview its next occurrences                |

A typical loop: `scaffold` → write step code → `run_local` until green → `link`
→ `deploy` → `run` → `inspect`.

## How capabilities fit in

Agents authored here call Sapiom capabilities — sandboxes, repositories,
coding agents, search, storage, content generation — through
[`@sapiom/tools`](../tools) (`ctx.sapiom.*`). `run_local` resolves those calls
from stubs; deploy and production run cross into authenticated cloud operations
and can be metered. This MCP never grows a per-capability tool of its own —
capabilities live in `@sapiom/tools` and the hosted `sapiom-direct` MCP. See
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
