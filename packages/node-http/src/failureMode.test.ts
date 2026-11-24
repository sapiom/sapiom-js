/**
 * Critical tests for failureMode behavior
 * These tests ensure Sapiom failures don't break customer apps
 */
import { createClient } from "./node-http";
import {
  SapiomClient,
  TransactionAPI,
  TransactionRevisionRequiredError,
} from "@sapiom/core";
import nock from "nock";

describe("Node-HTTP failureMode", () => {
  let mockTransactionAPI: jest.Mocked<TransactionAPI>;
  let mockSapiomClient: SapiomClient;

  beforeEach(() => {
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
    nock.cleanAll();
  });

  it.each([
    ["open", false, "needs_revision"],
    ["open", true, "needs_revision"],
    ["closed", false, "needs_revision"],
    ["closed", true, "needs_revision"],
    ["open", false, "authorized"],
    ["open", true, "authorized"],
    ["closed", false, "authorized"],
    ["closed", true, "authorized"],
  ] as const)(
    "leaves a payment revision open (%s, polled: %s, status: %s)",
    async (failureMode, pending, status) => {
      const revision = {
        id: "tx-revise",
        status,
        ...(status === "authorized" && {
          nextAction: { type: "revise", actor: "agent", reasons: [] },
        }),
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
      mockTransactionAPI.get.mockResolvedValue(revision as any);
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
      const merchant = nock("https://api.example.com")
        .get("/test")
        .reply(402, paymentRequired);
      const client = createClient({
        sapiomClient: mockSapiomClient,
        failureMode,
        polling: { pollInterval: 1 },
      });
      await expect(
        client.request({
          method: "GET",
          url: "https://api.example.com/test",
          headers: {},
        }),
      ).rejects.toBeInstanceOf(TransactionRevisionRequiredError);
      expect(merchant.isDone()).toBe(true);
      expect(mockTransactionAPI.reauthorizeWithPayment).toHaveBeenCalledTimes(
        1,
      );
      expect(mockTransactionAPI.complete).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["open", "needs_revision"],
    ["closed", "needs_revision"],
    ["open", "authorized"],
    ["closed", "authorized"],
  ] as const)(
    "blocks revision decisions in failureMode %s with status %s",
    async (failureMode, status) => {
      for (const mode of ["create", "existing", "poll"] as const) {
        const transaction = {
          id: "tx-revise",
          status,
          ...(status === "authorized" && {
            nextAction: { type: "revise", actor: "agent", reasons: [] },
          }),
        };
        mockTransactionAPI.create.mockResolvedValue(
          mode === "poll"
            ? ({ id: "tx-revise", status: "pending" } as any)
            : (transaction as any),
        );
        mockTransactionAPI.get.mockResolvedValue(transaction as any);
        const endpoint = nock("https://api.example.com")
          .get("/test")
          .reply(200);
        const client = createClient({
          sapiomClient: mockSapiomClient,
          failureMode,
          polling: { pollInterval: 1 },
        });
        await expect(
          client.request({
            method: "GET",
            url: "https://api.example.com/test",
            headers:
              mode === "existing"
                ? { "X-Sapiom-Transaction-Id": "tx-revise" }
                : {},
          }),
        ).rejects.toBeInstanceOf(TransactionRevisionRequiredError);
        expect(endpoint.isDone()).toBe(false);
      }
    },
  );

  describe('failureMode: "open" (default)', () => {
    it("should allow request when Sapiom API returns 500", async () => {
      nock("https://api.example.com")
        .get("/test")
        .reply(200, { data: "success" });

      mockTransactionAPI.create.mockRejectedValue(
        new Error("Sapiom API returned 500"),
      );

      const client = createClient({
        sapiomClient: mockSapiomClient,
        failureMode: "open",
      });

      const response = await client.request({
        method: "GET",
        url: "https://api.example.com/test",
        headers: {},
      });

      expect(response.status).toBe(200);
      expect(response.data).toEqual({ data: "success" });
    });

    it("should allow request when Sapiom API times out", async () => {
      nock("https://api.example.com")
        .get("/test")
        .reply(200, { data: "success" });

      mockTransactionAPI.create.mockRejectedValue(
        new Error("ETIMEDOUT: Sapiom API timeout"),
      );

      const client = createClient({
        sapiomClient: mockSapiomClient,
      }); // Default is "open"

      const response = await client.request({
        method: "GET",
        url: "https://api.example.com/test",
        headers: {},
      });

      expect(response.status).toBe(200);
    });

    it("should allow request when SDK throws unexpected error", async () => {
      nock("https://api.example.com")
        .get("/test")
        .reply(200, { data: "success" });

      mockTransactionAPI.create.mockImplementation(() => {
        throw new TypeError("Cannot read property 'foo' of undefined");
      });

      const client = createClient({
        sapiomClient: mockSapiomClient,
        failureMode: "open",
      });

      const response = await client.request({
        method: "GET",
        url: "https://api.example.com/test",
        headers: {},
      });

      expect(response.status).toBe(200);
    });

    it("should throw original 402 when payment handling fails", async () => {
      nock("https://api.example.com")
        .get("/test")
        .reply(402, {
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
        new Error("Sapiom API error"),
      );

      const client = createClient({
        sapiomClient: mockSapiomClient,
        failureMode: "open",
      });

      try {
        await client.request({
          method: "GET",
          url: "https://api.example.com/test",
          headers: {},
        });
        fail("Should have thrown 402 error");
      } catch (error: any) {
        // Should get original 402, not Sapiom error
        expect(error.response?.status).toBe(402);
      }
    });
  });

  describe('failureMode: "closed"', () => {
    it("should throw when Sapiom API returns 500", async () => {
      nock("https://api.example.com")
        .get("/test")
        .reply(200, { data: "success" });

      mockTransactionAPI.create.mockRejectedValue(
        new Error("Sapiom API returned 500"),
      );

      const client = createClient({
        sapiomClient: mockSapiomClient,
        failureMode: "closed",
      });

      await expect(
        client.request({
          method: "GET",
          url: "https://api.example.com/test",
          headers: {},
        }),
      ).rejects.toThrow("Sapiom API returned 500");
    });

    it("should throw when Sapiom API times out", async () => {
      nock("https://api.example.com")
        .get("/test")
        .reply(200, { data: "success" });

      mockTransactionAPI.create.mockRejectedValue(new Error("ETIMEDOUT"));

      const client = createClient({
        sapiomClient: mockSapiomClient,
        failureMode: "closed",
      });

      await expect(
        client.request({
          method: "GET",
          url: "https://api.example.com/test",
          headers: {},
        }),
      ).rejects.toThrow("ETIMEDOUT");
    });

    it("should throw when SDK has bugs", async () => {
      nock("https://api.example.com")
        .get("/test")
        .reply(200, { data: "success" });

      mockTransactionAPI.create.mockImplementation(() => {
        throw new TypeError("SDK bug");
      });

      const client = createClient({
        sapiomClient: mockSapiomClient,
        failureMode: "closed",
      });

      await expect(
        client.request({
          method: "GET",
          url: "https://api.example.com/test",
          headers: {},
        }),
      ).rejects.toThrow("SDK bug");
    });
  });

  describe("default behavior", () => {
    it('should default to "open" when not specified', async () => {
      nock("https://api.example.com")
        .get("/test")
        .reply(200, { data: "success" });

      mockTransactionAPI.create.mockRejectedValue(new Error("Sapiom error"));

      const client = createClient({
        sapiomClient: mockSapiomClient,
        // No failureMode specified
      });

      // Should not throw (defaults to "open")
      const response = await client.request({
        method: "GET",
        url: "https://api.example.com/test",
        headers: {},
      });

      expect(response.status).toBe(200);
    });
  });

  describe("CRITICAL: Authorization denied should ALWAYS throw", () => {
    it("should throw AuthorizationDeniedError even with failureMode open", async () => {
      nock("https://api.example.com")
        .get("/test")
        .reply(200, { data: "success" });

      mockTransactionAPI.create.mockResolvedValue({
        id: "tx_123",
        status: "denied",
      } as any);

      const client = createClient({
        sapiomClient: mockSapiomClient,
        failureMode: "open",
      });

      await expect(
        client.request({
          method: "GET",
          url: "https://api.example.com/test",
          headers: {},
        }),
      ).rejects.toThrow("Authorization denied");
    });
  });
});
