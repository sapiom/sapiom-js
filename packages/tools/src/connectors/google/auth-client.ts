/**
 * A proxy-backed Google `authClient()` that keeps the OAuth token out of the sandbox: the SAME
 * public shape — a REAL `google-auth-library` `OAuth2Client`, ready for the vendor SDKs
 * (`drive({ version: "v3", auth: await authClient() })`) — but the OAuth token NEVER enters the
 * sandbox. The gateway injects the real credential server-side; the client here carries only a
 * sentinel.
 *
 * HOW: `googleapis` routes every call through `OAuth2Client.request()`, which hands the fully
 * assembled request to its gaxios `transporter`. We leave that pipeline intact — so gaxios keeps
 * building bodies (JSON, multipart/media uploads, streams with `duplex`), serializing params, and
 * applying retries / `signal` / `timeout` — and only swap gaxios' underlying `fetchImplementation`
 * for one that (1) rewrites the URL to the connectors proxy, (2) forwards the upstream host via
 * `x-sapiom-connector-host`, and (3) sends it through our tenant-authenticated `Transport`. We own
 * just the URL rewrite + one header; gaxios owns everything else, so the whole Google surface works
 * with no per-method wiring and no re-implemented HTTP semantics.
 *
 * WHY a real `OAuth2Client` (the reviewed decision, not a duck-type): only the real class both runs
 * and type-checks against `googleapis` / `@googleapis/*`, which type `auth` as
 * `OAuth2Client | GoogleAuth`.
 *
 * `google-auth-library` is an OPTIONAL peer, imported DYNAMICALLY only when a client is built.
 */
import type { OAuth2Client } from "google-auth-library";

import type { Transport } from "../../_client/index.js";
import { withNodeStreamBody } from "../core/node-stream-response.js";
import {
  CONNECTOR_HOST_HEADER,
  toProxyRequest,
} from "../core/proxy-request.js";

/**
 * A sentinel access token. `google-auth-library` refuses to assemble a request without *some*
 * credential (`getRequestMetadataAsync` throws otherwise), so we prime one — but it never reaches
 * Google: the proxy injects the real credential server-side, and our fetch layer strips this
 * `Authorization` header before dialing. The far-future expiry keeps it from triggering a refresh.
 */
const PROXY_SENTINEL_TOKEN = "sapiom-connectors-proxy-injects-server-side";
const NEVER_EXPIRES = Date.parse("2099-01-01T00:00:00.000Z");

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

  // Sentinel credential so google-auth-library assembles requests without demanding a real token.
  // It never leaves the process (see PROXY_SENTINEL_TOKEN).
  client.setCredentials({
    access_token: PROXY_SENTINEL_TOKEN,
    expiry_date: NEVER_EXPIRES,
  });

  // gaxios calls `fetchImplementation(url, init)` with the fully-assembled Google request. Retarget
  // it to the proxy and route it through our Transport (which adds the tenant credential +
  // attribution). gaxios still owns body-building, streaming, params, retries, and abort.
  const proxiedFetch = async (
    input: Parameters<typeof fetch>[0],
    init: RequestInit = {},
  ): Promise<Response> => {
    const sdkUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    const { url, upstreamHost } = toProxyRequest({
      sdkUrl,
      provider,
      proxyBaseUrl,
    });

    // Copy the assembled headers to a plain record (Transport spreads a plain object, not a
    // `Headers`), dropping the sentinel `Authorization` — the proxy injects the real credential.
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      if (key.toLowerCase() !== "authorization") headers[key] = value;
    });
    headers[CONNECTOR_HOST_HEADER] = upstreamHost;

    // gaxios returns `.body` verbatim for `responseType: "stream"`; our undici-based Transport
    // yields a web ReadableStream, so hand back a Node Readable to preserve googleapis' download
    // contract (`.pipe()` / `.on()`). Shared with the offline stub so the two can't drift.
    return withNodeStreamBody(await transport.fetch(url, { ...init, headers }));
  };

  // The transporter is a gaxios instance; swapping its default fetch is the smallest hook that keeps
  // gaxios in the request pipeline. Cast: `fetchImplementation` isn't on the narrow Transporter type.
  (
    client.transporter as unknown as {
      defaults: { fetchImplementation?: typeof fetch };
    }
  ).defaults.fetchImplementation = proxiedFetch as typeof fetch;

  return client;
}
