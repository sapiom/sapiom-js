/**
 * Token estimation and cost calculation for LLM models
 */
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import type { AIMessage } from "@langchain/core/messages";

/**
 * Token usage information
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens?: number; // Optional - not known before execution
  totalTokens?: number; // Optional - not known before execution
}

/**
 * Estimate INPUT tokens for messages (before execution)
 *
 * Uses LangChain's built-in getNumTokens() method which handles
 * provider-specific tokenization (tiktoken for OpenAI, etc.).
 *
 * Only estimates INPUT tokens. Output tokens are unknown before execution.
 *
 * @param messages - Messages to estimate tokens for
 * @param model - Model instance (uses model.getNumTokens())
 * @returns Estimated input token count
 *
 * @example
 * ```typescript
 * const messages = [{ role: 'user', content: 'Hello!' }];
 * const inputTokens = await estimateInputTokens(messages, model);
 * ```
 */
export async function estimateInputTokens(
  messages: BaseMessage[],
  model: BaseChatModel
): Promise<number> {
  let inputTokens = 0;

  try {
    for (const message of messages) {
      // Message formatting overhead
      inputTokens += 4;

      // Use model's getNumTokens for accurate counting
      const contentTokens = await model.getNumTokens(message.content);
      inputTokens += contentTokens;
    }

    return inputTokens;
  } catch (error) {
    console.warn(
      "Failed to use model.getNumTokens(), falling back to generic estimation:",
      error
    );
    return estimateInputTokensGeneric(messages);
  }
}

/**
 * Generic input token estimation fallback
 */
function estimateInputTokensGeneric(messages: BaseMessage[]): number {
  let charCount = 0;
  for (const message of messages) {
    const content =
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content);
    charCount += content.length;
  }
  return Math.ceil(charCount / 4);
}

/**
 * @deprecated Use estimateInputTokens instead
 * @internal
 */
export function estimateOpenAITokens(
  messages: BaseMessage[],
  modelName: string
): number {
  return estimateInputTokensGeneric(messages);
}

/**
 * Estimate tokens for Anthropic models
 *
 * Uses character-based heuristic (~4 chars per token for English).
 *
 * @param messages - Messages to estimate
 * @returns Estimated token count
 *
 * @internal
 */
export function estimateAnthropicTokens(messages: BaseMessage[]): number {
  // Anthropic uses similar tokenization to GPT
  // ~4 characters per token for English text
  let charCount = 0;

  for (const message of messages) {
    const content =
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content);

    charCount += content.length;
  }

  // ~4 chars per token + response buffer
  return Math.ceil(charCount / 4) + 100;
}

/**
 * Estimate tokens for Google models
 *
 * Uses character-based heuristic.
 *
 * @param messages - Messages to estimate
 * @returns Estimated token count
 *
 * @internal
 */
export function estimateGoogleTokens(messages: BaseMessage[]): number {
  // Similar estimation to Anthropic
  return estimateAnthropicTokens(messages);
}

/**
 * Extract actual token usage from AIMessage response
 *
 * Checks standard LangChain usage_metadata first, falls back to
 * response_metadata.tokenUsage for older patterns.
 *
 * @param result - AIMessage from model invocation
 * @returns Token usage or null if not available
 *
 * @example
 * ```typescript
 * const result = await model.invoke(messages);
 * const usage = extractActualTokens(result);
 * if (usage) {
 *   console.log(`Used ${usage.totalTokens} tokens`);
 * }
 * ```
 */
export function extractActualTokens(result: AIMessage): TokenUsage | null {
  // Standard LangChain usage_metadata (preferred)
  // Available on all modern chat models
  // Reference: BaseChatModel.ts:353-361
  if (result.usage_metadata) {
    // Validate that required fields are present and not undefined
    if (
      result.usage_metadata.input_tokens !== undefined &&
      result.usage_metadata.output_tokens !== undefined &&
      result.usage_metadata.total_tokens !== undefined
    ) {
      return {
        promptTokens: result.usage_metadata.input_tokens,
        completionTokens: result.usage_metadata.output_tokens,
        totalTokens: result.usage_metadata.total_tokens,
      };
    }
  }

  // Fallback: response_metadata.tokenUsage (older pattern)
  if (result.response_metadata?.tokenUsage) {
    const usage = result.response_metadata.tokenUsage as any;
    // Validate fields exist
    if (usage.promptTokens !== undefined && usage.totalTokens !== undefined) {
      return {
        promptTokens: usage.promptTokens || 0,
        completionTokens: usage.completionTokens || 0,
        totalTokens: usage.totalTokens || 0,
      };
    }
  }

  return null;
}

/**
 * Get model name from BaseChatModel instance
 *
 * @param model - Model instance
 * @returns Model name string
 *
 * @internal
 */
export function getModelName(model: BaseChatModel): string {
  // Try standard properties
  if ("modelName" in model && typeof (model as any).modelName === "string") {
    return (model as any).modelName;
  }

  if ("model" in model && typeof (model as any).model === "string") {
    return (model as any).model;
  }

  // Fallback to _llmType
  if (typeof model._llmType === "function") {
    return model._llmType();
  }

  return "unknown-model";
}
