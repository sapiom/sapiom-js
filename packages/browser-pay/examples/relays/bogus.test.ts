import type { HeldPlaceholder, RelayRequest } from "../../src/index.js";
import { bogusShopifyRelay } from "./bogus.js";

const PLACEHOLDER: HeldPlaceholder = {
  number: "4242424242424242",
  expMonth: 11,
  expYear: 2029,
  cvc: "321",
  injectionRef: "inj_demo",
};

const BODY = JSON.stringify({
  credit_card: {
    number: "4242-4242-4242-4242",
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
    headers: {
      "content-type": "application/json",
      "content-length": "999",
      host: "checkout.pci.shopifyinc.com",
      "shopify-identification-signature": "sig",
    },
    body,
  };
}

describe("bogusShopifyRelay", () => {
  it("substitutes the Bogus Gateway success card and forwards once", async () => {
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
        number: "1",
        name: "Test Buyer",
        month: 12,
        year: 2030,
        verification_value: "111",
      },
      payment_session_scope: "scope",
    });
    expect(String(seen.init?.body)).not.toContain(PLACEHOLDER.number);
    expect(String(seen.init?.body)).not.toContain(PLACEHOLDER.cvc);
    expect(response).toEqual({
      ok: true,
      status: 201,
      headers: {
        "content-type": "application/json",
        "set-cookie": "a=b",
      },
      body: '{"id":"sess_bogus"}',
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
