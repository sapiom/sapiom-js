import { randomUUID } from "node:crypto";
import { isRecord } from "./guards.js";
import type {
  VerificationState,
  NativeReturn,
  VerificationRunnerReply,
  VerificationRunner,
  VerificationAdapter,
  VerificationHandle,
  VerificationRequest,
  VerificationRelayContext,
} from "./verification-types.js";

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
const verificationIsActive = (state: VerificationState) =>
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
    private readonly runner: VerificationRunner,
    private readonly adapter: VerificationAdapter,
    private state: VerificationState,
  ) {}

  static attach(
    runner: VerificationRunner,
    adapter: VerificationAdapter,
    initial: VerificationState,
  ) {
    const state = validated(initial);
    const observer = new VerificationSession(runner, adapter, state);
    observer.finish(state);
    if (observer.canObserve()) {
      observer.timer = setInterval(() => void observer.tick(), 2000);
      observer.timer.unref?.();
    }
    return observer;
  }
  current(): VerificationState {
    return structuredClone(this.state);
  }
  submissionBlocked() {
    return (
      this.captureClaimed ||
      this.state.challengeCaptured ||
      this.state.launchClaimed
    );
  }
  wait(): Promise<VerificationState> {
    return verificationIsActive(this.state)
      ? new Promise((resolve) => this.waiters.add(resolve))
      : Promise.resolve(this.current());
  }
  /** Inspect checkout traffic while preserving captured and uncertain handoffs during native fallback. */
  async inspect(request: VerificationRequest, signal?: AbortSignal) {
    this.canObserve();
    if (!verificationIsActive(this.state)) {
      return this.submissionBlocked() &&
        isChallengeRequest(request, this.state.merchantOrigin)
        ? ("block" as const)
        : ("continue" as const);
    }
    if (this.native) {
      if (this.submissionBlocked()) this.native = false;
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
    if (signal?.aborted) return "continue" as const;
    if (action === "fallback") return this.fallback();
    if (this.native && !this.submissionBlocked()) return "continue" as const;
    if (typeof action !== "object")
      return action === "continue" &&
        request.method.toUpperCase() === "POST" &&
        this.submissionBlocked() &&
        (!this.state.interactionReturned ||
          isChallengeRequest(request, this.state.merchantOrigin))
        ? ("block" as const)
        : action;
    if (
      this.closed ||
      this.captureClaimed ||
      !verificationIsActive(this.state) ||
      this.state.challengeCaptured ||
      action.capture.url !== request.url ||
      action.capture.body !== request.body
    )
      return "block" as const;
    // Reserve before awaiting so concurrent handoffs cannot escape the pending report.
    this.captureClaimed = true;
    const reported = await this.report(
      { kind: "challenge_observed", capture: action.capture },
      true,
    ).catch(() => false);
    if (!reported) {
      this.captureClaimed = false;
      this.canObserve();
      if (this.closed || this.state.status === "expired")
        return "block" as const;
      return this.fallback();
    }
    return verificationIsActive(this.state) && this.state.challengeCaptured
      ? ("capture" as const)
      : ("block" as const);
  }
  fallback() {
    if (this.submissionBlocked()) return "block" as const;
    this.native = true;
    return "continue" as const;
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
    let expired = false;
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
          const reply = await this.runner.report(this.state.id, body);
          if (expired)
            throw new Error("Purchase verification report timed out");
          const result = validated(
            reply,
            this.state,
            input.kind === "continuation_started",
          );
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
        } catch {
          ambiguous = true;
          if (expired || attempt === 2)
            throw new Error("Purchase verification report failed");
        }
      }
    };
    const pending = this.queue.then(async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          operation(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              expired = true;
              reject(new Error("Purchase verification report timed out"));
            }, 1000);
            timer.unref?.();
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    });
    this.queue = pending.catch(() => {});
    return pending;
  }
  private async acknowledgeNativeReturn() {
    await this.report(
      { kind: "interaction_resumed" },
      false,
      this.nativeAckKey,
    );
    this.nativeAckKey = undefined;
  }
  /** Synchronize durable state and discard reconciliation when the checkout returns to native handling. */
  private async tick() {
    // Check expiry before the in-flight guard, including when an adapter never settles.
    if (!this.canObserve() || this.ticking) return;
    this.ticking = true;
    try {
      await this.queue;
      if (!this.canObserve()) return;
      const synced = validated(
        await this.runner.sync(this.state.id),
        this.state,
      );
      if (!this.canObserve()) return;
      this.finish(synced);
      if (this.canObserve() && !this.native) {
        if (this.nativeAckKey) await this.acknowledgeNativeReturn();
        if (!this.canObserve()) return;
        const observation = await this.adapter.reconcile(this.current());
        if (!this.canObserve() || this.native) return;
        if (observation && observation.outcome !== "unknown")
          await this.report({ kind: "checkout_observed", observation });
        else if (this.state.launchClaimed && !this.state.continuationClaimed) {
          const resume = await this.adapter.continuation();
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
              if (this.canObserve() && acknowledged.interactionReturned) {
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
    if (!verificationIsActive(this.state) && state.status !== this.state.status)
      return;
    // Sensitive native material never reaches current(), wait(), transaction reads or caller logs.
    const safeState = structuredClone(state) as VerificationRunnerReply;
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
          Promise.resolve(this.adapter.dispose()).catch(() => {});
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

/** Validate injected runner replies before they can change claims or deliver a return. */
function validated(
  value: unknown,
  previous?: VerificationState,
  allowReturn = false,
): VerificationRunnerReply {
  const invalid = () => new Error("Invalid purchase verification state");
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !value.id ||
    typeof value.status !== "string" ||
    !Number.isSafeInteger(value.version) ||
    Number(value.version) < 0 ||
    ![
      "preparing",
      "requires_action",
      "checking",
      "ended",
      "expired",
      "canceled",
      "error",
    ].includes(value.status) ||
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    typeof value.merchantOrigin !== "string" ||
    !isRecord(value.total) ||
    typeof value.total.amount !== "string" ||
    typeof value.total.currency !== "string" ||
    ![
      value.challengeCaptured,
      value.launchClaimed,
      value.continuationClaimed,
    ].every((v) => typeof v === "boolean")
  )
    throw invalid();
  const origin = new URL(value.merchantOrigin);
  if (
    origin.origin !== value.merchantOrigin ||
    !["https:", "http:"].includes(origin.protocol)
  )
    throw invalid();
  if (
    [value.nativeReturnAvailable, value.interactionReturned].some(
      (v) => v !== undefined && typeof v !== "boolean",
    ) ||
    (value.nativeReturnProtocol !== undefined &&
      value.nativeReturnProtocol !== "stripe_3ds2") ||
    (value.actionUrl !== undefined && typeof value.actionUrl !== "string")
  )
    throw invalid();
  if (
    value.observation !== undefined &&
    (!isRecord(value.observation) ||
      typeof value.observation.outcome !== "string" ||
      !["confirmed", "failed", "unknown"].includes(value.observation.outcome) ||
      value.observation.source !== "runner" ||
      (value.observation.confirmation !== undefined &&
        typeof value.observation.confirmation !== "string"))
  )
    throw invalid();
  if (
    previous &&
    (value.id !== previous.id ||
      Number(value.version) < previous.version ||
      value.merchantOrigin !== previous.merchantOrigin ||
      value.total.amount !== previous.total.amount ||
      value.total.currency !== previous.total.currency ||
      Date.parse(value.expiresAt) > Date.parse(previous.expiresAt) ||
      ["challengeCaptured", "launchClaimed", "continuationClaimed"].some(
        (key) =>
          previous[key as keyof VerificationState] === true &&
          value[key] !== true,
      ))
  )
    throw invalid();
  if (
    value.nativeReturn !== undefined &&
    (!allowReturn ||
      !isRecord(value.nativeReturn) ||
      value.nativeReturn.protocol !== "stripe_3ds2" ||
      typeof value.nativeReturn.cres !== "string" ||
      value.nativeReturn.cres.length > 16384 ||
      !/^[A-Za-z0-9_+/-]+={0,2}$/.test(value.nativeReturn.cres))
  )
    throw invalid();
  // Select known fields: arbitrary runner properties must never reach the public handle.
  const state: VerificationRunnerReply = {
    id: value.id,
    version: Number(value.version),
    status: value.status as VerificationState["status"],
    expiresAt: value.expiresAt,
    merchantOrigin: value.merchantOrigin,
    total: { amount: value.total.amount, currency: value.total.currency },
    challengeCaptured: value.challengeCaptured as boolean,
    launchClaimed: value.launchClaimed as boolean,
    continuationClaimed: value.continuationClaimed as boolean,
  };
  for (const key of [
    "interactionReturned",
    "nativeReturnAvailable",
    "nativeReturnProtocol",
    "actionUrl",
  ] as const) {
    if (value[key] !== undefined)
      Object.assign(state, { [key]: structuredClone(value[key]) });
  }
  if (isRecord(value.observation)) {
    state.observation = {
      outcome: value.observation.outcome as NonNullable<
        VerificationState["observation"]
      >["outcome"],
      source: "runner",
      ...(typeof value.observation.confirmation === "string" && {
        confirmation: value.observation.confirmation,
      }),
    };
  }
  if (isRecord(value.nativeReturn))
    state.nativeReturn = {
      protocol: "stripe_3ds2",
      cres: value.nativeReturn.cres as string,
    };
  return state;
}
