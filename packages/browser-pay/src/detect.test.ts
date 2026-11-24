import { createHash } from "node:crypto";
import { adyenBodies } from "../test/adyen-bodies";
import {
  adyenCheckout,
  adyenClientKeysInRequest,
  adyenDetailsCall,
  adyenPaymentResult,
  isAdyenCheckoutUrl,
  compactJweTokens,
  bodyJweHashes,
  adyenPayCandidate,
  redactHeld,
  textHoldsPlaceholderNumber,
} from "./detect";

const NUMBER = "4242424242424242";

function encodedDigits(digits: string): string {
  return [...digits].map((digit) => `%3${digit}`).join("");
}

describe("redactHeld", () => {
  it("masks grouped and encoded placeholder digits", () => {
    const values = [
      `https://checkout.example/pay?number=${NUMBER}`,
      "https://checkout.example/pay?number=4242 4242 4242 4242",
      "https://checkout.example/pay?number=4242  4242  4242  4242",
      "https://checkout.example/pay?number=4242 - 4242 - 4242 - 4242",
      "https://checkout.example/pay?number=4242-4242-4242-4242",
      "https://checkout.example/pay?number=4242+4242+4242+4242",
      "https://checkout.example/pay?number=4242%204242%204242%204242",
      "https://checkout.example/pay?number=4242%2D4242%2d4242%2D4242",
      "https://checkout.example/pay?number=4242\\u00204242\\u00204242\\u00204242",
      `https://checkout.example/pay?number=${encodedDigits(NUMBER)}`,
    ];
    for (const value of values) {
      const redacted = redactHeld(value, NUMBER);
      expect(textHoldsPlaceholderNumber(value, NUMBER)).toBe(
        redacted !== value,
      );
      expect(redacted).not.toContain("4242");
      expect(redacted).not.toContain("%34");
      expect(textHoldsPlaceholderNumber(redacted, NUMBER)).toBe(false);
    }
  });

  it("leaves a url that does not hold the placeholder", () => {
    const url = "https://shop.example/orders/100";
    expect(redactHeld(url, NUMBER)).toBe(url);
    expect(textHoldsPlaceholderNumber(url, NUMBER)).toBe(false);
  });
});

describe("isAdyenCheckoutUrl", () => {
  it("accepts only exact HTTPS checkoutshopper hosts, without requiring a key", () => {
    for (const region of [
      "test",
      "live",
      "live-us",
      "live-au",
      "live-apse",
      "live-in",
    ]) {
      expect(
        isAdyenCheckoutUrl(
          `https://checkoutshopper-${region}.adyen.com/checkoutshopper/v3/analytics`,
        ),
      ).toBe(true);
    }
    for (const url of [
      "http://checkoutshopper-test.adyen.com/checkoutshopper",
      "https://checkoutshopper-test.adyen.com.evil.example/checkoutshopper",
      "https://evil-checkoutshopper-test.adyen.com/checkoutshopper",
      "https://checkoutshopper-live-eu.adyen.com/checkoutshopper",
      "https://checkoutanalytics-test.adyen.com/checkoutanalytics",
      "https://checkoutshopper-test.adyen.com:8443/checkoutshopper",
      "https://shop.example/checkout",
      "not a url",
      "",
    ]) {
      expect(isAdyenCheckoutUrl(url)).toBe(false);
    }
  });
});

