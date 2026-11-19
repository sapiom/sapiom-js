import { CdpCommandError, CdpConnection, type CdpEvent } from "./cdp.js";
import {
  isAdyenActionResult,
  paymentIdempotencyKey,
  type AdyenEncryptedFields,
  type AdyenEncryptResult,
  type AdyenResultCode,
  type AdyenResultResponse,
  type RelayedHttpResponse,
  type RelayResponse,
} from "./contract.js";
import {
  adyenClientKeysInRequest,
  adyenCheckout,
  adyenDetailsCheckout,
  adyenPaymentResult,
  isAdyenClientKey,
  isAdyenSecuredFieldsPayment,
  redactHeld,
  textHoldsPlaceholderNumber,
  withAdyenEncryptedFields,
  type HeldPlaceholder,
} from "./detect.js";
import { isRecord } from "./guards.js";
import { silentLogger, type PayLogger } from "./logger.js";
import {
  isRelayTimeout,
  isRetryableRelayError,
  RelayHttpError,
  RelayTimeoutError,
  type PaymentRelay,
} from "./relay.js";

export interface AttachOptions {
  relay: PaymentRelay;
  /** The one placeholder the agent was given for this checkout. */
  placeholder: HeldPlaceholder;
  /**
   * Relay profile, for example `shopify-card-vault`. Omit it for any other
   * checkout: the relay sends the paused request to its own URL when that is
   * https to a public host, and finds the card fields by the placeholder's
   * values. Without a profile headers including `cookie` are forwarded, except
   * the connection's, `host`, `content-length`, and the browser's `sec-fetch-*`
   * and `sec-ch-*` hints. Oversized cookies lose known analytics pairs first;
   * cookies still exceeding the relay's value or header-count limit are omitted.
   */
  profileId?: string;
  /**
   * How long to wait for a terminal relay outcome before failing the paused
   * request. Defaults to 55 seconds. Identical pauses share one poll,
   * including the backoff. `relay_in_progress`, a per-attempt timeout, a
   * transport error, and HTTP 502, 503, and 504 are posted again with the
   * same idempotency key until this deadline. Any other refusal fails the
   * request. `outcome: "unknown"` is not sent again. A relay that ignores
   * the abort signal still fails here. One waiter's timeout does not abort
   * a shared flight that another waiter still holds.
   */
  timeoutMs?: number;
  /**
   * How long one relay POST may run before it is aborted and tried again.
   * Defaults to 25 seconds, under the 30 second router limit. The total
   * wait is `timeoutMs`.
   */
  attemptTimeoutMs?: number;
  /** Defaults to a logger that discards every line. */
  logger?: PayLogger;
  /**
   * `true` turns Adyen secured-fields payments off for this attach: such a
   * payment fails with `adyen_not_enabled` and the backend is not asked.
   * There is no way to force them on: they run only when the backend's
   * Adyen encryption answers with fields.
   */
  disableAdyenEncryption?: boolean;
}

/** Whether a page's Adyen secured-fields payment can be paid. */
export type AdyenReadiness =
  | { enabled: true }
  | {
      enabled: false;
      reason: Extract<
        FailureReason,
        "adyen_not_enabled" | "adyen_client_key" | "adyen_encrypt"
      >;
    };

/**
 * Asks, before any card is typed, whether an Adyen secured-fields payment on
 * `pageOrigin` with `clientKey` will be paid. `fillCard` takes one as
 * `adyen`; the interceptor handle is one.
 */
