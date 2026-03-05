/**
 * Tests for:
 * 1. Transaction creation retry with exponential backoff
 * 2. Error classification (only retry 5xx/network, not 4xx/timeouts)
 * 3. handlePayment on-demand transaction creation (402 cascade fix)
 * 4. Idempotency key on retried transaction creation
 * 5. withRetry validation
 * 6. Configurable polling intervals
 */
import { createFetch } from "./fetch";
import { SapiomClient, TransactionAPI } from "@sapiom/core";
import fetchMock from "@fetch-mock/jest";

// Minimal retry config for fast tests
const FAST_RETRY = { maxAttempts: 3, baseDelayMs: 10 };

/** Simulates a 5xx error as thrown by HttpClient */
function server500Error(msg = "Internal Server Error") {
  return new Error(`Request failed with status 500: ${msg}`);
}

/** Simulates a 4xx error as thrown by HttpClient */
function client400Error(status = 400, msg = "Bad Request") {
  return new Error(`Request failed with status ${status}: ${msg}`);
}

/** Simulates a timeout error as thrown by HttpClient */
function timeoutError(ms = 30000) {
  return new Error(`Request timeout after ${ms}ms`);
}

/** Simulates a network error (DNS / connection refused) */
function networkError(msg = "fetch failed") {
  return new TypeError(msg);
}

describe("Transaction creation retry logic", () => {
  let mockTransactionAPI: jest.Mocked<TransactionAPI>;
  let mockSapiomClient: SapiomClient;

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

  it("should retry on 5xx and succeed on 2nd attempt", async () => {
    fetchMock.get("https://api.example.com/test", {
      status: 200,
      body: { data: "success" },
    });

    mockTransactionAPI.create
      .mockRejectedValueOnce(server500Error())
      .mockResolvedValueOnce({
        id: "tx_retry",
        status: "authorized",
      } as any);
    mockTransactionAPI.complete.mockResolvedValue({} as any);

    const fetch = createFetch({
      sapiomClient: mockSapiomClient,
      retry: FAST_RETRY,
    });

    const response = await fetch("https://api.example.com/test");
    expect(response.status).toBe(200);
    expect(mockTransactionAPI.create).toHaveBeenCalledTimes(2);
  });

  it("should retry on network errors (TypeError)", async () => {
    fetchMock.get("https://api.example.com/test", {
      status: 200,
      body: { data: "success" },
    });

    mockTransactionAPI.create
      .mockRejectedValueOnce(networkError("ECONNREFUSED"))
      .mockResolvedValueOnce({
        id: "tx_net",
        status: "authorized",
      } as any);
    mockTransactionAPI.complete.mockResolvedValue({} as any);

    const fetch = createFetch({
      sapiomClient: mockSapiomClient,
      retry: FAST_RETRY,
    });

    const response = await fetch("https://api.example.com/test");
    expect(response.status).toBe(200);
    expect(mockTransactionAPI.create).toHaveBeenCalledTimes(2);
  });

  it("should NOT retry on 4xx errors - throw immediately", async () => {
    fetchMock.get("https://api.example.com/test", {
      status: 200,
      body: { data: "success" },
    });

    mockTransactionAPI.create.mockRejectedValueOnce(client400Error(422, "Validation failed"));

    const fetch = createFetch({
      sapiomClient: mockSapiomClient,
      failureMode: "closed",
      retry: FAST_RETRY,
    });

    await expect(fetch("https://api.example.com/test")).rejects.toThrow(
      "Request failed with status 422",
    );
    // Should NOT retry - only 1 attempt
    expect(mockTransactionAPI.create).toHaveBeenCalledTimes(1);
  });

  it("should NOT retry on timeout errors - throw immediately", async () => {
    fetchMock.get("https://api.example.com/test", {
      status: 200,
      body: { data: "success" },
    });

    mockTransactionAPI.create.mockRejectedValueOnce(timeoutError());

    const fetch = createFetch({
      sapiomClient: mockSapiomClient,
      failureMode: "closed",
      retry: FAST_RETRY,
    });

    await expect(fetch("https://api.example.com/test")).rejects.toThrow(
      "Request timeout",
    );
    expect(mockTransactionAPI.create).toHaveBeenCalledTimes(1);
  });

  it("should allow request through on timeout in failureMode open (no retry)", async () => {
    fetchMock.get("https://api.example.com/test", {
      status: 200,
      body: { data: "success" },
    });

    mockTransactionAPI.create.mockRejectedValueOnce(timeoutError());

    const fetch = createFetch({
      sapiomClient: mockSapiomClient,
      failureMode: "open",
      retry: FAST_RETRY,
    });

    const response = await fetch("https://api.example.com/test");
    expect(response.status).toBe(200);
    expect(mockTransactionAPI.create).toHaveBeenCalledTimes(1);
  });

  it("should retry up to maxAttempts on 5xx then fall through in failureMode open", async () => {
    fetchMock.get("https://api.example.com/test", {
      status: 200,
      body: { data: "success" },
    });

    mockTransactionAPI.create.mockRejectedValue(server500Error());

    const fetch = createFetch({
      sapiomClient: mockSapiomClient,
      failureMode: "open",
      retry: FAST_RETRY,
    });

    const response = await fetch("https://api.example.com/test");
    expect(response.status).toBe(200);
    expect(mockTransactionAPI.create).toHaveBeenCalledTimes(3);
  });

  it("should throw after retries exhausted in failureMode closed", async () => {
    fetchMock.get("https://api.example.com/test", {
      status: 200,
      body: { data: "success" },
    });

    mockTransactionAPI.create.mockRejectedValue(server500Error());

    const fetch = createFetch({
      sapiomClient: mockSapiomClient,
      failureMode: "closed",
      retry: FAST_RETRY,
    });

    await expect(fetch("https://api.example.com/test")).rejects.toThrow(
      "Request failed with status 500",
    );
    expect(mockTransactionAPI.create).toHaveBeenCalledTimes(3);
  });

  it("should succeed on first attempt without retrying", async () => {
    fetchMock.get("https://api.example.com/test", {
      status: 200,
      body: { data: "success" },
    });

    mockTransactionAPI.create.mockResolvedValueOnce({
      id: "tx_ok",
      status: "authorized",
    } as any);
    mockTransactionAPI.complete.mockResolvedValue({} as any);

    const fetch = createFetch({
      sapiomClient: mockSapiomClient,
      retry: FAST_RETRY,
    });

    const response = await fetch("https://api.example.com/test");
    expect(response.status).toBe(200);
    expect(mockTransactionAPI.create).toHaveBeenCalledTimes(1);
  });

  it("should succeed on 3rd attempt (last retry)", async () => {
    fetchMock.get("https://api.example.com/test", {
      status: 200,
      body: { data: "success" },
    });

    mockTransactionAPI.create
      .mockRejectedValueOnce(server500Error())
      .mockRejectedValueOnce(server500Error())
      .mockResolvedValueOnce({
        id: "tx_3rd",
        status: "authorized",
      } as any);
    mockTransactionAPI.complete.mockResolvedValue({} as any);

    const fetch = createFetch({
      sapiomClient: mockSapiomClient,
      retry: FAST_RETRY,
    });

    const response = await fetch("https://api.example.com/test");
    expect(response.status).toBe(200);
    expect(mockTransactionAPI.create).toHaveBeenCalledTimes(3);
  });
});

