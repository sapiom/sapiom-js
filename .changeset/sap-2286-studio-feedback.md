---
"@sapiom/agent-core": minor
"@sapiom/mcp": minor
---

Studio feedback: `sendFeedback` SDK function + the `sapiom_send_feedback` MCP tool (SAP-2286).

`@sapiom/agent-core` gains `sendFeedback({ message, context?, clientMeta? }, client)`, which POSTs
to `/v1/studio-feedback` and returns the stored record's id. Because that route sits at the API host
root rather than under `/v1/workflows`, `GatewayClient` gains one new public method,
`postAtHostRoot(path, body?)` — a separate method rather than a special-cased path prefix, so a call
site always declares which base its path is relative to. Every JSON request now funnels through a
single private `send()` (`openStream` keeps its own handshake path); as a side effect a `NETWORK`
error message now names the full URL instead of only the base.

`@sapiom/mcp` registers `sapiom_send_feedback`, which relays a user's feedback along with
client-side context it gathers itself (package version, platform, arch, node version, environment,
timestamp) so the model never has to read that off the machine. Internal: `ok`/`fail`/`gatewayClient`
moved from `tools/agents.ts` to a new `tools/shared.ts`, and `packageVersion()` from `analytics.ts`
to a new `version.ts`.
