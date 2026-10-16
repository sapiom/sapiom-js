import type { HeldPlaceholder, RelayRequest } from "../../src/index.js";
import {
  btAccessFromKey,
  btProxyRelay,
  createShopifyPaymentsTestToken,
} from "./bt-proxy.js";
import { SHOPIFY_PAYMENTS_TEST_CARD } from "./shopify-payments-test-card.js";

const PLACEHOLDER: HeldPlaceholder = {
  number: "4242424242424242",
  expMonth: 11,
  expYear: 2029,
  cvc: "321",
  injectionRef: "inj_demo",
};

const API_KEY = "bt_test_key_should_not_leak";
const TOKEN_ID = "tok_test_123";

const REQUEST: RelayRequest = {
  transactionId: "tx_demo",
  injectionRef: "inj_demo",
  merchantOrigin: "https://shop.example",
  url: "https://checkout.pci.shopifyinc.com/sessions",
  method: "POST",
  headers: {
    "content-type": "application/json",
    "content-length": "40",
    "shopify-identification-signature": "sig",
  },
  body: JSON.stringify({
    credit_card: {
      number: "4242424242424242",
      month: 11,
      year: 2029,
      verification_value: "321",
    },
  }),
};

describe("btProxyRelay", () => {
  it("posts token expressions to the Basis Theory proxy", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const fetchImpl = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      seen.url = String(url);
      seen.init = init;
      return new Response('{"id":"sess_bt"}', {
        status: 200,
        headers: {
          "content-type": "application/json",
          "bt-proxy-destination-status": "201",
          "bt-request-id": "req_secret",
          "content-encoding": "gzip",
        },
      });
    }) as typeof fetch;
    const relay = btProxyRelay({
      placeholder: PLACEHOLDER,
      apiKey: API_KEY,
      tokenId: TOKEN_ID,
      fetchImpl,
    });
    const response = await relay.relay(REQUEST);
    expect(seen.url).toBe("https://api.basistheory.com/proxy");
    const headers = seen.init?.headers as Record<string, string>;
    expect(headers["BT-API-KEY"]).toBe(API_KEY);
    expect(headers["BT-PROXY-URL"]).toBe(
      "https://checkout.pci.shopifyinc.com/sessions",
    );
    expect(headers["shopify-identification-signature"]).toBe("sig");
    expect(headers["content-length"]).toBeUndefined();
    const body = String(seen.init?.body);
    expect(body).not.toContain(PLACEHOLDER.number);
    expect(body).not.toContain(PLACEHOLDER.cvc);
    const card = JSON.parse(body).credit_card;
    expect(card.number).toBe(
      "{{ token: tok_test_123 | json: '$.data.number' }}",
    );
    expect(card.month).toBe(
      "{{ token: tok_test_123 | json: '$.data.expiration_month' }}",
    );
    expect(card.year).toBe(
      "{{ token: tok_test_123 | json: '$.data.expiration_year' }}",
    );
    expect(card.verification_value).toBe(
      "{{ token: tok_test_123 | json: '$.data.cvc' }}",
    );
    expect(response).toEqual({
      ok: true,
      status: 201,
      headers: { "content-type": "application/json" },
      body: '{"id":"sess_bt"}',
    });
    if (!response.ok) throw new Error("expected a fulfilled relay response");
    expect(JSON.stringify(response.headers)).not.toContain("bt-");
  });

  it("fails closed on a proxy error and does not include the key", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 401 })) as typeof fetch;
    const relay = btProxyRelay({
      placeholder: PLACEHOLDER,
      apiKey: API_KEY,
      tokenId: TOKEN_ID,
      fetchImpl,
    });
    await expect(relay.relay(REQUEST)).rejects.toThrow(
      "Payment relay failed (HTTP 401)",
    );
  });
});

