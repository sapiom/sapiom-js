import { z } from 'zod/v4';

import type { CtxSharedSizeLimitPhase } from './ctx-shared-quota.js';
import { AgentError } from './errors.js';

/** Versioned wire contract for a `ctx.shared` JSON serialization failure. */
export const CTX_SHARED_SERIALIZATION_ERROR_CONTRACT = Object.freeze({
  version: 1,
  errorCode: 'CTX_SHARED_SERIALIZATION_FAILED',
  retryable: false,
} as const);

/** The boundary at which a candidate shared snapshot could not be serialized. */
export type CtxSharedSerializationPhase = CtxSharedSizeLimitPhase;

/**
 * Stable cross-process representation of a shared-snapshot serialization error.
 *
 * Compatible positive reporting versions and future non-empty phases are
 * accepted so independently bundled SDK copies can coexist during rollout.
 */
export const ctxSharedSerializationErrorPayloadSchema = z.object({
  name: z.literal('CtxSharedSerializationError'),
  message: z.string(),
  code: z.literal(CTX_SHARED_SERIALIZATION_ERROR_CONTRACT.errorCode),
  version: z.number().int().positive(),
  stepName: z.string().min(1),
  phase: z.string().min(1),
  retryable: z.literal(false),
  stack: z.string().optional(),
});

export type CtxSharedSerializationErrorPayload = z.infer<typeof ctxSharedSerializationErrorPayloadSchema>;

export interface CtxSharedSerializationErrorOptions {
  readonly stepName: string;
  readonly phase: CtxSharedSerializationPhase;
  readonly stack?: string;
}

/** Public terminal error for a `ctx.shared` snapshot that `JSON.stringify` cannot encode. */
export class CtxSharedSerializationError extends AgentError {
  readonly code = CTX_SHARED_SERIALIZATION_ERROR_CONTRACT.errorCode;
  readonly version = CTX_SHARED_SERIALIZATION_ERROR_CONTRACT.version;
  readonly stepName: string;
  readonly phase: CtxSharedSerializationPhase;
  readonly retryable = CTX_SHARED_SERIALIZATION_ERROR_CONTRACT.retryable;

  constructor(options: CtxSharedSerializationErrorOptions) {
    super(
      `Step '${options.stepName}' could not serialize the ctx.shared snapshot during ${options.phase}. ` +
        `ctx.shared uses compact JSON.stringify; remove circular references and BigInt values, and ensure ` +
        `custom toJSON methods return normally.`,
    );
    this.name = 'CtxSharedSerializationError';
    this.stepName = options.stepName;
    this.phase = options.phase;
    if (options.stack !== undefined) this.stack = options.stack;
  }

  /** Ensure `JSON.stringify(error)` preserves the complete bounded public payload. */
  toJSON(): CtxSharedSerializationErrorPayload {
    return {
      name: 'CtxSharedSerializationError',
      message: this.message,
      code: this.code,
      version: this.version,
      stepName: this.stepName,
      phase: this.phase,
      retryable: this.retryable,
      ...(this.stack === undefined ? {} : { stack: this.stack }),
    };
  }
}

/** Recognize the canonical payload across bundles and process boundaries. */
export function isCtxSharedSerializationErrorPayload(value: unknown): value is CtxSharedSerializationErrorPayload {
  return ctxSharedSerializationErrorPayloadSchema.safeParse(value).success;
}
