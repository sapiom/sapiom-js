/**
 * Error thrown by the memory capability when the memory service returns a
 * non-2xx response. Exposes `status` (HTTP status code) and `body` (parsed
 * JSON body, or raw text when the body isn't JSON) for programmatic inspection.
 *
 * Wrap semantics: caller-safe validation errors pass through as `400` with a
 * stable `body.code` to branch on — `invalid_metadata`, `invalid_filter`, and
 * `secret_detected`. Other request-shape violations (e.g. oversized content)
 * surface as a plain `400` without a stable code. Infrastructure failures are
 * wrapped and surface only as a generic `502` (service error), `503` (memory
 * unavailable), or `504` (timeout) — details are logged server-side, never
 * returned. `401`/`402`/`403` keep their usual identity/balance/ownership
 * meanings.
 */
export class MemoryHttpError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "MemoryHttpError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Return the response when 2xx, otherwise throw a {@link MemoryHttpError}.
 * Parses the error body as JSON when possible; falls back to raw text.
 */
export async function ensureOk(
  response: Response,
  errorPrefix: string,
): Promise<Response> {
  if (response.ok) return response;
  let body: unknown;
  const text = await response.text().catch(() => "");
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  throw new MemoryHttpError(
    `${errorPrefix}: ${response.status} ${text}`,
    response.status,
    body,
  );
}
