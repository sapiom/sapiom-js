import { ensureOk as sharedEnsureOk } from "../_client/sapiom-call.js";

/**
 * Error thrown by the `keys` capability when the Core API returns a non-2xx
 * response to a mint request. Exposes `status` (HTTP status code) and `body`
 * (parsed JSON body, or raw text when the body isn't JSON) for programmatic
 * inspection.
 *
 * Useful statuses to branch on: `401` (missing/invalid credential), `403` (the
 * caller is not a workflow-run token, or the requested scope exceeds it).
 */
export class KeysHttpError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "KeysHttpError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Return the response when 2xx, otherwise throw a {@link KeysHttpError}.
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
    ({ message, status, body }) => new KeysHttpError(message, status, body),
    "keys",
  );
}
