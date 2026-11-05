import { randomUUID } from "node:crypto";
import type { CdpConnection } from "./cdp.js";

export interface VerificationState {
  id: string;
  version: number;
  status:
    | "preparing"
    | "requires_action"
    | "checking"
    | "ended"
    | "expired"
    | "canceled"
    | "error";
  expiresAt: string;
  challengeCaptured: boolean;
  launchClaimed: boolean;
  checkRequested: boolean;
  continuationClaimed: boolean;
  interactionReturned?: boolean;
  nativeReturnAvailable?: boolean;
  nativeReturnProtocol?: "braintree_cardinal";
  merchantOrigin: string;
  total: { amount: string; currency: string };
  actionUrl?: string;
  observation?: {
    outcome: "confirmed" | "failed" | "unknown";
    source: "runner";
    confirmation?: string;
  };
}
export interface NativeReturn {
  protocol: "braintree_cardinal";
  jwt: string;
}
export interface VerificationRunnerReply extends VerificationState {
  nativeReturn?: NativeReturn;
}
export interface VerificationRelayContext {
  frameId?: string;
  url?: string;
}
export interface VerificationTransport {
  register(
    injectionRef: string,
    browserRef: string,
  ): Promise<VerificationState | null>;
  sync(id: string): Promise<VerificationState>;
  report(
    id: string,
    input: Record<string, unknown>,
  ): Promise<VerificationRunnerReply>;
}
export interface VerificationRequest {
  url: string;
  method: string;
  body: string;
  sessionId: string;
  frameId?: string;
  networkId?: string;
}
export interface CheckoutObservation {
  outcome: "confirmed" | "failed" | "unknown";
  cardSession?: string;
  amount: string;
  currency: string;
  confirmation?: string;
}
export interface VerificationAdapter {
  continuation?(): Promise<
    | ((result?: NativeReturn) => Promise<void | { interactionReturned: true }>)
    | null
  >;
  dispose?(): void | Promise<void>;
  inspect(request: VerificationRequest): Promise<
    | "continue"
    | "block"
    | "fallback"
    | {
        capture: {
          url: string;
          body: string;
          nativeReturn?: "braintree_cardinal";
        };
      }
  >;
  relayed(
    response: { body: string },
    sessionId: string,
    context?: VerificationRelayContext,
  ): void;
  reconcile(state: VerificationState): Promise<CheckoutObservation | null>;
}
export interface VerificationHandle {
  current(): VerificationState;
  wait(): Promise<VerificationState>;
}
function isChallengeRequest(
  request: VerificationRequest,
  merchantOrigin: string,
): boolean {
  if (request.method.toUpperCase() !== "POST") return false;
  try {
    if (new URL(request.url).origin === merchantOrigin) return false;
  } catch {
    return false;
  }
  try {
    const body: unknown = JSON.parse(request.body);
    return (
      body !== null &&
      typeof body === "object" &&
      (Object.prototype.hasOwnProperty.call(body, "creq") ||
        ("messageType" in body && body.messageType === "CReq"))
    );
  } catch {
    return new URLSearchParams(request.body).has("creq");
  }
}
export const verificationIsActive = (state: VerificationState) =>
  ["preparing", "requires_action", "checking"].includes(state.status);

/** Fixed-purpose observer on the existing browser; it never creates or closes a browser session. */
export class VerificationSession implements VerificationHandle {
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private closed = false;
  private captureClaimed = false;
  private native = false;
  private nativeReturn?: NativeReturn;
  private nativeAckKey?: string;
  private disposed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly waiters = new Set<(state: VerificationState) => void>();
  private constructor(
    private readonly transport: VerificationTransport,
    private readonly adapter: VerificationAdapter,
    private state: VerificationState,
  ) {}

