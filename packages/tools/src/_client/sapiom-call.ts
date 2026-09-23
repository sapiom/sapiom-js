/**
 * Facts a failed Sapiom call records about itself, and the shared non-2xx path.
 *
 * Facts only: nothing here decides whether a call is retried. The marker is a
 * plain property, not an error class, so `instanceof` checks keep working and
 * recognition survives an artifact bundling its own copy of this package.
 */

import { readErrorBody } from "./errors.js";

/** Where the facts live on a thrown error. */
export const SAPIOM_CALL_MARKER_KEY = "sapiomCall" as const;

export const SAPIOM_CALL_FACTS_VERSION = 1;

const MAX_CAPABILITY_LENGTH = 200;

/**
 * Facts about a call that was sent and failed. Absent when a capability rejects
 * its input before sending: no response existed, so no status is invented.
 */
export interface SapiomCallMarker {
  /** Read as a number: another bundle copy may stamp a later version. */
  readonly version: number;
  /**
   * Routed capability id, or the call's namespace. Derived from the URL on a
   * network failure, so it can be coarser than on a response failure.
   */
  readonly capability?: string;
  /** Absent when no response existed. */
  readonly status?: number;
  readonly retryAfterMs?: number;
  /** `fetch` rejected before any response existed. */
  readonly network?: boolean;
}

export type SapiomCallFactsInput = Omit<SapiomCallMarker, "version">;

/**
 * Attach the facts to `err`. Idempotent (the innermost call wins), additive, and
 * never throws: describing a failure must not replace it.
 */
export function markSapiomCall<E extends Error>(
  err: E,
  facts: SapiomCallFactsInput,
): E {
  try {
    if (SAPIOM_CALL_MARKER_KEY in err) return err;
    Object.defineProperty(err, SAPIOM_CALL_MARKER_KEY, {
      value: Object.freeze(buildMarker(facts)),
      enumerable: true,
      writable: false,
      configurable: false,
    });
  } catch {
    // A frozen error carries no facts.
  }
  return err;
}

/** Structural, so it works across bundle copies. Never throws. */
export function readSapiomCall(err: unknown): SapiomCallMarker | undefined {
  try {
    if (err === null || typeof err !== "object") return undefined;
    const candidate = (err as Record<string, unknown>)[SAPIOM_CALL_MARKER_KEY];
    return isMarker(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/** Thrown on a non-2xx by call sites that have no error class of their own. */
export class SapiomCallError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "SapiomCallError";
    this.status = status;
    this.body = body;
  }
}

export interface SapiomCallFailure {
  /** `${errorPrefix}: ${status} ${text}`. */
  readonly message: string;
  readonly status: number;
  /** Parsed JSON, or the raw text. */
  readonly body: unknown;
  readonly text: string;
  readonly retryAfterMs: number | undefined;
  readonly errorPrefix: string;
}

export type SapiomCallErrorFactory = (failure: SapiomCallFailure) => Error;

/**
 * Return a 2xx response, otherwise throw the capability's own error with the
 * call's facts stamped on it.
 */
export async function ensureOk(
  response: Response,
  errorPrefix: string,
  makeError: SapiomCallErrorFactory,
  capability?: string,
): Promise<Response> {
  if (response.ok) return response;
  const { text, body } = await readErrorBody(response);
  // A test double may have no `headers`.
  const retryAfterMs = parseRetryAfter(
    response.headers?.get?.("Retry-After") ?? null,
  );
  const error = makeError({
    message: `${errorPrefix}: ${response.status} ${text}`,
    status: response.status,
    body,
    text,
    retryAfterMs,
    errorPrefix,
  });
  throw markSapiomCall(error, {
    status: response.status,
    ...(capability === undefined ? {} : { capability }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

/** {@link ensureOk}, throwing a {@link SapiomCallError}. */
export function failIfNotOk(
  response: Response,
  errorPrefix: string,
  capability?: string,
): Promise<Response> {
  return ensureOk(
    response,
    errorPrefix,
    ({ message, status, body }) => new SapiomCallError(message, status, body),
    capability,
  );
}

/** Past a day, a `Retry-After` is a parse accident, not a hint. */
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

/** Numeric-looking, but not `1*DIGIT`. */
const MALFORMED_DELTA_SECONDS = /^[+-]?[\d.]+(?:[eE][+-]?\d+)?$/;

/**
 * Parse `Retry-After` (RFC 9110): delta-seconds (`1*DIGIT`) or an HTTP-date.
 * A malformed number is rejected, not passed to `Date.parse`, which accepts
 * `"1.5"` as a date. Returns `undefined` rather than guess, so the caller falls
 * back to its own backoff.
 */
export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const value = header.trim();
  if (/^\d+$/.test(value)) {
    const ms = Number(value) * 1000;
    return Number.isSafeInteger(ms) ? ms : undefined;
  }
  if (MALFORMED_DELTA_SECONDS.test(value)) return undefined;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  const ms = Math.max(0, date - Date.now());
  return ms <= MAX_RETRY_AFTER_MS ? ms : undefined;
}

/**
 * Capability label for a URL: the routed id under `/v1/capabilities/<id>`,
 * otherwise the namespace segment. Never a resource id, since it ends up as a
 * metric attribute.
 */
export function capabilityOf(url: string): string | undefined {
  try {
    const segments = new URL(url).pathname.split("/").filter(Boolean);
    if (segments.length === 0) return undefined;
    const versionAt = segments.findIndex((s) => /^v\d+$/.test(s));
    const rest = versionAt === -1 ? segments : segments.slice(versionAt + 1);
    const head = rest[0] ?? segments[0];
    if (head === "capabilities" && rest[1] !== undefined) {
      return staticSegment(rest[1]);
    }
    return staticSegment(head);
  } catch {
    return undefined;
  }
}

/** A short static token, never an id. */
function staticSegment(segment: string | undefined): string | undefined {
  if (segment === undefined) return undefined;
  return /^[a-z][a-z0-9._-]{0,39}$/i.test(segment) ? segment : undefined;
}

function buildMarker(facts: SapiomCallFactsInput): SapiomCallMarker {
  const marker: {
    -readonly [K in keyof SapiomCallMarker]: SapiomCallMarker[K];
  } = { version: SAPIOM_CALL_FACTS_VERSION };
  if (typeof facts.capability === "string" && facts.capability.length > 0) {
    marker.capability = facts.capability.slice(0, MAX_CAPABILITY_LENGTH);
  }
  if (typeof facts.status === "number" && Number.isInteger(facts.status)) {
    marker.status = facts.status;
  }
  if (
    typeof facts.retryAfterMs === "number" &&
    Number.isFinite(facts.retryAfterMs) &&
    facts.retryAfterMs >= 0
  ) {
    marker.retryAfterMs = Math.round(facts.retryAfterMs);
  }
  if (facts.network === true) marker.network = true;
  return marker;
}

function isMarker(value: unknown): value is SapiomCallMarker {
  if (typeof value !== "object" || value === null) return false;
  const version = (value as { version?: unknown }).version;
  return (
    typeof version === "number" && Number.isInteger(version) && version > 0
  );
}
