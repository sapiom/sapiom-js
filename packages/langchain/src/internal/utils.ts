/**
 * Shared utilities for LangChain v1.x integration
 */
import { randomUUID } from "crypto";

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
  return `sdk-${randomUUID()}`;
}

/**
 * Check if error is an authorization denial or timeout
 *
 * These errors should always be thrown regardless of failureMode,
 * as they represent business logic decisions rather than system failures.
 *
 * @param error - Error to check
 * @returns True if error is authorization denied or timeout
 */
export function isAuthorizationDeniedOrTimeout(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const err = error as Error;
  return (
    err.name === "TransactionDeniedError" ||
    err.name === "TransactionTimeoutError" ||
    err.name === "AuthorizationDeniedError"
  );
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
 * SDK version constant
 * TODO: Read from package.json at build time
 */
export const SDK_VERSION = "0.1.0";

/**
 * SDK package name
 */
export const SDK_NAME = "@sapiom/langchain";
