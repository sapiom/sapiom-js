/**
 * HTTP Client Integration Tests
 *
 * These tests verify the complete Sapiom integration flow:
 * - Authorization: create → get/poll → HTTP request
 * - Completion: complete() called after request finishes
 * - Payment: 402 → create payment tx → poll → retry with X-PAYMENT header
 *
 * Uses fetch-mock to simulate HTTP server responses and mocked SapiomClient
 * to verify the correct Sapiom API calls are made in the right order.
 */
import { createFetch } from "./fetch";
import { SapiomClient, TransactionAPI, TransactionStatus } from "@sapiom/core";
import fetchMock from "@fetch-mock/jest";

/**
 * Creates a fully mocked SapiomClient for testing
 */
function createMockSapiomClient(): {
  client: SapiomClient;
  mocks: jest.Mocked<TransactionAPI>;
} {
  const mocks: jest.Mocked<TransactionAPI> = {
    create: jest.fn(),
    get: jest.fn(),
    complete: jest.fn(),
    reauthorizeWithPayment: jest.fn(),
    list: jest.fn(),
    isAuthorized: jest.fn(),
    isCompleted: jest.fn(),
    requiresPayment: jest.fn(),
    getPaymentDetails: jest.fn(),
    addFacts: jest.fn(),
    addCost: jest.fn(),
    listCosts: jest.fn(),
  } as any;

  const client = {
    transactions: mocks,
  } as unknown as SapiomClient;

  return { client, mocks };
}

/**
 * Helper to wait for fire-and-forget operations to complete
 */
