import {
  ADYEN_BLOB_BINDING,
  adyenBlobWatchScript,
  hashObservedBlob,
  placeholderBlobHashes,
  type AdyenEncryptedField,
} from "./adyen-blobs.js";
import { CdpCommandError, CdpConnection, type CdpEvent } from "./cdp.js";
import {
  isAdyenActionResult,
  paymentIdempotencyKey,
  type AdyenResultCode,
  type AdyenResultResponse,
  type RelayedHttpResponse,
  type RelayRequest,
  type RelayResponse,
} from "./contract.js";
import {
  ADYEN_CHECKOUT_ORIGINS,
  adyenCheckout,
  adyenClientKeysInRequest,
  adyenDetailsCall,
  adyenPaymentResult,
  isAdyenSecuredFieldsPayment,
  redactHeld,
  textHoldsPlaceholderNumber,
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
  | "destination_not_allowed"
  | "adyen_client_key"
  | "adyen_placeholder_unobserved";

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
  /**
   * Adyen's final answer after 3-D Secure on a merchant's own
   * `/payments/details`, which the relay cannot see. `status` is the page's
   * HTTP status; `reported` is false when the backend did not take it.
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

export interface InterceptorHandle {
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

interface AdyenChallenge {
  readonly clientKey: string;
}

type Decision =
  | { action: "continue" }
  | { action: "awaitAdyenResult"; challenge: AdyenChallenge }
  | { action: "fail"; reason: FailureReason }
  | { action: "refused"; refusal: PublicRefusal }
  | { action: "relayed"; response: RelayedHttpResponse };

type SettleAction =
  | "continue"
  | "continueForAnswer"
  | "fail"
  | { fulfill: RelayedHttpResponse };

interface AdyenDetailsWatch {
  url: string;
  sessionId: string;
  challenge: AdyenChallenge;
  redirectNetworkId?: string;
}

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
  /** Every client key Adyen's own requests named: frame URLs and paused requests. */
  private readonly adyenClientKeys = new Set<string>();
  /**
   * Open 3-D Secure challenges, by page session and checkout: each relayed
   * payment answering a 3-D Secure code adds one, and a details call's final
   * code closes its admitted challenge. Merchant routes on one origin share
   * a checkout key; a stale answer must not close a newer challenge.
   */
  private readonly adyenAwaiting3ds = new Map<
    string,
    Map<string, Set<AdyenChallenge>>
  >();
  /** Merchant `/payments/details` calls whose answer is still to come, by inflight key. */
  private readonly adyenDetailsWatches = new Map<string, AdyenDetailsWatch>();
  /** Answers being read, handed to the page and reported; detach() waits for them. */
  private readonly answers = new Set<Promise<void>>();
  /** Latest sha256 hex per field the page's secured fields encrypted. Never the blob. */
  private readonly adyenBlobHashes = new Map<AdyenEncryptedField, string>();
  private readonly timeoutMs: number;
  private readonly attemptTimeoutMs: number;
  private readonly logger: PayLogger;
  private backlog: InterceptorEvent[] | null = [];
  private buffering = true;
  private closed = false;

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
    } else if (event.method === "Network.requestWillBeSent") {
      this.onRequestWillBeSent(event);
    } else if (
      event.method === "Network.loadingFinished" ||
      event.method === "Network.loadingFailed"
    ) {
      this.onNetworkCompletion(event);
    } else if (event.method === "Runtime.bindingCalled") {
      this.onBindingCalled(event);
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
    for (const [key, watch] of this.adyenDetailsWatches) {
      if (watch.sessionId === sessionId) this.adyenDetailsWatches.delete(key);
    }
    this.adyenAwaiting3ds.delete(sessionId);
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
    await this.watchAdyenBlobs(session, waitingForDebugger);
    await this.resumeIfWaiting(sessionId, waitingForDebugger);
  }

  /**
   * Installs the passive secured-fields listener before the target runs, and
   * in the current document when the target was already running. A target
   * where this fails cannot supply the hashes, so its Adyen Pay fails closed.
   */
  private async watchAdyenBlobs(
    session: Session,
    waitingForDebugger: boolean,
  ): Promise<void> {
    const { sessionId } = session;
    const script = adyenBlobWatchScript();
    // Runtime.enable reports existing contexts, including same-target frames
    // that Page's new-document hook cannot reach retroactively.
    const contexts = new Set<number>();
    const stopCollecting = this.connection.onEvent((event) => {
      if (event.sessionId !== sessionId || !isRecord(event.params)) return;
      if (event.method === "Runtime.executionContextCreated") {
        const context = event.params.context;
        if (
          isRecord(context) &&
          typeof context.id === "number" &&
          isRecord(context.auxData) &&
          context.auxData.isDefault === true
        ) {
          contexts.add(context.id);
        }
      } else if (event.method === "Runtime.executionContextDestroyed") {
        if (typeof event.params.executionContextId === "number") {
          contexts.delete(event.params.executionContextId);
        }
      } else if (event.method === "Runtime.executionContextsCleared") {
        contexts.clear();
      }
    });
    try {
      // Chromium runs new-document scripts only with Page enabled, and installs
      // a binding in new contexts and reports its calls only with Runtime
      // enabled (checked on headless Chromium; either alone observes nothing).
      for (const method of ["Page.enable", "Runtime.enable"]) {
        await this.swallowStep(
          this.connection.send(method, {}, sessionId),
          method,
          session,
        );
      }
      await this.swallowStep(
        this.connection.send(
          "Runtime.addBinding",
          { name: ADYEN_BLOB_BINDING },
          sessionId,
        ),
        "Runtime.addBinding",
        session,
      );
      await this.swallowStep(
        this.connection.send(
          "Page.addScriptToEvaluateOnNewDocument",
          { source: script },
          sessionId,
        ),
        "Page.addScriptToEvaluateOnNewDocument",
        session,
      );
      if (contexts.size === 0 && !waitingForDebugger) {
        await this.swallowStep(
          this.connection.send(
            "Runtime.evaluate",
            { expression: script, returnByValue: true },
            sessionId,
          ),
          "Runtime.evaluate",
          session,
        );
      }
      for (const contextId of contexts) {
        await this.swallowStep(
          this.connection.send(
            "Runtime.evaluate",
            { expression: script, contextId, returnByValue: true },
            sessionId,
          ),
          "Runtime.evaluate",
          session,
        );
      }
    } finally {
      stopCollecting();
    }
  }

  private onBindingCalled(event: CdpEvent): void {
    if (!this.sessions.has(event.sessionId ?? "")) return;
    if (!isRecord(event.params)) return;
    if (event.params.name !== ADYEN_BLOB_BINDING) return;
    const observed = hashObservedBlob(event.params.payload);
    if (observed) this.adyenBlobHashes.set(observed.field, observed.hash);
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
    try {
      void Promise.resolve(
        this.logger.warn("browser step failed", {
          method,
          ...(code !== undefined ? { code } : {}),
          timedOut: failed?.timedOut ?? false,
          ...(targetType ? { targetType } : {}),
          ...(target ? { origin: eventUrl(target.url, this.number) } : {}),
        }),
      ).catch(() => {});
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
    const frames = parseTargetInfos(listed).filter(
      (info) => info.type === "iframe" && !this.byTarget.has(info.targetId),
    );
    const parents = new Map<string, string>();
    const pages = [...this.sessions.values()].filter(
      (session) => session.type === "page",
    );
    // Root-level recovery loses the attaching parent's session. CDP frame ids
    // identify iframe targets in the owning page's tree, including nested ones.
    if (frames.length > 0 && pages.length > 1) {
      for (const page of pages) {
        const tree = await this.swallowStep(
          this.connection.send("Page.getFrameTree", {}, page.sessionId),
          "Page.getFrameTree",
          page,
        );
        for (const frame of frames) {
          if (
            isRecord(tree) &&
            frameTreeContains(tree.frameTree, frame.targetId)
          ) {
            parents.set(frame.targetId, page.sessionId);
          }
        }
      }
    }
    for (const info of frames) {
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
      const parentSessionId =
        parents.get(info.targetId) ??
        (pages.length === 1 ? pages[0].sessionId : undefined);
      const session = this.trackSession({
        sessionId,
        targetId: info.targetId,
        type: "iframe",
        url: info.url,
        fetchEnabled: false,
        ...(parentSessionId ? { parentSessionId } : {}),
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
      const answer = this.onDetailsAnswer(
        sessionId,
        requestId,
        response.status,
        response.redirect,
        request.networkId,
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
    const redirectedRequestId = readStringField(
      event.params,
      "redirectedRequestId",
    );
    const previousKey = redirectedRequestId
      ? inflightKey(sessionId, redirectedRequestId)
      : undefined;
    const watch = previousKey
      ? this.adyenDetailsWatches.get(previousKey)
      : undefined;
    if (watch && previousKey) {
      this.adyenDetailsWatches.delete(previousKey);
      delete watch.redirectNetworkId;
    }
    const redirectWatch =
      watch && isPageOrigin(request.url, new URL(watch.url).origin)
        ? watch
        : undefined;
    this.noteAdyenRequest(request);
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
      !redirectWatch &&
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
    void this.handlePaused(entry, request, redirectWatch);
  }

  private async handlePaused(
    entry: Inflight,
    request: PausedRequest,
    redirectWatch?: AdyenDetailsWatch,
  ): Promise<void> {
    try {
      const decision = await this.decide(entry, request, redirectWatch);
      if (redirectWatch && decision.action === "continue") {
        this.adyenDetailsWatches.set(entry.key, redirectWatch);
        const continued = await this.settle(entry, "continueForAnswer");
        if (!continued) this.adyenDetailsWatches.delete(entry.key);
      } else {
        await this.apply(entry, request.url, decision);
      }
    } catch {
      await this.settle(entry, "fail");
      this.emit({ type: "failed", url: request.url, reason: "network" });
    }
  }

  private async decide(
    entry: Inflight,
    request: PausedRequest,
    redirectWatch?: AdyenDetailsWatch,
  ): Promise<Decision> {
    const read = await this.readHeld(entry.sessionId, request);
    if (read.kind === "unreadable") {
      return { action: "fail", reason: "unreadable_body" };
    }
    const adyen =
      read.kind === "miss" && isAdyenSecuredFieldsPayment(read.body);
    // A watched redirect already belongs to its original challenge.
    const details =
      read.kind === "miss" && !adyen && !redirectWatch
        ? this.openDetailsCall(entry.sessionId, request)
        : undefined;
    if (details && !details.relay) {
      return { action: "awaitAdyenResult", challenge: details.challenge };
    }
    if (read.kind === "miss" && !adyen && !details) {
      return { action: "continue" };
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
    let challenge = details?.challenge;
    let route: Pick<RelayRequest, "profileId" | "adyen">;
    let forwarded = this.options.profileId ? profileHeader : genericHeader;
    if (adyen || details) {
      const clientKey = details?.challenge.clientKey ?? this.adyenClientKey();
      if (!clientKey) {
        this.logger.warn(
          this.adyenClientKeys.size > 1
            ? "two different adyen client keys seen in adyen requests"
            : "adyen client key not seen in adyen requests",
        );
        return { action: "fail", reason: "adyen_client_key" };
      }
      if (details) {
        const explicitKeys = new URL(request.url).searchParams.getAll(
          "clientKey",
        );
        const headerKey = headerValue(request.headers, "x-client-key");
        if (headerKey) explicitKeys.push(headerKey);
        if (explicitKeys.some((key) => key !== clientKey)) {
          return { action: "fail", reason: "adyen_client_key" };
        }
      }
      challenge ??= { clientKey };
      route = { profileId: ADYEN_CHECKOUT_PROFILE, adyen: { clientKey } };
      // Only a Pay carries the page's card blobs; a details call has none.
      if (adyen) {
        // A Pay is relayed only to the page's own origin or Adyen's sessions
        // payments endpoint; any other destination is refused here.
        if (
          request.method.toUpperCase() !== "POST" ||
          (!isPageOrigin(request.url, pageOrigin) &&
            !isAdyenCheckoutDestination(request.url, clientKey))
        ) {
          return { action: "fail", reason: "destination_not_allowed" };
        }
        const blobs = placeholderBlobHashes(this.adyenBlobHashes);
        if ("missing" in blobs) {
          this.logger.warn("adyen placeholder blobs not observed", {
            missing: blobs.missing.join(","),
          });
          return { action: "fail", reason: "adyen_placeholder_unobserved" };
        }
        route.adyen = { clientKey, placeholderBlobHashes: blobs.hashes };
      }
      // The merchant's own endpoint may need the page's session cookie or a
      // CSRF header; Adyen's endpoints must never see them.
      forwarded = isPageOrigin(request.url, pageOrigin)
        ? genericHeader
        : adyenHeader;
    } else if (this.options.profileId) {
      route = { profileId: this.options.profileId };
    } else {
      route = {};
    }
    const idempotencyKey = paymentIdempotencyKey(
      request.method,
      request.url,
      read.body,
    );
    if (this.unknownKeys.has(idempotencyKey)) {
      return { action: "fail", reason: "unknown" };
    }
    const headers = forwardedHeaders(request.headers, forwarded);
    if (!headers) return { action: "fail", reason: "headers_unrelayable" };
    // Adyen checks the Origin a client key is allowed for; CDP can omit it.
    if (adyen || details) headers.origin ??= pageOrigin;
    // Resolved before the relay answers, while the frame still knows its tab.
    const page = this.pageOf(entry.sessionId);
    const decision = await this.awaitRelay({
      injectionRef: this.options.placeholder.injectionRef,
      ...route,
      pageOrigin,
      request: {
        method: request.method,
        url: request.url,
        headers,
        body: read.body,
      },
      idempotencyKey,
    });
    if (challenge && decision.action === "relayed") {
      // Counted before the page gets the answer: its details call can pause
      // before the fulfil returns.
      this.track3ds(
        page,
        details?.checkout ?? adyenCheckout(new URL(request.url)),
        adyenPaymentResult(decision.response.body).resultCode,
        challenge,
        adyen,
      );
    }
    return decision;
  }

  /**
   * A details call the page sends for a 3-D Secure challenge this tab opened
   * on the same checkout, or `undefined`. Nothing new is watched once
   * detach() starts.
   */
  private openDetailsCall(
    sessionId: string,
    request: PausedRequest,
  ):
    | { checkout: string; relay: boolean; challenge: AdyenChallenge }
    | undefined {
    if (this.closed) return undefined;
    const call = adyenDetailsCall(request.method, request.url);
    if (!call) return undefined;
    const challenge = this.adyenAwaiting3ds
      .get(this.pageOf(sessionId))
      ?.get(call.checkout)
      ?.values()
      .next().value;
    return challenge === undefined ? undefined : { ...call, challenge };
  }

  /**
   * A payment's 3-D Secure code opens a challenge; a details answer's final
   * code closes one. A details answer with another action code continues its
   * challenge. Non-final or unknown answers change nothing: the page's
   * retried details call may be final. A final code on a payment had no
   * challenge to close.
   */
  private track3ds(
    page: string,
    checkout: string,
    resultCode: AdyenResultCode,
    challenge: AdyenChallenge,
    opening = false,
  ): void {
    const awaiting = this.adyenAwaiting3ds.get(page);
    const open = awaiting?.get(checkout);
    if (isAdyenActionResult(resultCode)) {
      if (opening && !this.closed && this.sessions.has(page)) {
        this.adyenAwaiting3ds.set(
          page,
          (awaiting ?? new Map<string, Set<AdyenChallenge>>()).set(
            checkout,
            (open ?? new Set<AdyenChallenge>()).add(challenge),
          ),
        );
      }
    } else if (!opening && isFinalAdyenResult(resultCode)) {
      open?.delete(challenge);
      if (open?.size === 0) awaiting?.delete(checkout);
    }
  }

  /**
   * The answer to a merchant `/payments/details` call continued with
   * `interceptResponse`. The page gets it unchanged, before the backend is
   * told: a slow report must not hold the checkout. Only a final code is
   * reported, once per challenge. The body may carry the shopper's details,
   * so only the result code leaves this method.
   */
  private async onDetailsAnswer(
    sessionId: string,
    requestId: string,
    status: number | undefined,
    redirect = false,
    networkId?: string,
  ): Promise<void> {
    const key = inflightKey(sessionId, requestId);
    const watch = this.adyenDetailsWatches.get(key);
    if (watch && redirect) {
      // The next Fetch request claims this watch; completion without one expires it.
      watch.redirectNetworkId = networkId;
      const continued = await continueRequest(
        this.connection,
        sessionId,
        requestId,
      );
      if (!continued) this.adyenDetailsWatches.delete(key);
      return;
    }
    // Deleting first makes a second answer for the same request pass untouched.
    this.adyenDetailsWatches.delete(key);
    // A request that failed before any answer has no result to report.
    if (watch === undefined || status === undefined) {
      await continueRequest(this.connection, sessionId, requestId);
      return;
    }
    const page = this.pageOf(sessionId);
    const result = adyenPaymentResult(
      (await readResponseBody(this.connection, sessionId, requestId)) ?? "",
    );
    const checkout = adyenCheckout(new URL(watch.url));
    const open = this.adyenAwaiting3ds.get(page)?.get(checkout);
    const final =
      open?.has(watch.challenge) && isFinalAdyenResult(result.resultCode);
    this.track3ds(page, checkout, result.resultCode, watch.challenge);
    await continueRequest(this.connection, sessionId, requestId);
    // Another details answer may already have closed this admitted challenge.
    if (!final) return;
    const reported = await this.reportAdyenResult(result);
    this.emit({
      type: "adyen_result",
      url: watch.url,
      resultCode: result.resultCode,
      status,
      reported,
    });
  }

  /** The tab a session belongs to: its frames share it, other tabs do not. */
  private pageOf(sessionId: string): string {
    return topPageSession(this.sessions, sessionId) ?? sessionId;
  }

  /** False when the backend did not take the result. Never throws. */
  private async reportAdyenResult(result: {
    resultCode: AdyenResultCode;
    pspReference?: string;
  }): Promise<boolean> {
    const relay = this.options.relay;
    if (typeof relay.adyenResult !== "function") return false;
    const report = relay.adyenResult.bind(relay);
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new RelayTimeoutError()),
      this.attemptTimeoutMs,
    );
    let answer: AdyenResultResponse;
    try {
      answer = await failAfter(
        report(
          { injectionRef: this.options.placeholder.injectionRef, ...result },
          { signal: controller.signal },
        ),
        this.attemptTimeoutMs,
      );
    } catch (error) {
      this.warn("adyen result report failed", {
        resultCode: result.resultCode,
        ...(error instanceof RelayHttpError ? { status: error.status } : {}),
        timedOut: isRelayTimeout(error),
      });
      return false;
    } finally {
      clearTimeout(timer);
    }
    if (answer.outcome !== "refused") return answer.outcome !== "pending";
    this.warn("adyen result report refused", {
      resultCode: result.resultCode,
      status: answer.status,
      code: REASON_SHAPE.test(answer.code.toLowerCase())
        ? answer.code
        : "unrecognized",
    });
    return false;
  }

  /** A logger must not change control flow. */
  private warn(...args: Parameters<PayLogger["warn"]>): void {
    try {
      void Promise.resolve(this.logger.warn(...args)).catch(() => {});
    } catch {
      // Ignored on purpose.
    }
  }

  /** Another CDP client can fulfill a request before it pauses here; Network still sees it. */
  private onRequestWillBeSent(event: CdpEvent): void {
    const parsed = parsePaused(event.params);
    if (!parsed || !this.sessions.has(event.sessionId ?? "")) return;
    this.noteAdyenRequest(parsed.request);
  }

  private onNetworkCompletion(event: CdpEvent): void {
    const requestId = readStringField(event.params, "requestId");
    if (!requestId) return;
    for (const [key, watch] of this.adyenDetailsWatches) {
      if (
        watch.sessionId === event.sessionId &&
        watch.redirectNetworkId === requestId
      ) {
        this.adyenDetailsWatches.delete(key);
      }
    }
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

  private async awaitRelay(relayRequest: RelayRequest): Promise<Decision> {
    const { idempotencyKey } = relayRequest;
    const flight = this.relayOnce(idempotencyKey, (signal) =>
      this.pollRelay(relayRequest, signal),
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
    relayRequest: RelayRequest,
    signal: AbortSignal,
  ): Promise<RelayResponse> {
    const { idempotencyKey } = relayRequest;
    let poll = 0;
    for (;;) {
      if (signal.aborted || this.closed) throw abortError(signal);
      if (this.unknownKeys.has(idempotencyKey)) {
        return { outcome: "unknown" };
      }
      try {
        const response = await this.postAttempt(relayRequest, signal);
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
    relayRequest: RelayRequest,
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
      return await this.options.relay.relay(relayRequest, {
        signal: attempt.signal,
      });
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
    if (decision.action === "awaitAdyenResult") {
      this.adyenDetailsWatches.set(entry.key, {
        url,
        sessionId: entry.sessionId,
        challenge: decision.challenge,
      });
      const continued = await this.settle(entry, "continueForAnswer");
      if (!continued) this.adyenDetailsWatches.delete(entry.key);
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
    if (action === "continue" || action === "continueForAnswer") {
      let continued = true;
      const done = continueRequest(
        this.connection,
        entry.sessionId,
        entry.requestId,
        action === "continueForAnswer",
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

  private async detach(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.buffering = false;
    this.backlog = null;
    this.adyenDetailsWatches.clear();
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
 * The relay profile for an Adyen secured-fields payment, whatever profile the
 * attach names: the relay encrypts the real card to the page's client key.
 */
const ADYEN_CHECKOUT_PROFILE = "adyen-checkout";

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

function frameTreeContains(tree: unknown, targetId: string): boolean {
  if (!isRecord(tree)) return false;
  if (isRecord(tree.frame) && tree.frame.id === targetId) return true;
  return (
    Array.isArray(tree.childFrames) &&
    tree.childFrames.some((child) => frameTreeContains(child, targetId))
  );
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
const adyenHeader = (key: string) =>
  key === "accept" || key === "content-type" || key === "origin";
const genericHeader = (key: string) =>
  !UNFORWARDED_HEADERS.has(key) &&
  !key.startsWith("sec-fetch-") &&
  !key.startsWith("sec-ch-") &&
  !key.startsWith(":");

function isPageOrigin(url: string, pageOrigin: string): boolean {
  try {
    return new URL(url).origin === pageOrigin;
  } catch {
    return false;
  }
}

/** Keep sessions destinations aligned with the relay's adyen-checkout profile. */
function isAdyenCheckoutDestination(url: string, clientKey: string): boolean {
  try {
    const parsed = new URL(url);
    const testHost = parsed.hostname === "checkoutshopper-test.adyen.com";
    return (
      parsed.protocol === "https:" &&
      !parsed.username &&
      !parsed.password &&
      !parsed.hash &&
      ADYEN_CHECKOUT_ORIGINS.includes(`https://${parsed.hostname}`) &&
      testHost === clientKey.startsWith("test_") &&
      /^\/checkoutshopper\/v\d+\/sessions\/[A-Za-z0-9_-]+\/payments$/.test(
        parsed.pathname,
      )
    );
  } catch {
    return false;
  }
}

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
  interceptResponse = false,
): Promise<boolean> {
  try {
    await connection.send(
      "Fetch.continueRequest",
      { requestId, ...(interceptResponse ? { interceptResponse } : {}) },
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

function isFinalAdyenResult(code: AdyenResultCode): boolean {
  return ["Authorised", "Refused", "Error", "Cancelled"].includes(code);
}

/**
 * A pause at the Response stage, which only a request continued with
 * `interceptResponse` reaches. `status` is missing when it failed before an
 * answer.
 */
function responseStage(
  params: Record<string, unknown>,
): { status?: number; redirect?: boolean } | undefined {
  const status = params.responseStatusCode;
  if (typeof status === "number") {
    return {
      status,
      redirect:
        [301, 302, 303, 307, 308].includes(status) &&
        headerValue(params.responseHeaders, "location").length > 0,
    };
  }
  return params.responseErrorReason !== undefined ? {} : undefined;
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
