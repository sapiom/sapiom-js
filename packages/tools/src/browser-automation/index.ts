/**
 * `browserAutomation` capability — sessions, screenshots, and identity management.
 * The same browser automation tools your agents call over MCP, callable directly
 * from code.
 *
 *   import { createClient } from "@sapiom/tools";
 *   const sapiom = createClient({ apiKey: process.env.SAPIOM_API_KEY });
 *
 *   // One-shot screenshot (no session needed):
 *   const shot = await sapiom.browserAutomation.screenshot({ url: "https://example.com" });
 *   shot.url;        // absolute hosted URL
 *   shot.expiresAt;  // ISO-8601 expiry
 *
 *   // Session + auto-close helper:
 *   const result = await sapiom.browserAutomation.withSession(async (session) => {
 *     session.cdpUrl;  // CDP WebSocket — connect Playwright/Puppeteer here
 *     const shot = await session.screenshot({ url: "https://example.com" });
 *     return shot;
 *   });
 *
 * Or via an explicit client:
 *   `createClient({ apiKey }).browserAutomation.sessions.create()`
 */
import { Transport, defaultTransport } from "../_client/index.js";
import { resolveServiceUrl } from "../_client/service-url.js";
import { ensureOk, BrowserAutomationHttpError } from "./errors.js";

export { BrowserAutomationHttpError };

// The ONLY occurrence of the backing provider subdomain — NOT in type names,
// method names, comments, or docs.
const DEFAULT_BASE_URL = resolveServiceUrl(
  "anchor-browser",
  process.env.SAPIOM_BROWSER_AUTOMATION_URL,
);

// ----- Types -----

export interface BrowserSession {
  /** Unique session identifier. */
  sessionId: string;
  /** CDP WebSocket URL — connect Playwright or Puppeteer here. */
  cdpUrl: string;
  /** Optional hosted live-view URL. */
  liveViewUrl?: string;
  /** ISO-8601 timestamp when this session expires. */
  expiresAt: string;
  /** Maximum session duration in seconds. */
  maxDurationSec: number;
  /** Additional fields returned by the capability, passed through as-is. */
  [k: string]: unknown;
}

export interface SessionSettlement {
  /** The session that was closed. */
  sessionId: string;
  /** Whether the session was settled successfully. */
  settled: boolean;
  /** Actual USD amount captured (present when settled). */
  capturedAmountUsd?: string;
  /** Credits consumed during the session. */
  creditsUsed?: number;
  /** Additional fields returned by the capability, passed through as-is. */
  [k: string]: unknown;
}

export interface ScreenshotInput {
  /**
   * URL to screenshot. Required when no `sessionId` is provided (one-shot mode).
   * Optional when a `sessionId` is given.
   */
  url?: string;
  /**
   * Session mode — attach this screenshot to an existing session. No per-call
   * charge; billing settles with the session when it is closed.
   */
  sessionId?: string;
  /** Viewport width in pixels. */
  width?: number;
  /** Viewport height in pixels. */
  height?: number;
  /**
   * Capture the full scrollable page height. Maps to `scroll_all_content` +
   * `capture_full_height` in the gateway request.
   */
  fullPage?: boolean;
  /**
   * JPEG quality (0–100). Maps to `image_quality` in the gateway request.
   * Only meaningful when `format` is `"jpeg"`.
   */
  imageQuality?: number;
  /**
   * Milliseconds to wait after page load before capturing. Maps to `wait` in
   * the gateway request.
   */
  waitMs?: number;
  /** Output format. Defaults to `"png"` when omitted. */
  format?: "png" | "jpeg";
  /**
   * Advanced: extra parameters forwarded verbatim to the gateway (spread FIRST
   * so they cannot override the guard-validated fields above).
   */
  params?: Record<string, unknown>;
}

export interface Screenshot {
  /** Absolute hosted URL of the captured image. */
  url: string;
  /** ISO-8601 timestamp when `url` expires. */
  expiresAt: string;
  /** Additional fields returned by the capability, passed through as-is. */
  [k: string]: unknown;
}

