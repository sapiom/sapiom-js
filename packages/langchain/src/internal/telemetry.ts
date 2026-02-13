/**
 * Telemetry utilities for LangChain v1.x integration
 *
 * Token estimation and model identification for middleware hooks
 */

import type { CallSiteInfo } from "@sapiom/core";

/**
 * SDK info for facts
 */
export interface SDKInfo {
  name: string;
  version: string;
  nodeVersion: string;
  platform: string;
  dependencies: Record<string, string>;
}

/**
 * Model generation parameters
 */
export interface ModelParameters {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  topK?: number;
  stopSequences?: string[];
}

/**
 * LangChain-specific context
 */
export interface LangChainContext {
  hasCallbacks: boolean;
  callbackCount: number;
}

/**
 * Token usage information
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens?: number;
  totalTokens?: number;
}

/**
 * Message context info for facts schema
 */
export interface MessageContextInfo {
  count: number;
  hasSystemMessage: boolean;
  hasImages: boolean;
  totalCharacters: number;
}

/**
 * Tool usage info for facts schema
 */
export interface ToolUsageInfo {
  enabled: boolean;
  count: number;
  names: string[];
}

/**
 * Estimate input tokens from messages
 *
 * Uses character-based heuristic (~4 chars per token).
 * LangChain v1.x middleware doesn't have direct access to model's getNumTokens,
 * so we use this generic approach.
 *
 * @param messages - Array of messages with content
 * @returns Estimated input token count
 */
export function estimateInputTokens(
  messages: Array<{ content?: unknown }>,
): number {
  let charCount = 0;

  for (const message of messages) {
    // Message formatting overhead
    charCount += 16; // ~4 tokens

    const content = message.content;
    if (typeof content === "string") {
      charCount += content.length;
    } else if (content !== null && content !== undefined) {
      charCount += JSON.stringify(content).length;
    }
  }

  // ~4 chars per token for English text
  return Math.ceil(charCount / 4);
}

/**
 * Collect message context info for facts
 */
export function collectMessageContext(
  messages: Array<{ content?: unknown; role?: string }>,
): MessageContextInfo {
  let totalCharacters = 0;
  let hasSystemMessage = false;
  let hasImages = false;

  for (const message of messages) {
    if (
      (message as any).role === "system" ||
      (message as any)._getType?.() === "system"
    ) {
      hasSystemMessage = true;
    }

    const content = message.content;
    if (typeof content === "string") {
      totalCharacters += content.length;
    } else if (Array.isArray(content)) {
      // Multimodal content
      for (const part of content) {
        if (typeof part === "string") {
          totalCharacters += part.length;
        } else if (part && typeof part === "object") {
          if (
            (part as any).type === "image" ||
            (part as any).type === "image_url"
          ) {
            hasImages = true;
          }
          if ((part as any).text) {
            totalCharacters += (part as any).text.length;
          }
        }
      }
    } else if (content !== null && content !== undefined) {
      totalCharacters += JSON.stringify(content).length;
    }
  }

  return {
    count: messages.length,
    hasSystemMessage,
    hasImages,
    totalCharacters,
  };
}

/**
 * Collect tool usage info for facts
 */
export function collectToolUsage(
  tools: Array<{ name?: string }>,
): ToolUsageInfo {
  return {
    enabled: tools.length > 0,
    count: tools.length,
    names: tools.map((t) => t.name || "unknown").filter(Boolean),
  };
}

/**
 * Get model class name from model object
 *
 * LangChain wraps models in ConfigurableModel, RunnableBinding, etc.
 * We try to get provider info from _defaultConfig or cached instances.
 */
