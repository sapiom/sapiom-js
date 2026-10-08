/**
 * The single seam that turns a vendor-SDK-built URL into a Sapiom connectors-proxy request.
 * Provider-neutral and pure, so every injection rung reuses it: the google `OAuth2Client`
 * adapter (rung 1), `@octokit`'s `request.fetch` (rung 1, later), and the generic tail
 * `fetch()` (rung 3).
 *
 * The vendor SDK already chose the upstream host (each Google API bakes its own `rootUrl` —
 * Gmail dials `gmail.googleapis.com`, Drive `www.googleapis.com`, Sheets `sheets.googleapis.com`).
 * We read it off the URL the SDK built and forward it via the `x-sapiom-connector-host` header
 * (validated server-side against the provider's declared `allowedHosts`), so the caller needs zero
 * per-provider, per-method knowledge of upstream hosts.
 *
 * Backend contract (provider-addressed facade):
 *   ALL {proxyBase}/connectors/v1/providers/:provider/proxy/*path
 *   + header  x-sapiom-connector-host: <bare host>   (host-only; the server forces https)
 * The route is PROVIDER-addressed — the gateway resolves the tenant's connector for that provider
 * (≤1 per tenant+provider) server-side, so the client never handles a connectorId.
 */

/** The header the multi-host proxy reads to pick the upstream origin (within `allowedHosts`). */
export const CONNECTOR_HOST_HEADER = "x-sapiom-connector-host";

export interface ToProxyRequestInput {
  /**
   * The absolute URL the vendor SDK built, e.g.
   * `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5`.
   */
  sdkUrl: string;
  /** The connected provider (e.g. `"google"`); the gateway resolves it to the tenant's connector. */
  provider: string;
  /** The connectors proxy base (the tools host), e.g. `https://tools.sapiom.ai`. */
  proxyBaseUrl: string;
  /**
   * Query params the SDK kept separate from the URL (gaxios `options.params`). Merged into the
   * proxied URL's query so nothing is dropped before the proxy forwards it.
   */
  params?: Record<string, unknown> | undefined;
}

export interface ProxyRequest {
  /** The proxy URL to actually call (credential + attribution added by the Transport). */
  url: string;
  /** The bare upstream host for `x-sapiom-connector-host`, lowercased. */
  upstreamHost: string;
}

/**
 * Rewrite a vendor-SDK URL into the provider-addressed connectors-proxy URL + the upstream-host
 * header value. The path (including any service prefix like `/gmail/v1`) is preserved verbatim as
 * the proxy wildcard tail; the host travels in the header, never the path.
 */
export function toProxyRequest({
  sdkUrl,
  provider,
  proxyBaseUrl,
  params,
}: ToProxyRequestInput): ProxyRequest {
  let target: URL;
  try {
    target = new URL(sdkUrl);
  } catch {
    throw new Error(`connectors proxy: cannot parse upstream URL "${sdkUrl}"`);
  }
  // The proxy pins https server-side; an http/non-https SDK URL means the SDK was misconfigured —
  // fail loud rather than silently downgrade custody.
  if (target.protocol !== "https:") {
    throw new Error(
      `connectors proxy: refusing non-https upstream "${target.protocol}//${target.host}"`,
    );
  }
  if (!provider) {
    throw new Error("connectors proxy: missing provider");
  }

  // Merge any SDK-separated query params (gaxios keeps some in `options.params`).
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        target.searchParams.delete(key);
        for (const v of value) target.searchParams.append(key, String(v));
      } else {
        target.searchParams.set(key, String(value));
      }
    }
  }

  const base = proxyBaseUrl.replace(/\/+$/, "");
  // `target.pathname` already starts with "/", so this yields `.../providers/google/proxy/gmail/v1/...`.
  const url = `${base}/connectors/v1/providers/${encodeURIComponent(provider)}/proxy${target.pathname}${target.search}`;

  return { url, upstreamHost: target.hostname.toLowerCase() };
}
