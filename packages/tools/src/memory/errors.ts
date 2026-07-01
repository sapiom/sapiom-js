/**
 * Error thrown by the memory capability when the gateway returns a non-2xx
 * response. Exposes `status` (HTTP status code) and `body` (parsed JSON body, or
 * raw text when the body isn't JSON) for programmatic inspection.
 *
 * Useful statuses to branch on: `400` (validation or `SecretDetected`), `401`
 * (missing identity), `402` (route gate balance), `403` (ownership failure),
 * `404` (`get` only), `422` (resource limit), and `507` (store full).
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
