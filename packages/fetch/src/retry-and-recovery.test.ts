/**
 * Tests for:
 * 1. handlePayment on-demand transaction creation (402 cascade fix)
 * 2. failureMode open/closed behavior
 * 3. Configurable polling intervals
 *
 * NOTE: Retry logic (exponential backoff, idempotency keys) has moved to
 * @sapiom/core HttpClient and is tested in SapiomClient.test.ts.
 * These tests mock TransactionAPI.create() which bypasses HttpClient,
 * so retry behavior is not exercised here.
 */
import { createFetch } from "./fetch";
import { SapiomClient, TransactionAPI } from "@sapiom/core";
import fetchMock from "@fetch-mock/jest";

/** Simulates a 5xx error as thrown by HttpClient */
function server500Error(msg = "Internal Server Error") {
  return new Error(`Request failed with status 500: ${msg}`);
}

describe("handlePayment on-demand transaction creation (402 cascade fix)", () => {
  let mockTransactionAPI: jest.Mocked<TransactionAPI>;
  let mockSapiomClient: SapiomClient;

  const x402Body = {
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: "base",
        maxAmountRequired: "1000000",
        resource: "https://api.example.com/premium",
        payTo: "0x123",
        asset: "0xUSDC",
      },
    ],
  };

  beforeAll(() => {
    fetchMock.mockGlobal();
  });

  beforeEach(() => {
    mockTransactionAPI = {
      create: jest.fn(),
      get: jest.fn(),
      reauthorizeWithPayment: jest.fn(),
      complete: jest.fn(),
      list: jest.fn(),
      isAuthorized: jest.fn(),
      isCompleted: jest.fn(),
      requiresPayment: jest.fn(),
      getPaymentDetails: jest.fn(),
    } as any;

    mockSapiomClient = {
      transactions: mockTransactionAPI,
    } as any;

    fetchMock.removeRoutes();
  });

  afterAll(() => {
    fetchMock.unmockGlobal();
  });

  it("should create on-demand transaction when 402 received without transaction ID", async () => {
    // handleAuthorization: create fails → failureMode open, request sent without txn ID
    // Server returns 402
    // handlePayment: creates on-demand transaction, reauthorizes, retries with payment header
    mockTransactionAPI.create
      .mockRejectedValueOnce(server500Error())
      // On-demand creation in handlePayment
      .mockResolvedValueOnce({
        id: "tx_ondemand",
        status: "authorized",
      } as any);

    mockTransactionAPI.reauthorizeWithPayment.mockResolvedValueOnce({
      id: "tx_ondemand",
      status: "authorized",
      payment: {
        authorizationPayload: "payment-token-123",
      },
    } as any);

    mockTransactionAPI.complete.mockResolvedValue({} as any);

    fetchMock.getOnce("https://api.example.com/premium", {
      status: 402,
      body: x402Body,
    });
    fetchMock.get("https://api.example.com/premium", {
      status: 200,
      body: { data: "premium-content" },
    });

    const fetch = createFetch({
      sapiomClient: mockSapiomClient,
      failureMode: "open",
    });

    const response = await fetch("https://api.example.com/premium");
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ data: "premium-content" });

    // 1 failed attempt in handleAuthorization + 1 on-demand in handlePayment
    expect(mockTransactionAPI.create).toHaveBeenCalledTimes(2);
    expect(mockTransactionAPI.reauthorizeWithPayment).toHaveBeenCalledWith(
      "tx_ondemand",
      expect.objectContaining({
        x402: expect.any(Object),
      }),
    );
  });

  it("should return raw 402 when on-demand creation also fails in failureMode open", async () => {
    mockTransactionAPI.create.mockRejectedValue(server500Error());

    fetchMock.get("https://api.example.com/premium", {
      status: 402,
      body: x402Body,
    });

    const fetch = createFetch({
      sapiomClient: mockSapiomClient,
      failureMode: "open",
    });

    const response = await fetch("https://api.example.com/premium");
    expect(response.status).toBe(402);
  });

  it("should throw when creation fails in failureMode closed", async () => {
    mockTransactionAPI.create.mockRejectedValue(server500Error());

    fetchMock.get("https://api.example.com/premium", {
      status: 402,
      body: x402Body,
    });

    const fetch = createFetch({
      sapiomClient: mockSapiomClient,
      failureMode: "closed",
    });

    // In closed mode, handleAuthorization itself throws before we get to the 402
    await expect(
      fetch("https://api.example.com/premium"),
    ).rejects.toThrow("Request failed with status 500");
  });

  it("should work normally when transaction ID exists (no on-demand creation)", async () => {
    mockTransactionAPI.create.mockResolvedValueOnce({
      id: "tx_normal",
      status: "authorized",
    } as any);

    mockTransactionAPI.reauthorizeWithPayment.mockResolvedValueOnce({
      id: "tx_normal",
      status: "authorized",
      payment: {
        authorizationPayload: "payment-token-456",
      },
    } as any);

    mockTransactionAPI.complete.mockResolvedValue({} as any);

    fetchMock.getOnce("https://api.example.com/premium", {
      status: 402,
      body: x402Body,
    });
    fetchMock.get("https://api.example.com/premium", {
      status: 200,
      body: { data: "premium-content" },
    });

    const fetch = createFetch({
      sapiomClient: mockSapiomClient,
    });

    const response = await fetch("https://api.example.com/premium");
    expect(response.status).toBe(200);

    // Only 1 create call (from handleAuthorization), no on-demand creation
    expect(mockTransactionAPI.create).toHaveBeenCalledTimes(1);
    expect(mockTransactionAPI.reauthorizeWithPayment).toHaveBeenCalledWith(
      "tx_normal",
      expect.objectContaining({
        x402: expect.any(Object),
      }),
    );
  });

  it("should include onDemandPayment metadata in on-demand transaction", async () => {
    mockTransactionAPI.create
      .mockRejectedValueOnce(server500Error())
      .mockResolvedValueOnce({
        id: "tx_ondemand",
        status: "authorized",
      } as any);

    mockTransactionAPI.reauthorizeWithPayment.mockResolvedValueOnce({
      id: "tx_ondemand",
      status: "authorized",
      payment: { authorizationPayload: "token" },
    } as any);

    mockTransactionAPI.complete.mockResolvedValue({} as any);

    fetchMock.getOnce("https://api.example.com/premium", {
      status: 402,
      body: x402Body,
    });
    fetchMock.get("https://api.example.com/premium", {
      status: 200,
      body: { data: "ok" },
    });

    const fetch = createFetch({
      sapiomClient: mockSapiomClient,
      failureMode: "open",
    });

    await fetch("https://api.example.com/premium");

    // The 2nd create call (on-demand) should have onDemandPayment metadata
    const onDemandCall = mockTransactionAPI.create.mock.calls[1]![0];
    expect(onDemandCall.metadata).toEqual(
      expect.objectContaining({
        onDemandPayment: true,
      }),
    );
  });
});

describe("Configurable polling", () => {
  let mockTransactionAPI: jest.Mocked<TransactionAPI>;
  let mockSapiomClient: SapiomClient;

  beforeEach(() => {
    mockTransactionAPI = {
      create: jest.fn(),
      get: jest.fn(),
      reauthorizeWithPayment: jest.fn(),
      complete: jest.fn(),
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

  it("should accept custom polling configuration", () => {
    const fetch = createFetch({
      sapiomClient: mockSapiomClient,
      polling: { timeout: 10000, pollInterval: 500 },
    });

    expect(typeof fetch).toBe("function");
  });
});
