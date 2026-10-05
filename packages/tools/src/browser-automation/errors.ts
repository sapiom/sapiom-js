import { readErrorBody } from "../_client/errors.js";

/**
 * Error thrown by the `browserAutomation` capability when a request fails
 * (non-2xx response). Exposes `status` (HTTP status code) and `body` (parsed
 * JSON body, or raw text when the body isn't JSON) for programmatic inspection.
 */
export class BrowserAutomationHttpError extends Error {
  readonly status: number;
  readonly body: unknown;
  /** The Sapiom error code, when supplied. No codes are inferred from message text. */
  readonly code?: string;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "BrowserAutomationHttpError";
    this.status = status;
    this.body = body;
    if (
      typeof body === "object" &&
      body !== null &&
      "code" in body &&
      typeof body.code === "string"
    ) {
      this.code = body.code;
    }
  }
}

/**
 * Return the response when 2xx, otherwise throw a {@link BrowserAutomationHttpError}.
 * Parses the error body as JSON when possible; falls back to raw text.
 */
export async function ensureOk(
  response: Response,
  errorPrefix: string,
): Promise<Response> {
  if (response.ok) return response;
  const { body } = await readErrorBody(response);
  throw new BrowserAutomationHttpError(
    `${errorPrefix}: HTTP ${response.status}`,
    response.status,
    body,
  );
}
