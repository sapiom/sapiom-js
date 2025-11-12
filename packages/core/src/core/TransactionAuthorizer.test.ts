/**
 * Tests for TransactionAuthorizer
 */

import {
  TransactionAuthorizer,
  TransactionDeniedError,
  TransactionTimeoutError,
} from "./TransactionAuthorizer";
import { SapiomClient } from "../lib/SapiomClient";

describe("TransactionAuthorizer", () => {
  let mockClient: SapiomClient;
  let authorizer: TransactionAuthorizer;
  let onAuthorizationPending: jest.Mock;
  let onAuthorizationSuccess: jest.Mock;
  let onAuthorizationDenied: jest.Mock;

  beforeEach(() => {
    onAuthorizationPending = jest.fn();
    onAuthorizationSuccess = jest.fn();
    onAuthorizationDenied = jest.fn();

    mockClient = {
      transactions: {
        create: jest.fn().mockResolvedValue({
          id: "tx-123",
          status: "pending",
          trace: { id: "trace-uuid", externalId: null },
        }),
        get: jest.fn().mockResolvedValue({
          id: "tx-123",
          status: "authorized",
          trace: { id: "trace-uuid", externalId: null },
        }),
      },
    } as any;

    authorizer = new TransactionAuthorizer({
      sapiomClient: mockClient,
      authorizationTimeout: 5000,
      pollingInterval: 50,
      onAuthorizationPending,
      onAuthorizationSuccess,
      onAuthorizationDenied,
    });
  });

  describe("createAndAuthorize", () => {
    it("creates transaction with traceExternalId", async () => {
      const tx = await authorizer.createAndAuthorize({
        serviceName: "openai",
        actionName: "generate",
        resourceName: "gpt-4",
        traceExternalId: "my-workflow",
        qualifiers: { estimatedTokens: 100 },
      });

      expect(mockClient.transactions.create).toHaveBeenCalledWith({
        serviceName: "openai",
        actionName: "generate",
        resourceName: "gpt-4",
        traceId: undefined,
        traceExternalId: "my-workflow",
        qualifiers: { estimatedTokens: 100 },
        paymentData: undefined,
        metadata: undefined,
      });

      expect(tx.id).toBe("tx-123");
      expect(tx.status).toBe("authorized");
    });

    it("creates transaction with traceId", async () => {
      await authorizer.createAndAuthorize({
        serviceName: "tool",
        actionName: "call",
        resourceName: "weather",
        traceId: "existing-trace-uuid",
      });

      expect(mockClient.transactions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          traceId: "existing-trace-uuid",
          traceExternalId: undefined,
        }),
      );
    });

    it("creates transaction without trace (backend auto-creates)", async () => {
      await authorizer.createAndAuthorize({
        serviceName: "tool",
        actionName: "call",
        resourceName: "calculator",
      });

      expect(mockClient.transactions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          traceId: undefined,
          traceExternalId: undefined,
        }),
      );
    });

    it("waits for authorization and calls success callback", async () => {
      const tx = await authorizer.createAndAuthorize({
        serviceName: "test",
        actionName: "test",
        resourceName: "test-resource",
      });

      expect(onAuthorizationPending).toHaveBeenCalledWith(
        "tx-123",
        "test-resource",
      );
      expect(onAuthorizationSuccess).toHaveBeenCalledWith(
        "tx-123",
        "test-resource",
      );
      expect(tx.status).toBe("authorized");
    });

    it("throws TransactionDeniedError when transaction is denied", async () => {
      (mockClient.transactions.get as jest.Mock).mockResolvedValue({
        id: "tx-123",
        status: "denied",
      });

      await expect(
        authorizer.createAndAuthorize({
          serviceName: "test",
          actionName: "test",
          resourceName: "test-resource",
        }),
      ).rejects.toThrow(TransactionDeniedError);

      expect(onAuthorizationDenied).toHaveBeenCalledWith(
        "tx-123",
        "test-resource",
        expect.any(String),
      );
    });

    it("returns denied transaction when throwOnDenied is false", async () => {
      const authorizerNoThrow = new TransactionAuthorizer({
        sapiomClient: mockClient,
        throwOnDenied: false,
      });

      (mockClient.transactions.get as jest.Mock).mockResolvedValue({
        id: "tx-123",
        status: "denied",
      });

      const tx = await authorizerNoThrow.createAndAuthorize({
        serviceName: "test",
        actionName: "test",
        resourceName: "test-resource",
      });

      expect(tx.status).toBe("denied");
    });

    it("includes payment data when provided", async () => {
      const paymentData = {
        protocol: "x402",
        network: "base-sepolia",
        token: "USDC",
        scheme: "exact",
        amount: "100",
        payTo: "0x123",
        payToType: "address",
      };

      await authorizer.createAndAuthorize({
        serviceName: "tool",
        actionName: "payment",
        resourceName: "send_sms",
        traceExternalId: "workflow",
        paymentData,
      });

      expect(mockClient.transactions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentData,
        }),
      );
    });

    it("creates transaction with agentId", async () => {
      await authorizer.createAndAuthorize({
        serviceName: "openai",
        actionName: "generate",
        resourceName: "gpt-4",
        agentId: "AG-001",
      });

      expect(mockClient.transactions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "AG-001",
          agentName: undefined,
        }),
      );
    });

    it("creates transaction with agentName", async () => {
      await authorizer.createAndAuthorize({
        serviceName: "openai",
        actionName: "generate",
        resourceName: "gpt-4",
        agentName: "my-bot",
      });

      expect(mockClient.transactions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: undefined,
          agentName: "my-bot",
        }),
      );
    });

    it("prefers agentId when both agentId and agentName provided", async () => {
      const consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation();

      await authorizer.createAndAuthorize({
        serviceName: "openai",
        actionName: "generate",
        resourceName: "gpt-4",
        agentId: "AG-001",
        agentName: "my-bot",
      });

      // Should prefer agentId and clear agentName
      expect(mockClient.transactions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "AG-001",
          agentName: undefined, // Cleared
        }),
      );

      // Should log warning
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Both agentId and agentName provided"),
      );
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Preferring agentId="AG-001"'),
      );
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('agentName="my-bot"'),
      );

      consoleWarnSpy.mockRestore();
    });
  });

  describe("waitForExisting", () => {
    it("waits for existing transaction to be authorized", async () => {
      const tx = await authorizer.waitForExisting("tx-existing");

      expect(mockClient.transactions.get).toHaveBeenCalledWith("tx-existing");
      expect(tx.status).toBe("authorized");
    });

    it("throws when existing transaction is denied", async () => {
      (mockClient.transactions.get as jest.Mock).mockResolvedValue({
        id: "tx-existing",
        status: "denied",
        declineReason: "Insufficient funds",
      });

      await expect(authorizer.waitForExisting("tx-existing")).rejects.toThrow(
        TransactionDeniedError,
      );
    });

    it("returns denied transaction when throwOnDenied is false", async () => {
      const authorizerNoThrow = new TransactionAuthorizer({
        sapiomClient: mockClient,
        throwOnDenied: false,
      });

      (mockClient.transactions.get as jest.Mock).mockResolvedValue({
        id: "tx-existing",
        status: "denied",
      });

      const tx = await authorizerNoThrow.waitForExisting("tx-existing");

      expect(tx.status).toBe("denied");
    });

    it("throws TransactionTimeoutError on timeout", async () => {
      const authorizerFastTimeout = new TransactionAuthorizer({
        sapiomClient: mockClient,
        authorizationTimeout: 100,
        pollingInterval: 50,
      });

      // Mock transaction stays pending
      (mockClient.transactions.get as jest.Mock).mockResolvedValue({
        id: "tx-timeout",
        status: "pending",
      });

      await expect(
        authorizerFastTimeout.waitForExisting("tx-timeout"),
      ).rejects.toThrow(TransactionTimeoutError);
    });
  });

  describe("client property", () => {
    it("exposes sapiomClient instance", () => {
      expect(authorizer.client).toBe(mockClient);
    });
  });
});
