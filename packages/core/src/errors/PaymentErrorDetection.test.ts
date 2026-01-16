import { PaymentRequiredError, X402PaymentResponse } from "./PaymentErrorDetection";
import { X402ResponseV1, X402ResponseV2 } from "../types/transaction";

// ============================================================================
// Test Fixtures
// ============================================================================

const v1Response: X402ResponseV1 = {
  x402Version: 1,
  accepts: [
    {
      scheme: "exact",
      network: "sapiom",
      maxAmountRequired: "1000000",
      resource: "https://api.example.com/resource",
      description: "API call",
      mimeType: "application/json",
      payTo: "sapiom:tenant:abc123",
      maxTimeoutSeconds: 300,
      asset: "USD",
      extra: null,
    },
  ],
};

const v2Response: X402ResponseV2 = {
  x402Version: 2,
  resource: {
    url: "https://api.example.com/resource",
    description: "API call",
    mimeType: "application/json",
  },
  accepts: [
    {
      scheme: "exact",
      network: "sapiom:main",
      amount: "1000000",
      payTo: "sapiom:tenant:abc123",
      maxTimeoutSeconds: 300,
      asset: "USD",
      extra: {},
    },
  ],
};

// ============================================================================
// PaymentRequiredError Tests
// ============================================================================

describe("PaymentRequiredError", () => {
  describe("x402Version property", () => {
    it("exposes x402Version from V1 response", () => {
      const error = new PaymentRequiredError(
        "Payment required",
        v1Response as X402PaymentResponse,
        "https://api.example.com/resource",
      );
      expect(error.x402Version).toBe(1);
    });

    it("exposes x402Version from V2 response", () => {
      const error = new PaymentRequiredError(
        "Payment required",
        v2Response as X402PaymentResponse,
        "https://api.example.com/resource",
      );
      expect(error.x402Version).toBe(2);
    });
  });

  describe("isV2() method", () => {
    it("returns true for V2 errors", () => {
      const error = new PaymentRequiredError(
        "Payment required",
        v2Response as X402PaymentResponse,
        "https://api.example.com/resource",
      );
      expect(error.isV2()).toBe(true);
    });

    it("returns false for V1 errors", () => {
      const error = new PaymentRequiredError(
        "Payment required",
        v1Response as X402PaymentResponse,
        "https://api.example.com/resource",
      );
      expect(error.isV2()).toBe(false);
    });
  });

  describe("isV1() method", () => {
    it("returns true for V1 errors", () => {
      const error = new PaymentRequiredError(
        "Payment required",
        v1Response as X402PaymentResponse,
        "https://api.example.com/resource",
      );
      expect(error.isV1()).toBe(true);
    });

    it("returns false for V2 errors", () => {
      const error = new PaymentRequiredError(
        "Payment required",
        v2Response as X402PaymentResponse,
        "https://api.example.com/resource",
      );
      expect(error.isV1()).toBe(false);
    });
  });

  describe("error properties", () => {
    it("preserves message, resource, and transactionId", () => {
      const error = new PaymentRequiredError(
        "Custom message",
        v2Response as X402PaymentResponse,
        "https://api.example.com/resource",
        "txn_123",
      );
      expect(error.message).toBe("Custom message");
      expect(error.resource).toBe("https://api.example.com/resource");
      expect(error.transactionId).toBe("txn_123");
      expect(error.name).toBe("PaymentRequiredError");
    });

    it("preserves full x402Response object", () => {
      const error = new PaymentRequiredError(
        "Payment required",
        v2Response as X402PaymentResponse,
        "https://api.example.com/resource",
      );
      expect(error.x402Response).toBe(v2Response);
    });
  });
});
