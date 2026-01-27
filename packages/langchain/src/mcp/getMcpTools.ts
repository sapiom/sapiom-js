/**
 * getMcpTools - Wrapper for MultiServerMCPClient.getTools() that adds MCP metadata
 *
 * This function loads tools from an MCP client and enriches them with server
 * metadata so the Sapiom backend can fingerprint MCP services the same way
 * it fingerprints HTTP APIs.
 *
 * @example
 * ```typescript
 * import { MultiServerMCPClient } from "@langchain/mcp-adapters";
 * import { createSapiomMiddleware, getMcpTools } from "@sapiom/langchain";
 *
 * const mcpClient = new MultiServerMCPClient({
 *   mcpServers: {
 *     weather: { url: "https://weather.example.com/mcp" },
 *     calculator: { transport: "stdio", command: "npx", args: ["calc-mcp"] },
 *   },
 * });
 *
 * // Use getMcpTools instead of client.getTools()
 * const tools = await getMcpTools(mcpClient);
 *
 * const agent = createReactAgent({
 *   tools,
 *   middleware: [createSapiomMiddleware({ apiKey: "sk_..." })],
 * });
 * ```
 */

import type {
  McpToolMetadata,
  McpServerUrlParsed,
  GetMcpToolsOptions,
} from "./types.js";

/**
 * Minimal tool interface for type constraints
 *
 * This represents the minimum properties we need to access on tools.
 * The actual tools from MultiServerMCPClient (DynamicStructuredTool) have
 * many more properties which are preserved through generics.
 */
interface McpToolBase {
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Minimal interface for MultiServerMCPClient
 *
 * Using duck typing with generics to avoid tight coupling with @langchain/mcp-adapters
 * while preserving the actual tool types returned by the client.
 */
interface McpClientLike<TTool extends McpToolBase = McpToolBase> {
  config: {
    mcpServers: Record<string, McpConnectionLike>;
  };
  getTools(...servers: string[]): Promise<TTool[]>;
}

/**
 * Minimal interface for MCP connection configuration
 */
interface McpConnectionLike {
  // HTTP/SSE connections
  url?: string;
  transport?: "http" | "sse" | "stdio";
  type?: "http" | "sse" | "stdio";

  // Stdio connections
  command?: string;
  args?: string[];
}

/**
 * Parse a URL string into components for backend fingerprinting
 */
function parseServerUrl(url: string): McpServerUrlParsed {
  const parsed = new URL(url);
  return {
    protocol: parsed.protocol.replace(":", ""),
    hostname: parsed.hostname,
    pathname: parsed.pathname,
    port: parsed.port ? parseInt(parsed.port, 10) : null,
  };
}

/**
 * Determine transport type from connection configuration
 */
function getTransportType(
  connection: McpConnectionLike,
): "http" | "sse" | "stdio" {
  // Explicit transport/type takes precedence
  if (connection.transport === "stdio" || connection.type === "stdio") {
    return "stdio";
  }
  if (connection.transport === "sse" || connection.type === "sse") {
    return "sse";
  }
  if (connection.transport === "http" || connection.type === "http") {
    return "http";
  }

  // Infer from properties
  if (typeof connection.command === "string") {
    return "stdio";
  }
  if (typeof connection.url === "string") {
    // Default to http for URL-based connections
    return "http";
  }

  // Fallback
  return "stdio";
}

/**
 * Check if a connection is remote (HTTP/SSE) vs local (stdio)
 */
function isRemoteConnection(connection: McpConnectionLike): boolean {
  return typeof connection.url === "string";
}

/**
 * Build MCP metadata for a server connection
 */
function buildMcpMetadata(
  serverName: string,
  connection: McpConnectionLike,
): McpToolMetadata {
  const isRemote = isRemoteConnection(connection);
  const transportType = getTransportType(connection);

  return {
    serverName,
    serverUrl: isRemote ? connection.url : undefined,
    serverUrlParsed:
      isRemote && connection.url ? parseServerUrl(connection.url) : undefined,
    transportType,
    isRemote,
  };
}

/**
 * Load tools from an MCP client with server metadata attached
 *
 * This is a drop-in replacement for `client.getTools()` that enriches
 * tools with MCP server metadata for Sapiom tracking.
 *
 * @param client - MultiServerMCPClient instance (or compatible client)
 * @param options - Optional configuration
 * @returns Tools with MCP metadata attached to tool.metadata.__sapiom.mcp
 *
 * @example Get all tools
 * ```typescript
 * const tools = await getMcpTools(mcpClient);
 * ```
 *
 * @example Get tools from specific servers
 * ```typescript
 * const tools = await getMcpTools(mcpClient, {
 *   servers: ["weather", "calculator"],
 * });
 * ```
 */
export async function getMcpTools<TTool extends McpToolBase>(
  client: McpClientLike<TTool>,
  options?: GetMcpToolsOptions,
): Promise<TTool[]> {
  const config = client.config;
  const serverNames = options?.servers ?? Object.keys(config.mcpServers);
  const allTools: TTool[] = [];

  for (const serverName of serverNames) {
    const connection = config.mcpServers[serverName];
    if (!connection) {
      continue;
    }

    // Get tools from this specific server
    const serverTools = await client.getTools(serverName);
    const mcpMetadata = buildMcpMetadata(serverName, connection);

    // Attach MCP metadata to each tool under __sapiom namespace
    // Using __sapiom to avoid conflicts with LangChain or other libraries
    for (const tool of serverTools) {
      const existingMetadata = tool.metadata ?? {};
      const existingSapiom =
        (existingMetadata.__sapiom as Record<string, unknown>) ?? {};

      tool.metadata = {
        ...existingMetadata,
        __sapiom: {
          ...existingSapiom,
          mcp: mcpMetadata,
        },
      };
    }

    allTools.push(...serverTools);
  }

  return allTools;
}

// Re-export the McpClientLike interface for advanced usage
export type { McpClientLike };