  /**
   * Register an observer for the existing checkout without creating another browser or credential channel.
   * @param transport The purchase-bound verification transport carried by the existing relay.
   * @param adapter The internal integration that inspects this checkout and reads back its result.
   * @param injectionRef The existing card injection to bind to the observer.
   * @returns Null when unavailable, otherwise a session; only active registrations start a polling timer.
   */
  static async attach(
    transport: VerificationTransport,
    adapter: VerificationAdapter,
    injectionRef: string,
  ) {
    let state;
    try {
      state = await transport.register(injectionRef, randomUUID());
    } catch (error) {
      try {
        await adapter.dispose?.();
      } catch {
        /* Registration failure keeps native checkout in charge. */
      }
      throw error;
    }
    if (!state) {
      try {
        await adapter.dispose?.();
      } catch {
        /* Cleanup cannot disable the ordinary relay. */
      }
      return null;
    }
    const observer = new VerificationSession(transport, adapter, state);
    observer.finish(state);
    if (verificationIsActive(state)) {
      observer.timer = setInterval(() => void observer.tick(), 2000);
      observer.timer.unref?.();
    }
    return observer;
  }
  current() {
    return { ...this.state };
  }
  wait(): Promise<VerificationState> {
    return verificationIsActive(this.state)
      ? new Promise((resolve) => this.waiters.add(resolve))
      : Promise.resolve(this.current());
  }
  /** Inspect checkout traffic while preserving captured and uncertain handoffs during native fallback. */
  async inspect(request: VerificationRequest) {
    if (
      !verificationIsActive(this.state) &&
      !this.captureClaimed &&
      !this.state.challengeCaptured &&
      !this.state.launchClaimed
    )
      this.native = true;
    if (this.native) {
      if (this.state.challengeCaptured || this.state.launchClaimed)
        this.native = false;
      else return "continue" as const;
    }
    let action: Awaited<ReturnType<VerificationAdapter["inspect"]>>;
    try {
      action = await this.adapter.inspect(request);
    } catch {
      // Observation errors leave ordinary traffic alone; an unobserved bank POST stays blocked.
      return isChallengeRequest(request, this.state.merchantOrigin)
        ? ("block" as const)
        : ("continue" as const);
    }
    if (action === "fallback") {
      if (
        this.captureClaimed ||
        this.state.challengeCaptured ||
        this.state.launchClaimed
      )
        return "block" as const;
      this.native = true;
      return "continue" as const;
    }
    if (this.native) return "continue" as const;
    if (typeof action !== "object") return action;
    if (
      this.closed ||
      this.captureClaimed ||
      !verificationIsActive(this.state) ||
      this.state.challengeCaptured ||
      action.capture.url !== request.url ||
      action.capture.body !== request.body
    )
      return "block" as const;
    // Reserve synchronously: an ambiguous capture report must never admit another ACS request.
    this.captureClaimed = true;
    const reported = await this.report(
      { kind: "challenge_observed", capture: action.capture },
      true,
    );
    if (!reported) {
      this.captureClaimed = false;
      this.native = true;
      return "continue" as const;
    }
    return verificationIsActive(this.state) && this.state.challengeCaptured
      ? ("capture" as const)
      : ("block" as const);
  }
  relayed(
    response: { body: string },
    sessionId: string,
    context?: VerificationRelayContext,
  ) {
    try {
      this.adapter.relayed(response, sessionId, context);
    } catch {
      // Observation cannot change the response of a card relay that already happened.
    }
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    const reported = verificationIsActive(this.state)
      ? this.report({ kind: "browser_lost" }).catch(() => {})
      : Promise.resolve();
    this.finish({
      ...this.state,
      status: verificationIsActive(this.state) ? "error" : this.state.status,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      reported,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 1000);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
  }
  /** Serialize reports with stable replay keys, dropping receipts when native checkout takes over. */
  private async report(
    input: Record<string, unknown>,
    capture = false,
    idempotencyKey: string = randomUUID(),
  ) {
    const operation = async () => {
      // A native fallback can win while this receipt waits for earlier reports to finish.
      if (
        input.kind === "checkout_observed" &&
        (this.native || !this.canObserve())
      )
        return false;
      const body = {
        ...input,
        idempotencyKey,
        expectedVersion: this.state.version,
      };
      let ambiguous = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const result = await this.transport.report(this.state.id, body);
          if (
            input.kind === "continuation_started" &&
            result.id === this.state.id &&
            result.version >= this.state.version &&
            verificationIsActive(result) &&
            result.continuationClaimed
          )
            this.nativeReturn = result.nativeReturn;
          this.finish(result);
          if (
            capture &&
            !ambiguous &&
            result.id === this.state.id &&
            result.version >= this.state.version &&
            !verificationIsActive(result) &&
            !result.challengeCaptured &&
            !result.launchClaimed &&
            !this.state.challengeCaptured &&
            !this.state.launchClaimed
          )
            return false;
          return true;
        } catch (error) {
          if (
            error instanceof VerificationHttpError &&
            error.code === "verification_version_conflict"
          ) {
            this.finish(await this.transport.sync(this.state.id));
            body.expectedVersion = this.state.version;
            if (
              attempt === 2 &&
              capture &&
              !ambiguous &&
              error.status >= 400 &&
              error.status < 500 &&
              !this.state.challengeCaptured &&
              !this.state.launchClaimed
            )
              return false;
          } else if (
            error instanceof VerificationHttpError &&
            error.status < 500
          ) {
            if (input.kind === "interaction_resumed" && error.status !== 429)
              return false;
            if (
              capture &&
              !ambiguous &&
              error.status >= 400 &&
              !this.state.challengeCaptured &&
              !this.state.launchClaimed
            )
              return false;
            throw error;
          } else ambiguous = true;
          if (attempt === 2)
            throw new Error("Purchase verification report failed");
        }
      }
    };
    const pending = this.queue.then(operation);
    this.queue = pending.catch(() => {});
    return pending;
  }
  /** Synchronize durable state and discard reconciliation when the checkout returns to native handling. */
  private async acknowledgeNativeReturn() {
    await this.report(
      { kind: "interaction_resumed" },
      false,
      this.nativeAckKey,
    );
    this.nativeAckKey = undefined;
  }
  private async tick() {
    // Check expiry before the in-flight guard, including when an adapter never settles.
    if (!this.canObserve() || this.ticking) return;
    this.ticking = true;
    try {
      await this.queue;
      if (!this.canObserve()) return;
      const synced = await this.transport.sync(this.state.id);
      if (!this.canObserve()) return;
      this.finish(synced);
      if (this.canObserve() && !this.native) {
        if (this.nativeAckKey) await this.acknowledgeNativeReturn();
        if (!this.canObserve()) return;
        const observation = await this.adapter.reconcile(this.state);
        if (!this.canObserve() || this.native) return;
        if (observation && observation.outcome !== "unknown")
          await this.report({ kind: "checkout_observed", observation });
        else if (this.state.launchClaimed && !this.state.continuationClaimed) {
          const resume = await this.adapter.continuation?.();
          if (!this.canObserve()) return;
          if (resume) {
            await this.report({ kind: "continuation_started" });
            if (this.canObserve() && this.state.continuationClaimed) {
              const result = this.nativeReturn;
              this.nativeReturn = undefined;
              let acknowledged;
              try {
                acknowledged = await resume(result);
              } catch {
                if (this.canObserve())
                  await this.report({ kind: "continuation_failed" });
                return;
              }
              if (this.canObserve() && acknowledged?.interactionReturned) {
                this.nativeAckKey = randomUUID();
                await this.acknowledgeNativeReturn();
              }
            }
          }
        }
      }
    } catch {
      this.canObserve();
    } finally {
      this.ticking = false;
    }
  }
  private canObserve() {
    if (
      !this.closed &&
      verificationIsActive(this.state) &&
      Date.now() >= Date.parse(this.state.expiresAt)
    )
      this.finish({ ...this.state, status: "expired" });
    return !this.closed && verificationIsActive(this.state);
  }
  private finish(state: VerificationState) {
    if (state.id !== this.state.id || state.version < this.state.version)
      return;
    if (!verificationIsActive(this.state) && verificationIsActive(state))
      return;
    // Sensitive native material never reaches current(), wait(), transaction reads or caller logs.
    const safeState = { ...state } as VerificationRunnerReply;
    delete safeState.nativeReturn;
    this.state =
      this.closed && verificationIsActive(state)
        ? { ...safeState, status: "error" }
        : safeState;
    if (!verificationIsActive(state)) {
      this.nativeReturn = undefined;
      if (!this.disposed) {
        this.disposed = true;
        try {
          Promise.resolve(this.adapter.dispose?.()).catch(() => {});
        } catch {
          /* Cleanup cannot change a terminal observation. */
        }
      }
      if (this.timer) clearInterval(this.timer);
      for (const resolve of this.waiters) resolve(this.current());
      this.waiters.clear();
    }
  }
}

