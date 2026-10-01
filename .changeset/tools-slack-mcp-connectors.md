---
"@sapiom/tools": minor
"@sapiom/agent-core": patch
---

`@sapiom/tools`: new connectors. `connectors.slack` wraps the gateway's Slack methods
(`postMessage`, `update`, `postEphemeral`, `addReaction`, `removeReaction`, `replies`,
`userInfo`) on `POST /connectors/v1/slack/methods/<method>`. `connectors.mcp(slug)` is a
client for the MCP relay at `POST /connectors/v1/<slug>/mcp` (`listTools()`,
`callTool(name, args)`), with `connectors.linear` and `connectors.notion` for the default
slugs; a JSON-RPC error throws `McpRelayError`. All are bound on `ctx.sapiom.connectors`
and stubbed for `run_local` (overridable under `connectors.slack.<method>`,
`connectors.<slug>.listTools|callTool`, or `connectors.mcp.listTools|callTool`).

`@sapiom/agent-core`: the authoring skill gains "Calling Slack, Linear, and Notion from a step".
