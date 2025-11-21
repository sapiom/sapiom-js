/**
 * Integration tests for Authorization with Node-HTTP
 * Detailed authorization handler tests are in @sapiom/core
 */
import { createClient } from "./node-http";
import { SapiomClient, TransactionAPI } from "@sapiom/core";

describe("Authorization Integration - Node-HTTP", () => {
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

  it("should create client with Sapiom client", () => {
    const client = createClient({
      sapiomClient: mockSapiomClient,
    });

    expect(client).toBeDefined();
  });
});
