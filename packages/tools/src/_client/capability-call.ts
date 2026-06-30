/**
 * `capabilityCall` — the single routed-call seam every capability that lives on
 * the Capability Router goes through (SAP-1116). It is the SDK-side anti-drift
 * foundation: one place builds `POST /v1/capabilities/<id>`, one place resolves the
 * Core base URL, one place sends the credential header, one place maps a non-2xx to
 * a typed error. A NEW routed verb is then ~5 lines (build request DTO → call →
 * map response DTO) and *cannot* diverge on transport, auth, or error handling.
 *
 *   const res = await capabilityCall<ScrapeResponse>("web.scrape", { url }, {
 *     transport, makeError: (m, s, b) => new SearchHttpError(m, s, b),
 *     errorPrefix: "Failed to scrape",
 *   });
 *
 * Two patterns coexist by design (SAP-1112): routed caps come here; the deferred
 * async/stateful caps (SAP-1117) keep their `resolveServiceUrl` → provider-gateway
 * path. Do not consolidate the two until the async/resource primitives exist.
 */
import { Transport, defaultTransport } from "./index.js";

/**
 * The single Core base URL, resolved at CALL TIME — never frozen in a module-level
 * const. Freezing the base URL at import is the SAP-1107 prod-escape 401 root cause:
 * an in-process workflow step that imported a capability before the runtime set the
 * env kept a stale (often prod) URL forever. Reading it per call means routed caps
 * always honor the current client/runtime config, so that 401 class is structurally
 * gone for routed caps even locally.
 *
 * Mirrors `@sapiom/core`'s base-URL convention (`SAPIOM_BASE_URL` → `SAPIOM_API_URL`
 * → the production default). There is no per-capability URL knob: one Core base URL
 * re-homes every routed verb at once, so nothing silently escapes to a stale host.
 */
export function resolveCoreBaseUrl(): string {
  return (
    process.env.SAPIOM_BASE_URL ??
    process.env.SAPIOM_API_URL ??
    "https://api.sapiom.ai"
  );
}

/** Options for {@link capabilityCall}. */
export interface CapabilityCallOptions {
  /** Transport carrying the tenant credential. Defaults to the ambient transport. */
  transport?: Transport;
  /**
   * Override the Core base URL. Defaults to {@link resolveCoreBaseUrl} evaluated at
   * call time — the seam tests pin and the only place a routed verb's host is set.
   */
  baseUrl?: string;
  /**
   * Build the capability-specific typed error to throw on a non-2xx response. Each
   * capability namespace passes its own (`SearchHttpError`, `ContentGenerationHttpError`,
   * …) so the public error surface stays unchanged; the call/parse path is shared.
   */
  makeError: (message: string, status: number, body: unknown) => Error;
  /** Human-readable prefix for the thrown error's message. */
  errorPrefix: string;
}

/**
 * Send a routed capability request: `POST <core>/v1/capabilities/<id>` with the
 * tenant credential on `x-api-key` (the header the `/v1` controller guard reads —
 * NOT the gateway-direct `x-sapiom-api-key`, which would silently 401 here), the
 * request DTO as a JSON body, and the parsed JSON response DTO returned. A non-2xx
 * throws the capability's typed error (parsed JSON body when possible, else raw text).
 */
export async function capabilityCall<Res>(
  id: string,
  req: Record<string, unknown>,
  opts: CapabilityCallOptions,
): Promise<Res> {
  const transport = opts.transport ?? defaultTransport();
  const baseUrl = opts.baseUrl ?? resolveCoreBaseUrl();

  const res = await transport.fetch(
    `${baseUrl}/v1/capabilities/${id}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    },
    { authHeader: "x-api-key" },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    throw opts.makeError(
      `${opts.errorPrefix}: ${res.status} ${text}`,
      res.status,
      body,
    );
  }

  return (await res.json()) as Res;
}