export interface AdyenGate {
  prepareAdyen(input: {
    clientKey: string;
    pageOrigin: string;
  }): Promise<AdyenReadiness>;
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
  | "response_credential"
  | "headers_unrelayable"
  | "adyen_not_enabled"
  | "adyen_client_key"
  | "adyen_encrypt";

export const KNOWN_REFUSAL_REASONS = [
  "unknown_injection",
  "injection_expired",
  "payment_released",
  "key_rotated",
  "already_relayed",
  "relay_in_progress",
  "card_removed",
  "payment_not_authorized",
  "total_changed",
  "destination_not_allowed",
  "card_fields_invalid",
  "merchant_mismatch",
  "provider_unavailable",
  "merchant_unavailable",
  "card_unavailable",
  "payments_stopped",
  "sapiom_error",
  "relaying_under_other_key",
  "stale_generation",
] as const;

export type KnownRefusalReason = (typeof KNOWN_REFUSAL_REASONS)[number];

// `{}` keeps autocomplete on the known reasons without closing the union.
// eslint-disable-next-line @typescript-eslint/ban-types
export type RefusalReason = KnownRefusalReason | (string & {});

/**
 * Event `url` is the request origin (`scheme://host[:port]`) with any held
 * placeholder masked, `""` when unparseable, or the scheme (for example,
 * `about:`) for opaque origins. Path, query, fragment, and userinfo are never
 * included.
 */
export type InterceptorEvent =
  | { type: "paused"; url: string; method: string; targetType: string }
  | { type: "relayed"; url: string; status: number }
  | { type: "relayed_unfulfilled"; url: string; status: number }
  /** An Adyen secured-fields payment continued with the card's own encrypted fields. */
  | { type: "reencrypted"; url: string }
  /**
   * What Adyen answered a re-encrypted payment, once per payment. `status` is
   * the page's HTTP status; `reported` is false when the backend did not take
   * the result. True means only that the backend took it, not that the
   * purchase completed: a code that is not final changes nothing.
   */
  | {
      type: "adyen_result";
      url: string;
      resultCode: AdyenResultCode;
      status: number;
      reported: boolean;
    }
  | {
      type: "refused";
      url: string;
      reason: RefusalReason;
      /** Missing when the relay did not send a boolean. The SDK does not invent one. */
      retryable?: boolean;
      /** Present only when the id passes the redaction checks. Not logged. */
      requestId?: string;
    }
  | { type: "failed"; url: string; reason: FailureReason };

type PublicRefusal = Omit<
  Extract<InterceptorEvent, { type: "refused" }>,
  "type" | "url"
>;

export interface InterceptorHandle extends AdyenGate {
  detach(): Promise<void>;
  /** Subscribe to outcomes. Returns an unsubscribe function. */
  on(listener: (event: InterceptorEvent) => void): () => void;
}

/**
 * A browser CDP WebSocket URL (`ws://` or `wss://`) or DevTools discovery URL
 * (`http://` or `https://`), the same URLs Playwright's `connectOverCDP`
 * takes, or a Puppeteer browser or page that can provide one through
 * `wsEndpoint()`. Playwright's `Browser` and `Page` have no `wsEndpoint()`
 * (only its `BrowserServer` does, and that URL speaks Playwright's own
 * protocol, not CDP), so with Playwright pass the CDP URL instead. A URL with
 * any other scheme is refused before a connection opens. Browser Pay
 * always opens its own connection.
 */
export type InterceptorTarget =
  | string
  | { wsEndpoint(): string }
  | { browser(): { wsEndpoint(): string } | null }
  // Neither Puppeteer nor Playwright fits this shape today; it stays so
  // existing callers still compile.
  | { context(): { browser(): { wsEndpoint(): string } | null } | null };

const DEFAULT_ATTEMPT_TIMEOUT_MS = 25_000;
const DEFAULT_TIMEOUT_MS = 55_000;
const RELAY_POLL_INITIAL_MS = 200;
const RELAY_POLL_MAX_MS = 2_000;

const TARGET_FILTER = [{ type: "page" }, { type: "iframe" }];
const CHILD_FILTER = [{ type: "iframe" }];

function eventUrl(value: string, number: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "";
  }
  const origin = parsed.origin !== "null" ? parsed.origin : parsed.protocol;
  const redacted = redactHeld(origin, number);
  // Fail closed if masking ever leaves a held number behind.
  return textHoldsPlaceholderNumber(redacted, number) ? "" : redacted;
}

const REASON_SHAPE = /^[a-z]+(_[a-z]+)*$/;
const REASON_MAX_LENGTH = 48;
const REQUEST_ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;
const SEPARATED_PAN = /^\d{13,19}$/;
const RAW_PAN_RUN = /\d{13,}/;

function publicReason(reason: string): RefusalReason {
  return reason.length <= REASON_MAX_LENGTH && REASON_SHAPE.test(reason)
    ? reason
    : "unrecognized";
}

const CODE_SHAPE = /^[A-Za-z0-9_]{1,48}$/;

function publicCode(code: string): string {
  return CODE_SHAPE.test(code) ? code : "unrecognized";
}

function publicRequestId(id: unknown, heldNumber: string): string | undefined {
  if (typeof id !== "string") return undefined;
  if (!REQUEST_ID_SHAPE.test(id)) return undefined;
  const collapsed = id.replace(/[_-]/g, "");
  const held = heldNumber.replace(/[^A-Za-z0-9]/g, "");
  if (held.length > 0 && collapsed.includes(held)) return undefined;
  if (SEPARATED_PAN.test(collapsed) || RAW_PAN_RUN.test(id)) return undefined;
  return id;
}

