/**
 * `google` capability — a live, tenant-scoped Google credential for in-run code,
 * refreshed server-side (AGENT-311). Two members:
 *
 *   import { google } from "@sapiom/tools";
 *   const cred = await google.token();                 // { kind: "bearer", value, expiresAt? }
 *   // …or a real google-auth-library OAuth2 client, ready for the vendor SDKs:
 *   import { drive } from "@googleapis/drive";
 *   const res = await drive({ version: "v3", auth: await google.authClient() }).files.list();
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
// Type-only: erased at emit, so importing it adds NO runtime dependency. The value
// `OAuth2Client` is pulled in at runtime by {@link authClient} via a dynamic import,
// keeping `google-auth-library` an OPTIONAL peer that only loads when a builder actually
// builds a client (agents that only use {@link token} pull none of it).
import type { OAuth2Client } from "google-auth-library";

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

/**
 * The tenant's Google auth client for the vendor SDKs — a GENUINE `google-auth-library`
 * `OAuth2Client`, backed by server-side credential materialization. Pass it straight to
 * any Google client library: `drive({ version: "v3", auth: await authClient() })`.
 *
 * WHY a real client (not a `{ getRequestHeaders }` duck-type): `googleapis` /
 * `@googleapis/*` route every request through `authClient.request(...)`, which a bare
 * duck-type lacks ("authClient.request is not a function"), and they type `auth` as
 * `OAuth2Client | GoogleAuth | …` — so only the real client both runs and type-checks. A
 * real `OAuth2Client` is a superset (it also has `getRequestHeaders()`), so header-only
 * callers are covered too; for a pure raw-bearer path with no extra dependency, use
 * {@link token}.
 *
 * The client's `refreshHandler` — google-auth-library's official "bring your own token
 * source" hook — sources EVERY token from {@link token}, so the OAuth token is minted on
 * demand and refreshed transparently server-side; the library caches it and re-mints only
 * when it needs to (initial call and near expiry). The raw token is returned to the caller
 * only — never logged, persisted, or written to env.
 *
 * `google-auth-library` is an OPTIONAL peer dependency, imported DYNAMICALLY so it never
 * weighs on agents that only use {@link token} (raw bearer + `fetch`) and never build a
 * client. It ships transitively with `googleapis` and the `@googleapis/*` clients, so a
 * builder using those already has it; called without it installed, this throws a clear
 * error naming the package to add.
 *
 * @example
 *   import { drive } from "@googleapis/drive";
 *   const auth = await ctx.sapiom.google.authClient();
 *   const res = await drive({ version: "v3", auth }).files.list({ pageSize: 10 });
 */
export async function authClient(
  transport: Transport = defaultTransport(),
  baseUrl: string = DEFAULT_BASE_URL,
): Promise<OAuth2Client> {
  let mod: typeof import("google-auth-library");
  try {
    mod = await import("google-auth-library");
  } catch {
    throw new Error(
      "google.authClient() needs the 'google-auth-library' package, which ships with " +
        "'googleapis' and the '@googleapis/*' clients — install one of those (e.g. " +
        "`npm i @googleapis/drive`) to use the vendor SDKs. For a token-only path that " +
        "needs no extra dependency, use google.token() instead.",
    );
  }

  const client = new mod.OAuth2Client();
  // The single source of tokens: every mint is a server-side materialize, so no OAuth
  // token or refresh token ever lives in this process beyond the returned bearer.
  const mint = async () => {
    const cred = await token(transport, baseUrl);
    return {
      access_token: cred.value,
      // google-auth-library requires a numeric epoch expiry. Google always sends one;
      // fall back to +1h so refresh timing stays well-defined for a static connector.
      expiry_date: cred.expiresAt
        ? Date.parse(cred.expiresAt)
        : Date.now() + 3_600_000,
    };
  };
  client.refreshHandler = mint; // library calls this whenever it needs a fresh token
  client.setCredentials(await mint()); // prime so the first request needs no round-trip guess
  return client;
}

