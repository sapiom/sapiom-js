import { z } from 'zod/v4';

/**
 * The retryable direction of the closed step-error contract.
 *
 * `non-retryable-step-error.ts` carries the platform errors that may bypass
 * workflow retry; this one carries the single error a host may *keep* on the
 * retry path: a Sapiom-surface call that failed transiently.
 *
 * Responsibilities are split so no layer holds two:
 *
 *   - `@sapiom/tools` records FACTS on the thrown error (which capability, what
 *     status, any `Retry-After`, whether a response ever existed). It never
 *     decides anything.
 *   - this module holds the ONE versioned rule that turns those facts into the
 *     wire payload, plus the payload's schema and parsers.
 *   - the engine owns the retry POLICY (attempts, backoff, fail-fast). It never
 *     needs an SDK release to change its mind: `status`, `capability`, and
 *     `retryAfterMs` all travel on the wire, so it can re-derive or refine.
 *
 * The facts are passed in rather than read here on purpose: `@sapiom/tools`
 * owns the marker key and this package owns the rule, so neither duplicates the
 * other's literal. The step-runner composes the two at the dispatch boundary.
 */

/** Versioned contract for a transient Sapiom-surface call failure. */
export const SAPIOM_CALL_TRANSIENT_ERROR_CONTRACT = Object.freeze({
  version: 1,
  errorCode: 'SAPIOM_CALL_TRANSIENT',
  retryable: true,
} as const);

/**
 * What a Sapiom-surface call reports about its own failure. Facts only: there
 * is deliberately no disposition field here.
 */
export interface SapiomCallFacts {
  /** Routed capability id, or the module namespace the call belonged to. */
  readonly capability?: string;
  /** HTTP status of the response, absent when no response ever existed. */
  readonly status?: number;
  /** Parsed `Retry-After`, in milliseconds. A fact; consuming it is policy. */
  readonly retryAfterMs?: number;
  /** `fetch` rejected before any response existed. */
  readonly network?: boolean;
}

const MAX_CAPABILITY_LENGTH = 200;

const isHttpStatus = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599;

/**
 * The single platform rule: 5xx, 429, 408, or a connection that never produced
 * a response. Versioned with the contract, and the engine may refine it without
 * an SDK release because `status` ships on the payload.
 */
export function isTransientSapiomCall(facts: SapiomCallFacts): boolean {
  if (facts.network === true) return true;
  if (!isHttpStatus(facts.status)) return false;
  return facts.status >= 500 || facts.status === 429 || facts.status === 408;
}

const httpStatusSchema = z.number().int().min(100).max(599);

/**
 * Recognition is relative to the version carried by the payload, not this
 * package copy's constant, so compatible contract versions coexist across
 * bundles and processes (same rule as the ctx.shared quota contract).
 */
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
 * Boundary conversion, host side: build the canonical payload for a thrown
 * error whose recorded facts say the failure was transient.
 *
 * Returns `undefined` when there are no facts or they are not transient: a
 * deterministic failure (4xx) deliberately ships as a legacy error carrying no
 * disposition field at all, so today's retry behavior stays byte-identical
 * until the engine's fail-fast flag decides otherwise.
 *
 * Total by construction: out-of-range or malformed facts are dropped rather
 * than thrown on, because a serialization helper on the failure path must never
 * be the thing that fails.
 */
export function toRetryableStepErrorPayload(
  error: Error,
  facts: SapiomCallFacts | undefined,
): RetryableStepErrorPayload | undefined {
  if (!facts || !isTransientSapiomCall(facts)) return undefined;
  return sapiomCallTransientErrorPayloadSchema.parse({
    name: error.name || 'Error',
    message: error.message,
    code: SAPIOM_CALL_TRANSIENT_ERROR_CONTRACT.errorCode,
    version: SAPIOM_CALL_TRANSIENT_ERROR_CONTRACT.version,
    retryable: SAPIOM_CALL_TRANSIENT_ERROR_CONTRACT.retryable,
    ...normalizeFacts(facts),
    ...(error.stack === undefined ? {} : { stack: error.stack }),
  });
}

/**
 * Wire parse, engine side. Returning parsed schema data strips arbitrary extra
 * properties before the value crosses a trust or persistence boundary.
 */
export function parseRetryableStepErrorPayload(value: unknown): RetryableStepErrorPayload | undefined {
  const parsed = sapiomCallTransientErrorPayloadSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Structural guard for callers that only need the retry disposition. */
export function isRetryableStepErrorPayload(value: unknown): value is RetryableStepErrorPayload {
  return parseRetryableStepErrorPayload(value) !== undefined;
}

/** Keep only the facts that survive the schema, so the build above cannot throw. */
function normalizeFacts(facts: SapiomCallFacts): Partial<RetryableStepErrorPayload> {
  const normalized: Partial<RetryableStepErrorPayload> = {};
  if (isHttpStatus(facts.status)) normalized.status = facts.status;
  if (typeof facts.capability === 'string' && facts.capability.length > 0) {
    normalized.capability = facts.capability.slice(0, MAX_CAPABILITY_LENGTH);
  }
  if (typeof facts.retryAfterMs === 'number' && Number.isFinite(facts.retryAfterMs) && facts.retryAfterMs >= 0) {
    normalized.retryAfterMs = Math.round(facts.retryAfterMs);
  }
  return normalized;
}