export type IdentityCredential =
  | { type: "profile"; name: string }
  | { type: "username_password"; username: string; password: string }
  | { type: "authenticator"; secret: string }
  | { type: "custom"; fields: Array<{ name: string; value: string }> };

export interface IdentityCreateInput {
  /** Login page URL (required). */
  source: string;
  /** Optional display name for this identity. */
  name?: string;
  /** Credentials the session should log in with. */
  credentials: IdentityCredential[];
  /** Whether to cache the authenticated session state. */
  shouldCache?: boolean;
  /** Arbitrary metadata to attach to this identity. */
  metadata?: Record<string, unknown>;
}

export interface Identity {
  /** Unique identity identifier. */
  id: string;
  /** Current lifecycle status. */
  status: string;
  /** Display name of this identity. */
  name?: string;
  /** Additional fields returned by the capability, passed through as-is. */
  [k: string]: unknown;
}

export interface WithSessionOptions {
  /**
   * When provided, opens the session with the given identity so it starts with
   * a pre-authenticated browser context.
   */
  identityId?: string;
}

/**
 * An open browser session with a session-bound `screenshot` convenience.
 * The `screenshot` method injects `sessionId` automatically — no per-call charge.
 */
export interface ActiveSession extends BrowserSession {
  /**
   * Capture a screenshot inside this session. `sessionId` is injected
   * automatically. `url` is optional when the session already has an active page.
   */
  screenshot(
    input?: Omit<ScreenshotInput, "sessionId" | "url"> & { url?: string },
  ): Promise<Screenshot>;
}

// ----- Internal response shapes -----

interface RawBrowserSession {
  session_id?: string;
  sessionId?: string;
  cdp_url?: string;
  cdpUrl?: string;
  live_view_url?: string;
  liveViewUrl?: string;
  expires_at?: string;
  expiresAt?: string;
  max_duration_sec?: number;
  maxDurationSec?: number;
  [k: string]: unknown;
}

interface RawSessionSettlement {
  session_id?: string;
  sessionId?: string;
  settled?: boolean;
  captured_amount_usd?: string;
  capturedAmountUsd?: string;
  credits_used?: number;
  creditsUsed?: number;
  [k: string]: unknown;
}

interface RawScreenshot {
  url?: string;
  expires_at?: string;
  expiresAt?: string;
  [k: string]: unknown;
}

interface RawIdentity {
  id?: string;
  status?: string;
  name?: string;
  [k: string]: unknown;
}

// ----- Response mappers (accept snake_case OR camelCase, spread the rest) -----

function mapBrowserSession(raw: RawBrowserSession): BrowserSession {
  const {
    session_id,
    sessionId,
    cdp_url,
    cdpUrl,
    live_view_url,
    liveViewUrl,
    expires_at,
    expiresAt,
    max_duration_sec,
    maxDurationSec,
    ...rest
  } = raw;
  const resolvedLiveViewUrl = liveViewUrl ?? live_view_url;
  return {
    sessionId: (sessionId ?? session_id ?? "") as string,
    cdpUrl: (cdpUrl ?? cdp_url ?? "") as string,
    ...(resolvedLiveViewUrl !== undefined && {
      liveViewUrl: resolvedLiveViewUrl,
    }),
    expiresAt: (expiresAt ?? expires_at ?? "") as string,
    maxDurationSec: (maxDurationSec ?? max_duration_sec ?? 0) as number,
    ...rest,
  };
}

function mapSessionSettlement(raw: RawSessionSettlement): SessionSettlement {
  const {
    session_id,
    sessionId,
    settled,
    captured_amount_usd,
    capturedAmountUsd,
    credits_used,
    creditsUsed,
    ...rest
  } = raw;
  const resolvedCaptured = capturedAmountUsd ?? captured_amount_usd;
  const resolvedCredits = creditsUsed ?? credits_used;
  return {
    sessionId: (sessionId ?? session_id ?? "") as string,
    settled: settled ?? false,
    ...(resolvedCaptured !== undefined && {
      capturedAmountUsd: resolvedCaptured,
    }),
    ...(resolvedCredits !== undefined && { creditsUsed: resolvedCredits }),
    ...rest,
  };
}