describe("createShopifyPaymentsTestToken", () => {
  it("vaults the Shopify Payments test card and deletes the token afterwards", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls.push({ url: String(url), init });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return new Response(
        JSON.stringify({
          id: "tok_created_1",
          data: { number: SHOPIFY_PAYMENTS_TEST_CARD.number },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const created = await createShopifyPaymentsTestToken({
      apiKey: API_KEY,
      fetchImpl,
    });
    expect(created.tokenId).toBe("tok_created_1");
    const create = calls[0];
    expect(create?.url).toBe("https://api.basistheory.com/tokens");
    expect(create?.init?.method).toBe("POST");
    const headers = create?.init?.headers as Record<string, string>;
    expect(headers["BT-API-KEY"]).toBe(API_KEY);
    expect(JSON.parse(String(create?.init?.body))).toEqual({
      type: "card",
      data: {
        number: SHOPIFY_PAYMENTS_TEST_CARD.number,
        expiration_month: SHOPIFY_PAYMENTS_TEST_CARD.expMonth,
        expiration_year: SHOPIFY_PAYMENTS_TEST_CARD.expYear,
        cvc: SHOPIFY_PAYMENTS_TEST_CARD.cvc,
      },
    });
    await created.release();
    expect(calls[1]?.url).toBe(
      "https://api.basistheory.com/tokens/tok_created_1",
    );
    expect(calls[1]?.init?.method).toBe("DELETE");
  });

  it("does not echo the card number when token create fails", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          title: "bad",
          echo: SHOPIFY_PAYMENTS_TEST_CARD.number,
        }),
        { status: 400 },
      )) as typeof fetch;
    await expect(
      createShopifyPaymentsTestToken({ apiKey: API_KEY, fetchImpl }),
    ).rejects.toThrow("Basis Theory token create failed (HTTP 400: bad)");
    try {
      await createShopifyPaymentsTestToken({ apiKey: API_KEY, fetchImpl });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(SHOPIFY_PAYMENTS_TEST_CARD.number);
      expect(message).not.toContain(API_KEY);
    }
  });
});

describe("btAccessFromKey", () => {
  it("uses a private key without creating an application", async () => {
    const fetchImpl = jest.fn(async () =>
      Response.json({ type: "private" }),
    ) as unknown as typeof fetch;
    const access = await btAccessFromKey({ apiKey: API_KEY, fetchImpl });
    expect(access.createdApplication).toBe(false);
    expect(access.apiKey).toBe(API_KEY);
    await access.release();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("creates a private application from a management key and deletes it", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const createdKey = "key_test_private_created";
    const fetchImpl = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls.push({ url: String(url), init });
      if (!init || init.method === "GET" || init.method === undefined) {
        return Response.json({ type: "management" });
      }
      if (init.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json({
        id: "app_demo_1",
        keys: [{ key: createdKey }],
      });
    }) as typeof fetch;
    const access = await btAccessFromKey({
      apiKey: "key_test_management",
      fetchImpl,
    });
    expect(access.createdApplication).toBe(true);
    expect(access.apiKey).toBe(createdKey);
    const create = calls[1];
    expect(create?.url).toBe("https://api.basistheory.com/applications");
    expect(JSON.parse(String(create?.init?.body))).toEqual({
      name: "browser-pay demo",
      type: "private",
      permissions: [
        "token:create",
        "token:delete",
        "token:use",
        "proxy:invoke",
      ],
    });
    await access.release();
    expect(calls[2]?.url).toBe(
      "https://api.basistheory.com/applications/app_demo_1",
    );
    expect(calls[2]?.init?.method).toBe("DELETE");
    const deleteHeaders = calls[2]?.init?.headers as Record<string, string>;
    expect(deleteHeaders["BT-API-KEY"]).toBe("key_test_management");
  });

  it("does not include the created key when application create fails", async () => {
    const fetchImpl = (async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (!init || init.method === undefined || init.method === "GET") {
        return Response.json({ type: "management" });
      }
      return Response.json(
        {
          title: "missing_permission",
          detail: "Missing permission: application:create",
          key: "key_test_should_not_leak",
        },
        { status: 403 },
      );
    }) as typeof fetch;
    await expect(
      btAccessFromKey({ apiKey: "key_test_management", fetchImpl }),
    ).rejects.toThrow(
      "Basis Theory application create failed (HTTP 403: missing_permission: Missing permission: application:create)",
    );
  });
});
