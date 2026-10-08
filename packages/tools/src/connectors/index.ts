/**
 * `connectors` — the grouping namespace for connection-backed third-party
 * providers (Google, GitHub, …): capabilities whose credential is a tenant's
 * OAuth/static connector, resolved and governed server-side in the connectors
 * gateway rather than shipped to the run. This is distinct from Sapiom's
 * first-party capabilities (sandboxes, models, search, …), which need no
 * external connector at all.
 *
 *   import { connectors } from "@sapiom/tools";
 *   const auth = await connectors.google.authClient();
 *   const repos = await connectors.github.listRepos();
 *   await connectors.slack.postMessage({ channel, text: "Done." });
 *   const tools = await connectors.linear.listTools();
 *
 * Or on the step context: `ctx.sapiom.connectors.google.authClient()` /
 * `ctx.sapiom.connectors.github.listRepos()`.
 */
export * as google from "./google/index.js";
export * as github from "./github/index.js";
export * as slack from "./slack/index.js";
// MCP-backed connectors go through the relay: `mcp(slug)` for any of them, plus the two
// providers whose default connector slug is known.
export { mcp, linear, notion, McpRelayError } from "./mcp/index.js";
