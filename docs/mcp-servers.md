# Sapiom MCP connections

Sapiom has two MCP connections. Use **Project MCP** for work rooted in a local
agent project and **Cloud MCP** for a direct cloud capability.

|              | **Sapiom Project MCP**                                       | **Sapiom Cloud MCP**                         |
| ------------ | ------------------------------------------------------------ | -------------------------------------------- |
| Client alias | `sapiom-project`                                             | `sapiom-cloud`                               |
| Connection   | `npx -y @sapiom/mcp` over stdio                              | `https://api.sapiom.ai/v1/mcp` over HTTP     |
| Sign-in      | Browser sign-in begins at the first cloud project action     | API key required when the connection starts  |
| Use it for   | Create, check, test, deploy, run, and inspect agent projects | Call an advertised cloud capability directly |

These aliases label client configuration entries. They do not rename tools.
Some MCP clients merge tools from all connections into one flat list, so do
not use `sapiom_*` as a cloud-only allowlist: it also matches Project MCP's
`sapiom_dev_*` lifecycle tools. Allow exact operations when the distinction is
a security boundary.

## Sapiom Project MCP

Register the published package in the coding agent you use:

```sh
claude mcp add sapiom-project -- npx -y @sapiom/mcp
```

```sh
codex mcp add sapiom-project -- npx -y @sapiom/mcp
```

Project MCP scaffolds agent projects, validates them, and runs them against
local stubs. Creating, checking, and running locally do not require Sapiom
authentication. Local Run creates no Sapiom capability request or spend, but
it executes ordinary project code, including file, process, and network side
effects.

Linking, deploying, production runs, inspection, schedules, and signals are
authenticated cloud actions. Ask the coding agent to connect your Sapiom
account when you first cross that boundary.

## Sapiom Cloud MCP

Create an API key in Sapiom settings and expose it as `SAPIOM_API_KEY`, then
register the hosted endpoint:

```sh
claude mcp add --scope user --transport http sapiom-cloud https://api.sapiom.ai/v1/mcp --header "x-api-key: $SAPIOM_API_KEY"
```

```sh
codex mcp add sapiom-cloud --url https://api.sapiom.ai/v1/mcp --bearer-token-env-var SAPIOM_API_KEY
```

Claude Code stores the expanded header value in its MCP configuration; do not
share raw diagnostics. Codex stores the environment-variable name, so make the
variable available to the process that launches Codex. Ask either client for
the outcome you want and let it discover the current cloud catalog.

For maintained public setup and boundary guidance, read
[Connect your coding agent](https://docs.sapiom.ai/guides/connect-claude-code-with-mcp)
and [Sapiom Cloud MCP](https://docs.sapiom.ai/integration/mcp-servers/remote).
