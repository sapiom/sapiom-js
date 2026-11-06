import { randomUUID } from "node:crypto";
import type { CdpConnection } from "./cdp.js";
import type { Frame } from "./merchant-frame.js";
import type { NativeReturn } from "./verification.js";
type Evaluation = { result?: { value?: unknown }; exceptionDetails?: unknown };
export type NativeCardinalTarget = {
  frame: Frame;
  context: { id: number; epoch: number };
  framework: string;
  handler: string;
  cleanup: string;
  pending: string;
  method: string;
};

/**
 * Transport the real signed result through the existing verifier, never through a synthetic message.
 * The native API can return HTTP 200 with errors and an unauthenticated fallback nonce. Reject that
 * response before the merchant's pending promise can resolve. Restore only our exact request wrapper.
 */
export const DELIVER_NATIVE_CARDINAL = `async function(handler, cleanup, pending, method, payload, jwt, timeout, notify, receipt) {
  if (this._verifyCardPromisePlus !== pending || this._lookupPaymentMethod !== method ||
      typeof method.nonce !== 'string' || typeof pending.then !== 'function') throw new Error('native_attempt_changed');
  const client = this._client, original = client.request, nonce = method.nonce;
  let exchanges = 0, accepted = false, timer;
  const guarded = function(options, ...rest) {
    if (options.endpoint !== 'payment_methods/' + nonce + '/three_d_secure/authenticate_from_jwt')
      return original.call(this, options, ...rest);
    if (options.data?.jwt !== jwt || options.data?.paymentMethodNonce !== nonce || ++exchanges !== 1)
      return Promise.reject(new Error('native_validation_binding_mismatch'));
    return Promise.resolve(original.call(this, options, ...rest)).then(response => {
      if ((response.errors && response.errors.length) || !response.paymentMethod ||
          typeof response.paymentMethod.nonce !== 'string' || !response.threeDSecureInfo)
        throw new Error('native_validation_rejected');
      accepted = true;
      return response;
    });
  };
  client.request = guarded;
  try {
    cleanup();
    handler(payload, jwt);
    await Promise.race([pending, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('native_validation_timeout')), timeout);
    })]);
    if (!accepted || exchanges !== 1) throw new Error('native_validation_not_confirmed');
    globalThis[notify](receipt);
    return true;
  } finally {
    clearTimeout(timer);
    if (client.request === guarded) client.request = original;
  }
}`;

/** Private one-use return delivery on the pinned caller-owned connection. */
export class NativeCardinalDelivery {
  private readonly receipts = new Map<
    string,
    { sessionId: string; contextId: number; token: string; resolve: () => void }
  >();
  private readonly unsubscribe: () => void;
  constructor(private readonly cdp: Pick<CdpConnection, "send" | "onEvent">) {
    this.unsubscribe = cdp.onEvent((event) => {
      const params = event.params as {
        name?: string;
        payload?: string;
        executionContextId?: number;
      };
      if (event.method === "Runtime.bindingCalled" && params.name) {
        const receipt = this.receipts.get(params.name);
        if (
          receipt &&
          receipt.sessionId === event.sessionId &&
          receipt.contextId === params.executionContextId &&
          receipt.token === params.payload
        )
          receipt.resolve();
      }
    });
  }
  async deliver(
    target: NativeCardinalTarget,
    result: NativeReturn,
    expiresAt: string,
  ) {
    if (
      result.protocol !== "braintree_cardinal" ||
      result.jwt.length > 16384 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(result.jwt)
    )
      throw new Error("Native return context changed");
    const [header, claims] = result.jwt
      .split(".")
      .slice(0, 2)
      .map((part) =>
        JSON.parse(Buffer.from(part, "base64url").toString("utf8")),
      );
    const payload =
      typeof claims.Payload === "string"
        ? JSON.parse(claims.Payload)
        : claims.Payload;
    if (
      header.alg !== "HS256" ||
      !Number.isFinite(claims.exp) ||
      claims.exp * 1000 <= Date.now() ||
      !["SUCCESS", "NOACTION", "FAILURE"].includes(payload?.ActionCode)
    )
      throw new Error("Unsupported native result");
    const timeout = Math.min(15000, Date.parse(expiresAt) - Date.now());
    if (timeout <= 0) throw new Error("Native return expired");
    const name = `sapiomNativeReturn${randomUUID().replace(/-/g, "")}`;
    const token = randomUUID();
    const receipt = new Promise<void>((resolve) =>
      this.receipts.set(name, {
        sessionId: target.frame.sessionId,
        contextId: target.context.id,
        token,
        resolve,
      }),
    );
    try {
      await this.cdp.send(
        "Runtime.addBinding",
        { name, executionContextId: target.context.id },
        target.frame.sessionId,
      );
      const delivered = this.cdp
        .send(
          "Runtime.callFunctionOn",
          {
            objectId: target.framework,
            functionDeclaration: DELIVER_NATIVE_CARDINAL,
            arguments: [
              { objectId: target.handler },
              { objectId: target.cleanup },
              { objectId: target.pending },
              { objectId: target.method },
              { value: payload },
              { value: result.jwt },
              { value: timeout },
              { value: name },
              { value: token },
            ],
            awaitPromise: true,
            returnByValue: true,
          },
          target.frame.sessionId,
          timeout + 2000,
        )
        .then((value) => {
          const result = value as Evaluation;
          if (result.exceptionDetails || result.result?.value !== true)
            throw new Error("Native continuation unavailable");
        });
      // A real merchant may navigate immediately after its native promise resolves. The receipt is
      // emitted by our guarded native call before navigation; it contains no bank material or outcome.
      await Promise.race([delivered, receipt]);
    } finally {
      this.receipts.delete(name);
      await this.cdp
        .send("Runtime.removeBinding", { name }, target.frame.sessionId)
        .catch(() => {});
      await this.cdp
        .send(
          "Runtime.callFunctionOn",
          {
            executionContextId: target.context.id,
            functionDeclaration: "function(name) { delete globalThis[name]; }",
            arguments: [{ value: name }],
          },
          target.frame.sessionId,
          1000,
        )
        .catch(() => {});
    }
  }

  dispose() {
    this.unsubscribe();
    this.receipts.clear();
  }
}