function mapScreenshot(raw: RawScreenshot, baseUrl: string): Screenshot {
  const { url, expires_at, expiresAt, ...rest } = raw;
  // The gateway may return a relative path — resolve it to absolute.
  const resolvedUrl = url
    ? url.startsWith("/")
      ? `${baseUrl}${url}`
      : url
    : "";
  return {
    url: resolvedUrl,
    expiresAt: (expiresAt ?? expires_at ?? "") as string,
    ...rest,
  };
}

function mapIdentity(raw: RawIdentity): Identity {
  const { id, status, name, ...rest } = raw;
  return {
    id: id ?? "",
    status: status ?? "",
    ...(name !== undefined && { name }),
    ...rest,
  };
}

// ----- Guards -----

function assertIdentityId(identityId: unknown): void {
  if (typeof identityId !== "string" || identityId.trim() === "") {
    throw new BrowserAutomationHttpError(
      "identityId is required and must be a non-empty string",
      400,
      { error: "invalid_identity_id" },
    );
  }
}

function assertSource(source: unknown): void {
  if (typeof source !== "string" || source.trim() === "") {
    throw new BrowserAutomationHttpError(
      "source is required and must be a non-empty string (the login page URL)",
      400,
      { error: "invalid_source" },
    );
  }
}

function assertUrl(url: unknown): void {
  if (typeof url !== "string" || url.trim() === "") {
    throw new BrowserAutomationHttpError(
      "url is required and must be a non-empty string for one-shot screenshots",
      400,
      { error: "invalid_url" },
    );
  }
}

// ----- Capability operations -----

/**
 * Open a new browser session. Returns a `BrowserSession` with a CDP WebSocket
 * you can pass to Playwright or Puppeteer. The session is billed at `upto $1.00`;
 * call `sessions.close` (or use `withSession`) to settle the exact cost.
 * Failed requests throw {@link BrowserAutomationHttpError}.
 */
