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
} from './internal/types';

// Tool Wrapper
export { wrapSapiomTool, createSapiomTool, sapiomTool, SapiomDynamicTool } from './tool';

// Model Wrapper
export { SapiomChatOpenAI, SapiomChatAnthropic } from './model';

// Model Wrapper Functions
export { wrapChatOpenAI } from './models/openai';
export { wrapChatAnthropic } from './models/anthropic';

// Agent Wrapper
export { wrapSapiomAgent, createSapiomReactAgent } from './agent';
export type { WrapSapiomAgentConfig } from './agent';

// Re-export SapiomClient from core for convenience
export { SapiomClient } from '@sapiom/core';
export type { SapiomClientConfig } from '@sapiom/core';
