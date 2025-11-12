/**
 * Tests for SapiomChatOpenAI and wrapChatOpenAI
 */
import { ChatOpenAI } from "@langchain/openai";

import { SapiomClient } from "@sapiom/core";
import { SapiomChatOpenAI, wrapChatOpenAI } from "./openai";

/**
 * Helper to mock generate() response with usage metadata
 * Since invoke() calls generate() internally, we mock generate()
 */
function mockGenerate(
  content: string,
  usage?: { input_tokens: number; output_tokens: number; total_tokens: number },
) {
  return jest.spyOn(ChatOpenAI.prototype, "generate").mockResolvedValue({
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

describe("SapiomChatOpenAI", () => {
  let mockClient: SapiomClient;

  beforeEach(() => {
    mockClient = {
      transactions: {
        create: jest.fn().mockResolvedValue({
          id: "tx-model-123",
          status: "authorized",
          trace: { id: "trace-uuid-123", externalId: null },
          // Backend-inferred values (SDK ignores these)
          serviceName: "openai",
          actionName: "generate",
          resourceName: "gpt-4",
          costs: [
            { id: "cost-estimate-123", fiatAmount: "0.030", isEstimate: true },
          ],
        }),
        get: jest.fn().mockResolvedValue({
          id: "tx-model-123",
          status: "authorized",
          trace: { id: "trace-uuid-123", externalId: null },
          serviceName: "openai",
          actionName: "generate",
          resourceName: "gpt-4",
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

  it("creates SapiomChatOpenAI with Sapiom tracking", () => {
    const model = new SapiomChatOpenAI(
      { model: "gpt-4", openAIApiKey: "test-key" },
      { sapiomClient: mockClient },
    );

    expect(model).toBeInstanceOf(ChatOpenAI);
    expect(model).toBeInstanceOf(SapiomChatOpenAI);
    expect(model.__sapiomClient).toBe(mockClient);
    expect(model.__sapiomWrapped).toBe(true);
  });

  it("works as drop-in replacement for ChatOpenAI", () => {
    const model = new SapiomChatOpenAI(
      {
        model: "gpt-4-turbo",
        temperature: 0.7,
        maxTokens: 1000,
        openAIApiKey: "test-key",
      },
      { sapiomClient: mockClient },
    );

    // ChatOpenAI stores model name in 'model' property (or modelName getter)
    expect((model as any).model || (model as any).modelName).toBe(
      "gpt-4-turbo",
    );
    expect((model as any).temperature).toBe(0.7);
    expect((model as any).maxTokens).toBe(1000);
  });

  it("tracks invoke calls", async () => {
    // Skip actual OpenAI API call in test
    const model = new SapiomChatOpenAI(
      { model: "gpt-4", openAIApiKey: "test-key" },
      { sapiomClient: mockClient },
    );

    // Mock parent's generate (invoke calls generate internally)
    jest.spyOn(ChatOpenAI.prototype, "generate").mockResolvedValue({
      generations: [
        [
          {
            message: {
              content: "Hello!",
              usage_metadata: {
                input_tokens: 10,
                output_tokens: 5,
                total_tokens: 15,
              },
            },
            text: "Hello!",
          },
        ],
      ],
      llmOutput: {},
    } as any);

    await model.invoke("Hello");

    // Should create transaction with requestFacts
    expect(mockClient.transactions.create).toHaveBeenCalled();

    const calls = (mockClient.transactions.create as jest.Mock).mock.calls;
    expect(calls.length).toBeGreaterThan(0);

    const createCall = calls[0][0];
    expect(createCall).toBeDefined();

    // Verify requestFacts sent
    expect(createCall.requestFacts).toBeDefined();
    expect(createCall.requestFacts.source).toBe("langchain-llm");
    expect(createCall.requestFacts.version).toBe("v1");
    expect(createCall.requestFacts.request.modelClass).toBe("SapiomChatOpenAI");
    expect(createCall.requestFacts.request.modelId).toBe("gpt-4");
    expect(
      createCall.requestFacts.request.estimatedInputTokens,
    ).toBeGreaterThan(0);

    // Verify response facts sent
    expect(mockClient.transactions.addFacts).toHaveBeenCalled();
    const addFactsCalls = (mockClient.transactions.addFacts as jest.Mock).mock
      .calls;
    expect(addFactsCalls.length).toBeGreaterThan(0);

    const [txId, addFactsData] = addFactsCalls[0];
    expect(txId).toBe("tx-model-123");
    expect(addFactsData.source).toBe("langchain-llm");
    expect(addFactsData.factPhase).toBe("response");
    expect(addFactsData.facts.actualInputTokens).toBe(10);
    expect(addFactsData.facts.actualOutputTokens).toBe(5);
  });

  it("auto-generates trace ID when not provided", async () => {
    const model = new SapiomChatOpenAI(
      { model: "gpt-4", openAIApiKey: "test-key" },
      { sapiomClient: mockClient },
    );

    mockGenerate("Hi", {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
    });

    await model.invoke("Test");

    // Should have auto-generated trace ID with sdk- prefix
    expect(model.currentTraceId).toMatch(/^sdk-[0-9a-f-]{36}$/);

    const createCall = (mockClient.transactions.create as jest.Mock).mock
      .calls[0][0];
    expect(createCall.traceExternalId).toMatch(/^sdk-/);
  });

  it("uses user-provided trace ID", async () => {
    const model = new SapiomChatOpenAI(
      { model: "gpt-4", openAIApiKey: "test-key" },
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
    const model = new SapiomChatOpenAI(
      { model: "gpt-4", openAIApiKey: "test-key" },
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

    const onAuthorizationDenied = jest.fn();

    const model = new SapiomChatOpenAI(
      { model: "gpt-4", openAIApiKey: "test-key" },
      {
        sapiomClient: mockClient,
        onAuthorizationDenied,
      },
    );

    await expect(model.invoke("Test")).rejects.toThrow(/denied/);
  });

  it("estimates tokens and includes in request facts", async () => {
    const model = new SapiomChatOpenAI(
      { model: "gpt-4", openAIApiKey: "test-key" },
      { sapiomClient: mockClient },
    );

    // Mock getNumTokens for token estimation
    jest.spyOn(model as any, "getNumTokens").mockResolvedValue(10);

    mockGenerate("Response");

    await model.invoke("Short message");

    const createCall = (mockClient.transactions.create as jest.Mock).mock
      .calls[0][0];

    // Verify token estimation in request facts
    expect(
      createCall.requestFacts.request.estimatedInputTokens,
    ).toBeGreaterThan(0);
    expect(createCall.requestFacts.request.batchSize).toBe(1);
    expect(createCall.requestFacts.request.tokenEstimationMethod).toBe(
      "tiktoken",
    );
  });

  it("supports custom service name override in config", async () => {
    const model = new SapiomChatOpenAI(
      { model: "gpt-4", openAIApiKey: "test-key" },
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
    const model = new SapiomChatOpenAI(
      { model: "gpt-4", openAIApiKey: "test-key" },
      { sapiomClient: mockClient },
    );

    jest.spyOn(ChatOpenAI.prototype, "generate").mockResolvedValue({
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

  it("inherits all ChatOpenAI methods", () => {
    const model = new SapiomChatOpenAI(
      { model: "gpt-4", openAIApiKey: "test-key" },
      { sapiomClient: mockClient },
    );

    // These methods should exist (inherited from ChatOpenAI)
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
      const model = new SapiomChatOpenAI(
        { model: "gpt-4", openAIApiKey: "test-key" },
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
      const model = new SapiomChatOpenAI(
        { model: "gpt-4", openAIApiKey: "test-key" },
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

    it.skip("trace propagation requires agent wrapper (SapiomReactAgent)", async () => {
      // NOTE: Vanilla LangChain agents (createReactAgent) do not propagate
      // metadata from model to tools automatically.
      //
      // For full trace support across model + tools, use:
      // - SapiomReactAgent (Phase 4) - wraps entire agent
      // - Or manually pass traceId in agent config
      //
      // This test is skipped until Phase 4 (Agent Wrapper) is implemented.
    });

    it("maps SDK traceId to backend traceExternalId parameter", async () => {
      const model = new SapiomChatOpenAI(
        { model: "gpt-4", openAIApiKey: "test-key" },
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
      const model = new SapiomChatOpenAI(
        { model: "gpt-4", openAIApiKey: "test-key" },
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
      const model = new SapiomChatOpenAI(
        { model: "gpt-4", openAIApiKey: "test-key" },
        {
          sapiomClient: mockClient,
          traceId: "batch-trace",
        },
      );

      (mockClient.transactions.create as jest.Mock).mockResolvedValue({
        id: "tx-batch",
        status: "authorized",
        trace: { id: "trace-uuid", externalId: "batch-trace" },
        serviceName: "openai",
        actionName: "generate-batch",
        resourceName: "gpt-4",
        costs: [{ id: "cost-est", fiatAmount: "0.030", isEstimate: true }],
      });

      jest.spyOn(ChatOpenAI.prototype, "generate").mockResolvedValue({
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
      const model = new SapiomChatOpenAI(
        { model: "gpt-4", openAIApiKey: "test-key" },
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
      const model = new SapiomChatOpenAI(
        { model: "gpt-4", openAIApiKey: "test-key" },
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
  // COST TRACKING TESTS
  // ============================================================================

  describe("Facts Tracking", () => {
    it("submits request facts with token estimate", async () => {
      const model = new SapiomChatOpenAI(
        { model: "gpt-4" },
        { sapiomClient: mockClient },
      );

      mockGenerate("Response", {
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
      });

      await model.invoke("Hello");

      const createCall = (mockClient.transactions.create as jest.Mock).mock
        .calls[0][0];

      // Verify request facts sent
      expect(createCall.requestFacts).toBeDefined();
      expect(
        createCall.requestFacts.request.estimatedInputTokens,
      ).toBeGreaterThan(0);
      expect(createCall.requestFacts.request.modelId).toBe("gpt-4");
    });

    it("submits response facts with actual token usage", async () => {
      const model = new SapiomChatOpenAI(
        { model: "gpt-4" },
        { sapiomClient: mockClient },
      );

      mockGenerate("Response", {
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
      });

      await model.invoke("Hello");

      expect(mockClient.transactions.addFacts).toHaveBeenCalledWith(
        "tx-model-123",
        expect.objectContaining({
          source: "langchain-llm",
          version: "v1",
          factPhase: "response",
          facts: expect.objectContaining({
            actualInputTokens: 100,
            actualOutputTokens: 50,
            actualTotalTokens: 150,
            finishReason: expect.any(String),
          }),
        }),
      );
    });

    it("includes call site in request facts", async () => {
      const model = new SapiomChatOpenAI(
        { model: "gpt-4o" },
        { sapiomClient: mockClient },
      );

      mockGenerate("Response", {
        input_tokens: 1000,
        output_tokens: 500,
        total_tokens: 1500,
      });

      await model.invoke("Test");

      const createCall = (mockClient.transactions.create as jest.Mock).mock
        .calls[0][0];

      // Verify call site captured (may be null in test environment)
      expect(createCall.requestFacts.request.callSite).toBeDefined();
    });

    it("does not fail invoke if response facts submission fails", async () => {
      const model = new SapiomChatOpenAI(
        { model: "gpt-4" },
        { sapiomClient: mockClient },
      );

      (mockClient.transactions.addFacts as jest.Mock).mockRejectedValueOnce(
        new Error("Network error"),
      );

      mockGenerate("Response", {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
      });

      // Should not throw even if facts submission fails
      const result = await model.invoke("Hello");
      expect(result).toBeDefined();
      expect(result.content).toBe("Response");
    });

    it("skips response facts if usage metadata not available", async () => {
      const model = new SapiomChatOpenAI(
        { model: "gpt-4" },
        { sapiomClient: mockClient },
      );

      mockGenerate("Response"); // No usage metadata

      await model.invoke("Hello");

      // Should create transaction with request facts
      expect(mockClient.transactions.create).toHaveBeenCalled();

      // Should NOT call addFacts (no actual usage to report)
      expect(mockClient.transactions.addFacts).not.toHaveBeenCalled();
    });

    it("submits aggregate response facts for batch generate", async () => {
      const model = new SapiomChatOpenAI(
        { model: "gpt-4" },
        { sapiomClient: mockClient },
      );

      jest.spyOn(ChatOpenAI.prototype, "generate").mockResolvedValue({
        generations: [
          [
            {
              message: {
                content: "Response 1",
                usage_metadata: {
                  input_tokens: 10,
                  output_tokens: 5,
                  total_tokens: 15,
                },
              },
              text: "Response 1",
            },
          ],
          [
            {
              message: {
                content: "Response 2",
                usage_metadata: {
                  input_tokens: 20,
                  output_tokens: 10,
                  total_tokens: 30,
                },
              },
              text: "Response 2",
            },
          ],
        ],
      } as any);

      await model.generate([
        [{ role: "user", content: "Batch 1" }] as any,
        [{ role: "user", content: "Batch 2" }] as any,
      ]);

      // Should submit ONE transaction with batch request facts
      expect(mockClient.transactions.create).toHaveBeenCalledTimes(1);

      const createCall = (mockClient.transactions.create as jest.Mock).mock
        .calls[0][0];
      expect(createCall.requestFacts.request.batchSize).toBe(2);

      // Should submit ONE aggregate response facts
      expect(mockClient.transactions.addFacts).toHaveBeenCalledTimes(1);
      const addFactsCall = (mockClient.transactions.addFacts as jest.Mock).mock
        .calls[0][1];

      expect(addFactsCall.facts.actualInputTokens).toBe(30); // 10 + 20
      expect(addFactsCall.facts.actualOutputTokens).toBe(15); // 5 + 10
      expect(addFactsCall.facts.actualTotalTokens).toBe(45); // 15 + 30
    });
  });

  // ============================================================================
  // WRAP CHAT OPENAI TESTS
  // ============================================================================

  describe("wrapChatOpenAI", () => {
    it("wraps existing ChatOpenAI instance with Sapiom tracking", () => {
      const originalModel = new ChatOpenAI({
        model: "gpt-4",
        temperature: 0.7,
        maxTokens: 1000,
        openAIApiKey: "test-key",
      });

      const wrappedModel = wrapChatOpenAI(originalModel, {
        sapiomClient: mockClient,
      });

      expect(wrappedModel).toBeInstanceOf(SapiomChatOpenAI);
      expect(wrappedModel.__sapiomWrapped).toBe(true);
      expect(wrappedModel.__sapiomClient).toBe(mockClient);
    });

    it("preserves all configuration fields from original model", () => {
      const originalModel = new ChatOpenAI({
        model: "gpt-4-turbo",
        temperature: 0.8,
        maxTokens: 2000,
        topP: 0.9,
        frequencyPenalty: 0.5,
        presencePenalty: 0.6,
        openAIApiKey: "test-key",
        timeout: 60000,
        maxRetries: 3,
      });

      const wrappedModel = wrapChatOpenAI(originalModel, {
        sapiomClient: mockClient,
      });

      // Verify all fields were copied (access via protected fields property)
      const fields = (wrappedModel as any).fields;
      expect(fields.model).toBe("gpt-4-turbo");
      expect(fields.temperature).toBe(0.8);
      expect(fields.maxTokens).toBe(2000);
      expect(fields.topP).toBe(0.9);
      expect(fields.frequencyPenalty).toBe(0.5);
      expect(fields.presencePenalty).toBe(0.6);
      expect(fields.timeout).toBe(60000);
      expect(fields.maxRetries).toBe(3);
    });

    it("prevents double-wrapping of SapiomChatOpenAI", () => {
      const originalModel = new SapiomChatOpenAI(
        { model: "gpt-4", openAIApiKey: "test-key" },
        { sapiomClient: mockClient },
      );

      const wrappedModel = wrapChatOpenAI(originalModel, {
        sapiomClient: mockClient,
      });

      // Should return the same instance
      expect(wrappedModel).toBe(originalModel);
    });

    it("wrapped model can invoke and tracks transactions with facts", async () => {
      const originalModel = new ChatOpenAI({
        model: "gpt-4",
        openAIApiKey: "test-key",
      });

      const wrappedModel = wrapChatOpenAI(originalModel, {
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
      expect(createCall.requestFacts.request.modelId).toBe("gpt-4");
    });

    it("allows custom trace ID in wrapper config", async () => {
      const originalModel = new ChatOpenAI({
        model: "gpt-4",
        openAIApiKey: "test-key",
      });

      const wrappedModel = wrapChatOpenAI(originalModel, {
        sapiomClient: mockClient,
        traceId: "custom-trace-123",
      });

      mockGenerate("Response");

      await wrappedModel.invoke("Test");

      const createCall = (mockClient.transactions.create as jest.Mock).mock
        .calls[0][0];
      expect(createCall.traceExternalId).toBe("custom-trace-123");
      expect(wrappedModel.currentTraceId).toBe("custom-trace-123");
    });

    it("wraps model with all LangChain methods available", () => {
      const originalModel = new ChatOpenAI({
        model: "gpt-4",
        openAIApiKey: "test-key",
      });
      const wrappedModel = wrapChatOpenAI(originalModel, {
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
  });
});