describe("Idempotency key on transaction creation", () => {
  let mockTransactionAPI: jest.Mocked<TransactionAPI>;
  let mockSapiomClient: SapiomClient;

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

  it("should include idempotencyKey in metadata", async () => {
    fetchMock.get("https://api.example.com/test", {
      status: 200,
      body: { data: "success" },
    });

    mockTransactionAPI.create.mockResolvedValueOnce({
      id: "tx_idem",
      status: "authorized",
    } as any);
    mockTransactionAPI.complete.mockResolvedValue({} as any);

    const fetch = createFetch({
      sapiomClient: mockSapiomClient,
      retry: FAST_RETRY,
    });

    await fetch("https://api.example.com/test");

    const createCall = mockTransactionAPI.create.mock.calls[0]![0];
    expect(createCall.metadata).toHaveProperty("idempotencyKey");
    expect(typeof createCall.metadata!.idempotencyKey).toBe("string");
    // UUID format: 8-4-4-4-12
    expect(createCall.metadata!.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("should use the same idempotencyKey across retries", async () => {
    fetchMock.get("https://api.example.com/test", {
      status: 200,
      body: { data: "success" },
    });

    mockTransactionAPI.create
      .mockRejectedValueOnce(server500Error())
      .mockResolvedValueOnce({
        id: "tx_idem2",
        status: "authorized",
      } as any);
    mockTransactionAPI.complete.mockResolvedValue({} as any);

    const fetch = createFetch({
      sapiomClient: mockSapiomClient,
      retry: FAST_RETRY,
    });

    await fetch("https://api.example.com/test");

    expect(mockTransactionAPI.create).toHaveBeenCalledTimes(2);
    const key1 = mockTransactionAPI.create.mock.calls[0]![0].metadata!.idempotencyKey;
    const key2 = mockTransactionAPI.create.mock.calls[1]![0].metadata!.idempotencyKey;
    expect(key1).toBe(key2);
  });
});

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
    // handleAuthorization: all 3 create attempts fail → failureMode open, request sent without txn ID
    // Server returns 402
    // handlePayment: creates on-demand transaction, reauthorizes, retries with payment header
    mockTransactionAPI.create
      .mockRejectedValueOnce(server500Error())
      .mockRejectedValueOnce(server500Error())
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
      retry: FAST_RETRY,
    });

    const response = await fetch("https://api.example.com/premium");
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ data: "premium-content" });

    // 3 failed attempts in handleAuthorization + 1 on-demand in handlePayment
    expect(mockTransactionAPI.create).toHaveBeenCalledTimes(4);
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
      retry: FAST_RETRY,
    });

    const response = await fetch("https://api.example.com/premium");
    expect(response.status).toBe(402);
  });

  it("should throw when on-demand creation fails in failureMode closed", async () => {
    mockTransactionAPI.create.mockRejectedValue(server500Error());

    fetchMock.get("https://api.example.com/premium", {
      status: 402,
      body: x402Body,
    });

    const fetch = createFetch({
      sapiomClient: mockSapiomClient,
      failureMode: "closed",
      retry: FAST_RETRY,
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
      retry: FAST_RETRY,
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

  it("should include onDemandPayment and idempotencyKey metadata in on-demand transaction", async () => {
    mockTransactionAPI.create
      .mockRejectedValueOnce(server500Error())
      .mockRejectedValueOnce(server500Error())
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
      retry: FAST_RETRY,
    });

    await fetch("https://api.example.com/premium");

    // The 4th create call (on-demand) should have onDemandPayment and idempotencyKey metadata
    const onDemandCall = mockTransactionAPI.create.mock.calls[3]![0];
    expect(onDemandCall.metadata).toEqual(
      expect.objectContaining({
        onDemandPayment: true,
        idempotencyKey: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        ),
      }),
    );
  });
});

describe("Configurable polling and retry", () => {
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

  it("should accept custom retry configuration", () => {
    const fetch = createFetch({
      sapiomClient: mockSapiomClient,
      retry: { maxAttempts: 5, baseDelayMs: 100 },
    });

    expect(typeof fetch).toBe("function");
  });
});
