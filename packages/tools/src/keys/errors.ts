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
  throw new KeysHttpError(
    `${errorPrefix}: ${response.status} ${text}`,
    response.status,
    body,
  );
}
