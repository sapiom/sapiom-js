import type { CdpConnection, CdpEvent } from "./cdp.js";
import { isRecord } from "./guards.js";
import { MerchantFrames, type Frame } from "./merchant-frame.js";
import { supportedCReq } from "./three-d-secure.js";
import type {
  CheckoutObservation,
  VerificationAdapter,
  VerificationAdapterFactory,
  VerificationRelayContext,
  VerificationRequest,
  VerificationState,
} from "./verification.js";

const json = (body: string): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(body);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
};
const id = (value: unknown): string | undefined =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,255}$/.test(value)
    ? value
    : undefined;
const intentId = (value: unknown) => {
  const candidate = isRecord(value) ? value.id : value;
  return typeof candidate === "string" && /^pi_[A-Za-z0-9]+$/.test(candidate)
    ? candidate
    : undefined;
};
const stripeIntent = (url: URL) =>
  url.origin === "https://api.stripe.com"
    ? /^\/v1\/payment_intents\/(pi_[A-Za-z0-9]+)(\/confirm)?$/.exec(
        url.pathname,
      )
    : null;
const authenticationFailure = (value: unknown) =>
  isRecord(value) &&
  ["payment_intent_authentication_failure", "authentication_failure"].includes(
    String(value.code),
  );
type ResponseRequest = {
  url: string;
  kind: "confirm" | "retrieve" | "auth";
  ready?: boolean;
};

