/**
 * LangChain Tool Facts Schema V1
 *
 * Schema for tracking LangChain tool invocations through Sapiom.
 *
 * Schema: source="langchain-tool", version="v1"
 */

import type { CallSiteInfo } from "@sapiom/core";

/**
 * Request facts (pre-execution)
 */
export interface LangChainToolRequestFacts {
  // Tool identity
  toolName: string;
  toolDescription: string;

  // Tool schema (for similarity matching across agents)
  inputSchema: Record<string, any>;

  // Call context (depth=3 for call chain)
  callSite: CallSiteInfo[] | null;

  // Arguments (sanitized - no sensitive data!)
  hasArguments: boolean;
  argumentKeys: string[]; // Keys only, not values

  // Timestamp
  timestamp: string;
}

/**
 * Response facts (post-execution)
 */
export interface LangChainToolResponseFacts {
  // Execution metadata
  success: boolean;
  durationMs: number;

  // Result metadata (no actual data!)
  hasResult: boolean;
  resultType: string; // "string" | "object" | "array" | "null"
}

/**
 * Error facts
 */
export interface LangChainToolErrorFacts {
  errorType: string;
  errorMessage: string;

  // Payment error detection
  isMCPPaymentError: boolean;
  paymentRequired?: {
    protocol: string;
    network: string;
    amount: string;
  };

  // Timing
  elapsedMs: number;
}

/**
 * Complete LangChain Tool facts package
 */
export interface LangChainToolFacts {
  source: "langchain-tool";
  version: "v1";

  sdk: {
    name: "@sapiom/sdk";
    version: string;
  };

  request: LangChainToolRequestFacts;
  response?: LangChainToolResponseFacts;
  error?: LangChainToolErrorFacts;
}
