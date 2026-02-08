/**
 * @sapiom/langchain - LangChain v1.x Integration
 *
 * Provides Sapiom tracking for LangChain v1.x agents via middleware.
 *
 * @example
 * ```typescript
 * import { createAgent } from "langchain";
 * import { createSapiomMiddleware } from "@sapiom/langchain";
 *
 * const agent = createAgent({
 *   model: "openai:gpt-4",
 *   tools: [getWeather, sendEmail],
 *   middleware: [
 *     createSapiomMiddleware({
 *       apiKey: process.env.SAPIOM_API_KEY,
 *     }),
 *   ],
 * });
 *
 * // All model and tool calls are automatically tracked!
 * const result = await agent.invoke({
 *   messages: [{ role: "user", content: "What's the weather?" }],
 * });
 * ```
 *
 * @packageDocumentation
 */

// Main middleware
export { createSapiomMiddleware } from "./middleware.js";
export type { SapiomMiddlewareConfig, SapiomMiddlewareContext } from "./internal/types.js";

// Re-export LangChain types for convenience
export type { AgentMiddleware, ToolCallRequest } from "langchain";

// Types (re-exported from middleware, but also available directly)
export type {
  SapiomMiddlewareState,
} from "./internal/types.js";

// Utilities (for advanced use cases)
export {
  generateSDKTraceId,
  isAuthorizationDenied,
  isAuthorizationDeniedOrTimeout,
  AuthorizationDeniedError,
  SDK_VERSION,
  SDK_NAME,
} from "./internal/utils.js";

// Payment detection (for custom payment handling)
export {
  isMCPPaymentError,
  extractPaymentFromMCPError,
  convertX402ToSapiomPayment,
  getPaymentAuthFromTransaction,
  type X402PaymentResponse,
} from "./internal/payment.js";

// Telemetry (for custom tracking)
export {
  estimateInputTokens,
  getModelId,
  extractActualTokens,
  type TokenUsage,
} from "./internal/telemetry.js";

// Schemas (for type checking)
export type {
  AgentRequestFacts,
  AgentResponseFacts,
  AgentErrorFacts,
  AgentFacts,
} from "./schemas/agent-v1.js";

export type {
  ModelRequestFacts,
  ModelResponseFacts,
  ModelErrorFacts,
  ModelFacts,
} from "./schemas/model-v1.js";

export type {
  ToolRequestFacts,
  ToolResponseFacts,
  ToolErrorFacts,
  ToolFacts,
} from "./schemas/tool-v1.js";
