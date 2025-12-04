/**
 * LangChain v1.x Tool Facts Schema
 *
 * Schema for tracking tool calls through Sapiom middleware.
 *
 * Schema: source="langchain-tool", version="v1"
 */

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