describe("adyenClientKeysInRequest", () => {
  const TEST = "https://checkoutshopper-test.adyen.com/checkoutshopper";

  it("reads the key from each place Adyen's own requests carry it", () => {
    expect(
      adyenClientKeysInRequest(
        `${TEST}/securedfields/test_ABC123XYZ/6.4.1/securedFields.html?type=card`,
      ),
    ).toStrictEqual(["test_ABC123XYZ"]);
    expect(
      adyenClientKeysInRequest(`${TEST}/v1/clientKeys/test_ABC123XYZ`),
    ).toStrictEqual(["test_ABC123XYZ"]);
    expect(
      adyenClientKeysInRequest(
        `${TEST}/v1/sessions/CS1/payments?clientKey=test_ABC123XYZ`,
      ),
    ).toStrictEqual(["test_ABC123XYZ"]);
    expect(
      adyenClientKeysInRequest(`${TEST}/v3/analytics`, "test_ABC123XYZ"),
    ).toStrictEqual(["test_ABC123XYZ"]);
    expect(
      adyenClientKeysInRequest(
        "https://checkoutshopper-live.adyen.com/checkoutshopper/v1/clientKeys/live_Q1W2E3",
      ),
    ).toStrictEqual(["live_Q1W2E3"]);
    for (const region of ["live-us", "live-au", "live-apse", "live-in"]) {
      expect(
        adyenClientKeysInRequest(
          `https://checkoutshopper-${region}.adyen.com/checkoutshopper/securedfields/live_Q1W2E3/5.0.0/securedFields.html`,
        ),
      ).toStrictEqual(["live_Q1W2E3"]);
    }
  });

  it("ignores lookalike and other hosts, plain http, a wrong environment and malformed keys", () => {
    for (const url of [
      "https://checkoutshopper-test.adyen.com.evil.example/checkoutshopper/v1/clientKeys/test_ABC",
      "https://evil-checkoutshopper-test.adyen.com/checkoutshopper/v1/clientKeys/test_ABC",
      "https://checkoutshopper-live-us.adyen.com.evil.example/checkoutshopper/v1/clientKeys/live_ABC",
      "https://checkoutshopper-live-eu.adyen.com/checkoutshopper/v1/clientKeys/live_ABC",
      "https://checkoutshopper-live-us.adyen.com/checkoutshopper/v1/clientKeys/test_ABC",
      "https://checkoutanalytics-test.adyen.com/checkoutanalytics/v3/analytics?clientKey=test_ABC",
      "https://checkoutshopper-test.adyen.com:8443/checkoutshopper/v1/clientKeys/test_ABC",
      "http://checkoutshopper-test.adyen.com/checkoutshopper/v1/clientKeys/test_ABC",
      "https://shop.example/checkout?clientKey=test_ABC",
      `${TEST}/v1/clientKeys/live_ABC`,
      "https://checkoutshopper-live.adyen.com/checkoutshopper/v1/clientKeys/test_ABC",
      `${TEST}/v1/clientKeys/test_ab-c`,
      `${TEST}/v1/clientKeys/test_${"A".repeat(65)}`,
      `${TEST}/securedfields/pub.v2.ABC/6.4.1/securedFields.html`,
      "not a url",
      "",
    ]) {
      expect(adyenClientKeysInRequest(url, "test_ABC")).toStrictEqual(
        url.startsWith(TEST) ? ["test_ABC"] : [],
      );
    }
  });

  it("accepts lowercase key bodies from the query, path, header and frame URL", () => {
    const KEY = "test_870be2854add4f56b86778353010f36c";
    expect(
      adyenClientKeysInRequest(
        `${TEST}/v1/sessions/CS1/payments?clientKey=${KEY}`,
      ),
    ).toStrictEqual([KEY]);
    expect(
      adyenClientKeysInRequest(`${TEST}/v1/clientKeys/${KEY}`),
    ).toStrictEqual([KEY]);
    expect(adyenClientKeysInRequest(`${TEST}/v3/analytics`, KEY)).toStrictEqual(
      [KEY],
    );
    expect(
      adyenClientKeysInRequest(
        `${TEST}/securedfields/${KEY}/6.4.1/securedFields.html?type=card`,
      ),
    ).toStrictEqual([KEY]);
    expect(
      adyenClientKeysInRequest(
        "https://checkoutshopper-live.adyen.com/checkoutshopper/v1/clientKeys/live_q1w2e3",
      ),
    ).toStrictEqual(["live_q1w2e3"]);
  });

  it("reports every key a frame URL names, so a conflict stays visible", () => {
    expect(
      adyenClientKeysInRequest(
        `${TEST}/securedfields/test_ABC/6.4.1/securedFields.html?clientKey=test_XYZ`,
      ),
    ).toStrictEqual(["test_XYZ", "test_ABC"]);
  });
});

describe("Adyen secured-fields payment bodies", () => {
  const blob =
    "eyJhbGciOiJSU0EtT0FFUCIsImVuYyI6IkEyNTZHQ00ifQ.KEY_-1.aXY-2.Y2lwaGVy_3.dGFn-4";
  const hash = createHash("sha256").update(blob).digest("hex");
  it.each(adyenBodies({ encryptedCardNumber: blob }))(
    "keeps a compact JWE verbatim through $name",
    ({ body }) => {
      expect(body).toContain(blob);
      expect(compactJweTokens(body)).toContain(blob);
      expect(adyenPayCandidate(body, [])).toBe(true);
    },
  );
  it("recognises opaque field names only by observed hashes", () => {
    expect(adyenPayCandidate(`opaque=${blob}`, [hash])).toBe(true);
    expect(adyenPayCandidate(`opaque=${blob}`, [])).toBe(false);
    expect(encodeURIComponent(blob)).toBe(blob);
    expect(JSON.stringify(JSON.stringify(blob))).toContain(blob);
  });
  it("recognises case-insensitive names through nested percent escapes", () => {
    expect(adyenPayCandidate("%22%45ncryptedCardNumber%22", [])).toBe(true);
    expect(adyenPayCandidate("%2545ncryptedCardNumber", [])).toBe(true);
    expect(adyenPayCandidate('{"number":"plain"}', [])).toBe(false);
  });
  it("separates raw hashes from percent-encoded and JSON-escaped hashes", () => {
    const other =
      "eyJhbGciOiJSU0EtT0FFUCIsImVuYyI6IkEyNTZHQ00ifQ.UNKNOWN.aXY.Y2lwaGVy.dGFn";
    const otherHash = createHash("sha256").update(other).digest("hex");
    for (const encoded of [
      other.replace(/\./g, "%2E"),
      other.replace(/\./g, "\\u002e"),
      other.replace(/\./g, "\\\\u002e"),
    ]) {
      expect(bodyJweHashes(`${blob} ${encoded}`)).toEqual({
        raw: new Set([hash]),
        hidden: new Set([otherHash]),
      });
      expect(adyenPayCandidate(`opaque=${encoded}`, [otherHash])).toBe(true);
      expect(adyenPayCandidate(`opaque=${encoded}`, [])).toBe(false);
    }
  });
  it("deduplicates raw hashes", () => {
    expect(bodyJweHashes(`${blob} ${blob}`)).toEqual({
      raw: new Set([hash]),
      hidden: new Set(),
    });
  });
  it("reports an escaped copy as hidden even when the ciphertext is also raw", () => {
    expect(
      bodyJweHashes(`${blob} ${blob.replace(/\./g, "%2e")} ${blob}`),
    ).toEqual({
      raw: new Set([hash]),
      hidden: new Set([hash]),
    });
    expect(bodyJweHashes("a.b.c.d a..b.c.d")).toEqual({
      raw: new Set(),
      hidden: new Set(),
    });
  });
  it("takes only runs whose first segment is a JWE header for ciphertexts", () => {
    const noEnc = Buffer.from('{"alg":"RSA-OAEP"}').toString("base64url");
    expect(
      compactJweTokens(
        `https://checkout.shop.example.co.uk/complete 1.2.3.4.5 ${noEnc}.a.b.c.d e30.a.b.c.d`,
      ),
    ).toEqual([]);
  });
  it("never extracts a five-part substring from a longer or incomplete run", () => {
    expect(compactJweTokens(`${blob}.extra a.b.c.d a..b.c.d ${blob}`)).toEqual([
      blob,
    ]);
  });
});

