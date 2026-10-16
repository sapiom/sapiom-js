import { CdpConnection, type CdpEvent } from "./cdp.js";
import { matchHeldPlaceholderInBody, type HeldPlaceholder } from "./detect.js";
import type { PaymentRelay, RelayResponse } from "./relay.js";
import { redact } from "./redact.js";

export interface AttachOptions {
  relay: PaymentRelay;
  /** The one placeholder the agent was given for this checkout. */
  placeholder: HeldPlaceholder;
  transactionId: string;
  /**
   * How long to wait for the relay before failing the paused request.
   * The relay is not retried.
   */
  timeoutMs?: number;
}

export type InterceptorEvent =
  | { type: "paused"; url: string; method: string }
  | { type: "relayed"; url: string; status: number }
  | { type: "refused"; url: string; reason: string }
  | { type: "failed"; url: string; reason: string };

export interface InterceptorHandle {
  detach(): Promise<void>;
  /** Subscribe to outcomes. Returns an unsubscribe function. */
  on(listener: (event: InterceptorEvent) => void): () => void;
}

/**
 * A browser CDP websocket URL, or a Playwright/Puppeteer browser or page that
 * can provide one. The interceptor always opens its own connection.
 */
export type InterceptorTarget =
  | string
  | { wsEndpoint(): string }
  | { browser(): { wsEndpoint(): string } | null }
  | { context(): { browser(): { wsEndpoint(): string } | null } | null };

const DEFAULT_TIMEOUT_MS = 20_000;

const TARGET_FILTER = [{ type: "page" }, { type: "iframe" }];

/** GET/HEAD with no body and no held number in the URL. Safe to continue immediately. */
export function canContinueWithoutReading(
  method: string,
  url: string,
  hasBody: boolean,
  placeholderNumber: string,
): boolean {
  const verb = method.toUpperCase();
  if (verb !== "GET" && verb !== "HEAD") return false;
  if (hasBody) return false;
  return !urlDigits(url).includes(placeholderNumber);
}

function urlDigits(url: string): string {
  let decoded = url;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    // Keep the raw URL when it is not valid percent-encoding.
  }
  return decoded.replace(/\D/g, "");
}

/**
 * Captcha widgets and the session solver. Their requests are not the card
 * post. Holding them on Fetch or the debugger stalls the solver past its
 * own timeout. A POST is still scanned so a placeholder is never continued.
 */
export function isSolverTraffic(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host === "hcaptcha.com" ||
    host.endsWith(".hcaptcha.com") ||
    host === "recaptcha.net" ||
    host.endsWith(".recaptcha.net") ||
    host === "challenges.cloudflare.com" ||
    host === "anchorbrowser.io" ||
    host.endsWith(".anchorbrowser.io")
  ) {
    return true;
  }
  return parsed.pathname.toLowerCase().includes("/recaptcha/");
}

const RESPONSE_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "content-encoding",
  "content-length",
]);

interface Session {
  sessionId: string;
  targetId: string;
  type: string;
  url: string;
  parentSessionId?: string;
  fetchEnabled?: boolean;
}

function isBlankTarget(url: string): boolean {
  return url === "" || url === "about:blank" || url === "about:srcdoc";
}
function isHandsOffTarget(session: Session): boolean {
  if (
    session.type === "worker" ||
    session.type === "shared_worker" ||
    session.type === "service_worker"
  ) {
    return true;
  }
  if (session.url.startsWith("chrome-extension:")) return true;
  return isSolverTraffic(session.url);
}

/**
 * Attach the payment interceptor to a browser.
 *
 * Page and iframe requests are paused. Captcha widgets, extension pages, and
 * workers are not: pausing them stalls the session's captcha solver. A paused
 * body that does not contain the held placeholder is continued. A match is
 * sent to the relay and the paused request is fulfilled with the provider
 * response. A mismatch, refusal, timeout, or network error fails the paused
 * request. The placeholder is never continued: it is a random number in a
 * real BIN range.
 */
