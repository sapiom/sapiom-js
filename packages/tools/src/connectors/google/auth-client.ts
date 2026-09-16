/**
 * A proxy-backed Google `authClient()` that keeps the OAuth token out of the sandbox: the SAME
 * public shape — a REAL `google-auth-library` `OAuth2Client`, ready for the vendor SDKs
 * (`drive({ version: "v3", auth: await authClient() })`) — but the OAuth token NEVER enters the
 * sandbox. It overrides the client's `request()` to redirect every call through the Sapiom
 * connectors proxy, which resolves + injects the credential server-side (metered, governed).
 *
 * WHY a real `OAuth2Client` (the reviewed decision, not a duck-type): `googleapis` / `@googleapis/*`
 * route every call through `authClient.request(...)` and type `auth` as `OAuth2Client | GoogleAuth`,
 * so only the real class both runs and type-checks. We keep the real class and override just
 * `request()` — the smallest compatible piece.
 *
 * WHY this works (verified against googleapis-common@7.2.0 `apirequest.js:303`): on the standard
 * (non-http2) path every generated API call is `authClient.request(options)`. Overriding it captures
 * every endpoint across every Google API — Gmail (gmail.googleapis.com), Drive/Calendar
 * (www.googleapis.com), Sheets (sheets.googleapis.com) — with no per-method wiring, because the SDK
 * already put the upstream host in the URL and we forward it via `x-sapiom-connector-host`.
 *
 * `google-auth-library` is an OPTIONAL peer, imported DYNAMICALLY only when a client is built.
 */
import { Readable } from "node:stream";

import type { OAuth2Client } from "google-auth-library";

import type { Transport } from "../../_client/index.js";
import {
  CONNECTOR_HOST_HEADER,
  toProxyRequest,
} from "../core/proxy-request.js";

/**
 * The subset of gaxios' request options googleapis-common hands to `authClient.request`. Modelled
 * locally so this file adds no runtime coupling to Google's packages beyond the dynamic import.
 */
export interface GaxiosLikeOptions {
  url?: string | URL;
  method?: string;
  headers?: Record<string, string> | Headers | [string, string][];
  /** Already-serialized body (gaxios sets this); forwarded verbatim. */
  body?: unknown;
  /** Structured payload some call sites set instead of `body`; JSON-encoded if present. */
  data?: unknown;
  /** Query params gaxios keeps separate from the URL. */
  params?: Record<string, unknown>;
  responseType?: "json" | "stream" | "arraybuffer" | "text" | "blob" | string;
  [k: string]: unknown;
}

/** The gaxios-shaped response googleapis-common expects back from `authClient.request`. */
export interface GaxiosLikeResponse<T = unknown> {
  config: GaxiosLikeOptions;
  data: T;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  request: { responseURL: string };
}

export interface CreateProxyAuthClientOptions {
  /** The connected provider the gateway resolves to the tenant's connector (e.g. `"google"`). */
  provider: string;
  /** The connectors proxy base (the tools host). */
  proxyBaseUrl: string;
  /** The tenant-authenticated Transport — injects `x-sapiom-api-key` + attribution + analytics. */
  transport: Transport;
}

/**
 * Build a real `OAuth2Client` whose HTTP is redirected through the connectors proxy. Drop it into
 * any Google vendor SDK just like a normal `authClient()`:
 *
 *   const auth = await createProxyAuthClient({ provider: "google", proxyBaseUrl, transport });
 *   await google.gmail("v1").users.messages.list({ userId: "me", auth });
 *
 * `google-auth-library` ships transitively with `googleapis` / `@googleapis/*`; called without it
 * this throws a clear error naming the package to add.
 */
