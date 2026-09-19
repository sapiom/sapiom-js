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

  constructor(args: {
    message: string;
    status: number;
    method: string;
    url: string;
    body: unknown;
  }) {
    super(args.message);
    this.name = "TransportHttpError";
    this.status = args.status;
    this.method = args.method;
    this.url = args.url;
    this.body = args.body;
  }
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
