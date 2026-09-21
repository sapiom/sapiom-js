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
 *     session.cdpUrl;      // CDP WebSocket — connect Playwright/Puppeteer here
 *     session.liveViewUrl; // live view — hand a sign-in or 2FA step to a person
 *     const shot = await session.screenshot({ url: "https://example.com" });
 *     return shot;
 *   });
 *
 * Or via an explicit client:
 *   `createClient({ apiKey }).browserAutomation.sessions.create()`
 */
import { Transport, defaultTransport } from "../_client/index.js";
import { resolveServiceUrl } from "../_client/service-url.js";
import { managedBrowserApi } from "./managed.js";
import { ensureOk, BrowserAutomationHttpError } from "./errors.js";

export { BrowserAutomationHttpError };
export * from "./managed.js";

// The ONLY occurrence of the backing provider subdomain — NOT in type names,
// method names, comments, or docs.
const DEFAULT_BASE_URL = resolveServiceUrl(
  "anchor-browser",
  process.env.SAPIOM_BROWSER_AUTOMATION_URL,
);

// ----- Types -----

/**
 * Lifetime of a session's `liveViewUrl`. `"persistent"` works for as long as the session does.
 */
export type LiveViewMode = "persistent";

/**
 * Session lifetime in integer minutes. Omitted values use the gateway defaults: 5 minutes
 * idle timeout and 20 minutes maximum duration. Idle timeout accepts 1–60 minutes and max
 * duration accepts 1–240 minutes; out-of-range values are rejected by the gateway with HTTP
 * 400. The idle timer starts only after all CDP/live-view clients disconnect. Reconnecting
 * resets idle but never extends maximum duration. For example, idle 30 / max 20 ends at 20
 * minutes regardless.
 */
export interface SessionTimeoutOptions {
  idleTimeoutMinutes?: number;
  maxDurationMinutes?: number;
}

