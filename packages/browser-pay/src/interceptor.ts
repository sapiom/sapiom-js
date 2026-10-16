import crypto from "node:crypto";
import { CdpConnection, type CdpEvent } from "./cdp.js";
import { RELAY_CONTRACT_VERSION, type RelayHeader } from "./contract.js";
import {
  matchHeldPlaceholderInBody,
  textContainsForeignCard,
  textHoldsPlaceholderNumber,
  type HeldPlaceholder,
} from "./detect.js";
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
  /**
   * When set, only targets whose URL contains one of these strings are paused.
   * Other pages keep running, so a captcha solver is not held on their traffic.
   * Omit it to pause every page and iframe.
   */
  pauseOnlyUrls?: string[];
  /**
   * Copy Cookie, Accept-Language, and Sec-Fetch-* from the browser onto the
   * relay request. Off by default. Those headers can include HttpOnly cookies
   * the relay backend must not log or persist. Shopify's card session needs
   * them, so the dev-store script turns this on.
   */
  synthesizeBrowserHeaders?: boolean;
}

export type InterceptorEvent =
  | { type: "paused"; url: string; method: string; targetType: string }
  | { type: "relayed"; url: string; status: number }
  | { type: "relayed_unfulfilled"; url: string; status: number }
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

function shouldPauseTarget(
  session: Session,
  pauseOnlyUrls?: string[],
): boolean {
  if (isHandsOffTarget(session) || isBlankTarget(session.url)) return false;
  if (!pauseOnlyUrls || pauseOnlyUrls.length === 0) return true;
  return pauseOnlyUrls.some((part) => session.url.includes(part));
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
 *
 * `detach()` fails in-flight paused requests before it disables Fetch, so a
 * placeholder mid-relay is not released. If this process crashes or the CDP
 * socket drops first, Chrome continues those paused requests on its own.
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
  const inflight = new Map<string, Inflight>();
  const relayAborts = new Set<AbortController>();
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
    if (!session || !shouldPauseTarget(session, options.pauseOnlyUrls)) {
      if (session?.fetchEnabled) {
        session.fetchEnabled = false;
        await connection.send("Fetch.disable", {}, sessionId).catch(() => {});
      }
      await releaseTarget(connection, sessionId, waitingForDebugger);
      return;
    }
    // Fetch has to be on before the target runs, or the card iframe can post
    // before we are listening. Network has to be enabled before
    // Network.getCookies will return the jar the card session needs.
    const armed = await armFetch(connection, session);
    if (!armed) {
      emit({
        type: "failed",
        url: redact(session.url || session.targetId),
        reason: "intercept_unavailable",
      });
      await connection
        .send("Target.closeTarget", { targetId: session.targetId })
        .catch(() => {});
      return;
    }
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
    // Browser-level auto-attach covers pages. Child iframes attach only when
    // the page (or parent frame) session asks for them. A second session for
    // the same target is detached in onAttached.
    if (info.type === "page" || info.type === "iframe") {
      void connection
        .send(
          "Target.setAutoAttach",
          {
            autoAttach: true,
            waitForDebuggerOnStart: false,
            flatten: true,
            filter: [{ type: "iframe" }],
          },
          sessionId,
        )
        .catch(() => {});
    }
    void enableSession(sessionId, params.waitingForDebugger === true);
  };

  const onPaused = (event: CdpEvent) => {
    const sessionId = event.sessionId;
    const params = event.params as {
      requestId?: string;
      resourceType?: string;
      request?: PausedRequest;
    };
    if (!sessionId || !params.requestId || !params.request) return;
    const url = params.request.url ?? "";
    const method = params.request.method ?? "GET";
    const hasBody = requestHasBody(params.request);
    const key = inflightKey(sessionId, params.requestId);
    if (inflight.has(key)) return;
    const entry: Inflight = {
      key,
      sessionId,
      requestId: params.requestId,
      settled: false,
    };
    inflight.set(key, entry);
    const ctx: PauseContext = {
      connection,
      sessions,
      options,
      timeoutMs,
      emit,
      inflight,
      relayAborts,
      isClosed: () => closed,
    };
    if (
      canContinueWithoutReading(
        method,
        url,
        hasBody,
        options.placeholder.number,
      )
    ) {
      entry.continuing = continueRequest(
        connection,
        sessionId,
        params.requestId,
      ).finally(() => {
        entry.settled = true;
        inflight.delete(key);
      });
      return;
    }
    if (
      !hasBody &&
      (method.toUpperCase() === "GET" || method.toUpperCase() === "HEAD")
    ) {
      void finish(ctx, entry, "fail").then(() => {
        emit({
          type: "failed",
          url: redact(url),
          reason: "placeholder_mismatch",
        });
      });
      return;
    }
    if (closed) {
      void settleClosed(ctx, entry, url, params.request);
      return;
    }
    const session = sessions.get(sessionId);
    if (isSolverTraffic(url) || (session ? isHandsOffTarget(session) : false)) {
      void continueSolverRequest(ctx, entry, url, params.request);
      return;
    }
    void handlePaused(ctx, entry, params.resourceType ?? "", params.request);
  };

  connection.onEvent((event) => {
    if (event.method === "Fetch.requestPaused") {
      onPaused(event);
      return;
    }
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
        if (!shouldPauseTarget(session, options.pauseOnlyUrls)) {
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
        if (!session.fetchEnabled) {
          void armFetch(connection, session).then((armed) => {
            if (armed || closed) return;
            emit({
              type: "failed",
              url: redact(session.url || session.targetId),
              reason: "intercept_unavailable",
            });
            void connection
              .send("Target.closeTarget", { targetId: session.targetId })
              .catch(() => {});
          });
        }
      }
    }
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
      for (const controller of relayAborts) controller.abort();
      await drainInflight(connection, inflight);
      for (const sessionId of sessions.keys()) {
        await connection.send("Fetch.disable", {}, sessionId).catch(() => {});
      }
      // A pause delivered while disable was in flight is still failed or
      // continued here, before the socket goes away.
      await drainInflight(connection, inflight);
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

interface Inflight {
  key: string;
  sessionId: string;
  requestId: string;
  settled: boolean;
  continuing?: Promise<void>;
}

interface PausedRequest {
  url?: string;
  method?: string;
  headers?: unknown;
  postData?: string;
  hasPostData?: boolean;
  postDataEntries?: { bytes?: string }[];
}

interface PauseContext {
  connection: CdpConnection;
  sessions: Map<string, Session>;
  options: AttachOptions;
  timeoutMs: number;
  emit: (event: InterceptorEvent) => void;
  inflight: Map<string, Inflight>;
  relayAborts: Set<AbortController>;
  isClosed: () => boolean;
}

function inflightKey(sessionId: string, requestId: string): string {
  return `${sessionId}\n${requestId}`;
}

async function drainInflight(
  connection: CdpConnection,
  inflight: Map<string, Inflight>,
): Promise<void> {
  const entries = [...inflight.values()];
  await Promise.all(
    entries.map(async (entry) => {
      if (entry.settled) return;
      if (entry.continuing) {
        await entry.continuing;
        return;
      }
      entry.settled = true;
      inflight.delete(entry.key);
      await failRequest(connection, entry.sessionId, entry.requestId);
    }),
  );
}

async function finish(
  ctx: PauseContext,
  entry: Inflight,
  action: "fail" | "continue",
): Promise<boolean> {
  if (entry.settled) return false;
  entry.settled = true;
  ctx.inflight.delete(entry.key);
  if (action === "continue") {
    await continueRequest(ctx.connection, entry.sessionId, entry.requestId);
  } else {
    await failRequest(ctx.connection, entry.sessionId, entry.requestId);
  }
  return true;
}

async function finishContinue(
  ctx: PauseContext,
  entry: Inflight,
): Promise<void> {
  if (entry.settled) return;
  const promise = continueRequest(
    ctx.connection,
    entry.sessionId,
    entry.requestId,
  ).finally(() => {
    entry.settled = true;
    ctx.inflight.delete(entry.key);
  });
  entry.continuing = promise;
  await promise;
}

async function handlePaused(
  ctx: PauseContext,
  entry: Inflight,
  resourceType: string,
  request: PausedRequest,
): Promise<void> {
  const url = request.url ?? "";
  const method = request.method ?? "GET";
  const safeUrl = redact(url);
  const targetType = ctx.sessions.get(entry.sessionId)?.type ?? "";
  try {
    const read = await readBodyResult(
      ctx.connection,
      entry.sessionId,
      entry.requestId,
      request,
    );
    if (read.unreadable) {
      await finish(ctx, entry, "fail");
      ctx.emit({ type: "failed", url: safeUrl, reason: "unreadable_body" });
      return;
    }
    const urlHolds = textHoldsPlaceholderNumber(
      url,
      ctx.options.placeholder.number,
    );
    const match = matchHeldPlaceholderInBody(
      read.body,
      ctx.options.placeholder,
    );
    if (match.kind === "not_held" && !urlHolds) {
      if (ctx.isClosed()) {
        await finishContinue(ctx, entry);
        return;
      }
      await finishContinue(ctx, entry);
      return;
    }
    if (match.kind !== "match" || ctx.isClosed()) {
      await finish(ctx, entry, "fail");
      ctx.emit({
        type: "failed",
        url: safeUrl,
        reason: "placeholder_mismatch",
      });
      return;
    }
    ctx.emit({ type: "paused", url: safeUrl, method, targetType });
    const merchantOrigin = await readMerchantOrigin(
      ctx.connection,
      ctx.sessions,
      entry.sessionId,
    );
    if (!merchantOrigin || ctx.isClosed()) {
      await finish(ctx, entry, "fail");
      ctx.emit({
        type: "failed",
        url: safeUrl,
        reason: merchantOrigin ? "detached" : "merchant_origin",
      });
      return;
    }
    const headers = ctx.options.synthesizeBrowserHeaders
      ? await completeHeaders(
          ctx.connection,
          ctx.sessions,
          entry.sessionId,
          url,
          resourceType,
          request.headers,
        )
      : headerList(request.headers);
    const frameOrigin = readFrameOrigin(ctx.sessions, entry.sessionId, url);
    const controller = new AbortController();
    ctx.relayAborts.add(controller);
    const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);
    let response: RelayResponse;
    try {
      response = await ctx.options.relay.relay(
        {
          version: RELAY_CONTRACT_VERSION,
          transactionId: ctx.options.transactionId,
          injectionRef: match.injectionRef,
          merchantOrigin,
          ...(frameOrigin ? { frameOrigin } : {}),
          url,
          method,
          headers,
          body: read.body,
          bodyEncoding: "utf8",
          idempotencyKey: `${entry.requestId}:${crypto.randomBytes(8).toString("hex")}`,
        },
        { signal: controller.signal },
      );
    } catch (error) {
      await finish(ctx, entry, "fail");
      ctx.emit({
        type: "failed",
        url: safeUrl,
        reason: ctx.isClosed() ? "detached" : failureReason(error),
      });
      return;
    } finally {
      clearTimeout(timer);
      ctx.relayAborts.delete(controller);
    }
    if (!response.ok) {
      await finish(ctx, entry, "fail");
      ctx.emit({ type: "refused", url: safeUrl, reason: response.reason });
      return;
    }
    const responseText =
      response.bodyEncoding === "base64"
        ? Buffer.from(response.body, "base64").toString("utf8")
        : response.body;
    if (textContainsForeignCard(responseText, ctx.options.placeholder.number)) {
      await finish(ctx, entry, "fail");
      ctx.emit({ type: "failed", url: safeUrl, reason: "response_credential" });
      return;
    }
    let fulfilled = false;
    try {
      if (!entry.settled) {
        await fulfillRequest(
          ctx.connection,
          entry.sessionId,
          entry.requestId,
          response,
        );
        fulfilled = true;
      }
    } catch {
      fulfilled = false;
    }
    if (!entry.settled) {
      entry.settled = true;
      ctx.inflight.delete(entry.key);
    }
    ctx.emit(
      fulfilled
        ? { type: "relayed", url: safeUrl, status: response.status }
        : {
            type: "relayed_unfulfilled",
            url: safeUrl,
            status: response.status,
          },
    );
  } catch {
    await finish(ctx, entry, "fail");
    ctx.emit({ type: "failed", url: safeUrl, reason: "network" });
  }
}

