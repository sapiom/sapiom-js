import { CdpConnection, type CdpEvent } from "./cdp.js";
import {
  paymentIdempotencyKey,
  type RelayedHttpResponse,
  type RelayResponse,
} from "./contract.js";
import {
  redactHeld,
  textHoldsPlaceholderNumber,
  type HeldPlaceholder,
} from "./detect.js";
import { isRecord } from "./guards.js";
import { silentLogger, type PayLogger } from "./logger.js";
import {
  isRelayTimeout,
  RelayTimeoutError,
  type PaymentRelay,
} from "./relay.js";

export interface AttachOptions {
  relay: PaymentRelay;
  /** The one placeholder the agent was given for this checkout. */
  placeholder: HeldPlaceholder;
  /** Relay profile, for example `shopify-card-vault`. */
  profileId: string;
  /**
   * How long to wait for a terminal relay outcome before failing the paused
   * request. `relay_in_progress` is posted again with the same idempotency
   * key until this deadline. Identical pauses share that poll, including the
   * backoff. Any other refusal fails the request. `outcome: "unknown"` is
   * not sent again. A relay that ignores the abort signal still fails here.
   * One waiter's timeout does not abort a shared flight that another waiter
   * still holds.
   */
  timeoutMs?: number;
  /** Defaults to a logger that discards every line. */
  logger?: PayLogger;
}

export type FailureReason =
  | "intercept_unavailable"
  | "unknown_session"
  | "unreadable_body"
  | "detached"
  | "page_origin"
  | "unknown"
  | "timeout"
  | "network"
  | "response_credential";

export type InterceptorEvent =
  | { type: "paused"; url: string; method: string; targetType: string }
  | { type: "relayed"; url: string; status: number }
  | { type: "relayed_unfulfilled"; url: string; status: number }
  | { type: "refused"; url: string; reason: string }
  | { type: "failed"; url: string; reason: FailureReason };

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
const RELAY_POLL_INITIAL_MS = 200;
const RELAY_POLL_MAX_MS = 2_000;

const TARGET_FILTER = [{ type: "page" }, { type: "iframe" }];
const CHILD_FILTER = [{ type: "iframe" }];