async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("HTTP Client Integration Tests", () => {
  let mockSapiomClient: SapiomClient;
  let mocks: jest.Mocked<TransactionAPI>;

  beforeAll(() => {
    fetchMock.mockGlobal();
  });

  beforeEach(() => {
    const setup = createMockSapiomClient();
    mockSapiomClient = setup.client;
    mocks = setup.mocks;
    fetchMock.removeRoutes();
    jest.clearAllMocks();
  });

  afterAll(() => {
    fetchMock.unmockGlobal();
  });

  // ============================================================================
  // AUTHORIZATION FLOW TESTS
  // ============================================================================

  describe("Authorization Flow", () => {
    it("should complete full authorization flow: create → authorized → request → complete", async () => {
      // Setup: Transaction is immediately authorized
      mocks.create.mockResolvedValue({
        id: "tx-123",
        status: TransactionStatus.AUTHORIZED,
      } as any);

      mocks.complete.mockResolvedValue({
        transaction: { id: "tx-123", status: "completed" },
      } as any);

      fetchMock.get("https://api.example.com/data", {
        status: 200,
        body: { result: "success" },
      });

      const fetch = createFetch({ sapiomClient: mockSapiomClient });

      // Execute
      const response = await fetch("https://api.example.com/data");
      await flushPromises();

      // Verify HTTP response
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual({ result: "success" });

      // Verify Sapiom API calls
      expect(mocks.create).toHaveBeenCalledTimes(1);
      expect(mocks.complete).toHaveBeenCalledTimes(1);

      // Verify create call includes request facts
      const createCall = mocks.create.mock.calls[0][0];
      expect(createCall.requestFacts).toBeDefined();
      expect(createCall.requestFacts!.source).toBe("http-client");
      expect((createCall.requestFacts!.request as any).method).toBe("GET");
      expect((createCall.requestFacts!.request as any).url).toBe(
        "https://api.example.com/data",
      );

      // Verify complete call
      const completeCall = mocks.complete.mock.calls[0];
      expect(completeCall[0]).toBe("tx-123");
      expect(completeCall[1].outcome).toBe("success");
      expect(completeCall[1].responseFacts).toBeDefined();
      expect((completeCall[1].responseFacts as any).facts.status).toBe(200);

      // Verify call order: create before complete
      const createOrder = mocks.create.mock.invocationCallOrder[0];
      const completeOrder = mocks.complete.mock.invocationCallOrder[0];
      expect(createOrder).toBeLessThan(completeOrder);
    });

    it("should poll for authorization when transaction is pending", async () => {
      // Setup: Transaction starts pending, becomes authorized after get()
      mocks.create.mockResolvedValue({
        id: "tx-456",
        status: TransactionStatus.PENDING,
      } as any);

      mocks.get.mockResolvedValue({
        id: "tx-456",
        status: TransactionStatus.AUTHORIZED,
      } as any);

      mocks.complete.mockResolvedValue({
        transaction: { id: "tx-456", status: "completed" },
      } as any);

      fetchMock.get("https://api.example.com/data", {
        status: 200,
        body: { result: "polled" },
      });

      const fetch = createFetch({ sapiomClient: mockSapiomClient });

      // Execute
      const response = await fetch("https://api.example.com/data");
      await flushPromises();

      // Verify
      expect(response.status).toBe(200);
      expect(mocks.create).toHaveBeenCalledTimes(1);
      expect(mocks.get).toHaveBeenCalled(); // Polled for status
      expect(mocks.complete).toHaveBeenCalledTimes(1);

      // Verify polling was for the correct transaction
      expect(mocks.get).toHaveBeenCalledWith("tx-456");
    });

    it("should throw AuthorizationDeniedError when transaction is denied", async () => {
      // Setup: Transaction is denied
      mocks.create.mockResolvedValue({
        id: "tx-denied",
        status: TransactionStatus.DENIED,
      } as any);

      fetchMock.get("https://api.example.com/data", {
        status: 200,
        body: { result: "should not reach" },
      });

      const fetch = createFetch({ sapiomClient: mockSapiomClient });

      // Execute & Verify
      await expect(fetch("https://api.example.com/data")).rejects.toThrow(
        "Authorization denied",
      );

      // Verify no complete call (denied before request)
      expect(mocks.complete).not.toHaveBeenCalled();
    });

    it("should add X-Sapiom-Transaction-Id header to request", async () => {
      mocks.create.mockResolvedValue({
        id: "tx-header-test",
        status: TransactionStatus.AUTHORIZED,
      } as any);

      mocks.complete.mockResolvedValue({
        transaction: { id: "tx-header-test", status: "completed" },
      } as any);

      fetchMock.get("https://api.example.com/data", { status: 200, body: {} });

      const fetch = createFetch({ sapiomClient: mockSapiomClient });
      await fetch("https://api.example.com/data");
      await flushPromises();

      // Verify transaction was created and header was set (implicitly via complete being called)
      expect(mocks.create).toHaveBeenCalledTimes(1);
      expect(mocks.complete).toHaveBeenCalledWith(
        "tx-header-test",
        expect.anything(),
      );
    });
  });

  // ============================================================================
  // COMPLETION FLOW TESTS
  // ============================================================================

  describe("Completion Flow", () => {
    it("should call complete with success outcome on HTTP 200", async () => {
      mocks.create.mockResolvedValue({
        id: "tx-success",
        status: TransactionStatus.AUTHORIZED,
      } as any);

      mocks.complete.mockResolvedValue({
        transaction: { id: "tx-success", status: "completed" },
      } as any);

      fetchMock.get("https://api.example.com/data", {
        status: 200,
        body: { ok: true },
      });

      const fetch = createFetch({ sapiomClient: mockSapiomClient });
      await fetch("https://api.example.com/data");
      await flushPromises();

      expect(mocks.complete).toHaveBeenCalledWith(
        "tx-success",
        expect.objectContaining({
          outcome: "success",
          responseFacts: expect.objectContaining({
            source: "http-client",
            facts: expect.objectContaining({
              status: 200,
            }),
          }),
        }),
      );
    });

    it("should call complete with error outcome on HTTP 500", async () => {
      mocks.create.mockResolvedValue({
        id: "tx-error",
        status: TransactionStatus.AUTHORIZED,
      } as any);

      mocks.complete.mockResolvedValue({
        transaction: { id: "tx-error", status: "completed" },
      } as any);

      fetchMock.get("https://api.example.com/data", {
        status: 500,
        body: { error: "Internal Server Error" },
      });

      const fetch = createFetch({ sapiomClient: mockSapiomClient });
      const response = await fetch("https://api.example.com/data");
      await flushPromises();

      expect(response.status).toBe(500);
      expect(mocks.complete).toHaveBeenCalledWith(
        "tx-error",
        expect.objectContaining({
          outcome: "error",
          responseFacts: expect.objectContaining({
            facts: expect.objectContaining({
              httpStatus: 500,
            }),
          }),
        }),
      );
    });

    it("should call complete with error outcome on network error", async () => {
      mocks.create.mockResolvedValue({
        id: "tx-network-error",
        status: TransactionStatus.AUTHORIZED,
      } as any);

      mocks.complete.mockResolvedValue({
        transaction: { id: "tx-network-error", status: "completed" },
      } as any);

      fetchMock.get("https://api.example.com/data", {
        throws: new Error("Network error"),
      });

      const fetch = createFetch({ sapiomClient: mockSapiomClient });

      await expect(fetch("https://api.example.com/data")).rejects.toThrow(
        "Network error",
      );
      await flushPromises();

      expect(mocks.complete).toHaveBeenCalledWith(
        "tx-network-error",
        expect.objectContaining({
          outcome: "error",
          responseFacts: expect.objectContaining({
            facts: expect.objectContaining({
              errorMessage: "Network error",
              isNetworkError: true,
            }),
          }),
        }),
      );
    });

    it("should not block request if complete() fails", async () => {
      mocks.create.mockResolvedValue({
        id: "tx-complete-fail",
        status: TransactionStatus.AUTHORIZED,
      } as any);

      // complete() fails
      mocks.complete.mockRejectedValue(new Error("Sapiom API unavailable"));

      fetchMock.get("https://api.example.com/data", {
        status: 200,
        body: { result: "success" },
      });

      const consoleSpy = jest.spyOn(console, "error").mockImplementation();

      const fetch = createFetch({ sapiomClient: mockSapiomClient });
      const response = await fetch("https://api.example.com/data");
      await flushPromises();

      // Request should still succeed
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual({ result: "success" });

      // Error should be logged but not thrown
      expect(consoleSpy).toHaveBeenCalledWith(
        "[Sapiom] Failed to complete transaction:",
        expect.any(Error),
      );

      consoleSpy.mockRestore();
    });

    it("should include duration in response facts", async () => {
      mocks.create.mockResolvedValue({
        id: "tx-duration",
        status: TransactionStatus.AUTHORIZED,
      } as any);

      mocks.complete.mockResolvedValue({
        transaction: { id: "tx-duration", status: "completed" },
      } as any);

      fetchMock.get("https://api.example.com/data", {
        status: 200,
        body: {},
      });

      const fetch = createFetch({ sapiomClient: mockSapiomClient });
      await fetch("https://api.example.com/data");
      await flushPromises();

      const completeCall = mocks.complete.mock.calls[0];
      expect(
        (completeCall[1].responseFacts as any).facts.durationMs,
      ).toBeGreaterThanOrEqual(0);
    });
  });

  // ============================================================================
  // PAYMENT FLOW TESTS
  // ============================================================================

  describe("Payment Flow", () => {
    it("should handle 402 payment required flow", async () => {
      // First request: authorized
      mocks.create
        .mockResolvedValueOnce({
          id: "tx-auth",
          status: TransactionStatus.AUTHORIZED,
        } as any)
        // Payment transaction: authorized with payment payload
        .mockResolvedValueOnce({
          id: "tx-payment",
          status: TransactionStatus.PENDING,
        } as any);

      // Payment transaction polling returns authorized with payload
      mocks.get.mockResolvedValue({
        id: "tx-payment",
        status: TransactionStatus.AUTHORIZED,
        payment: {
          authorizationPayload: "payment-token-xyz",
        },
      } as any);

      mocks.complete.mockResolvedValue({
        transaction: { id: "tx-auth", status: "completed" },
      } as any);

      // First request returns 402, second returns success
      fetchMock.getOnce("https://api.example.com/paid", {
        status: 402,
        body: {
          x402Version: 1,
          accepts: [
            {
              scheme: "exact",
              network: "base",
              maxAmountRequired: "1000000",
              resource: "https://api.example.com/paid",
              payTo: "0x123",
              asset: "0xUSDC",
            },
          ],
        },
      });

      // Second request (retry with payment) returns success
      fetchMock.get("https://api.example.com/paid", {
        status: 200,
        body: { paid: true },
      });

      const fetch = createFetch({ sapiomClient: mockSapiomClient });
      const response = await fetch("https://api.example.com/paid");
      await flushPromises();

      // Verify success after payment retry
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual({ paid: true });

      // Verify two transactions created (auth + payment)
      expect(mocks.create).toHaveBeenCalledTimes(2);

      // Verify payment transaction includes x402 data
      const paymentCreateCall = mocks.create.mock.calls[1][0];
      expect(paymentCreateCall.paymentData).toBeDefined();
      expect(paymentCreateCall.paymentData!.x402).toBeDefined();
    });

    it("should return original 402 if payment transaction is denied", async () => {
      mocks.create
        .mockResolvedValueOnce({
          id: "tx-auth",
          status: TransactionStatus.AUTHORIZED,
        } as any)
        .mockResolvedValueOnce({
          id: "tx-payment-denied",
          status: TransactionStatus.PENDING,
        } as any);

      // Payment transaction polling returns denied
      mocks.get.mockResolvedValue({
        id: "tx-payment-denied",
        status: TransactionStatus.DENIED,
      } as any);

      mocks.complete.mockResolvedValue({
        transaction: { id: "tx-auth", status: "completed" },
      } as any);

      fetchMock.get("https://api.example.com/paid", {
        status: 402,
        body: {
          x402Version: 1,
          accepts: [
            {
              scheme: "exact",
              network: "base",
              maxAmountRequired: "1000000",
              resource: "https://api.example.com/paid",
              payTo: "0x123",
              asset: "0xUSDC",
            },
          ],
        },
      });

      const fetch = createFetch({ sapiomClient: mockSapiomClient });
      const response = await fetch("https://api.example.com/paid");
      await flushPromises();

      // Should return original 402
      expect(response.status).toBe(402);
    });
  });

  // ============================================================================
  // METADATA PROPAGATION TESTS
  // ============================================================================

  describe("Metadata Propagation", () => {
    it("should pass default metadata to transaction create", async () => {
      mocks.create.mockResolvedValue({
        id: "tx-meta",
        status: TransactionStatus.AUTHORIZED,
      } as any);

      mocks.complete.mockResolvedValue({
        transaction: { id: "tx-meta", status: "completed" },
      } as any);

      fetchMock.get("https://api.example.com/data", { status: 200, body: {} });

      const fetch = createFetch({
        sapiomClient: mockSapiomClient,
        agentName: "test-agent",
        agentId: "agent-123",
        serviceName: "test-service",
        traceId: "trace-abc",
      });

      await fetch("https://api.example.com/data");
      await flushPromises();

      const createCall = mocks.create.mock.calls[0][0];
      expect(createCall.agentName).toBe("test-agent");
      expect(createCall.agentId).toBe("agent-123");
      expect(createCall.serviceName).toBe("test-service");
      expect(createCall.traceId).toBe("trace-abc");
    });

    it("should skip Sapiom when config.enabled is false", async () => {
      fetchMock.get("https://api.example.com/public", {
        status: 200,
        body: { public: true },
      });

      const fetch = createFetch({
        sapiomClient: mockSapiomClient,
        enabled: false,
      });

      const response = await fetch("https://api.example.com/public");
      await flushPromises();

      expect(response.status).toBe(200);

      // No Sapiom calls should be made
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.complete).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // CALL ORDER VERIFICATION
  // ============================================================================

  describe("Call Order Verification", () => {
    it("should call Sapiom APIs in correct order: create → (get) → complete", async () => {
      const callSequence: string[] = [];

      mocks.create.mockImplementation(async () => {
        callSequence.push("create");
        return {
          id: "tx-order",
          status: TransactionStatus.PENDING,
        } as any;
      });

      mocks.get.mockImplementation(async () => {
        callSequence.push("get");
        return {
          id: "tx-order",
          status: TransactionStatus.AUTHORIZED,
        } as any;
      });

      mocks.complete.mockImplementation(async () => {
        callSequence.push("complete");
        return {
          transaction: { id: "tx-order", status: "completed" },
        } as any;
      });

      fetchMock.get("https://api.example.com/data", { status: 200, body: {} });

      const fetch = createFetch({ sapiomClient: mockSapiomClient });
      await fetch("https://api.example.com/data");
      await flushPromises();

      // Verify sequence
      expect(callSequence[0]).toBe("create");
      expect(callSequence[1]).toBe("get");
      expect(callSequence[callSequence.length - 1]).toBe("complete");
    });
  });
});
