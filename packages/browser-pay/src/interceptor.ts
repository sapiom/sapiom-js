import { CdpConnection, type CdpEvent } from "./cdp.js";
import {
  parseRelayResponse,
  paymentIdempotencyKey,
  type RelayHeader,
  type RelayResponse,
} from "./contract.js";
import {
  luhnHeldPan,
  matchHeldPlaceholderInBody,
  textContainsForeignCard,
  textHoldsPlaceholderNumber,
  type HeldPlaceholder,
} from "./detect.js";
import {
  acceptLanguageHeader,
  cookieHeader,
  secFetchDest,
  secFetchSite,
} from "./headers.js";
import { silentLogger, type PayLogger } from "./logger.js";
import type { PaymentRelay } from "./relay.js";
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
   * When set, Fetch pauses only URLs containing one of these strings.
   * Other requests are not paused, so a captcha solver keeps running.
   * Omit it to pause every page and iframe request.
   */
  pauseOnlyUrls?: string[];
  /** Defaults to a logger that discards every line. */
  logger?: PayLogger;
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
  return !textHoldsPlaceholderNumber(url, placeholderNumber);
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

// CDP writes the body bytes itself. These headers would describe a different
// representation (gzip, a length from the processor hop) than the bytes we fulfill.
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
  assertAttachOptions(options);
  const cdpUrl = resolveCdpUrl(target);
  const connection = await CdpConnection.connect(cdpUrl);
  const sessions = new Map<string, Session>();
  const seen = new Set<string>();
  const listeners = new Set<(event: InterceptorEvent) => void>();
  const inflight = new Map<string, Inflight>();
  const relayFlights = new Map<string, Promise<RelayResponse>>();
  const relayAborts = new Set<AbortController>();
  const loggedRefusals = new Set<string>();
  const pendingArms: Promise<void>[] = [];
  let closed = false;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const logger = options.logger ?? silentLogger;

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
    if (!session || isHandsOffTarget(session)) {
      await releaseTarget(connection, sessionId, waitingForDebugger);
      return;
    }
    // Fetch has to be on before the target runs, or the card iframe can post
    // before we are listening. Network has to be enabled before
    // Network.getCookies will return the jar the card session needs.
    const armed = await armFetch(connection, session, options.pauseOnlyUrls);
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
    const params = parseAttachedTarget(event.params);
    if (!params) return;
    const sessionId = params.sessionId;
    const info = params.targetInfo;
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
    const arm = (async () => {
      // Child iframes pause on attach so Fetch.enable runs before they resume.
      if (info.type === "page" || info.type === "iframe") {
        await connection
          .send(
            "Target.setAutoAttach",
            {
              autoAttach: true,
              waitForDebuggerOnStart: true,
              flatten: true,
              filter: [{ type: "iframe" }],
            },
            sessionId,
          )
          .catch(() => {});
      }
      await enableSession(sessionId, params.waitingForDebugger === true);
    })();
    pendingArms.push(arm);
    void arm.finally(() => {
      const index = pendingArms.indexOf(arm);
      if (index >= 0) pendingArms.splice(index, 1);
    });
  };

  const onPaused = (event: CdpEvent) => {
    const sessionId = event.sessionId;
    const params = parsePaused(event.params);
    if (!sessionId || !params) return;
    if (!sessions.has(sessionId)) {
      void failRequest(connection, sessionId, params.requestId);
      emit({
        type: "failed",
        url: redact(params.request.url ?? ""),
        reason: "unknown_session",
      });
      return;
    }
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
      relayFlights,
      loggedRefusals,
      logger,
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
      const sessionId = readStringField(event.params, "sessionId");
      if (sessionId) sessions.delete(sessionId);
    } else if (event.method === "Target.targetInfoChanged") {
      const info = parseTargetInfoChange(event.params);
      if (!info) return;
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
          void armFetch(connection, session, options.pauseOnlyUrls).then(
            (armed) => {
              if (armed || closed) return;
              emit({
                type: "failed",
                url: redact(session.url || session.targetId),
                reason: "intercept_unavailable",
              });
              void connection
                .send("Target.closeTarget", { targetId: session.targetId })
                .catch(() => {});
            },
          );
        }
      }
    }
  });

  await connection.send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
    filter: TARGET_FILTER,
  });
  await connection
    .send("Target.setDiscoverTargets", { discover: true })
    .catch(() => {});
  await attachExistingPaymentFrames(connection, sessions, options, (session) =>
    enableSession(session.sessionId, false),
  );
  await Promise.all([...pendingArms]);

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
  relayFlights: Map<string, Promise<RelayResponse>>;
  loggedRefusals: Set<string>;
  logger: PayLogger;
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
    const headers = await completeHeaders(
      ctx.connection,
      ctx.sessions,
      entry.sessionId,
      url,
      resourceType,
      request.headers,
    );
    const idempotencyKey = paymentIdempotencyKey(method, url, read.body);
    const controller = new AbortController();
    ctx.relayAborts.add(controller);
    const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);
    let response: RelayResponse;
    try {
      response = parseRelayResponse(
        await relayOnce(ctx, idempotencyKey, () =>
          ctx.options.relay.relay(
            {
              transactionId: ctx.options.transactionId,
              injectionRef: match.injectionRef,
              merchantOrigin,
              url,
              method,
              headers,
              body: read.body,
              idempotencyKey,
            },
            { signal: controller.signal },
          ),
        ),
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
    if (response.kind === "refused") {
      if (!ctx.loggedRefusals.has(idempotencyKey)) {
        ctx.loggedRefusals.add(idempotencyKey);
        ctx.logger.warn("payment relay refused the paused request", {
          reason: response.reason,
        });
      }
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
    // A failed fulfill must not leave the pause open. Chrome continues an
    // open pause when the socket drops, which would deliver the placeholder.
    if (!fulfilled && !entry.settled) {
      await failRequest(ctx.connection, entry.sessionId, entry.requestId);
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
    const result = await connection.send(
      "Fetch.getRequestPostData",
      { requestId },
      sessionId,
    );
    const postData = readStringField(result, "postData");
    if (!postData) return { body: "", unreadable: true };
    return { body: postData, unreadable: false };
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
    .send(
      "Runtime.evaluate",
      {
        expression:
          "location.ancestorOrigins[location.ancestorOrigins.length - 1]",
        returnByValue: true,
      },
      sessionId,
    )
    .catch(() => null);
  const value = evaluatedString(ancestors);
  if (value && /^https?:\/\//.test(value)) return value;
  return undefined;
}

async function originFromSession(
  connection: CdpConnection,
  sessions: Map<string, Session>,
  sessionId: string,
): Promise<string | undefined> {
  const evaluated = await connection
    .send(
      "Runtime.evaluate",
      { expression: "location.origin", returnByValue: true },
      sessionId,
    )
    .catch(() => null);
  const value = evaluatedString(evaluated);
  if (value && /^https?:\/\//.test(value)) return value;
  const url = sessions.get(sessionId)?.url;
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
 * stack appends. Fill the ones that are missing. Never override a header the
 * request already has. Cookie values are not logged.
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
  const site = secFetchSite(requestUrl, frameUrl);
  if (!has("sec-fetch-site") && site) {
    headers.push(["Sec-Fetch-Site", site]);
  }
  const dest = secFetchDest(resourceType);
  if (!has("sec-fetch-dest") && dest) {
    headers.push(["Sec-Fetch-Dest", dest]);
  }
  if (!has("accept-language")) {
    const languages = await readLanguages(connection, sessionId);
    if (languages.length > 0) {
      headers.push(["Accept-Language", acceptLanguageHeader(languages)]);
    }
  }
  if (!has("cookie")) {
    const cookies = await readCookies(connection, sessionId, requestUrl);
    if (cookies.length > 0) {
      headers.push(["Cookie", cookieHeader(cookies)]);
    }
  }
  return headers;
}

async function readLanguages(
  connection: CdpConnection,
  sessionId: string,
): Promise<string[]> {
  const evaluated = await connection
    .send(
      "Runtime.evaluate",
      { expression: "navigator.languages", returnByValue: true },
      sessionId,
    )
    .catch(() => undefined);
  return stringList(evaluated);
}

async function readCookies(
  connection: CdpConnection,
  sessionId: string,
  requestUrl: string,
): Promise<{ name: string; value: string }[]> {
  const result = await connection
    .send("Network.getCookies", { urls: [requestUrl] }, sessionId)
    .catch(() => undefined);
  if (!isRecord(result) || !Array.isArray(result.cookies)) return [];
  const cookies: { name: string; value: string }[] = [];
  for (const entry of result.cookies) {
    if (!isRecord(entry)) continue;
    if (typeof entry.name !== "string" || typeof entry.value !== "string") {
      continue;
    }
    cookies.push({ name: entry.name, value: entry.value });
  }
  return cookies;
}

function stringList(value: unknown): string[] {
  if (!isRecord(value) || !isRecord(value.result)) return [];
  const list = value.result.value;
  if (
    !Array.isArray(list) ||
    !list.every((entry) => typeof entry === "string")
  ) {
    return [];
  }
  return list.filter((entry): entry is string => typeof entry === "string");
}

function headerList(headers: unknown): RelayHeader[] {
  if (!headers) return [];
  if (Array.isArray(headers)) {
    const out: RelayHeader[] = [];
    for (const entry of headers) {
      if (
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === "string" &&
        typeof entry[1] === "string"
      ) {
        out.push([entry[0], entry[1]]);
        continue;
      }
      if (isRecord(entry) && typeof entry.name === "string") {
        const value = entry.value;
        out.push([entry.name, typeof value === "string" ? value : ""]);
      }
    }
    return out;
  }
  if (isRecord(headers)) {
    const out: RelayHeader[] = [];
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value === "string") out.push([key, value]);
    }
    return out;
  }
  return [];
}

function parseAttachedTarget(value: unknown):
  | {
      sessionId: string;
      waitingForDebugger: boolean;
      targetInfo: { targetId: string; type: string; url: string };
    }
  | undefined {
  if (!isRecord(value) || typeof value.sessionId !== "string") return undefined;
  if (!isRecord(value.targetInfo)) return undefined;
  const info = value.targetInfo;
  if (typeof info.targetId !== "string" || typeof info.type !== "string") {
    return undefined;
  }
  return {
    sessionId: value.sessionId,
    waitingForDebugger: value.waitingForDebugger === true,
    targetInfo: {
      targetId: info.targetId,
      type: info.type,
      url: typeof info.url === "string" ? info.url : "",
    },
  };
}

function parsePaused(
  value: unknown,
):
  | { requestId: string; resourceType: string; request: PausedRequest }
  | undefined {
  if (!isRecord(value) || typeof value.requestId !== "string") return undefined;
  if (!isRecord(value.request)) return undefined;
  const request = value.request;
  return {
    requestId: value.requestId,
    resourceType:
      typeof value.resourceType === "string" ? value.resourceType : "",
    request: {
      url: typeof request.url === "string" ? request.url : "",
      method: typeof request.method === "string" ? request.method : "GET",
      headers: request.headers,
      postData:
        typeof request.postData === "string" ? request.postData : undefined,
      hasPostData: request.hasPostData === true,
      postDataEntries: parsePostDataEntries(request.postDataEntries),
    },
  };
}

function parsePostDataEntries(
  value: unknown,
): { bytes?: string }[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: { bytes?: string }[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      entries.push({});
      continue;
    }
    entries.push(typeof entry.bytes === "string" ? { bytes: entry.bytes } : {});
  }
  return entries;
}

function parseTargetInfoChange(
  value: unknown,
): { targetId: string; url: string } | undefined {
  if (!isRecord(value) || !isRecord(value.targetInfo)) return undefined;
  const info = value.targetInfo;
  if (typeof info.targetId !== "string" || typeof info.url !== "string") {
    return undefined;
  }
  return { targetId: info.targetId, url: info.url };
}

function evaluatedString(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.result)) return undefined;
  return typeof value.result.value === "string"
    ? value.result.value
    : undefined;
}

function readStringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "string" ? field : undefined;
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
  pauseOnlyUrls: string[] | undefined,
): Promise<boolean> {
  if (!session || isHandsOffTarget(session)) return false;
  if (session.fetchEnabled) return true;
  await connection
    .send("Network.enable", {}, session.sessionId)
    .catch(() => {});
  try {
    await connection.send(
      "Fetch.enable",
      { patterns: fetchPatterns(pauseOnlyUrls) },
      session.sessionId,
    );
  } catch {
    return false;
  }
  session.fetchEnabled = true;
  return true;
}

function fetchPatterns(
  pauseOnlyUrls: string[] | undefined,
): { urlPattern: string; requestStage: "Request" }[] {
  if (!pauseOnlyUrls || pauseOnlyUrls.length === 0) {
    return [{ urlPattern: "*", requestStage: "Request" }];
  }
  const patterns: { urlPattern: string; requestStage: "Request" }[] = [];
  for (const part of pauseOnlyUrls) {
    patterns.push({ urlPattern: `*${part}*`, requestStage: "Request" });
  }
  return patterns;
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
  response: Extract<RelayResponse, { kind: "relayed" }>,
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

function relayOnce(
  ctx: PauseContext,
  key: string,
  call: () => Promise<RelayResponse>,
): Promise<RelayResponse> {
  const existing = ctx.relayFlights.get(key);
  if (existing) return existing;
  const flight = call().finally(() => {
    if (ctx.relayFlights.get(key) === flight) ctx.relayFlights.delete(key);
  });
  ctx.relayFlights.set(key, flight);
  return flight;
}

async function attachExistingPaymentFrames(
  connection: CdpConnection,
  sessions: Map<string, Session>,
  options: AttachOptions,
  enable: (session: Session) => Promise<void>,
): Promise<void> {
  const listed = await connection
    .send("Target.getTargets")
    .catch(() => undefined);
  for (const info of parseTargetInfos(listed)) {
    if (info.type !== "iframe") continue;
    if (!urlMatchesPause(info.url, options.pauseOnlyUrls)) continue;
    const known = [...sessions.values()].some(
      (session) => session.targetId === info.targetId,
    );
    if (known) continue;
    const attached = await connection
      .send("Target.attachToTarget", { targetId: info.targetId, flatten: true })
      .catch(() => undefined);
    const sessionId = readAttachedSessionId(attached);
    if (!sessionId || sessions.has(sessionId)) continue;
    const session: Session = {
      sessionId,
      targetId: info.targetId,
      type: "iframe",
      url: info.url,
    };
    sessions.set(sessionId, session);
    await connection
      .send(
        "Target.setAutoAttach",
        {
          autoAttach: true,
          waitForDebuggerOnStart: true,
          flatten: true,
          filter: [{ type: "iframe" }],
        },
        sessionId,
      )
      .catch(() => {});
    await enable(session);
  }
}

function urlMatchesPause(url: string, pauseOnlyUrls?: string[]): boolean {
  if (!pauseOnlyUrls || pauseOnlyUrls.length === 0) return true;
  return pauseOnlyUrls.some((part) => url.includes(part));
}

function parseTargetInfos(
  value: unknown,
): { targetId: string; type: string; url: string }[] {
  if (!isRecord(value) || !Array.isArray(value.targetInfos)) return [];
  const infos: { targetId: string; type: string; url: string }[] = [];
  for (const entry of value.targetInfos) {
    if (!isRecord(entry)) continue;
    if (typeof entry.targetId !== "string" || typeof entry.type !== "string") {
      continue;
    }
    infos.push({
      targetId: entry.targetId,
      type: entry.type,
      url: typeof entry.url === "string" ? entry.url : "",
    });
  }
  return infos;
}

function readAttachedSessionId(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.sessionId !== "string") return undefined;
  return value.sessionId.length > 0 ? value.sessionId : undefined;
}

