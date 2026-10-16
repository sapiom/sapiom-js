import type { HeldPlaceholder, RelayRequest } from "../../src/index.js";
import { bogusShopifyRelay } from "./bogus.js";
import { SHOPIFY_PAYMENTS_TEST_CARD } from "./shopify-payments-test-card.js";

const PLACEHOLDER: HeldPlaceholder = {
  number: "4123456789012349",
  expMonth: 11,
  expYear: 2029,
  cvc: "321",
  injectionRef: "inj_demo",
};

const BODY = JSON.stringify({
  credit_card: {
    number: "4123-4567-8901-2349",
    name: "Test Buyer",
    month: 11,
    year: 2029,
    verification_value: "321",
  },
  payment_session_scope: "scope",
});

function request(body = BODY): RelayRequest {
  return {
    transactionId: "tx_demo",
    injectionRef: "inj_demo",
    merchantOrigin: "https://1a2uh3-r7.myshopify.com",
    url: "https://checkout.pci.shopifyinc.com/sessions?x=1",
    method: "POST",
    headers: [
      ["content-type", "application/json"],
      ["content-length", "999"],
      ["host", "checkout.pci.shopifyinc.com"],
      ["shopify-identification-signature", "sig"],
    ],
    body,
    bodyEncoding: "utf8",
    version: 1,
    idempotencyKey: "req_demo",
  };
}

describe("bogusShopifyRelay", () => {
  it("substitutes the Shopify Payments test card and forwards once", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const fetchImpl = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      seen.url = String(url);
      seen.init = init;
      return new Response(JSON.stringify({ id: "sess_bogus" }), {
        status: 201,
        headers: {
          "content-type": "application/json",
          "content-length": "20",
          "set-cookie": "a=b",
        },
      });
    }) as typeof fetch;
    const relay = bogusShopifyRelay({ placeholder: PLACEHOLDER, fetchImpl });
    const response = await relay.relay(request());
    expect(seen.url).toBe("https://checkout.pci.shopifyinc.com/sessions?x=1");
    expect(seen.init?.method).toBe("POST");
    const headers = seen.init?.headers as Record<string, string>;
    expect(headers["shopify-identification-signature"]).toBe("sig");
    expect(headers["content-length"]).toBeUndefined();
    expect(headers.host).toBeUndefined();
    const forwarded = JSON.parse(String(seen.init?.body));
    expect(forwarded).toEqual({
      credit_card: {
        number: SHOPIFY_PAYMENTS_TEST_CARD.number,
        name: "Test Buyer",
        month: SHOPIFY_PAYMENTS_TEST_CARD.expMonth,
        year: SHOPIFY_PAYMENTS_TEST_CARD.expYear,
        verification_value: SHOPIFY_PAYMENTS_TEST_CARD.cvc,
      },
      payment_session_scope: "scope",
    });
    expect(String(seen.init?.body)).not.toContain(PLACEHOLDER.number);
    expect(String(seen.init?.body)).not.toContain(PLACEHOLDER.cvc);
    expect(response).toEqual({
      ok: true,
      status: 201,
      headers: [
        ["content-type", "application/json"],
        ["set-cookie", "a=b"],
      ],
      body: '{"id":"sess_bogus"}',
      bodyEncoding: "utf8",
    });
  });

  it("does not forward when the placeholder cannot be replaced", async () => {
    const fetchImpl = jest.fn() as unknown as typeof fetch;
    const relay = bogusShopifyRelay({ placeholder: PLACEHOLDER, fetchImpl });
    await expect(relay.relay(request('{"event":"ping"}'))).rejects.toThrow(
      "Placeholder card fields were not replaced",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a redirect instead of following it", async () => {
    const fetchImpl = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.example" },
      })) as typeof fetch;
    const relay = bogusShopifyRelay({ placeholder: PLACEHOLDER, fetchImpl });
    await expect(relay.relay(request())).rejects.toThrow(
      "Payment relay refused a redirect",
    );
  });
});
