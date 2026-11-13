/** The public HTTP error, preserved so callers can inspect refusals without parsing an Error message. */
export class SapiomApiError extends Error {
  readonly code?: string;
  readonly requestId?: string;

  constructor(
    readonly status: number,
    readonly body: unknown,
    requestId?: string,
  ) {
    super(`Request failed with status ${status}: ${JSON.stringify(body)}`);
    this.name = "SapiomApiError";
    const record =
      typeof body === "object" && body !== null
        ? (body as Record<string, unknown>)
        : {};
    this.code = typeof record.code === "string" ? record.code : undefined;
    this.requestId =
      typeof record.requestId === "string" ? record.requestId : requestId;
  }
}