/** GET/HEAD with no body and no held number in the URL. Safe to continue immediately. */
function canContinueWithoutReading(
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
 * Captcha widgets and the session solver. Holding them on Fetch or the
 * debugger stalls the solver past its own timeout.
 */
function isSolverTraffic(url: string): boolean {
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
  fetchEnabled: boolean;
}

// Blank frames stay armed. Disarming about:blank and arming again on the
// next URL drops the navigation that leaves the blank document.
function shouldArm(session: Session): boolean {
  return !isHandsOffTarget(session);
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

type InflightPhase =
  | { status: "open" }
  | { status: "continuing"; done: Promise<void> }
  | { status: "done" };

interface Inflight {
  key: string;
  sessionId: string;
  requestId: string;
  phase: InflightPhase;
}

interface PausedRequest {
  url: string;
  method: string;
  headers?: unknown;
  postData?: string;
  hasPostData?: boolean;
  postDataEntries?: { bytes?: string }[];
  networkId?: string;
}

interface Flight {
  promise: Promise<RelayResponse>;
  controller: AbortController;
  waiters: number;
}

type HeldRead =
  | { kind: "unreadable" }
  | { kind: "miss" }
  | { kind: "held"; body: string };

type Decision =
  | { action: "continue" }
  | { action: "fail"; reason: FailureReason }
  | { action: "refused"; reason: string }
  | { action: "relayed"; response: RelayedHttpResponse };

type SettleAction = "continue" | "fail" | { fulfill: RelayedHttpResponse };

type Listener = (event: InterceptorEvent) => void;

export async function attachInterceptor(
  target: InterceptorTarget,
  options: AttachOptions,
): Promise<InterceptorHandle> {
  assertAttachOptions(options);
  const connection = await CdpConnection.connect(resolveCdpUrl(target));
  try {
    return await new PaymentInterceptor(connection, options).start();
  } catch (error) {
    connection.close();
    throw error;
  }
}

class PaymentInterceptor {
  private readonly sessions = new Map<string, Session>();
  private readonly byTarget = new Map<string, Session>();
  private readonly enabledSessions = new Set<string>();
  private readonly listeners = new Set<Listener>();
  private readonly inflight = new Map<string, Inflight>();
  private readonly relayFlights = new Map<string, Flight>();
  private readonly unknownKeys = new Set<string>();
  private readonly loggedRefusals = new Set<string>();
  private readonly pendingArms = new Set<Promise<void>>();
  private readonly timeoutMs: number;
  private readonly logger: PayLogger;
  private backlog: InterceptorEvent[] | null = [];
  private buffering = true;
  private closed = false;

  constructor(
    private readonly connection: CdpConnection,
    private readonly options: AttachOptions,
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.logger = options.logger ?? silentLogger;
  }

  private get number(): string {
    return this.options.placeholder.number;
  }

  async start(): Promise<InterceptorHandle> {
    this.connection.onEvent((event) => this.dispatch(event));
    await this.connection.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: TARGET_FILTER,
    });
    await this.connection
      .send("Target.setDiscoverTargets", { discover: true })
      .catch(() => {});
    await this.attachExistingFrames();
    await Promise.all([...this.pendingArms]);
    this.buffering = false;
    return {
      on: (listener) => this.subscribe(listener),
      detach: () => this.detach(),
    };
  }

  private dispatch(event: CdpEvent): void {
    if (event.method === "Fetch.requestPaused") {
      this.onPaused(event);
      return;
    }
    if (this.closed) return;
    if (event.method === "Target.attachedToTarget") this.onAttached(event);
    else if (event.method === "Target.detachedFromTarget")
      this.onDetached(event);
    else if (event.method === "Target.targetInfoChanged") {
      this.onTargetInfoChanged(event);
    }
  }

  private onAttached(event: CdpEvent): void {
    const params = parseAttachedTarget(event.params);
    if (!params) return;
    const sessionId = params.sessionId;
    const info = params.targetInfo;
    if (this.byTarget.has(info.targetId)) {
      // setAutoAttach already owns this target. A second session would pause
      // every request twice.
      void this.resumeIfWaiting(sessionId, params.waitingForDebugger).then(() =>
        this.connection
          .send("Target.detachFromTarget", { sessionId })
          .catch(() => {}),
      );
      return;
    }
    const session = this.trackSession({
      sessionId,
      targetId: info.targetId,
      type: info.type,
      url: info.url,
      fetchEnabled: false,
      ...(event.sessionId ? { parentSessionId: event.sessionId } : {}),
    });
    const arm = (async () => {
      if (info.type === "page" || info.type === "iframe") {
        await this.autoAttachChildren(sessionId);
      }
      await this.enableSession(session.sessionId, params.waitingForDebugger);
    })();
    this.pendingArms.add(arm);
    void arm.finally(() => {
      this.pendingArms.delete(arm);
    });
  }

  private onDetached(event: CdpEvent): void {
    const sessionId = readStringField(event.params, "sessionId");
    if (!sessionId) return;
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    this.enabledSessions.delete(sessionId);
    if (this.byTarget.get(session.targetId) === session) {
      this.byTarget.delete(session.targetId);
    }
  }

  private onTargetInfoChanged(event: CdpEvent): void {
    const info = parseTargetInfoChange(event.params);
    if (!info) return;
    const session = this.byTarget.get(info.targetId);
    if (!session) return;
    session.url = info.url;
    if (!shouldArm(session)) {
      this.disarm(session);
      return;
    }
    if (!session.fetchEnabled) void this.armOrClose(session);
  }

  private disarm(session: Session): void {
    if (session.fetchEnabled) {
      session.fetchEnabled = false;
      void this.connection
        .send("Fetch.disable", {}, session.sessionId)
        .catch(() => {});
    }
    void this.resumeIfWaiting(session.sessionId, true);
  }

  private async enableSession(
    sessionId: string,
    waitingForDebugger: boolean,
  ): Promise<void> {
    if (this.enabledSessions.has(sessionId)) {
      await this.resumeIfWaiting(sessionId, waitingForDebugger);
      return;
    }
    this.enabledSessions.add(sessionId);
    const session = this.sessions.get(sessionId);
    if (!session || !shouldArm(session)) {
      await this.resumeIfWaiting(sessionId, waitingForDebugger);
      return;
    }
    // Fetch has to be on before the target runs, or the card iframe can post
    // before we are listening.
    const armed = await this.armOrClose(session);
    if (!armed) return;
    await this.resumeIfWaiting(sessionId, waitingForDebugger);
  }

  private async armOrClose(session: Session): Promise<boolean> {
    const armed = await armFetch(this.connection, session);
    if (armed) return true;
    if (this.closed) return false;
    this.emit({
      type: "failed",
      url: this.safe(session.url || session.targetId),
      reason: "intercept_unavailable",
    });
    await this.connection
      .send("Target.closeTarget", { targetId: session.targetId })
      .catch(() => {});
    return false;
  }

  private async autoAttachChildren(sessionId: string): Promise<void> {
    await this.connection
      .send(
        "Target.setAutoAttach",
        {
          autoAttach: true,
          waitForDebuggerOnStart: true,
          flatten: true,
          filter: CHILD_FILTER,
        },
        sessionId,
      )
      .catch(() => {});
  }

  private async resumeIfWaiting(
    sessionId: string,
    waitingForDebugger: boolean,
  ): Promise<void> {
    if (!waitingForDebugger) return;
    await this.connection
      .send("Runtime.runIfWaitingForDebugger", {}, sessionId)
      .catch(() => {});
  }

  private async attachExistingFrames(): Promise<void> {
    const listed = await this.connection
      .send("Target.getTargets")
      .catch(() => undefined);
    for (const info of parseTargetInfos(listed)) {
      if (info.type !== "iframe") continue;
      if (this.byTarget.has(info.targetId)) continue;
      const attached = await this.connection
        .send("Target.attachToTarget", {
          targetId: info.targetId,
          flatten: true,
        })
        .catch(() => undefined);
      const sessionId = readAttachedSessionId(attached);
      if (!sessionId || this.sessions.has(sessionId)) continue;
      const session = this.trackSession({
        sessionId,
        targetId: info.targetId,
        type: "iframe",
        url: info.url,
        fetchEnabled: false,
      });
      await this.autoAttachChildren(sessionId);
      await this.enableSession(session.sessionId, false);
    }
  }

  private trackSession(session: Session): Session {
    this.sessions.set(session.sessionId, session);
    this.byTarget.set(session.targetId, session);
    return session;
  }

  private onPaused(event: CdpEvent): void {
    const sessionId = event.sessionId;
    const parsed = parsePaused(event.params);
    if (!sessionId || !parsed) return;
    const { requestId, request } = parsed;
    if (!this.sessions.has(sessionId)) {
      void failRequest(this.connection, sessionId, requestId);
      this.emit({
        type: "failed",
        url: this.safe(request.url),
        reason: "unknown_session",
      });
      return;
    }
    const key = inflightKey(sessionId, requestId);
    if (this.inflight.has(key)) return;
    const entry: Inflight = {
      key,
      sessionId,
      requestId,
      phase: { status: "open" },
    };
    this.inflight.set(key, entry);
    if (
      canContinueWithoutReading(
        request.method,
        request.url,
        postDataPlan(request) !== "empty",
        this.number,
      )
    ) {
      void this.settle(entry, "continue");
      return;
    }
    void this.handlePaused(entry, request);
  }

  private async handlePaused(
    entry: Inflight,
    request: PausedRequest,
  ): Promise<void> {
    const safeUrl = this.safe(request.url);
    try {
      const decision = await this.decide(entry, request, safeUrl);
      await this.apply(entry, safeUrl, decision);
    } catch {
      await this.settle(entry, "fail");
      this.emit({ type: "failed", url: safeUrl, reason: "network" });
    }
  }

  private async decide(
    entry: Inflight,
    request: PausedRequest,
    safeUrl: string,
  ): Promise<Decision> {
    const read = await this.readHeld(entry.sessionId, request);
    if (read.kind === "unreadable") {
      return { action: "fail", reason: "unreadable_body" };
    }
    if (read.kind === "miss") return { action: "continue" };
    if (this.closed) return { action: "fail", reason: "detached" };
    const targetType = this.sessions.get(entry.sessionId)?.type ?? "";
    this.emit({
      type: "paused",
      url: safeUrl,
      method: request.method,
      targetType,
    });
    const pageOrigin = await readPageOrigin(
      this.connection,
      this.sessions,
      entry.sessionId,
    );
    if (!pageOrigin || this.closed) {
      return {
        action: "fail",
        reason: pageOrigin ? "detached" : "page_origin",
      };
    }
    const idempotencyKey = paymentIdempotencyKey(
      request.method,
      request.url,
      read.body,
    );
    if (this.unknownKeys.has(idempotencyKey)) {
      return { action: "fail", reason: "unknown" };
    }
    return this.awaitRelay(request, read.body, pageOrigin, idempotencyKey);
  }

  private async awaitRelay(
    request: PausedRequest,
    body: string,
    pageOrigin: string,
    idempotencyKey: string,
  ): Promise<Decision> {
    const flight = this.relayOnce(idempotencyKey, (signal) =>
      this.pollRelay(request, body, pageOrigin, idempotencyKey, signal),
    );
    let response: RelayResponse;
    try {
      response = await failAfter(flight.promise, this.timeoutMs);
    } catch (error) {
      this.releaseWaiter(flight);
      return {
        action: "fail",
        reason: this.closed ? "detached" : failureReason(error),
      };
    }
    this.releaseWaiter(flight);
    if (this.closed) return { action: "fail", reason: "detached" };
    return this.decisionForOutcome(response, idempotencyKey);
  }

  private async pollRelay(
    request: PausedRequest,
    body: string,
    pageOrigin: string,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<RelayResponse> {
    let poll = 0;
    for (;;) {
      if (signal.aborted || this.closed) throw abortError(signal);
      if (this.unknownKeys.has(idempotencyKey)) {
        return { outcome: "unknown" };
      }
      const response = await this.options.relay.relay(
        {
          injectionRef: this.options.placeholder.injectionRef,
          profileId: this.options.profileId,
          pageOrigin,
          request: {
            method: request.method,
            url: request.url,
            headers: forwardedHeaders(request.headers),
            body,
          },
          idempotencyKey,
        },
        { signal },
      );
      if (response.outcome === "unknown") {
        this.unknownKeys.add(idempotencyKey);
      }
      if (!isRelayInProgress(response)) return response;
      poll += 1;
      await sleep(relayPollDelayMs(poll), signal);
    }
  }

  private async readHeld(
    sessionId: string,
    request: PausedRequest,
  ): Promise<HeldRead> {
    const urlHeld = textHoldsPlaceholderNumber(request.url, this.number);
    if (urlHeld && this.closed) return { kind: "held", body: "" };
    if (postDataPlan(request) === "empty") {
      return urlHeld ? { kind: "held", body: "" } : { kind: "miss" };
    }
    const body = await readBody(this.connection, sessionId, request);
    if (body === undefined) return { kind: "unreadable" };
    if (urlHeld || textHoldsPlaceholderNumber(body, this.number)) {
      return { kind: "held", body };
    }
    return { kind: "miss" };
  }

  private decisionForOutcome(
    response: RelayResponse,
    idempotencyKey: string,
  ): Decision {
    if (response.outcome === "unknown") {
      this.unknownKeys.add(idempotencyKey);
      return { action: "fail", reason: "unknown" };
    }
    if (response.outcome === "refused") {
      this.logRefusalOnce(idempotencyKey, response.reason);
      return { action: "refused", reason: response.reason };
    }
    if (textHoldsPlaceholderNumber(response.response.body, this.number)) {
      return { action: "fail", reason: "response_credential" };
    }
    return { action: "relayed", response: response.response };
  }

  private logRefusalOnce(idempotencyKey: string, reason: string): void {
    if (this.loggedRefusals.has(idempotencyKey)) return;
    this.loggedRefusals.add(idempotencyKey);
    this.logger.warn("payment relay refused the paused request", { reason });
  }

  private async apply(
    entry: Inflight,
    safeUrl: string,
    decision: Decision,
  ): Promise<void> {
    if (decision.action === "continue") {
      await this.settle(entry, "continue");
      return;
    }
    if (decision.action === "fail") {
      await this.settle(entry, "fail");
      this.emit({ type: "failed", url: safeUrl, reason: decision.reason });
      return;
    }
    if (decision.action === "refused") {
      await this.settle(entry, "fail");
      this.emit({ type: "refused", url: safeUrl, reason: decision.reason });
      return;
    }
    const fulfilled = await this.settle(entry, { fulfill: decision.response });
    this.emit(
      fulfilled
        ? { type: "relayed", url: safeUrl, status: decision.response.status }
        : {
            type: "relayed_unfulfilled",
            url: safeUrl,
            status: decision.response.status,
          },
    );
  }

  private async settle(
    entry: Inflight,
    action: SettleAction,
  ): Promise<boolean> {
    if (entry.phase.status !== "open") return false;
    if (action === "continue") {
      const done = continueRequest(
        this.connection,
        entry.sessionId,
        entry.requestId,
      ).finally(() => {
        entry.phase = { status: "done" };
        this.inflight.delete(entry.key);
      });
      entry.phase = { status: "continuing", done };
      await done;
      return true;
    }
    entry.phase = { status: "done" };
    try {
      if (action === "fail") {
        await failRequest(this.connection, entry.sessionId, entry.requestId);
        return true;
      }
      await fulfillRequest(
        this.connection,
        entry.sessionId,
        entry.requestId,
        action.fulfill,
      );
      return true;
    } catch {
      await failRequest(this.connection, entry.sessionId, entry.requestId);
      return false;
    } finally {
      this.inflight.delete(entry.key);
    }
  }

  private async drainInflight(): Promise<void> {
    const entries = [...this.inflight.values()];
    await Promise.all(
      entries.map(async (entry) => {
        if (entry.phase.status === "continuing") {
          await entry.phase.done;
          return;
        }
        if (entry.phase.status === "open") await this.settle(entry, "fail");
      }),
    );
  }

  private relayOnce(
    key: string,
    start: (signal: AbortSignal) => Promise<RelayResponse>,
  ): Flight {
    const existing = this.relayFlights.get(key);
    if (existing && !existing.controller.signal.aborted) {
      existing.waiters += 1;
      return existing;
    }
    const controller = new AbortController();
    const promise = start(controller.signal).finally(() => {
      const current = this.relayFlights.get(key);
      if (current?.controller === controller) this.relayFlights.delete(key);
    });
    void promise.catch(() => {});
    const flight: Flight = { controller, waiters: 1, promise };
    this.relayFlights.set(key, flight);
    return flight;
  }

  private releaseWaiter(flight: Flight): void {
    flight.waiters -= 1;
    if (flight.waiters > 0) return;
    flight.controller.abort();
  }

  private async detach(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.buffering = false;
    this.backlog = null;
    for (const flight of this.relayFlights.values()) flight.controller.abort();
    await this.drainInflight();
    for (const sessionId of this.sessions.keys()) {
      await this.connection
        .send("Fetch.disable", {}, sessionId)
        .catch(() => {});
    }
    // A pause delivered while disable was in flight is still failed or
    // continued here, before the socket goes away.
    await this.drainInflight();
    await this.connection
      .send("Target.setAutoAttach", {
        autoAttach: false,
        waitForDebuggerOnStart: false,
        flatten: true,
      })
      .catch(() => {});
    this.connection.close();
  }

  private subscribe(listener: Listener): () => void {
    const missed = this.backlog;
    this.backlog = null;
    this.listeners.add(listener);
    if (missed) {
      for (const event of missed) this.deliver(listener, event);
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: InterceptorEvent): void {
    if (this.buffering && this.backlog) {
      this.backlog.push(event);
      return;
    }
    for (const listener of this.listeners) this.deliver(listener, event);
  }

  private deliver(listener: Listener, event: InterceptorEvent): void {
    try {
      listener(event);
    } catch {
      // A listener must not break interception.
    }
  }

  private safe(value: string): string {
    return redactHeld(value, this.number);
  }
}

function inflightKey(sessionId: string, requestId: string): string {
  return `${sessionId}\n${requestId}`;
}

function isRelayInProgress(response: RelayResponse): boolean {
  return (
    response.outcome === "refused" && response.reason === "relay_in_progress"
  );
}

function relayPollDelayMs(attempt: number): number {
  const shift = Math.min(Math.max(attempt, 1) - 1, 10);
  return Math.min(RELAY_POLL_INITIAL_MS * 2 ** shift, RELAY_POLL_MAX_MS);
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function failureReason(error: unknown): FailureReason {
  return isRelayTimeout(error) ? "timeout" : "network";
}

function failAfter<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new RelayTimeoutError());
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(
          error instanceof Error ? error : new Error("Payment relay failed"),
        );
      },
    );
  });
}

