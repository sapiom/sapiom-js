/**
 * Critical tests for failureMode behavior
 * These tests ensure Sapiom failures don't break customer apps
 */
import { createSapiomFetch } from "./fetch";
import { SapiomClient, TransactionAPI } from "@sapiom/core";
import fetchMock from "@fetch-mock/jest";

describe("Fetch failureMode", () => {
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

  describe('failureMode: "open" (default)', () => {
    it("should allow request when Sapiom API returns 500", async () => {
      fetchMock.get("https://api.example.com/test", {
        status: 200,
        body: { data: "success" },
      });

      mockTransactionAPI.create.mockRejectedValue(
        new Error("Sapiom API returned 500"),
      );

      const fetch = createSapiomFetch({
        sapiomClient: mockSapiomClient,
        failureMode: "open",
      });

      const response = await fetch("https://api.example.com/test");
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual({ data: "success" });
    });

    it("should allow request when Sapiom API times out", async () => {
      fetchMock.get("https://api.example.com/test", {
        status: 200,
        body: { data: "success" },
      });

      mockTransactionAPI.create.mockRejectedValue(
        new Error("ETIMEDOUT: Sapiom API timeout"),
      );

      const fetch = createSapiomFetch({
        sapiomClient: mockSapiomClient,
      }); // Default is "open"

      const response = await fetch("https://api.example.com/test");
      expect(response.status).toBe(200);
    });

    it("should allow request when SDK throws unexpected error", async () => {
      fetchMock.get("https://api.example.com/test", {
        status: 200,
        body: { data: "success" },
      });

      mockTransactionAPI.create.mockImplementation(() => {
        throw new TypeError("Cannot read property 'foo' of undefined");
      });

      const fetch = createSapiomFetch({
        sapiomClient: mockSapiomClient,
        failureMode: "open",
      });

      const response = await fetch("https://api.example.com/test");
      expect(response.status).toBe(200);
    });

    it("should return original 402 when payment handling fails", async () => {
      fetchMock.get("https://api.example.com/test", {
        status: 402,
        body: {
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
        },
      });

      mockTransactionAPI.create.mockRejectedValue(
        new Error("Sapiom API error"),
      );

      const fetch = createSapiomFetch({
        sapiomClient: mockSapiomClient,
        failureMode: "open",
      });

      const response = await fetch("https://api.example.com/test");
      // Should get original 402, not Sapiom error
      expect(response.status).toBe(402);
    });
  });

  describe('failureMode: "closed"', () => {
    it("should throw when Sapiom API returns 500", async () => {
      fetchMock.get("https://api.example.com/test", {
        status: 200,
        body: { data: "success" },
      });

      mockTransactionAPI.create.mockRejectedValue(
        new Error("Sapiom API returned 500"),
      );

      const fetch = createSapiomFetch({
        sapiomClient: mockSapiomClient,
        failureMode: "closed",
      });

      await expect(fetch("https://api.example.com/test")).rejects.toThrow(
        "Sapiom API returned 500",
      );
    });

    it("should throw when Sapiom API times out", async () => {
      fetchMock.get("https://api.example.com/test", {
        status: 200,
        body: { data: "success" },
      });

      mockTransactionAPI.create.mockRejectedValue(new Error("ETIMEDOUT"));

      const fetch = createSapiomFetch({
        sapiomClient: mockSapiomClient,
        failureMode: "closed",
      });

      await expect(fetch("https://api.example.com/test")).rejects.toThrow(
        "ETIMEDOUT",
      );
    });

    it("should throw when SDK has bugs", async () => {
      fetchMock.get("https://api.example.com/test", {
        status: 200,
        body: { data: "success" },
      });

      mockTransactionAPI.create.mockImplementation(() => {
        throw new TypeError("SDK bug");
      });

      const fetch = createSapiomFetch({
        sapiomClient: mockSapiomClient,
        failureMode: "closed",
      });

      await expect(fetch("https://api.example.com/test")).rejects.toThrow(
        "SDK bug",
      );
    });

    it("should throw when payment handling fails", async () => {
      fetchMock.get("https://api.example.com/test", {
        status: 402,
        body: {
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
        },
      });

      mockTransactionAPI.create.mockRejectedValue(
        new Error("Sapiom payment API error"),
      );

      const fetch = createSapiomFetch({
        sapiomClient: mockSapiomClient,
        failureMode: "closed",
      });

      await expect(fetch("https://api.example.com/test")).rejects.toThrow(
        "Sapiom payment API error",
      );
    });
  });

  describe("default behavior", () => {
    it('should default to "open" when not specified', async () => {
      fetchMock.get("https://api.example.com/test", {
        status: 200,
        body: { data: "success" },
      });

      mockTransactionAPI.create.mockRejectedValue(new Error("Sapiom error"));

      const fetch = createSapiomFetch({
        sapiomClient: mockSapiomClient,
        // No failureMode specified
      });

      // Should not throw (defaults to "open")
      const response = await fetch("https://api.example.com/test");
      expect(response.status).toBe(200);
    });
  });

  describe("CRITICAL: Authorization denied should ALWAYS throw", () => {
    it("should throw AuthorizationDeniedError even with failureMode open", async () => {
      fetchMock.get("https://api.example.com/test", {
        status: 200,
        body: { data: "success" },
      });

      mockTransactionAPI.create.mockResolvedValue({
        id: "tx_123",
        status: "denied",
      } as any);

      const fetch = createSapiomFetch({
        sapiomClient: mockSapiomClient,
        failureMode: "open",
      });

      await expect(fetch("https://api.example.com/test")).rejects.toThrow(
        "Authorization denied",
      );
    });
  });
});
