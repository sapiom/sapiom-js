import { SapiomClient } from "./SapiomClient";
import type {
  CardPurchaseApprovalSettings,
  CreateCardSetupLinkInput,
} from "../types/payment-card";

describe("Saved-card purchase approval through the public SDK", () => {
  const cardId = "11111111-1111-4111-8111-111111111111";
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;
  let client: SapiomClient;
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

  it("reads and updates the saved setting, retaining its concurrency version", async () => {
    fetchMock.mockResolvedValueOnce(json({ enabled: false, version: 0 }));
    expect(await client.paymentCards.getPurchaseApproval(cardId)).toEqual({
      enabled: false,
      version: 0,
    });
    const setting: CardPurchaseApprovalSettings = { enabled: true, version: 0 };
    fetchMock.mockResolvedValueOnce(json({ enabled: true, version: 1 }));
    expect(
      await client.paymentCards.setPurchaseApproval(cardId, setting),
    ).toEqual({ enabled: true, version: 1 });
    const [url, request] = fetchMock.mock.calls[1];
    expect(String(url)).toBe(
      `https://api.test/v1/payment-cards/${cardId}/purchase-approval`,
    );
    expect(request.method).toBe("PUT");
    expect(JSON.parse(request.body)).toEqual(setting);
    expect(request.headers["x-api-key"]).toBe("fixture-management-key");
  });

  it("passes the bounded approval grant to hosted setup and retrieves the resulting card", async () => {
    const input: CreateCardSetupLinkInput = {
      returnUrl: "https://buyer.example/cards",
      purchaseApproval: { enabled: false, allowChanges: true },
    };
    fetchMock.mockResolvedValueOnce(
      json({
        id: "link",
        status: "open",
        url: "https://app.test/add-card#private-code",
        purchaseApproval: input.purchaseApproval,
      }),
    );
    const link = await client.paymentCards.createSetupLink(input);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(input);
    fetchMock.mockResolvedValueOnce(
      json({
        id: "link",
        status: "completed",
        cardId,
        purchaseApproval: { enabled: true, allowChanges: false },
      }),
    );
    expect((await client.paymentCards.getSetupLink(link.id)).cardId).toBe(
      cardId,
    );
    expect(String(fetchMock.mock.calls[1][0])).toBe(
      "https://api.test/v1/payment-cards/setup-links/link",
    );
  });

  it("surfaces conflicts without retrying a policy overwrite", async () => {
    fetchMock.mockResolvedValue(json({ code: "RULE_VERSION_CONFLICT" }, 409));
    await expect(
      client.paymentCards.setPurchaseApproval(cardId, {
        enabled: false,
        version: 1,
      }),
    ).rejects.toThrow(/409.*RULE_VERSION_CONFLICT/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
