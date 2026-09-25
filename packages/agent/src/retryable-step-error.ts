import { z } from 'zod/v4';

/**
 * The retryable side of the closed step-error contract: a Sapiom call that
 * failed transiently.
 *
 * `@sapiom/tools` records the facts, this module holds the one rule that turns
 * them into a wire payload, and the host applies retry policy. The facts are
 * passed in so neither package duplicates the other's marker key.
 */

export const SAPIOM_CALL_TRANSIENT_ERROR_CONTRACT = Object.freeze({
  version: 1,
  errorCode: 'SAPIOM_CALL_TRANSIENT',
  retryable: true,
} as const);

/** What a Sapiom call reports about its own failure. Facts, no verdict. */
export interface SapiomCallFacts {
  readonly capability?: string;
  /** Absent when no response existed. */
  readonly status?: number;
  readonly retryAfterMs?: number;
  /** `fetch` rejected before any response existed. */
  readonly network?: boolean;
}

const MAX_CAPABILITY_LENGTH = 200;

const isHttpStatus = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599;

/** Timeouts and rate limits. 425 matches what `sandboxes/multipart` retries locally. */
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([408, 425, 429]);

/**
 * A 5xx, one of {@link TRANSIENT_STATUSES}, or a connection that never
 * happened. Never throws, even on a hostile `facts` object.
 */
export function isTransientSapiomCall(facts: SapiomCallFacts): boolean {
  const safe = readFacts(facts);
  if (safe.network === true) return true;
  if (!isHttpStatus(safe.status)) return false;
  return safe.status >= 500 || TRANSIENT_STATUSES.has(safe.status);
}

const httpStatusSchema = z.number().int().min(100).max(599);

/** Accepts any positive version, so compatible contract versions coexist. */
export const sapiomCallTransientErrorPayloadSchema = z.object({
  name: z.string().min(1),
  message: z.string(),
  code: z.literal(SAPIOM_CALL_TRANSIENT_ERROR_CONTRACT.errorCode),
  version: z.number().int().positive(),
  retryable: z.literal(true),
  status: httpStatusSchema.optional(),
  capability: z.string().min(1).max(MAX_CAPABILITY_LENGTH).optional(),
  retryAfterMs: z.number().int().nonnegative().optional(),
  stack: z.string().optional(),
});

export type RetryableStepErrorPayload = z.infer<typeof sapiomCallTransientErrorPayloadSchema>;

/**
 * Build the payload for an error whose facts say it was transient, or
 * `undefined` so it ships as a legacy error. Never throws: it runs on the
 * failure path, where throwing would replace the step's real error.
 */
export function toRetryableStepErrorPayload(
  error: Error,
  facts: SapiomCallFacts | undefined,
): RetryableStepErrorPayload | undefined {
  if (!facts) return undefined;
  const safe = readFacts(facts);
  if (!isTransientSapiomCall(safe)) return undefined;
  const parsed = sapiomCallTransientErrorPayloadSchema.safeParse({
    name: asString(readField(error, 'name')) || 'Error',
    message: asString(readField(error, 'message')),
    code: SAPIOM_CALL_TRANSIENT_ERROR_CONTRACT.errorCode,
    version: SAPIOM_CALL_TRANSIENT_ERROR_CONTRACT.version,
    retryable: SAPIOM_CALL_TRANSIENT_ERROR_CONTRACT.retryable,
    ...normalizeFacts(safe),
    ...stackOf(error),
  });
  return parsed.success ? parsed.data : undefined;
}

/** Parse a wire payload, stripping unknown fields. */
export function parseRetryableStepErrorPayload(value: unknown): RetryableStepErrorPayload | undefined {
  const parsed = sapiomCallTransientErrorPayloadSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function isRetryableStepErrorPayload(value: unknown): value is RetryableStepErrorPayload {
  return parseRetryableStepErrorPayload(value) !== undefined;
}

/** Keep only the facts the schema accepts. */
function normalizeFacts(facts: SapiomCallFacts): Partial<RetryableStepErrorPayload> {
  const normalized: Partial<RetryableStepErrorPayload> = {};
  if (isHttpStatus(facts.status)) normalized.status = facts.status;
  if (typeof facts.capability === 'string' && facts.capability.length > 0) {
    normalized.capability = facts.capability.slice(0, MAX_CAPABILITY_LENGTH);
  }
  if (typeof facts.retryAfterMs === 'number' && facts.retryAfterMs >= 0) {
    const rounded = Math.round(facts.retryAfterMs);
    if (Number.isSafeInteger(rounded)) normalized.retryAfterMs = rounded;
  }
  return normalized;
}

/** Copy the facts field by field, swallowing a throwing getter or Proxy trap. */
function readFacts(facts: SapiomCallFacts): SapiomCallFacts {
  const read = (key: keyof SapiomCallFacts): unknown => {
    try {
      return facts[key];
    } catch {
      return undefined;
    }
  };
  return {
    capability: read('capability') as string | undefined,
    status: read('status') as number | undefined,
    retryAfterMs: read('retryAfterMs') as number | undefined,
    network: read('network') as boolean | undefined,
  };
}

function readField(error: Error, key: 'name' | 'message' | 'stack'): unknown {
  try {
    return error[key];
  } catch {
    return undefined;
  }
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return String(value);
  } catch {
    return '';
  }
}

function stackOf(error: Error): { stack?: string } {
  const stack = readField(error, 'stack');
  return typeof stack === 'string' ? { stack } : {};
}
