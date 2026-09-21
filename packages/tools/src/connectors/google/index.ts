/**
 * `connectors.google` capability — call Google's APIs and vendor SDKs from in-run code with the
 * OAuth token resolved and injected SERVER-SIDE by the connectors proxy, so it never enters the
 * sandbox. `authClient()` returns a real `google-auth-library`
 * OAuth2Client whose HTTP is redirected through the proxy, and `fetch()` is the generic proxied tail.
 *
 *   import { connectors } from "@sapiom/tools";
 *   import { drive } from "@googleapis/drive";
 *   const auth = await connectors.google.authClient();
 *   const res = await drive({ version: "v3", auth }).files.list();
 *
 *   // …or the generic tail for an ad-hoc endpoint:
 *   await connectors.google.fetch("https://sheets.googleapis.com/v4/spreadsheets/ID");
 *
 * Or on the step context: `ctx.sapiom.connectors.google.authClient()` / `.fetch()`.
 *
 * Wire: the tools host, PROVIDER-addressed proxy route
 * `ALL /connectors/v1/providers/google/proxy/*path` on the run credential (`x-sapiom-api-key`); the
 * gateway resolves the tenant's Google connector, injects the credential, and forwards to Google —
 * only Google's response comes back. The premium `drive.*` / `gmail.*` methods still run server-side.
 */
import { Transport, defaultTransport } from "../../_client/index.js";
// Type-only: erased at emit, so this adds NO runtime dependency. The value `OAuth2Client` is pulled
// in at runtime by {@link authClient} via a dynamic import, keeping `google-auth-library` an OPTIONAL
// peer that only loads when a builder actually builds a client.
import type { OAuth2Client } from "google-auth-library";

import {
  CONNECTOR_HOST_HEADER,
  toProxyRequest,
} from "../core/proxy-request.js";
import { createProxyAuthClient } from "./auth-client.js";

/** This capability's provider key — the segment the gateway resolves to the tenant's connector. */
const PROVIDER = "google";

// Same tools host agents/models resolve — via SAPIOM_TOOLS_BASE. No new per-cap config.
const DEFAULT_BASE_URL =
  process.env.SAPIOM_TOOLS_BASE ?? "https://tools.sapiom.ai";

/**
 * The tenant's Google auth client for the vendor SDKs — a GENUINE `google-auth-library`
 * `OAuth2Client`, proxy-backed. Drop it into any Google client library
 * (`drive({ version: "v3", auth: await authClient() })`); every request is redirected through the
 * connectors proxy, so the OAuth token never enters the sandbox and the gateway owns refresh + 401
 * retry. The upstream host each Google API dials (gmail/sheets/… subdomains) is forwarded
 * automatically, so all of Google's surface works with no per-method wiring.
 *
 * WHY a real client (not a `{ getRequestHeaders }` duck-type): `googleapis` / `@googleapis/*` route
 * every request through `authClient.request(...)` and type `auth` as `OAuth2Client | GoogleAuth`, so
 * only the real class both runs and type-checks. We keep the real class and override just `request()`.
 *
 * `google-auth-library` is an OPTIONAL peer, imported DYNAMICALLY (in {@link createProxyAuthClient})
 * so agents that never build a client pull none of it. Called without it installed, this throws a
 * clear error naming the package to add.
 *
 * @example
 *   import { drive } from "@googleapis/drive";
 *   const auth = await ctx.sapiom.connectors.google.authClient();
 *   const res = await drive({ version: "v3", auth }).files.list({ pageSize: 10 });
 */
export async function authClient(
  transport: Transport = defaultTransport(),
): Promise<OAuth2Client> {
  return createProxyAuthClient({
    provider: PROVIDER,
    proxyBaseUrl: DEFAULT_BASE_URL,
    transport,
  });
}

/**
 * The generic proxied tail — for an endpoint not covered by a method or the vendor SDK. Pass an
 * absolute Google URL (its host is forwarded via `x-sapiom-connector-host`) or a bare path (joined
 * onto the connector's default origin server-side). The tenant credential + attribution are added by
 * the Transport; the OAuth token is injected server-side, never in the sandbox.
 *
 *   await connectors.google.fetch("https://sheets.googleapis.com/v4/spreadsheets/ID");
 *   await connectors.google.fetch("/drive/v3/files");
 */
export async function fetch(
  pathOrUrl: string,
  init: RequestInit = {},
  transport: Transport = defaultTransport(),
): Promise<Response> {
  const base = DEFAULT_BASE_URL.replace(/\/+$/, "");
  const headers: Record<string, string> = { ...headerRecord(init.headers) };
  let url: string;
  if (/^https?:\/\//i.test(pathOrUrl)) {
    const proxied = toProxyRequest({
      sdkUrl: pathOrUrl,
      provider: PROVIDER,
      proxyBaseUrl: base,
    });
    url = proxied.url;
    // Absolute vendor URL → forward its host; bare path → let the proxy use the default origin.
    headers[CONNECTOR_HOST_HEADER] = proxied.upstreamHost;
  } else {
    const path = pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`;
    url = `${base}/connectors/v1/providers/${PROVIDER}/proxy${path}`;
  }
  return transport.fetch(url, { ...init, headers });
}

/** Flatten a `RequestInit['headers']` (Headers | entries | record) into a plain record. */
function headerRecord(input: RequestInit["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input) return out;
  new Headers(input).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/**
 * Google Drive server-side methods. Each posts the args to the
 * gateway's method route on the run credential (`x-sapiom-api-key`); the
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
): Promise<DrivePermission> {
  return transport.request<DrivePermission>(
    `${DEFAULT_BASE_URL}/connectors/v1/google/methods/shareFile`,
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
): Promise<DriveFile> {
  return transport.request<DriveFile>(
    `${DEFAULT_BASE_URL}/connectors/v1/google/methods/uploadFile`,
    {
      method: "POST",
      body: JSON.stringify(args),
    },
  );
}

/**
 * Google Gmail server-side methods. Mirrors the Drive methods
 * above: the args are POSTed to the gateway's method route on the run
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
): Promise<SendEmailResult> {
  const body = {
    ...args,
    to: toRecipientArray(args.to),
    ...(args.cc !== undefined ? { cc: toRecipientArray(args.cc) } : {}),
    ...(args.bcc !== undefined ? { bcc: toRecipientArray(args.bcc) } : {}),
  };
  return transport.request<SendEmailResult>(
    `${DEFAULT_BASE_URL}/connectors/v1/google/methods/sendEmail`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
}

// ----- Namespace exports -----
//
// `authClient` and `fetch` sit directly on the namespace; Drive and Gmail nest their
// verbs under `drive`/`gmail`. This mirrors the client surface built in client.ts
// (`ctx.sapiom.connectors.google.drive.shareFile(...)`), so the ambient import
// `import { connectors } from "@sapiom/tools"` exposes the identical shape.

/** Drive operations. */
export const drive = { shareFile: driveShareFile, uploadFile: driveUploadFile };

/** Gmail operations. */
export const gmail = { sendEmail: gmailSendEmail };
