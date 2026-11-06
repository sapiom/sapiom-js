import { SapiomClient } from "./SapiomClient.js";
import { SapiomApiError } from "../errors/SapiomApiError.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("Saved-method SDK HTTP contract", () => {
  const client = () =>
    new SapiomClient({
      apiKey: "management-fixture",
      baseURL: "https://api.example",
      backgroundRefresh: false,
      headers: { "sapiom-tenant": "buyer" },
    });
  afterEach(() => jest.restoreAllMocks());

  it("passes cursor parameters and preserves safe unfamiliar-kind data", async () => {
    const page = {
      data: [
        {
          id: "method",
          kind: "future_kind",
          label: "Saved account",
          readiness: "not_ready",
        },
      ],
      links: { next: null },
      meta: {},
    };
    const fetch = jest.spyOn(globalThis, "fetch").mockResolvedValue(json(page));
    expect(
      await client().paymentMethods.list({
        limit: 1,
        after: "cursor",
        sort: "-updated_at",
      }),
    ).toEqual(page);
    const [url, options] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://api.example/v1/payment-methods?sort=-updated_at&page%5Blimit%5D=1&page%5Bafter%5D=cursor",
    );
    expect(new Headers(options?.headers).get("sapiom-tenant")).toBe("buyer");
  });

  it("sends all nullable settings and never replays a failed save", async () => {
    const fetch = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(json({ code: "RULE_VERSION_CONFLICT" }, 409));
    const input = {
      version: 3,
      purchaseLimit: null,
      recurringLimit: {
        amount: "30.00",
        currency: "USD" as const,
        period: "month" as const,
      },
      customLimit: null,
    };
    await expect(
      client().paymentMethods.setSpendingLimits("method/id", input),
    ).rejects.toBeInstanceOf(SapiomApiError);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]![0])).toContain(
      "/payment-methods/method%2Fid/spending-limits",
    );
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual(input);
  });

  it("does not retry a one-time card setup link after a lost response", async () => {
    const fetch = jest
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new TypeError("response lost"));
    await expect(
      client().paymentCards.createSetupLink({
        returnUrl: "https://app.example/return",
      }),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("accepts an empty 204 card removal response", async () => {
    jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    await expect(client().paymentCards.remove("card")).resolves.toBeUndefined();
  });
  it("uses card setup and management routes with flat setup results and buyer-scoped requests", async () => {
    const card = {
      id: "card/id",
      readiness: "real_card_number",
      last4: "4242",
    };
    const setup = {
      id: "link/id",
      status: "open",
      expiresAt: "2026-12-01T00:00:00Z",
    };
    const fetch = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ data: [card] }))
      .mockResolvedValueOnce(json(card))
      .mockResolvedValueOnce(
        json({ ...setup, url: "https://buyer.example/setup" }),
      )
      .mockResolvedValueOnce(json(setup))
      .mockResolvedValueOnce(json(card))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const cards = client().paymentCards;
    expect(await cards.list()).toEqual({ data: [card] });
    expect(await cards.get(card.id)).toEqual(card);
    expect(
      await cards.createSetupLink({ returnUrl: "https://app.example/return" }),
    ).toEqual({ ...setup, url: "https://buyer.example/setup" });
    expect(await cards.getSetupLink(setup.id)).toEqual(setup);
    expect(await cards.setDefault(card.id)).toEqual(card);
    expect(await cards.remove(card.id)).toBeUndefined();
    expect(
      fetch.mock.calls.map(([url, init]) => [
        new URL(String(url)).pathname,
        init?.method,
      ]),
    ).toEqual([
      ["/v1/payment-cards", "GET"],
      ["/v1/payment-cards/card%2Fid", "GET"],
      ["/v1/payment-cards/setup-links", "POST"],
      ["/v1/payment-cards/setup-links/link%2Fid", "GET"],
      ["/v1/payment-cards/card%2Fid/default", "PUT"],
      ["/v1/payment-cards/card%2Fid", "DELETE"],
    ]);
    expect(JSON.parse(String(fetch.mock.calls[2]![1]?.body))).toEqual({
      returnUrl: "https://app.example/return",
    });
    for (const [, init] of fetch.mock.calls) {
      expect(new Headers(init?.headers).get("sapiom-tenant")).toBe("buyer");
    }
  });
});
