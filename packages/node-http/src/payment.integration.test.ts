/**
 * Integration tests for Payment with Node-HTTP
 * Detailed payment handler tests are in @sapiom/core
 */
import { createSapiomNodeHttp } from "./node-http";
import { SapiomClient, TransactionAPI } from "@sapiom/core";

describe("Payment Integration - Node-HTTP", () => {
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

  it("should create client with payment enabled", () => {
    const client = createSapiomNodeHttp({
      sapiomClient: mockSapiomClient,
      payment: {
        enabled: true,
        onPaymentRequired: jest.fn(),
      },
    });

    expect(client).toBeDefined();
  });

  it("should create client with payment disabled", () => {
    const client = createSapiomNodeHttp({
      sapiomClient: mockSapiomClient,
      payment: {
        enabled: false,
      },
    });

    expect(client).toBeDefined();
  });
});
