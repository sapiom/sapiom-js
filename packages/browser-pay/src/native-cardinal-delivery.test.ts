import { runInNewContext } from "node:vm";
import { DELIVER_NATIVE_CARDINAL } from "./native-cardinal-delivery";

function verifier(
  response: unknown = {
    paymentMethod: { nonce: "authenticated" },
    threeDSecureInfo: {},
  },
) {
  let resolve!: (value: unknown) => void, reject!: (error: Error) => void;
  const pending = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const request = jest.fn(async (_options: unknown) => response);
  const framework = {
    _client: { request },
    _verifyCardPromisePlus: pending,
    _lookupPaymentMethod: { nonce: "upgraded-original" },
  };
  const cleanup = jest.fn();
  const receipt = jest.fn();
  const deliver = runInNewContext(`(${DELIVER_NATIVE_CARDINAL})`, {
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
      .then(resolve, reject);
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
  return { call, framework, request, handler, cleanup, receipt };
}
describe("guarded delivery to the existing native verifier", () => {
  it("uses the pinned pending promise and nonce, validates once, acknowledges and restores its wrapper", async () => {
    const native = verifier();
    await expect(native.call()).resolves.toBe(true);
    expect(native.handler).toHaveBeenCalledTimes(1);
    expect(native.cleanup).toHaveBeenCalledTimes(1);
    expect(native.request).toHaveBeenCalledTimes(1);
    expect(native.receipt).toHaveBeenCalledWith("private-receipt");
    expect(native.framework._client.request).toBe(native.request);
  });
  it.each([
    {
      errors: [{ code: "94533" }],
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
    const replacement = Promise.resolve();
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
    native.handler.mockImplementation(() => {});
    await expect(native.call()).rejects.toThrow("native_validation_timeout");
    expect(native.receipt).not.toHaveBeenCalled();
    expect(native.framework._client.request).toBe(native.request);
  });
});
