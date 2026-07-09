# @sapiom/mcp

The **local developer** MCP server for Sapiom. It runs on your machine over
stdio under the server name `sapiom-dev` — the unmetered `sapiom_dev_*` surface
for building and operating on Sapiom. Today it gives a coding agent the tools to
scaffold, test, deploy, and inspect Sapiom orchestrations; the namespace leaves
room for other non-capability developer tooling later.

> **Not the capability surface.** This is *not* the remote "Sapiom" MCP (the
> hosted connector with `sapiom_sandbox_*`, scrape, search, … capability tools).
> `sapiom-dev` is the local developer surface; it makes no paid capability calls
> and exposes no capability tools. See
> [the two Sapiom MCP servers](../../docs/mcp-servers.md) for which to use when.

## Install

No global install — run it on demand with `npx`:

```jsonc
{
  "mcpServers": {
    "sapiom-dev": {
      "command": "npx",
      "args": ["-y", "@sapiom/mcp"]
    }
  }
}
```

In Claude Code:

```sh
claude mcp add sapiom-dev -- npx -y @sapiom/mcp
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
      "env": { "SAPIOM_ENVIRONMENT": "staging" }
    }
  }
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

The local authoring tools (`scaffold`, `check`, `run_local`) need no
authentication — they run entirely offline.

## Tools

| Tool | Network | What it does |
| --- | --- | --- |
| `sapiom_authenticate` | browser | Log in and cache an API key for the current environment |
| `sapiom_status` | — | Report authentication status |
| `sapiom_logout` | — | Clear cached credentials |
| `sapiom_dev_agents_scaffold` | — | Create a new orchestration project |
| `sapiom_dev_agents_check` | — | Bundle + validate the step graph offline |
| `sapiom_dev_agents_run_local` | — | Run the workflow locally, resolving capability calls from stubs (no cost) |
| `sapiom_dev_agents_link` | ✓ | Resolve/create the hosted orchestration and cache its id |
| `sapiom_dev_agents_deploy` | ✓ | Push the current commit, build, and wait for it |
| `sapiom_dev_agents_run` | ✓ | Start a real cloud execution |
| `sapiom_dev_agents_inspect` | ✓ | Inspect an execution or build (optionally waiting for it) |
| `sapiom_dev_agents_signal` | ✓ | Resume a paused execution by delivering a signal |

A typical loop: `scaffold` → write step code → `run_local` until green → `link`
→ `deploy` → `run` → `inspect`.

## How capabilities fit in

Workflows authored here call Sapiom capabilities — sandboxes, repositories,
coding agents, search, storage, content generation — through
[`@sapiom/tools`](../tools) (`ctx.sapiom.*`). `run_local` resolves those calls
from stubs; a real `run`/`deploy` executes them in the cloud (metered). This MCP
never grows a per-capability tool of its own — capabilities live in
`@sapiom/tools` and the remote `sapiom` MCP. See
[the positioning doc](../../docs/mcp-servers.md) for the full policy.

## Usage analytics

The server can emit anonymous usage analytics (one `tool.call` event per tool
invocation: tool name, arguments, duration, ok/error class) via
[`@sapiom/analytics-core`](../analytics-core). It currently ships dark: unless
a collector endpoint is explicitly configured through the
`SAPIOM_ANALYTICS_ENDPOINT` environment variable, nothing is sent anywhere and
nothing is written to disk. Opt out at any time with
`SAPIOM_TELEMETRY_DISABLED=1` or `DO_NOT_TRACK=1`. Telemetry is a synchronous
in-memory enqueue that never throws, never blocks a tool call, and can never
change a tool result.

## License

MIT