export async function createProxyAuthClient(
  options: CreateProxyAuthClientOptions,
): Promise<OAuth2Client> {
  let mod: typeof import("google-auth-library");
  try {
    mod = await import("google-auth-library");
  } catch {
    throw new Error(
      "connectors.google.authClient() needs the 'google-auth-library' package, which ships with " +
        "'googleapis' and the '@googleapis/*' clients — install one of those (e.g. " +
        "`npm i @googleapis/drive`) to use the vendor SDKs. For a raw proxied path with no extra " +
        "dependency, use connectors.google.fetch() instead.",
    );
  }

  const { provider, proxyBaseUrl, transport } = options;
  const client = new mod.OAuth2Client();

  // Override the single interception point. No credentials / refreshHandler are set, so the client
  // holds no token; overriding request() means getRequestHeaders()/refresh are never reached on the
  // standard path — every call is rewritten to the proxy, which owns the credential + 401 refresh.
  const proxiedRequest = async <T = unknown>(
    opts: GaxiosLikeOptions,
  ): Promise<GaxiosLikeResponse<T>> => {
    const sdkUrl = opts.url instanceof URL ? opts.url.toString() : opts.url;
    if (!sdkUrl) {
      throw new Error("connectors proxy: googleapis request is missing a url");
    }

    const { url, upstreamHost } = toProxyRequest({
      sdkUrl,
      provider,
      proxyBaseUrl,
      params: opts.params,
    });

    const headers = sanitizeHeaders(opts.headers);
    headers[CONNECTOR_HOST_HEADER] = upstreamHost;

    const method = (opts.method ?? "GET").toUpperCase();
    const body = resolveBody(method, opts);

    const res = await transport.fetch(url, { method, headers, body });
    const data = (await parseBody(res, opts.responseType)) as T;
    const response: GaxiosLikeResponse<T> = {
      config: opts,
      data,
      status: res.status,
      statusText: res.statusText,
      headers: headerBag(res.headers),
      request: { responseURL: url },
    };

    // gaxios throws on non-2xx (default validateStatus); googleapis relies on that to surface
    // upstream errors. Mirror it so the author's SDK sees a normal Google API error, not a 200.
    if (res.status >= 400) {
      throw makeRequestError(method, upstreamHost, response);
    }
    return response;
  };

  // Instance-level override (cast: our shape is the subset googleapis-common actually consumes).
  (client as unknown as { request: typeof proxiedRequest }).request =
    proxiedRequest;
  return client;
}

// --------------------------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------------------------

/** Normalize gaxios headers (object | Headers | entries) to a plain record, dropping inbound auth. */
function sanitizeHeaders(
  input: Record<string, string> | Headers | [string, string][] | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input) return out;
  const entries: [string, string][] =
    input instanceof Headers
      ? [...input.entries()]
      : Array.isArray(input)
        ? input
        : Object.entries(input);
  for (const [key, value] of entries) {
    if (value == null) continue;
    // The sandbox holds no valid Google token; never let one ride through, and never let the
    // proxy's injected credential be shadowed by a stale inbound header.
    if (key.toLowerCase() === "authorization") continue;
    out[key] = String(value);
  }
  return out;
}

/** GET/HEAD carry no body; otherwise forward the serialized body (or JSON-encode structured data). */
function resolveBody(
  method: string,
  opts: GaxiosLikeOptions,
): RequestInit["body"] {
  if (method === "GET" || method === "HEAD") return undefined;
  if (opts.body != null) return opts.body as RequestInit["body"];
  if (opts.data != null) {
    return typeof opts.data === "string"
      ? opts.data
      : JSON.stringify(opts.data);
  }
  return undefined;
}

/** Parse the proxied response into the shape googleapis expects for the requested responseType. */
async function parseBody(
  res: Response,
  responseType?: string,
): Promise<unknown> {
  switch (responseType) {
    case "stream":
      // googleapis media downloads expect a Node Readable; adapt the web stream.
      return res.body ? webToNodeReadable(res.body) : null;
    case "arraybuffer":
      return Buffer.from(await res.arrayBuffer());
    case "blob":
      return await res.blob();
    case "text":
      return await res.text();
    default: {
      // Default is JSON. Tolerate an empty body (204 / empty 200) without throwing.
      const text = await res.text();
      if (!text) return {};
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
  }
}

/** A Node `Readable` from a WHATWG `ReadableStream`, using the built-in adapter (Node 18+). */
function webToNodeReadable(body: ReadableStream<Uint8Array>): unknown {
  return (
    Readable as unknown as {
      fromWeb: (s: ReadableStream<Uint8Array>) => unknown;
    }
  ).fromWeb(body);
}

/** Flatten fetch `Headers` into the lowercased plain bag googleapis reads (`headers['content-type']`). */
function headerBag(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/**
 * A gaxios-error-shaped throwable: carries `.response` (with parsed `.data`) and `.status`/`.code`
 * so `googleapis` renders the upstream failure exactly as it would a direct call.
 */
function makeRequestError(
  method: string,
  upstreamHost: string,
  response: GaxiosLikeResponse,
): Error & {
  response: GaxiosLikeResponse;
  status: number;
  code: string;
  config: GaxiosLikeOptions;
} {
  const message = `${method} ${upstreamHost} → ${response.status} ${response.statusText}`;
  return Object.assign(new Error(message), {
    response,
    status: response.status,
    code: String(response.status),
    config: response.config,
  });
}
