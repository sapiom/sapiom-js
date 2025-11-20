/**
 * Integration tests for Authorization with Fetch
 * Detailed authorization handler tests are in @sapiom/core
 */
import { createSapiomFetch } from "./fetch";
import { SapiomClient, TransactionAPI } from "@sapiom/core";

describe("Authorization Integration - Fetch", () => {
  let mockSapiomClient: SapiomClient;

  beforeEach(() => {
    const mockTransactionAPI: jest.Mocked<TransactionAPI> = {
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

  it("should create fetch with authorization enabled", () => {
    const fetch = createSapiomFetch({
      sapiomClient: mockSapiomClient,
      authorization: {
        enabled: true,
        authorizedEndpoints: [
          {
            pathPattern: /^\/api/,
            serviceName: "test-service",
          },
        ],
      },
    });

    expect(fetch).toBeDefined();
  });

  it("should create fetch with authorization disabled", () => {
    const fetch = createSapiomFetch({
      sapiomClient: mockSapiomClient,
      authorization: {
        enabled: false,
      },
    });

    expect(fetch).toBeDefined();
  });
});
