/**
 * MCP (Model Context Protocol) Integration Types
 *
 * Types for tracking MCP server metadata on tools, enabling backend
 * service fingerprinting similar to HTTP APIs.
 */

/**
 * Parsed URL components for MCP server fingerprinting
 */
export interface McpServerUrlParsed {
  /** URL protocol without colon (e.g., "https") */
  protocol: string;

  /** Hostname for fingerprinting (e.g., "weather-api.example.com") */
  hostname: string;

  /** URL pathname (e.g., "/mcp") */
  pathname: string;

  /** Port number if specified, null otherwise */
  port: number | null;
}

/**
 * MCP server metadata attached to tools loaded via getMcpTools()
 *
 * This metadata is included in tool request facts so the backend
 * can fingerprint MCP services the same way it fingerprints HTTP APIs.
 */
export interface McpToolMetadata {
  /** Server name from MultiServerMCPClient config (e.g., "weather") */
  serverName: string;

  /** Server URL for HTTP/SSE transports */
  serverUrl?: string;

  /** Parsed URL components for backend fingerprinting */
  serverUrlParsed?: McpServerUrlParsed;

  /** Transport type used to connect to the server */
  transportType: "http" | "sse" | "stdio";

  /** Whether this is a remote (HTTP/SSE) vs local (stdio) server */
  isRemote: boolean;
}

/**
 * Options for getMcpTools()
 */
export interface GetMcpToolsOptions {
  /**
   * Filter to specific server names. If not provided, gets tools from all servers.
   */
  servers?: string[];
}
