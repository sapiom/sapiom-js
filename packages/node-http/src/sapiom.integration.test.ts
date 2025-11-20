/**
 * Integration tests for Sapiom Node-HTTP implementation
 * Tests combined authorization + payment flow
 */
import { createSapiomNodeHttp } from "./node-http";
import { SapiomClient } from "@sapiom/core";
import { TransactionAPI } from "@sapiom/core";

describe("Sapiom Node-HTTP Integration Tests", () => {
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

  it("should create Sapiom-enabled HTTP client", () => {
    const client = createSapiomNodeHttp({
      sapiomClient: mockSapiomClient,
    });

    expect(client).toBeDefined();
    expect(typeof client.request).toBe("function");
    expect(client.__sapiomClient).toBe(mockSapiomClient);
  });

  it("should create client with authorization config", () => {
    const onAuthorizationSuccess = jest.fn();

    const client = createSapiomNodeHttp({
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

    expect(client).toBeDefined();
  });

  it("should create client with payment config", () => {
    const onPaymentRequired = jest.fn();

    const client = createSapiomNodeHttp({
      sapiomClient: mockSapiomClient,
      payment: {
        onPaymentRequired,
      },
    });

    expect(client).toBeDefined();
  });
});
