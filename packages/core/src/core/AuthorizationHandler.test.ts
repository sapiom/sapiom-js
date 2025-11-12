import { HttpRequest } from "../http/types";
import { SapiomClient } from "../lib/SapiomClient";
import { TransactionAPI } from "../lib/TransactionAPI";
import { TransactionResponse, TransactionStatus } from "../types/transaction";
import {
  AuthorizationDeniedError,
  AuthorizationHandler,
  AuthorizationHandlerConfig,
  AuthorizationTimeoutError,
  EndpointAuthorizationRule,
} from "./AuthorizationHandler";

describe("AuthorizationHandler", () => {
  let mockTransactionAPI: jest.Mocked<TransactionAPI>;
  let mockSapiomClient: SapiomClient;
  let config: AuthorizationHandlerConfig;
  let handler: AuthorizationHandler;

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
      addFacts: jest.fn().mockResolvedValue({
        success: true,
        factId: "fact-123",
      }),
      addCost: jest.fn(),
      listCosts: jest.fn(),
    } as any;

    mockSapiomClient = {
      transactions: mockTransactionAPI,
    } as any;

    config = {
      sapiomClient: mockSapiomClient,
      onAuthorizationPending: jest.fn(),
      onAuthorizationSuccess: jest.fn(),
      onAuthorizationDenied: jest.fn(),
      authorizationTimeout: 30000,
      pollingInterval: 100,
    };

    handler = new AuthorizationHandler(config);
  });

  describe("handleRequest", () => {
    it("should validate existing transaction ID and continue if authorized", async () => {
      const existingTx: TransactionResponse = {
        id: "tx_existing",
        organizationId: "org_1",
        serviceName: "test",
        actionName: "read",
        resourceName: "/test",
        status: TransactionStatus.AUTHORIZED,
        requiresPayment: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      mockTransactionAPI.get.mockResolvedValue(existingTx);

      const request: HttpRequest = {
        method: "GET",
        url: "/api/admin/users",
        headers: {
          "X-Sapiom-Transaction-Id": "tx_existing",
        },
      };

      const result = await handler.handleRequest(request);

      // Should validate the existing transaction
      expect(mockTransactionAPI.get).toHaveBeenCalledWith("tx_existing");

      // Should return request unchanged if valid
      expect(result).toEqual(request);
      expect(mockTransactionAPI.create).not.toHaveBeenCalled();
    });

    it("should throw error for denied existing transaction", async () => {
      const deniedTx: TransactionResponse = {
        id: "tx_denied_existing",
        organizationId: "org_1",
        serviceName: "test",
        actionName: "read",
        resourceName: "/test",
        status: TransactionStatus.DENIED,
        requiresPayment: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      mockTransactionAPI.get.mockResolvedValue(deniedTx);

      const request: HttpRequest = {
        method: "GET",
        url: "/test",
        headers: {
          "X-Sapiom-Transaction-Id": "tx_denied_existing",
        },
      };

      // Should throw AuthorizationDeniedError
      await expect(handler.handleRequest(request)).rejects.toThrow(
        AuthorizationDeniedError,
      );

      // Should check existing transaction
      expect(mockTransactionAPI.get).toHaveBeenCalledWith("tx_denied_existing");

      // Should NOT create new transaction
      expect(mockTransactionAPI.create).not.toHaveBeenCalled();
    });

    it("should wait for pending existing transaction", async () => {
      const pendingTx: TransactionResponse = {
        id: "tx_pending_existing",
        organizationId: "org_1",
        serviceName: "test",
        actionName: "read",
        resourceName: "/test",
        status: TransactionStatus.PENDING,
        requiresPayment: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const authorizedTx: TransactionResponse = {
        ...pendingTx,
        status: TransactionStatus.AUTHORIZED,
      };

      mockTransactionAPI.get
        .mockResolvedValueOnce(pendingTx) // First get for validation
        .mockResolvedValueOnce(authorizedTx); // Poll returns authorized

      const request: HttpRequest = {
        method: "GET",
        url: "/test",
        headers: {
          "X-Sapiom-Transaction-Id": "tx_pending_existing",
        },
      };

      const result = await handler.handleRequest(request);

      // Should NOT create new transaction
      expect(mockTransactionAPI.create).not.toHaveBeenCalled();

      // Should NOT call onAuthorizationPending (transaction already exists)
      expect(config.onAuthorizationPending).not.toHaveBeenCalled();

      // Should call onAuthorizationSuccess when authorized
      expect(config.onAuthorizationSuccess).toHaveBeenCalledWith(
        "tx_pending_existing",
        "/test",
      );

      // Should return request with same transaction ID
      expect(result.headers["X-Sapiom-Transaction-Id"]).toBe(
        "tx_pending_existing",
      );
    });

    it("should skip if skipAuthorization flag is set in __sapiom", async () => {
      const request: HttpRequest = {
        method: "GET",
        url: "/api/admin/users",
        headers: {},
        __sapiom: {
          skipAuthorization: true,
        },
      };

      const result = await handler.handleRequest(request);

      expect(result).toEqual(request);
      expect(mockTransactionAPI.create).not.toHaveBeenCalled();
    });

    it("should authorize ALL requests when no endpoint patterns configured", async () => {
      const emptyHandler = new AuthorizationHandler({
        ...config,
        authorizedEndpoints: undefined,
      });

      const mockTx: TransactionResponse = {
        id: "tx_all",
        organizationId: "org_1",
        serviceName: "test",
        actionName: "read",
        resourceName: "/test",
        status: TransactionStatus.AUTHORIZED,
        requiresPayment: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      mockTransactionAPI.create.mockResolvedValue(mockTx);

      const request: HttpRequest = {
        method: "GET",
        url: "/test",
        headers: {},
      };

      const result = await emptyHandler.handleRequest(request);

      // Should create transaction even though no patterns configured
      expect(mockTransactionAPI.create).toHaveBeenCalled();
      expect(result.headers["X-Sapiom-Transaction-Id"]).toBe("tx_all");
    });

    it("should skip authorization if endpoint does not match any pattern", async () => {
      const handlerWithPatterns = new AuthorizationHandler({
        ...config,
        authorizedEndpoints: [
          {
            pathPattern: /^\/api\/admin\//,
            serviceName: "admin-api",
          },
        ],
      });

      const request: HttpRequest = {
        method: "GET",
        url: "/api/public/data",
        headers: {},
      };

      const result = await handlerWithPatterns.handleRequest(request);

      expect(result).toEqual(request);
      expect(mockTransactionAPI.create).not.toHaveBeenCalled();
    });

    it("should authorize if __sapiom metadata is provided (even without pattern match)", async () => {
      const handlerWithPatterns = new AuthorizationHandler({
        ...config,
        authorizedEndpoints: [
          {
            pathPattern: /^\/api\/admin\//,
            serviceName: "admin-api",
          },
        ],
      });

      const mockTx: TransactionResponse = {
        id: "tx_override",
        organizationId: "org_1",
        serviceName: "custom-service",
        actionName: "custom-action",
        resourceName: "custom:resource",
        status: TransactionStatus.AUTHORIZED,
        requiresPayment: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      mockTransactionAPI.create.mockResolvedValue(mockTx);

      const request: HttpRequest = {
        method: "POST",
        url: "/api/public/action",
        headers: {},
        __sapiom: {
          serviceName: "custom-service",
          actionName: "custom-action",
          resourceName: "custom:resource",
        },
      };

      const result = await handler.handleRequest(request);

      // Should authorize because __sapiom was provided
      const createCall = (mockTransactionAPI.create as jest.Mock).mock
        .calls[0][0];

      // Verify requestFacts sent
      expect(createCall.requestFacts).toBeDefined();
      expect(createCall.requestFacts.source).toBe("http-client");
      expect(createCall.requestFacts.request.method).toBe("POST");
      expect(createCall.requestFacts.request.url).toBe("/api/public/action");

      // Verify user overrides applied
      expect(createCall.serviceName).toBe("custom-service");
      expect(createCall.actionName).toBe("custom-action");
      expect(createCall.resourceName).toBe("custom:resource");

      expect(result.headers["X-Sapiom-Transaction-Id"]).toBe("tx_override");
    });

    it("should create transaction and add header for authorized transaction", async () => {
      const handlerWithPatterns = new AuthorizationHandler({
        ...config,
        authorizedEndpoints: [
          {
            pathPattern: /^\/api\/admin\//,
            serviceName: "admin-api",
          },
        ],
      });

      const mockTx: TransactionResponse = {
        id: "tx_authorized",
        organizationId: "org_1",
        serviceName: "admin-api",
        actionName: "read",
        resourceName: "/api/admin/users",
        status: TransactionStatus.AUTHORIZED,
        requiresPayment: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      mockTransactionAPI.create.mockResolvedValue(mockTx);

      const request: HttpRequest = {
        method: "GET",
        url: "/api/admin/users",
        headers: {},
      };

      const result = await handlerWithPatterns.handleRequest(request);

      const createCall = (mockTransactionAPI.create as jest.Mock).mock
        .calls[0][0];

      // Verify requestFacts sent
      expect(createCall.requestFacts).toBeDefined();
      expect(createCall.requestFacts.source).toBe("http-client");

      // Verify rule serviceName override applied (actionName/resourceName inferred by backend)
      expect(createCall.serviceName).toBe("admin-api");

      expect(result.headers["X-Sapiom-Transaction-Id"]).toBe("tx_authorized");
      expect(config.onAuthorizationSuccess).toHaveBeenCalledWith(
        "tx_authorized",
        "/api/admin/users",
      );
    });

    it("should throw AuthorizationDeniedError for denied transactions", async () => {
      const handlerWithPatterns = new AuthorizationHandler({
        ...config,
        authorizedEndpoints: [
          {
            pathPattern: /^\/api\/admin\//,
            serviceName: "admin-api",
          },
        ],
      });

      const mockTx: TransactionResponse = {
        id: "tx_denied",
        organizationId: "org_1",
        serviceName: "admin-api",
        actionName: "read",
        resourceName: "/api/admin/users",
        status: TransactionStatus.DENIED,
        requiresPayment: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      mockTransactionAPI.create.mockResolvedValue(mockTx);

      const request: HttpRequest = {
        method: "GET",
        url: "/api/admin/users",
        headers: {},
      };

      await expect(handler.handleRequest(request)).rejects.toThrow(
        AuthorizationDeniedError,
      );
      await expect(handler.handleRequest(request)).rejects.toThrow(
        "Authorization denied",
      );

      expect(config.onAuthorizationDenied).toHaveBeenCalledWith(
        "tx_denied",
        "/api/admin/users",
      );
    });

    it("should not throw for denied if throwOnDenied is false", async () => {
      const lenientHandler = new AuthorizationHandler({
        ...config,
        throwOnDenied: false,
        authorizedEndpoints: [
          {
            pathPattern: /^\/api\/admin\//,
            serviceName: "admin-api",
          },
        ],
      });

      const mockTx: TransactionResponse = {
        id: "tx_denied_lenient",
        organizationId: "org_1",
        serviceName: "admin-api",
        actionName: "read",
        resourceName: "/api/admin/users",
        status: TransactionStatus.DENIED,
        requiresPayment: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      mockTransactionAPI.create.mockResolvedValue(mockTx);

      const request: HttpRequest = {
        method: "GET",
        url: "/api/admin/users",
        headers: {},
      };

      const result = await lenientHandler.handleRequest(request);

      // Should continue without authorization
      expect(result).toEqual(request);
      expect(result.headers["X-Sapiom-Transaction-Id"]).toBeUndefined();
    });

    it("should handle cancelled transactions same as denied", async () => {
      const handlerWithPatterns = new AuthorizationHandler({
        ...config,
        authorizedEndpoints: [
          {
            pathPattern: /^\/api\/admin\//,
            serviceName: "admin-api",
          },
        ],
      });

      const mockTx: TransactionResponse = {
        id: "tx_cancelled",
        organizationId: "org_1",
        serviceName: "admin-api",
        actionName: "delete",
        resourceName: "/api/admin/users/123",
        status: TransactionStatus.CANCELLED,
        requiresPayment: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      mockTransactionAPI.create.mockResolvedValue(mockTx);

      const request: HttpRequest = {
        method: "DELETE",
        url: "/api/admin/users/123",
        headers: {},
      };

      await expect(handler.handleRequest(request)).rejects.toThrow(
        AuthorizationDeniedError,
      );
    });

    it("should wait for pending transaction and add header when authorized", async () => {
      const handlerWithPatterns = new AuthorizationHandler({
        ...config,
        authorizedEndpoints: [
          {
            pathPattern: /^\/api\/admin\//,
            serviceName: "admin-api",
          },
        ],
      });

      const pendingTx: TransactionResponse = {
        id: "tx_pending",
        organizationId: "org_1",
        serviceName: "admin-api",
        actionName: "read",
        resourceName: "/api/admin/users",
        status: TransactionStatus.PENDING,
        requiresPayment: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const authorizedTx: TransactionResponse = {
        ...pendingTx,
        status: TransactionStatus.AUTHORIZED,
      };

      mockTransactionAPI.create.mockResolvedValue(pendingTx);
      mockTransactionAPI.get.mockResolvedValueOnce(authorizedTx);

      const request: HttpRequest = {
        method: "GET",
        url: "/api/admin/users",
        headers: {},
      };

      const result = await handler.handleRequest(request);

      expect(config.onAuthorizationPending).toHaveBeenCalledWith(
        "tx_pending",
        "/api/admin/users",
      );
      expect(config.onAuthorizationSuccess).toHaveBeenCalledWith(
        "tx_pending",
        "/api/admin/users",
      );
      expect(result.headers["X-Sapiom-Transaction-Id"]).toBe("tx_pending");
    });

    it("should throw timeout error for pending transactions that never authorize", async () => {
      const quickHandler = new AuthorizationHandler({
        ...config,
        authorizationTimeout: 200,
        pollingInterval: 50,
        authorizedEndpoints: [
          {
            pathPattern: /^\/api\/admin\//,
            serviceName: "admin-api",
          },
        ],
      });

      const pendingTx: TransactionResponse = {
        id: "tx_timeout",
        organizationId: "org_1",
        serviceName: "admin-api",
        actionName: "read",
        resourceName: "/api/admin/users",
        status: TransactionStatus.PENDING,
        requiresPayment: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      mockTransactionAPI.create.mockResolvedValue(pendingTx);
      mockTransactionAPI.get.mockResolvedValue(pendingTx); // Always pending

      const request: HttpRequest = {
        method: "GET",
        url: "/api/admin/users",
        headers: {},
      };

      await expect(quickHandler.handleRequest(request)).rejects.toThrow(
        AuthorizationTimeoutError,
      );
      await expect(quickHandler.handleRequest(request)).rejects.toThrow(
        "timeout",
      );
    });

    it("should use __sapiom metadata overrides", async () => {
      const handlerWithPatterns = new AuthorizationHandler({
        ...config,
        authorizedEndpoints: [
          {
            pathPattern: /^\/api\/documents\//,
            serviceName: "default-docs",
          },
        ],
      });

      const mockTx: TransactionResponse = {
        id: "tx_custom",
        organizationId: "org_1",
        serviceName: "document-management",
        actionName: "delete-document",
        resourceName: "document:doc-12345",
        status: TransactionStatus.AUTHORIZED,
        requiresPayment: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      mockTransactionAPI.create.mockResolvedValue(mockTx);

      const request: HttpRequest = {
        method: "DELETE",
        url: "/api/documents/doc-12345",
        headers: {},
        __sapiom: {
          serviceName: "document-management",
          actionName: "delete-document",
          resourceName: "document:doc-12345",
          qualifiers: {
            reason: "gdpr-request",
            requestedBy: "user_789",
          },
          metadata: {
            sensitivityLevel: "high",
          },
        },
      };

      const result = await handler.handleRequest(request);

      const createCall = (mockTransactionAPI.create as jest.Mock).mock
        .calls[0][0];

      // Verify requestFacts sent
      expect(createCall.requestFacts).toBeDefined();
      expect(createCall.requestFacts.source).toBe("http-client");
      expect(createCall.requestFacts.request.method).toBe("DELETE");

      // Verify __sapiom overrides applied
      expect(createCall.serviceName).toBe("document-management");
      expect(createCall.actionName).toBe("delete-document");
      expect(createCall.resourceName).toBe("document:doc-12345");

      // Verify qualifiers and metadata preserved
      expect(createCall.qualifiers).toMatchObject({
        reason: "gdpr-request",
        requestedBy: "user_789",
      });
      expect(createCall.metadata).toMatchObject({
        sensitivityLevel: "high",
        preemptiveAuthorization: true,
      });

      expect(result.headers["X-Sapiom-Transaction-Id"]).toBe("tx_custom");
    });

    it.skip("should fallback to extracted values when no __sapiom provided (MOVED TO BACKEND)", async () => {
      // NOTE: Extraction logic moved to HttpClientHandlerV1 in backend
      // SDK now always sends requestFacts, backend infers service/action/resource
      const handlerWithPatterns = new AuthorizationHandler({
        ...config,
        authorizedEndpoints: [
          {
            pathPattern: /^\/api\/admin\//,
            serviceName: "admin-api",
          },
        ],
      });

      const mockTx: TransactionResponse = {
        id: "tx_extracted",
        organizationId: "org_1",
        serviceName: "admin-api",
        actionName: "read",
        resourceName: "/api/admin/users",
        status: TransactionStatus.AUTHORIZED,
        requiresPayment: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      mockTransactionAPI.create.mockResolvedValue(mockTx);

      const request: HttpRequest = {
        method: "GET",
        url: "/api/admin/users",
        headers: {},
      };

      await handlerWithPatterns.handleRequest(request);

      expect(mockTransactionAPI.create).toHaveBeenCalledWith(
        expect.objectContaining({
          serviceName: "admin-api", // From rule
          actionName: "read", // Mapped from GET
          resourceName: "/api/admin/users", // From URL
        }),
      );
    });

    it.skip("should use custom resourceExtractor from rule (DEPRECATED)", async () => {
      // NOTE: Resource extraction logic moved to backend handlers
      // Users should use explicit resourceName in __sapiom if needed
      const handlerWithExtractor = new AuthorizationHandler({
        ...config,
        authorizedEndpoints: [
          {
            pathPattern: /^\/api\/documents\/([^/]+)/,
            serviceName: "docs",
            resourceExtractor: (req) => {
              const match = req.url.match(/\/documents\/([^/]+)/);
              return match ? `document:${match[1]}` : req.url;
            },
          },
        ],
      });

      const mockTx: TransactionResponse = {
        id: "tx_extracted_resource",
        organizationId: "org_1",
        serviceName: "docs",
        actionName: "update",
        resourceName: "document:abc-123",
        status: TransactionStatus.AUTHORIZED,
        requiresPayment: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      mockTransactionAPI.create.mockResolvedValue(mockTx);

      const request: HttpRequest = {
        method: "PUT",
        url: "/api/documents/abc-123",
        headers: {},
        body: { title: "Updated" },
      };

      await handlerWithExtractor.handleRequest(request);

      expect(mockTransactionAPI.create).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceName: "document:abc-123", // From custom extractor
        }),
      );
    });

    it.skip("should use dynamic qualifiers from rule function (DEPRECATED)", async () => {
      // NOTE: Dynamic qualifiers still work but are now user responsibility via __sapiom
      // Backend has richer facts to work with
      const handlerWithQualifiers = new AuthorizationHandler({
        ...config,
        authorizedEndpoints: [
          {
            pathPattern: /^\/api\/documents\//,
            serviceName: "docs",
            qualifiers: (req) => ({
              documentId: req.url.match(/\/documents\/([^/]+)/)?.[1],
              operation: req.method.toLowerCase(),
              hasBody: !!req.body,
            }),
          },
        ],
      });

      const mockTx: TransactionResponse = {
        id: "tx_qualifiers",
        organizationId: "org_1",
        serviceName: "docs",
        actionName: "update",
        resourceName: "/api/documents/xyz",
        status: TransactionStatus.AUTHORIZED,
        requiresPayment: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      mockTransactionAPI.create.mockResolvedValue(mockTx);

      const request: HttpRequest = {
        method: "PATCH",
        url: "/api/documents/xyz",
        headers: {},
        body: { content: "updated" },
      };

      await handlerWithQualifiers.handleRequest(request);

      expect(mockTransactionAPI.create).toHaveBeenCalledWith(
        expect.objectContaining({
          qualifiers: expect.objectContaining({
            documentId: "xyz",
            operation: "patch",
            hasBody: true,
            method: "PATCH",
          }),
        }),
      );
    });

    it("should match endpoints by method", async () => {
      const handlerWithMethods = new AuthorizationHandler({
        ...config,
        authorizedEndpoints: [
          {
            method: ["POST", "PUT", "DELETE"],
            pathPattern: /^\/api\/data\//,
            serviceName: "data-api",
          },
        ],
      });

      const mockTx: TransactionResponse = {
        id: "tx_method",
        organizationId: "org_1",
        serviceName: "data-api",
        actionName: "delete",
        resourceName: "/api/data/item",
        status: TransactionStatus.AUTHORIZED,
        requiresPayment: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      mockTransactionAPI.create.mockResolvedValue(mockTx);

      // DELETE should match
      await handlerWithMethods.handleRequest({
        method: "DELETE",
        url: "/api/data/item",
        headers: {},
      });

      expect(mockTransactionAPI.create).toHaveBeenCalled();

      // GET should not match
      mockTransactionAPI.create.mockClear();

      const getResult = await handlerWithMethods.handleRequest({
        method: "GET",
        url: "/api/data/item",
        headers: {},
      });

      expect(mockTransactionAPI.create).not.toHaveBeenCalled();
      expect(getResult.headers["X-Sapiom-Transaction-Id"]).toBeUndefined();
    });

    it.skip("should map HTTP methods to actions correctly (MOVED TO BACKEND)", async () => {
      // NOTE: HTTP method to action mapping moved to HttpClientHandlerV1 in backend
      const handlerWithPatterns = new AuthorizationHandler({
        ...config,
        authorizedEndpoints: [
          {
            pathPattern: /.*/,
            serviceName: "test-service",
          },
        ],
      });

      const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"];
      const expectedActions = ["read", "create", "update", "update", "delete"];

      for (let i = 0; i < methods.length; i++) {
        mockTransactionAPI.create.mockResolvedValue({
          id: `tx_${i}`,
          status: TransactionStatus.AUTHORIZED,
        } as any);

        await handlerWithPatterns.handleRequest({
          method: methods[i],
          url: "/test",
          headers: {},
        });

        expect(mockTransactionAPI.create).toHaveBeenCalledWith(
          expect.objectContaining({
            actionName: expectedActions[i],
          }),
        );

        mockTransactionAPI.create.mockClear();
      }
    });

    it("should deduplicate concurrent authorization for same transaction", async () => {
      const handlerWithPatterns = new AuthorizationHandler({
        ...config,
        authorizedEndpoints: [
          {
            pathPattern: /^\/api\/admin\//,
            serviceName: "admin-api",
          },
        ],
      });

      const pendingTx: TransactionResponse = {
        id: "tx_concurrent_auth",
        organizationId: "org_1",
        serviceName: "admin-api",
        actionName: "read",
        resourceName: "/api/admin/users",
        status: TransactionStatus.PENDING,
        requiresPayment: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const authorizedTx: TransactionResponse = {
        ...pendingTx,
        status: TransactionStatus.AUTHORIZED,
      };

      mockTransactionAPI.create.mockResolvedValue(pendingTx);
      mockTransactionAPI.get.mockResolvedValueOnce(authorizedTx);

      const request: HttpRequest = {
        method: "GET",
        url: "/api/admin/users",
        headers: {},
      };

      // Simulate 3 concurrent authorization requests
      const results = await Promise.all([
        handlerWithPatterns.handleRequest(request),
        handlerWithPatterns.handleRequest(request),
        handlerWithPatterns.handleRequest(request),
      ]);

      // All should succeed with same transaction ID
      expect(results).toHaveLength(3);
      results.forEach((result) => {
        expect(result.headers["X-Sapiom-Transaction-Id"]).toBe(
          "tx_concurrent_auth",
        );
      });

      // Polling should be deduplicated
      expect(mockTransactionAPI.get.mock.calls.length).toBeLessThan(5);
    });
  });
});
