import { SapiomClient } from "./SapiomClient";
import type {
  CardSpendingLimitsSettings,
  RefundConfirmationRequest,
} from "../types/payment-card";

describe("Card-limit management through the public client", () => {
  const cardId = "11111111-1111-4111-8111-111111111111";
  const transactionId = "22222222-2222-4222-8222-222222222222";
  let client: SapiomClient;
  let fetchMock: jest.Mock;
  const originalFetch = global.fetch;
  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock;
    client = new SapiomClient({
      apiKey: "fixture-management-key",
      baseURL: "https://api.test",
      backgroundRefresh: false,
    });
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const settings: CardSpendingLimitsSettings = {
    version: 0,
    purchaseLimit: { amount: "100.00", currency: "USD" },
    recurringLimit: { amount: "500.00", currency: "USD", period: "month" },
    customLimit: null,
  };

  it("uses versioned routes and preserves explicit slots and decimal amounts", async () => {
    fetchMock.mockResolvedValueOnce(json({ ...settings, version: 1 }));
    expect(
      (await client.paymentCards.setSpendingLimits(cardId, settings)).version,
    ).toBe(1);
    const [url, request] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      `https://api.test/v1/payment-cards/${cardId}/spending-limits`,
    );
    expect(request.method).toBe("PUT");
    expect(JSON.parse(request.body)).toEqual(settings);
    expect(request.headers["x-api-key"]).toBe("fixture-management-key");
    fetchMock.mockResolvedValueOnce(
      json({
        ...settings,
        version: 1,
        usage: { recurringLimit: { remaining: "450.00" } },
      }),
    );
    expect(
      (await client.paymentCards.getSpendingLimits(cardId)).usage.recurringLimit
        ?.remaining,
    ).toBe("450.00");
  });
  it("propagates a stale-version conflict without silently retrying a reset", async () => {
    fetchMock.mockResolvedValue(json({ code: "RULE_VERSION_CONFLICT" }, 409));
    await expect(
      client.paymentCards.setSpendingLimits(cardId, settings),
    ).rejects.toThrow(/409.*RULE_VERSION_CONFLICT/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("preserves refund identity, evidence and idempotency through transport retries", async () => {
    const receipt: RefundConfirmationRequest = {
      paymentTransactionId: transactionId,
      externalRefundId: "refund-1",
      amount: "10.00",
      currency: "USD",
      confirmedAt: "2026-10-18T12:00:00Z",
      idempotencyKey: "refund-1",
      evidence: {
        source: "trusted_platform",
        sourceReference: "verified-receipt-1",
        merchantOrderId: "order-1",
      },
    };
    fetchMock
      .mockResolvedValueOnce(json({ message: "temporary" }, 503))
      .mockResolvedValueOnce(json({ id: "receipt-1", state: "applied" }));
    expect(
      (
        await client.transactions.recordRefundConfirmation(
          transactionId,
          receipt,
        )
      ).state,
    ).toBe("applied");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, request] of fetchMock.mock.calls) {
      expect(String(url)).toBe(
        `https://api.test/v1/transactions/${transactionId}/refund-confirmations`,
      );
      expect(request.method).toBe("POST");
      expect(JSON.parse(request.body)).toEqual(receipt);
    }
  });
});
