/**
 * Integration tests for AuthorizationHandler with Fetch adapter
 * Tests the complete authorization flow with Fetch HTTP client
 */
import fetchMock from "@fetch-mock/jest";

import { createFetchAdapter } from "./adapter";
import { SapiomClient } from "@sapiom/core";
import { TransactionAPI } from "@sapiom/core";
import { TransactionStatus } from "@sapiom/core";
import { withAuthorizationHandling } from "@sapiom/core";

describe("AuthorizationHandler Integration Tests", () => {
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

  describe("Fetch Integration", () => {
    beforeAll(() => {
      fetchMock.mockGlobal();
    });

    afterAll(() => {
      fetchMock.unmockGlobal();
    });

    afterEach(() => {
      fetchMock.removeRoutes();
    });

    it("should authorize request and add transaction ID header", async () => {
      const adapter = createFetchAdapter("https://api.example.com");

      const authCallbacks = {
        onAuthorizationSuccess: jest.fn(),
      };

      withAuthorizationHandling(adapter, {
        sapiomClient: mockSapiomClient,
        authorizedEndpoints: [
          {
            pathPattern: /^\/api\/sensitive\//,
            serviceName: "sensitive-api",
          },
        ],
        ...authCallbacks,
      });

      fetchMock.route("https://api.example.com/api/sensitive/data", {
        status: 200,
        body: { sensitive: "data" },
      });

      mockTransactionAPI.create.mockResolvedValue({
        id: "tx_fetch_auth",
        status: TransactionStatus.AUTHORIZED,
      } as any);

      const response = await adapter.request({
        method: "GET",
        url: "/api/sensitive/data",
        headers: {},
      });

      expect(response.data).toEqual({ sensitive: "data" });
      expect(authCallbacks.onAuthorizationSuccess).toHaveBeenCalledWith(
        "tx_fetch_auth",
        "/api/sensitive/data",
      );

      // Verify header was added
      const calls = fetchMock.callHistory.calls();
      expect(
        (calls[0]!.options!.headers as any)["x-sapiom-transaction-id"],
      ).toBe("tx_fetch_auth");
    });

    it("should authorize ALL requests when no patterns configured", async () => {
      const adapter = createFetchAdapter("https://api.example.com");

      withAuthorizationHandling(adapter, {
        sapiomClient: mockSapiomClient,
        // No authorizedEndpoints - should authorize everything
      });

      fetchMock.route("https://api.example.com/any/endpoint", {
        status: 200,
        body: { authorized: true },
      });

      mockTransactionAPI.create.mockResolvedValue({
        id: "tx_all",
        status: TransactionStatus.AUTHORIZED,
      } as any);

      const response = await adapter.request({
        method: "POST",
        url: "/any/endpoint",
        headers: {},
        body: { test: "data" },
      });

      expect(response.data).toEqual({ authorized: true });
      expect(mockTransactionAPI.create).toHaveBeenCalled();
    });
  });

  describe("Error Handling Across Adapters", () => {
    beforeAll(() => {
      fetchMock.mockGlobal();
    });

    afterAll(() => {
      fetchMock.unmockGlobal();
    });

    afterEach(() => {
      fetchMock.removeRoutes();
    });

    it("should use __sapiom overrides to force authorization (Fetch)", async () => {
      const adapter = createFetchAdapter("https://api.example.com");

      withAuthorizationHandling(adapter, {
        sapiomClient: mockSapiomClient,
        authorizedEndpoints: [
          {
            pathPattern: /^\/api\/admin\//,
            serviceName: "admin-api",
          },
        ],
      });

      fetchMock.route("https://api.example.com/api/public/action", {
        status: 200,
        body: { authorized: "via override" },
      });

      mockTransactionAPI.create.mockResolvedValue({
        id: "tx_override",
        status: TransactionStatus.AUTHORIZED,
      } as any);

      // Endpoint doesn't match pattern, but __sapiom forces authorization
      const response = await adapter.request({
        method: "POST",
        url: "/api/public/action",
        headers: {},
        __sapiom: {
          serviceName: "custom-service",
          actionName: "custom-action",
        },
      });

      expect(response.data).toEqual({ authorized: "via override" });
      expect(mockTransactionAPI.create).toHaveBeenCalledWith(
        expect.objectContaining({
          serviceName: "custom-service",
          actionName: "custom-action",
        }),
      );
    });
  });

  describe("Trace and Agent Support", () => {
    beforeAll(() => {
      fetchMock.mockGlobal();
    });

    afterAll(() => {
      fetchMock.unmockGlobal();
    });

    afterEach(() => {
      fetchMock.removeRoutes();
    });

    it("should pass agentId through __sapiom metadata (Fetch)", async () => {
      const adapter = createFetchAdapter("https://api.example.com");

      withAuthorizationHandling(adapter, {
        sapiomClient: mockSapiomClient,
        authorizedEndpoints: [
          {
            pathPattern: /^\/api/,
            serviceName: "test-api",
          },
        ],
      });

      fetchMock.route("https://api.example.com/api/action", {
        status: 200,
        body: { result: "ok" },
      });

      mockTransactionAPI.create.mockResolvedValue({
        id: "tx_agent_test",
        status: TransactionStatus.AUTHORIZED,
      } as any);

      await adapter.request({
        method: "POST",
        url: "/api/action",
        headers: {},
        __sapiom: {
          agentId: "AG-001",
        },
      });

      expect(mockTransactionAPI.create).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "AG-001",
        }),
      );
    });
  });
});
