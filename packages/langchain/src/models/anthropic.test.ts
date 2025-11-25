/**
 * Tests for SapiomChatAnthropic and wrapChatAnthropic
 */
import { ChatAnthropic, ChatAnthropicMessages } from "@langchain/anthropic";

import { SapiomClient } from "@sapiom/core";
import { SapiomChatAnthropic, wrapChatAnthropic } from "./anthropic";

/**
 * Helper to mock generate() response with usage metadata
 * Since invoke() calls generate() internally, we mock generate()
 */
function mockGenerate(
  content: string,
  usage?: { input_tokens: number; output_tokens: number; total_tokens: number },
) {
  return jest
    .spyOn(ChatAnthropicMessages.prototype, "generate")
    .mockResolvedValue({
      generations: [
        [
          {
            message: {
              content,
              usage_metadata: usage,
            },
            text: content,
          },
        ],
      ],
      llmOutput: {},
    } as any);
}

describe("SapiomChatAnthropic", () => {
  let mockClient: SapiomClient;

  beforeEach(() => {
    mockClient = {
      transactions: {
        create: jest.fn().mockResolvedValue({
          id: "tx-model-123",
          status: "authorized",
          trace: { id: "trace-uuid-123", externalId: null },
          serviceName: "anthropic",
          actionName: "generate",
          resourceName: "claude-3-5-sonnet-20241022",
          costs: [
            { id: "cost-estimate-123", fiatAmount: "0.030", isEstimate: true },
          ],
        }),
        get: jest.fn().mockResolvedValue({
          id: "tx-model-123",
          status: "authorized",
          trace: { id: "trace-uuid-123", externalId: null },
          serviceName: "anthropic",
          actionName: "generate",
          resourceName: "claude-3-5-sonnet-20241022",
          costs: [
            { id: "cost-estimate-123", fiatAmount: "0.030", isEstimate: true },
          ],
        }),
        addFacts: jest.fn().mockResolvedValue({
          success: true,
          factId: "fact-resp-123",
          costId: "cost-actual-123",
        }),
        addCost: jest.fn().mockResolvedValue({
          id: "cost-actual-123",
          isEstimate: false,
          supersedesCostId: "cost-estimate-123",
        }),
        listCosts: jest.fn().mockResolvedValue({
          costs: [],
          totalActiveCostUsd: "0.000000000000000000",
        }),
      },
    } as any;
  });

  it("creates SapiomChatAnthropic with Sapiom tracking", () => {
    const model = new SapiomChatAnthropic(
      { model: "claude-3-5-sonnet-20241022", anthropicApiKey: "test-key" },
      { sapiomClient: mockClient },
    );

    expect(model).toBeInstanceOf(ChatAnthropicMessages);
    expect(model).toBeInstanceOf(SapiomChatAnthropic);
    expect(model.__sapiomClient).toBe(mockClient);
    expect(model.__sapiomWrapped).toBe(true);
  });

  it("works as drop-in replacement for ChatAnthropic", () => {
    const model = new SapiomChatAnthropic(
      {
        model: "claude-3-5-sonnet-20241022",
        temperature: 0.7,
        maxTokens: 1000,
        anthropicApiKey: "test-key",
      },
      { sapiomClient: mockClient },
    );

    // ChatAnthropicMessages stores model name in 'model' property
    expect((model as any).model).toBe("claude-3-5-sonnet-20241022");
    expect((model as any).temperature).toBe(0.7);
    expect((model as any).maxTokens).toBe(1000);
  });

  it("tracks invoke calls", async () => {
    // Skip actual Anthropic API call in test
    const model = new SapiomChatAnthropic(
      { model: "claude-3-5-sonnet-20241022", anthropicApiKey: "test-key" },
      { sapiomClient: mockClient },
    );

    // Mock parent's invoke to avoid real API call
    mockGenerate("Hello!", {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
    });

    await model.invoke("Hello");

    // Should create transaction with requestFacts
    expect(mockClient.transactions.create).toHaveBeenCalled();
    const createCall = (mockClient.transactions.create as jest.Mock).mock
      .calls[0][0];

    expect(createCall.requestFacts).toBeDefined();
    expect(createCall.requestFacts.source).toBe("langchain-llm");
    expect(createCall.requestFacts.request.modelClass).toBe(
      "SapiomChatAnthropic",
    );
    expect(createCall.requestFacts.request.modelId).toBe(
      "claude-3-5-sonnet-20241022",
    );
    expect(
      createCall.requestFacts.request.estimatedInputTokens,
    ).toBeGreaterThan(0);
  });

  it("auto-generates trace ID when not provided", async () => {
    const model = new SapiomChatAnthropic(
      { model: "claude-3-5-sonnet-20241022", anthropicApiKey: "test-key" },
      { sapiomClient: mockClient },
    );

    mockGenerate("Hi");

    await model.invoke("Test");

    // Should have auto-generated trace ID with sdk- prefix
    expect(model.currentTraceId).toMatch(/^sdk-[0-9a-f-]{36}$/);

    const createCall = (mockClient.transactions.create as jest.Mock).mock
      .calls[0][0];
    expect(createCall.traceExternalId).toMatch(/^sdk-/);
  });

  it("uses user-provided trace ID", async () => {
    const model = new SapiomChatAnthropic(
      { model: "claude-3-5-sonnet-20241022", anthropicApiKey: "test-key" },
      {
        sapiomClient: mockClient,
        traceId: "my-workflow-123",
      },
    );

    (mockClient.transactions.create as jest.Mock).mockResolvedValue({
      id: "tx-123",
      status: "authorized",
      trace: { id: "trace-uuid", externalId: "my-workflow-123" },
    });

    mockGenerate("Hi");

    await model.invoke("Test");

    const createCall = (mockClient.transactions.create as jest.Mock).mock
      .calls[0][0];
    expect(createCall.traceExternalId).toBe("my-workflow-123");
    expect(model.currentTraceId).toBe("my-workflow-123");
  });

  it("supports per-invoke trace override", async () => {
    const model = new SapiomChatAnthropic(
      { model: "claude-3-5-sonnet-20241022", anthropicApiKey: "test-key" },
      {
        sapiomClient: mockClient,
        traceId: "default-trace",
      },
    );

    mockGenerate("Hi");

    // First call - uses default
    (mockClient.transactions.create as jest.Mock).mockResolvedValueOnce({
      id: "tx-1",
      status: "authorized",
      trace: { id: "trace-1", externalId: "default-trace" },
    });

    await model.invoke("First");

    expect(
      (mockClient.transactions.create as jest.Mock).mock.calls[0][0]
        .traceExternalId,
    ).toBe("default-trace");

    // Second call - override
    (mockClient.transactions.create as jest.Mock).mockResolvedValueOnce({
      id: "tx-2",
      status: "authorized",
      trace: { id: "trace-2", externalId: "override-trace" },
    });

    await model.invoke("Second", {
      metadata: {
        __sapiomTraceId: "override-trace",
      },
    });

    expect(
      (mockClient.transactions.create as jest.Mock).mock.calls[1][0]
        .traceExternalId,
    ).toBe("override-trace");
    expect(model.currentTraceId).toBe("override-trace");

    // Third call - back to default
    (mockClient.transactions.create as jest.Mock).mockResolvedValueOnce({
      id: "tx-3",
      status: "authorized",
      trace: { id: "trace-1", externalId: "default-trace" },
    });

    await model.invoke("Third");

    expect(
      (mockClient.transactions.create as jest.Mock).mock.calls[2][0]
        .traceExternalId,
    ).toBe("default-trace");
    expect(model.currentTraceId).toBe("default-trace");
  });

  it("handles authorization denial", async () => {
    (mockClient.transactions.get as jest.Mock).mockResolvedValue({
      id: "tx-model-123",
      status: "denied",
    });

    const model = new SapiomChatAnthropic(
      { model: "claude-3-5-sonnet-20241022", anthropicApiKey: "test-key" },
      {
        sapiomClient: mockClient,
      },
    );

    await expect(model.invoke("Test")).rejects.toThrow(/denied/);
  });

  it("estimates tokens before authorization", async () => {
    const model = new SapiomChatAnthropic(
      { model: "claude-3-5-sonnet-20241022", anthropicApiKey: "test-key" },
      { sapiomClient: mockClient },
    );

    mockGenerate("Response");

    await model.invoke("Short message");

    const createCall = (mockClient.transactions.create as jest.Mock).mock
      .calls[0][0];

    expect(
      createCall.requestFacts.request.estimatedInputTokens,
    ).toBeGreaterThan(0);
    expect(createCall.requestFacts.request.batchSize).toBe(1);
  });

  it("handles missing usage_metadata gracefully", async () => {
    const model = new SapiomChatAnthropic(
      { model: "claude-3-5-sonnet-20241022", anthropicApiKey: "test-key" },
      {
        sapiomClient: mockClient,
      },
    );

    mockGenerate("Response"); // No usage metadata

    await model.invoke("Test");

    // Should not throw even without usage metadata
    expect(mockClient.transactions.create).toHaveBeenCalled();
  });

  it("supports custom service name in config", async () => {
    const model = new SapiomChatAnthropic(
      { model: "claude-3-5-sonnet-20241022", anthropicApiKey: "test-key" },
      {
        sapiomClient: mockClient,
        serviceName: "custom-llm-service",
      },
    );

    mockGenerate("Hi");

    await model.invoke("Test");

    const createCall = (mockClient.transactions.create as jest.Mock).mock
      .calls[0][0];

    // requestFacts still sent (for telemetry)
    expect(createCall.requestFacts).toBeDefined();

    // serviceName override applied
    expect(createCall.serviceName).toBe("custom-llm-service");
  });

  it("generates aggregate transaction for batch generate", async () => {
    const model = new SapiomChatAnthropic(
      { model: "claude-3-5-sonnet-20241022", anthropicApiKey: "test-key" },
      { sapiomClient: mockClient },
    );

    jest.spyOn(ChatAnthropicMessages.prototype, "generate").mockResolvedValue({
      generations: [[], []],
    } as any);

    await model.generate([
      [{ role: "user", content: "Batch 1" }] as any,
      [{ role: "user", content: "Batch 2" }] as any,
    ]);

    // Should create 1 aggregate transaction for entire batch
    expect(mockClient.transactions.create).toHaveBeenCalledTimes(1);

    const call = (mockClient.transactions.create as jest.Mock).mock.calls[0][0];

    // Verify batch size in request facts
    expect(call.requestFacts.request.batchSize).toBe(2);
  });

  it("inherits all ChatAnthropicMessages methods", () => {
    const model = new SapiomChatAnthropic(
      { model: "claude-3-5-sonnet-20241022", anthropicApiKey: "test-key" },
      { sapiomClient: mockClient },
    );

    // These methods should exist (inherited from ChatAnthropicMessages)
    expect(typeof model.invoke).toBe("function");
    expect(typeof model.generate).toBe("function");
    expect(typeof model.stream).toBe("function");
    expect(typeof (model as any).bindTools).toBe("function");
    expect(typeof (model as any).withStructuredOutput).toBe("function");
  });

  // ============================================================================
  // TRACE INTEGRATION TESTS
  // ============================================================================

  describe("Trace Integration", () => {
    it("reuses auto-generated trace across multiple invokes", async () => {
      const model = new SapiomChatAnthropic(
        { model: "claude-3-5-sonnet-20241022", anthropicApiKey: "test-key" },
        { sapiomClient: mockClient },
      );

      const autoGenTraceId = model.currentTraceId;
      expect(autoGenTraceId).toMatch(/^sdk-/);

      mockGenerate("Response");

      // First invoke
      await model.invoke("First");
      expect(
        (mockClient.transactions.create as jest.Mock).mock.calls[0][0]
          .traceExternalId,
      ).toBe(autoGenTraceId);

      // Second invoke - should use same auto-generated trace
      await model.invoke("Second");
      expect(
        (mockClient.transactions.create as jest.Mock).mock.calls[1][0]
          .traceExternalId,
      ).toBe(autoGenTraceId);

      // currentTraceId should remain the same
      expect(model.currentTraceId).toBe(autoGenTraceId);
    });

    it("updates currentTraceId from backend response", async () => {
      const model = new SapiomChatAnthropic(
        { model: "claude-3-5-sonnet-20241022", anthropicApiKey: "test-key" },
        {
          sapiomClient: mockClient,
          traceId: "my-trace",
        },
      );

      (mockClient.transactions.create as jest.Mock).mockResolvedValue({
        id: "tx-123",
        status: "authorized",
        trace: { id: "backend-uuid", externalId: "my-trace" },
      });

      mockGenerate("Response");

      await model.invoke("Test");

      // currentTraceId should match the externalId from backend
      expect(model.currentTraceId).toBe("my-trace");
    });

    it.skip("trace propagation requires agent wrapper (wrapSapiomAgent)", async () => {
      // NOTE: Vanilla LangChain agents (createReactAgent) do not propagate
      // metadata from model to tools automatically.
      //
      // For full trace support across model + tools, use:
      // - wrapSapiomAgent - wraps entire agent
      // - Or manually pass traceId in agent config
      //
      // This test is skipped - trace propagation is handled at agent level.
    });

    it("maps SDK traceId to backend traceExternalId parameter", async () => {
      const model = new SapiomChatAnthropic(
        { model: "claude-3-5-sonnet-20241022", anthropicApiKey: "test-key" },
        {
          sapiomClient: mockClient,
          traceId: "user-trace-xyz",
        },
      );

      mockGenerate("Response");

      await model.invoke("Test");

      const createCall = (mockClient.transactions.create as jest.Mock).mock
        .calls[0][0];

      // SDK traceId becomes backend traceExternalId
      expect(createCall.traceExternalId).toBe("user-trace-xyz");

      // Backend traceId should NOT be set by SDK
      expect(createCall.traceId).toBeUndefined();
    });

    it("preserves trace across withConfig() calls", async () => {
      const model = new SapiomChatAnthropic(
        { model: "claude-3-5-sonnet-20241022", anthropicApiKey: "test-key" },
        {
          sapiomClient: mockClient,
          traceId: "original-trace",
        },
      );

      (mockClient.transactions.create as jest.Mock).mockResolvedValue({
        id: "tx-123",
        status: "authorized",
        trace: { id: "trace-uuid", externalId: "original-trace" },
      });

      mockGenerate("Response");

      await model.invoke("First");

      // Call withConfig (simulates bindTools behavior)
      const newModel = model.withConfig({ configurable: { temperature: 0.5 } });

      await newModel.invoke("Second");

      // Both should use same trace
      const calls = (mockClient.transactions.create as jest.Mock).mock.calls;
      expect(calls[0][0].traceExternalId).toBe("original-trace");
      expect(calls[1][0].traceExternalId).toBe("original-trace");
    });

    it("handles batch generate with trace", async () => {
      const model = new SapiomChatAnthropic(
        { model: "claude-3-5-sonnet-20241022", anthropicApiKey: "test-key" },
        {
          sapiomClient: mockClient,
          traceId: "batch-trace",
        },
      );

      (mockClient.transactions.create as jest.Mock).mockResolvedValue({
        id: "tx-batch",
        status: "authorized",
        trace: { id: "trace-uuid", externalId: "batch-trace" },
        costs: [{ id: "cost-est", isEstimate: true }],
      });

      jest
        .spyOn(ChatAnthropicMessages.prototype, "generate")
        .mockResolvedValue({
          generations: [[], []],
        } as any);

      await model.generate([
        [{ role: "user", content: "Batch 1" }] as any,
        [{ role: "user", content: "Batch 2" }] as any,
      ]);

      // Single aggregate transaction should have the trace
      const calls = (mockClient.transactions.create as jest.Mock).mock.calls;
      expect(calls).toHaveLength(1);
      expect(calls[0][0].traceExternalId).toBe("batch-trace");

      // Verify batch size in request facts
      expect(calls[0][0].requestFacts.request.batchSize).toBe(2);
    });

    it("fallbacks gracefully when backend returns null externalId", async () => {
      const model = new SapiomChatAnthropic(
        { model: "claude-3-5-sonnet-20241022", anthropicApiKey: "test-key" },
        {
          sapiomClient: mockClient,
          traceId: "my-trace",
        },
      );

      // Backend returns trace with null externalId
      (mockClient.transactions.create as jest.Mock).mockResolvedValue({
        id: "tx-123",
        status: "authorized",
        trace: { id: "backend-uuid", externalId: null },
      });

      mockGenerate("Response");

      await model.invoke("Test");

      // Should fallback to the traceId we sent
      expect(model.currentTraceId).toBe("my-trace");
    });

    it("exposes currentTraceId immediately after construction", () => {
      const model = new SapiomChatAnthropic(
        { model: "claude-3-5-sonnet-20241022", anthropicApiKey: "test-key" },
        {
          sapiomClient: mockClient,
          traceId: "early-access-trace",
        },
      );

      // Should be accessible before any invoke
      expect(model.currentTraceId).toBe("early-access-trace");
    });
  });

  // ============================================================================
  // INVOKE → GENERATE WORKAROUND TESTS
  // ============================================================================

  describe("Double Authorization Prevention", () => {
    it("prevents double authorization when invoke calls generate", async () => {
      const model = new SapiomChatAnthropic(
        { model: "claude-3-5-sonnet-20241022", anthropicApiKey: "test-key" },
        { sapiomClient: mockClient },
      );

      mockGenerate("Response", {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
      });

      await model.invoke("Test");

      // Should only create ONE transaction (not two)
      expect(mockClient.transactions.create).toHaveBeenCalledTimes(1);
    });

    it("authorizes when generate is called directly", async () => {
      const model = new SapiomChatAnthropic(
        { model: "claude-3-5-sonnet-20241022", anthropicApiKey: "test-key" },
        { sapiomClient: mockClient },
      );

      jest
        .spyOn(ChatAnthropicMessages.prototype, "generate")
        .mockResolvedValue({
          generations: [[]],
        } as any);

      await model.generate([
        [{ role: "user", content: "Direct generate call" }] as any,
      ]);

      // Should create transaction for direct generate() call
      expect(mockClient.transactions.create).toHaveBeenCalledTimes(1);
      const createCall = (mockClient.transactions.create as jest.Mock).mock
        .calls[0][0];

      // Verify single batch in request facts
      expect(createCall.requestFacts.request.batchSize).toBe(1);
    });
  });

  // ============================================================================
  // WRAP CHAT ANTHROPIC TESTS
  // ============================================================================

  describe("wrapChatAnthropic", () => {
    it("wraps existing ChatAnthropic instance with Sapiom tracking", () => {
      const originalModel = new ChatAnthropic({
        model: "claude-3-5-sonnet-20241022",
        temperature: 0.7,
        maxTokens: 1000,
        anthropicApiKey: "test-key",
      });

      const wrappedModel = wrapChatAnthropic(originalModel, {
        sapiomClient: mockClient,
      });

      expect(wrappedModel).toBeInstanceOf(SapiomChatAnthropic);
      expect(wrappedModel.__sapiomWrapped).toBe(true);
      expect(wrappedModel.__sapiomClient).toBe(mockClient);
    });

    it("preserves all configuration from original model", () => {
      const originalModel = new ChatAnthropic({
        model: "claude-3-5-sonnet-20241022",
        temperature: 0.8,
        maxTokens: 2000,
        topK: 40,
        topP: 0.9,
        anthropicApiKey: "test-key",
        streaming: true,
        streamUsage: false,
      });

      const wrappedModel = wrapChatAnthropic(originalModel, {
        sapiomClient: mockClient,
      });

      // Verify configuration was copied
      expect((wrappedModel as any).model).toBe("claude-3-5-sonnet-20241022");
      expect((wrappedModel as any).temperature).toBe(0.8);
      expect((wrappedModel as any).maxTokens).toBe(2000);
      expect((wrappedModel as any).topK).toBe(40);
      expect((wrappedModel as any).topP).toBe(0.9);
      expect((wrappedModel as any).streaming).toBe(true);
      expect((wrappedModel as any).streamUsage).toBe(false);
    });

    it("prevents double-wrapping of SapiomChatAnthropic", () => {
      const originalModel = new SapiomChatAnthropic(
        { model: "claude-3-5-sonnet-20241022", anthropicApiKey: "test-key" },
        { sapiomClient: mockClient },
      );

      const wrappedModel = wrapChatAnthropic(originalModel, {
        sapiomClient: mockClient,
      });

      // Should return the same instance
      expect(wrappedModel).toBe(originalModel);
    });

    it("wrapped model can invoke and tracks transactions", async () => {
      const originalModel = new ChatAnthropic({
        model: "claude-3-5-sonnet-20241022",
        anthropicApiKey: "test-key",
      });

      const wrappedModel = wrapChatAnthropic(originalModel, {
        sapiomClient: mockClient,
      });

      mockGenerate("Response", {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
      });

      await wrappedModel.invoke("Hello");

      // Should create transaction with facts
      expect(mockClient.transactions.create).toHaveBeenCalled();
      const createCall = (mockClient.transactions.create as jest.Mock).mock
        .calls[0][0];

      expect(createCall.requestFacts).toBeDefined();
      expect(createCall.requestFacts.request.modelId).toBe(
        "claude-3-5-sonnet-20241022",
      );
    });

    it("allows custom trace ID in wrapper config", async () => {
      const originalModel = new ChatAnthropic({
        model: "claude-3-5-sonnet-20241022",
        anthropicApiKey: "test-key",
      });

      const wrappedModel = wrapChatAnthropic(originalModel, {
        sapiomClient: mockClient,
        traceId: "custom-trace-456",
      });

      mockGenerate("Response");

      await wrappedModel.invoke("Test");

      const createCall = (mockClient.transactions.create as jest.Mock).mock
        .calls[0][0];
      expect(createCall.traceExternalId).toBe("custom-trace-456");
      expect(wrappedModel.currentTraceId).toBe("custom-trace-456");
    });

    it("wraps model with all LangChain methods available", () => {
      const originalModel = new ChatAnthropic({
        model: "claude-3-5-sonnet-20241022",
        anthropicApiKey: "test-key",
      });
      const wrappedModel = wrapChatAnthropic(originalModel, {
        sapiomClient: mockClient,
      });

      // All inherited methods should be available
      expect(typeof wrappedModel.invoke).toBe("function");
      expect(typeof wrappedModel.generate).toBe("function");
      expect(typeof wrappedModel.stream).toBe("function");
      expect(typeof (wrappedModel as any).bindTools).toBe("function");
      expect(typeof (wrappedModel as any).withStructuredOutput).toBe(
        "function",
      );
    });

    it("preserves extended thinking config when wrapping", () => {
      const originalModel = new ChatAnthropic({
        model: "claude-3-5-sonnet-20241022",
        anthropicApiKey: "test-key",
        thinking: { type: "enabled", budget_tokens: 1000 },
      });

      const wrappedModel = wrapChatAnthropic(originalModel, {
        sapiomClient: mockClient,
      });

      expect((wrappedModel as any).thinking).toEqual({
        type: "enabled",
        budget_tokens: 1000,
      });
    });
  });
});
