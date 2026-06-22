/**
 * Error thrown by SapiomFileStorage methods when the gateway returns a non-2xx
 * response. Exposes `status` (HTTP status code) and `body` (parsed response
 * body or raw text when JSON parsing fails) for programmatic inspection.
 */
export class FileStorageHttpError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "FileStorageHttpError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Throw a FileStorageHttpError if the response status is not 2xx.
 * Parses the body as JSON when possible; falls back to text.
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
  throw new FileStorageHttpError(
    `${errorPrefix}: ${response.status} ${text}`,
    response.status,
    body,
  );
}