export class VerificationHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super("Purchase verification request failed");
  }
}

/** The caller supplies the existing relay's credential-safe POST, not another credential channel. */
export function verificationTransport(
  post: (suffix: string, body: unknown) => Promise<Response>,
): VerificationTransport {
  const read = async (
    suffix: string,
    body: unknown,
    registering = false,
  ): Promise<VerificationRunnerReply | null> => {
    const response = await post(suffix, body);
    if (registering && response.status === 404) {
      await response.arrayBuffer().catch(() => {});
      return null;
    }
    let data: any;
    try {
      data = await response.json();
    } catch {
      throw new Error("Unreadable purchase verification response");
    }
    if (
      registering &&
      response.status === 503 &&
      data?.code === "verification_unavailable"
    )
      return null;
    if (!response.ok)
      throw new VerificationHttpError(
        response.status,
        typeof data?.code === "string" ? data.code : "verification_error",
      );
    if (
      !data ||
      typeof data.id !== "string" ||
      !Number.isInteger(data.version) ||
      ![
        "preparing",
        "requires_action",
        "checking",
        "ended",
        "expired",
        "canceled",
        "error",
      ].includes(data.status) ||
      !Number.isFinite(Date.parse(data.expiresAt)) ||
      typeof data.merchantOrigin !== "string" ||
      typeof data.total?.amount !== "string" ||
      typeof data.total?.currency !== "string" ||
      ![
        data.challengeCaptured,
        data.launchClaimed,
        data.checkRequested,
        data.continuationClaimed,
      ].every((v) => typeof v === "boolean")
    ) {
      throw new Error("Unreadable purchase verification response");
    }
    if (
      [data.interactionReturned, data.nativeReturnAvailable].some(
        (value) => value !== undefined && typeof value !== "boolean",
      )
    )
      throw new Error("Unreadable purchase verification response");
    if (
      data.nativeReturnProtocol !== undefined &&
      data.nativeReturnProtocol !== "braintree_cardinal"
    )
      throw new Error("Unreadable purchase verification response");
    if (
      data.nativeReturn !== undefined &&
      (!(
        suffix.endsWith("/reports") &&
        (body as Record<string, unknown>)?.kind === "continuation_started"
      ) ||
        data.nativeReturn?.protocol !== "braintree_cardinal" ||
        typeof data.nativeReturn.jwt !== "string" ||
        data.nativeReturn.jwt.length > 16384 ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(
          data.nativeReturn.jwt,
        ))
    )
      throw new Error("Unreadable purchase verification response");
    return data as VerificationRunnerReply;
  };
  return {
    register: (injectionRef, browserRef) =>
      read("", { injectionRef, browserRef }, true),
    sync: async (id) => (await read(`/${encodeURIComponent(id)}/sync`, {}))!,
    report: async (id, input) =>
      (await read(`/${encodeURIComponent(id)}/reports`, input))!,
  };
}

export type VerificationAdapterFactory = (
  connection: CdpConnection,
  state: () => VerificationState | undefined,
) => VerificationAdapter;
