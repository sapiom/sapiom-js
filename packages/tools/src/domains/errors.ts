import { ensureOk as sharedEnsureOk } from "../_client/sapiom-call.js";

/**
 * Error thrown by the domains capability when a request fails (non-2xx
 * response). Exposes `status` (HTTP status code) and `body` (parsed JSON body, or
 * raw text when the body isn't JSON) for programmatic inspection.
 */
export class DomainsHttpError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "DomainsHttpError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Return the response when 2xx, otherwise throw a {@link DomainsHttpError}.
 * Parses the error body as JSON when possible; falls back to raw text.
 */
export function ensureOk(
  response: Response,
  errorPrefix: string,
): Promise<Response> {
  return sharedEnsureOk(
    response,
    errorPrefix,
    ({ message, status, body }) => new DomainsHttpError(message, status, body),
    "domains",
  );
}
