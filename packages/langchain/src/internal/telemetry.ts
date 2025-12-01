/**
 * Telemetry utilities for LangChain v1.x integration
 *
 * Token estimation and model identification for middleware hooks
 */

/**
 * Token usage information
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens?: number;
  totalTokens?: number;
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
  messages: Array<{ content?: unknown }>
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
 * Extract model ID from model object
 *
 * Tries various property names used by different providers.
 *
 * @param model - LangChain model object
 * @returns Model identifier string
 */
export function getModelId(model: unknown): string {
  if (!model || typeof model !== "object") {
    return "unknown";
  }

  const m = model as Record<string, unknown>;

  // Try common property names
  if (typeof m.modelName === "string") return m.modelName;
  if (typeof m.model === "string") return m.model;
  if (typeof m.modelId === "string") return m.modelId;

  // Try _llmType method (LangChain convention)
  if (typeof m._llmType === "function") {
    try {
      return (m._llmType as () => string)();
    } catch {
      // Ignore errors
    }
  }

  // Fallback to constructor name
  if (m.constructor?.name && m.constructor.name !== "Object") {
    return m.constructor.name;
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
