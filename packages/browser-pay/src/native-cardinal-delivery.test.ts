import { runInNewContext } from "node:vm";
import type { CdpEvent } from "./cdp";
import {
  DELIVER_NATIVE_CARDINAL,
  NativeCardinalDelivery,
} from "./native-cardinal-delivery";

function verifier(
  response: unknown = {
    paymentMethod: { nonce: "authenticated" },
    threeDSecureInfo: {},
  },
) {
  let resolve!: (value: unknown) => void, reject!: (error: Error) => void;
  const pending = Object.assign(
    new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    }),
    {
      isFulfilled: false,
      resolve(value: unknown) {
        if (this.isFulfilled) return;
        this.isFulfilled = true;
        resolve(value);
      },
      reject(error: Error) {
        if (this.isFulfilled) return;
        this.isFulfilled = true;
        reject(error);
      },
    },
  );
  const request = jest.fn(async (_options: unknown) => response);
  const framework = {
    _client: { request },
    _verifyCardPromisePlus: pending,
    _lookupPaymentMethod: { nonce: "upgraded-original" },
  };
  const cleanup = jest.fn();
  const receipt = jest.fn();
  const deliver = runInNewContext(`(${DELIVER_NATIVE_CARDINAL})`, {
    Date,
    setTimeout,
    clearTimeout,
    notify: receipt,
  });
  const handler = jest.fn((_payload: unknown, jwt: string) => {
    void framework._client
      .request({
        endpoint:
          "payment_methods/upgraded-original/three_d_secure/authenticate_from_jwt",
        data: { jwt, paymentMethodNonce: "upgraded-original" },
      })
      .then(
        (value) => pending.resolve(value),
        (error: Error) => pending.reject(error),
      );
  });
  const call = () =>
    deliver.call(
      framework,
      handler,
      cleanup,
      pending,
      framework._lookupPaymentMethod,
      { ActionCode: "SUCCESS" },
      "signed.jwt.result",
      20,
      "notify",
      "private-receipt",
    );
  return {
    call,
    framework,
    request,
    handler,
    cleanup,
    receipt,
    pending,
    resolve: (value: unknown) => pending.resolve(value),
  };
}
describe("guarded delivery to the existing native verifier", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("uses the pinned pending promise and nonce, validates once, acknowledges and restores its wrapper", async () => {
    const native = verifier();
    await expect(native.call()).resolves.toBe(true);
    expect(native.handler).toHaveBeenCalledTimes(1);
    expect(native.cleanup).toHaveBeenCalledTimes(1);
    expect(native.request).toHaveBeenCalledTimes(1);
    expect(native.receipt).toHaveBeenCalledWith("private-receipt");
    expect(native.framework._client.request).toBe(native.request);
  });
  it("accepts an empty native errors array after validating the original exchange", async () => {
    const native = verifier({
      errors: [],
      paymentMethod: { nonce: "authenticated" },
      threeDSecureInfo: {},
    });
    await expect(native.call()).resolves.toBe(true);
    expect(native.receipt).toHaveBeenCalledTimes(1);
  });
  it.each([
    {
      errors: [{ code: "94533" }],
      paymentMethod: { nonce: "fallback" },
      threeDSecureInfo: {},
    },
    {
      errors: { code: "94533" },
      paymentMethod: { nonce: "fallback" },
      threeDSecureInfo: {},
    },
    {
      errors: { code: "94533", length: 0 },
      paymentMethod: { nonce: "fallback" },
      threeDSecureInfo: {},
    },
    { errors: [{ code: "94533" }] },
    { threeDSecureInfo: {} },
    { paymentMethod: { nonce: "fallback" } },
  ])(
    "rejects HTTP-200 error/fallback responses before the merchant receives a resolved nonce: %j",
    async (response) => {
      const native = verifier(response);
      await expect(native.call()).rejects.toThrow("native_validation_rejected");
      await expect(native.framework._verifyCardPromisePlus).rejects.toThrow(
        "native_validation_rejected",
      );
      expect(native.receipt).not.toHaveBeenCalled();
      expect(native.framework._client.request).toBe(native.request);
    },
  );
  it("refuses a replaced pending attempt before invoking either native callback", async () => {
    const native = verifier();
    const replacement = Object.assign(Promise.resolve(), {
      isFulfilled: false,
      resolve: jest.fn(),
      reject: jest.fn(),
    });
    native.framework._verifyCardPromisePlus = replacement;
    // call() takes the current pending object; change it inside native identity checking instead.
    Object.defineProperty(native.framework, "_verifyCardPromisePlus", {
      get: () => Promise.resolve(),
    });
    await expect(native.call()).rejects.toThrow("native_attempt_changed");
    expect(native.handler).not.toHaveBeenCalled();
    expect(native.request).not.toHaveBeenCalled();
  });
  it("requires a validated exchange even when an existing promise resolves without one", async () => {
    const native = verifier();
    native.handler.mockImplementation(() => {
      native.resolve({
        paymentMethod: { nonce: "upgraded-original" },
        threeDSecureInfo: {},
      });
    });
    await expect(native.call()).rejects.toThrow(
      "native_validation_not_confirmed",
    );
    expect(native.receipt).not.toHaveBeenCalled();
    expect(native.framework._client.request).toBe(native.request);
  });
});

