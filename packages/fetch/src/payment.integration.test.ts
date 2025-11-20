/**
 * Integration tests for Payment with Fetch
 * Detailed payment handler tests are in @sapiom/core
 */
import { createSapiomFetch } from "./fetch";
import { SapiomClient, TransactionAPI } from "@sapiom/core";

describe("Payment Integration - Fetch", () => {
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

  it("should create fetch with payment enabled", () => {
    const fetch = createSapiomFetch({
      sapiomClient: mockSapiomClient,
      payment: {
        enabled: true,
        onPaymentRequired: jest.fn(),
      },
    });

    expect(fetch).toBeDefined();
  });

  it("should create fetch with payment disabled", () => {
    const fetch = createSapiomFetch({
      sapiomClient: mockSapiomClient,
      payment: {
        enabled: false,
      },
    });

    expect(fetch).toBeDefined();
  });
});
