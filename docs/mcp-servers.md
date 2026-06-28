# The two Sapiom MCP servers

Two MCP servers carry the Sapiom name. They do different jobs, and conflating
them is the most common source of confusion. This is the short version of which
to use when.

| | **Remote `sapiom`** | **Local `sapiom-dev`** |
| --- | --- | --- |
| What it is | The production **capability surface** | The local **workflow-authoring** surface |
| Server name | `sapiom` | `sapiom-dev` |
| Package | — (hosted connector) | [`@sapiom/mcp`](../packages/mcp) (`npx -y @sapiom/mcp`) |
| Transport | Remote / hosted | stdio (runs on your machine) |
| Tools | ~30+ capability tools — `sapiom_sandbox_*`, scrape, web search, content generation, storage, … | `sapiom_authenticate`, `sapiom_status`, and `sapiom_dev_orchestrations_{scaffold,check,run_local,link,deploy,run,inspect,signal}` |
| Cost | Paid — capability calls are gateway-routed and metered (x402) | Free to author and test locally; `run` / `deploy` execute real cloud runs whose capability calls are metered |
| Use it to… | **call** a capability directly from an agent or client | **build, test, and ship** a workflow that orchestrates capabilities |

## Remote `sapiom` — the production capability surface

The remote MCP is the product's capability surface. Connect it (it is the
[claude.ai](https://claude.ai) "Sapiom" connector, also reachable through the
`use-sapiom` flow) and an agent gets direct tools for the things Sapiom runs:
sandboxes, web scrape and search, content generation, storage, and the rest.
Each tool call is a real, metered capability call routed through the gateway and
paid for via x402.

Reach for it when you want an agent to **use** a capability right now — "scrape
this page", "run this code in a sandbox", "search the web".

## Local `sapiom-dev` — the workflow-authoring surface

The local MCP is published as [`@sapiom/mcp`](../packages/mcp) and runs on your
machine over stdio under the server name `sapiom-dev`. It is the entry point for
**authoring** Sapiom orchestrations: scaffold a project, validate it, run it
locally against stubs (no cost), then link, deploy, run, and inspect it in the
cloud.

It deliberately does **not** expose capability tools. There is no
`sapiom_dev_scrape` or `sapiom_dev_sandbox_create`. Instead you write a workflow
whose step code calls capabilities through [`@sapiom/tools`](../packages/tools)
(`ctx.sapiom.*`), and `sapiom_dev_orchestrations_run_local` resolves those calls
from stubs so you can iterate offline. When you `run` or `deploy`, the same step
code executes in the cloud and its capability calls are metered just like the
remote MCP's.

Reach for it when you want to **build** something that composes capabilities —
not call one ad hoc.

## How they relate

The `sapiom-dev` MCP is **not** a second, local copy of the product. It is the
authoring tool for workflows that, at run time, call the same capabilities the
remote `sapiom` MCP exposes. One surface *uses* capabilities; the other *builds
the things that use them*. The capability implementations live in exactly one
place ([`@sapiom/tools`](../packages/tools) + the remote MCP) — see the policy
below.

## Capability-exposure policy

There is one rule that keeps the two surfaces from drifting into duplicates:

> **Capabilities live in `@sapiom/tools` and are exposed by the remote `sapiom`
> MCP. The authoring MCP (`sapiom-dev`) executes workflows; it does not hand-roll
> per-capability tools.**

A new capability is added to `@sapiom/tools` (and surfaced on the remote MCP).
Workflows reach it through `ctx.sapiom.*`; the authoring MCP never grows a
matching `sapiom_dev_<capability>` tool. This is why `@sapiom/mcp` ships only
`authenticate`/`status` and the `orchestrations_*` lifecycle tools — adding a
capability never changes its tool list.
