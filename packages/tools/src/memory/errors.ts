/**
 * Error thrown by the memory capability when the gateway returns a non-2xx
 * response. Exposes `status` (HTTP status code) and `body` (parsed JSON body, or
 * raw text when the body isn't JSON) for programmatic inspection.
 *
 * Useful statuses to branch on: `404` (memory not found / wrong owner, or a
 * `forget` of an already-deleted memory — `forget` is a hard delete, not
 * idempotent), `400` (validation, or a secret detected in `append`
 * content/metadata — the body carries `error: "SecretDetected"` and
 * `decision: "REJECTED"`), `402` (insufficient balance), `422` (spending rules
 * blocked the call), `503` (memory store unavailable).
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
