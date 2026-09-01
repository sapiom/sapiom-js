export type SapiomRequestMeta = Record<string, unknown>;

type RequestWithSapiom = Request & { __sapiom?: SapiomRequestMeta };

/** Read per-request metadata from a Request input before native cloning drops it. */
export function readSapiomMetadata(
  input: string | URL | Request,
): SapiomRequestMeta | undefined {
  if (input instanceof Request) {
    return (input as RequestWithSapiom).__sapiom;
  }
  return undefined;
}

/** Copy `__sapiom` from one Request onto another (native Request clones drop it). */
export function copySapiomMetadata(from: Request, to: Request): Request {
  const meta = (from as RequestWithSapiom).__sapiom;
  if (meta) {
    (to as RequestWithSapiom).__sapiom = meta;
  }
  return to;
}

/** `new Request` wrapper that preserves `__sapiom` custom properties. */
export function cloneRequest(
  request: Request,
  init?: RequestInit,
): Request {
  return copySapiomMetadata(request, new Request(request, init));
}

/** Build a Request from fetch input, carrying metadata from a Request source. */
export function requestFromInput(
  input: string | URL | Request,
  init?: RequestInit,
): Request {
  const inputMetadata = readSapiomMetadata(input);
  const request = new Request(input, init);
  if (inputMetadata) {
    const existing = (request as RequestWithSapiom).__sapiom;
    (request as RequestWithSapiom).__sapiom = { ...inputMetadata, ...existing };
  }
  return request;
}
