/**
 * Service and resource inference for transaction metadata
 */

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

/**
 * Infer service name from model class
 *
 * Examines model constructor name to determine provider.
 *
 * @param model - Model instance
 * @returns Service name (e.g., "openai", "anthropic", "google")
 *
 * @example
 * ```typescript
 * const model = new ChatOpenAI({ ... });
 * const service = inferServiceFromModel(model);
 * // "openai"
 * ```
 */
export function inferServiceFromModel(model: BaseChatModel): string {
  const className = model.constructor.name;

  // OpenAI
  if (className.includes("OpenAI")) {
    return "openai";
  }

  // Anthropic
  if (className.includes("Anthropic") || className.includes("Claude")) {
    return "anthropic";
  }

  // Google
  if (className.includes("Google") || className.includes("Gemini")) {
    return "google";
  }

  // Cohere
  if (className.includes("Cohere")) {
    return "cohere";
  }

  // Mistral
  if (className.includes("Mistral")) {
    return "mistral";
  }

  // Groq
  if (className.includes("Groq")) {
    return "groq";
  }

  // Generic fallback
  return "llm-unknown";
}

/**
 * Get model name from model instance
 *
 * Extracts the specific model identifier (e.g., "gpt-4", "claude-3-opus").
 *
 * @param model - Model instance
 * @returns Model name
 *
 * @example
 * ```typescript
 * const model = new ChatOpenAI({ model: "gpt-4" });
 * const name = getModelName(model);
 * // "gpt-4"
 * ```
 */
export function getModelName(model: BaseChatModel): string {
  // Try standard property names
  if ("modelName" in model && typeof (model as any).modelName === "string") {
    return (model as any).modelName;
  }

  if ("model" in model && typeof (model as any).model === "string") {
    return (model as any).model;
  }

  // Try _llmType as fallback
  if (typeof model._llmType === "function") {
    return model._llmType();
  }

  return "unknown-model";
}

/**
 * Infer service name from MCP server URL or name
 *
 * Extracts hostname from URL or uses server name as fallback.
 *
 * @param url - MCP server URL (optional)
 * @param serverName - MCP server name
 * @returns Service name for transaction
 *
 * @example
 * ```typescript
 * inferServiceFromMCPUrl("https://weather-api.example.com/mcp", "weather");
 * // "mcp-weather-api.example.com"
 *
 * inferServiceFromMCPUrl(undefined, "weather");
 * // "mcp-local-weather"
 * ```
 */
export function inferServiceFromMCPUrl(
  url: string | undefined,
  serverName: string,
): string {
  if (!url) {
    return `mcp-local-${serverName}`;
  }

  try {
    const parsed = new URL(url);
    return `mcp-${parsed.hostname}`;
  } catch {
    return `mcp-${serverName}`;
  }
}
