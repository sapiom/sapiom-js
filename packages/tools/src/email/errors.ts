import { ensureOk as sharedEnsureOk } from "../_client/sapiom-call.js";

/**
 * Error thrown by the `email` capability when a request fails (non-2xx response).
 * Exposes `status` (HTTP status code) and `body` (parsed JSON body, or raw text
 * when the body isn't JSON) for programmatic inspection.
 */
export class EmailHttpError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "EmailHttpError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Return the response when 2xx, otherwise throw an {@link EmailHttpError}.
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
    ({ message, status, body }) => new EmailHttpError(message, status, body),
    "email",
  );
}