export async function attachInterceptor(
  target: InterceptorTarget,
  options: AttachOptions,
): Promise<InterceptorHandle> {
  const cdpUrl = resolveCdpUrl(target);
  const connection = await CdpConnection.connect(cdpUrl);
  const sessions = new Map<string, Session>();
  const seen = new Set<string>();
  const listeners = new Set<(event: InterceptorEvent) => void>();
  let closed = false;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const emit = (event: InterceptorEvent) => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // A listener must not break interception.
      }
    }
  };

  const enableSession = async (
    sessionId: string,
    waitingForDebugger: boolean,
  ) => {
    if (seen.has(sessionId)) {
      if (waitingForDebugger) {
        await connection
          .send("Runtime.runIfWaitingForDebugger", {}, sessionId)
          .catch(() => {});
      }
      return;
    }
    seen.add(sessionId);
    const session = sessions.get(sessionId);
    // A blank frame has not navigated yet. Holding it for Fetch.enable freezes
    // a captcha widget that is about to load. Arm Fetch only once the URL is a
    // page we might need to pause.
    if (!session || isHandsOffTarget(session) || isBlankTarget(session.url)) {
      await releaseTarget(connection, sessionId, waitingForDebugger);
      return;
    }
    // Fetch has to be on before the target runs, or the card iframe can post
    // before we are listening. waitForDebuggerOnStart holds it until then.
    // Network has to be enabled before Network.getCookies will return the
    // jar the card session needs.
    await armFetch(connection, session);
    await releaseTarget(connection, sessionId, waitingForDebugger);
  };

  const onAttached = (event: CdpEvent) => {
    const params = event.params as {
      sessionId?: string;
      waitingForDebugger?: boolean;
      targetInfo?: { targetId?: string; type?: string; url?: string };
    };
    const sessionId = params.sessionId;
    const info = params.targetInfo;
    if (!sessionId || !info?.type || !info.targetId) return;
    const duplicate = [...sessions.values()].some(
      (session) => session.targetId === info.targetId,
    );
    if (duplicate) {
      // setAutoAttach already owns this target. A second session would pause
      // every request twice.
      void releaseTarget(
        connection,
        sessionId,
        params.waitingForDebugger === true,
      ).then(() =>
        connection
          .send("Target.detachFromTarget", { sessionId })
          .catch(() => {}),
      );
      return;
    }
    sessions.set(sessionId, {
      sessionId,
      targetId: info.targetId,
      type: info.type,
      url: info.url ?? "",
      ...(event.sessionId ? { parentSessionId: event.sessionId } : {}),
    });
    void enableSession(sessionId, params.waitingForDebugger === true);
  };

  const onPaused = (event: CdpEvent) => {
    const sessionId = event.sessionId;
    const params = event.params as {
      requestId?: string;
      resourceType?: string;
      request?: {
        url?: string;
        method?: string;
        headers?: unknown;
        postData?: string;
        hasPostData?: boolean;
        postDataEntries?: { bytes?: string }[];
      };
    };
    if (!sessionId || !params.requestId || !params.request) return;
    const url = params.request.url ?? "";
    const method = params.request.method ?? "GET";
    const hasBody = requestHasBody(params.request);
    if (
      canContinueWithoutReading(
        method,
        url,
        hasBody,
        options.placeholder.number,
      )
    ) {
      void continueRequest(connection, sessionId, params.requestId);
      return;
    }
    if (
      !hasBody &&
      (method.toUpperCase() === "GET" || method.toUpperCase() === "HEAD")
    ) {
      void failRequest(connection, sessionId, params.requestId);
      emit({
        type: "failed",
        url: redact(url),
        reason: "placeholder_mismatch",
      });
      return;
    }
    const session = sessions.get(sessionId);
    if (isSolverTraffic(url) || (session ? isHandsOffTarget(session) : false)) {
      void continueSolverRequest(
        connection,
        options,
        emit,
        sessionId,
        params.requestId,
        url,
        params.request,
      );
      return;
    }
    void handlePaused(
      connection,
      sessions,
      options,
      timeoutMs,
      emit,
      () => closed,
      sessionId,
      params.requestId,
      params.resourceType ?? "",
      params.request,
    );
  };

  connection.onEvent((event) => {
    if (closed) return;
    if (event.method === "Target.attachedToTarget") onAttached(event);
    else if (event.method === "Target.detachedFromTarget") {
      const sessionId = event.params.sessionId as string | undefined;
      if (sessionId) sessions.delete(sessionId);
    } else if (event.method === "Target.targetInfoChanged") {
      const info = event.params.targetInfo as
        | { targetId?: string; url?: string }
        | undefined;
      if (!info?.targetId || !info.url) return;
      for (const session of sessions.values()) {
        if (session.targetId !== info.targetId) continue;
        session.url = info.url;
        if (isHandsOffTarget(session)) {
          if (session.fetchEnabled) {
            session.fetchEnabled = false;
            void connection
              .send("Fetch.disable", {}, session.sessionId)
              .catch(() => {});
          }
          void connection
            .send("Runtime.runIfWaitingForDebugger", {}, session.sessionId)
            .catch(() => {});
          continue;
        }
        if (!session.fetchEnabled && !isBlankTarget(session.url)) {
          void armFetch(connection, session);
        }
      }
    } else if (event.method === "Fetch.requestPaused") onPaused(event);
  });

  await connection.send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
    filter: TARGET_FILTER,
  });
  await connection
    .send("Target.setDiscoverTargets", { discover: true })
    .catch(() => {});

  return {
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async detach() {
      if (closed) return;
      closed = true;
      for (const sessionId of sessions.keys()) {
        await connection.send("Fetch.disable", {}, sessionId).catch(() => {});
      }
      await connection
        .send("Target.setAutoAttach", {
          autoAttach: false,
          waitForDebuggerOnStart: false,
          flatten: true,
        })
        .catch(() => {});
      connection.close();
    },
  };
}

