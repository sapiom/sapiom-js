/**
 * Shared utilities for LangChain integration
 */
import { randomUUID } from "crypto";
import type { BaseLanguageModelInput } from "@langchain/core/language_models/base";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";

import { SapiomClient } from "@sapiom/core";

/**
 * Generate SDK-prefixed trace ID
 *
 * Used when user doesn't provide traceId in config.
 * Creates a UUID v4 with "sdk-" prefix for clarity.
 *
 * @returns SDK-generated trace identifier (format: sdk-{uuid})
 *
 * @example
 * ```typescript
 * const traceId = generateSDKTraceId();
 * // "sdk-a1b2c3d4-e5f6-7890-abcd-ef1234567890"
 * ```
 */
export function generateSDKTraceId(): string {
  // Use crypto.randomUUID() for proper UUID v4
  // Prefix with "sdk-" to indicate SDK-generated
  return `sdk-${randomUUID()}`;
}

/**
 * Wait for transaction authorization from Sapiom backend
 *
 * Polls transaction status until authorized or denied.
 * Throws if authorization is denied.
 *
 * @param txId - Transaction ID to wait for
 * @param client - SapiomClient instance
 * @param options - Polling options
 * @returns Authorized transaction object
 * @throws Error if authorization denied or timeout
 *
 * @example
 * ```typescript
 * const tx = await client.transactions.create({ ... });
 * const authorizedTx = await waitForTransactionAuthorization(tx.id, client);
 * // Use authorizedTx.payment.authorizationPayload if needed
 * ```
 */
export async function waitForTransactionAuthorization(
  txId: string,
  client: SapiomClient,
  options?: {
    pollIntervalMs?: number;
    timeoutMs?: number;
  },
): Promise<any> {
  const pollInterval = options?.pollIntervalMs || 100;
  const timeout = options?.timeoutMs || 30000;
  const startTime = Date.now();

  while (true) {
    // Check timeout
    if (Date.now() - startTime > timeout) {
      throw new Error(
        `Transaction authorization timeout after ${timeout}ms (txId: ${txId})`,
      );
    }

    // Poll transaction status
    const tx = await client.transactions.get(txId);

    if (tx.status === "authorized") {
      return tx; // Return authorized transaction
    }

    if (tx.status === "denied" || tx.status === "cancelled") {
      throw new AuthorizationDeniedError(
        (tx as any).declineReason || `Transaction ${txId} was ${tx.status}`,
        txId,
      );
    }

    // Still pending, wait and retry
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }
}

/**
 * Error thrown when transaction authorization is denied
 */
export class AuthorizationDeniedError extends Error {
  constructor(
    message: string,
    public readonly txId: string,
  ) {
    super(message);
    this.name = "AuthorizationDeniedError";
  }
}

/**
 * Check if error is authorization denied
 *
 * @param error - Error to check
 * @returns True if error is AuthorizationDeniedError
 */
export function isAuthorizationDenied(
  error: unknown,
): error is AuthorizationDeniedError {
  return error instanceof AuthorizationDeniedError;
}

/**
 * Convert various LangChain input types to BaseMessage array
 *
 * Handles: string, BaseMessage[], BaseMessage[][], PromptValue
 *
 * @param input - LangChain model input
 * @returns Array of BaseMessage
 */
export function convertInputToMessages(
  input: BaseLanguageModelInput,
): BaseMessage[] {
  // String input
  if (typeof input === "string") {
    return [{ role: "user", content: input } as unknown as BaseMessage];
  }

  // Already messages
  if (Array.isArray(input)) {
    // Nested array (batch)
    if (input.length > 0 && Array.isArray(input[0])) {
      return input[0] as unknown as BaseMessage[];
    }
    return input as unknown as BaseMessage[];
  }

  // PromptValue
  if ("toChatMessages" in input && typeof input.toChatMessages === "function") {
    return input.toChatMessages();
  }

  // Fallback
  return [];
}

/**
 * Wrap a stream with token usage tracking
 *
 * Accumulates tokens from streaming chunks and updates transaction
 * when stream completes.
 *
 * @param stream - Original stream from model
 * @param txId - Transaction ID to update
 * @param client - SapiomClient instance
 * @returns Wrapped stream
 *
 * @internal
 */
export async function* wrapStreamWithTokenTracking<T>(
  stream: AsyncIterable<T>,
  txId: string,
  client: SapiomClient,
): AsyncIterable<T> {
  let totalTokens = 0;
  let promptTokens = 0;
  let completionTokens = 0;

  try {
    for await (const chunk of stream) {
      // Extract token usage from chunk if available
      if ((chunk as any).message?.usage_metadata) {
        const usage = (chunk as any).message.usage_metadata;
        promptTokens = usage.input_tokens || 0;
        completionTokens = usage.output_tokens || 0;
        totalTokens = usage.total_tokens || 0;
      }

      yield chunk;
    }
  } finally {
    // Update transaction with actual usage
    if (totalTokens > 0) {
      // TODO: Implement transactions.update when available
      // await client.transactions.update(txId, {
      //   actualTokens: totalTokens,
      //   promptTokens,
      //   completionTokens
      // });
    }
  }
}
