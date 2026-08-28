/**
 * `google` capability — a live, tenant-scoped Google credential for in-run code,
 * refreshed server-side (AGENT-311). Two members:
 *
 *   import { google } from "@sapiom/tools";
 *   const cred = await google.token();                 // { kind: "bearer", value, expiresAt? }
 *   // …or a googleapis-style auth client that refreshes itself:
 *   const auth = google.authClient();
 *   const { Authorization } = await auth.getRequestHeaders(); // "Bearer <token>"
 *
 * Or on the step context: `ctx.sapiom.google.token()` / `ctx.sapiom.google.authClient()`.
 *
 * WHY this exists: a run must call Google WITHOUT the OAuth token ever living in the
 * run env or on disk. `token()` pulls a short-lived credential ON DEMAND from the
 * connectors gateway, which owns the tenant's Google connector and does the OAuth
 * refresh server-side; the raw token is returned to the caller only. It is NEVER
 * logged, persisted, or written to env by this module.
 *
 * Wire: the tools host `POST /connectors/v1/google/materialize`, the run credential
 * on the default `x-sapiom-api-key` header (NOT the Core `x-api-key`), NO body.
 * 404 = no Google connector for this tenant (connect Google first); 400 = unknown
 * provider. Non-2xx throws (Transport.request), carrying the server body.
 */
import { Transport, defaultTransport } from "../_client/index.js";

// Same tools host agents/models resolve — via SAPIOM_TOOLS_BASE. No new per-cap config.
const DEFAULT_BASE_URL =
  process.env.SAPIOM_TOOLS_BASE ?? "https://tools.sapiom.ai";

/**
 * A short-lived, tenant-scoped credential materialized from the tenant's connector.
 * `value` is a RAW bearer token — use it, never log/persist/echo it. `expiresAt` is
 * present for OAuth connectors (Google has a real expiry) and absent for static
 * ones. `baseUrl`, when present, is the provider API base the caller may target.
 */
export interface LiveCredential {
  kind: "bearer";
  value: string;
  expiresAt?: string;
  baseUrl?: string;
}

/**
 * Pull a fresh Google credential from the connectors gateway. Server-side refresh:
 * the gateway resolves the tenant's Google connector (from the authenticated run
 * credential) and returns a live bearer. Throws on a non-2xx response — notably 404
 * (no Google connector for this tenant — connect Google first) and 400 (unknown
 * provider); the thrown Error carries the gateway's response body.
 */
export async function token(
  transport: Transport = defaultTransport(),
  baseUrl: string = DEFAULT_BASE_URL,
): Promise<LiveCredential> {
  // No body — provider-only contract (mirrors agents.launch's transport.request path).
  return transport.request<LiveCredential>(
    `${baseUrl}/connectors/v1/google/materialize`,
    { method: "POST" },
  );
}