async function settleClosed(
  ctx: PauseContext,
  entry: Inflight,
  url: string,
  request: PausedRequest,
): Promise<void> {
  const safeUrl = redact(url);
  try {
    let holds = textHoldsPlaceholderNumber(url, ctx.options.placeholder.number);
    let unreadable = false;
    if (!holds && requestHasBody(request)) {
      const read = await readBodyResult(
        ctx.connection,
        entry.sessionId,
        entry.requestId,
        request,
      );
      unreadable = read.unreadable;
      holds =
        unreadable ||
        matchHeldPlaceholderInBody(read.body, ctx.options.placeholder).kind !==
          "not_held";
    }
    if (holds) {
      await finish(ctx, entry, "fail");
      ctx.emit({
        type: "failed",
        url: safeUrl,
        reason: unreadable ? "unreadable_body" : "placeholder_mismatch",
      });
      return;
    }
    await finishContinue(ctx, entry);
  } catch {
    await finish(ctx, entry, "fail");
    ctx.emit({ type: "failed", url: safeUrl, reason: "unreadable_body" });
  }
}

export type PostDataPlan = "inline" | "entries" | "fetch" | "empty";

/** How a paused request's body should be read. Missing entry bytes are fetched. */
export function postDataPlan(request: {
  postData?: string;
  hasPostData?: boolean;
  postDataEntries?: { bytes?: string }[];
}): PostDataPlan {
  if (typeof request.postData === "string" && request.postData.length > 0) {
    return "inline";
  }
  if (request.postDataEntries && request.postDataEntries.length > 0) {
    const missing = request.postDataEntries.some(
      (entry) => typeof entry.bytes !== "string" || entry.bytes.length === 0,
    );
    return missing ? "fetch" : "entries";
  }
  if (request.hasPostData) return "fetch";
  return "empty";
}

