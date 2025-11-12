/**
 * Tests for MCP payment error detection (x402 protocol)
 */

import {
  isMCPPaymentError,
  extractPaymentFromMCPError,
  convertX402ToSapiomPayment,
  getPaymentAuthFromTransaction,
} from "./payment-detection";

describe("isMCPPaymentError", () => {
  it("detects x402 error from JSON message", () => {
    const error = {
      message: JSON.stringify({
        x402Version: 1,
        accepts: [{ scheme: "exact", amount: "1000000" }],
      }),
    };

    expect(isMCPPaymentError(error)).toBe(true);
  });

  it("detects x402 from string indicators", () => {
    const error1 = { message: "Payment required - x402Version: 1" };
    expect(isMCPPaymentError(error1)).toBe(true);

    const error2 = { message: "Payment required for this resource" };
    expect(isMCPPaymentError(error2)).toBe(true);

    const error3 = { message: "Resource requires payment_required" };
    expect(isMCPPaymentError(error3)).toBe(true);
  });

  it("detects x402 from status code", () => {
    const error1 = { message: "Error", code: 402 };
    expect(isMCPPaymentError(error1)).toBe(true);

    const error2 = { message: "Error", statusCode: 402 };
    expect(isMCPPaymentError(error2)).toBe(true);
  });

  it("returns false for non-payment errors", () => {
    expect(isMCPPaymentError({ message: "Regular error" })).toBe(false);
    expect(isMCPPaymentError({ message: "Not found", code: 404 })).toBe(false);
    expect(isMCPPaymentError("string error")).toBe(false);
    expect(isMCPPaymentError(null)).toBe(false);
    expect(isMCPPaymentError(undefined)).toBe(false);
  });
});

describe("extractPaymentFromMCPError", () => {
  it("extracts from structured content", () => {
    const error = {
      message: "Payment required",
      structuredContent: {
        x402Version: 1,
        accepts: [
          {
            scheme: "exact",
            amount: "5000000",
            unit: "sats",
            to: "bc1q...",
          },
        ],
      },
    };

    const result = extractPaymentFromMCPError(error);

    expect(result).toEqual({
      x402Version: 1,
      accepts: [
        {
          scheme: "exact",
          amount: "5000000",
          unit: "sats",
          to: "bc1q...",
        },
      ],
    });
  });

  it("extracts from JSON message", () => {
    const paymentData = {
      x402Version: 1,
      accepts: [{ scheme: "range", minAmount: "100", maxAmount: "1000" }],
    };

    const error = {
      message: JSON.stringify(paymentData),
    };

    const result = extractPaymentFromMCPError(error);

    expect(result).toEqual(paymentData);
  });

  it("extracts from error.data property", () => {
    const paymentData = {
      x402Version: 1,
      accepts: [{ scheme: "exact", amount: "500" }],
    };

    const error = {
      message: "Payment required",
      data: JSON.stringify(paymentData),
    };

    const result = extractPaymentFromMCPError(error);

    expect(result).toEqual(paymentData);
  });

  it("extracts from error.data object", () => {
    const paymentData = {
      x402Version: 1,
      accepts: [{ scheme: "exact", amount: "500" }],
    };

    const error = {
      message: "Payment required",
      data: paymentData,
    };

    const result = extractPaymentFromMCPError(error);

    expect(result).toEqual(paymentData);
  });

  it("throws if payment data cannot be extracted", () => {
    const error = { message: "Not a payment error" };

    expect(() => extractPaymentFromMCPError(error)).toThrow(
      /Failed to extract x402 payment data/,
    );
  });
});

describe("convertX402ToSapiomPayment", () => {
  it("converts exact payment scheme", () => {
    const x402 = {
      x402Version: 1,
      accepts: [
        {
          scheme: "exact",
          amount: "1000000",
          unit: "sats",
          to: "bc1qaddress",
        },
      ],
    };

    const result = convertX402ToSapiomPayment(x402);

    expect(result).toEqual({
      protocol: "x402",
      version: 1,
      scheme: "exact",
      amount: "1000000",
      unit: "sats",
      destination: "bc1qaddress",
      minAmount: undefined,
      maxAmount: undefined,
      metadata: {
        scheme: "exact",
        amount: "1000000",
        unit: "sats",
        to: "bc1qaddress",
        allAcceptedMethods: x402.accepts,
      },
    });
  });

  it("converts range payment scheme", () => {
    const x402 = {
      x402Version: 1,
      accepts: [
        {
          scheme: "range",
          minAmount: "100",
          maxAmount: "5000",
          unit: "USD",
        },
      ],
    };

    const result = convertX402ToSapiomPayment(x402);

    expect(result.scheme).toBe("range");
    expect(result.minAmount).toBe("100");
    expect(result.maxAmount).toBe("5000");
    expect(result.unit).toBe("USD");
  });

  it("defaults unit to USD if not provided", () => {
    const x402 = {
      x402Version: 1,
      accepts: [{ scheme: "exact", amount: "100" }],
    };

    const result = convertX402ToSapiomPayment(x402);

    expect(result.unit).toBe("USD");
  });

  it("includes all accepted methods in metadata", () => {
    const x402 = {
      x402Version: 1,
      accepts: [
        { scheme: "exact", amount: "100" },
        { scheme: "range", minAmount: "50", maxAmount: "200" },
      ],
    };

    const result = convertX402ToSapiomPayment(x402);

    expect(result.metadata.allAcceptedMethods).toEqual(x402.accepts);
  });
});

describe("getPaymentAuthFromTransaction", () => {
  it("returns string authorizationPayload as-is", () => {
    const tx = {
      id: "tx-123",
      payment: {
        authorizationPayload: "pre-encoded-payment-auth-string",
      },
    };

    const result = getPaymentAuthFromTransaction(tx);

    expect(result).toBe("pre-encoded-payment-auth-string");
  });

  it("encodes object authorizationPayload as base64 JSON", () => {
    const tx = {
      id: "tx-123",
      payment: {
        authorizationPayload: {
          signature: "sig123",
          timestamp: 1234567890,
          paymentId: "pay-456",
        },
      },
    };

    const result = getPaymentAuthFromTransaction(tx);

    // Decode to verify
    const decoded = JSON.parse(Buffer.from(result, "base64").toString());
    expect(decoded).toEqual({
      signature: "sig123",
      timestamp: 1234567890,
      paymentId: "pay-456",
    });
  });

  it("throws if authorizationPayload is missing", () => {
    const tx1 = { id: "tx-123", payment: {} };
    expect(() => getPaymentAuthFromTransaction(tx1)).toThrow(
      /missing payment\.authorizationPayload/,
    );

    const tx2 = { id: "tx-123" };
    expect(() => getPaymentAuthFromTransaction(tx2)).toThrow(
      /missing payment\.authorizationPayload/,
    );
  });
});
