import { NativeCardinal } from "./native-cardinal";
import type { CdpEvent } from "./cdp";
function observer() {
  let event!: (event: CdpEvent) => void;
  const send = jest.fn(async (method: string) => {
    if (method === "Network.getResponseBody")
      return {
        body: JSON.stringify({ paymentMethod: { nonce: "upgraded-original" } }),
      };
    return {};
  });
  const dispose = jest.fn();
  const native = new NativeCardinal({
    send,
    onEvent: (listener) => {
      event = listener;
      return dispose;
    },
  });
  const lookup = {
    url: "https://api.sandbox.braintreegateway.com/payment_methods/original/three_d_secure/lookup",
    method: "POST",
    body: "{}",
    sessionId: "merchant",
    networkId: "exact-request",
  };
  const emit = (
    method: string,
    params: Record<string, unknown>,
    sessionId = "merchant",
  ) => event({ method, params, sessionId });
  return { native, send, emit, lookup, dispose };
}
it("binds a successful original lookup response, including HTTP 201, to its upgraded native nonce", async () => {
  const o = observer();
  await o.native.watchLookup(o.lookup);
  o.emit("Network.responseReceived", {
    requestId: "exact-request",
    response: { url: o.lookup.url, status: 201 },
  });
  o.emit("Network.loadingFinished", {
    requestId: "exact-request",
    encodedDataLength: 3000,
  });
  expect(await o.native.lookupNonce()).toBe("upgraded-original");
  expect(o.send).toHaveBeenCalledWith(
    "Network.getResponseBody",
    { requestId: "exact-request" },
    "merchant",
    5000,
  );
  await o.native.dispose();
  expect(o.dispose).toHaveBeenCalled();
});
it("ignores other sessions/requests and rejects oversized or unsuccessful lookup replies", async () => {
  const o = observer();
  await o.native.watchLookup(o.lookup);
  o.emit(
    "Network.responseReceived",
    {
      requestId: "exact-request",
      response: { url: o.lookup.url, status: 201 },
    },
    "other-session",
  );
  o.emit("Network.loadingFinished", {
    requestId: "other-request",
    encodedDataLength: 30,
  });
  expect(o.send).not.toHaveBeenCalledWith(
    "Network.getResponseBody",
    expect.anything(),
    expect.anything(),
    expect.anything(),
  );
  o.emit("Network.responseReceived", {
    requestId: "exact-request",
    response: { url: o.lookup.url, status: 201 },
  });
  o.emit("Network.loadingFinished", {
    requestId: "exact-request",
    encodedDataLength: 100000,
  });
  expect(await o.native.lookupNonce()).toBeUndefined();
  await o.native.dispose();
});
it("leaves an unknown native runtime unsupported before capture", async () => {
  const o = observer();
  o.send.mockImplementation(async () => ({}));
  await expect(
    o.native.bind(
      {
        sessionId: "merchant",
        frameId: "checkout",
        url: "https://shop.example",
      },
      "nonce",
    ),
  ).rejects.toThrow("context unavailable");
  await o.native.dispose();
});
