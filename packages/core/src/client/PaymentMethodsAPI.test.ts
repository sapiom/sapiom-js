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
    await expect(client().paymentCards.remove("card")).resolves.toBeNull();
  });
});
