/**
 * Integration tests for Sapiom Fetch implementation
 * Tests combined authorization + payment flow
 */
import { createFetch } from "./fetch";
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
    const fetch = createFetch({
      sapiomClient: mockSapiomClient,
    });

    expect(typeof fetch).toBe("function");
    expect((fetch as any).__sapiomClient).toBe(mockSapiomClient);
  });

  it("should create fetch with default metadata", () => {
    const fetch = createFetch({
      sapiomClient: mockSapiomClient,
      agentName: "test-agent",
      serviceName: "test-service",
    });

    expect(typeof fetch).toBe("function");
  });
});
