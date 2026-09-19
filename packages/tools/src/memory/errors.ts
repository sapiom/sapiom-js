import { ensureOk as sharedEnsureOk } from "../_client/sapiom-call.js";

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
 *
 * A two-line wrapper over the shared non-2xx path: the public error class is
 * unchanged, and the facts about the call (status, `Retry-After`, which
 * capability) are recorded in exactly one place.
 */
export function ensureOk(
  response: Response,
  errorPrefix: string,
): Promise<Response> {
  return sharedEnsureOk(
    response,
    errorPrefix,
    ({ message, status, body }) => new MemoryHttpError(message, status, body),
    "memory",
  );
}
