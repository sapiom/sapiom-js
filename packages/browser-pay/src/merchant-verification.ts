import type { CdpConnection } from "./cdp.js";
import { MerchantFrames, type Frame } from "./merchant-frame.js";
import {
  NativeCardinal,
  type NativeCardinalTarget,
} from "./native-cardinal.js";
import { ShopifyVerification, supportedCReq } from "./shopify-verification.js";
import type {
  NativeReturn,
  VerificationAdapter,
  VerificationRelayContext,
  VerificationRequest,
  VerificationState,
} from "./verification.js";

const TOKENIZATION = new Set([
  "https://payments.sandbox.braintree-api.com",
  "https://payments.braintree-api.com",
]);
const GATEWAYS = new Set([
  "https://api.sandbox.braintreegateway.com",
  "https://api.braintreegateway.com",
]);
const money = (value: unknown) => {
  const text = String(value);
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  return `${whole}.${fraction.padEnd(2, "0")}`;
};

/** Qualified merchant protocols on the existing no-profile relay, with native fallback before capture. */
export class MerchantVerification
  extends MerchantFrames
  implements VerificationAdapter
{
  private readonly native: NativeCardinal;
  private readonly shopify: ShopifyVerification;
  private mode?: "shopify" | "braintree";
  private nonce?: string;
  private pin?: Promise<Frame | undefined>;
  private checkout?: Frame;
  private lookup = false;
  private target?: NativeCardinalTarget;

  constructor(
    connection: CdpConnection,
    private readonly state: () => VerificationState | undefined,
    parentSession: (
      sessionId: string,
      parentFrameId?: string,
    ) => string | undefined = () => undefined,
  ) {
    super(connection, parentSession);
    this.native = new NativeCardinal(connection);
    this.shopify = new ShopifyVerification(connection, state, parentSession);
  }

  relayed(
    response: { body: string },
    sessionId: string,
    context?: VerificationRelayContext,
  ) {
    if (this.mode || !context?.url || !context.frameId) return;
    const url = new URL(context.url);
    const body = JSON.parse(response.body);
    if (
      url.origin === "https://checkout.pci.shopifyinc.com" &&
      url.pathname === "/sessions"
    ) {
      if (
        typeof body?.id !== "string" ||
        body.id.length === 0 ||
        body.id.length > 255
      )
        return;
      this.mode = "shopify";
      this.shopify.relayed(response);
      return;
    }
    const nonce = body?.data?.tokenizeCreditCard?.token;
    if (
      !TOKENIZATION.has(url.origin) ||
      url.pathname !== "/graphql" ||
      body.errors?.length ||
      typeof nonce !== "string" ||
      !nonce ||
      nonce.length > 255
    )
      return;
    this.mode = "braintree";
    this.nonce = nonce;
    const origin = this.state()?.merchantOrigin;
    this.pin = origin
      ? this.merchantAncestor({ sessionId, frameId: context.frameId }, origin)
          .then(async (frame) => {
            if (frame) await this.native.enableLookup(frame.sessionId);
            return frame;
          })
          .catch(() => undefined)
      : Promise.resolve(undefined);
  }

  async inspect(request: VerificationRequest) {
    if (this.mode === "shopify") return this.shopify.inspect(request);
    const state = this.state();
    if (!state || request.method !== "POST") return "continue" as const;
    const url = new URL(request.url);
    if (this.pin) this.checkout = await this.pin;
    const checkout = this.checkout;
    const captured =
      this.target || state.challengeCaptured || state.launchClaimed;
    if (
      checkout &&
      this.nonce &&
      GATEWAYS.has(url.origin) &&
      url.pathname.endsWith(
        `/payment_methods/${encodeURIComponent(this.nonce)}/three_d_secure/lookup`,
      )
    ) {
      if (
        captured &&
        (await this.samePage(checkout, request).catch(() => undefined)) !==
          false
      )
        return "block" as const;
      if (
        !state.challengeCaptured &&
        (await this.descendant(checkout, request, false))
      ) {
        const body = JSON.parse(request.body);
        if (
          !this.lookup &&
          money(body.amount) === state.total.amount &&
          state.total.currency === "USD"
        ) {
          this.lookup = true;
          try {
            await this.native.watchLookup(request);
          } catch {
            this.lookup = false;
          }
        }
      }
      return "continue" as const;
    }
    let jsonChallenge = false;
    if (request.body.startsWith("{")) {
      try {
        const body = JSON.parse(request.body);
        jsonChallenge =
          body &&
          typeof body === "object" &&
          (Object.prototype.hasOwnProperty.call(body, "creq") ||
            body.messageType === "CReq");
      } catch {
        /* An unsupported body does not identify a bank request. */
      }
    }
    if (!jsonChallenge && !new URLSearchParams(request.body).has("creq"))
      return "continue" as const;
    if (captured)
      return checkout &&
        (await this.samePage(checkout, request).catch(() => undefined)) ===
          false
        ? ("continue" as const)
        : ("block" as const);
    if (
      !checkout ||
      !(await this.descendant(checkout, request, false).catch(() => false))
    )
      return "continue" as const;
    if (
      jsonChallenge ||
      this.mode !== "braintree" ||
      !this.lookup ||
      !this.nonce ||
      request.body.length > 8192 ||
      request.url.length > 2048 ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      [...request.url].some((character) => {
        const code = character.charCodeAt(0);
        return code <= 32 || code === 127;
      }) ||
      /%(?![0-9a-f]{2})/i.test(request.body)
    )
      return "fallback" as const;
    const form = new URLSearchParams(request.body);
    if (
      [...form.keys()].sort().join(",") !== "creq,threeDSSessionData" ||
      form.getAll("creq").length !== 1 ||
      form.getAll("threeDSSessionData").length !== 1 ||
      !/^[\x20-\x7e]+$/.test(form.get("threeDSSessionData") ?? "")
    )
      return "fallback" as const;
    if (!supportedCReq(form.get("creq")!)) return "fallback" as const;
    try {
      const nonce = await this.native.lookupNonce();
      if (!nonce) return "fallback" as const;
      this.target = await this.native.bind(checkout, nonce);
    } catch {
      return "fallback" as const;
    }
    return {
      capture: {
        url: request.url,
        body: request.body,
        nativeReturn: "braintree_cardinal" as const,
      },
    };
  }

  async continuation() {
    if (this.mode === "shopify") return this.shopify.continuation();
    const state = this.state(),
      target = this.target;
    if (!state?.nativeReturnAvailable || !state.launchClaimed || !target)
      return null;
    return async (result?: NativeReturn) => {
      if (
        !result ||
        !(await this.descendant(
          target.frame,
          {
            sessionId: target.frame.sessionId,
            frameId: target.frame.frameId,
          } as VerificationRequest,
          false,
        ))
      )
        throw new Error("Native checkout context unavailable");
      await this.native.deliver(target, result, state.expiresAt);
      return { interactionReturned: true as const };
    };
  }

  reconcile(state: VerificationState) {
    return this.mode === "shopify"
      ? this.shopify.reconcile(state)
      : Promise.resolve(null);
  }

  dispose() {
    return this.native.dispose();
  }
}
