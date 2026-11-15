import { TransactionAPI } from "./TransactionAPI.js";
import { HttpClient } from "./HttpClient.js";
import type {
  BrowserPurchase,
  UpdatePurchaseRequest,
} from "../types/transaction.js";

const purchase: BrowserPurchase = {
  type: "browser_checkout",
  merchant: { origin: "https://shop.example" },
  total: { amount: "0.40", currency: "USD" },
};

describe("purchase updates", () => {
  const request = jest.fn();
  const api = new TransactionAPI({ request } as unknown as HttpClient);
  beforeEach(() => request.mockReset());

  it("forwards a stable key and the exact replacement body, and preserves the result", async () => {
    const result = {
      id: "tx",
      status: "preparing",
      nextAction: { type: "wait", actor: "system" },
    };
    request.mockResolvedValue(result);
    const input: UpdatePurchaseRequest = { version: "v1", purchase };
    expect(await api.update("tx", input, { idempotencyKey: "change-1" })).toBe(
      result,
    );
    await api.update("tx", input, { idempotencyKey: "change-1" });
    expect(request.mock.calls).toEqual(
      Array(2).fill([
        {
          method: "POST",
          url: "/transactions/tx/update",
          body: input,
          retry: false,
          headers: { "Idempotency-Key": "change-1" },
        },
      ]),
    );
  });

  it("supports UCP replacement and preserves server conflicts", async () => {
    const failure = Object.assign(new Error("stale version"), {
      status: 409,
      code: "stale_version",
    });
    request.mockRejectedValue(failure);
    await expect(
      api.update(
        "tx",
        { version: "v1", checkout: { line_items: [] } },
        { idempotencyKey: "change" },
      ),
    ).rejects.toBe(failure);
  });

  it.each(["browser", "ucp"])(
    "never automatically replays an uncertain %s update",
    async (source) => {
      const fetch = jest
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response("{}", { status: 500 }));
      const real = new TransactionAPI(
        new HttpClient({
          baseURL: "https://api.example.com",
          timeout: 1000,
          headers: {},
          retry: { maxAttempts: 3, baseDelayMs: 0 },
        }),
      );
      const body: UpdatePurchaseRequest =
        source === "browser"
          ? { version: "v1", purchase }
          : { version: "v1", checkout: { line_items: [] } };
      try {
        await expect(
          real.update("tx", body, { idempotencyKey: "change" }),
        ).rejects.toThrow();
        expect(fetch).toHaveBeenCalledTimes(1);
      } finally {
        fetch.mockRestore();
      }
    },
  );

  it("forwards purchase creation's key in a header", async () => {
    await api.create({
      purchase,
      funding: { source: "external_card" },
      idempotencyKey: "create-1",
    });
    expect(request).toHaveBeenCalledWith({
      method: "POST",
      url: "/transactions",
      body: { purchase, funding: { source: "external_card" } },
      headers: { "Idempotency-Key": "create-1" },
    });
  });

  it("requires a nonempty bounded key before any request", async () => {
    for (const idempotencyKey of [" ", "a".repeat(256)])
      await expect(
        api.update("tx", { version: "v1", purchase }, { idempotencyKey }),
      ).rejects.toThrow("idempotencyKey");
    expect(request).not.toHaveBeenCalled();
  });
});
