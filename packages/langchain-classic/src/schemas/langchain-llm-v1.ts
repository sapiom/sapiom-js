/**
 * LangChain LLM Facts Schema V1
 *
 * Schema for tracking LangChain LLM invocations through Sapiom.
 * This schema enables backend inference of service, action, resource, and costs.
 *
 * Schema: source="langchain-llm", version="v1"
 */

import type { CallSiteInfo } from "@sapiom/core";

/**
 * Tool usage metadata
 */
export interface ToolUsageInfo {
  enabled: boolean;
  count: number;
  names: string[];
  toolChoice?: string;
}

/**
 * Structured output metadata
 */
export interface StructuredOutputInfo {
  enabled: boolean;
  method?: string;
  schemaName?: string;
}

/**
 * Message context (counts only, no content!)
 */
export interface MessageContextInfo {
  count: number;
  hasSystemMessage: boolean;
  hasImages: boolean;
  totalCharacters: number;
}

/**
 * LangChain integration context
 */
export interface LangChainContextInfo {
  runName?: string;
  tags?: string[];
  hasCallbacks: boolean;
  callbackCount: number;
}

/**
 * Request facts (pre-execution)
 */
export interface LangChainLLMRequestFacts {
  // Model identity
  framework: "langchain";
  modelClass: string;
  modelId: string;

  // Call metadata
  entryMethod: "invoke" | "generate" | "stream" | "batch";
  isStreaming: boolean;
  batchSize: number;

  // Call site (enabled by default, depth=3 for context)
  // [0]: Direct call, [1]: Intermediate, [2]: Top-level
  callSite: CallSiteInfo[] | null;

  // Token estimation
  estimatedInputTokens: number;
  tokenEstimationMethod: "tiktoken" | "approximate";

  // Generation parameters
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stopSequences?: string[];

  // Tool usage
  tools?: ToolUsageInfo;

  // Structured output
  structuredOutput?: StructuredOutputInfo;

  // Message context
  messages: MessageContextInfo;

  // LangChain integration
  langchain?: LangChainContextInfo;

  // Timestamp
  timestamp: string;
}

/**
 * Response facts (post-execution)
 */
export interface LangChainLLMResponseFacts {
  // Actual usage (from LLM response)
  actualInputTokens: number;
  actualOutputTokens: number;
  actualTotalTokens: number;

  // Response metadata
  finishReason: string;
  responseId?: string;

  // Tool calls
  hadToolCalls: boolean;
  toolCallCount?: number;
  toolCallNames?: string[];

  // Content metadata
  outputCharacters: number;
  hadImages: boolean;

  // Timing
  durationMs: number;
  firstTokenMs?: number;

  // Provider details
  provider?: {
    actualModel?: string;
    systemFingerprint?: string;
  };
}

/**
 * Error facts
 */
export interface LangChainLLMErrorFacts {
  errorType: string;
  errorClass: string;
  errorMessage: string;
  errorCode?: string;

  // Provider error details
  httpStatus?: number;
  rateLimit?: {
    remaining?: number;
    resetAt?: string;
    retryAfter?: number;
  };

  // Retry context
  attemptNumber: number;
  willRetry: boolean;

  // Timing
  elapsedMs: number;
}

/**
 * Complete LangChain LLM facts package
 */
export interface LangChainLLMFacts {
  source: "langchain-llm";
  version: "v1";

  sdk: {
    name: "@sapiom/sdk";
    version: string;
    nodeVersion?: string;
    platform?: string;
    dependencies?: Record<string, string>;
  };

  request: LangChainLLMRequestFacts;
  response?: LangChainLLMResponseFacts;
  error?: LangChainLLMErrorFacts;
}
