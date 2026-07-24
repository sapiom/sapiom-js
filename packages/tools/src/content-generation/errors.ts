/**
 * Error thrown by the `contentGeneration` capability when a request fails
 * (non-2xx response). Exposes `status` (HTTP status code) and `body` (parsed JSON
 * body, or raw text when the body isn't JSON) for programmatic inspection.
 */
export class ContentGenerationHttpError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ContentGenerationHttpError";
    this.status = status;
    this.body = body;
  }
}
