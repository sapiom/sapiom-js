/**
 * Critical tests for failureMode behavior
 * These tests ensure Sapiom failures don't break customer apps
 */
import { createSapiomNodeHttp } from "./node-http";
import { SapiomClient, TransactionAPI } from "@sapiom/core";
import nock from "nock";

describe("Node-HTTP failureMode", () => {
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

  afterEach(() => {
    nock.cleanAll();
  });

  describe('failureMode: "open" (default)', () => {
    it("should allow request when Sapiom API returns 500", async () => {
      nock("https://api.example.com")
        .get("/test")
        .reply(200, { data: "success" });

      mockTransactionAPI.create.mockRejectedValue(
        new Error("Sapiom API returned 500"),
      );

      const client = createSapiomNodeHttp({
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

      const client = createSapiomNodeHttp({
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

      const client = createSapiomNodeHttp({
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

      const client = createSapiomNodeHttp({
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

      const client = createSapiomNodeHttp({
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

      const client = createSapiomNodeHttp({
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

      const client = createSapiomNodeHttp({
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

      const client = createSapiomNodeHttp({
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

      const client = createSapiomNodeHttp({
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
