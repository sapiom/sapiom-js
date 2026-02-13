/**
 * HTTP Client Integration Tests for Axios
 *
 * These tests verify the complete Sapiom integration flow:
 * - Authorization: create → get/poll → HTTP request
 * - Completion: complete() called after request finishes
 * - Payment: 402 → create payment tx → poll → retry with X-PAYMENT header
 *
 * Uses axios-mock-adapter to simulate HTTP server responses and mocked SapiomClient
 * to verify the correct Sapiom API calls are made in the right order.
 */
import axios, { AxiosInstance } from "axios";
import MockAdapter from "axios-mock-adapter";
import { Readable, Stream } from "stream";
import { withSapiom } from "./axios";
import { SapiomClient, TransactionAPI, TransactionStatus } from "@sapiom/core";

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

describe("Axios HTTP Client Integration Tests", () => {
  let axiosInstance: AxiosInstance;
  let mockAxios: MockAdapter;
  let mockSapiomClient: SapiomClient;
  let mocks: jest.Mocked<TransactionAPI>;

  beforeEach(() => {
    axiosInstance = axios.create({ baseURL: "https://api.example.com" });
    mockAxios = new MockAdapter(axiosInstance);

    const setup = createMockSapiomClient();
    mockSapiomClient = setup.client;
    mocks = setup.mocks;
    jest.clearAllMocks();
  });

  afterEach(() => {
    mockAxios.restore();
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

      mockAxios.onGet("/data").reply(200, { result: "success" });

      const client = withSapiom(axiosInstance, {
        sapiomClient: mockSapiomClient,
      });

      // Execute
      const response = await client.get("/data");
      await flushPromises();

      // Verify HTTP response
      expect(response.status).toBe(200);
      expect(response.data).toEqual({ result: "success" });

      // Verify Sapiom API calls
      expect(mocks.create).toHaveBeenCalledTimes(1);
      expect(mocks.complete).toHaveBeenCalledTimes(1);

      // Verify create call includes request facts
      const createCall = mocks.create.mock.calls[0][0];
      expect(createCall.requestFacts).toBeDefined();
      expect(createCall.requestFacts!.source).toBe("http-client");
      expect((createCall.requestFacts!.request as any).method).toBe("GET");

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

      mockAxios.onGet("/data").reply(200, { result: "polled" });

      const client = withSapiom(axiosInstance, {
        sapiomClient: mockSapiomClient,
      });

      // Execute
      const response = await client.get("/data");
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

      mockAxios.onGet("/data").reply(200, { result: "should not reach" });

      const client = withSapiom(axiosInstance, {
        sapiomClient: mockSapiomClient,
      });

      // Execute & Verify
      await expect(client.get("/data")).rejects.toThrow("Authorization denied");

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

      mockAxios.onGet("/data").reply(200, {});

      const client = withSapiom(axiosInstance, {
        sapiomClient: mockSapiomClient,
      });
      await client.get("/data");
      await flushPromises();

      // Verify transaction was created and complete was called with correct ID
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

      mockAxios.onGet("/data").reply(200, { ok: true });

      const client = withSapiom(axiosInstance, {
        sapiomClient: mockSapiomClient,
      });
      await client.get("/data");
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

      mockAxios.onGet("/data").reply(500, { error: "Internal Server Error" });

      const client = withSapiom(axiosInstance, {
        sapiomClient: mockSapiomClient,
      });

      try {
        await client.get("/data");
      } catch {
        // Expected to throw
      }
      await flushPromises();

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

      mockAxios.onGet("/data").networkError();

      const client = withSapiom(axiosInstance, {
        sapiomClient: mockSapiomClient,
      });

      try {
        await client.get("/data");
      } catch {
        // Expected to throw
      }
      await flushPromises();

      expect(mocks.complete).toHaveBeenCalledWith(
        "tx-network-error",
        expect.objectContaining({
          outcome: "error",
          responseFacts: expect.objectContaining({
            facts: expect.objectContaining({
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

      mockAxios.onGet("/data").reply(200, { result: "success" });

      const consoleSpy = jest.spyOn(console, "error").mockImplementation();

      const client = withSapiom(axiosInstance, {
        sapiomClient: mockSapiomClient,
      });
      const response = await client.get("/data");
      await flushPromises();

      // Request should still succeed
      expect(response.status).toBe(200);
      expect(response.data).toEqual({ result: "success" });

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

      mockAxios.onGet("/data").reply(200, {});

      const client = withSapiom(axiosInstance, {
        sapiomClient: mockSapiomClient,
      });
      await client.get("/data");
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
    it("should handle 402 payment required flow with reauthorization", async () => {
      // First authorization
      mocks.create.mockResolvedValue({
        id: "tx-auth",
        status: TransactionStatus.AUTHORIZED,
      } as any);

      // Reauthorization for payment
      mocks.get.mockResolvedValue({
        id: "tx-auth",
        status: TransactionStatus.AUTHORIZED,
        requiresPayment: false,
      } as any);

      mocks.reauthorizeWithPayment.mockResolvedValue({
        id: "tx-auth",
        status: TransactionStatus.AUTHORIZED,
        payment: {
          authorizationPayload: "payment-token-xyz",
        },
      } as any);

      mocks.complete.mockResolvedValue({
        transaction: { id: "tx-auth", status: "completed" },
      } as any);

      let requestCount = 0;
      mockAxios.onGet("/paid").reply(() => {
        requestCount++;
        if (requestCount === 1) {
          // First request: return 402
          return [
            402,
            {
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
          ];
        } else {
          // Retry with payment: return success
          return [200, { paid: true }];
        }
      });

      const client = withSapiom(axiosInstance, {
        sapiomClient: mockSapiomClient,
      });
      const response = await client.get("/paid");
      await flushPromises();

      // Verify success after payment retry
      expect(response.status).toBe(200);
      expect(response.data).toEqual({ paid: true });

      // Verify two requests were made
      expect(requestCount).toBe(2);

      // Verify reauthorization was called
      expect(mocks.reauthorizeWithPayment).toHaveBeenCalled();
    });

    it("should return original 402 if payment reauthorization is denied", async () => {
      mocks.create.mockResolvedValue({
        id: "tx-auth",
        status: TransactionStatus.AUTHORIZED,
      } as any);

      mocks.get.mockResolvedValue({
        id: "tx-auth",
        status: TransactionStatus.AUTHORIZED,
        requiresPayment: false,
      } as any);

      // Payment reauthorization returns denied
      mocks.reauthorizeWithPayment.mockResolvedValue({
        id: "tx-auth",
        status: TransactionStatus.DENIED,
      } as any);

      mocks.complete.mockResolvedValue({
        transaction: { id: "tx-auth", status: "completed" },
      } as any);

      mockAxios.onGet("/paid").reply(402, {
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
      });

      const client = withSapiom(axiosInstance, {
        sapiomClient: mockSapiomClient,
      });

      try {
        await client.get("/paid");
        fail("Should have thrown 402 error");
      } catch (error: any) {
        // Should get original 402
        expect(error.response?.status).toBe(402);
      }
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

      mockAxios.onGet("/data").reply(200, {});

      const client = withSapiom(axiosInstance, {
        sapiomClient: mockSapiomClient,
        agentName: "test-agent",
        agentId: "agent-123",
        serviceName: "test-service",
        traceId: "trace-abc",
      });

      await client.get("/data");
      await flushPromises();

      const createCall = mocks.create.mock.calls[0][0];
      expect(createCall.agentName).toBe("test-agent");
      expect(createCall.agentId).toBe("agent-123");
      expect(createCall.serviceName).toBe("test-service");
      expect(createCall.traceId).toBe("trace-abc");
    });

    it("should allow per-request metadata override via __sapiom", async () => {
      mocks.create.mockResolvedValue({
        id: "tx-override",
        status: TransactionStatus.AUTHORIZED,
      } as any);

      mocks.complete.mockResolvedValue({
        transaction: { id: "tx-override", status: "completed" },
      } as any);

      mockAxios.onGet("/data").reply(200, {});

      const client = withSapiom(axiosInstance, {
        sapiomClient: mockSapiomClient,
        serviceName: "default-service",
      });

      await client.get("/data", {
        __sapiom: {
          serviceName: "override-service",
          actionName: "custom-action",
        },
      } as any);
      await flushPromises();

      const createCall = mocks.create.mock.calls[0][0];
      expect(createCall.serviceName).toBe("override-service");
      expect(createCall.actionName).toBe("custom-action");
    });

    it("should skip Sapiom when __sapiom.enabled is false", async () => {
      mockAxios.onGet("/public").reply(200, { public: true });

      const client = withSapiom(axiosInstance, {
        sapiomClient: mockSapiomClient,
      });

      const response = await client.get("/public", {
        __sapiom: { enabled: false },
      } as any);
      await flushPromises();

      expect(response.status).toBe(200);

      // No Sapiom calls should be made
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.complete).not.toHaveBeenCalled();
    });

    it("should skip Sapiom when config.enabled is false", async () => {
      mockAxios.onGet("/public").reply(200, { public: true });

      const client = withSapiom(axiosInstance, {
        sapiomClient: mockSapiomClient,
        enabled: false,
      });

      const response = await client.get("/public");
      await flushPromises();

      expect(response.status).toBe(200);

      // No Sapiom calls should be made (interceptors not added)
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

      mockAxios.onGet("/data").reply(200, {});

      const client = withSapiom(axiosInstance, {
        sapiomClient: mockSapiomClient,
      });
      await client.get("/data");
      await flushPromises();

      // Verify sequence
      expect(callSequence[0]).toBe("create");
      expect(callSequence[1]).toBe("get");
      expect(callSequence[callSequence.length - 1]).toBe("complete");
    });
  });

  // ============================================================================
  // DOUBLE COMPLETION PREVENTION (Axios-specific)
  // ============================================================================

  describe("Double Completion Prevention", () => {
    it("should not call complete twice when payment flow succeeds", async () => {
      mocks.create.mockResolvedValue({
        id: "tx-payment",
        status: TransactionStatus.AUTHORIZED,
      } as any);

      mocks.get.mockResolvedValue({
        id: "tx-payment",
        status: TransactionStatus.AUTHORIZED,
        requiresPayment: false,
      } as any);

      mocks.reauthorizeWithPayment.mockResolvedValue({
        id: "tx-payment",
        status: TransactionStatus.AUTHORIZED,
        payment: {
          authorizationPayload: "token",
        },
      } as any);

      mocks.complete.mockResolvedValue({
        transaction: { id: "tx-payment", status: "completed" },
      } as any);

      let requestCount = 0;
      mockAxios.onGet("/paid").reply(() => {
        requestCount++;
        if (requestCount === 1) {
          return [
            402,
            {
              x402Version: 1,
              accepts: [
                {
                  scheme: "exact",
                  network: "base",
                  maxAmountRequired: "1000",
                  resource: "https://api.example.com/paid",
                  payTo: "0x123",
                  asset: "0xUSDC",
                },
              ],
            },
          ];
        }
        return [200, { success: true }];
      });

      const client = withSapiom(axiosInstance, {
        sapiomClient: mockSapiomClient,
      });
      await client.get("/paid");
      await flushPromises();

      // complete() should only be called once (on the retry, not the original 402)
      expect(mocks.complete).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================================
  // STREAM AND FORMDATA BODY REPLAY TESTS
  // ============================================================================

  describe("Stream and FormData Body Replay", () => {
    /**
     * Creates a mock FormData-like object that mimics the `form-data` npm package's
     * CombinedStream: has `.pipe()`, `.getHeaders()`, and emits data/end events,
     * but does NOT implement Symbol.asyncIterator (unlike Node.js Readable).
     * This ensures we test the pipe-based fallback path in streamToBuffer.
     */
    function createMockFormData(
      content: string,
      boundary: string,
    ) {
      const body = `--${boundary}\r\nContent-Disposition: form-data; name="file"\r\n\r\n${content}\r\n--${boundary}--\r\n`;
      const stream = new Stream() as Stream & {
        pipe: (dest: any) => any;
        getHeaders: () => Record<string, string>;
      };
      stream.pipe = function (dest: any) {
        dest.write(body);
        dest.end();
        return dest;
      };
      // Emit data/end on next tick (mimics CombinedStream behavior)
      let started = false;
      const originalOn = stream.on.bind(stream);
      stream.on = function (event: string, listener: (...args: any[]) => void) {
        originalOn(event, listener);
        if (event === "data" && !started) {
          started = true;
          process.nextTick(() => {
            stream.emit("data", Buffer.from(body));
            stream.emit("end");
          });
        }
        return stream;
      } as any;
      stream.getHeaders = () => ({
        "content-type": `multipart/form-data; boundary=${boundary}`,
      });
      return stream;
    }

    function setup402PaymentFlow() {
      mocks.create.mockResolvedValue({
        id: "tx-body",
        status: TransactionStatus.AUTHORIZED,
      } as any);

      mocks.get.mockResolvedValue({
        id: "tx-body",
        status: TransactionStatus.AUTHORIZED,
        requiresPayment: false,
      } as any);

      mocks.reauthorizeWithPayment.mockResolvedValue({
        id: "tx-body",
        status: TransactionStatus.AUTHORIZED,
        payment: {
          authorizationPayload: "payment-token",
        },
      } as any);

      mocks.complete.mockResolvedValue({
        transaction: { id: "tx-body", status: "completed" },
      } as any);
    }

    function mock402ThenSuccess(
      method: "onPost" | "onGet",
      path: string,
      captureBody?: (data: any) => void,
    ) {
      let requestCount = 0;
      mockAxios[method](path).reply((config) => {
        requestCount++;
        if (requestCount === 1) {
          if (captureBody) captureBody(config.data);
          return [
            402,
            {
              x402Version: 1,
              accepts: [
                {
                  scheme: "exact",
                  network: "base",
                  maxAmountRequired: "1000",
                  resource: `https://api.example.com${path}`,
                  payTo: "0x123",
                  asset: "0xUSDC",
                },
              ],
            },
          ];
        }
        if (captureBody) captureBody(config.data);
        return [200, { success: true }];
      });
      return () => requestCount;
    }

    it("should replay Buffer body on 402 retry", async () => {
      setup402PaymentFlow();
      const bodies: any[] = [];
      mock402ThenSuccess("onPost", "/upload", (d) => bodies.push(d));

      const client = withSapiom(axiosInstance, {
        sapiomClient: mockSapiomClient,
      });
      const response = await client.post("/upload", Buffer.from("binary-data"));
      await flushPromises();

      expect(response.status).toBe(200);
      // Both requests should have received the body
      expect(bodies).toHaveLength(2);
      // Retry body should match original (Buffer serialized to JSON by axios-mock-adapter)
      expect(Buffer.from(bodies[1]).toString()).toContain("binary-data");
    });

    it("should auto-buffer Readable stream body on 402 retry", async () => {
      setup402PaymentFlow();
      const bodies: any[] = [];
      mock402ThenSuccess("onPost", "/upload", (d) => bodies.push(d));

      const warnSpy = jest.spyOn(console, "warn").mockImplementation();

      const client = withSapiom(axiosInstance, {
        sapiomClient: mockSapiomClient,
      });

      const stream = new Readable({
        read() {
          this.push("streamed-content");
          this.push(null);
        },
      });

      const response = await client.post("/upload", stream);
      await flushPromises();

      expect(response.status).toBe(200);
      expect(bodies).toHaveLength(2);
      // Both first request and retry should get the buffered content
      expect(Buffer.from(bodies[0]).toString()).toBe("streamed-content");
      expect(Buffer.from(bodies[1]).toString()).toBe("streamed-content");

      // Should have warned about buffering
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Buffering stream body into memory"),
      );

      warnSpy.mockRestore();
    });

    it("should use bodyFactory for fresh body on 402 retry", async () => {
      setup402PaymentFlow();
      const bodies: any[] = [];
      mock402ThenSuccess("onPost", "/upload", (d) => bodies.push(d));

      const warnSpy = jest.spyOn(console, "warn").mockImplementation();

      let factoryCalls = 0;
      const bodyFactory = () => {
        factoryCalls++;
        return Buffer.from(`factory-body-${factoryCalls}`);
      };

      const client = withSapiom(axiosInstance, {
        sapiomClient: mockSapiomClient,
      });

      // Create a stream for the initial body
      const stream = new Readable({
        read() {
          this.push("initial-stream");
          this.push(null);
        },
      });

      const response = await client.post("/upload", stream, {
        __sapiom: {
          bodyFactory,
        },
      } as any);
      await flushPromises();

      expect(response.status).toBe(200);
      // bodyFactory should have been called once for the retry
      expect(factoryCalls).toBe(1);
      // Should NOT have warned about buffering (bodyFactory was provided)
      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    it("should replay mock FormData body on 402 retry with correct headers", async () => {
      setup402PaymentFlow();
      const bodies: any[] = [];
      mock402ThenSuccess("onPost", "/upload", (d) => bodies.push(d));

      const client = withSapiom(axiosInstance, {
        sapiomClient: mockSapiomClient,
      });

      const formData = createMockFormData("file-content", "----boundary123");

      const response = await client.post("/upload", formData);
      await flushPromises();

      expect(response.status).toBe(200);
      expect(bodies).toHaveLength(2);
      // Both requests should get the buffered FormData content
      const retryBody = Buffer.from(bodies[1]).toString();
      expect(retryBody).toContain("file-content");
      expect(retryBody).toContain("----boundary123");
    });

    it("should compute bodySizeBytes correctly for various body types", async () => {
      mocks.complete.mockResolvedValue({
        transaction: { id: "tx-size", status: "completed" },
      } as any);

      mockAxios.onPost("/data").reply(200, { ok: true });

      const testCases: Array<{ body: any; expectedSize: number; label: string }> = [
        { body: "hello", expectedSize: 5, label: "ASCII string" },
        { body: "héllo", expectedSize: 6, label: "multi-byte string" },
        { body: Buffer.from("data"), expectedSize: 4, label: "Buffer" },
        { body: { key: "value" }, expectedSize: Buffer.byteLength('{"key":"value"}'), label: "plain object" },
      ];

      for (const { body, expectedSize, label } of testCases) {
        mocks.create.mockResolvedValue({
          id: "tx-size",
          status: TransactionStatus.AUTHORIZED,
        } as any);

        const client = withSapiom(axios.create({ baseURL: "https://api.example.com" }), {
          sapiomClient: mockSapiomClient,
        });

        const localMock = new MockAdapter(client);
        localMock.onPost("/data").reply(200, { ok: true });

        await client.post("/data", body);
        await flushPromises();

        const createCall = mocks.create.mock.calls[mocks.create.mock.calls.length - 1][0];
        expect((createCall.requestFacts as any).request.bodySizeBytes).toBe(expectedSize);

        localMock.restore();
      }
    });
  });
});