async function handlePaused(
  connection: CdpConnection,
  sessions: Map<string, Session>,
  options: AttachOptions,
  timeoutMs: number,
  emit: (event: InterceptorEvent) => void,
  isClosed: () => boolean,
  sessionId: string,
  requestId: string,
  resourceType: string,
  request: {
    url?: string;
    method?: string;
    headers?: unknown;
    postData?: string;
    hasPostData?: boolean;
    postDataEntries?: { bytes?: string }[];
  },
): Promise<void> {
  const url = request.url ?? "";
  const method = request.method ?? "GET";
  const safeUrl = redact(url);
  try {
    let body = "";
    try {
      body = await readBody(connection, sessionId, requestId, request);
    } catch {
      // A body we cannot read might still be the placeholder. Fail it.
      if (request.hasPostData) {
        await failRequest(connection, sessionId, requestId);
        emit({ type: "failed", url: safeUrl, reason: "unreadable_body" });
        return;
      }
    }
    const match = matchHeldPlaceholderInBody(body, options.placeholder);
    if (match.kind === "not_held") {
      await continueRequest(connection, sessionId, requestId);
      return;
    }
    if (match.kind === "mismatch") {
      // The placeholder number is here with someone else's expiry or CVC.
      // Continuing it would still put that number on the network.
      await failRequest(connection, sessionId, requestId);
      emit({
        type: "failed",
        url: safeUrl,
        reason: "placeholder_mismatch",
      });
      return;
    }
    if (isClosed()) {
      await failRequest(connection, sessionId, requestId);
      return;
    }
    // A later injection profile (W7 U3) can reject a matched destination
    // here, before the relay call, and must fail the request rather than
    // continue it. M0 has no URL filter.
    emit({ type: "paused", url: safeUrl, method });
    const merchantOrigin = await readMerchantOrigin(
      connection,
      sessions,
      sessionId,
    );
    if (!merchantOrigin) {
      await failRequest(connection, sessionId, requestId);
      emit({ type: "failed", url: safeUrl, reason: "merchant_origin" });
      return;
    }
    const headers = await completeHeaders(
      connection,
      sessions,
      sessionId,
      url,
      resourceType,
      request.headers,
    );
    let response: RelayResponse;
    try {
      response = await withTimeout(
        options.relay.relay({
          transactionId: options.transactionId,
          injectionRef: match.injectionRef,
          merchantOrigin,
          url,
          method,
          headers,
          body,
        }),
        timeoutMs,
      );
    } catch (error) {
      await failRequest(connection, sessionId, requestId);
      emit({
        type: "failed",
        url: safeUrl,
        reason: failureReason(error),
      });
      return;
    }
    if (!response.ok) {
      await failRequest(connection, sessionId, requestId);
      emit({ type: "refused", url: safeUrl, reason: response.reason });
      return;
    }
    await fulfillRequest(connection, sessionId, requestId, response);
    emit({ type: "relayed", url: safeUrl, status: response.status });
  } catch {
    await failRequest(connection, sessionId, requestId);
    emit({ type: "failed", url: safeUrl, reason: "network" });
  }
}

async function readBody(
  connection: CdpConnection,
  sessionId: string,
  requestId: string,
  request: {
    postData?: string;
    hasPostData?: boolean;
    postDataEntries?: { bytes?: string }[];
  },
): Promise<string> {
  if (typeof request.postData === "string" && request.postData.length > 0) {
    return request.postData;
  }
  if (request.postDataEntries && request.postDataEntries.length > 0) {
    return request.postDataEntries
      .map((entry) => Buffer.from(entry.bytes ?? "", "base64").toString("utf8"))
      .join("");
  }
  if (!request.hasPostData) return "";
  const result = await connection.send<{ postData?: string }>(
    "Fetch.getRequestPostData",
    { requestId },
    sessionId,
  );
  return result.postData ?? "";
}

