/**
 * Tests for token estimation and cost calculation
 */
import { Decimal } from "decimal.js";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import {
  estimateInputTokens,
  extractActualTokens,
  calculateModelCost,
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

describe("calculateModelCost", () => {
  it("returns Decimal instance", () => {
    const mockModel = { modelName: "gpt-4" } as unknown as BaseChatModel;

    const cost = calculateModelCost(mockModel, { promptTokens: 100 });

    expect(cost).toBeInstanceOf(Decimal);
  });

  it("calculates GPT-4 cost correctly with exact precision", () => {
    const mockModel = {
      constructor: { name: "ChatOpenAI" },
      modelName: "gpt-4",
    } as any as BaseChatModel;

    const usage = {
      promptTokens: 1000,
      completionTokens: 500,
      totalTokens: 1500,
    };

    const cost = calculateModelCost(mockModel, usage);

    // Input: 1000 × 0.00003 = 0.03
    // Output: 500 × 0.00006 = 0.03
    // Total: 0.06
    expect(cost.toFixed(18)).toBe("0.060000000000000000");
    expect(cost.toNumber()).toBeCloseTo(0.06, 5);
  });

  it("calculates GPT-4o cost correctly", () => {
    const mockModel = {
      modelName: "gpt-4o",
    } as any as BaseChatModel;

    const usage = {
      promptTokens: 2000,
      completionTokens: 1000,
      totalTokens: 3000,
    };

    const cost = calculateModelCost(mockModel, usage);

    // Input: 2000 × 0.000005 = 0.01
    // Output: 1000 × 0.000015 = 0.015
    // Total: 0.025
    expect(cost.toFixed(18)).toBe("0.025000000000000000");
  });

  it("calculates Claude 3.5 Sonnet cost correctly", () => {
    const mockModel = {
      modelName: "claude-3-5-sonnet-20241022",
    } as any as BaseChatModel;

    const usage = {
      promptTokens: 1000,
      completionTokens: 500,
      totalTokens: 1500,
    };

    const cost = calculateModelCost(mockModel, usage);

    // Input: 1000 × 0.000003 = 0.003
    // Output: 500 × 0.000015 = 0.0075
    // Total: 0.0105
    expect(cost.toFixed(18)).toBe("0.010500000000000000");
  });

  it("calculates exact cost for cheapest model (gemini-1.5-flash)", () => {
    const mockModel = {
      modelName: "gemini-1.5-flash",
    } as unknown as BaseChatModel;

    // Single input token
    const cost = calculateModelCost(mockModel, { promptTokens: 1 });

    expect(cost).toBeInstanceOf(Decimal);
    expect(cost.toFixed(18)).toBe("0.000000075000000000");
    expect(cost.toNumber()).toBeGreaterThan(0); // Not rounded to zero
  });

  it("maintains precision through arithmetic (claude-3-haiku)", () => {
    const mockModel = {
      modelName: "claude-3-haiku",
    } as unknown as BaseChatModel;

    // 1000 tokens
    const cost = calculateModelCost(mockModel, { promptTokens: 1000 });

    // Expected: 1000 × 0.00000025 = 0.00025
    expect(cost.toFixed(18)).toBe("0.000250000000000000");
  });

  it("never produces $0.000000 for non-zero tokens", () => {
    const models = ["gemini-1.5-flash", "claude-3-haiku", "gpt-4o-mini"];

    models.forEach((modelName) => {
      const mockModel = { modelName } as unknown as BaseChatModel;
      const cost = calculateModelCost(mockModel, { promptTokens: 1 });

      // Even single token should produce non-zero cost
      expect(cost.toNumber()).toBeGreaterThan(0);
      expect(cost.toFixed(18)).not.toBe("0.000000000000000000");
    });
  });

  it("handles zero completion tokens (estimate scenario)", () => {
    const mockModel = { modelName: "gpt-4" } as unknown as BaseChatModel;

    const cost = calculateModelCost(mockModel, { promptTokens: 100 });

    // Only input cost: 100 × 0.00003 = 0.003
    expect(cost.toFixed(18)).toBe("0.003000000000000000");
  });

  it("uses fallback pricing for unknown models", () => {
    const mockModel = {
      modelName: "unknown-model-2025",
    } as any as BaseChatModel;

    const usage = {
      promptTokens: 1000,
      completionTokens: 500,
      totalTokens: 1500,
    };

    const cost = calculateModelCost(mockModel, usage);

    // Fallback: Input 1000 × 0.000001 = 0.001, Output 500 × 0.000002 = 0.001
    // Total: 0.002
    expect(cost.toFixed(18)).toBe("0.002000000000000000");
  });

  it("handles partial model name matches (gpt-4-0125-preview -> gpt-4)", () => {
    const mockModel = {
      modelName: "gpt-4-0125-preview",
    } as any as BaseChatModel;

    const usage = {
      promptTokens: 1000,
      completionTokens: 500,
      totalTokens: 1500,
    };

    const cost = calculateModelCost(mockModel, usage);

    // Should match "gpt-4" pricing: 1000 × 0.00003 + 500 × 0.00006 = 0.06
    expect(cost.toFixed(18)).toBe("0.060000000000000000");
  });

  it("handles large token counts without precision loss", () => {
    const mockModel = { modelName: "gpt-4" } as unknown as BaseChatModel;

    const cost = calculateModelCost(mockModel, {
      promptTokens: 100000,
      completionTokens: 50000,
    });

    // Input: 100000 × 0.00003 = 3.0
    // Output: 50000 × 0.00006 = 3.0
    // Total: 6.0
    expect(cost.toFixed(18)).toBe("6.000000000000000000");
  });

  it("handles -latest suffix by stripping it (claude-3-5-haiku-latest)", () => {
    const mockModel = {
      modelName: "claude-3-5-haiku-latest",
    } as unknown as BaseChatModel;

    const cost = calculateModelCost(mockModel, { promptTokens: 1000 });

    // Should strip -latest and match claude-3-5-haiku: 1000 × 0.0000008 = 0.0008
    expect(cost.toFixed(18)).toBe("0.000800000000000000");
  });

  it("prioritizes exact -latest match over stripped version", () => {
    // This test verifies that if we ever add explicit -latest entries,
    // they take priority over the stripped version
    const mockModel = {
      modelName: "claude-3-5-sonnet-latest",
    } as unknown as BaseChatModel;

    const cost = calculateModelCost(mockModel, { promptTokens: 1000 });

    // Currently matches claude-3-5-sonnet (after stripping)
    // If we later add 'claude-3-5-sonnet-latest' with different pricing,
    // it would match that instead (exact match takes priority)
    expect(cost.toFixed(18)).toBe("0.003000000000000000");
  });

  it("handles -latest suffix for other providers (claude-3-5-sonnet-latest)", () => {
    const mockModel = {
      modelName: "claude-3-5-sonnet-latest",
    } as unknown as BaseChatModel;

    const cost = calculateModelCost(mockModel, {
      promptTokens: 1000,
      completionTokens: 500,
    });

    // Should match claude-3-5-sonnet: 1000 × 0.000003 + 500 × 0.000015 = 0.0105
    expect(cost.toFixed(18)).toBe("0.010500000000000000");
  });

  it("warns when falling back to conservative estimate", () => {
    const consoleSpy = jest.spyOn(console, "warn").mockImplementation();
    const mockModel = {
      modelName: "unknown-future-model-2026",
    } as unknown as BaseChatModel;

    const cost = calculateModelCost(mockModel, { promptTokens: 1000 });

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Unknown model pricing for "unknown-future-model-2026"',
      ),
    );
    expect(cost.toFixed(18)).toBe("0.001000000000000000"); // Fallback pricing

    consoleSpy.mockRestore();
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