/**
 * Google Drive server-side methods (AGENT-312 / Path 2). Each posts the args to the
 * gateway's method-dispatch route on the run credential (`x-sapiom-api-key`); the
 * gateway resolves the tenant's Google credential INTERNALLY and calls Drive — the
 * Google token NEVER crosses this boundary, only the Drive result comes back. Non-2xx
 * throws (Transport.request), carrying the gateway body: 404 connector_not_found (connect
 * Google first), 400 connector_method_invalid_args, 502 connector_method_upstream_failed.
 */
export interface DriveShareFileArgs {
  fileId: string;
  role: "reader" | "writer" | "commenter" | "owner";
  type: "user" | "group" | "domain" | "anyone";
  emailAddress?: string;
  domain?: string;
  sendNotificationEmail?: boolean;
}

export interface DriveUploadFileArgs {
  name: string;
  content: string;
  mimeType?: string;
  parents?: string[];
  contentEncoding?: "utf8" | "base64";
}

export interface DrivePermission {
  id: string;
  type: string;
  role: string;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
}

/** Share a Drive file (Permissions: create), executed server-side in the gateway. */
export async function driveShareFile(
  args: DriveShareFileArgs,
  transport: Transport = defaultTransport(),
  baseUrl: string = DEFAULT_BASE_URL,
): Promise<DrivePermission> {
  return transport.request<DrivePermission>(
    `${baseUrl}/connectors/v1/google/methods/shareFile`,
    {
      method: "POST",
      body: JSON.stringify(args),
    },
  );
}

/** Upload a new Drive file (Files: create, multipart), executed server-side in the gateway. */
export async function driveUploadFile(
  args: DriveUploadFileArgs,
  transport: Transport = defaultTransport(),
  baseUrl: string = DEFAULT_BASE_URL,
): Promise<DriveFile> {
  return transport.request<DriveFile>(
    `${baseUrl}/connectors/v1/google/methods/uploadFile`,
    {
      method: "POST",
      body: JSON.stringify(args),
    },
  );
}

/**
 * Google Gmail server-side methods (AGENT-313 / Path 2). Mirrors the Drive methods
 * above: the args are POSTed to the gateway's method-dispatch route on the run
 * credential (`x-sapiom-api-key`); the gateway resolves the tenant's Google
 * credential INTERNALLY and calls Gmail — the Google token NEVER crosses this
 * boundary, only the send result comes back. Non-2xx throws (Transport.request),
 * carrying the gateway body: 404 connector_not_found (connect Google first),
 * 400 connector_method_invalid_args, 502 connector_method_upstream_failed.
 */
export interface GmailAttachment {
  filename: string;
  mimeType: string;
  /** Base64-encoded attachment bytes. */
  content: string;
}

/**
 * Arguments for {@link gmailSendEmail}. `to`/`cc`/`bcc` accept a single address or
 * an array for ergonomics; each is NORMALIZED to an array before POSTing because the
 * gateway is strict — recipients cross the wire as arrays only.
 */
export interface SendEmailArgs {
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: GmailAttachment[];
}

export interface SendEmailResult {
  id: string;
  threadId: string;
}

/** Normalize a single address or address array to an array (gateway expects arrays). */
const toRecipientArray = (value: string | string[]): string[] =>
  Array.isArray(value) ? value : [value];

/** Send an email via Gmail (Users.messages: send), executed server-side in the gateway. */
export async function gmailSendEmail(
  args: SendEmailArgs,
  transport: Transport = defaultTransport(),
  baseUrl: string = DEFAULT_BASE_URL,
): Promise<SendEmailResult> {
  const body = {
    ...args,
    to: toRecipientArray(args.to),
    ...(args.cc !== undefined ? { cc: toRecipientArray(args.cc) } : {}),
    ...(args.bcc !== undefined ? { bcc: toRecipientArray(args.bcc) } : {}),
  };
  return transport.request<SendEmailResult>(
    `${baseUrl}/connectors/v1/google/methods/sendEmail`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
}
