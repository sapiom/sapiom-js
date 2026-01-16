import {
  X402PaymentRequirementV1,
  X402PaymentRequirementV2,
  X402ResponseV1,
  X402ResponseV2,
  X402PaymentRequirement,
  X402Response,
  isV1Response,
  isV2Response,
  isV1Requirement,
  isV2Requirement,
  getPaymentAmount,
  getResourceUrl,
  getX402Version,
} from "./transaction";

// ============================================================================
// Test Fixtures
// ============================================================================

const v1Requirement: X402PaymentRequirementV1 = {
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
};

const v2Requirement: X402PaymentRequirementV2 = {
  scheme: "exact",
  network: "sapiom:main",
  amount: "1000000",
  payTo: "sapiom:tenant:abc123",
  maxTimeoutSeconds: 300,
  asset: "USD",
  extra: {},
};

const v1Response: X402ResponseV1 = {
  x402Version: 1,
  accepts: [v1Requirement],
};

const v2Response: X402ResponseV2 = {
  x402Version: 2,
  resource: {
    url: "https://api.example.com/resource",
    description: "API call",
    mimeType: "application/json",
  },
  accepts: [v2Requirement],
};

// ============================================================================
// Response Type Guard Tests
// ============================================================================

describe("isV2Response", () => {
  it("returns true for V2 response format", () => {
    expect(isV2Response(v2Response)).toBe(true);
  });

  it("returns false for V1 response format", () => {
    expect(isV2Response(v1Response)).toBe(false);
  });

  it("narrows type correctly", () => {
    const response: X402Response = v2Response;
    if (isV2Response(response)) {
      // TypeScript should know this is X402ResponseV2
      expect(response.resource.url).toBe("https://api.example.com/resource");
    }
  });
});

describe("isV1Response", () => {
  it("returns true for V1 response format", () => {
    expect(isV1Response(v1Response)).toBe(true);
  });

  it("returns false for V2 response format", () => {
    expect(isV1Response(v2Response)).toBe(false);
  });

  it("narrows type correctly", () => {
    const response: X402Response = v1Response;
    if (isV1Response(response)) {
      // TypeScript should know this is X402ResponseV1
      expect(response.accepts[0].resource).toBe(
        "https://api.example.com/resource",
      );
    }
  });
});

// ============================================================================
// Requirement Type Guard Tests
// ============================================================================

describe("isV2Requirement", () => {
  it("returns true for V2 requirement (has amount)", () => {
    expect(isV2Requirement(v2Requirement)).toBe(true);
  });

  it("returns false for V1 requirement (has maxAmountRequired)", () => {
    expect(isV2Requirement(v1Requirement)).toBe(false);
  });

  it("narrows type correctly", () => {
    const req: X402PaymentRequirement = v2Requirement;
    if (isV2Requirement(req)) {
      // TypeScript should know this is X402PaymentRequirementV2
      expect(req.amount).toBe("1000000");
    }
  });
});

describe("isV1Requirement", () => {
  it("returns true for V1 requirement (has maxAmountRequired)", () => {
    expect(isV1Requirement(v1Requirement)).toBe(true);
  });

  it("returns false for V2 requirement (has amount)", () => {
    expect(isV1Requirement(v2Requirement)).toBe(false);
  });

  it("narrows type correctly", () => {
    const req: X402PaymentRequirement = v1Requirement;
    if (isV1Requirement(req)) {
      // TypeScript should know this is X402PaymentRequirementV1
      expect(req.maxAmountRequired).toBe("1000000");
    }
  });
});

// ============================================================================
// Helper Function Tests
// ============================================================================

describe("getPaymentAmount", () => {
  it("extracts amount from V2 requirement", () => {
    expect(getPaymentAmount(v2Requirement)).toBe("1000000");
  });

  it("extracts maxAmountRequired from V1 requirement", () => {
    expect(getPaymentAmount(v1Requirement)).toBe("1000000");
  });

  it("works with union type", () => {
    const requirements: X402PaymentRequirement[] = [v1Requirement, v2Requirement];
    requirements.forEach((req) => {
      expect(getPaymentAmount(req)).toBe("1000000");
    });
  });
});

describe("getResourceUrl", () => {
  it("extracts from resource object for V2", () => {
    expect(getResourceUrl(v2Response)).toBe("https://api.example.com/resource");
  });

  it("extracts from accepts[0].resource for V1", () => {
    expect(getResourceUrl(v1Response)).toBe("https://api.example.com/resource");
  });

  it("returns undefined for V1 with empty accepts", () => {
    const emptyV1: X402ResponseV1 = {
      x402Version: 1,
      accepts: [],
    };
    expect(getResourceUrl(emptyV1)).toBeUndefined();
  });
});

describe("getX402Version", () => {
  it("returns 1 for V1 response", () => {
    expect(getX402Version(v1Response)).toBe(1);
  });

  it("returns 2 for V2 response", () => {
    expect(getX402Version(v2Response)).toBe(2);
  });
});
