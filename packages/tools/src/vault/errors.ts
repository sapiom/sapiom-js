import { ensureOk as sharedEnsureOk } from "../_client/sapiom-call.js";

/**
 * Error thrown by the vault capability when the gateway returns a non-2xx
 * response. Exposes `status` (HTTP status code) and `body` (parsed JSON body, or
 * raw text when the body isn't JSON) for programmatic inspection.
 *
 * Useful statuses to branch on: `401` (missing identity), `403` (ownership
 * failure), `404` (unknown ref/key — `get` maps this to `null` for you).
 */
export class VaultHttpError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "VaultHttpError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Return the response when 2xx, otherwise throw a {@link VaultHttpError}.
 * Parses the error body as JSON when possible; falls back to raw text.
 */
export function ensureOk(
  response: Response,
  errorPrefix: string,
): Promise<Response> {
  return sharedEnsureOk(
    response,
    errorPrefix,
    ({ message, status, body }) => new VaultHttpError(message, status, body),
    "vault",
  );
}
