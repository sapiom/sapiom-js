/**
 * LangChain Agent Facts Schema V1
 *
 * Schema for tracking LangChain agent invocations through Sapiom.
 *
 * Schema: source="langchain-agent", version="v1"
 */

import type { CallSiteInfo } from "@sapiom/core";

/**
 * Request facts (pre-execution)
 */
export interface LangChainAgentRequestFacts {
  // Agent type
  agentType: "react" | "openai-functions" | "structured-chat" | "unknown";

  // Invocation metadata
  entryMethod: "invoke" | "stream";
  messageCount: number;

  // Call site (where user invoked the agent, depth=3 for context)
  callSite: CallSiteInfo[] | null;

  // Timestamp
  timestamp: string;
}

/**
 * Response facts (post-execution)
 */
export interface LangChainAgentResponseFacts {
  // Execution metadata
  success: boolean;
  durationMs: number;
  iterations: number; // Number of agent iterations

  // Output metadata
  hasOutput: boolean;
  outputMessageCount: number;
}

/**
 * Error facts
 */
export interface LangChainAgentErrorFacts {
  errorType: string;
  errorMessage: string;
  elapsedMs: number;
  iterationsBeforeError: number;
}

/**
 * Complete LangChain Agent facts package
 */
export interface LangChainAgentFacts {
  source: "langchain-agent";
  version: "v1";

  sdk: {
    name: "@sapiom/sdk";
    version: string;
  };

  request: LangChainAgentRequestFacts;
  response?: LangChainAgentResponseFacts;
  error?: LangChainAgentErrorFacts;
}
