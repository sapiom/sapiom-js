/**
 * Structured transport errors.
 *
 * `Transport.request` throws a {@link TransportHttpError} on any non-2xx so a
 * capability can branch on the STATUS — 404 "no such resource" vs 400 "the
 * platform refused this input" — instead of scraping a message string. The
 * message text is byte-identical to the plain `Error` this replaced, so
 * anything matching on it keeps working.
 *
 * @internal Not part of the package's public surface: it is deliberately absent
 * from the root barrel, and `@sapiom/tools` publishes no `./_client` subpath.
 * A capability translates it into ITS own author-facing error before the value
 * reaches a caller (see `agents`' `AgentRunError`). Consumers who want a typed
 * HTTP failure use the per-capability classes (`SearchHttpError`, …).
 */
export class TransportHttpError extends Error {
  /** HTTP status the platform answered with. */
  readonly status: number;
  /** Request method, for context in logs. */
  readonly method: string;
  /** Request URL, for context in logs. */
  readonly url: string;
  /** Parsed JSON response body, or the raw text when the body isn't JSON. */
  readonly body: unknown;
  /**
   * The platform's `Retry-After` header as a delay in milliseconds, when it sent
   * one (a 429 or 503 usually does); `null` otherwise. A poll loop that backs
   * off on a transient status uses this over its own schedule when present.
   */
  readonly retryAfterMs: number | null;

  constructor(args: {
    message: string;
    status: number;
    method: string;
    url: string;
    body: unknown;
    retryAfterMs?: number | null;
  }) {
    super(args.message);
    this.name = "TransportHttpError";
    this.status = args.status;
    this.method = args.method;
    this.url = args.url;
    this.body = args.body;
    this.retryAfterMs = args.retryAfterMs ?? null;
  }
}

/**
 * Parse a `Retry-After` header into a delay in milliseconds. Accepts both forms
 * RFC 9110 allows — a non-negative number of seconds, or an HTTP-date — and
 * returns `null` for a missing or unparseable value. A date in the past is a
 * delay of zero, not `null`: the platform did answer, and "now" is its answer.
 */
export function parseRetryAfterMs(
  header: string | null | undefined,
  now: number = Date.now(),
): number | null {
  if (header == null) return null;
  const value = header.trim();
  if (value === "") return null;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  // Any other bare number (negative, fractional) is malformed, not a date —
  // `Date.parse("-5")` would otherwise read it as a year.
  if (/^[-+]?\d*\.?\d+$/.test(value)) return null;
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

/**
 * Read a non-2xx response body once, preferring parsed JSON and falling back to
 * the raw text. Never throws — a body that can't be read resolves as `""`.
 */
export async function readErrorBody(
  response: Response,
): Promise<{ text: string; body: unknown }> {
  const text = await response.text().catch(() => "");
  try {
    return { text, body: JSON.parse(text) };
  } catch {
    return { text, body: text };
  }
}

/** What a non-2xx response carried, for a capability to build its own error from. */
export interface HttpFailure {
  /** `${errorPrefix}: ${status} ${text}`. */
  readonly message: string;
  readonly status: number;
  /** Parsed JSON, or the raw text. */
  readonly body: unknown;
  readonly text: string;
  readonly retryAfterMs: number | undefined;
  readonly errorPrefix: string;
}

export type HttpErrorFactory = (failure: HttpFailure) => Error;

/**
 * Return a 2xx response, otherwise throw the error `makeError` builds from it.
 * The one non-2xx path every capability namespace goes through, so each keeps
 * its own error class while the body and `Retry-After` are read in one place.
 */
export async function ensureOk(
  response: Response,
  errorPrefix: string,
  makeError: HttpErrorFactory,
): Promise<Response> {
  if (response.ok) return response;
  const { text, body } = await readErrorBody(response);
  // A test double may have no `headers`.
  const retryAfterMs =
    parseRetryAfterMs(response.headers?.get?.("Retry-After")) ?? undefined;
  throw makeError({
    message: `${errorPrefix}: ${response.status} ${text}`,
    status: response.status,
    body,
    text,
    retryAfterMs,
    errorPrefix,
  });
}