async function readMerchantOrigin(
  connection: CdpConnection,
  sessions: Map<string, Session>,
  sessionId: string,
): Promise<string | undefined> {
  const pageSessionId = topPageSession(sessions, sessionId);
  if (!pageSessionId) return undefined;
  const evaluated = await connection
    .send<{
      result?: { value?: unknown };
    }>(
      "Runtime.evaluate",
      { expression: "location.origin", returnByValue: true },
      pageSessionId,
    )
    .catch(() => null);
  const value = evaluated?.result?.value;
  if (typeof value === "string" && /^https?:\/\//.test(value)) return value;
  const url = sessions.get(pageSessionId)?.url;
  if (!url) return undefined;
  try {
    const origin = new URL(url).origin;
    return /^https?:\/\//.test(origin) ? origin : undefined;
  } catch {
    return undefined;
  }
}

function topPageSession(
  sessions: Map<string, Session>,
  sessionId: string,
): string | undefined {
  let current: string | undefined = sessionId;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const session = sessions.get(current);
    if (!session) return undefined;
    if (session.type === "page") return current;
    if (!session.parentSessionId) return undefined;
    current = session.parentSessionId;
  }
  return undefined;
}

/**
 * At the Fetch Request stage Chrome has not yet added the headers its network
 * stack appends (Cookie, Sec-Fetch-*, Accept-Language). Shopify's card session
 * needs those. Never override a header the request already has.
 */
async function completeHeaders(
  connection: CdpConnection,
  sessions: Map<string, Session>,
  sessionId: string,
  requestUrl: string,
  resourceType: string,
  rawHeaders: unknown,
): Promise<Record<string, string>> {
  const headers = headerRecord(rawHeaders);
  const has = (name: string) =>
    Object.keys(headers).some((key) => key.toLowerCase() === name);
  const frameUrl = sessions.get(sessionId)?.url || requestUrl;
  try {
    const target = new URL(requestUrl);
    const frame = new URL(frameUrl);
    if (!has("sec-fetch-site")) {
      const site = (value: URL) =>
        value.hostname.split(".").slice(-2).join(".");
      headers["Sec-Fetch-Site"] =
        target.origin === frame.origin
          ? "same-origin"
          : site(target) === site(frame) && target.protocol === frame.protocol
            ? "same-site"
            : "cross-site";
    }
    if (!has("sec-fetch-dest") && /^(Fetch|XHR)$/.test(resourceType)) {
      headers["Sec-Fetch-Dest"] = "empty";
    }
    if (!has("accept-language")) {
      const languages = await connection
        .send<{
          result?: { value?: unknown };
        }>(
          "Runtime.evaluate",
          { expression: "navigator.languages", returnByValue: true },
          sessionId,
        )
        .catch(() => null);
      const list = languages?.result?.value;
      if (
        Array.isArray(list) &&
        list.every((entry) => typeof entry === "string")
      ) {
        headers["Accept-Language"] = list
          .map((language, index) =>
            index === 0
              ? language
              : `${language};q=${Math.max(0.1, 1 - index / 10).toFixed(1)}`,
          )
          .join(",");
      }
    }
    if (!has("cookie")) {
      const cookies = await connection
        .send<{
          cookies?: { name: string; value: string }[];
        }>("Network.getCookies", { urls: [requestUrl] }, sessionId)
        .catch(() => null);
      if (cookies?.cookies?.length) {
        headers["Cookie"] = cookies.cookies
          .map((cookie) => `${cookie.name}=${cookie.value}`)
          .join("; ");
      }
    }
  } catch {
    // Keep the headers Chrome already gave us.
  }
  return headers;
}

function headerRecord(headers: unknown): Record<string, string> {
  if (!headers) return {};
  if (Array.isArray(headers)) {
    const out: Record<string, string> = {};
    for (const entry of headers) {
      if (entry && typeof entry.name === "string") {
        out[entry.name] = String(entry.value ?? "");
      }
    }
    return out;
  }
  if (typeof headers === "object") {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      headers as Record<string, unknown>,
    )) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  }
  return {};
}

function requestHasBody(request: {
  postData?: string;
  hasPostData?: boolean;
  postDataEntries?: { bytes?: string }[];
}): boolean {
  if (request.hasPostData) return true;
  if (typeof request.postData === "string" && request.postData.length > 0) {
    return true;
  }
  return Boolean(request.postDataEntries && request.postDataEntries.length > 0);
}