describe("adyenCheckout", () => {
  it.each([
    "https://merchant.adyen.com",
    "https://checkoutshopper-test.adyen.com:8443",
    "https://shop.example",
  ])("keeps merchant session routes keyed by origin on %s", (origin) => {
    expect(adyenCheckout(new URL(`${origin}/sessions/S1/payments`))).toBe(
      origin,
    );
    expect(
      adyenDetailsCall("POST", `${origin}/sessions/S1/paymentDetails`),
    ).toStrictEqual({ checkout: origin, relay: false });
    expect(
      adyenDetailsCall("POST", `${origin}/payments/details`),
    ).toStrictEqual({ checkout: origin, relay: false });
  });

  it.each(["", ":443"])(
    "keys checkoutshopper payments by session on the default HTTPS port (%s)",
    (port) => {
      const origin = "https://checkoutshopper-test.adyen.com";
      expect(
        adyenCheckout(new URL(`${origin}${port}/sessions/S1/payments`)),
      ).toBe(`${origin}/sessions/S1`);
      expect(
        adyenDetailsCall("POST", `${origin}${port}/sessions/S1/paymentDetails`),
      ).toStrictEqual({ checkout: `${origin}/sessions/S1`, relay: true });
    },
  );
});

describe("Adyen 3-D Secure details calls", () => {
  const ADYEN = "https://checkoutshopper-test.adyen.com/checkoutshopper/v1";

  it("relays only Adyen's own sessions paymentDetails, keyed by session", () => {
    expect(
      adyenDetailsCall(
        "POST",
        `${ADYEN}/sessions/CS1/paymentDetails?clientKey=k`,
      ),
    ).toStrictEqual({
      checkout: `https://checkoutshopper-test.adyen.com/checkoutshopper/v1/sessions/CS1`,
      relay: true,
    });
    expect(
      adyenDetailsCall("post", "https://shop.example/api/payments/details"),
    ).toStrictEqual({ checkout: "https://shop.example", relay: false });
    expect(
      adyenDetailsCall(
        "POST",
        "https://shop.example/sessions/S1/paymentDetails",
      ),
    ).toStrictEqual({ checkout: "https://shop.example", relay: false });
  });

  it("matches nothing else", () => {
    for (const [method, url] of [
      ["GET", `${ADYEN}/sessions/CS1/paymentDetails`],
      ["POST", `${ADYEN}/sessions/CS1/payments`],
      ["POST", "https://shop.example/api/payments"],
      ["POST", "https://shop.example/api/payments/details/extra"],
      ["POST", "not a url"],
    ]) {
      expect(adyenDetailsCall(method!, url!)).toBeUndefined();
    }
  });

  it("reads a known resultCode and a well-formed pspReference, else unknown", () => {
    expect(
      adyenPaymentResult('{"resultCode":"Authorised","pspReference":"PSP1"}'),
    ).toStrictEqual({ resultCode: "Authorised", pspReference: "PSP1" });
    expect(
      adyenPaymentResult('{"resultCode":"Paid","pspReference":"a b"}'),
    ).toStrictEqual({ resultCode: "unknown" });
    expect(adyenPaymentResult("<html>")).toStrictEqual({
      resultCode: "unknown",
    });
  });
});
