/**
 * Tests for Sapiom LangChain v1.x Middleware
 */

import {
  createSapiomMiddleware,
  type ModelRequest,
  type ModelResponse,
  type ToolCallRequest,
} from "./middleware";

// Mock Sapiom core
jest.mock("@sapiom/core", () => ({
  initializeSapiomClient: jest.fn(() => mockSapiomClient),
  TransactionAuthorizer: jest.fn().mockImplementation(() => mockAuthorizer),
}));

const mockSapiomClient = {
  transactions: {
    addFacts: jest.fn().mockResolvedValue({}),
  },
};

const mockAuthorizer = {
  createAndAuthorize: jest.fn().mockResolvedValue({ id: "tx-123" }),
};

describe("createSapiomMiddleware", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("creation", () => {
    it("creates middleware with default config", () => {
      const middleware = createSapiomMiddleware();

      expect(middleware.name).toBe("SapiomMiddleware");
      expect(middleware.beforeAgent).toBeDefined();
      expect(middleware.afterAgent).toBeDefined();
      expect(middleware.wrapModelCall).toBeDefined();
      expect(middleware.wrapToolCall).toBeDefined();
    });

    it("creates middleware with custom config", () => {
      const middleware = createSapiomMiddleware({
        apiKey: "sk-test",
        traceId: "my-trace",
        agentName: "test-agent",
        failureMode: "closed",
      });

      expect(middleware.name).toBe("SapiomMiddleware");
    });
  });

  describe("beforeAgent", () => {
    it("creates agent transaction with auto-generated trace ID", async () => {
      const middleware = createSapiomMiddleware();
      const state = { messages: [{ content: "Hello" }] };
      const runtime = {};

      const result = await middleware.beforeAgent!(state, runtime);

      expect(mockAuthorizer.createAndAuthorize).toHaveBeenCalledWith(
        expect.objectContaining({
          requestFacts: expect.objectContaining({
            source: "langchain-agent",
            version: "v1",
          }),
        })
      );
      expect(result.__sapiomTraceId).toMatch(/^sdk-/);
      expect(result.__sapiomAgentTxId).toBe("tx-123");
    });

    it("uses config trace ID when provided", async () => {
      const middleware = createSapiomMiddleware({ traceId: "custom-trace" });
      const state = { messages: [] };
      const runtime = {};

      const result = await middleware.beforeAgent!(state, runtime);

      expect(result.__sapiomTraceId).toBe("custom-trace");
    });

    it("uses context trace ID as override", async () => {
      const middleware = createSapiomMiddleware({ traceId: "config-trace" });
      const state = { messages: [] };
      const runtime = { context: { sapiomTraceId: "context-trace" } };

      const result = await middleware.beforeAgent!(state, runtime);

      expect(result.__sapiomTraceId).toBe("context-trace");
    });

    it("skips tracking when disabled", async () => {
      const middleware = createSapiomMiddleware({ enabled: false });
      const state = { messages: [] };
      const runtime = {};

      const result = await middleware.beforeAgent!(state, runtime);

      expect(mockAuthorizer.createAndAuthorize).not.toHaveBeenCalled();
      expect(result).toEqual({});
    });

    it("continues on failure in open mode", async () => {
      mockAuthorizer.createAndAuthorize.mockRejectedValueOnce(
        new Error("API error")
      );
      const middleware = createSapiomMiddleware({ failureMode: "open" });
      const state = { messages: [] };
      const runtime = {};

      const result = await middleware.beforeAgent!(state, runtime);

      expect(result.__sapiomTraceId).toMatch(/^sdk-/);
      expect(result.__sapiomAgentTxId).toBeUndefined();
    });

    it("throws on failure in closed mode", async () => {
      mockAuthorizer.createAndAuthorize.mockRejectedValueOnce(
        new Error("API error")
      );
      const middleware = createSapiomMiddleware({ failureMode: "closed" });
      const state = { messages: [] };
      const runtime = {};

      await expect(middleware.beforeAgent!(state, runtime)).rejects.toThrow(
        "API error"
      );
    });

    it("always throws authorization denied errors", async () => {
      const deniedError = new Error("Transaction denied");
      deniedError.name = "TransactionDeniedError";
      mockAuthorizer.createAndAuthorize.mockRejectedValueOnce(deniedError);

      const middleware = createSapiomMiddleware({ failureMode: "open" });
      const state = { messages: [] };
      const runtime = {};

      await expect(middleware.beforeAgent!(state, runtime)).rejects.toThrow(
        "Transaction denied"
      );
    });
  });

  describe("afterAgent", () => {
    it("submits response facts when tracking is active", async () => {
      const middleware = createSapiomMiddleware();
      const state = {
        messages: [{ content: "Response" }],
        __sapiomAgentTxId: "tx-123",
        __sapiomStartTime: Date.now() - 1000,
      };
      const runtime = {};

      await middleware.afterAgent!(state as any, runtime);

      expect(mockSapiomClient.transactions.addFacts).toHaveBeenCalledWith(
        "tx-123",
        expect.objectContaining({
          source: "langchain-agent",
          factPhase: "response",
          facts: expect.objectContaining({
            success: true,
            outputMessageCount: 1,
          }),
        })
      );
    });

    it("skips when no agent transaction", async () => {
      const middleware = createSapiomMiddleware();
      const state = { messages: [] };
      const runtime = {};

      await middleware.afterAgent!(state as any, runtime);

      expect(mockSapiomClient.transactions.addFacts).not.toHaveBeenCalled();
    });
  });

  describe("wrapModelCall", () => {
    const createMockRequest = (
      overrides: Partial<ModelRequest> = {}
    ): ModelRequest => ({
      model: { modelName: "gpt-4" },
      messages: [{ content: "Hello", role: "user" }],
      tools: [],
      state: { __sapiomTraceId: "trace-123" },
      runtime: {},
      ...overrides,
    });

    const createMockResponse = (
      overrides: Partial<ModelResponse> = {}
    ): ModelResponse => ({
      usage_metadata: {
        input_tokens: 10,
        output_tokens: 20,
        total_tokens: 30,
      },
      ...overrides,
    });

    it("tracks model call with token estimation", async () => {
      const middleware = createSapiomMiddleware();
      const request = createMockRequest();
      const handler = jest.fn().mockResolvedValue(createMockResponse());

      await middleware.wrapModelCall!(request, handler);

      expect(mockAuthorizer.createAndAuthorize).toHaveBeenCalledWith(
        expect.objectContaining({
          requestFacts: expect.objectContaining({
            source: "langchain-llm",
            request: expect.objectContaining({
              modelId: "gpt-4",
              messageCount: 1,
            }),
          }),
        })
      );
      expect(handler).toHaveBeenCalledWith(request);
    });

    it("submits response facts with actual tokens", async () => {
      const middleware = createSapiomMiddleware();
      const request = createMockRequest();
      const response = createMockResponse({
        tool_calls: [{ name: "weather" }],
      });
      const handler = jest.fn().mockResolvedValue(response);

      await middleware.wrapModelCall!(request, handler);

      expect(mockSapiomClient.transactions.addFacts).toHaveBeenCalledWith(
        "tx-123",
        expect.objectContaining({
          source: "langchain-llm",
          factPhase: "response",
          facts: expect.objectContaining({
            actualInputTokens: 10,
            actualOutputTokens: 20,
            hadToolCalls: true,
            toolCallCount: 1,
          }),
        })
      );
    });

    it("passes through when disabled", async () => {
      const middleware = createSapiomMiddleware({ enabled: false });
      const request = createMockRequest();
      const response = createMockResponse();
      const handler = jest.fn().mockResolvedValue(response);

      const result = await middleware.wrapModelCall!(request, handler);

      expect(mockAuthorizer.createAndAuthorize).not.toHaveBeenCalled();
      expect(result).toBe(response);
    });
  });

  describe("wrapToolCall", () => {
    const createMockToolRequest = (
      overrides: Partial<ToolCallRequest> = {}
    ): ToolCallRequest => ({
      toolCall: {
        name: "weather",
        args: { city: "Tokyo" },
        id: "call-123",
      },
      tool: {
        name: "weather",
        description: "Get weather",
      },
      state: { __sapiomTraceId: "trace-123" },
      runtime: {},
      ...overrides,
    });

    it("tracks tool call with argument keys", async () => {
      const middleware = createSapiomMiddleware();
      const request = createMockToolRequest();
      const handler = jest.fn().mockResolvedValue("Sunny, 25C");

      await middleware.wrapToolCall!(request, handler);

      expect(mockAuthorizer.createAndAuthorize).toHaveBeenCalledWith(
        expect.objectContaining({
          requestFacts: expect.objectContaining({
            source: "langchain-tool",
            request: expect.objectContaining({
              toolName: "weather",
              hasArguments: true,
              argumentKeys: ["city"],
            }),
          }),
        })
      );
    });

    it("submits success facts on completion", async () => {
      const middleware = createSapiomMiddleware();
      const request = createMockToolRequest();
      const handler = jest.fn().mockResolvedValue("Result");

      await middleware.wrapToolCall!(request, handler);

      expect(mockSapiomClient.transactions.addFacts).toHaveBeenCalledWith(
        "tx-123",
        expect.objectContaining({
          source: "langchain-tool",
          factPhase: "response",
          facts: expect.objectContaining({
            success: true,
          }),
        })
      );
    });

    it("submits error facts on failure", async () => {
      const middleware = createSapiomMiddleware();
      const request = createMockToolRequest();
      const handler = jest.fn().mockRejectedValue(new Error("Tool failed"));

      await expect(
        middleware.wrapToolCall!(request, handler)
      ).rejects.toThrow("Tool failed");

      expect(mockSapiomClient.transactions.addFacts).toHaveBeenCalledWith(
        "tx-123",
        expect.objectContaining({
          factPhase: "error",
          facts: expect.objectContaining({
            errorType: "Error",
            errorMessage: "Tool failed",
          }),
        })
      );
    });

    it("retries with payment on MCP 402 error", async () => {
      const middleware = createSapiomMiddleware();
      const request = createMockToolRequest();

      // First call fails with payment required
      const paymentError = new Error(
        JSON.stringify({
          x402Version: 1,
          accepts: [{ scheme: "exact", amount: "100", unit: "sats" }],
        })
      );

      // Second call succeeds
      const handler = jest
        .fn()
        .mockRejectedValueOnce(paymentError)
        .mockResolvedValueOnce("Success after payment");

      // Mock payment transaction
      mockAuthorizer.createAndAuthorize
        .mockResolvedValueOnce({ id: "tx-tool" })
        .mockResolvedValueOnce({
          id: "tx-payment",
          payment: { authorizationPayload: "auth-token" },
        });

      const result = await middleware.wrapToolCall!(request, handler);

      expect(result).toBe("Success after payment");
      expect(handler).toHaveBeenCalledTimes(2);

      // Second call should include payment
      const secondCall = handler.mock.calls[1][0];
      expect(secondCall.toolCall.args._meta["x402/payment"]).toBe("auth-token");
    });
  });
});

describe("utility exports", () => {
  it("exports generateSDKTraceId", () => {
    const { generateSDKTraceId } = require("./internal/utils");
    const traceId = generateSDKTraceId();
    expect(traceId).toMatch(/^sdk-[a-f0-9-]{36}$/);
  });

  it("exports isMCPPaymentError", () => {
    const { isMCPPaymentError } = require("./internal/payment");

    expect(isMCPPaymentError(null)).toBe(false);
    expect(isMCPPaymentError({})).toBe(false);
    expect(
      isMCPPaymentError({
        message: JSON.stringify({ x402Version: 1, accepts: [] }),
      })
    ).toBe(true);
  });

  it("exports estimateInputTokens", () => {
    const { estimateInputTokens } = require("./internal/telemetry");

    const tokens = estimateInputTokens([{ content: "Hello world" }]);
    expect(tokens).toBeGreaterThan(0);
  });
});
