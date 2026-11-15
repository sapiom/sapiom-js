/**
 * Critical tests for failureMode behavior
 * These tests ensure Sapiom failures don't break customer apps
 */
import axios, { AxiosInstance } from "axios";
import MockAdapter from "axios-mock-adapter";
import { withSapiom } from "./axios";
import {
  SapiomClient,
  TransactionAPI,
  TransactionRevisionRequiredError,
} from "@sapiom/core";

describe("Axios failureMode", () => {
  let axiosInstance: AxiosInstance;
  let mockAxios: MockAdapter;
  let mockTransactionAPI: jest.Mocked<TransactionAPI>;
  let mockSapiomClient: SapiomClient;

  beforeEach(() => {
    axiosInstance = axios.create({ baseURL: "https://api.example.com" });
    mockAxios = new MockAdapter(axiosInstance);

    mockTransactionAPI = {
      create: jest.fn(),
      get: jest.fn(),
      reauthorizeWithPayment: jest.fn(),
      complete: jest.fn().mockResolvedValue({}),
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

  afterEach(() => {
    mockAxios.restore();
  });

  it.each([
    ["open", false],
    ["open", true],
    ["closed", false],
    ["closed", true],
  ] as const)(
    "leaves a payment revision open (%s, polled: %s)",
    async (failureMode, pending) => {
      const revision = {
        id: "tx-revise",
        status: "needs_revision",
        nextAction: { type: "revise", actor: "agent", reasons: [] },
      };
      mockTransactionAPI.create.mockResolvedValue({
        id: "tx-revise",
        status: "authorized",
      } as any);
      mockTransactionAPI.reauthorizeWithPayment.mockResolvedValue(
        pending
          ? ({ id: "tx-revise", status: "pending" } as any)
          : (revision as any),
      );
      mockTransactionAPI.get
        .mockResolvedValueOnce({
          id: "tx-revise",
          status: "authorized",
          requiresPayment: false,
        } as any)
        .mockResolvedValue(revision as any);
      const paymentRequired = {
        x402Version: 1,
        accepts: [
          {
            scheme: "exact",
            network: "base",
            maxAmountRequired: "1000000",
            resource: "https://api.example.com/test",
            payTo: "0x123",
            asset: "0xUSDC",
          },
        ],
      };
      mockAxios.onGet("/test").reply(402, paymentRequired);
      const client = withSapiom(axiosInstance, {
        sapiomClient: mockSapiomClient,
        failureMode,
        polling: { pollInterval: 1 },
      });
      await expect(client.get("/test")).rejects.toBeInstanceOf(
        TransactionRevisionRequiredError,
      );
      expect(mockAxios.history.get).toHaveLength(1);
      expect(mockTransactionAPI.reauthorizeWithPayment).toHaveBeenCalledTimes(
        1,
      );
      expect(mockTransactionAPI.complete).not.toHaveBeenCalled();
    },
  );

  it.each(["open", "closed"] as const)(
    "blocks revision decisions in failureMode %s",
    async (failureMode) => {
      for (const mode of ["create", "existing", "poll"] as const) {
        const transaction = {
          id: "tx-revise",
          status: "needs_revision",
          nextAction: { type: "revise", actor: "agent", reasons: [] },
        };
        mockTransactionAPI.create.mockResolvedValue(
          mode === "poll"
            ? ({ id: "tx-revise", status: "pending" } as any)
            : (transaction as any),
        );
        mockTransactionAPI.get.mockResolvedValue(transaction as any);
        mockAxios.onGet("/test").reply(200);
        const client = withSapiom(axiosInstance, {
          sapiomClient: mockSapiomClient,
          failureMode,
          polling: { pollInterval: 1 },
        });
        await expect(
          client.get("/test", {
            headers:
              mode === "existing"
                ? { "X-Sapiom-Transaction-Id": "tx-revise" }
                : {},
          }),
        ).rejects.toBeInstanceOf(TransactionRevisionRequiredError);
        expect(mockAxios.history.get).toHaveLength(0);
      }
    },
  );

  describe('failureMode: "open" (default)', () => {
    it("should allow request when Sapiom API returns 500", async () => {
      mockAxios.onGet("/test").reply(200, { data: "success" });

      // Sapiom API fails with 500
      mockTransactionAPI.create.mockRejectedValue(
        new Error("Sapiom API returned 500"),
      );

      const client = withSapiom(axiosInstance, {
        sapiomClient: mockSapiomClient,
        failureMode: "open",
      });

      // Should succeed despite Sapiom failure
      const response = await client.get("/test");
      expect(response.status).toBe(200);
      expect(response.data).toEqual({ data: "success" });
    });

    it("should allow request when Sapiom API times out", async () => {
      mockAxios.onGet("/test").reply(200, { data: "success" });

      mockTransactionAPI.create.mockRejectedValue(
        new Error("ETIMEDOUT: Sapiom API timeout"),
      );

      const client = withSapiom(axiosInstance, {
        sapiomClient: mockSapiomClient,
      }); // Default is "open"

      const response = await client.get("/test");
      expect(response.status).toBe(200);
    });

    it("should allow request when SDK throws unexpected error", async () => {
      mockAxios.onGet("/test").reply(200, { data: "success" });

      // Simulate SDK bug
      mockTransactionAPI.create.mockImplementation(() => {
        throw new TypeError("Cannot read property 'foo' of undefined");
      });

      const client = withSapiom(axiosInstance, {
        sapiomClient: mockSapiomClient,
        failureMode: "open",
      });

      const response = await client.get("/test");
      expect(response.status).toBe(200);
    });

    it("should allow request when Sapiom returns network error", async () => {
      mockAxios.onGet("/test").reply(200, { data: "success" });

      mockTransactionAPI.create.mockRejectedValue(
        new Error("ECONNREFUSED: Connection refused"),
      );

      const client = withSapiom(axiosInstance, {
        sapiomClient: mockSapiomClient,
        failureMode: "open",
      });

      const response = await client.get("/test");
      expect(response.status).toBe(200);
    });

    it("should return original 402 when payment handling fails", async () => {
      mockAxios.onGet("/test").reply(402, {
        x402Version: 1,
        accepts: [
          {
            scheme: "exact",
            network: "base",
            maxAmountRequired: "1000000",
            resourceName: "https://api.example.com/test",
            payTo: "0x123",
            asset: "0xUSDC",
          },
        ],
      });

      // Payment transaction creation fails
      mockTransactionAPI.create.mockRejectedValue(
        new Error("Sapiom API error"),
      );

      const client = withSapiom(axiosInstance, {
        sapiomClient: mockSapiomClient,
        failureMode: "open",
      });

      try {
        await client.get("/test");
        fail("Should have thrown 402 error");
      } catch (error: any) {
        // Should get original 402, not Sapiom error
        expect(error.response?.status).toBe(402);
      }
    });
  });

  describe('failureMode: "closed"', () => {
    it("should throw when Sapiom API returns 500", async () => {
      mockAxios.onGet("/test").reply(200, { data: "success" });

      mockTransactionAPI.create.mockRejectedValue(
        new Error("Sapiom API returned 500"),
      );

      const client = withSapiom(axiosInstance, {
        sapiomClient: mockSapiomClient,
        failureMode: "closed",
      });

      await expect(client.get("/test")).rejects.toThrow(
        "Sapiom API returned 500",
      );
    });

    it("should throw when Sapiom API times out", async () => {
      mockAxios.onGet("/test").reply(200, { data: "success" });

      mockTransactionAPI.create.mockRejectedValue(new Error("ETIMEDOUT"));

      const client = withSapiom(axiosInstance, {
        sapiomClient: mockSapiomClient,
        failureMode: "closed",
      });

      await expect(client.get("/test")).rejects.toThrow("ETIMEDOUT");
    });

    it("should throw when SDK has bugs", async () => {
      mockAxios.onGet("/test").reply(200, { data: "success" });

      mockTransactionAPI.create.mockImplementation(() => {
        throw new TypeError("SDK bug");
      });

      const client = withSapiom(axiosInstance, {
        sapiomClient: mockSapiomClient,
        failureMode: "closed",
      });

      await expect(client.get("/test")).rejects.toThrow("SDK bug");
    });

    it("should throw when payment handling fails", async () => {
      mockAxios.onGet("/test").reply(402, {
        x402Version: 1,
        accepts: [
          {
            scheme: "exact",
            network: "base",
            maxAmountRequired: "1000000",
            resourceName: "https://api.example.com/test",
            payTo: "0x123",
            asset: "0xUSDC",
          },
        ],
      });

      mockTransactionAPI.create.mockRejectedValue(
        new Error("Sapiom payment API error"),
      );

      const client = withSapiom(axiosInstance, {
        sapiomClient: mockSapiomClient,
        failureMode: "closed",
      });

      await expect(client.get("/test")).rejects.toThrow(
        "Sapiom payment API error",
      );
    });
  });

  describe("default behavior", () => {
    it('should default to "open" when not specified', async () => {
      mockAxios.onGet("/test").reply(200, { data: "success" });

      mockTransactionAPI.create.mockRejectedValue(new Error("Sapiom error"));

      const client = withSapiom(axiosInstance, {
        sapiomClient: mockSapiomClient,
        // No failureMode specified
      });

      // Should not throw (defaults to "open")
      const response = await client.get("/test");
      expect(response.status).toBe(200);
    });
  });

  describe("CRITICAL: Authorization denied should ALWAYS throw", () => {
    it("should throw AuthorizationDeniedError even with failureMode open", async () => {
      mockAxios.onGet("/test").reply(200, { data: "success" });

      mockTransactionAPI.create.mockResolvedValue({
        id: "tx_123",
        status: "denied",
      } as any);

      const client = withSapiom(axiosInstance, {
        sapiomClient: mockSapiomClient,
        failureMode: "open",
      });

      await expect(client.get("/test")).rejects.toThrow("Authorization denied");
    });
  });
});
