import type { CreatePurchaseRequest } from "../types/transaction.js";
import { SapiomApiError } from "../errors/SapiomApiError.js";
import { HttpClient } from "./HttpClient.js";
import { TransactionAPI } from "./TransactionAPI.js";

const purchase: CreatePurchaseRequest = {
  purchase: {
    type: "ucp_checkout",
    merchant: { origin: "https://shop.example" },
    checkout: { line_items: [] },
  },
  funding: { paymentMethodId: "method" },
};
const api = () =>
  new TransactionAPI(
    new HttpClient({
      baseURL: "https://api.example",
      timeout: 1000,
      headers: {},
      retry: { maxAttempts: 3, baseDelayMs: 0 },
    }),
  );
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
afterEach(() => jest.restoreAllMocks());

it("replays a caller purchase key with identical funding after an uncertain create, only on explicit retry", async () => {
  const fetch = jest
    .spyOn(globalThis, "fetch")
    .mockRejectedValueOnce(new TypeError("lost reply"))
    .mockResolvedValueOnce(
      response({
        id: "transaction",
        paymentMethodId: "method",
        paymentMethodKind: "wallet",
      }),
    );
  const client = api();
  await expect(
    client.create(purchase, { idempotencyKey: "saved-purchase" }),
  ).rejects.toThrow("lost reply");
  expect(fetch).toHaveBeenCalledTimes(1);
  await expect(
    client.create(purchase, { idempotencyKey: "saved-purchase" }),
  ).resolves.toMatchObject({ paymentMethodId: "method" });
  for (const [url, init] of fetch.mock.calls) {
    expect(url).toBe("https://api.example/v1/transactions");
    expect(new Headers(init?.headers).get("idempotency-key")).toBe(
      "saved-purchase",
    );
    expect(JSON.parse(init?.body as string)).toEqual(purchase);
  }
});

it("requires a retained purchase key and leaves ordinary transaction creation compatible", async () => {
  const fetch = jest
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(response({ id: "ordinary" }));
  // JavaScript callers get the same protection as TypeScript callers.
  // @ts-expect-error purchase creation requires a key
  await expect(api().create(purchase)).rejects.toThrow("idempotencyKey");
  expect(fetch).not.toHaveBeenCalled();
  await api().create({
    serviceName: "ordinary",
    actionName: "read",
    resourceName: "resource",
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("uses the documented domain query and checkout paths, with full replacement bodies", async () => {
  const fetch = jest
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => response({}));
  const client = api();
  await client.checkCompatibility("shop.example");
  expect(fetch.mock.calls[0][0]).toBe(
    "https://api.example/v1/transaction-compatibility?domain=shop.example",
  );
  const checkout = {
    id: "checkout",
    line_items: [{ item: { id: "cheaper-item" }, quantity: 1 }],
    currency: "USD",
  };
  await client.openCheckout("transaction", checkout, {
    idempotencyKey: "open",
  });
  await client.updateCheckout("transaction", checkout, {
    idempotencyKey: "revision",
  });
  await client.getCheckout("transaction", {
    since: "revision-1",
    maxWaitSeconds: 0,
  });
  await client.refreshCheckout("transaction");
  await client.cancelCheckout("transaction", {
    idempotencyKey: "cancel-checkout",
  });
  await client.cancel("transaction", { idempotencyKey: "cancel-purchase" });
  const calls = fetch.mock.calls.slice(1);
  expect(
    calls.map(([url, init]) => [new URL(url as string).pathname, init?.method]),
  ).toEqual([
    ["/v1/transactions/transaction/ucp/checkout", "POST"],
    ["/v1/transactions/transaction/ucp/checkout", "PUT"],
    ["/v1/transactions/transaction/ucp/checkout", "GET"],
    ["/v1/transactions/transaction/ucp/checkout/refresh", "POST"],
    ["/v1/transactions/transaction/ucp/checkout/cancel", "POST"],
    ["/v1/transactions/transaction/cancel", "POST"],
  ]);
  expect(JSON.parse(calls[1][1]?.body as string)).toEqual(checkout);
  expect(new Headers(calls[1][1]?.headers).get("idempotency-key")).toBe(
    "revision",
  );
  expect(calls[2][0]).toContain("since=revision-1&maxWaitSeconds=0");
});

it.each([
  "openCheckout",
  "updateCheckout",
  "cancelCheckout",
  "cancel",
  "refreshCheckout",
] as const)(
  "does not automatically replay %s or erase typed refusals",
  async (operation) => {
    const fetch = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        response({ code: "change_unconfirmed", requestId: "support-ref" }, 409),
      );
    const client = api();
    const result =
      operation === "openCheckout" || operation === "updateCheckout"
        ? client[operation]("transaction", {}, { idempotencyKey: "change" })
        : operation === "refreshCheckout"
          ? client.refreshCheckout("transaction")
          : client[operation]("transaction", { idempotencyKey: "change" });
    await expect(result).rejects.toMatchObject({
      status: 409,
      code: "change_unconfirmed",
      requestId: "support-ref",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

it("bounds checkout reads and preserves a larger caller timeout", async () => {
  const http = new HttpClient({
    baseURL: "https://api.example",
    timeout: 60000,
    headers: {},
  });
  const request = jest.spyOn(http, "request").mockResolvedValue({});
  const client = new TransactionAPI(http);
  await client.getCheckout("transaction", {
    since: "before",
    maxWaitSeconds: 25,
  });
  expect(request).toHaveBeenCalledWith(
    expect.objectContaining({
      timeoutMs: 60000,
      params: { since: "before", maxWaitSeconds: 25 },
    }),
  );
  for (const maxWaitSeconds of [-1, 0.5, 26, NaN])
    await expect(
      client.getCheckout("transaction", { maxWaitSeconds }),
    ).rejects.toThrow("maxWaitSeconds");
  expect(request).toHaveBeenCalledTimes(1);
});

it("retains unknown merchant outcome and buyer-only next action fields unchanged", async () => {
  const body = {
    id: "transaction",
    order: { outcome: "unknown" },
    paymentMethodId: "wallet",
    paymentMethodKind: "wallet",
    nextAction: {
      type: "payment_ready",
      actor: "buyer",
      url: "https://buyer.example",
    },
  };
  jest.spyOn(globalThis, "fetch").mockResolvedValue(response(body));
  await expect(api().get("transaction")).resolves.toEqual(body);
  expect(new SapiomApiError(409, { code: "stale_version" })).toBeInstanceOf(
    Error,
  );
});
