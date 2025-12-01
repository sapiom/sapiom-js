/**
 * LangChain v1.x Agent Facts Schema
 *
 * Schema for tracking agent invocations through Sapiom middleware.
 *
 * Schema: source="langchain-agent", version="v1"
 */

/**
 * Request facts (pre-execution, from beforeAgent)
 */
export interface AgentRequestFacts {
  /** Agent type (react is standard for createAgent) */
  agentType: "react" | "unknown";

  /** Entry method */
  entryMethod: "invoke" | "stream";

  /** Number of input messages */
  messageCount: number;

  /** Timestamp */
  timestamp: string;
}

/**
 * Response facts (post-execution, from afterAgent)
 */
export interface AgentResponseFacts {
  /** Whether execution succeeded */
  success: boolean;

  /** Total execution duration in ms */
  durationMs: number;

  /** Number of output messages */
  outputMessageCount: number;
}

/**
 * Error facts
 */
export interface AgentErrorFacts {
  /** Error type/name */
  errorType: string;

  /** Error message */
  errorMessage: string;

  /** Time elapsed before error */
  elapsedMs: number;
}

/**
 * Complete agent facts envelope
 */
export interface AgentFacts {
  source: "langchain-agent";
  version: "v1";

  sdk: {
    name: string;
    version: string;
  };

  request: AgentRequestFacts;
  response?: AgentResponseFacts;
  error?: AgentErrorFacts;
}
