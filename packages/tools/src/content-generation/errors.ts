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

/**
 * Error thrown when a launched media job reaches a terminal FAILED state — the provider
 * job errored, was cancelled, or completed with an error, so no asset was ever produced
 * (SAP-3097).
 *
 * Distinct from {@link ContentGenerationHttpError}, which reports an HTTP request that
 * failed, and from the plain `Error` a poll throws when `timeoutMs` elapses with the job
 * still in flight. Catching this one means "the generation failed"; catching the timeout
 * means "it is still running and I stopped waiting".
 *
 *   try {
 *     const out = await handle.wait();
 *   } catch (err) {
 *     if (err instanceof ContentGenerationFailedError) {
 *       // The model failed. `err.providerError` says why; retrying the same prompt
 *       // will probably fail the same way.
 *     }
 *   }
 */
export class ContentGenerationFailedError extends Error {
  /** The queue request id of the failed job. */
  readonly requestId: string;
  /** The provider's own reason for the failure. */
  readonly providerError: string;
  /** The raw polled body the failure was read from, for programmatic inspection. */
  readonly body: unknown;

  /**
   * @param mediaLabel How the medium is named in the message, e.g. `"Image"` / `"Video"`.
   */
  constructor(
    mediaLabel: string,
    requestId: string,
    providerError: string,
    body: unknown,
  ) {
    super(
      `${mediaLabel} generation failed (request id: ${requestId}): ${providerError}`,
    );
    this.name = "ContentGenerationFailedError";
    this.requestId = requestId;
    this.providerError = providerError;
    this.body = body;
  }
}

/**
 * Return the response when 2xx, otherwise throw a {@link ContentGenerationHttpError}.
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
  throw new ContentGenerationHttpError(
    `${errorPrefix}: ${response.status} ${text}`,
    response.status,
    body,
  );
}
