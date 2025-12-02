/**
 * LangChain v1.x Model Facts Schema
 *
 * Schema for tracking model calls through Sapiom middleware.
 *
 * Schema: source="langchain-llm", version="v1"
 */

/**
 * Request facts (pre-execution, from wrapModelCall)
 */
export interface ModelRequestFacts {
  /** Model identifier */
  modelId: string;

  /** Estimated input tokens */
  estimatedInputTokens: number;

  /** Number of messages in conversation */
  messageCount: number;

  /** Whether tools are available */
  hasTools: boolean;

  /** Number of tools available */
  toolCount: number;

  /** Timestamp */
  timestamp: string;
}

/**
 * Response facts (post-execution)
 */
export interface ModelResponseFacts {
  /** Actual input tokens from provider */
  actualInputTokens: number;

  /** Actual output tokens from provider */
  actualOutputTokens: number;

  /** Total tokens */
  actualTotalTokens: number;

  /** Execution duration in ms */
  durationMs: number;

  /** Whether response included tool calls */
  hadToolCalls: boolean;

  /** Number of tool calls in response */
  toolCallCount?: number;

  /** Names of tools called */
  toolCallNames?: string[];

  /** Finish reason from provider */
  finishReason?: string;
}

/**
 * Error facts
 */
export interface ModelErrorFacts {
  /** Error type/name */
  errorType: string;

  /** Error message */
  errorMessage: string;

  /** Time elapsed before error */
  elapsedMs: number;

  /** HTTP status if applicable */
  httpStatus?: number;
}

/**
 * Complete model facts envelope
 */
export interface ModelFacts {
  source: "langchain-llm";
  version: "v1";

  sdk: {
    name: string;
    version: string;
  };

  request: ModelRequestFacts;
  response?: ModelResponseFacts;
  error?: ModelErrorFacts;
}
