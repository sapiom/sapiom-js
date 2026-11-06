import { NativeCardinal } from "./native-cardinal";
import type { CdpEvent } from "./cdp";
const lookupResult = {
  nonce: "upgraded-original",
  acsUrl: "https://bank.example/challenge",
  acsTransactionId: "11111111-1111-4111-8111-111111111111",
  threeDSecureServerTransactionId: "22222222-2222-4222-8222-222222222222",
};
const lookupBody = {
  paymentMethod: { nonce: lookupResult.nonce },
  lookup: { acsUrl: lookupResult.acsUrl },
  threeDSecureInfo: {
    acsTransactionId: lookupResult.acsTransactionId,
    threeDSecureServerTransactionId:
      lookupResult.threeDSecureServerTransactionId,
  },
};
function observer() {
  let event!: (event: CdpEvent) => void;
  const send = jest.fn(async (method: string) => {
    if (method === "Network.getResponseBody")
      return {
        body: JSON.stringify(lookupBody),
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
  expect(await o.native.lookupChallenge()).toEqual(lookupResult);
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
  expect(await o.native.lookupChallenge()).toBeUndefined();
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

it.each([
  { ...lookupBody, lookup: {} },
  { ...lookupBody, lookup: { acsUrl: "" } },
  {
    ...lookupBody,
    threeDSecureInfo: { ...lookupBody.threeDSecureInfo, acsTransactionId: "" },
  },
  {
    ...lookupBody,
    threeDSecureInfo: { acsTransactionId: lookupResult.acsTransactionId },
  },
  { ...lookupBody, errors: { code: "lookup_rejected" } },
  { ...lookupBody, errors: [{ code: "lookup_rejected" }] },
])("rejects an unbound or rejected lookup response: %j", async (body) => {
  const o = observer();
  o.send.mockImplementation(async (method) =>
    method === "Network.getResponseBody" ? { body: JSON.stringify(body) } : {},
  );
  await o.native.watchLookup(o.lookup);
  o.emit("Network.responseReceived", {
    requestId: "exact-request",
    response: { url: o.lookup.url, status: 200 },
  });
  o.emit("Network.loadingFinished", {
    requestId: "exact-request",
    encodedDataLength: 3000,
  });
  expect(await o.native.lookupChallenge()).toBeUndefined();
  await o.native.dispose();
});
it.each([false, true])(
  "retains bound lookup identities with an empty errors array (base64=%s)",
  async (base64Encoded) => {
    const o = observer();
    const text = JSON.stringify({ ...lookupBody, errors: [] });
    o.send.mockImplementation(async (method) =>
      method === "Network.getResponseBody"
        ? {
            body: base64Encoded ? Buffer.from(text).toString("base64") : text,
            base64Encoded,
          }
        : {},
    );
    await o.native.watchLookup(o.lookup);
    o.emit("Network.responseReceived", {
      requestId: "exact-request",
      response: { url: o.lookup.url, status: 200 },
    });
    o.emit("Network.loadingFinished", {
      requestId: "exact-request",
      encodedDataLength: 3000,
    });
    expect(await o.native.lookupChallenge()).toEqual(lookupResult);
    await o.native.dispose();
  },
);