export interface BrowserSession {
  /** Unique session identifier. */
  sessionId: string;
  /** CDP WebSocket URL — connect Playwright or Puppeteer here. */
  cdpUrl: string;
  /**
   * Interactive live view of this session's browser. It opens in any web browser on any
   * device, so a person can take over for a step the agent should not do itself — a sign-in,
   * a one-time code, a payment confirmation. They act inside the same session, and the agent
   * resumes over `cdpUrl` with cookies intact.
   *
   * The link works for as long as the session does (see `maxDurationSec`).
   * Current gateways return `liveViewMode: "persistent"`; older gateways omit the field.
   * Single-use live views are not supported. Anyone holding the link can act in the browser.
   * Treat it like a credential: send it to one
   * person over a channel you trust, and close the session when the step is done.
   * Absent from Local Run stub sessions.
   *
   * @see https://docs.sapiom.ai/capabilities/browser#hand-a-step-to-a-human
   */
  liveViewUrl?: string;
  /** Lifetime the capability applied to `liveViewUrl`; see {@link LiveViewMode}. */
  liveViewMode?: LiveViewMode;
  /**
   * ISO-8601 expiry of the gateway payment context. This includes a settlement buffer;
   * it is not a browser liveness deadline. See `maxDurationSec` for the browser limit.
   */
  expiresAt: string;
  /** Maximum session duration in seconds. */
  maxDurationSec: number;
  /** Applied idle timeout in minutes, when returned by the gateway. */
  idleTimeoutMinutes?: number;
  /** Applied maximum duration in minutes, when returned by the gateway. */
  maxDurationMinutes?: number;
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

export interface WithSessionOptions extends SessionTimeoutOptions {
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
  live_view_mode?: LiveViewMode;
  liveViewMode?: LiveViewMode;
  expires_at?: string;
  expiresAt?: string;
  max_duration_sec?: number;
  maxDurationSec?: number;
  idle_timeout_minutes?: number;
  idleTimeoutMinutes?: number;
  max_duration_minutes?: number;
  maxDurationMinutes?: number;
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
    live_view_mode,
    liveViewMode,
    expires_at,
    expiresAt,
    max_duration_sec,
    maxDurationSec,
    idle_timeout_minutes,
    idleTimeoutMinutes,
    max_duration_minutes,
    maxDurationMinutes,
    ...rest
  } = raw;
  const resolvedLiveViewUrl = liveViewUrl ?? live_view_url;
  const resolvedLiveViewMode = liveViewMode ?? live_view_mode;
  return {
    sessionId: (sessionId ?? session_id ?? "") as string,
    cdpUrl: (cdpUrl ?? cdp_url ?? "") as string,
    ...(resolvedLiveViewUrl !== undefined && {
      liveViewUrl: resolvedLiveViewUrl,
    }),
    ...(resolvedLiveViewMode !== undefined && {
      liveViewMode: resolvedLiveViewMode,
    }),
    expiresAt: (expiresAt ?? expires_at ?? "") as string,
    maxDurationSec: (maxDurationSec ?? max_duration_sec ?? 0) as number,
    ...((idleTimeoutMinutes ?? idle_timeout_minutes) !== undefined && {
      idleTimeoutMinutes: idleTimeoutMinutes ?? idle_timeout_minutes,
    }),
    ...((maxDurationMinutes ?? max_duration_minutes) !== undefined && {
      maxDurationMinutes: maxDurationMinutes ?? max_duration_minutes,
    }),
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
 * you can pass to Playwright or Puppeteer. The gateway authorizes $1 per started hour of
 * the requested maximum duration ($1 by default, up to $4 for 240 minutes). This is a payment
 * authorization, not a provider usage limit. Call `sessions.close` (or use `withSession`)
 * when finished to request settlement of actual usage.
 * Failed requests throw {@link BrowserAutomationHttpError}.
 */
export function createSession(
  options?: SessionTimeoutOptions,
  transport?: Transport,
  baseUrl?: string,
): Promise<BrowserSession>;
export function createSession(
  transport: Transport,
  baseUrl?: string,
): Promise<BrowserSession>;
export function createSession(
  transport: Transport | undefined,
  baseUrl?: string,
): Promise<BrowserSession>;
export async function createSession(
  optionsOrTransport?: SessionTimeoutOptions | Transport,
  transportOrBaseUrl?: Transport | string,
  baseUrl = DEFAULT_BASE_URL,
): Promise<BrowserSession> {
  const isTransport = (value: unknown): value is Transport =>
    typeof value === "object" && value !== null && "fetch" in value;
  const transport = isTransport(optionsOrTransport)
    ? optionsOrTransport
    : isTransport(transportOrBaseUrl)
      ? transportOrBaseUrl
      : defaultTransport();
  const isLegacyCall =
    isTransport(optionsOrTransport) ||
    (optionsOrTransport === undefined &&
      typeof transportOrBaseUrl === "string");
  const resolvedBaseUrl = isLegacyCall
    ? typeof transportOrBaseUrl === "string"
      ? transportOrBaseUrl
      : DEFAULT_BASE_URL
    : baseUrl;
  const options = isLegacyCall ? undefined : optionsOrTransport;
  const body = {
    ...(options?.idleTimeoutMinutes !== undefined && {
      idleTimeoutMinutes: options.idleTimeoutMinutes,
    }),
    ...(options?.maxDurationMinutes !== undefined && {
      maxDurationMinutes: options.maxDurationMinutes,
    }),
  };
  const res = await ensureOk(
    await transport.fetch(`${resolvedBaseUrl}/v1/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
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
  input: { identityId: string } & SessionTimeoutOptions,
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
      body: JSON.stringify({
        identityId: input.identityId,
        ...(input.idleTimeoutMinutes !== undefined && {
          idleTimeoutMinutes: input.idleTimeoutMinutes,
        }),
        ...(input.maxDurationMinutes !== undefined && {
          maxDurationMinutes: input.maxDurationMinutes,
        }),
      }),
    }),
    "Failed to create session with identity",
  );
  return mapBrowserSession((await res.json()) as RawBrowserSession);
}

/**
 * Close a session and settle its billing. Returns a `SessionSettlement` with
 * `capturedAmountUsd` (the amount captured on successful settlement) and `creditsUsed`.
 * Settlement can fail if usage exceeds the payment authorization. Session expiry does not
 * guarantee settlement. Failed requests throw {@link BrowserAutomationHttpError}.
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
 * session-bound `screenshot` convenience), and attempt to close the session in a
 * `finally` block — even when `fn` throws.
 *
 * Close errors are suppressed to preserve the callback result or error. Use
 * `sessions.close` directly when your code must check settlement success.
 * Other failed requests throw {@link BrowserAutomationHttpError}.
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
    ? await createSessionWithIdentity(
        {
          identityId: opts.identityId,
          idleTimeoutMinutes: opts.idleTimeoutMinutes,
          maxDurationMinutes: opts.maxDurationMinutes,
        },
        transport,
        baseUrl,
      )
    : await createSession(opts, transport, baseUrl);

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
  ...managedBrowserApi(DEFAULT_BASE_URL).sessions,
  create: createSession,
  createWithIdentity: createSessionWithIdentity,
  close: closeSession,
};

/** Browser identity management. */
export const identities = {
  create: createIdentity,
};

/** Managed browser tasks in tenant-owned sessions. */
export const tasks = managedBrowserApi(DEFAULT_BASE_URL).tasks;

/** Bind the owned API to a client transport. */
export const bindManagedBrowser = (transport: Transport) =>
  managedBrowserApi(DEFAULT_BASE_URL, transport);