function assertAttachOptions(options: AttachOptions): void {
  if (typeof options.relay?.relay !== "function") {
    throw new Error("A payment relay is required");
  }
  if (!options.transactionId) {
    throw new Error("transactionId is required");
  }
  if (
    !options.placeholder?.injectionRef ||
    !luhnHeldPan(options.placeholder.number)
  ) {
    throw new Error(
      "placeholder.injectionRef and a Luhn-valid placeholder number are required",
    );
  }
  const patterns = options.pauseOnlyUrls;
  if (
    patterns !== undefined &&
    (!Array.isArray(patterns) ||
      patterns.some((part) => typeof part !== "string"))
  ) {
    throw new Error("pauseOnlyUrls must be an array of strings");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveCdpUrl(target: InterceptorTarget): string {
  if (typeof target === "string") {
    if (!target) throw new Error("A CDP websocket URL is required");
    return target;
  }
  const direct = callString(target, "wsEndpoint");
  if (direct) return direct;
  const browser = callObject(target, "browser");
  const fromBrowser = browser ? callString(browser, "wsEndpoint") : undefined;
  if (fromBrowser) return fromBrowser;
  const context = callObject(target, "context");
  const nested = context ? callObject(context, "browser") : undefined;
  const fromContext = nested ? callString(nested, "wsEndpoint") : undefined;
  if (fromContext) return fromContext;
  throw new Error(
    "Pass a CDP websocket URL, or a Playwright/Puppeteer browser or page whose browser exposes wsEndpoint()",
  );
}

function callString(target: object, key: string): string | undefined {
  const method = Reflect.get(target, key);
  if (typeof method !== "function") return undefined;
  const value: unknown = method.call(target);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function callObject(target: object, key: string): object | undefined {
  const method = Reflect.get(target, key);
  if (typeof method !== "function") return undefined;
  const value: unknown = method.call(target);
  return typeof value === "object" && value !== null ? value : undefined;
}
