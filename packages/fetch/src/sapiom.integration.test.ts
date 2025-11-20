/**
 * Integration tests for Sapiom Fetch implementation
 * Tests combined authorization + payment flow
 */
import { createSapiomFetch } from "./fetch";
import { SapiomClient } from "@sapiom/core";
import { TransactionAPI } from "@sapiom/core";

describe("Sapiom Fetch Integration Tests", () => {
  let mockTransactionAPI: jest.Mocked<TransactionAPI>;
  let mockSapiomClient: SapiomClient;

  beforeEach(() => {
    mockTransactionAPI = {
      create: jest.fn(),
      get: jest.fn(),
      reauthorizeWithPayment: jest.fn(),
      list: jest.fn(),
      isAuthorized: jest.fn(),
      isCompleted: jest.fn(),
      requiresPayment: jest.fn(),
      getPaymentDetails: jest.fn(),
    } as any;

    mockSapiomClient = {
      transactions: mockTransactionAPI,
    } as any;
  });

  it("should create Sapiom-enabled fetch function", () => {
    const fetch = createSapiomFetch({
      sapiomClient: mockSapiomClient,
    });

    expect(fetch).toBeDefined();
    expect(typeof fetch).toBe("function");
    expect((fetch as any).__sapiomClient).toBe(mockSapiomClient);
  });

  it("should create fetch with authorization config", () => {
    const onAuthorizationSuccess = jest.fn();

    const fetch = createSapiomFetch({
      sapiomClient: mockSapiomClient,
      authorization: {
        authorizedEndpoints: [
          {
            pathPattern: /^\/api\/premium\//,
            serviceName: "premium-api",
          },
        ],
        onAuthorizationSuccess,
      },
    });

    expect(fetch).toBeDefined();
  });

  it("should create fetch with payment config", () => {
    const onPaymentRequired = jest.fn();

    const fetch = createSapiomFetch({
      sapiomClient: mockSapiomClient,
      payment: {
        onPaymentRequired,
      },
    });

    expect(fetch).toBeDefined();
  });
});
