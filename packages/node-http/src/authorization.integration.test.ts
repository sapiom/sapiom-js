/**
 * Integration tests for Authorization with Node-HTTP
 * Detailed authorization handler tests are in @sapiom/core
 */
import { createSapiomNodeHttp } from "./node-http";
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

  it("should create client with authorization enabled", () => {
    const client = createSapiomNodeHttp({
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

    expect(client).toBeDefined();
  });

  it("should create client with authorization disabled", () => {
    const client = createSapiomNodeHttp({
      sapiomClient: mockSapiomClient,
      authorization: {
        enabled: false,
      },
    });

    expect(client).toBeDefined();
  });
});
