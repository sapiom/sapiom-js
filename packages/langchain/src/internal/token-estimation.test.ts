/**
 * Tests for token estimation and cost calculation
 */
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import {
  estimateInputTokens,
  extractActualTokens,
  getModelName,
} from "./token-estimation";

describe("estimateInputTokens", () => {
  it("uses model.getNumTokens() for each message", async () => {
    const mockModel = {
      getNumTokens: jest.fn().mockResolvedValue(10),
    } as any as BaseChatModel;

    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ] as any;

    const tokens = await estimateInputTokens(messages, mockModel);

    // 2 messages × (4 overhead + 10 content) = 28 (no completion buffer)
    expect(tokens).toBe(28);
    expect(mockModel.getNumTokens).toHaveBeenCalledTimes(2);
    expect(mockModel.getNumTokens).toHaveBeenCalledWith("Hello");
    expect(mockModel.getNumTokens).toHaveBeenCalledWith("Hi there");
  });

  it("handles array content", async () => {
    const mockModel = {
      getNumTokens: jest.fn().mockResolvedValue(15),
    } as any as BaseChatModel;

    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "What is this?" },
          { type: "image_url", image_url: { url: "https://..." } },
        ],
      },
    ] as any;

    const tokens = await estimateInputTokens(messages, mockModel);

    expect(mockModel.getNumTokens).toHaveBeenCalledWith(messages[0].content);
  });

  it("falls back to generic if getNumTokens throws", async () => {
    const mockModel = {
      getNumTokens: jest
        .fn()
        .mockRejectedValue(new Error("tiktoken not available")),
    } as any as BaseChatModel;

    const messages = [{ role: "user", content: "Test message" }] as any;

    const tokens = await estimateInputTokens(messages, mockModel);

    // Should use generic fallback
    expect(tokens).toBeGreaterThan(0);
    expect(mockModel.getNumTokens).toHaveBeenCalled();
  });

  it("adds message overhead (no completion buffer)", async () => {
    const mockModel = {
      getNumTokens: jest.fn().mockResolvedValue(20),
    } as any as BaseChatModel;

    const messages = [{ role: "user", content: "Test" }] as any;

    const tokens = await estimateInputTokens(messages, mockModel);

    // 1 message × 4 overhead + 20 content = 24 (input only, no completion)
    expect(tokens).toBe(24);
  });
});

describe("extractActualTokens", () => {
  it("extracts from usage_metadata (preferred)", () => {
    const message = {
      usage_metadata: {
        input_tokens: 50,
        output_tokens: 30,
        total_tokens: 80,
      },
    } as any;

    const usage = extractActualTokens(message);

    expect(usage).toEqual({
      promptTokens: 50,
      completionTokens: 30,
      totalTokens: 80,
    });
  });

  it("falls back to response_metadata.tokenUsage", () => {
    const message = {
      response_metadata: {
        tokenUsage: {
          promptTokens: 60,
          completionTokens: 40,
          totalTokens: 100,
        },
      },
    } as any;

    const usage = extractActualTokens(message);

    expect(usage).toEqual({
      promptTokens: 60,
      completionTokens: 40,
      totalTokens: 100,
    });
  });

  it("returns null if no usage data available", () => {
    const message = { content: "Hello" } as any;

    const usage = extractActualTokens(message);

    expect(usage).toBeNull();
  });

  it("prefers usage_metadata over response_metadata", () => {
    const message = {
      usage_metadata: {
        input_tokens: 10,
        output_tokens: 20,
        total_tokens: 30,
      },
      response_metadata: {
        tokenUsage: {
          promptTokens: 999,
          completionTokens: 999,
          totalTokens: 999,
        },
      },
    } as any;

    const usage = extractActualTokens(message);

    expect(usage?.totalTokens).toBe(30); // Uses usage_metadata
  });
});

describe("getModelName", () => {
  it("extracts from modelName property", () => {
    const model = {
      modelName: "gpt-4-turbo",
    } as any as BaseChatModel;

    expect(getModelName(model)).toBe("gpt-4-turbo");
  });

  it("extracts from model property", () => {
    const model = {
      model: "claude-3-opus",
    } as any as BaseChatModel;

    expect(getModelName(model)).toBe("claude-3-opus");
  });

  it("falls back to _llmType()", () => {
    const model = {
      _llmType: () => "openai",
    } as any as BaseChatModel;

    expect(getModelName(model)).toBe("openai");
  });

  it("returns unknown-model for missing properties", () => {
    const model = {} as any as BaseChatModel;

    expect(getModelName(model)).toBe("unknown-model");
  });

  it("prefers modelName over model property", () => {
    const model = {
      modelName: "gpt-4",
      model: "gpt-3.5-turbo",
    } as any as BaseChatModel;

    expect(getModelName(model)).toBe("gpt-4");
  });
});
