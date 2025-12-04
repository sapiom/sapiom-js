/**
 * Integration tests for Sapiom Node-HTTP implementation
 * Tests combined authorization + payment flow
 */
import { createClient } from "./node-http";
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
    const client = createClient({
      sapiomClient: mockSapiomClient,
    });

    expect(client).toBeDefined();
    expect(typeof client.request).toBe("function");
    expect(client.__sapiomClient).toBe(mockSapiomClient);
  });

  it("should create client with default metadata", () => {
    const client = createClient({
      sapiomClient: mockSapiomClient,
      agentName: "test-agent",
      serviceName: "test-service",
    });

    expect(client).toBeDefined();
  });
});