export async function createSession(
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<BrowserSession> {
  const res = await ensureOk(
    await transport.fetch(`${baseUrl}/v1/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({}),
    }),
    "Failed to create session",
  );
  return mapBrowserSession((await res.json()) as RawBrowserSession);
}

/**
 * Open a new browser session with an existing identity, starting the browser
 * already authenticated. Returns a `BrowserSession`. Failed requests throw
 * {@link BrowserAutomationHttpError}.
 */
export async function createSessionWithIdentity(
  input: { identityId: string },
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<BrowserSession> {
  assertIdentityId(input.identityId);

  const res = await ensureOk(
    await transport.fetch(`${baseUrl}/v1/sessions/with-identity`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ identityId: input.identityId }),
    }),
    "Failed to create session with identity",
  );
  return mapBrowserSession((await res.json()) as RawBrowserSession);
}

/**
 * Close a session and settle its billing. Returns a `SessionSettlement` with
 * `capturedAmountUsd` (the exact amount charged, never more than $1.00) and
 * `creditsUsed`. Always call this or use `withSession` to avoid the auto-expiry
 * $1.00 ceiling. Failed requests throw {@link BrowserAutomationHttpError}.
 */
export async function closeSession(
  sessionId: string,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<SessionSettlement> {
  const res = await ensureOk(
    await transport.fetch(
      `${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}`,
      {
        method: "DELETE",
        headers: { accept: "application/json" },
      },
    ),
    "Failed to close session",
  );
  return mapSessionSettlement((await res.json()) as RawSessionSettlement);
}

/**
 * Capture a screenshot of a URL or an in-session page. In one-shot mode (`url`
 * required, no `sessionId`) the call is billed at `$0.01`. In session mode
 * (`sessionId` provided) there is no per-call charge; billing settles with the
 * session. The returned `url` is an absolute, short-lived hosted image URL.
 * Failed requests throw {@link BrowserAutomationHttpError}.
 */
export async function screenshot(
  input: ScreenshotInput,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<Screenshot> {
  // One-shot mode requires a url; session mode makes url optional.
  if (!input.sessionId) {
    assertUrl(input.url);
  }

  // `params` is spread first so it cannot clobber the guard-validated fields.
  const body: Record<string, unknown> = {
    ...input.params,
    ...(input.url !== undefined && { url: input.url }),
    ...(input.sessionId !== undefined && { sessionId: input.sessionId }),
    ...(input.width !== undefined && { width: input.width }),
    ...(input.height !== undefined && { height: input.height }),
    ...(input.fullPage === true && {
      scroll_all_content: true,
      capture_full_height: true,
    }),
    ...(input.imageQuality !== undefined && {
      image_quality: input.imageQuality,
    }),
    ...(input.waitMs !== undefined && { wait: input.waitMs }),
    ...(input.format !== undefined && { format: input.format }),
  };

  const res = await ensureOk(
    await transport.fetch(`${baseUrl}/v1/tools/screenshot`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
    }),
    "Failed to capture screenshot",
  );
  return mapScreenshot((await res.json()) as RawScreenshot, baseUrl);
}

/**
 * Create a browser identity that stores credentials for automatic login.
 * Pass the returned `id` to `sessions.createWithIdentity` to open a
 * pre-authenticated session. Identity creation is free.
 * Failed requests throw {@link BrowserAutomationHttpError}.
 */
export async function createIdentity(
  input: IdentityCreateInput,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<Identity> {
  assertSource(input.source);

  const body: Record<string, unknown> = {
    source: input.source,
    credentials: input.credentials,
    ...(input.name !== undefined && { name: input.name }),
    ...(input.shouldCache !== undefined && { shouldCache: input.shouldCache }),
    ...(input.metadata !== undefined && { metadata: input.metadata }),
  };

  const res = await ensureOk(
    await transport.fetch(`${baseUrl}/v1/identities`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
    }),
    "Failed to create identity",
  );
  return mapIdentity((await res.json()) as RawIdentity);
}

/**
 * Open a browser session, invoke `fn` with an `ActiveSession` (which includes a
 * session-bound `screenshot` convenience), and **always** close the session in a
 * `finally` block — even when `fn` throws.
 *
 * This is the recommended way to run a browser automation task: it prevents the
 * session from leaking at the $1.00 ceiling charge if you forget to close it.
 * Failed requests throw {@link BrowserAutomationHttpError}.
 *
 * @example
 * const result = await sapiom.browserAutomation.withSession(async (session) => {
 *   const shot = await session.screenshot({ url: "https://example.com" });
 *   return shot.url;
 * });
 */
export async function withSession<T>(
  fn: (session: ActiveSession) => Promise<T>,
  opts?: WithSessionOptions,
  transport: Transport = defaultTransport(),
  baseUrl = DEFAULT_BASE_URL,
): Promise<T> {
  const browserSession = opts?.identityId
    ? await createSessionWithIdentity({ identityId: opts.identityId }, transport, baseUrl)
    : await createSession(transport, baseUrl);

  const activeSession: ActiveSession = {
    ...browserSession,
    screenshot: (input?) =>
      screenshot(
        { ...input, sessionId: browserSession.sessionId },
        transport,
        baseUrl,
      ),
  };

  try {
    return await fn(activeSession);
  } finally {
    // Always close — swallow errors so the original result/throw propagates.
    await closeSession(browserSession.sessionId, transport, baseUrl).catch(
      () => undefined,
    );
  }
}

// ----- Namespace exports -----

/** Browser session lifecycle operations. */
export const sessions = {
  create: createSession,
  createWithIdentity: createSessionWithIdentity,
  close: closeSession,
};

/** Browser identity management. */
export const identities = {
  create: createIdentity,
};