type PostDataPlan = "inline" | "entries" | "fetch" | "empty";

function postDataPlan(request: PausedRequest): PostDataPlan {
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

async function readBody(
  connection: CdpConnection,
  sessionId: string,
  request: PausedRequest,
): Promise<string | undefined> {
  const plan = postDataPlan(request);
  if (plan === "empty") return "";
  if (plan === "inline") return request.postData ?? "";
  if (plan === "entries") {
    return Buffer.concat(
      (request.postDataEntries ?? []).map((entry) =>
        Buffer.from(entry.bytes ?? "", "base64"),
      ),
    ).toString("utf8");
  }
  if (!request.networkId) return undefined;
  try {
    const result = await connection.send(
      "Network.getRequestPostData",
      { requestId: request.networkId },
      sessionId,
    );
    const postData = readStringField(result, "postData");
    if (!postData) return undefined;
    const body =
      isRecord(result) && result.base64Encoded === true
        ? Buffer.from(postData, "base64").toString("utf8")
        : postData;
    if (isMultipart(request.headers) && multipartOmitsFileBytes(body)) {
      return undefined;
    }
    return body;
  } catch {
    return undefined;
  }
}

async function readPageOrigin(
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
  const visited = new Set<string>();
  while (current && !visited.has(current)) {
    visited.add(current);
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

const FORWARDED_HEADERS = new Set([
  "accept",
  "content-type",
  "shopify-identification-signature",
]);

function forwardedHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const take = (name: string, value: string) => {
    const key = name.toLowerCase();
    if (!FORWARDED_HEADERS.has(key) || value.length > 8192) return;
    out[key] = value;
  };
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === "string" &&
        typeof entry[1] === "string"
      ) {
        take(entry[0], entry[1]);
        continue;
      }
      if (isRecord(entry) && typeof entry.name === "string") {
        take(entry.name, typeof entry.value === "string" ? entry.value : "");
      }
    }
    return out;
  }
  if (isRecord(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === "string") take(key, value);
    }
  }
  return out;
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
): { requestId: string; request: PausedRequest } | undefined {
  if (!isRecord(value) || typeof value.requestId !== "string") return undefined;
  if (!isRecord(value.request)) return undefined;
  const request = value.request;
  return {
    requestId: value.requestId,
    request: {
      url: typeof request.url === "string" ? request.url : "",
      method: typeof request.method === "string" ? request.method : "GET",
      headers: request.headers,
      postData:
        typeof request.postData === "string" ? request.postData : undefined,
      hasPostData: request.hasPostData === true,
      postDataEntries: parsePostDataEntries(request.postDataEntries),
      ...(typeof value.networkId === "string" && value.networkId.length > 0
        ? { networkId: value.networkId }
        : {}),
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

function headerValue(headers: unknown, name: string): string {
  const wanted = name.toLowerCase();
  if (Array.isArray(headers)) {
    for (const entry of headers) {
      if (
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === "string" &&
        typeof entry[1] === "string" &&
        entry[0].toLowerCase() === wanted
      ) {
        return entry[1];
      }
      if (
        isRecord(entry) &&
        typeof entry.name === "string" &&
        entry.name.toLowerCase() === wanted &&
        typeof entry.value === "string"
      ) {
        return entry.value;
      }
    }
    return "";
  }
  if (isRecord(headers)) {
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === wanted && typeof value === "string") {
        return value;
      }
    }
  }
  return "";
}

function isMultipart(headers: unknown): boolean {
  return headerValue(headers, "content-type")
    .toLowerCase()
    .includes("multipart/");
}

// The retrieved body keeps a file part's filename header and drops its bytes.
function multipartOmitsFileBytes(body: string): boolean {
  return /content-disposition:[^\r\n]*[;\s]filename\s*\*?=/i.test(body);
}

async function armFetch(
  connection: CdpConnection,
  session: Session,
): Promise<boolean> {
  if (session.fetchEnabled) return true;
  try {
    await connection
      .send("Network.enable", {}, session.sessionId)
      .catch(() => {});
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
  response: RelayedHttpResponse,
): Promise<void> {
  const responseHeaders = Object.entries(response.headers).flatMap(
    ([name, value]) => {
      if (RESPONSE_HOP.has(name.toLowerCase())) return [];
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
  if (!options.profileId) {
    throw new Error("profileId is required");
  }
  const digits = options.placeholder?.number?.replace(/\D/g, "") ?? "";
  if (!options.placeholder?.injectionRef || digits.length === 0) {
    throw new Error(
      "placeholder.injectionRef and placeholder.number are required",
    );
  }
}

function resolveCdpUrl(target: InterceptorTarget): string {
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
