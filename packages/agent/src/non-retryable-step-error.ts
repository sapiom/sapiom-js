import { ctxSharedSizeLimitExceededPayloadSchema, type CtxSharedSizeLimitExceededPayload } from './ctx-shared-quota.js';
import { stepInputValidationErrorPayloadSchema, type StepInputValidationErrorPayload } from './errors.js';

/**
 * The closed set of platform-owned step errors that may bypass workflow retry.
 * Unknown codes and arbitrary `retryable: false` properties are intentionally
 * excluded and therefore retain the legacy retry behavior.
 */
export type NonRetryableStepErrorPayload = CtxSharedSizeLimitExceededPayload | StepInputValidationErrorPayload;

/**
 * Validate and normalize a platform terminal error. Returning parsed schema
 * data strips arbitrary extra properties before the value crosses a trust or
 * persistence boundary.
 */
export function parseNonRetryableStepErrorPayload(value: unknown): NonRetryableStepErrorPayload | undefined {
  const quota = ctxSharedSizeLimitExceededPayloadSchema.safeParse(value);
  if (quota.success) return quota.data;

  const inputValidation = stepInputValidationErrorPayloadSchema.safeParse(value);
  if (inputValidation.success) return inputValidation.data;

  return undefined;
}

/** Structural guard for callers that only need the retry disposition. */
export function isNonRetryableStepErrorPayload(value: unknown): value is NonRetryableStepErrorPayload {
  return parseNonRetryableStepErrorPayload(value) !== undefined;
}
