/**
 * Error thrown by the `searchindex` capability when the gateway returns a
 * non-2xx response. Exposes `status` (HTTP status code) and `body` (parsed JSON
 * body, or raw text when the body isn't JSON) for programmatic inspection.
 *
 * Useful statuses to branch on: `401` (missing/invalid credential), `404`
 * (index not found — also returned on an ownership mismatch), `422`
 * (per-account index limit reached).
 */
export class SearchIndexHttpError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "SearchIndexHttpError";
    this.status = status;
    this.body = body;
  }
}

/**
 * A successful HTTP response that does not match the documented SearchIndex
 * wire contract. This is deliberately distinct from an empty result: callers
 * performing reconciliation must never interpret a gateway/provider regression
 * as an empty index.
 */
export class SearchIndexContractError extends Error {
  readonly operation: string;
  readonly body: unknown;

  constructor(operation: string, message: string, body: unknown) {
    super(`Invalid SearchIndex ${operation} response: ${message}`);
    this.name = "SearchIndexContractError";
    this.operation = operation;
    this.body = body;
  }
}

/**
 * Return the response when 2xx, otherwise throw a {@link SearchIndexHttpError}.
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
  throw new SearchIndexHttpError(
    `${errorPrefix}: ${response.status} ${text}`,
    response.status,
    body,
  );
}
