import {
  adyenClientKeyFromFrameUrl,
  isAdyenSecuredFieldsFrameUrl,
  isAdyenSecuredFieldsPayment,
  redactHeld,
  textHoldsPlaceholderNumber,
  withAdyenEncryptedFields,
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

describe("adyenClientKeyFromFrameUrl", () => {
  it("reads the key from a secured-field iframe on an adyen.com host", () => {
    expect(
      adyenClientKeyFromFrameUrl(
        "https://checkoutshopper-test.adyen.com/checkoutshopper/securedfields/test_ABC123XYZ/6.4.1/securedFields.html?type=card&d=aHR0cA",
      ),
    ).toBe("test_ABC123XYZ");
    expect(
      adyenClientKeyFromFrameUrl(
        "https://checkoutshopper-live-us.adyen.com/checkoutshopper/securedfields/live_Q1W2E3/5.0.0/securedFields.html",
      ),
    ).toBe("live_Q1W2E3");
  });

  it("ignores other hosts, plain http, other paths and malformed keys", () => {
    for (const url of [
      "https://adyen.com.evil.example/checkoutshopper/securedfields/test_ABC/6.4.1/securedFields.html",
      "https://evil-adyen.com/checkoutshopper/securedfields/test_ABC/6.4.1/securedFields.html",
      "http://checkoutshopper-test.adyen.com/checkoutshopper/securedfields/test_ABC/6.4.1/securedFields.html",
      "https://checkoutshopper-test.adyen.com/checkoutshopper/v1/clientKeys/test_ABC",
      "https://checkoutshopper-test.adyen.com/checkoutshopper/securedfields/test_abc/6.4.1/securedFields.html",
      "https://checkoutshopper-test.adyen.com/checkoutshopper/securedfields/pub.v2.ABC/6.4.1/securedFields.html",
      "not a url",
      "",
    ]) {
      expect(adyenClientKeyFromFrameUrl(url)).toBeUndefined();
    }
  });
  it("tells a secured-field iframe apart from other frames even without a readable key", () => {
    expect(
      isAdyenSecuredFieldsFrameUrl(
        "https://checkoutshopper-live.adyen.com/checkoutshopper/securedfields/pub.v2.ABC/6.4.1/securedFields.html",
      ),
    ).toBe(true);
    for (const url of [
      "https://js.stripe.com/v3/elements-inner-card.html",
      "https://checkoutshopper-test.adyen.com/checkoutshopper/v3/analytics",
      "http://checkoutshopper-test.adyen.com/checkoutshopper/securedfields/test_ABC/6.4.1/securedFields.html",
      "https://adyen.com.evil.example/checkoutshopper/securedfields/test_ABC/6.4.1/securedFields.html",
      "https://shop.example/checkout",
    ]) {
      expect(isAdyenSecuredFieldsFrameUrl(url)).toBe(false);
    }
  });
});

describe("Adyen secured-fields payment bodies", () => {
  const BODY = JSON.stringify({
    amount: { currency: "EUR", value: 1000 },
    reference: "order-1",
    paymentMethod: {
      type: "scheme",
      holderName: "J. Smith",
      encryptedCardNumber: "eyJ.standin-number",
      encryptedExpiryMonth: "eyJ.standin-month",
      encryptedExpiryYear: "eyJ.standin-year",
      encryptedSecurityCode: "eyJ.standin-cvc",
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

  it("replaces the four encrypted fields and keeps everything else", () => {
    const swapped = JSON.parse(
      withAdyenEncryptedFields(BODY, {
        encryptedCardNumber: "eyJ.real-number",
        encryptedExpiryMonth: "eyJ.real-month",
        encryptedExpiryYear: "eyJ.real-year",
        encryptedSecurityCode: "eyJ.real-cvc",
      }),
    );
    const original = JSON.parse(BODY);
    expect(swapped).toStrictEqual({
      ...original,
      paymentMethod: {
        ...original.paymentMethod,
        encryptedCardNumber: "eyJ.real-number",
        encryptedExpiryMonth: "eyJ.real-month",
        encryptedExpiryYear: "eyJ.real-year",
        encryptedSecurityCode: "eyJ.real-cvc",
      },
    });
    expect(Object.keys(swapped)).toStrictEqual(Object.keys(original));
  });
});
