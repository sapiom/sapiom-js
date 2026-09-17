import { ensureOk as sharedEnsureOk } from "../_client/sapiom-call.js";

/** Error thrown when a coding-run HTTP request is unsuccessful. */
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

/**
 * Return the response when 2xx, otherwise throw a {@link CodingRunHttpError}.
 *
 * Wraps the shared non-2xx path so the facts about the call are recorded in one
 * place, but formats its own message: this capability prefers the API body's
 * `message` and omits the trailing space when the response had no text.
 */
export function ensureCodingRunOk(
  response: Response,
  errorPrefix: string,
): Promise<Response> {
  return sharedEnsureOk(
    response,
    errorPrefix,
    ({ status, body, text }) =>
      new CodingRunHttpError(
        stringField(body, "message") ??
          `${errorPrefix}: ${status}${text ? ` ${text}` : ""}`,
        status,
        body,
      ),
    "models",
  );
}

function stringField(value: unknown, field: string): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === "string" ? candidate : null;
}