function publicRefusal(
  refusal: Extract<RelayResponse, { outcome: "refused" }>,
  heldNumber: string,
): PublicRefusal {
  const reason = refusal.reason;
  const retryable = refusal.retryable;
  const requestId = publicRequestId(refusal.requestId, heldNumber);
  return {
    reason: publicReason(typeof reason === "string" ? reason : ""),
    ...(typeof retryable === "boolean" ? { retryable } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
  };
}

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
  networkId?: string;
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
  | { kind: "miss"; body: string }
  | { kind: "held"; body: string };

type Decision =
  | { action: "continue" }
  | { action: "reencrypted"; body: string }
  | { action: "awaitAdyenResult" }
  | { action: "fail"; reason: FailureReason }
  | { action: "refused"; refusal: PublicRefusal }
  | { action: "relayed"; response: RelayedHttpResponse };

type SettleAction =
  | "continue"
  | "continueForAnswer"
  | "fail"
  | { fulfill: RelayedHttpResponse }
  | { continueWith: string };

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
  /** Fields a `prepareAdyen` call fetched, used once by the next matching payment. */
  private readonly preparedAdyen = new Map<
    string,
    { fields: AdyenEncryptedFields; at: number }
  >();
  /** Every client key Adyen's own requests named: frame URLs and paused requests. */
  private readonly adyenClientKeys = new Set<string>();
  /** Re-encrypted payments whose answer is still to come, by inflight key. */
  private readonly adyenResults = new Map<
    string,
    { url: string; sessionId: string; networkId?: string }
  >();
  /**
   * Checkouts, by page, whose Adyen payment answered a 3-D Secure code. The
   * agent completes 3-D Secure; the page's next details call there carries the
   * final code.
   */
  private readonly adyenAwaiting3ds = new Set<string>();
  /** Answers being read, handed to the page and reported; detach() waits for them. */
  private readonly answers = new Set<Promise<void>>();
  /** Counts `prepareAdyen` calls, so only the latest one's answer is kept. */
  private adyenPrepareCalls = 0;
  /** Counts not-enabled answers, so a success begun before one is never used. */
  private adyenDenials = 0;
  private readonly timeoutMs: number;
  private readonly attemptTimeoutMs: number;
  private readonly logger: PayLogger;
  private backlog: InterceptorEvent[] | null = [];
  private buffering = true;
  private closed = false;
  /** Every detach() call waits for the same shutdown. */
  private detaching: Promise<void> | undefined;

  constructor(
    private readonly connection: CdpConnection,
    private readonly options: AttachOptions,
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.attemptTimeoutMs =
      options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
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
      prepareAdyen: (input) => this.prepareAdyen(input),
    };
  }

  private dispatch(event: CdpEvent): void {
    if (event.method === "Fetch.requestPaused") {
      this.onPaused(event);
      return;
    }
    if (this.closed) {
      // Shutdown can wait on a slow report; a new tab must not wait with it.
      if (event.method === "Target.attachedToTarget") this.release(event);
      return;
    }
    if (event.method === "Target.attachedToTarget") this.onAttached(event);
    else if (event.method === "Target.detachedFromTarget")
      this.onDetached(event);
    else if (event.method === "Target.targetInfoChanged") {
      this.onTargetInfoChanged(event);
    } else if (event.method === "Network.requestWillBeSent") {
      this.onRequestWillBeSent(event);
    } else if (event.method === "Network.loadingFailed") {
      this.onLoadingFailed(event);
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
      this.release(event);
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

  /** Lets a target this interceptor will not watch run, then lets go of it. */
  private release(event: CdpEvent): void {
    const params = parseAttachedTarget(event.params);
    if (!params) return;
    const { sessionId } = params;
    void this.resumeIfWaiting(sessionId, params.waitingForDebugger).then(() =>
      this.connection
        .send("Target.detachFromTarget", { sessionId })
        .catch(() => {}),
    );
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
    // A closed page's payments never reach the answer stage.
    for (const [key, watch] of this.adyenResults) {
      if (watch.sessionId === sessionId) this.adyenResults.delete(key);
    }
  }

  private onTargetInfoChanged(event: CdpEvent): void {
    const info = parseTargetInfoChange(event.params);
    if (!info) return;
    const session = this.byTarget.get(info.targetId);
    if (!session) return;
    session.url = info.url;
    this.noteAdyenClientKeys(info.url);
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
    const failure = await armFetch(this.connection, session);
    if (!failure) return true;
    if (this.closed) return false;
    this.logStepFailure("Fetch.enable", failure, session);
    this.emit({
      type: "failed",
      url: session.url,
      reason: "intercept_unavailable",
    });
    await this.swallowStep(
      this.connection.send("Target.closeTarget", {
        targetId: session.targetId,
      }),
      "Target.closeTarget",
      session,
    );
    return false;
  }

  private logStepFailure(
    method: string,
    error: unknown,
    target?: { type: string; url: string },
  ): void {
    if (this.closed) return;
    const failed = error instanceof CdpCommandError ? error : undefined;
    const targetType =
      target?.type === "page" || target?.type === "iframe"
        ? target.type
        : undefined;
    const code = failed?.code;
    this.warn("browser step failed", {
      method,
      ...(code !== undefined ? { code } : {}),
      timedOut: failed?.timedOut ?? false,
      ...(targetType ? { targetType } : {}),
      ...(target ? { origin: eventUrl(target.url, this.number) } : {}),
    });
  }

  private warn(...args: Parameters<PayLogger["warn"]>): void {
    try {
      void Promise.resolve(this.logger.warn(...args)).catch(() => {});
    } catch {
      // A logger must not change control flow.
    }
  }

  private async swallowStep<T>(
    pending: Promise<T>,
    method: string,
    target?: { type: string; url: string },
  ): Promise<T | undefined> {
    try {
      return await pending;
    } catch (error) {
      this.logStepFailure(method, error, target);
      return undefined;
    }
  }

  private async autoAttachChildren(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    await this.swallowStep(
      this.connection.send(
        "Target.setAutoAttach",
        {
          autoAttach: true,
          waitForDebuggerOnStart: true,
          flatten: true,
          filter: CHILD_FILTER,
        },
        sessionId,
      ),
      "Target.setAutoAttach",
      session,
    );
  }

  private async resumeIfWaiting(
    sessionId: string,
    waitingForDebugger: boolean,
  ): Promise<void> {
    if (!waitingForDebugger) return;
    const session = this.sessions.get(sessionId);
    await this.swallowStep(
      this.connection.send("Runtime.runIfWaitingForDebugger", {}, sessionId),
      "Runtime.runIfWaitingForDebugger",
      session,
    );
  }

  private async attachExistingFrames(): Promise<void> {
    const listed = await this.swallowStep(
      this.connection.send("Target.getTargets"),
      "Target.getTargets",
    );
    for (const info of parseTargetInfos(listed)) {
      if (info.type !== "iframe") continue;
      if (this.byTarget.has(info.targetId)) continue;
      const attached = await this.swallowStep(
        this.connection.send("Target.attachToTarget", {
          targetId: info.targetId,
          flatten: true,
        }),
        "Target.attachToTarget",
        { type: info.type, url: info.url },
      );
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
    this.noteAdyenClientKeys(session.url);
    this.sessions.set(session.sessionId, session);
    this.byTarget.set(session.targetId, session);
    return session;
  }

  private onPaused(event: CdpEvent): void {
    const sessionId = event.sessionId;
    const parsed = parsePaused(event.params);
    if (!sessionId || !parsed) return;
    const { requestId, request } = parsed;
    const response = responseStage(event.params);
    if (response) {
      const answer = this.onAdyenResponse(
        sessionId,
        requestId,
        response.status,
      );
      this.answers.add(answer);
      void answer.finally(() => this.answers.delete(answer));
      return;
    }
    if (!this.sessions.has(sessionId)) {
      void failRequest(this.connection, sessionId, requestId);
      this.emit({
        type: "failed",
        url: request.url,
        reason: "unknown_session",
      });
      return;
    }
    this.noteAdyenRequest(request);
    const key = inflightKey(sessionId, requestId);
    if (this.inflight.has(key)) return;
    const entry: Inflight = {
      key,
      sessionId,
      requestId,
      ...(request.networkId ? { networkId: request.networkId } : {}),
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
    try {
      const decision = await this.decide(entry, request);
      await this.apply(entry, request.url, decision);
    } catch {
      await this.settle(entry, "fail");
      this.emit({ type: "failed", url: request.url, reason: "network" });
    }
  }

  private async decide(
    entry: Inflight,
    request: PausedRequest,
  ): Promise<Decision> {
    const read = await this.readHeld(entry.sessionId, request);
    if (read.kind === "unreadable") {
      return { action: "fail", reason: "unreadable_body" };
    }
    if (read.kind === "miss") {
      if (isAdyenSecuredFieldsPayment(read.body)) {
        return this.reencryptAdyen(entry, request, read.body);
      }
      const checkout = adyenDetailsCheckout(request.method, request.url);
      return checkout !== undefined &&
        this.adyenAwaiting3ds.has(
          this.checkoutOnPage(entry.sessionId, checkout),
        )
        ? { action: "awaitAdyenResult" }
        : { action: "continue" };
    }
    if (this.closed) return { action: "fail", reason: "detached" };
    const targetType = this.sessions.get(entry.sessionId)?.type ?? "";
    this.emit({
      type: "paused",
      url: request.url,
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
    const headers = forwardedHeaders(
      request.headers,
      this.options.profileId ? profileHeader : genericHeader,
    );
    if (!headers) return { action: "fail", reason: "headers_unrelayable" };
    return this.awaitRelay(
      request,
      headers,
      read.body,
      pageOrigin,
      idempotencyKey,
    );
  }

  /**
   * Adyen secured fields send only ciphertext of the typed placeholder, so
   * there is nothing to relay. The card vault encrypts the real card to the
   * merchant's Adyen key instead, and the page's own request goes on with
   * those four fields. Any failure fails the request: the placeholder's
   * ciphertext is never sent on.
   */
  private async reencryptAdyen(
    entry: Inflight,
    request: PausedRequest,
    body: string,
  ): Promise<Decision> {
    if (this.closed) return { action: "fail", reason: "detached" };
    this.emit({
      type: "paused",
      url: request.url,
      method: request.method,
      targetType: this.sessions.get(entry.sessionId)?.type ?? "",
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
    if (!this.adyenAllowed()) {
      return { action: "fail", reason: "adyen_not_enabled" };
    }
    const clientKey = this.adyenClientKey();
    if (!clientKey) {
      this.logger.warn(
        this.adyenClientKeys.size > 1
          ? "two different adyen client keys seen in adyen requests"
          : "adyen client key not seen in adyen requests",
      );
      return { action: "fail", reason: "adyen_client_key" };
    }
    const prepared = this.takePreparedAdyen(clientKey, pageOrigin);
    const denials = this.adyenDenials;
    let result: AdyenEncryptResult;
    if (prepared) {
      result = { outcome: "encrypted", fields: prepared };
    } else {
      try {
        result = await this.adyenEncrypt(clientKey, pageOrigin);
      } catch (error) {
        if (this.closed) return { action: "fail", reason: "detached" };
        this.logAdyenFailure(error);
        return { action: "fail", reason: "adyen_encrypt" };
      }
    }
    if (this.closed) return { action: "fail", reason: "detached" };
    if (result.outcome === "not_enabled") {
      this.denyAdyen();
      return { action: "fail", reason: "adyen_not_enabled" };
    }
    // A success that lands after any not-enabled answer is stale: the backend has since said off.
    if (denials !== this.adyenDenials) {
      return { action: "fail", reason: "adyen_not_enabled" };
    }
    // A second key seen while encrypting makes the first choice a guess.
    if (this.adyenClientKey() !== clientKey) {
      this.logger.warn("adyen client key changed during re-encryption");
      return { action: "fail", reason: "adyen_client_key" };
    }
    return {
      action: "reencrypted",
      body: withAdyenEncryptedFields(body, result.fields),
    };
  }

  /** Off when the caller turned it off or the relay cannot encrypt; otherwise the backend decides. */
  private adyenAllowed(): boolean {
    return (
      this.options.disableAdyenEncryption !== true &&
      typeof this.options.relay.adyenEncrypt === "function"
    );
  }

  private async prepareAdyen(input: {
    clientKey: string;
    pageOrigin: string;
  }): Promise<AdyenReadiness> {
    // Any new answer replaces fields an earlier call prepared, so a later "off" is never bypassed.
    const key = preparedKey(input.clientKey, input.pageOrigin);
    this.preparedAdyen.delete(key);
    const call = ++this.adyenPrepareCalls;
    const denials = this.adyenDenials;
    if (this.closed || !this.adyenAllowed()) {
      return { enabled: false, reason: "adyen_not_enabled" };
    }
    if (!isAdyenClientKey(input.clientKey)) {
      return { enabled: false, reason: "adyen_encrypt" };
    }
    if (this.adyenClientKeys.size > 1) {
      this.logger.warn(
        "two different adyen client keys seen in adyen requests",
      );
      return { enabled: false, reason: "adyen_client_key" };
    }
    let result: AdyenEncryptResult;
    try {
      result = await this.adyenEncrypt(input.clientKey, input.pageOrigin);
    } catch (error) {
      this.logAdyenFailure(error);
      return { enabled: false, reason: "adyen_encrypt" };
    }
    if (result.outcome === "not_enabled") {
      this.denyAdyen();
      return { enabled: false, reason: "adyen_not_enabled" };
    }
    // A success that lands after any not-enabled answer is stale: the backend has since said off.
    if (this.closed || denials !== this.adyenDenials) {
      return { enabled: false, reason: "adyen_not_enabled" };
    }
    // A slower, older call must not restore fields a newer call cleared.
    if (call === this.adyenPrepareCalls) {
      this.preparedAdyen.set(key, { fields: result.fields, at: Date.now() });
    }
    return { enabled: true };
  }

  /** The backend's "off" covers every key and origin, so no prepared fields survive it. */
  private denyAdyen(): void {
    this.adyenDenials += 1;
    this.preparedAdyen.clear();
  }

  /** Prepared fields are used once, and only while fresh. */
  private takePreparedAdyen(
    clientKey: string,
    pageOrigin: string,
  ): AdyenEncryptedFields | undefined {
    const key = preparedKey(clientKey, pageOrigin);
    const prepared = this.preparedAdyen.get(key);
    this.preparedAdyen.delete(key);
    if (!prepared || Date.now() - prepared.at > PREPARED_ADYEN_TTL_MS) {
      return undefined;
    }
    return prepared.fields;
  }

  private logAdyenFailure(error: unknown): void {
    this.logger.warn("adyen re-encryption failed", {
      ...(error instanceof RelayHttpError ? { status: error.status } : {}),
      timedOut: isRelayTimeout(error),
    });
  }

  private async adyenEncrypt(
    clientKey: string,
    pageOrigin: string,
  ): Promise<AdyenEncryptResult> {
    const relay = this.options.relay;
    if (typeof relay.adyenEncrypt !== "function") {
      return { outcome: "not_enabled" };
    }
    const encrypt = relay.adyenEncrypt.bind(relay);
    return this.withinAttempt((signal) =>
      encrypt(
        {
          injectionRef: this.options.placeholder.injectionRef,
          clientKey,
          pageOrigin,
        },
        { signal },
      ),
    );
  }

  private async withinAttempt<T>(
    call: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new RelayTimeoutError()),
      this.attemptTimeoutMs,
    );
    try {
      return await failAfter(call(controller.signal), this.attemptTimeoutMs);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The answer to a payment continued with `interceptResponse`. The page gets
   * it unchanged, and before the backend is told: a slow report must not hold
   * the checkout. The body may carry the shopper's details, so only the
   * result code leaves this method.
   */
  private async onAdyenResponse(
    sessionId: string,
    requestId: string,
    status: number | undefined,
  ): Promise<void> {
    const key = inflightKey(sessionId, requestId);
    const url = this.adyenResults.get(key)?.url;
    // Deleting first makes a second answer for the same request pass untouched.
    this.adyenResults.delete(key);
    // A request that failed before any answer has no result to report.
    if (url === undefined || status === undefined) {
      await continueRequest(this.connection, sessionId, requestId);
      return;
    }
    const result = adyenPaymentResult(
      (await readResponseBody(this.connection, sessionId, requestId)) ?? "",
    );
    const checkout = this.checkoutOnPage(
      sessionId,
      adyenCheckout(new URL(url)),
    );
    // Watched before the page gets the answer: its details call can pause
    // before the continue returns. An `unknown` answer (an Adyen error or a
    // non-JSON body) keeps the watch: it is not final, and the page's retried
    // details call may be.
    if (isAdyenActionResult(result.resultCode)) {
      this.adyenAwaiting3ds.add(checkout);
    } else if (result.resultCode !== "unknown") {
      this.adyenAwaiting3ds.delete(checkout);
    }
    await continueRequest(this.connection, sessionId, requestId);
    const reported = await this.reportAdyenResult(result);
    this.emit({
      type: "adyen_result",
      url,
      resultCode: result.resultCode,
      status,
      reported,
    });
  }

  /** A checkout in one tab: its frames share it, other tabs do not. */
  private checkoutOnPage(sessionId: string, checkout: string): string {
    let page = sessionId;
    for (;;) {
      const parent = this.sessions.get(page)?.parentSessionId;
      if (parent === undefined || !this.sessions.has(parent)) break;
      page = parent;
    }
    return `${page} ${checkout}`;
  }

  /** False when the backend did not take the result. Never throws. */
  private async reportAdyenResult(result: {
    resultCode: AdyenResultCode;
    pspReference?: string;
  }): Promise<boolean> {
    const relay = this.options.relay;
    if (typeof relay.adyenResult !== "function") return false;
    const report = relay.adyenResult.bind(relay);
    let answer: AdyenResultResponse;
    try {
      answer = await this.withinAttempt((signal) =>
        report(
          { injectionRef: this.options.placeholder.injectionRef, ...result },
          { signal },
        ),
      );
    } catch (error) {
      this.warn("adyen result report failed", {
        resultCode: result.resultCode,
        ...(error instanceof RelayHttpError ? { status: error.status } : {}),
        timedOut: isRelayTimeout(error),
      });
      return false;
    }
    if (answer.outcome !== "refused") return true;
    this.warn("adyen result report refused", {
      resultCode: result.resultCode,
      status: answer.status,
      code: publicCode(answer.code),
    });
    return false;
  }

  /** Another CDP client can fulfill a request before it pauses here; Network still sees it. */
  /** A payment that failed without pausing at the answer stage has no result. */
  private onLoadingFailed(event: CdpEvent): void {
    const networkId = readStringField(event.params, "requestId");
    if (!networkId) return;
    for (const [key, watch] of this.adyenResults) {
      if (
        watch.sessionId === event.sessionId &&
        watch.networkId === networkId
      ) {
        this.adyenResults.delete(key);
      }
    }
  }

  private onRequestWillBeSent(event: CdpEvent): void {
    const parsed = parsePaused(event.params);
    if (!parsed || !this.sessions.has(event.sessionId ?? "")) return;
    this.noteAdyenRequest(parsed.request);
  }

  private noteAdyenRequest(request: PausedRequest): void {
    this.noteAdyenClientKeys(
      request.url,
      headerValue(request.headers, "x-client-key"),
    );
  }

  private noteAdyenClientKeys(url: string, clientKeyHeader?: string): void {
    for (const key of adyenClientKeysInRequest(url, clientKeyHeader)) {
      this.adyenClientKeys.add(key);
    }
  }

  /** Two different keys give none: the card must not be encrypted to a guess. */
  private adyenClientKey(): string | undefined {
    const keys = this.adyenClientKeys;
    return keys.size === 1 ? [...keys][0] : undefined;
  }

  private async awaitRelay(
    request: PausedRequest,
    headers: Record<string, string>,
    body: string,
    pageOrigin: string,
    idempotencyKey: string,
  ): Promise<Decision> {
    const flight = this.relayOnce(idempotencyKey, (signal) =>
      this.pollRelay(
        request,
        headers,
        body,
        pageOrigin,
        idempotencyKey,
        signal,
      ),
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
    headers: Record<string, string>,
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
      try {
        const response = await this.postAttempt(
          request,
          headers,
          body,
          pageOrigin,
          idempotencyKey,
          signal,
        );
        if (response.outcome === "unknown") {
          this.unknownKeys.add(idempotencyKey);
        }
        if (!isRelayInProgress(response)) return response;
      } catch (error) {
        if (signal.aborted || this.closed || !isRetryableRelayError(error)) {
          throw error;
        }
      }
      poll += 1;
      await sleep(relayPollDelayMs(poll), signal);
    }
  }

  private async postAttempt(
    request: PausedRequest,
    headers: Record<string, string>,
    body: string,
    pageOrigin: string,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<RelayResponse> {
    const attempt = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      attempt.abort(new RelayTimeoutError());
    }, this.attemptTimeoutMs);
    const onAbort = () => {
      clearTimeout(timer);
      attempt.abort(signal.reason);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort);
    try {
      return await this.options.relay.relay(
        {
          injectionRef: this.options.placeholder.injectionRef,
          ...(this.options.profileId && { profileId: this.options.profileId }),
          pageOrigin,
          request: {
            method: request.method,
            url: request.url,
            headers,
            body,
          },
          idempotencyKey,
        },
        { signal: attempt.signal },
      );
    } catch (error) {
      if (timedOut && !signal.aborted) throw new RelayTimeoutError();
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  private async readHeld(
    sessionId: string,
    request: PausedRequest,
  ): Promise<HeldRead> {
    const urlHeld = textHoldsPlaceholderNumber(request.url, this.number);
    if (urlHeld && this.closed) return { kind: "held", body: "" };
    if (postDataPlan(request) === "empty") {
      return urlHeld ? { kind: "held", body: "" } : { kind: "miss", body: "" };
    }
    const body = await readBody(this.connection, sessionId, request);
    if (body === undefined) return { kind: "unreadable" };
    if (urlHeld || textHoldsPlaceholderNumber(body, this.number)) {
      return { kind: "held", body };
    }
    return { kind: "miss", body };
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
      const refusal = publicRefusal(response, this.number);
      this.logRefusalOnce(idempotencyKey, refusal.reason);
      return { action: "refused", refusal };
    }
    if (textHoldsPlaceholderNumber(response.response.body, this.number)) {
      return { action: "fail", reason: "response_credential" };
    }
    return { action: "relayed", response: response.response };
  }

  private logRefusalOnce(idempotencyKey: string, reason: RefusalReason): void {
    if (this.loggedRefusals.has(idempotencyKey)) return;
    this.loggedRefusals.add(idempotencyKey);
    this.logger.warn("payment relay refused the paused request", { reason });
  }

  private async apply(
    entry: Inflight,
    url: string,
    decision: Decision,
  ): Promise<void> {
    if (decision.action === "continue") {
      await this.settle(entry, "continue");
      return;
    }
    if (decision.action === "reencrypted") {
      // Watched before continuing: the answer can pause before the continue returns.
      this.adyenResults.set(entry.key, {
        url,
        sessionId: entry.sessionId,
        ...(entry.networkId ? { networkId: entry.networkId } : {}),
      });
      const continued = await this.settle(entry, {
        continueWith: decision.body,
      });
      if (!continued) this.adyenResults.delete(entry.key);
      this.emit(
        continued
          ? { type: "reencrypted", url }
          : { type: "failed", url, reason: "adyen_encrypt" },
      );
      return;
    }
    if (decision.action === "awaitAdyenResult") {
      this.adyenResults.set(entry.key, {
        url,
        sessionId: entry.sessionId,
        ...(entry.networkId ? { networkId: entry.networkId } : {}),
      });
      const continued = await this.settle(entry, "continueForAnswer");
      if (!continued) this.adyenResults.delete(entry.key);
      return;
    }
    if (decision.action === "fail") {
      await this.settle(entry, "fail");
      this.emit({ type: "failed", url, reason: decision.reason });
      return;
    }
    if (decision.action === "refused") {
      await this.settle(entry, "fail");
      this.emit({ type: "refused", url, ...decision.refusal });
      return;
    }
    const fulfilled = await this.settle(entry, { fulfill: decision.response });
    this.emit(
      fulfilled
        ? { type: "relayed", url, status: decision.response.status }
        : {
            type: "relayed_unfulfilled",
            url,
            status: decision.response.status,
          },
    );
  }

  private async settle(
    entry: Inflight,
    action: SettleAction,
  ): Promise<boolean> {
    if (entry.phase.status !== "open") return false;
    if (
      action === "continue" ||
      action === "continueForAnswer" ||
      (typeof action === "object" && "continueWith" in action)
    ) {
      let continued = true;
      const done = continueRequest(
        this.connection,
        entry.sessionId,
        entry.requestId,
        action === "continue"
          ? undefined
          : action === "continueForAnswer"
            ? { interceptResponse: true }
            : { postData: action.continueWith, interceptResponse: true },
      )
        .then((ok) => {
          continued = ok;
        })
        .finally(() => {
          entry.phase = { status: "done" };
          this.inflight.delete(entry.key);
        });
      entry.phase = { status: "continuing", done };
      await done;
      return continued;
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
    await Promise.all(this.answers);
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

  private detach(): Promise<void> {
    this.detaching ??= this.shutDown();
    return this.detaching;
  }

  private async shutDown(): Promise<void> {
    this.closed = true;
    this.buffering = false;
    this.backlog = null;
    this.preparedAdyen.clear();
    this.adyenResults.clear();
    this.adyenAwaiting3ds.clear();
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

  // Callers pass the raw request URL. It is cut to the origin here, once, so
  // no event leaves with a path, query, or held number.
  private emit(event: InterceptorEvent): void {
    const safe = { ...event, url: eventUrl(event.url, this.number) };
    if (this.buffering && this.backlog) {
      this.backlog.push(safe);
      return;
    }
    for (const listener of this.listeners) this.deliver(listener, safe);
  }

  private deliver(listener: Listener, event: InterceptorEvent): void {
    try {
      listener(event);
    } catch {
      // A listener must not break interception.
    }
  }
}

/**
 * How long fields fetched by `prepareAdyen` wait for the payment. Well inside
 * the time Adyen accepts an encrypted field's `generationtime`.
 */
const PREPARED_ADYEN_TTL_MS = 10 * 60_000;

function preparedKey(clientKey: string, pageOrigin: string): string {
  return `${clientKey}\n${pageOrigin}`;
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

/** Headers of the connection, or set by whoever sends the request on. */
const UNFORWARDED_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** The relay accepts at most this many headers, each name and value within these lengths. */
const MAX_FORWARDED_HEADERS = 32;
const MAX_HEADER_NAME_LENGTH = 128;
const MAX_HEADER_VALUE_LENGTH = 8192;

const ANALYTICS_COOKIE_NAMES = [
  "_ga",
  "_gid",
  "_gat",
  "_fbp",
  "_fbc",
  "_ttp",
  "_clck",
  "_clsk",
];
const ANALYTICS_COOKIE_PREFIXES = [
  "_ga_",
  "_gat_",
  "_gcl_",
  "_hj",
  "_uet",
  "ajs_",
  "amplitude",
  "amp_",
  "mp_",
  "_tt_",
  "_pin_",
];

const profileHeader = (key: string) => FORWARDED_HEADERS.has(key);
const genericHeader = (key: string) =>
  !UNFORWARDED_HEADERS.has(key) &&
  !key.startsWith("sec-fetch-") &&
  !key.startsWith("sec-ch-") &&
  !key.startsWith(":");

/**
 * The headers relayed with a paused request, or `undefined` when the relay
 * can't take every non-cookie header that should go: past its limits, a header
 * would be dropped, and the merchant could refuse the changed request after the card
 * was sent. Which header matters (a CSRF token, an authorization) can't be
 * told from its name, so none is chosen.
 */
function forwardedHeaders(
  raw: unknown,
  forwarded: (key: string) => boolean,
): Record<string, string> | undefined {
  // No prototype: a header named `__proto__` is kept, and one named
  // `constructor` counts toward the limit like any other.
  const out: Record<string, string> = Object.create(null);
  let unrelayable = false;
  let cookie: string | undefined;
  const take = (name: string, value: string) => {
    const key = name.toLowerCase();
    if (!forwarded(key)) return;
    if (key === "cookie") {
      cookie = value;
      return;
    }
    if (
      key.length > MAX_HEADER_NAME_LENGTH ||
      value.length > MAX_HEADER_VALUE_LENGTH ||
      (!(key in out) && Object.keys(out).length >= MAX_FORWARDED_HEADERS)
    ) {
      unrelayable = true;
      return;
    }
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
  } else if (isRecord(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === "string") take(key, value);
    }
  }
  if (unrelayable) return undefined;
  if (cookie !== undefined && Object.keys(out).length < MAX_FORWARDED_HEADERS) {
    if (cookie.length > MAX_HEADER_VALUE_LENGTH) {
      cookie = cookie
        .split(";")
        .map((pair) => pair.trim())
        .filter((pair) => {
          if (!pair) return false;
          const name = pair.split("=", 1)[0].trim();
          return (
            !ANALYTICS_COOKIE_NAMES.includes(name) &&
            !ANALYTICS_COOKIE_PREFIXES.some((prefix) => name.startsWith(prefix))
          );
        })
        .join("; ");
      if (!cookie) return out;
    }
    if (cookie.length <= MAX_HEADER_VALUE_LENGTH) out.cookie = cookie;
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

/**
 * A pause at the Response stage, which only a request continued with
 * `interceptResponse` reaches. `status` is missing when it failed before an
 * answer.
 */
function responseStage(
  params: Record<string, unknown>,
): { status?: number } | undefined {
  const status = params.responseStatusCode;
  if (typeof status === "number") return { status };
  return params.responseErrorReason !== undefined ? {} : undefined;
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
): Promise<Error | undefined> {
  if (session.fetchEnabled) return;
  try {
    await connection
      .send("Network.enable", {}, session.sessionId)
      .catch(() => {});
    await connection.send(
      "Fetch.enable",
      { patterns: [{ urlPattern: "*", requestStage: "Request" }] },
      session.sessionId,
    );
  } catch (error) {
    return error instanceof Error ? error : new Error("CDP command failed");
  }
  session.fetchEnabled = true;
}

/**
 * False when the browser refused to continue and the request was failed
 * instead. With `interceptResponse` this one request pauses again at its
 * answer; every other request stays at the Request stage.
 */
async function continueRequest(
  connection: CdpConnection,
  sessionId: string,
  requestId: string,
  override?: { postData?: string; interceptResponse: boolean },
): Promise<boolean> {
  try {
    await connection.send(
      "Fetch.continueRequest",
      {
        requestId,
        ...(override?.postData !== undefined
          ? {
              postData: Buffer.from(override.postData, "utf8").toString(
                "base64",
              ),
            }
          : {}),
        ...(override ? { interceptResponse: override.interceptResponse } : {}),
      },
      sessionId,
    );
    return true;
  } catch {
    await failRequest(connection, sessionId, requestId);
    return false;
  }
}

async function readResponseBody(
  connection: CdpConnection,
  sessionId: string,
  requestId: string,
): Promise<string | undefined> {
  try {
    const result = await connection.send(
      "Fetch.getResponseBody",
      { requestId },
      sessionId,
    );
    const body = readStringField(result, "body");
    if (body === undefined) return undefined;
    return isRecord(result) && result.base64Encoded === true
      ? Buffer.from(body, "base64").toString("utf8")
      : body;
  } catch {
    return undefined;
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
  const responseHeaders = [
    ...Object.entries(response.headers).flatMap(([name, value]) => {
      if (RESPONSE_HOP.has(name.toLowerCase())) return [];
      return [{ name, value }];
    }),
    ...(response.setCookies ?? []).map((value) => ({
      name: "Set-Cookie",
      value,
    })),
  ];
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

const MAX_TIMER_MS = 2_147_483_647;

function assertPositiveDuration(name: string, value: number | undefined): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMER_MS) {
    throw new Error(`${name} must be a finite positive number`);
  }
}

function assertAttachOptions(options: AttachOptions): void {
  if (typeof options.relay?.relay !== "function") {
    throw new Error("A payment relay is required");
  }
  assertPositiveDuration("timeoutMs", options.timeoutMs);
  assertPositiveDuration("attemptTimeoutMs", options.attemptTimeoutMs);
  if (options.profileId !== undefined && options.profileId.length === 0) {
    throw new Error("profileId must not be empty");
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
    "Pass a CDP URL (ws://, wss://, http:// or https://), or a Puppeteer browser or page. Playwright browsers and pages do not expose wsEndpoint(); pass the URL instead.",
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