export function getModelClass(model: unknown, depth = 0): string {
  if (!model || typeof model !== "object" || depth > 5) {
    return "unknown";
  }

  const m = model as Record<string, unknown>;
  const constructorName = m.constructor?.name;

  // ConfigurableModel is a dynamic wrapper - check _defaultConfig for provider info
  if (constructorName === "ConfigurableModel") {
    const defaultConfig = m._defaultConfig as
      | Record<string, unknown>
      | undefined;
    if (defaultConfig) {
      // modelProvider tells us the class type
      const modelProvider = defaultConfig.modelProvider as string | undefined;
      if (modelProvider) {
        // Map provider names to class names
        const providerToClass: Record<string, string> = {
          anthropic: "ChatAnthropic",
          openai: "ChatOpenAI",
          google: "ChatGoogleGenerativeAI",
          "google-genai": "ChatGoogleGenerativeAI",
          cohere: "ChatCohere",
          mistral: "ChatMistralAI",
          groq: "ChatGroq",
        };
        if (providerToClass[modelProvider]) {
          return providerToClass[modelProvider];
        }
      }

      // Try to infer from model ID in defaultConfig
      const modelId = defaultConfig.model as string | undefined;
      if (modelId) {
        if (modelId.match(/^claude-/i)) return "ChatAnthropic";
        if (modelId.match(/^gpt-/i) || modelId.match(/^o1-/i))
          return "ChatOpenAI";
        if (modelId.match(/^gemini-/i)) return "ChatGoogleGenerativeAI";
        if (modelId.match(/^command-/i)) return "ChatCohere";
        if (modelId.match(/^mistral-/i)) return "ChatMistralAI";
      }
    }

    // Check cached model instances
    const cache = m._modelInstanceCache as Map<string, unknown> | undefined;
    if (cache && cache.size > 0) {
      // Get first cached instance
      const firstInstance = cache.values().next().value;
      if (firstInstance && typeof firstInstance === "object") {
        return getModelClass(firstInstance, depth + 1);
      }
    }
  }

  // RunnableBinding wraps in bound
  if (constructorName === "RunnableBinding") {
    if (m.bound && typeof m.bound === "object") {
      return getModelClass(m.bound, depth + 1);
    }
  }

  // RunnableConfigurableFields
  if (constructorName === "RunnableConfigurableFields") {
    const inner = m._model ?? m.default ?? m.bound ?? m.first;
    if (inner && typeof inner === "object") {
      return getModelClass(inner, depth + 1);
    }
  }

  // Now check if we have a real model class
  if (constructorName && constructorName !== "Object") {
    return constructorName;
  }

  // Try _llmType method (LangChain convention)
  if (typeof m._llmType === "function") {
    try {
      const llmType = (m._llmType as () => string)();
      if (llmType && llmType !== "unknown" && llmType !== "chat_model") {
        return llmType;
      }
    } catch {
      // Ignore errors
    }
  }

  return "unknown";
}

/**
 * Internal helper to extract model parameters from object (with unwrapping)
 *
 * LangChain wraps models in ConfigurableModel, RunnableBinding, etc.
 * For ConfigurableModel, we check _defaultConfig and cached instances.
 */