async function readBodyResult(
  connection: CdpConnection,
  sessionId: string,
  requestId: string,
  request: PausedRequest,
): Promise<{ body: string; unreadable: boolean }> {
  const plan = postDataPlan(request);
  if (plan === "empty") return { body: "", unreadable: false };
  if (plan === "inline")
    return { body: request.postData ?? "", unreadable: false };
  if (plan === "entries") {
    const body = (request.postDataEntries ?? [])
      .map((entry) => Buffer.from(entry.bytes ?? "", "base64").toString("utf8"))
      .join("");
    return { body, unreadable: false };
  }
  try {
    const result = await connection.send<{ postData?: string }>(
      "Fetch.getRequestPostData",
      { requestId },
      sessionId,
    );
    if (typeof result.postData !== "string" || result.postData.length === 0) {
      return { body: "", unreadable: true };
    }
    return { body: result.postData, unreadable: false };
  } catch {
    return { body: "", unreadable: true };
  }
}

async function readMerchantOrigin(
  connection: CdpConnection,
  sessions: Map<string, Session>,
  sessionId: string,
): Promise<string | undefined> {
  const pageSessionId = topPageSession(sessions, sessionId);
  if (pageSessionId) {
    const fromPage = await originFromSession(
      connection,
      sessions,
      pageSessionId,
    );
    if (fromPage) return fromPage;
  }
  const ancestors = await connection
    .send<{ result?: { value?: unknown } }>(
      "Runtime.evaluate",
      {
        expression:
          "location.ancestorOrigins[location.ancestorOrigins.length - 1]",
        returnByValue: true,
      },
      sessionId,
    )
    .catch(() => null);
  const value = ancestors?.result?.value;
  if (typeof value === "string" && /^https?:\/\//.test(value)) return value;
  return undefined;
}

async function originFromSession(
  connection: CdpConnection,
  sessions: Map<string, Session>,
  sessionId: string,
): Promise<string | undefined> {
  const evaluated = await connection
    .send<{
      result?: { value?: unknown };
    }>("Runtime.evaluate", { expression: "location.origin", returnByValue: true }, sessionId)
    .catch(() => null);
  const value = evaluated?.result?.value;
  if (typeof value === "string" && /^https?:\/\//.test(value)) return value;
  const url = sessions.get(sessionId)?.url;
  if (!url) return undefined;
  try {
    const origin = new URL(url).origin;
    return /^https?:\/\//.test(origin) ? origin : undefined;
  } catch {
    return undefined;
  }
}

function readFrameOrigin(
  sessions: Map<string, Session>,
  sessionId: string,
  requestUrl: string,
): string | undefined {
  const raw = sessions.get(sessionId)?.url || requestUrl;
  try {
    const origin = new URL(raw).origin;
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
    if (!session) break;
    if (session.type === "page") return current;
    if (!session.parentSessionId) break;
    current = session.parentSessionId;
  }
  const pages = [...sessions.values()].filter(
    (session) => session.type === "page",
  );
  if (pages.length === 1) return pages[0].sessionId;
  return undefined;
}

/**
 * At the Fetch Request stage Chrome has not yet added the headers its network
 * stack appends (Cookie, Sec-Fetch-*, Accept-Language). Shopify's card session
 * needs those. Never override a header the request already has. Only called
 * when `synthesizeBrowserHeaders` is set.
 */
async function completeHeaders(
  connection: CdpConnection,
  sessions: Map<string, Session>,
  sessionId: string,
  requestUrl: string,
  resourceType: string,
  rawHeaders: unknown,
): Promise<RelayHeader[]> {
  const headers = headerList(rawHeaders);
  const has = (name: string) =>
    headers.some(([key]) => key.toLowerCase() === name);
  const frameUrl = sessions.get(sessionId)?.url || requestUrl;
  try {
    const target = new URL(requestUrl);
    const frame = new URL(frameUrl);
    if (!has("sec-fetch-site")) {
      const site = (value: URL) =>
        value.hostname.split(".").slice(-2).join(".");
      headers.push([
        "Sec-Fetch-Site",
        target.origin === frame.origin
          ? "same-origin"
          : site(target) === site(frame) && target.protocol === frame.protocol
            ? "same-site"
            : "cross-site",
      ]);
    }
    if (!has("sec-fetch-dest") && /^(Fetch|XHR)$/.test(resourceType)) {
      headers.push(["Sec-Fetch-Dest", "empty"]);
    }
    if (!has("accept-language")) {
      const languages = await connection
        .send<{
          result?: { value?: unknown };
        }>("Runtime.evaluate", { expression: "navigator.languages", returnByValue: true }, sessionId)
        .catch(() => null);
      const list = languages?.result?.value;
      if (
        Array.isArray(list) &&
        list.every((entry) => typeof entry === "string")
      ) {
        headers.push([
          "Accept-Language",
          list
            .map((language, index) =>
              index === 0
                ? language
                : `${language};q=${Math.max(0.1, 1 - index / 10).toFixed(1)}`,
            )
            .join(","),
        ]);
      }
    }
    if (!has("cookie")) {
      const cookies = await connection
        .send<{
          cookies?: { name: string; value: string }[];
        }>("Network.getCookies", { urls: [requestUrl] }, sessionId)
        .catch(() => null);
      if (cookies?.cookies?.length) {
        headers.push([
          "Cookie",
          cookies.cookies
            .map((cookie) => `${cookie.name}=${cookie.value}`)
            .join("; "),
        ]);
      }
    }
  } catch {
    // Keep the headers Chrome already gave us.
  }
  return headers;
}

function headerList(headers: unknown): RelayHeader[] {
  if (!headers) return [];
  if (Array.isArray(headers)) {
    const out: RelayHeader[] = [];
    for (const entry of headers) {
      if (Array.isArray(entry) && entry.length === 2) {
        out.push([String(entry[0]), String(entry[1])]);
        continue;
      }
      if (
        entry &&
        typeof entry === "object" &&
        typeof (entry as { name?: unknown }).name === "string"
      ) {
        const named = entry as { name: string; value?: unknown };
        out.push([named.name, String(named.value ?? "")]);
      }
    }
    return out;
  }
  if (typeof headers === "object") {
    const out: RelayHeader[] = [];
    for (const [key, value] of Object.entries(
      headers as Record<string, unknown>,
    )) {
      if (typeof value === "string") out.push([key, value]);
    }
    return out;
  }
  return [];
}

function requestHasBody(request: PausedRequest): boolean {
  if (request.hasPostData) return true;
  if (typeof request.postData === "string" && request.postData.length > 0) {
    return true;
  }
  return Boolean(request.postDataEntries && request.postDataEntries.length > 0);
}

async function armFetch(
  connection: CdpConnection,
  session: Session | undefined,
): Promise<boolean> {
  if (!session || isHandsOffTarget(session)) return false;
  if (session.fetchEnabled) return true;
  await connection
    .send("Network.enable", {}, session.sessionId)
    .catch(() => {});
  try {
    await connection.send(
      "Fetch.enable",
      { patterns: [{ urlPattern: "*", requestStage: "Request" }] },
      session.sessionId,
    );
  } catch {
    return false;
  }
  session.fetchEnabled = true;
  return true;
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
  ctx: PauseContext,
  entry: Inflight,
  url: string,
  request: PausedRequest,
): Promise<void> {
  const safeUrl = redact(url);
  if (
    textHoldsPlaceholderNumber(url, ctx.options.placeholder.number) ||
    requestHasBody(request)
  ) {
    try {
      const read = requestHasBody(request)
        ? await readBodyResult(
            ctx.connection,
            entry.sessionId,
            entry.requestId,
            request,
          )
        : { body: "", unreadable: false };
      const held =
        textHoldsPlaceholderNumber(url, ctx.options.placeholder.number) ||
        (!read.unreadable &&
          matchHeldPlaceholderInBody(read.body, ctx.options.placeholder)
            .kind !== "not_held");
      if (held) {
        await finish(ctx, entry, "fail");
        ctx.emit({
          type: "failed",
          url: safeUrl,
          reason: "placeholder_mismatch",
        });
        return;
      }
    } catch {
      // An unreadable captcha body is not the card post. Continue it.
    }
  }
  await finishContinue(ctx, entry);
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
  const responseHeaders = response.headers.flatMap(([name, value]) => {
    if (RESPONSE_HOP.has(name.toLowerCase())) return [];
    return [{ name, value }];
  });
  const body =
    response.bodyEncoding === "base64"
      ? response.body
      : Buffer.from(response.body, "utf8").toString("base64");
  await connection.send(
    "Fetch.fulfillRequest",
    {
      requestId,
      responseCode: response.status,
      responseHeaders,
      body,
    },
    sessionId,
  );
}

function failureReason(error: unknown): string {
  if (!error || typeof error !== "object") return "network";
  const name = "name" in error ? String(error.name) : "";
  const message = "message" in error ? String(error.message) : "";
  if (
    name === "TimeoutError" ||
    name === "AbortError" ||
    message === "Payment relay timed out" ||
    /timeout/i.test(message)
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