describe("native return settlement ordering and deadlines", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("emits its receipt before the merchant's existing promise continuation runs", async () => {
    const native = verifier();
    const events: string[] = [];
    void native.pending.then(() => events.push("merchant"));
    native.receipt.mockImplementation(() => events.push("receipt"));
    await native.call();
    expect(events).toEqual(["receipt", "merchant"]);
  });

  it("does not acknowledge a successful response when the native promise was already rejected", async () => {
    const native = verifier();
    native.handler.mockImplementation((_payload, jwt) => {
      void native.framework._client
        .request({
          endpoint:
            "payment_methods/upgraded-original/three_d_secure/authenticate_from_jwt",
          data: { jwt, paymentMethodNonce: "upgraded-original" },
        })
        .then((value) => {
          native.pending.reject(new Error("merchant_canceled"));
          native.pending.resolve(value);
        });
    });
    await expect(native.call()).rejects.toThrow("merchant_canceled");
    expect(native.receipt).not.toHaveBeenCalled();
  });

  it("rejects the merchant's pending promise at the deadline and refuses a late successful response", async () => {
    let finish!: (value: unknown) => void;
    const native = verifier(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const accepted = jest.fn(),
      rejected = jest.fn();
    void native.pending.then(accepted, rejected);
    const resolve = native.pending.resolve;
    const failed = expect(native.call()).rejects.toThrow(
      "native_validation_timeout",
    );
    await jest.advanceTimersByTimeAsync(20);
    await failed;
    finish({
      paymentMethod: { nonce: "late-authenticated" },
      threeDSecureInfo: {},
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(accepted).not.toHaveBeenCalled();
    expect(rejected).toHaveBeenCalledWith(
      expect.objectContaining({ message: "native_validation_timeout" }),
    );
    expect(native.receipt).not.toHaveBeenCalled();
    expect(native.pending.resolve).toBe(resolve);
    expect(native.framework._client.request).toBe(native.request);
  });

  it("keeps the original merchant promise rejected if native validation starts after the deadline", async () => {
    const native = verifier();
    const originalHandler = native.handler.getMockImplementation()!;
    native.handler.mockImplementation((payload, jwt) => {
      setTimeout(() => originalHandler(payload, jwt), 40);
    });
    const accepted = jest.fn(),
      rejected = jest.fn();
    void native.pending.then(accepted, rejected);
    const failed = expect(native.call()).rejects.toThrow(
      "native_validation_timeout",
    );
    await jest.advanceTimersByTimeAsync(20);
    await failed;
    await jest.advanceTimersByTimeAsync(40);
    expect(accepted).not.toHaveBeenCalled();
    expect(rejected).toHaveBeenCalledTimes(1);
    expect(native.receipt).not.toHaveBeenCalled();
  });

  it("checks the deadline even before the timeout callback gets a turn", async () => {
    let finish!: (value: unknown) => void;
    const native = verifier(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const accepted = jest.fn(),
      rejected = jest.fn();
    void native.pending.then(accepted, rejected);
    const failed = expect(native.call()).rejects.toThrow(
      "native_validation_timeout",
    );
    jest.setSystemTime(Date.now() + 21);
    finish({
      paymentMethod: { nonce: "late-authenticated" },
      threeDSecureInfo: {},
    });
    await failed;
    expect(accepted).not.toHaveBeenCalled();
    expect(rejected).toHaveBeenCalledTimes(1);
    expect(native.receipt).not.toHaveBeenCalled();
  });
});

describe("native return receipt binding", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it.each(["session", "execution context", "token"] as const)(
    "ignores a receipt with the wrong %s until a matching receipt arrives",
    async (mismatch) => {
      let receive!: (event: CdpEvent) => void;
      const send = jest.fn(
        async (method: string, params: Record<string, unknown>) => {
          if (method === "Runtime.callFunctionOn" && params.objectId)
            return new Promise<unknown>(() => {});
          return {};
        },
      );
      const delivery = new NativeCardinalDelivery({
        send,
        onEvent(listener) {
          receive = listener;
          return jest.fn();
        },
      });
      const target = {
        frame: {
          sessionId: "merchant-session",
          frameId: "merchant-frame",
          url: "https://shop.example/checkout",
        },
        context: { id: 42, epoch: 1 },
        framework: "framework",
        handler: "handler",
        cleanup: "cleanup",
        pending: "pending",
        method: "method",
      };
      const jwt = [
        { alg: "HS256" },
        {
          exp: Math.floor(Date.now() / 1000) + 60,
          Payload: { ActionCode: "SUCCESS" },
        },
      ]
        .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
        .concat("signature")
        .join(".");
      const completed = jest.fn();
      const pending = delivery
        .deliver(
          target,
          { protocol: "braintree_cardinal", jwt },
          new Date(Date.now() + 60_000).toISOString(),
        )
        .then(completed);
      try {
        await jest.advanceTimersByTimeAsync(0);
        const call = send.mock.calls.find(
          ([method, params]) =>
            method === "Runtime.callFunctionOn" && params.objectId,
        );
        expect(call).toBeDefined();
        const args = call![1].arguments as { value?: string }[];
        const receipt: CdpEvent = {
          method: "Runtime.bindingCalled",
          sessionId: target.frame.sessionId,
          params: {
            name: args[7].value,
            executionContextId: target.context.id,
            payload: args[8].value,
          },
        };
        receive({
          ...receipt,
          sessionId:
            mismatch === "session" ? "other-session" : receipt.sessionId,
          params: {
            ...receipt.params,
            executionContextId:
              mismatch === "execution context" ? 99 : target.context.id,
            payload: mismatch === "token" ? "other-token" : args[8].value,
          },
        });
        await jest.advanceTimersByTimeAsync(0);
        expect(completed).not.toHaveBeenCalled();

        receive(receipt);
        await pending;
        expect(completed).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledWith(
          "Runtime.removeBinding",
          { name: receipt.params.name },
          target.frame.sessionId,
        );
      } finally {
        delivery.dispose();
      }
    },
  );
});