function unwrapModel(
  m: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> | null {
  // Prevent infinite recursion
  if (depth > 5) return null;

  const constructorName = m.constructor?.name;

  // ConfigurableModel is a dynamic wrapper
  if (constructorName === "ConfigurableModel") {
    // Check cached model instances first (actual model with real params)
    const cache = m._modelInstanceCache as Map<string, unknown> | undefined;
    if (cache && cache.size > 0) {
      const firstInstance = cache.values().next().value;
      if (firstInstance && typeof firstInstance === "object") {
        return unwrapModel(firstInstance as Record<string, unknown>, depth + 1);
      }
    }

    // Fall back to _defaultConfig
    const defaultConfig = m._defaultConfig as
      | Record<string, unknown>
      | undefined;
    if (defaultConfig) {
      return defaultConfig;
    }
  }

  // RunnableBinding wraps in bound
  if (constructorName === "RunnableBinding") {
    if (m.bound && typeof m.bound === "object") {
      return unwrapModel(m.bound as Record<string, unknown>, depth + 1);
    }
  }

  // RunnableConfigurableFields
  if (constructorName === "RunnableConfigurableFields") {
    const inner = m._model ?? m.default ?? m.bound ?? m.first;
    if (inner && typeof inner === "object") {
      return unwrapModel(inner as Record<string, unknown>, depth + 1);
    }
  }

  // This appears to be the actual model
  return m;
}

/**
 * Capture user call site information
 *
 * Walks up the stack to find the first non-internal frame.
 * Returns null if unable to capture.
 */
export function captureUserCallSite(): CallSiteInfo[] | null {
  const err = new Error();
  const stack = err.stack;
  if (!stack) return null;

  const lines = stack.split("\n").slice(1); // Skip "Error" line
  const callSites: CallSiteInfo[] = [];

  for (const line of lines) {
    // Skip internal files
    if (
      line.includes("node_modules") ||
      line.includes("@sapiom/") ||
      line.includes("internal/")
    ) {
      continue;
    }

    // Parse: "    at functionName (file:line:column)"
    const match = line.match(/at\s+(?:(.+?)\s+)?\(?(.+?):(\d+):(\d+)\)?/);
    if (match) {
      callSites.push({
        function: match[1] || "anonymous",
        file: match[2],
        line: parseInt(match[3], 10),
        column: parseInt(match[4], 10),
      });

      if (callSites.length >= 3) break; // Limit depth
    }
  }

  return callSites.length > 0 ? callSites : null;
}

/**
 * Extract model ID from model object
 *
 * LangChain wraps models in ConfigurableModel, RunnableBinding, etc.
 * We check _defaultConfig or cached instances for model ID.
 *
 * @param model - LangChain model object
 * @returns Model identifier string
 */
export function getModelId(model: unknown, depth = 0): string {
  if (!model || typeof model !== "object" || depth > 5) {
    return "unknown";
  }

  const m = model as Record<string, unknown>;
  const constructorName = m.constructor?.name;

  // ConfigurableModel is a dynamic wrapper - check _defaultConfig
  if (constructorName === "ConfigurableModel") {
    const defaultConfig = m._defaultConfig as
      | Record<string, unknown>
      | undefined;
    if (defaultConfig) {
      // model property in defaultConfig contains the model ID
      if (typeof defaultConfig.model === "string") {
        return defaultConfig.model;
      }
    }

    // Check cached model instances
    const cache = m._modelInstanceCache as Map<string, unknown> | undefined;
    if (cache && cache.size > 0) {
      const firstInstance = cache.values().next().value;
      if (firstInstance && typeof firstInstance === "object") {
        return getModelId(firstInstance, depth + 1);
      }
    }
  }

  // RunnableBinding wraps in bound
  if (constructorName === "RunnableBinding") {
    if (m.bound && typeof m.bound === "object") {
      return getModelId(m.bound, depth + 1);
    }
  }

  // RunnableConfigurableFields
  if (constructorName === "RunnableConfigurableFields") {
    const inner = m._model ?? m.default ?? m.bound ?? m.first;
    if (inner && typeof inner === "object") {
      return getModelId(inner, depth + 1);
    }
  }

  // Try common property names
  if (typeof m.modelName === "string") return m.modelName;
  if (typeof m.model === "string") return m.model;
  if (typeof m.modelId === "string") return m.modelId;

  // Try _llmType method (LangChain convention) - but only for actual model ID
  if (typeof m._llmType === "function") {
    try {
      const llmType = (m._llmType as () => string)();
      // Only use _llmType if it looks like a model ID (not a class name)
      if (llmType && llmType.includes("-")) {
        return llmType;
      }
    } catch {
      // Ignore errors
    }
  }

  return "unknown";
}

/**
 * Extract actual token usage from model response
 *
 * Checks standard LangChain usage_metadata first, falls back to
 * response_metadata for older patterns.
 *
 * @param result - Model response (AIMessage or similar)
 * @returns Token usage or null if not available
 */
export function extractActualTokens(result: unknown): TokenUsage | null {
  if (!result || typeof result !== "object") {
    return null;
  }

  const r = result as Record<string, unknown>;

  // Standard LangChain usage_metadata (preferred)
  if (r.usage_metadata && typeof r.usage_metadata === "object") {
    const usage = r.usage_metadata as Record<string, unknown>;
    if (
      typeof usage.input_tokens === "number" &&
      typeof usage.output_tokens === "number"
    ) {
      return {
        promptTokens: usage.input_tokens,
        completionTokens: usage.output_tokens,
        totalTokens:
          typeof usage.total_tokens === "number"
            ? usage.total_tokens
            : usage.input_tokens + usage.output_tokens,
      };
    }
  }

  // Fallback: response_metadata.tokenUsage (older pattern)
  if (r.response_metadata && typeof r.response_metadata === "object") {
    const meta = r.response_metadata as Record<string, unknown>;
    if (meta.tokenUsage && typeof meta.tokenUsage === "object") {
      const usage = meta.tokenUsage as Record<string, unknown>;
      if (typeof usage.promptTokens === "number") {
        return {
          promptTokens: usage.promptTokens,
          completionTokens:
            typeof usage.completionTokens === "number"
              ? usage.completionTokens
              : 0,
          totalTokens:
            typeof usage.totalTokens === "number" ? usage.totalTokens : 0,
        };
      }
    }
  }

  return null;
}

/**
 * Collect LangChain dependency versions
 *
 * Attempts to read package.json from installed LangChain packages.
 * Fails gracefully if packages not available.
 */
export function collectDependencyVersions(): Record<string, string> {
  const deps: Record<string, string> = {};

  const packagesToCheck = [
    "@langchain/core",
    "@langchain/openai",
    "@langchain/anthropic",
    "@langchain/google-genai",
    "@langchain/langgraph",
    "langchain",
  ];

  for (const pkg of packagesToCheck) {
    try {
      // Try to require package.json
      const pkgJson = require(`${pkg}/package.json`);
      deps[pkg] = pkgJson.version;
    } catch {
      // Package not installed or not accessible
      continue;
    }
  }

  return deps;
}

/**
 * Get runtime environment info
 */
export function getRuntimeInfo(): { nodeVersion: string; platform: string } {
  return {
    nodeVersion: process.version,
    platform: process.platform,
  };
}

/**
 * Extract model parameters from model object
 *
 * Unwraps ConfigurableModel/RunnableBinding to find actual parameters.
 */
export function extractModelParameters(model: unknown): ModelParameters {
  if (!model || typeof model !== "object") {
    return {};
  }

  // Unwrap to find the actual model
  const m =
    unwrapModel(model as Record<string, unknown>) ??
    (model as Record<string, unknown>);
  const params: ModelParameters = {};

  if (typeof m.temperature === "number") params.temperature = m.temperature;
  if (typeof m.maxTokens === "number") params.maxTokens = m.maxTokens;
  if (typeof m.topP === "number") params.topP = m.topP;
  if (typeof m.topK === "number") params.topK = m.topK;
  if (Array.isArray(m.stopSequences)) params.stopSequences = m.stopSequences;

  return params;
}
