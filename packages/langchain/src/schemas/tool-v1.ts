/**
 * LangChain v1.x Tool Facts Schema
 *
 * Schema for tracking tool calls through Sapiom middleware.
 *
 * Schema: source="langchain-tool", version="v1"
 */

/**
 * MCP server URL parsed components (for backend fingerprinting)
 */
export interface ToolMcpServerUrlParsed {
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
 * MCP server metadata included in tool facts
 *
 * Present when tools are loaded via getMcpTools().
 * Backend uses this for service fingerprinting.
 */
export interface ToolMcpMetadata {
  /** Server name from config (e.g., "weather") */
  serverName: string;

  /** Server URL for HTTP/SSE transports */
  serverUrl?: string;

  /** Parsed URL components for fingerprinting */
  serverUrlParsed?: ToolMcpServerUrlParsed;

  /** Transport type */
  transportType: "http" | "sse" | "stdio";

  /** Whether this is a remote server */
  isRemote: boolean;
}

/**
 * Request facts (pre-execution, from wrapToolCall)
 */
export interface ToolRequestFacts {
  /** Tool name */
  toolName: string;

  /** Tool description */
  toolDescription?: string;

  /** Whether arguments were provided */
  hasArguments: boolean;

  /** Argument keys (not values - privacy!) */
  argumentKeys: string[];

  /** Timestamp */
  timestamp: string;

  /**
   * MCP server metadata (present when tool loaded via getMcpTools)
   *
   * Backend uses this for service fingerprinting, similar to how
   * HTTP API fingerprinting uses URL hostname.
   */
  mcp?: ToolMcpMetadata;
}

/**
 * Response facts (post-execution)
 */
export interface ToolResponseFacts {
  /** Whether execution succeeded */
  success: boolean;

  /** Execution duration in ms */
  durationMs: number;

  /** Whether result was returned */
  hasResult?: boolean;

  /** Type of result */
  resultType?: string;
}

/**
 * Error facts
 */
export interface ToolErrorFacts {
  /** Error type/name */
  errorType: string;

  /** Error message */
  errorMessage: string;

  /** Time elapsed before error */
  durationMs: number;

  /** Whether this was a payment required error */
  isMCPPaymentError?: boolean;
}

/**
 * Complete tool facts envelope
 */
export interface ToolFacts {
  source: "langchain-tool";
  version: "v1";

  sdk: {
    name: string;
    version: string;
  };

  request: ToolRequestFacts;
  response?: ToolResponseFacts;
  error?: ToolErrorFacts;
}
