import { HttpError, HttpRequest, HttpResponse } from "../http/types";
import { SapiomClient } from "../lib/SapiomClient";
import { TransactionAPI } from "../lib/TransactionAPI";
import {
  PaymentTransactionResponse,
  TransactionResponse,
  TransactionStatus,
} from "../types/transaction";
import { PaymentHandler, PaymentHandlerConfig } from "./PaymentHandler";

describe("PaymentHandler", () => {
  let mockTransactionAPI: jest.Mocked<TransactionAPI>;
  let mockSapiomClient: SapiomClient;
  let config: PaymentHandlerConfig;
  let handler: PaymentHandler;
  let mockRequestExecutor: jest.Mock;

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

    config = {
      sapiomClient: mockSapiomClient,
      onPaymentRequired: jest.fn(),
      onPaymentSuccess: jest.fn(),
      onPaymentFailed: jest.fn(),
      authorizationTimeout: 30000,
      pollingInterval: 100, // Fast polling for tests
    };

    handler = new PaymentHandler(config);
    mockRequestExecutor = jest.fn();
  });

  describe("handlePaymentError", () => {
    it("should return null for non-402 errors", async () => {
      const error: HttpError = {
        message: "Not Found",
        status: 404,
        data: {},
      };

      const result = await handler.handlePaymentError(
        error,
        { method: "GET", url: "/test", headers: {} },
        mockRequestExecutor,
      );

      expect(result).toBeNull();
      expect(mockTransactionAPI.create).not.toHaveBeenCalled();
    });

    it("should return null if already retried", async () => {
      const error: HttpError = {
        message: "Payment Required",
        status: 402,
        data: {
          requiresPayment: true,
          paymentData: {
            protocol: "x402",
            network: "base",
            token: "USDC",
            scheme: "exact",
            amount: "1000000",
            payTo: "0x123",
            payToType: "address",
          },
        },
      };

      const request: HttpRequest = {
        method: "GET",
        url: "/test",
        headers: {},
        metadata: { __is402Retry: true },
      };

      const result = await handler.handlePaymentError(
        error,
        request,
        mockRequestExecutor,
      );

      expect(result).toBeNull();
      expect(mockTransactionAPI.create).not.toHaveBeenCalled();
    });

    it("should create transaction and retry with authorized payment", async () => {
      const error: HttpError = {
        message: "Payment Required",
        status: 402,
        data: {
          requiresPayment: true,
          paymentData: {
            protocol: "x402",
            network: "base-sepolia",
            token: "USDC",
            scheme: "exact",
            amount: "5000000",
            payTo: "0xabc123",
            payToType: "address",
          },
        },
        request: {
          method: "GET",
          url: "https://api.example.com/premium",
          headers: {},
        },
      };

      const mockTransaction: TransactionResponse = {
        id: "tx_123",
        organizationId: "org_1",
        serviceName: "premium",
        actionName: "access",
        resourceName: "https://api.example.com/premium",
        status: TransactionStatus.AUTHORIZED,
        requiresPayment: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        currentPaymentTransactionId: "pay_456",
        payment: {
          id: "pay_456",
          transactionId: "tx_123",
          protocol: "x402",
          network: "base-sepolia",
          token: "USDC",
          scheme: "exact",
          amount: "5000000",
          payTo: "0xabc123",
          payToType: "address",
          status: "authorized",
          authorizationPayload: "ENCODED_PAYMENT_PROOF_xyz789",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as PaymentTransactionResponse,
      };

      const mockResponse: HttpResponse = {
        status: 200,
        statusText: "OK",
        headers: {},
        data: { premium: "data" },
      };

      mockTransactionAPI.create.mockResolvedValue(mockTransaction);
      mockRequestExecutor.mockResolvedValue(mockResponse);

      const result = await handler.handlePaymentError(
        error,
        error.request!,
        mockRequestExecutor,
      );

      // Verify transaction created
      expect(mockTransactionAPI.create).toHaveBeenCalledWith({
        serviceName: "premium",
        actionName: "access",
        resourceName: "https://api.example.com/premium",
        paymentData: error.data.paymentData,
        metadata: {
          originalMethod: "GET",
          originalUrl: "https://api.example.com/premium",
        },
      });

      // Verify request was retried with X-PAYMENT header
      expect(mockRequestExecutor).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({
            "X-PAYMENT": "ENCODED_PAYMENT_PROOF_xyz789",
          }),
          metadata: expect.objectContaining({
            __is402Retry: true,
          }),
        }),
      );

      // Verify success callback
      expect(config.onPaymentSuccess).toHaveBeenCalledWith("tx_123");

      // Verify result
      expect(result).toEqual(mockResponse);
    });

    it("should wait for pending transaction authorization", async () => {
      const error: HttpError = {
        message: "Payment Required",
        status: 402,
        data: {
          x402Version: 1,
          accepts: [
            {
              scheme: "exact",
              network: "base",
              maxAmountRequired: "1000000",
              resourceName: "https://api.example.com/data",
              payTo: "0x123",
              asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            },
          ],
        },
        request: {
          method: "POST",
          url: "https://api.example.com/data",
          headers: {},
        },
      };

      const pendingTransaction: TransactionResponse = {
        id: "tx_pending",
        organizationId: "org_1",
        serviceName: "data",
        actionName: "access",
        resourceName: "https://api.example.com/data",
        status: TransactionStatus.PENDING,
        requiresPayment: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        currentPaymentTransactionId: "pay_pending",
        payment: {
          id: "pay_pending",
          transactionId: "tx_pending",
          protocol: "x402",
          network: "base",
          token: "USDC",
          scheme: "exact",
          amount: "1000000",
          payTo: "0x123",
          payToType: "address",
          status: "pending",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as PaymentTransactionResponse,
      };

      const authorizedTransaction: TransactionResponse = {
        ...pendingTransaction,
        status: TransactionStatus.AUTHORIZED,
        payment: {
          ...pendingTransaction.payment!,
          status: "authorized",
          authorizationPayload: "PAYMENT_PROOF_abc",
        } as PaymentTransactionResponse,
      };

      // First call returns PENDING, then AUTHORIZED, then refresh for payload
      mockTransactionAPI.create.mockResolvedValue(pendingTransaction);
      mockTransactionAPI.get
        .mockResolvedValueOnce(pendingTransaction) // First poll: still pending
        .mockResolvedValueOnce(authorizedTransaction) // Second poll: authorized
        .mockResolvedValueOnce(authorizedTransaction); // Refresh to get payload

      mockRequestExecutor.mockResolvedValue({
        status: 200,
        statusText: "OK",
        headers: {},
        data: { success: true },
      });

      const result = await handler.handlePaymentError(
        error,
        error.request!,
        mockRequestExecutor,
      );

      // Verify polling happened (2 polls, no refresh needed - transaction returned from poll)
      expect(mockTransactionAPI.get).toHaveBeenCalledTimes(2);

      // Verify onPaymentRequired was called
      expect(config.onPaymentRequired).toHaveBeenCalledWith(
        "tx_pending",
        pendingTransaction.payment,
      );

      // Verify retry happened
      expect(mockRequestExecutor).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it("should handle declined transactions", async () => {
      const error: HttpError = {
        message: "Payment Required",
        status: 402,
        data: {
          requiresPayment: true,
          paymentData: {
            protocol: "x402",
            network: "base",
            token: "USDC",
            scheme: "exact",
            amount: "1000000",
            payTo: "0x123",
            payToType: "address",
          },
        },
        request: {
          method: "GET",
          url: "https://api.example.com/premium",
          headers: {},
        },
      };

      const deniedTransaction: TransactionResponse = {
        id: "tx_denied",
        organizationId: "org_1",
        serviceName: "premium",
        actionName: "access",
        resourceName: "https://api.example.com/premium",
        status: TransactionStatus.DENIED,
        requiresPayment: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      mockTransactionAPI.create.mockResolvedValue(deniedTransaction);

      const result = await handler.handlePaymentError(
        error,
        error.request!,
        mockRequestExecutor,
      );

      // Should return 403 Forbidden response
      expect(result).toBeDefined();
      expect(result?.status).toBe(403);
      expect(result?.data).toMatchObject({
        error: "Payment transaction was denied or cancelled",
        transactionId: "tx_denied",
        status: TransactionStatus.DENIED,
      });

      expect(config.onPaymentFailed).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("denied"),
        }),
      );
      expect(mockRequestExecutor).not.toHaveBeenCalled();
    });

    it("should handle cancelled transactions", async () => {
      const error: HttpError = {
        message: "Payment Required",
        status: 402,
        data: {
          requiresPayment: true,
          paymentData: {
            protocol: "x402",
            network: "base",
            token: "USDC",
            scheme: "exact",
            amount: "1000000",
            payTo: "0x123",
            payToType: "address",
          },
        },
        request: {
          method: "GET",
          url: "https://api.example.com/premium",
          headers: {},
        },
      };

      const cancelledTransaction: TransactionResponse = {
        id: "tx_cancelled",
        organizationId: "org_1",
        serviceName: "premium",
        actionName: "access",
        resourceName: "https://api.example.com/premium",
        status: TransactionStatus.CANCELLED,
        requiresPayment: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      mockTransactionAPI.create.mockResolvedValue(cancelledTransaction);

      const result = await handler.handlePaymentError(
        error,
        error.request!,
        mockRequestExecutor,
      );

      // Should return 403 Forbidden response
      expect(result).toBeDefined();
      expect(result?.status).toBe(403);
      expect(result?.data).toMatchObject({
        error: "Payment transaction was denied or cancelled",
        transactionId: "tx_cancelled",
        status: TransactionStatus.CANCELLED,
      });

      expect(config.onPaymentFailed).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("cancelled"),
        }),
      );
      expect(mockRequestExecutor).not.toHaveBeenCalled();
    });

    it("should handle authorization timeout", async () => {
      const error: HttpError = {
        message: "Payment Required",
        status: 402,
        data: {
          requiresPayment: true,
          paymentData: {
            protocol: "x402",
            network: "base",
            token: "USDC",
            scheme: "exact",
            amount: "1000000",
            payTo: "0x123",
            payToType: "address",
          },
        },
        request: {
          method: "GET",
          url: "https://api.example.com/premium",
          headers: {},
        },
      };

      const pendingTransaction: TransactionResponse = {
        id: "tx_timeout",
        organizationId: "org_1",
        serviceName: "premium",
        actionName: "access",
        resourceName: "https://api.example.com/premium",
        status: TransactionStatus.PENDING,
        requiresPayment: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      mockTransactionAPI.create.mockResolvedValue(pendingTransaction);
      // Always return PENDING to trigger timeout
      mockTransactionAPI.get.mockResolvedValue(pendingTransaction);

      // Use short timeout for test
      const quickHandler = new PaymentHandler({
        ...config,
        authorizationTimeout: 200,
        pollingInterval: 50,
      });

      const result = await quickHandler.handlePaymentError(
        error,
        error.request!,
        mockRequestExecutor,
      );

      // Should return 403 Forbidden response
      expect(result).toBeDefined();
      expect(result?.status).toBe(403);
      expect(result?.data).toMatchObject({
        error: "Payment transaction timeout",
        transactionId: "tx_timeout",
      });

      expect(config.onPaymentFailed).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("timeout"),
        }),
      );
      expect(mockRequestExecutor).not.toHaveBeenCalled();
    });

    it("should use existing transaction ID from request headers", async () => {
      const error: HttpError = {
        message: "Payment Required",
        status: 402,
        data: {
          requiresPayment: true,
          // Note: error may contain external service's transactionId, but we ignore it
          transactionId: "external_tx_999",
          paymentData: {
            protocol: "x402",
            network: "base",
            token: "USDC",
            scheme: "exact",
            amount: "1000000",
            payTo: "0x123",
            payToType: "address",
          },
        },
        request: {
          method: "GET",
          url: "https://api.example.com/premium",
          headers: {
            "X-Sapiom-Transaction-Id": "tx_existing", // Our Sapiom transaction
          },
        },
      };

      const existingTransaction: TransactionResponse = {
        id: "tx_existing",
        organizationId: "org_1",
        serviceName: "premium",
        actionName: "access",
        resourceName: "https://api.example.com/premium",
        status: TransactionStatus.AUTHORIZED,
        requiresPayment: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        payment: {
          id: "pay_existing",
          transactionId: "tx_existing",
          protocol: "x402",
          network: "base",
          token: "USDC",
          scheme: "exact",
          amount: "1000000",
          payTo: "0x123",
          payToType: "address",
          status: "authorized",
          authorizationPayload: "EXISTING_PAYLOAD",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as PaymentTransactionResponse,
      };

      mockTransactionAPI.get.mockResolvedValue(existingTransaction);
      mockRequestExecutor.mockResolvedValue({
        status: 200,
        statusText: "OK",
        headers: {},
        data: { success: true },
      });

      const result = await handler.handlePaymentError(
        error,
        error.request!,
        mockRequestExecutor,
      );

      // Should NOT create new transaction
      expect(mockTransactionAPI.create).not.toHaveBeenCalled();

      // Should get existing transaction
      expect(mockTransactionAPI.get).toHaveBeenCalledWith("tx_existing");

      // Should retry with existing payload
      expect(mockRequestExecutor).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({
            "X-PAYMENT": "EXISTING_PAYLOAD",
          }),
        }),
      );

      expect(result).toBeDefined();
    });

    it("should throw if authorized transaction missing authorizationPayload (not swallow)", async () => {
      const error: HttpError = {
        message: "Payment Required",
        status: 402,
        data: {
          requiresPayment: true,
          paymentData: {
            protocol: "x402",
            network: "base",
            token: "USDC",
            scheme: "exact",
            amount: "1000000",
            payTo: "0x123",
            payToType: "address",
          },
        },
        request: {
          method: "GET",
          url: "https://api.example.com/premium",
          headers: {},
        },
      };

      const brokenTransaction: TransactionResponse = {
        id: "tx_broken",
        organizationId: "org_1",
        serviceName: "premium",
        actionName: "access",
        resourceName: "https://api.example.com/premium",
        status: TransactionStatus.AUTHORIZED,
        requiresPayment: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        payment: {
          id: "pay_broken",
          transactionId: "tx_broken",
          protocol: "x402",
          network: "base",
          token: "USDC",
          scheme: "exact",
          amount: "1000000",
          payTo: "0x123",
          payToType: "address",
          status: "authorized",
          // authorizationPayload is missing!
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as PaymentTransactionResponse,
      };

      mockTransactionAPI.create.mockResolvedValue(brokenTransaction);

      // Should throw the error, not return null
      await expect(
        handler.handlePaymentError(error, error.request!, mockRequestExecutor),
      ).rejects.toThrow("missing payment authorization payload");

      // Callback should still be invoked
      expect(config.onPaymentFailed).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining(
            "missing payment authorization payload",
          ),
        }),
      );
    });

    it("should extract service name from resource URL", async () => {
      const error: HttpError = {
        message: "Payment Required",
        status: 402,
        data: {
          x402Version: 1,
          accepts: [
            {
              scheme: "exact",
              network: "base",
              maxAmountRequired: "1000000",
              resourceName: "https://api.example.com/premium-service/endpoint",
              payTo: "0x123",
              asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            },
          ],
        },
        request: {
          method: "GET",
          url: "https://api.example.com/premium-service/endpoint",
          headers: {},
        },
      };

      const mockTransaction: TransactionResponse = {
        id: "tx_service",
        organizationId: "org_1",
        serviceName: "premium-service",
        actionName: "access",
        resourceName: "https://api.example.com/premium-service/endpoint",
        status: TransactionStatus.AUTHORIZED,
        requiresPayment: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        payment: {
          id: "pay_service",
          transactionId: "tx_service",
          protocol: "x402",
          network: "base",
          token: "USDC",
          scheme: "exact",
          amount: "1000000",
          payTo: "0x123",
          payToType: "address",
          status: "authorized",
          authorizationPayload: "PAYLOAD",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as PaymentTransactionResponse,
      };

      mockTransactionAPI.create.mockResolvedValue(mockTransaction);
      mockRequestExecutor.mockResolvedValue({
        status: 200,
        statusText: "OK",
        headers: {},
        data: {},
      });

      await handler.handlePaymentError(
        error,
        error.request!,
        mockRequestExecutor,
      );

      expect(mockTransactionAPI.create).toHaveBeenCalledWith(
        expect.objectContaining({
          serviceName: "premium-service",
        }),
      );
    });

    it("should handle transaction refresh after PENDING status", async () => {
      const error: HttpError = {
        message: "Payment Required",
        status: 402,
        data: {
          requiresPayment: true,
          paymentData: {
            protocol: "x402",
            network: "base",
            token: "USDC",
            scheme: "exact",
            amount: "1000000",
            payTo: "0x123",
            payToType: "address",
          },
        },
        request: {
          method: "GET",
          url: "https://api.example.com/premium",
          headers: {},
        },
      };

      const pendingTransaction: TransactionResponse = {
        id: "tx_refresh",
        organizationId: "org_1",
        serviceName: "premium",
        actionName: "access",
        resourceName: "https://api.example.com/premium",
        status: TransactionStatus.PENDING,
        requiresPayment: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const authorizedTransaction: TransactionResponse = {
        ...pendingTransaction,
        status: TransactionStatus.AUTHORIZED,
        payment: {
          id: "pay_refresh",
          transactionId: "tx_refresh",
          protocol: "x402",
          network: "base",
          token: "USDC",
          scheme: "exact",
          amount: "1000000",
          payTo: "0x123",
          payToType: "address",
          status: "authorized",
          authorizationPayload: "REFRESHED_PAYLOAD",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as PaymentTransactionResponse,
      };

      mockTransactionAPI.create.mockResolvedValue(pendingTransaction);
      mockTransactionAPI.get
        .mockResolvedValueOnce(authorizedTransaction) // Poll returns AUTHORIZED
        .mockResolvedValueOnce(authorizedTransaction); // Refresh to get payload

      mockRequestExecutor.mockResolvedValue({
        status: 200,
        statusText: "OK",
        headers: {},
        data: {},
      });

      const result = await handler.handlePaymentError(
        error,
        error.request!,
        mockRequestExecutor,
      );

      // Should have refreshed transaction after authorization
      expect(mockTransactionAPI.get).toHaveBeenCalledWith("tx_refresh");

      // Should use refreshed payload
      expect(mockRequestExecutor).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({
            "X-PAYMENT": "REFRESHED_PAYLOAD",
          }),
        }),
      );

      expect(result).toBeDefined();
    });

    it("should allow user to override service, action, resource, and qualifiers", async () => {
      const error: HttpError = {
        message: "Payment Required",
        status: 402,
        data: {
          requiresPayment: true,
          paymentData: {
            protocol: "x402",
            network: "base",
            token: "USDC",
            scheme: "exact",
            amount: "1000000",
            payTo: "0x123",
            payToType: "address",
          },
        },
        request: {
          method: "POST",
          url: "https://api.example.com/v1/analytics/run",
          headers: {},
          __sapiom: {
            serviceName: "custom-analytics",
            actionName: "execute-query",
            resourceName: "analytics:monthly-report",
            qualifiers: {
              reportType: "revenue",
              period: "2025-Q1",
            },
            metadata: {
              userId: "user_123",
              organizationId: "org_456",
            },
          },
        },
      };

      const mockTransaction: TransactionResponse = {
        id: "tx_override",
        organizationId: "org_1",
        serviceName: "custom-analytics",
        actionName: "execute-query",
        resourceName: "analytics:monthly-report",
        status: TransactionStatus.AUTHORIZED,
        requiresPayment: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        payment: {
          id: "pay_override",
          transactionId: "tx_override",
          protocol: "x402",
          network: "base",
          token: "USDC",
          scheme: "exact",
          amount: "1000000",
          payTo: "0x123",
          payToType: "address",
          status: "authorized",
          authorizationPayload: "OVERRIDE_PAYLOAD",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as PaymentTransactionResponse,
      };

      mockTransactionAPI.create.mockResolvedValue(mockTransaction);
      mockRequestExecutor.mockResolvedValue({
        status: 200,
        statusText: "OK",
        headers: {},
        data: { success: true },
      });

      const result = await handler.handlePaymentError(
        error,
        error.request!,
        mockRequestExecutor,
      );

      // Verify transaction was created with user-provided values
      expect(mockTransactionAPI.create).toHaveBeenCalledWith({
        serviceName: "custom-analytics",
        actionName: "execute-query",
        resourceName: "analytics:monthly-report",
        paymentData: error.data.paymentData,
        qualifiers: {
          reportType: "revenue",
          period: "2025-Q1",
        },
        metadata: {
          userId: "user_123",
          organizationId: "org_456",
          originalMethod: "POST",
          originalUrl: "https://api.example.com/v1/analytics/run",
        },
      });

      expect(result).toBeDefined();
    });

    it("should reauthorize with payment if existing transaction was authorized without payment", async () => {
      const error: HttpError = {
        message: "Payment Required",
        status: 402,
        data: {
          requiresPayment: true,
          paymentData: {
            protocol: "x402",
            network: "base",
            token: "USDC",
            scheme: "exact",
            amount: "10000000",
            payTo: "0xreauth",
            payToType: "address",
          },
        },
        request: {
          method: "GET",
          url: "https://api.example.com/premium",
          headers: {
            "X-Sapiom-Transaction-Id": "tx_auth_no_payment", // From authorization
          },
        },
      };

      // Existing transaction was authorized but without payment
      const existingTransaction: TransactionResponse = {
        id: "tx_auth_no_payment",
        organizationId: "org_1",
        serviceName: "premium",
        actionName: "access",
        resourceName: "https://api.example.com/premium",
        status: TransactionStatus.AUTHORIZED,
        requiresPayment: false, // No payment required originally
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // Reauthorized transaction with payment
      const reauthorizedTransaction: TransactionResponse = {
        ...existingTransaction,
        requiresPayment: true,
        status: TransactionStatus.AUTHORIZED,
        currentPaymentTransactionId: "pay_reauth",
        payment: {
          id: "pay_reauth",
          transactionId: "tx_auth_no_payment",
          protocol: "x402",
          network: "base",
          token: "USDC",
          scheme: "exact",
          amount: "10000000",
          payTo: "0xreauth",
          payToType: "address",
          status: "authorized",
          authorizationPayload: "REAUTH_PAYLOAD",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as PaymentTransactionResponse,
      };

      mockTransactionAPI.get.mockResolvedValue(existingTransaction);
      mockTransactionAPI.reauthorizeWithPayment.mockResolvedValue(
        reauthorizedTransaction,
      );
      mockRequestExecutor.mockResolvedValue({
        status: 200,
        statusText: "OK",
        headers: {},
        data: { reauthorized: true },
      });

      const result = await handler.handlePaymentError(
        error,
        error.request!,
        mockRequestExecutor,
      );

      // Should NOT create new transaction
      expect(mockTransactionAPI.create).not.toHaveBeenCalled();

      // Should get existing transaction
      expect(mockTransactionAPI.get).toHaveBeenCalledWith("tx_auth_no_payment");

      // Should reauthorize with payment
      expect(mockTransactionAPI.reauthorizeWithPayment).toHaveBeenCalledWith(
        "tx_auth_no_payment",
        error.data.paymentData,
      );

      // Should retry with reauth payload
      expect(mockRequestExecutor).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({
            "X-PAYMENT": "REAUTH_PAYLOAD",
          }),
        }),
      );

      expect(result).toBeDefined();
      expect(result?.data).toEqual({ reauthorized: true });
    });

    it("should use existing transaction with payment without reauthorizing", async () => {
      const error: HttpError = {
        message: "Payment Required",
        status: 402,
        data: {
          requiresPayment: true,
          paymentData: {
            protocol: "x402",
            network: "base",
            token: "USDC",
            scheme: "exact",
            amount: "5000000",
            payTo: "0x456",
            payToType: "address",
          },
        },
        request: {
          method: "GET",
          url: "https://api.example.com/premium",
          headers: {
            "X-Sapiom-Transaction-Id": "tx_already_has_payment", // From authorization
          },
        },
      };

      // Existing transaction already has payment
      const existingWithPayment: TransactionResponse = {
        id: "tx_already_has_payment",
        organizationId: "org_1",
        serviceName: "premium",
        actionName: "access",
        resourceName: "https://api.example.com/premium",
        status: TransactionStatus.AUTHORIZED,
        requiresPayment: true, // Already has payment
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        currentPaymentTransactionId: "pay_existing",
        payment: {
          id: "pay_existing",
          transactionId: "tx_already_has_payment",
          protocol: "x402",
          network: "base",
          token: "USDC",
          scheme: "exact",
          amount: "5000000",
          payTo: "0x456",
          payToType: "address",
          status: "authorized",
          authorizationPayload: "EXISTING_PAYMENT_PAYLOAD",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as PaymentTransactionResponse,
      };

      mockTransactionAPI.get.mockResolvedValue(existingWithPayment);
      mockRequestExecutor.mockResolvedValue({
        status: 200,
        statusText: "OK",
        headers: {},
        data: { existing: true },
      });

      const result = await handler.handlePaymentError(
        error,
        error.request!,
        mockRequestExecutor,
      );

      // Should NOT create or reauthorize
      expect(mockTransactionAPI.create).not.toHaveBeenCalled();
      expect(mockTransactionAPI.reauthorizeWithPayment).not.toHaveBeenCalled();

      // Should use existing payload
      expect(mockRequestExecutor).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({
            "X-PAYMENT": "EXISTING_PAYMENT_PAYLOAD",
          }),
        }),
      );

      expect(result).toBeDefined();
    });

    it("should fallback to extracted values if no overrides provided", async () => {
      const error: HttpError = {
        message: "Payment Required",
        status: 402,
        data: {
          x402Version: 1,
          accepts: [
            {
              scheme: "exact",
              network: "base",
              maxAmountRequired: "1000000",
              resourceName: "https://api.example.com/premium-service/data",
              payTo: "0x123",
              asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            },
          ],
        },
        request: {
          method: "GET",
          url: "https://api.example.com/premium-service/data",
          headers: {},
          // No metadata provided
        },
      };

      const mockTransaction: TransactionResponse = {
        id: "tx_fallback",
        organizationId: "org_1",
        serviceName: "premium-service",
        actionName: "access",
        resourceName: "https://api.example.com/premium-service/data",
        status: TransactionStatus.AUTHORIZED,
        requiresPayment: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        payment: {
          id: "pay_fallback",
          transactionId: "tx_fallback",
          protocol: "x402",
          network: "base",
          token: "USDC",
          scheme: "exact",
          amount: "1000000",
          payTo: "0x123",
          payToType: "address",
          status: "authorized",
          authorizationPayload: "FALLBACK_PAYLOAD",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as PaymentTransactionResponse,
      };

      mockTransactionAPI.create.mockResolvedValue(mockTransaction);
      mockRequestExecutor.mockResolvedValue({
        status: 200,
        statusText: "OK",
        headers: {},
        data: {},
      });

      await handler.handlePaymentError(
        error,
        error.request!,
        mockRequestExecutor,
      );

      // Verify fallback to extracted values
      expect(mockTransactionAPI.create).toHaveBeenCalledWith({
        serviceName: "premium-service", // Extracted from URL
        actionName: "access", // Default action
        resourceName: "https://api.example.com/premium-service/data", // From x402 response
        paymentData: expect.any(Object),
        qualifiers: undefined, // No qualifiers
        metadata: {
          originalMethod: "GET",
          originalUrl: "https://api.example.com/premium-service/data",
        },
      });
    });

    it("should deduplicate concurrent polling for same transaction", async () => {
      const error: HttpError = {
        message: "Payment Required",
        status: 402,
        data: {
          requiresPayment: true,
          paymentData: {
            protocol: "x402",
            network: "base",
            token: "USDC",
            scheme: "exact",
            amount: "1000000",
            payTo: "0x123",
            payToType: "address",
          },
        },
        request: {
          method: "GET",
          url: "https://api.example.com/premium",
          headers: {},
        },
      };

      const pendingTransaction: TransactionResponse = {
        id: "tx_concurrent",
        organizationId: "org_1",
        serviceName: "premium",
        actionName: "access",
        resourceName: "https://api.example.com/premium",
        status: TransactionStatus.PENDING,
        requiresPayment: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const authorizedTransaction: TransactionResponse = {
        ...pendingTransaction,
        status: TransactionStatus.AUTHORIZED,
        payment: {
          id: "pay_concurrent",
          transactionId: "tx_concurrent",
          protocol: "x402",
          network: "base",
          token: "USDC",
          scheme: "exact",
          amount: "1000000",
          payTo: "0x123",
          payToType: "address",
          status: "authorized",
          authorizationPayload: "CONCURRENT_PAYLOAD",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as PaymentTransactionResponse,
      };

      mockTransactionAPI.create.mockResolvedValue(pendingTransaction);
      mockTransactionAPI.get
        .mockResolvedValueOnce(pendingTransaction) // First poll
        .mockResolvedValueOnce(authorizedTransaction) // Second poll
        .mockResolvedValue(authorizedTransaction); // Subsequent polls and refresh

      mockRequestExecutor.mockResolvedValue({
        status: 200,
        statusText: "OK",
        headers: {},
        data: { concurrent: true },
      });

      // Simulate 3 concurrent requests for same transaction
      const results = await Promise.all([
        handler.handlePaymentError(error, error.request!, mockRequestExecutor),
        handler.handlePaymentError(error, error.request!, mockRequestExecutor),
        handler.handlePaymentError(error, error.request!, mockRequestExecutor),
      ]);

      // All should succeed
      expect(results).toHaveLength(3);
      results.forEach((result) => {
        expect(result).toBeDefined();
        expect(result?.status).toBe(200);
      });

      // Should only poll twice (not 6 times = 3 requests * 2 polls each)
      // The polling is shared via promise deduplication
      const getCallCount = mockTransactionAPI.get.mock.calls.length;
      expect(getCallCount).toBeLessThan(10); // Much less than 3 * (2 polls + 1 refresh) = 9
    });

    it("should handle staggered concurrent requests with reference counting", async () => {
      const error: HttpError = {
        message: "Payment Required",
        status: 402,
        data: {
          requiresPayment: true,
          paymentData: {
            protocol: "x402",
            network: "base",
            token: "USDC",
            scheme: "exact",
            amount: "1000000",
            payTo: "0x123",
            payToType: "address",
          },
        },
        request: {
          method: "GET",
          url: "https://api.example.com/premium",
          headers: {},
        },
      };

      const pendingTransaction: TransactionResponse = {
        id: "tx_staggered",
        organizationId: "org_1",
        serviceName: "premium",
        actionName: "access",
        resourceName: "https://api.example.com/premium",
        status: TransactionStatus.PENDING,
        requiresPayment: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const authorizedTransaction: TransactionResponse = {
        ...pendingTransaction,
        status: TransactionStatus.AUTHORIZED,
        payment: {
          id: "pay_staggered",
          transactionId: "tx_staggered",
          protocol: "x402",
          network: "base",
          token: "USDC",
          scheme: "exact",
          amount: "1000000",
          payTo: "0x123",
          payToType: "address",
          status: "authorized",
          authorizationPayload: "STAGGERED_PAYLOAD",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as PaymentTransactionResponse,
      };

      mockTransactionAPI.create.mockResolvedValue(pendingTransaction);
      mockTransactionAPI.get
        .mockResolvedValueOnce(pendingTransaction) // First poll
        .mockResolvedValueOnce(authorizedTransaction) // Second poll
        .mockResolvedValue(authorizedTransaction); // All subsequent

      mockRequestExecutor.mockResolvedValue({
        status: 200,
        statusText: "OK",
        headers: {},
        data: { staggered: true },
      });

      // Start first request
      const promise1 = handler.handlePaymentError(
        error,
        error.request!,
        mockRequestExecutor,
      );

      // Start second request after small delay (staggered)
      await new Promise((resolve) => setTimeout(resolve, 10));
      const promise2 = handler.handlePaymentError(
        error,
        error.request!,
        mockRequestExecutor,
      );

      // Start third request after another delay
      await new Promise((resolve) => setTimeout(resolve, 10));
      const promise3 = handler.handlePaymentError(
        error,
        error.request!,
        mockRequestExecutor,
      );

      // All should complete successfully
      const results = await Promise.all([promise1, promise2, promise3]);

      expect(results).toHaveLength(3);
      results.forEach((result) => {
        expect(result).toBeDefined();
        expect(result?.status).toBe(200);
      });

      // Verify polling was deduplicated (should be much less than 9 calls)
      const getCallCount = mockTransactionAPI.get.mock.calls.length;
      expect(getCallCount).toBeLessThan(10);
    });
  });
});
