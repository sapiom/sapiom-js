/**
 * Error thrown by the `speech` capability when a request fails. Exposes
 * `status` (HTTP status code) and `body` (parsed JSON body, or raw text when the
 * body isn't JSON) for programmatic inspection.
 */
export class SpeechHttpError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "SpeechHttpError";
    this.status = status;
    this.body = body;
  }
}
