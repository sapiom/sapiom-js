/**
 * The facts a failed Sapiom-surface call records about itself, and the one
 * non-2xx path every capability namespace funnels through.
 *
 * This module holds NO opinion about retrying. It stamps what happened (which
 * capability, what status, any `Retry-After`, whether a response ever existed)
 * onto the error the SDK already throws. The single rule that turns those facts
 * into a retry disposition lives in `@sapiom/agent`, and the retry policy itself
 * lives in the engine. Keeping the judgement out of the SDK means changing it
 * later is a platform deploy, not a release plus a rebuild of every agent
 * artifact (each bundles its own copy of this package).
 *
 * The marker is a plain enumerable property rather than a new error class on
 * purpose: author code that does `catch (e) { if (e instanceof SearchHttpError)
 * return fail(); }` must keep working, and recognition has to survive the
 * artifact bundle inlining its own copy of `@sapiom/tools`, where `instanceof`
 * across copies is false.
 */

/** Where the facts live on a thrown error. Public: authors may read them. */
export const SAPIOM_CALL_MARKER_KEY = "sapiomCall" as const;

/** Version this copy stamps. See {@link SapiomCallMarker.version}. */
export const SAPIOM_CALL_FACTS_VERSION = 1;

/** Longest capability label kept; the engine reports this as a metric attribute. */
const MAX_CAPABILITY_LENGTH = 200;

/**
 * Facts about the Sapiom-surface call that failed. Present on every surface
 * error, deterministic ones included: `err.sapiomCall.status` is the uniform
 * way to read the status an author used to have to remember per error class.
 */
export interface SapiomCallMarker {
  /**
   * Version of the fact contract, `1` today. Read as a number, not a literal:
   * a newer bundle copy in the same process may stamp a later version whose
   * common fields are still readable.
   */
  readonly version: number;
  /** Routed capability id (`web.search`), or the namespace the call belonged to. */
  readonly capability?: string;
  /** HTTP status of the response. Absent when no response ever existed. */
  readonly status?: number;
  /** Parsed `Retry-After`, in milliseconds. */
  readonly retryAfterMs?: number;
  /** `fetch` rejected before any response existed. */
  readonly network?: boolean;
}

/** The facts a caller supplies; the contract version is stamped here. */
export type SapiomCallFactsInput = Omit<SapiomCallMarker, "version">;

/**
 * Attach the facts to `err` and return it. Idempotent (the innermost call that
 * saw the response wins), additive (never touches `code`, `status`, `body`, or
 * any other field the error class owns), and total: an error on the failure
 * path must never be made worse by the act of describing it.
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
    // A frozen or exotic error simply carries no facts.
  }
  return err;
}

/**
 * Read the facts back. Structural, so it works across bundle copies and on a
 * duck-typed error that never touched this package. Never throws: a throwing
 * property accessor or a null prototype just means "no facts".
 */
export function readSapiomCall(err: unknown): SapiomCallMarker | undefined {
  try {
    if (err === null || typeof err !== "object") return undefined;
    const candidate = (err as Record<string, unknown>)[SAPIOM_CALL_MARKER_KEY];
    return isMarker(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Typed replacement for the bare `Error` that non-2xx responses used to throw
 * from `Transport.request` and a handful of capability methods. Same message,
 * now with `status` and `body` like every other Sapiom error class.
 */
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

/** Everything the shared helper learned about a non-2xx response. */
export interface SapiomCallFailure {
  /** The standard message: `${errorPrefix}: ${status} ${text}`. */
  readonly message: string;
  readonly status: number;
  /** Parsed JSON body when the response was JSON, otherwise the raw text. */
  readonly body: unknown;
  /** Raw response text, for the one capability that formats its own message. */
  readonly text: string;
  /** Parsed `Retry-After`, in milliseconds. */
  readonly retryAfterMs: number | undefined;
  readonly errorPrefix: string;
}

/**
 * Build the capability-specific error to throw. Each namespace passes its own
 * so its public error class (`SearchHttpError`, …) is unchanged.
 */
export type SapiomCallErrorFactory = (failure: SapiomCallFailure) => Error;

/**
 * Return the response when 2xx, otherwise throw the capability's own error with
 * the call's facts stamped on it. The single place a non-2xx becomes an error,
 * so the single place the facts are recorded.
 */
export async function ensureOk(
  response: Response,
  errorPrefix: string,
  makeError: SapiomCallErrorFactory,
  capability?: string,
): Promise<Response> {
  if (response.ok) return response;
  const text = await response.text().catch(() => "");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  // Optional-chained on purpose: this runs on the failure path, where the
  // "response" may be a hand-rolled test double with no `headers`.
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

/**
 * {@link ensureOk} for the call sites that had no typed error of their own and
 * threw a bare `Error`. Message shape preserved; the class is now
 * {@link SapiomCallError}.
 */
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

/**
 * Parse a `Retry-After` header value. Supports both forms:
 *  - delta-seconds integer (e.g. `"30"`)
 *  - HTTP-date (e.g. `"Wed, 21 Oct 2015 07:28:00 GMT"`)
 */
export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/**
 * Best-effort capability label for a URL, used where no routed id was passed
 * (a network failure, a non-routed namespace). Deliberately bounded: the engine
 * reports this as a metric attribute, so a resource id must never reach it.
 * Returns the routed capability id for `/v1/capabilities/<id>`, otherwise the
 * single path segment naming the namespace.
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

/** Accept only a short, static-looking path token, never an id. */
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