async function armFetch(
  connection: CdpConnection,
  session: Session | undefined,
): Promise<void> {
  if (!session || session.fetchEnabled || isHandsOffTarget(session)) return;
  await connection
    .send("Network.enable", {}, session.sessionId)
    .catch(() => {});
  await connection
    .send(
      "Fetch.enable",
      { patterns: [{ urlPattern: "*", requestStage: "Request" }] },
      session.sessionId,
    )
    .catch(() => {});
  session.fetchEnabled = true;
}

async function releaseTarget(
  connection: CdpConnection,
  sessionId: string,
  waitingForDebugger: boolean,
): Promise<void> {
  if (!waitingForDebugger) return;
  await connection
    .send("Runtime.runIfWaitingForDebugger", {}, sessionId)
    .catch(() => {});
}

async function continueSolverRequest(
  connection: CdpConnection,
  options: AttachOptions,
  emit: (event: InterceptorEvent) => void,
  sessionId: string,
  requestId: string,
  url: string,
  request: {
    postData?: string;
    hasPostData?: boolean;
    postDataEntries?: { bytes?: string }[];
  },
): Promise<void> {
  if (requestHasBody(request)) {
    try {
      const body = await readBody(connection, sessionId, requestId, request);
      const match = matchHeldPlaceholderInBody(body, options.placeholder);
      if (match.kind !== "not_held") {
        await failRequest(connection, sessionId, requestId);
        emit({
          type: "failed",
          url: redact(url),
          reason: "placeholder_mismatch",
        });
        return;
      }
    } catch {
      // An unreadable captcha body is not the card post. Continue it.
    }
  }
  await continueRequest(connection, sessionId, requestId);
}

async function continueRequest(
  connection: CdpConnection,
  sessionId: string,
  requestId: string,
): Promise<void> {
  try {
    await connection.send("Fetch.continueRequest", { requestId }, sessionId);
  } catch {
    await failRequest(connection, sessionId, requestId);
  }
}

async function failRequest(
  connection: CdpConnection,
  sessionId: string,
  requestId: string,
): Promise<void> {
  await connection
    .send(
      "Fetch.failRequest",
      { requestId, errorReason: "BlockedByClient" },
      sessionId,
    )
    .catch(() => {});
}

async function fulfillRequest(
  connection: CdpConnection,
  sessionId: string,
  requestId: string,
  response: Extract<RelayResponse, { ok: true }>,
): Promise<void> {
  const responseHeaders = Object.entries(response.headers).flatMap(
    ([name, value]) => {
      if (RESPONSE_HOP.has(name.toLowerCase())) return [];
      if (name.toLowerCase() === "set-cookie") {
        return value
          .split("\n")
          .filter((part) => part.length > 0)
          .map((part) => ({ name, value: part }));
      }
      return [{ name, value }];
    },
  );
  await connection.send(
    "Fetch.fulfillRequest",
    {
      requestId,
      responseCode: response.status,
      responseHeaders,
      body: Buffer.from(response.body, "utf8").toString("base64"),
    },
    sessionId,
  );
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error("Payment relay timed out");
      error.name = "TimeoutError";
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

function failureReason(error: unknown): string {
  if (
    error instanceof Error &&
    (error.name === "TimeoutError" ||
      error.message === "Payment relay timed out")
  ) {
    return "timeout";
  }
  return "network";
}

export function resolveCdpUrl(target: InterceptorTarget): string {
  if (typeof target === "string") {
    if (!target) throw new Error("A CDP websocket URL is required");
    return target;
  }
  if (
    target &&
    typeof (target as { wsEndpoint?: unknown }).wsEndpoint === "function"
  ) {
    const url = (target as { wsEndpoint(): string }).wsEndpoint();
    if (url) return url;
  }
  const browserFromBrowser = (
    target as { browser?: () => { wsEndpoint(): string } | null }
  ).browser;
  if (typeof browserFromBrowser === "function") {
    const url = browserFromBrowser.call(target)?.wsEndpoint();
    if (url) return url;
  }
  const context = (
    target as {
      context?: () => { browser(): { wsEndpoint(): string } | null } | null;
    }
  ).context;
  if (typeof context === "function") {
    const url = context.call(target)?.browser()?.wsEndpoint();
    if (url) return url;
  }
  throw new Error(
    "Pass a CDP websocket URL, or a Playwright/Puppeteer browser or page whose browser exposes wsEndpoint()",
  );
}
