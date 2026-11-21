import {
  adyenClientKeysInRequest,
  adyenDetailsCall,
  adyenPaymentResult,
  isAdyenSecuredFieldsPayment,
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
  const BODY = JSON.stringify({
    amount: { currency: "EUR", value: 1000 },
    reference: "order-1",
    paymentMethod: {
      type: "scheme",
      holderName: "J. Smith",
      encryptedCardNumber: "eyJ.placeholder-number",
      encryptedExpiryMonth: "eyJ.placeholder-month",
      encryptedExpiryYear: "eyJ.placeholder-year",
      encryptedSecurityCode: "eyJ.placeholder-cvc",
      checkoutAttemptId: "attempt-1",
    },
    browserInfo: { userAgent: "x" },
  });

  it("recognises only JSON with paymentMethod.encryptedCardNumber", () => {
    expect(isAdyenSecuredFieldsPayment(BODY)).toBe(true);
    for (const body of [
      "",
      "encryptedCardNumber=eyJ",
      JSON.stringify({ encryptedCardNumber: "eyJ" }),
      JSON.stringify({ paymentMethod: { encryptedCardNumber: "" } }),
      JSON.stringify({ paymentMethod: { encryptedCardNumber: 1 } }),
      JSON.stringify({ paymentMethod: { type: "scheme" } }),
      JSON.stringify([{ paymentMethod: { encryptedCardNumber: "eyJ" } }]),
    ]) {
      expect(isAdyenSecuredFieldsPayment(body)).toBe(false);
    }
  });
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
