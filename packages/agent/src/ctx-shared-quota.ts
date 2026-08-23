import { Buffer } from 'node:buffer';

import { z } from 'zod/v4';

import { AgentError } from './errors.js';

/**
 * Versioned, process-independent contract for the persisted `ctx.shared`
 * snapshot. This is the only policy literal: every compatibility export and
 * host-side validator must derive from this object.
 */
export const CTX_SHARED_QUOTA_CONTRACT = Object.freeze({
  version: 1,
  limitBytes: 262_144,
  serialization: 'JSON.stringify',
  encoding: 'utf8',
  errorCode: 'CTX_SHARED_SIZE_LIMIT_EXCEEDED',
} as const);

/** Backward-compatible name for consumers that only need the byte limit. */
export const MAX_SHARED_SNAPSHOT_BYTES = CTX_SHARED_QUOTA_CONTRACT.limitBytes;

/** A whole-snapshot quota violation returned by the measurement helper. */
export interface CtxSharedSizeViolation {
  readonly actualBytes: number;
  readonly limitBytes: typeof MAX_SHARED_SNAPSHOT_BYTES;
}

/**
 * Measure compact JSON for the entire candidate shared snapshot as UTF-8.
 *
 * JSON serialization failures deliberately propagate unchanged. They are not
 * quota violations and do not use `CTX_SHARED_SIZE_LIMIT_EXCEEDED`.
 */
export function measureCtxSharedSnapshotBytes(snapshot: Readonly<Record<string, unknown>>): number {
  const serialized = JSON.stringify(snapshot);
  if (serialized === undefined) {
    throw new TypeError('ctx.shared snapshot did not serialize to JSON');
  }
  return Buffer.byteLength(serialized, CTX_SHARED_QUOTA_CONTRACT.encoding);
}

/** Return a violation only when the whole snapshot is strictly over the limit. */
export function findCtxSharedSizeViolation(
  snapshot: Readonly<Record<string, unknown>>,
): CtxSharedSizeViolation | undefined {
  const actualBytes = measureCtxSharedSnapshotBytes(snapshot);
  if (actualBytes <= MAX_SHARED_SNAPSHOT_BYTES) return undefined;
  return { actualBytes, limitBytes: MAX_SHARED_SNAPSHOT_BYTES };
}

const CTX_SHARED_SIZE_LIMIT_PHASES = ['ctx_shared_set', 'step_completion', 'step_dispatch'] as const;

/** The boundary at which an oversized candidate snapshot was rejected. */
export type CtxSharedSizeLimitPhase = (typeof CTX_SHARED_SIZE_LIMIT_PHASES)[number];

/**
 * Serializable machine contract for a `ctx.shared` quota failure.
 *
 * Recognition is intentionally relative to the limit carried by the payload,
 * rather than this package copy's enforcement constant. That keeps structured
 * fields intact while compatible contract versions coexist across bundles and
 * processes. Enforcement always uses `CTX_SHARED_QUOTA_CONTRACT.limitBytes`.
 */
export const ctxSharedSizeLimitExceededPayloadSchema = z
  .object({
    name: z.literal('CtxSharedSizeLimitExceededError'),
    message: z.string(),
    code: z.literal(CTX_SHARED_QUOTA_CONTRACT.errorCode),
    version: z.number().int().positive(),
    actualBytes: z.number().int().nonnegative(),
    limitBytes: z.number().int().positive(),
    stepName: z.string().min(1),
    phase: z.string().min(1),
    retryable: z.literal(false),
    stack: z.string().optional(),
  })
  .refine(({ actualBytes, limitBytes }) => actualBytes > limitBytes, {
    message: 'actualBytes must be greater than limitBytes',
    path: ['actualBytes'],
  });

export type CtxSharedSizeLimitExceededPayload = z.infer<typeof ctxSharedSizeLimitExceededPayloadSchema>;

export interface CtxSharedSizeLimitExceededErrorOptions {
  readonly actualBytes: number;
  readonly stepName: string;
  readonly phase: CtxSharedSizeLimitPhase;
  readonly stack?: string;
}

/** Public error used at every boundary that enforces the shared quota. */
export class CtxSharedSizeLimitExceededError extends AgentError {
  readonly code = CTX_SHARED_QUOTA_CONTRACT.errorCode;
  readonly version = CTX_SHARED_QUOTA_CONTRACT.version;
  readonly actualBytes: number;
  readonly limitBytes = MAX_SHARED_SNAPSHOT_BYTES;
  readonly stepName: string;
  readonly phase: CtxSharedSizeLimitPhase;
  readonly retryable = false as const;

  constructor(options: CtxSharedSizeLimitExceededErrorOptions) {
    super(
      `Step '${options.stepName}' exceeded the ctx.shared snapshot quota during ${options.phase}: ` +
        `${options.actualBytes} UTF-8 bytes exceeds the ${MAX_SHARED_SNAPSHOT_BYTES}-byte limit. ` +
        `Store only compact state, IDs, or references in ctx.shared and move bulk data to durable storage.`,
    );
    this.name = 'CtxSharedSizeLimitExceededError';
    this.actualBytes = options.actualBytes;
    this.stepName = options.stepName;
    this.phase = options.phase;
    if (options.stack !== undefined) this.stack = options.stack;
  }

  /** Ensure `JSON.stringify(error)` preserves the complete public payload. */
  toJSON(): CtxSharedSizeLimitExceededPayload {
    return {
      name: 'CtxSharedSizeLimitExceededError',
      message: this.message,
      code: this.code,
      version: this.version,
      actualBytes: this.actualBytes,
      limitBytes: this.limitBytes,
      stepName: this.stepName,
      phase: this.phase,
      retryable: this.retryable,
      ...(this.stack === undefined ? {} : { stack: this.stack }),
    };
  }
}

/** Recognize the canonical payload across bundles and process boundaries. */
export function isCtxSharedSizeLimitExceededPayload(value: unknown): value is CtxSharedSizeLimitExceededPayload {
  return ctxSharedSizeLimitExceededPayloadSchema.safeParse(value).success;
}
