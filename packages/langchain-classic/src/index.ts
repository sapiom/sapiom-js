/**
 * Sapiom SDK - LangChain Integration
 *
 * Provides unified session tracking and cost management for LangChain agents.
 *
 * @packageDocumentation
 */

// Re-export types (users may need these for TypeScript)
export type {
  SapiomModelConfig,
  SapiomToolConfig,
  SapiomSessionMetadata,
  SapiomWrapped,
} from "./internal/types.js";

// Tool Wrapper
export {
  wrapSapiomTool,
  createSapiomTool,
  sapiomTool,
  SapiomDynamicTool,
} from "./tool.js";

// Model Wrapper
export { SapiomChatOpenAI, SapiomChatAnthropic } from "./model.js";

// Model Wrapper Functions
export { wrapChatOpenAI } from "./models/openai.js";
export { wrapChatAnthropic } from "./models/anthropic.js";

// Agent Wrapper
export { wrapSapiomAgent, createSapiomReactAgent } from "./agent.js";
export type { WrapSapiomAgentConfig } from "./agent.js";

// Re-export SapiomClient from core for convenience
export { SapiomClient } from "@sapiom/core";
export type { SapiomClientConfig } from "@sapiom/core";
