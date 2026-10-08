# mcp

Call the tools of a tenant's MCP-backed connector (Linear, Notion, or a custom MCP
server) through the connectors gateway's MCP relay. The gateway resolves the tenant's
credential server-side; it never reaches your run.

```typescript
import { createClient } from "@sapiom/tools";
const sapiom = createClient({ apiKey: process.env.SAPIOM_API_KEY });

const tools = await sapiom.connectors.linear.listTools();
const result = await sapiom.connectors.linear.callTool("list_issues", {
  limit: 5,
});
if (result.isError)
  throw new Error(result.content.map((c) => c.text).join("\n"));
```

Ambient import works too: `import { connectors } from "@sapiom/tools"` (then
`connectors.linear`, `connectors.notion`, or `connectors.mcp("<slug>")`).

## Operations

- `listTools()` — the connector's tools (`name`, `description`, `inputSchema`). Empty
  until the tenant connects the provider and runs **Discover** on the Connectors page.
- `callTool(name, args?)` — MCP's `CallToolResult` (`content`, `isError?`,
  `structuredContent?`).

## Slugs

The relay addresses a connector by its slug, derived from its name. A connector added
with its default name has slug `linear` / `notion`, which `connectors.linear` and
`connectors.notion` use. For a renamed or second connector (`linear-2`) or a custom
MCP server, call `connectors.mcp("<slug>")`.

## Errors

- A failed tool call (connector not ready, unknown tool, provider error) is a normal
  result with `isError: true` and the reason as text. Check it.
- A JSON-RPC error from the relay throws `McpRelayError` (`code`, `message`, `slug`,
  `method`).
- A non-2xx (e.g. `401` for a missing or tenant-less credential) throws the transport's
  HTTP error.
