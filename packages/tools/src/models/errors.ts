/**
 * Error thrown when a coding-run HTTP request returns a non-2xx response.
 * Exposes the status, parsed response body, stable error code, and gateway
 * request id for programmatic handling.
 */
export class CodingRunHttpError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly requestId: string | null;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "CodingRunHttpError";
    this.status = status;
    this.body = body;
    this.code = stringField(body, "error") ?? stringField(body, "code");
    this.requestId = stringField(body, "requestId");
  }
}

/** Parse a failed response once, preserving JSON or raw text for the caller. */
export async function ensureCodingRunOk(
  response: Response,
  errorPrefix: string,
): Promise<Response> {
  if (response.ok) return response;

  const text = await response.text().catch(() => "");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  throw new CodingRunHttpError(
    stringField(body, "message") ??
      `${errorPrefix}: ${response.status}${text ? ` ${text}` : ""}`,
    response.status,
    body,
  );
}

function stringField(value: unknown, field: string): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === "string" ? candidate : null;
}
