/**
 * Critical tests for failureMode behavior
 * These tests ensure Sapiom failures don't break customer apps
 */
import { createFetch } from "./fetch";
import {
  SapiomClient,
  TransactionAPI,
  TransactionRevisionRequiredError,
} from "@sapiom/core";
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

    fetchMock.removeRoutes();
    fetchMock.clearHistory();
  });

  afterAll(() => {
    fetchMock.unmockGlobal();
  });

  it.each(["needs_revision", "authorized"])(
    "leaves an on-demand revision open with status %s",
    async (status) => {
      const revision = {
        id: "tx-on-demand",
        status,
        ...(status === "authorized" && {
          nextAction: { type: "revise", actor: "agent", reasons: [] },
        }),
      };
      mockTransactionAPI.create
        .mockRejectedValueOnce(
          new Error("Preemptive authorization unavailable"),
        )
        .mockResolvedValueOnce(revision as any);
      mockTransactionAPI.reauthorizeWithPayment.mockResolvedValue({
        id: revision.id,
        status: "authorized",
        payment: { authorizationPayload: { x402Version: 1 } },
      } as any);
      fetchMock.get("https://api.example.com/test", {
        status: 402,
        body: {
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
        },
      });
      const client = createFetch({
        sapiomClient: mockSapiomClient,
        failureMode: "open",
      });

      await expect(
        client("https://api.example.com/test"),
      ).rejects.toMatchObject({
        name: "TransactionRevisionRequiredError",
        transaction: revision,
      });
      expect(mockTransactionAPI.create).toHaveBeenCalledTimes(2);
      expect(fetchMock.callHistory.calls()).toHaveLength(1);
      expect(mockTransactionAPI.reauthorizeWithPayment).not.toHaveBeenCalled();
      expect(mockTransactionAPI.complete).not.toHaveBeenCalled();
    },
  );

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
      fetchMock.get("https://api.example.com/test", {
        status: 402,
        body: paymentRequired,
      });
      const client = createFetch({
        sapiomClient: mockSapiomClient,
        failureMode,
        polling: { pollInterval: 1 },
      });
      await expect(
        client("https://api.example.com/test"),
      ).rejects.toBeInstanceOf(TransactionRevisionRequiredError);
      expect(fetchMock.callHistory.calls()).toHaveLength(1);
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
        fetchMock.get("https://api.example.com/test", { status: 200 });
        const client = createFetch({
          sapiomClient: mockSapiomClient,
          failureMode,
          polling: { pollInterval: 1 },
        });
        await expect(
          client("https://api.example.com/test", {
            headers:
              mode === "existing"
                ? { "X-Sapiom-Transaction-Id": "tx-revise" }
                : {},
          }),
        ).rejects.toBeInstanceOf(TransactionRevisionRequiredError);
        expect(fetchMock.callHistory.calls()).toHaveLength(0);
      }
    },
  );

  describe('failureMode: "open" (default)', () => {
    it("should allow request when Sapiom API returns 500", async () => {
      fetchMock.get("https://api.example.com/test", {
        status: 200,
        body: { data: "success" },
      });

      mockTransactionAPI.create.mockRejectedValue(
        new Error("Sapiom API returned 500"),
      );

      const fetch = createFetch({
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

      const fetch = createFetch({
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

      const fetch = createFetch({
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

      const fetch = createFetch({
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

      const fetch = createFetch({
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

      const fetch = createFetch({
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

      const fetch = createFetch({
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

      const fetch = createFetch({
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

      const fetch = createFetch({
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

      const fetch = createFetch({
        sapiomClient: mockSapiomClient,
        failureMode: "open",
      });

      await expect(fetch("https://api.example.com/test")).rejects.toThrow(
        "Authorization denied",
      );
    });
  });
});
