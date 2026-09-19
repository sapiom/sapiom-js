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
 * Statuses a repeat can plausibly get past: the server is unavailable (5xx),
 * asking us to slow down (429), or timed out waiting for the request (408, 425).
 *
 * 425 is `Too Early`, a refusal to replay a request sent over TLS early data.
 * It is here because `sandboxes/multipart.ts` already retries it locally, and a
 * failure the SDK retries by itself must not read as deterministic once it
 * escapes the step.
 */
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([408, 425, 429]);

/**
 * The single platform rule: a 5xx, one of {@link TRANSIENT_STATUSES}, or a
 * connection that never produced a response. Versioned with the contract, and
 * the engine may refine it without an SDK release because `status` ships on the
 * payload.
 *
 * Reads through {@link readFacts} so a caller that hands over a Proxy or a
 * throwing getter gets `false`, never an exception: this runs on the failure
 * path, where throwing would replace the error the step actually hit.
 */
export function isTransientSapiomCall(facts: SapiomCallFacts): boolean {
  const safe = readFacts(facts);
  if (safe.network === true) return true;
  if (!isHttpStatus(safe.status)) return false;
  return safe.status >= 500 || TRANSIENT_STATUSES.has(safe.status);
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
  if (!facts) return undefined;
  // Snapshot once, then work off the copy: `facts` may be a duck-typed object
  // from another bundle, or one a step body built with throwing accessors.
  const safe = readFacts(facts);
  if (!isTransientSapiomCall(safe)) return undefined;
  const parsed = sapiomCallTransientErrorPayloadSchema.safeParse({
    // Same reason: a step body can assign anything to `name`, `message` or
    // `stack`, or hang a throwing accessor on them.
    name: asString(readField(error, 'name')) || 'Error',
    message: asString(readField(error, 'message')),
    code: SAPIOM_CALL_TRANSIENT_ERROR_CONTRACT.errorCode,
    version: SAPIOM_CALL_TRANSIENT_ERROR_CONTRACT.version,
    retryable: SAPIOM_CALL_TRANSIENT_ERROR_CONTRACT.retryable,
    ...normalizeFacts(safe),
    ...stackOf(error),
  });
  // The last resort behind the normalization above: whatever slipped through, the
  // error ships as a legacy one rather than this helper becoming the failure.
  return parsed.success ? parsed.data : undefined;
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
  if (typeof facts.retryAfterMs === 'number' && facts.retryAfterMs >= 0) {
    // A `Retry-After` header is caller-controlled, so the delay can be any
    // magnitude. Beyond the safe-integer range the schema rejects it, and a
    // rejection here would replace the HTTP error with a validation one.
    const rounded = Math.round(facts.retryAfterMs);
    if (Number.isSafeInteger(rounded)) normalized.retryAfterMs = rounded;
  }
  return normalized;
}

/**
 * Copy the facts field by field, swallowing a throwing getter or Proxy trap.
 * Every read of an untrusted `facts` goes through this, so the rule and the
 * normalizer below work on plain values that cannot throw again.
 */
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

/** Read a field a step body may have replaced, or hung a throwing accessor on. */
function readField(error: Error, key: 'name' | 'message' | 'stack'): unknown {
  try {
    return error[key];
  } catch {
    return undefined;
  }
}

/** Coerce to a string, or empty when the value refuses to become one. */
function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return String(value);
  } catch {
    return '';
  }
}

/** The stack only when it really is one: a coerced object helps nobody debug. */
function stackOf(error: Error): { stack?: string } {
  const stack = readField(error, 'stack');
  return typeof stack === 'string' ? { stack } : {};
}
