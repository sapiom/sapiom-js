/**
 * Token estimation and cost calculation for LLM models
 */
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseMessage } from '@langchain/core/messages';
import type { AIMessage } from '@langchain/core/messages';
import { Decimal } from 'decimal.js';

// Configure Decimal.js for financial precision (36 digits, matching backend DECIMAL(36,18))
Decimal.set({
  precision: 36,
  rounding: Decimal.ROUND_HALF_UP,
});

/**
 * Token usage information
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens?: number; // Optional - not known before execution
  totalTokens?: number; // Optional - not known before execution
}

/**
 * Model pricing per token (stored as strings for exact precision)
 * Prices are per single token, not per 1K tokens
 *
 * Use this for exact decimal arithmetic with decimal.js
 */
const MODEL_PRICING_STRINGS: Record<string, { input: string; output: string }> = {
  // OpenAI (per token)
  'gpt-4': { input: '0.00003', output: '0.00006' },
  'gpt-4-turbo': { input: '0.00001', output: '0.00003' },
  'gpt-4o': { input: '0.000005', output: '0.000015' },
  'gpt-4o-mini': { input: '0.00000015', output: '0.0000006' },
  'gpt-3.5-turbo': { input: '0.0000005', output: '0.0000015' },

  // Anthropic (per token)
  'claude-3-5-sonnet-20241022': { input: '0.000003', output: '0.000015' },
  'claude-3-5-sonnet': { input: '0.000003', output: '0.000015' }, // Alias for latest
  'claude-3-5-haiku-20241022': { input: '0.0000008', output: '0.000004' },
  'claude-3-5-haiku': { input: '0.0000008', output: '0.000004' }, // Alias for latest
  'claude-3-opus': { input: '0.000015', output: '0.000075' },
  'claude-3-sonnet': { input: '0.000003', output: '0.000015' },
  'claude-3-haiku': { input: '0.00000025', output: '0.00000125' },

  // Google (per token)
  'gemini-1.5-pro': { input: '0.00000125', output: '0.000005' },
  'gemini-1.5-flash': { input: '0.000000075', output: '0.0000003' },
};

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
 * const cost = calculateModelCost(model, { promptTokens: inputTokens });
 * ```
 */
export async function estimateInputTokens(messages: BaseMessage[], model: BaseChatModel): Promise<number> {
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
    console.warn('Failed to use model.getNumTokens(), falling back to generic estimation:', error);
    return estimateInputTokensGeneric(messages);
  }
}

/**
 * Generic input token estimation fallback
 */
function estimateInputTokensGeneric(messages: BaseMessage[]): number {
  let charCount = 0;
  for (const message of messages) {
    const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
    charCount += content.length;
  }
  return Math.ceil(charCount / 4);
}

/**
 * @deprecated Use estimateInputTokens instead
 * @internal
 */
export function estimateOpenAITokens(messages: BaseMessage[], modelName: string): number {
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
    const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);

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
 * Calculate cost from token usage using exact decimal arithmetic
 *
 * Works for both estimated (input only) and actual (input + output) usage.
 * Returns Decimal for exact precision - convert to string with .toFixed(18) when needed.
 *
 * @param model - Model instance
 * @param usage - Token usage (completionTokens optional for estimates)
 * @returns Cost as Decimal for exact precision
 *
 * @example
 * ```typescript
 * // Before execution (estimate)
 * const estimatedCost = calculateModelCost(model, { promptTokens: 500 });
 * const fiatAmount = estimatedCost.toFixed(18); // "0.001500000000000000"
 *
 * // After execution (actual)
 * const actualCost = calculateModelCost(model, {
 *   promptTokens: 500,
 *   completionTokens: 200
 * });
 * const fiatAmount = actualCost.toFixed(18); // Exact decimal string
 * ```
 */
export function calculateModelCost(model: BaseChatModel, usage: TokenUsage): Decimal {
  const modelName = getModelName(model);
  let pricing: { input: string; output: string } | undefined;

  // Step 1: Try exact match with original name (including -latest if present)
  pricing = MODEL_PRICING_STRINGS[modelName];

  // Step 2: Try prefix match (e.g., "gpt-4-0125-preview" → "gpt-4")
  if (!pricing) {
    for (const [knownModel, p] of Object.entries(MODEL_PRICING_STRINGS)) {
      if (modelName.startsWith(knownModel)) {
        pricing = p;
        break;
      }
    }
  }

  // Step 3: If still not found and model ends with -latest, try stripping it
  if (!pricing && modelName.endsWith('-latest')) {
    const baseModelName = modelName.replace(/-latest$/, '');

    // Try exact match without -latest
    pricing = MODEL_PRICING_STRINGS[baseModelName];

    // Try prefix match without -latest
    if (!pricing) {
      for (const [knownModel, p] of Object.entries(MODEL_PRICING_STRINGS)) {
        if (baseModelName.startsWith(knownModel)) {
          pricing = p;
          break;
        }
      }
    }
  }

  // Step 4: Fallback to conservative estimate
  if (!pricing) {
    console.warn(
      `[Sapiom] Unknown model pricing for "${modelName}". ` +
        `Using conservative fallback estimate. ` +
        `Please update MODEL_PRICING_STRINGS in token-estimation.ts for accurate costs.`,
    );
    pricing = { input: '0.000001', output: '0.000002' };
  }

  // Convert to Decimal and calculate with exact arithmetic
  const inputPrice = new Decimal(pricing.input);
  const outputPrice = new Decimal(pricing.output);
  const promptTokens = new Decimal(usage.promptTokens);
  const completionTokens = new Decimal(usage.completionTokens || 0);

  // Calculate total cost: (promptTokens * inputPrice) + (completionTokens * outputPrice)
  return promptTokens.mul(inputPrice).add(completionTokens.mul(outputPrice));
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
  if ('modelName' in model && typeof (model as any).modelName === 'string') {
    return (model as any).modelName;
  }

  if ('model' in model && typeof (model as any).model === 'string') {
    return (model as any).model;
  }

  // Fallback to _llmType
  if (typeof model._llmType === 'function') {
    return model._llmType();
  }

  return 'unknown-model';
}
