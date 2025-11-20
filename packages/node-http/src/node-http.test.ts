import { createSapiomNodeHttp } from "./node-http";
import { SapiomClient, TransactionAPI } from "@sapiom/core";

describe("createSapiomNodeHttp", () => {
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

  it("should create an HTTP client adapter", () => {
    const client = createSapiomNodeHttp({
      sapiomClient: mockSapiomClient,
    });

    expect(client).toBeDefined();
    expect(typeof client.request).toBe("function");
  });

  it("should attach sapiomClient to adapter", () => {
    const client = createSapiomNodeHttp({
      sapiomClient: mockSapiomClient,
    });

    expect(client.__sapiomClient).toBe(mockSapiomClient);
  });

  it("should create client with default metadata", () => {
    const client = createSapiomNodeHttp({
      sapiomClient: mockSapiomClient,
      agentName: "test-agent",
      agentId: "agent-123",
      serviceName: "test-service",
    });

    expect(client).toBeDefined();
  });

  it("should throw error when calling addRequestInterceptor", () => {
    const client = createSapiomNodeHttp({
      sapiomClient: mockSapiomClient,
    });

    expect(() => {
      client.addRequestInterceptor(() => ({}) as any);
    }).toThrow("addRequestInterceptor is not supported");
  });

  it("should throw error when calling addResponseInterceptor", () => {
    const client = createSapiomNodeHttp({
      sapiomClient: mockSapiomClient,
    });

    expect(() => {
      client.addResponseInterceptor(() => ({}) as any);
    }).toThrow("addResponseInterceptor is not supported");
  });
});
