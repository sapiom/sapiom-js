/**
 * Integration tests for AuthorizationHandler with Node HTTP adapter
 * Tests the complete authorization flow with Node HTTP client
 */
import nock from "nock";

import { createNodeHttpAdapter } from "./adapter";
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

  describe("Node HTTP Integration", () => {
    afterEach(() => {
      nock.cleanAll();
    });

    it("should authorize request and add transaction ID header", async () => {
      const adapter = createNodeHttpAdapter();

      const authCallbacks = {
        onAuthorizationSuccess: jest.fn(),
      };

      withAuthorizationHandling(adapter, {
        sapiomClient: mockSapiomClient,
        // Authorize all requests (no pattern)
        authorizedEndpoints: undefined,
        ...authCallbacks,
      });

      const baseURL = "https://api.example.com";

      // Mock successful response
      nock(baseURL)
        .get("/api/protected/resource")
        .reply(200, { protected: "resource" });

      // Mock immediate authorization
      mockTransactionAPI.create.mockResolvedValue({
        id: "tx_node_auth",
        status: TransactionStatus.AUTHORIZED,
      } as any);

      const response = await adapter.request({
        method: "GET",
        url: `${baseURL}/api/protected/resource`,
        headers: {},
      });

      expect(response.data).toEqual({ protected: "resource" });
      expect(mockTransactionAPI.create).toHaveBeenCalled();
      expect(authCallbacks.onAuthorizationSuccess).toHaveBeenCalled();
    });
  });

  describe("Error Handling Across Adapters", () => {
    afterEach(() => {
      nock.cleanAll();
    });

    it("should skip authorization with skipAuthorization flag (Node HTTP)", async () => {
      const adapter = createNodeHttpAdapter();

      withAuthorizationHandling(adapter, {
        sapiomClient: mockSapiomClient,
        // Authorize everything
        authorizedEndpoints: undefined,
      });

      const baseURL = "https://api.example.com";

      nock(baseURL).get("/api/public-status").reply(200, { status: "ok" });

      const response = await adapter.request({
        method: "GET",
        url: `${baseURL}/api/public-status`,
        headers: {},
        __sapiom: {
          skipAuthorization: true,
        },
      });

      expect(response.data).toEqual({ status: "ok" });
      expect(mockTransactionAPI.create).not.toHaveBeenCalled();
    });
  });

  describe("Trace and Agent Support", () => {
    afterEach(() => {
      nock.cleanAll();
    });

    it("should pass agentName through __sapiom metadata (Node HTTP)", async () => {
      const adapter = createNodeHttpAdapter();

      withAuthorizationHandling(adapter, {
        sapiomClient: mockSapiomClient,
        authorizedEndpoints: [
          {
            pathPattern: /^\/api/,
            serviceName: "test-api",
          },
        ],
      });

      const baseURL = "https://api.example.com";

      nock(baseURL).post("/api/create").reply(200, { created: true });

      mockTransactionAPI.create.mockResolvedValue({
        id: "tx_agent_name_test",
        status: TransactionStatus.AUTHORIZED,
      } as any);

      await adapter.request({
        method: "POST",
        url: `${baseURL}/api/create`,
        headers: {},
        __sapiom: {
          agentName: "support-bot",
        },
      });

      expect(mockTransactionAPI.create).toHaveBeenCalledWith(
        expect.objectContaining({
          agentName: "support-bot",
        }),
      );
    });
  });
});
