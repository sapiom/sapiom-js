import type { HeldPlaceholder, RelayRequest } from "../../src/index.js";
import { btProxyRelay } from "./bt-proxy.js";

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
