/**
 * The single seam every tool registration goes through.
 *
 * `registerTool` forwards to `server.tool(name, description, schema, handler)`
 * verbatim. Having one choke point (instead of a direct `server.tool` call per
 * tool) lets cross-cutting concerns wrap every tool handler in one place
 * without touching the tool modules themselves.
 */
import type {
  McpServer,
  ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShape } from "zod";

/**
 * Register one MCP tool. Behaviorally identical to calling
 * `server.tool(name, description, schema, handler)` directly.
 */
export function registerTool<Args extends ZodRawShape>(
  server: McpServer,
  name: string,
  description: string,
  schema: Args,
  handler: ToolCallback<Args>,
): void {
  server.tool(name, description, schema, handler);
}