/** Passive Stripe PE observation; only supported, bound CReq POSTs transfer ownership. */
export class StripePaymentElementVerification
  extends MerchantFrames
  implements VerificationAdapter
{
  private cardSession?: string;
  private checkout?: Promise<Frame | undefined>;
  private submittedIntent?: string;
  private challengeExpected = false;
  private authSource?: string;
  private observation?: CheckoutObservation;
  private disposed = false;
  private readonly requests = new Map<string, ResponseRequest>();
  private readonly reads = new Set<Promise<void>>();
  private readonly removeListener: () => void;

  constructor(
    cdp: Pick<CdpConnection, "send" | "onEvent">,
    private readonly state: () => VerificationState | undefined,
    parentSession: (
      sessionId: string,
      parentFrameId?: string,
    ) => string | undefined = () => undefined,
  ) {
    const parents = new Map<string, string | undefined>();
    const targets = new Map<string, string>();
    super(
      cdp,
      (sessionId, frameId) =>
        parentSession(sessionId, frameId) ??
        targets.get(frameId ?? "") ??
        parents.get(sessionId),
    );
    this.removeListener = cdp.onEvent((event) => {
      const params = event.params;
      if (
        event.method === "Target.attachedToTarget" &&
        typeof params.sessionId === "string"
      ) {
        parents.set(params.sessionId, event.sessionId);
        if (
          isRecord(params.targetInfo) &&
          typeof params.targetInfo.targetId === "string"
        )
          targets.set(params.targetInfo.targetId, params.sessionId);
      }
      if (
        event.method === "Target.detachedFromTarget" &&
        typeof params.sessionId === "string"
      ) {
        parents.delete(params.sessionId);
        for (const [target, session] of targets)
          if (session === params.sessionId) targets.delete(target);
      }
      this.onResponse(event);
    });
  }

  relayed(
    response: { body: string },
    sessionId: string,
    context?: VerificationRelayContext,
  ) {
    if (this.cardSession || this.disposed) return;
    const body = json(response.body);
    const payment = isRecord(body?.payment_intent) ? body.payment_intent : body;
    const cardSession = id(payment?.id);
    const state = this.state();
    if (!cardSession || !state) return;
    this.cardSession = cardSession;
    this.checkout = (async () => {
      let frameId = context?.frameId;
      if (!frameId) {
        const tree = (await this.cdp.send(
          "Page.getFrameTree",
          {},
          sessionId,
        )) as any;
        frameId = tree?.frameTree?.frame?.id;
      }
      return this.merchantAncestor(
        { sessionId, frameId },
        state.merchantOrigin,
      );
    })().catch(() => undefined);
  }

  async inspect(request: VerificationRequest) {
    const state = this.state();
    if (!state || this.disposed) return "continue" as const;
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return "continue" as const;
    }
    const body = json(request.body);
    const form = body ? null : new URLSearchParams(request.body);
    const stripe = stripeIntent(url);
    const merchantConfirm =
      url.origin === state.merchantOrigin &&
      /\/confirm\/?$/.test(url.pathname) &&
      (!!intentId(body?.payment_intent) ||
        body?.payment_method === this.cardSession ||
        form?.get("payment_method") === this.cardSession);
    const confirming =
      request.method === "POST" && (!!stripe?.[2] || merchantConfirm);
    const bankPost =
      request.method === "POST" &&
      url.origin !== state.merchantOrigin &&
      (form?.has("creq") ||
        (body && ("creq" in body || body.messageType === "CReq")));
    const auth =
      url.origin === "https://api.stripe.com" &&
      /^\/v1\/3ds2\/(authenticate|challenge_complete)$/.test(url.pathname) &&
      request.method === "POST";
    if (
      (confirming || bankPost || auth) &&
      (state.challengeCaptured || state.launchClaimed)
    )
      return "block" as const;
    if (
      !confirming &&
      !bankPost &&
      !auth &&
      !(stripe && request.method === "GET" && this.submittedIntent)
    )
      return "continue" as const;
    if (confirming && this.submittedIntent) return "block" as const;
    const checkout = await this.checkout;
    if (
      !checkout ||
      !this.cardSession ||
      !(await this.descendant(checkout, request, false).catch(() => false))
    )
      return "fallback" as const;
    if (confirming) {
      // Frame checks can overlap for concurrent requests; claim only after they settle.
      if (
        this.submittedIntent ||
        this.state()?.challengeCaptured ||
        this.state()?.launchClaimed
      )
        return "block" as const;
      const paymentMethod = body?.payment_method ?? form?.get("payment_method");
      const source = body?.source ?? form?.get("source");
      const paymentIntent = stripe?.[1] ?? intentId(body?.payment_intent);
      if (
        !paymentIntent ||
        !request.networkId ||
        url.username ||
        url.password ||
        url.hash ||
        (this.cardSession.startsWith("pi_")
          ? paymentIntent !== this.cardSession
          : paymentMethod !== this.cardSession && source !== this.cardSession)
      )
        return "fallback" as const;
      // Claim before releasing the original Confirm, including uncertain network outcomes.
      this.submittedIntent = paymentIntent;
      this.track(request, "confirm");
      return "continue" as const;
    }
    if (bankPost) {
      await Promise.all(this.reads);
      if (
        !this.submittedIntent ||
        !this.challengeExpected ||
        !form ||
        [...form.keys()].join(",") !== "creq" ||
        request.url.length > 2048 ||
        request.body.length > 8192 ||
        [...request.url].some(
          (character) =>
            character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
        ) ||
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.hash ||
        !supportedCReq(form.get("creq") ?? "")
      )
        return "fallback" as const;
      const stripeFrame =
        (await this.merchantAncestor(request, "https://hooks.stripe.com").catch(
          () => undefined,
        )) ??
        (await this.merchantAncestor(request, "https://js.stripe.com").catch(
          () => undefined,
        ));
      if (
        !stripeFrame ||
        !/3d_secure_2|3ds2/.test(new URL(stripeFrame.url).pathname)
      )
        return "fallback" as const;
      return { capture: { url: request.url, body: request.body } };
    }
    if (this.submittedIntent && stripe?.[1] === this.submittedIntent)
      this.track(request, "retrieve");
    if (
      auth &&
      this.authSource &&
      (body?.source ?? form?.get("source")) === this.authSource
    )
      this.track(request, "auth");
    return "continue" as const;
  }

  async reconcile(
    state: VerificationState,
  ): Promise<CheckoutObservation | null> {
    await Promise.all(this.reads);
    if (this.disposed || state.merchantOrigin !== this.state()?.merchantOrigin)
      return null;
    const observation = this.observation;
    return observation &&
      observation.amount === state.total.amount &&
      observation.currency === state.total.currency
      ? { ...observation }
      : null;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.removeListener();
    this.requests.clear();
    this.observation = undefined;
    this.cardSession = undefined;
    this.checkout = undefined;
    this.authSource = undefined;
    this.challengeExpected = false;
  }

  private track(request: VerificationRequest, kind: ResponseRequest["kind"]) {
    if (!request.networkId || this.requests.size >= 32) return;
    this.requests.set(`${request.sessionId}:${request.networkId}`, {
      url: request.url,
      kind,
    });
  }

  private onResponse(event: CdpEvent) {
    if (
      this.disposed ||
      !event.sessionId ||
      typeof event.params.requestId !== "string"
    )
      return;
    const key = `${event.sessionId}:${event.params.requestId}`;
    const request = this.requests.get(key);
    if (!request) return;
    if (event.method === "Network.responseReceived") {
      const response = event.params.response;
      if (
        !isRecord(response) ||
        response.url !== request.url ||
        typeof response.mimeType !== "string" ||
        !response.mimeType.includes("json")
      ) {
        this.requests.delete(key);
      } else request.ready = true;
    }
    if (event.method === "Network.loadingFailed") this.requests.delete(key);
    if (event.method !== "Network.loadingFinished") return;
    this.requests.delete(key);
    if (!request.ready || Number(event.params.encodedDataLength) > 262144)
      return;
    const read = this.readResponse(
      event.sessionId,
      event.params.requestId,
      request.kind,
    ).catch(() => {
      // Unreadable responses never authorize capture or manufacture an outcome.
    });
    this.reads.add(read);
    void read.finally(() => this.reads.delete(read));
  }

  private async readResponse(
    sessionId: string,
    requestId: string,
    kind: ResponseRequest["kind"],
  ) {
    const response = (await this.cdp.send(
      "Network.getResponseBody",
      { requestId },
      sessionId,
    )) as any;
    if (
      this.disposed ||
      this.observation ||
      typeof response?.body !== "string" ||
      response.body.length > 349528
    )
      return;
    const text = response.base64Encoded
      ? Buffer.from(response.body, "base64").toString("utf8")
      : response.body;
    if (Buffer.byteLength(text) > 262144) return;
    const payload = json(text);
    const error = isRecord(payload?.error) ? payload.error : undefined;
    const payment = isRecord(error?.payment_intent)
      ? error.payment_intent
      : isRecord(payload?.payment_intent)
        ? payload.payment_intent
        : payload;
    const state = this.state();
    // A bound Confirm/auth error can omit its intent. Report failure only, never success.
    if (
      state &&
      this.cardSession &&
      kind !== "retrieve" &&
      authenticationFailure(error) &&
      !error?.payment_intent &&
      !payload?.payment_intent &&
      payload?.object !== "payment_intent"
    ) {
      this.observation = {
        outcome: "failed",
        cardSession: this.cardSession,
        ...state.total,
      };
      this.challengeExpected = false;
      return;
    }
    if (
      !state ||
      !payment ||
      !this.cardSession ||
      payment.id !== this.submittedIntent ||
      payment.object !== "payment_intent" ||
      (this.cardSession.startsWith("pm_") &&
        payment.payment_method !== this.cardSession) ||
      typeof payment.amount !== "number" ||
      !Number.isSafeInteger(payment.amount) ||
      payment.amount < 0 ||
      typeof payment.currency !== "string"
    )
      return;
    // Stripe uses minor units. Refuse currencies whose exponent has not been established here.
    if (!["usd", "eur", "gbp", "cad", "aud"].includes(payment.currency)) return;
    const amount = `${Math.floor(payment.amount / 100)}.${String(payment.amount % 100).padStart(2, "0")}`;
    const currency = payment.currency.toUpperCase();
    if (amount !== state.total.amount || currency !== state.total.currency)
      return;
    const outcome =
      payment.status === "succeeded" && !error
        ? "confirmed"
        : authenticationFailure(error) ||
            authenticationFailure(payment.last_payment_error) ||
            payment.status === "canceled"
          ? "failed"
          : null;
    if (outcome)
      this.observation = {
        outcome,
        cardSession: this.cardSession,
        amount,
        currency,
      };
    const action = payment.next_action;
    const sdk =
      isRecord(action) && isRecord(action.use_stripe_sdk)
        ? action.use_stripe_sdk
        : null;
    this.challengeExpected =
      !outcome &&
      payment.status === "requires_action" &&
      isRecord(action) &&
      action.type === "use_stripe_sdk" &&
      ["stripe_3ds2_fingerprint", "stripe_3ds2_challenge"].includes(
        String(sdk?.type),
      );
    this.authSource = this.challengeExpected
      ? id(sdk?.three_d_secure_2_source)
      : undefined;
  }
}

export const createStripePaymentElementVerification: VerificationAdapterFactory =
  (connection, state) =>
    new StripePaymentElementVerification(connection, state);
