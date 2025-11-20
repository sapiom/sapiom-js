import { createSapiomFetch } from "./fetch";
import { SapiomClient, TransactionAPI } from "@sapiom/core";

describe("createSapiomFetch", () => {
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

  it("should create a fetch function", () => {
    const fetch = createSapiomFetch({
      sapiomClient: mockSapiomClient,
    });

    expect(typeof fetch).toBe("function");
  });

  it("should attach sapiomClient to fetch function", () => {
    const fetch = createSapiomFetch({
      sapiomClient: mockSapiomClient,
    });

    expect((fetch as any).__sapiomClient).toBe(mockSapiomClient);
  });

  it("should create fetch with default metadata", () => {
    const fetch = createSapiomFetch({
      sapiomClient: mockSapiomClient,
      agentName: "test-agent",
      agentId: "agent-123",
      serviceName: "test-service",
    });

    expect(fetch).toBeDefined();
  });
});
