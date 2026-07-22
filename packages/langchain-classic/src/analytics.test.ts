/**
 * Usage-analytics tests for the LangChain classic wrappers (metadata-only
 * `model.call` / `tool.call` events).
 *
 * The redaction boundary test is the heart of this suite: every user-content
 * surface the wrappers can see (prompts, completions, tool args/results,
 * schemas, descriptions, error messages, …) is marked with unique sentinel
 * strings, and the suite asserts that no sentinel ever reaches the mock
 * collector — in any captured request body, not just parsed events.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { ChatAnthropicMessages } from "@langchain/anthropic";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

import { startMockCollector } from "@sapiom/analytics-core/testing";
import type { MockCollector } from "@sapiom/analytics-core/testing";
import type { SapiomClient } from "@sapiom/core";

import {
  __resetAnalyticsForTests,
  buildModelCallData,
  buildToolCallData,
  getAnalytics,
} from "./internal/analytics";
import { SapiomChatAnthropic } from "./models/anthropic";
import { SapiomChatOpenAI } from "./models/openai";
import { sapiomTool, wrapSapiomTool } from "./tool";

const ENV_KEYS = [
  "SAPIOM_ANALYTICS_ENDPOINT",
  "SAPIOM_TELEMETRY_DISABLED",
  "DO_NOT_TRACK",
] as const;

function createMockClient(): SapiomClient {
  return {
    transactions: {
      create: jest.fn().mockResolvedValue({
        id: "tx-123",
        status: "authorized",
        trace: { id: "trace-uuid-123", externalId: null },
      }),
      get: jest.fn().mockResolvedValue({ id: "tx-123", status: "authorized" }),
      addFacts: jest.fn().mockResolvedValue({ success: true }),
      complete: jest.fn().mockResolvedValue({
        transaction: { id: "tx-123", status: "completed" },
      }),
    },
  } as unknown as SapiomClient;
}

/**
 * Mock client that returns a payment-authorized transaction on the second
 * createAndAuthorize call, enabling payment-retry test scenarios.
 */
function createMockClientWithPayment(): SapiomClient {
  const client = {
    transactions: {
      create: jest
        .fn()
        .mockResolvedValueOnce({
          id: "tx-tool",
          status: "authorized",
          trace: { id: "trace-uuid-123", externalId: null },
        })
        .mockResolvedValueOnce({
          id: "tx-payment",
          status: "authorized",
          payment: { authorizationPayload: "auth-token" },
        }),
      get: jest
        .fn()
        .mockResolvedValueOnce({ id: "tx-tool", status: "authorized" })
        .mockResolvedValueOnce({
          id: "tx-payment",
          status: "authorized",
          payment: { authorizationPayload: "auth-token" },
        }),
      addFacts: jest.fn().mockResolvedValue({ success: true }),
      complete: jest.fn().mockResolvedValue({
        transaction: { id: "tx-tool", status: "completed" },
      }),
    },
  } as unknown as SapiomClient;
  return client;
}

function mockOpenAIGenerate(
  content: string,
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  },
) {
  return jest.spyOn(ChatOpenAI.prototype, "generate").mockResolvedValue({
    generations: [
      [{ message: { content, usage_metadata: usage }, text: content }],
    ],
    llmOutput: {},
  } as any);
}

function mockAnthropicGenerate(
  content: string,
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  },
) {
  return jest
    .spyOn(ChatAnthropicMessages.prototype, "generate")
    .mockResolvedValue({
      generations: [
        [{ message: { content, usage_metadata: usage }, text: content }],
      ],
      llmOutput: {},
    } as any);
}

describe("langchain-classic usage analytics", () => {
  let collector: MockCollector;
  let tempHome: string;
  const savedHome: Record<string, string | undefined> = {};
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    // Sandbox the analytics identity file (~/.sapiom/analytics.json).
    savedHome.HOME = process.env.HOME;
    savedHome.USERPROFILE = process.env.USERPROFILE;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "sapiom-lc-classic-"));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
  });

  afterAll(() => {
    restoreEnvVar("HOME", savedHome.HOME);
    restoreEnvVar("USERPROFILE", savedHome.USERPROFILE);
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    collector = await startMockCollector();
    process.env.SAPIOM_ANALYTICS_ENDPOINT = collector.url;
    await __resetAnalyticsForTests();
  });

  afterEach(async () => {
    await __resetAnalyticsForTests();
    for (const key of ENV_KEYS) restoreEnvVar(key, savedEnv[key]);
    await collector.close();
    jest.restoreAllMocks();
  });

  describe("tool.call (wrapSapiomTool)", () => {
    function buildTool(
      func: (input: { city: string }) => Promise<string> | string,
    ) {
      return new DynamicStructuredTool({
        name: "weather_tool",
        description: "Get weather",
        schema: z.object({ city: z.string() }),
        func: func as any,
      });
    }

    it("emits metadata-only success events (tool name only)", async () => {
      const wrapped = wrapSapiomTool(
        buildTool(async () => "Sunny, 25C"),
        {
          sapiomClient: createMockClient(),
        },
      );

      const result = await (wrapped as any).func({ city: "Tokyo" });
      expect(result).toBe("Sunny, 25C");

      await getAnalytics().flush();
      const events = collector.events();
      expect(events).toHaveLength(1);
      const event = events[0];
      expect(event.event_type).toBe("tool.call");
      expect(event.source).toBe("langchain");
      expect(event.sdk_name).toBe("@sapiom/langchain-classic");
      expect(event.data.status).toBe("success");
      expect(event.data.tool_name).toBe("weather_tool");
      expect(typeof event.data.duration_ms).toBe("number");
      expect(Object.keys(event.data).sort()).toEqual([
        "duration_ms",
        "status",
        "tool_name",
      ]);
    });

    it("emits error events carrying only the error class", async () => {
      class WeatherServiceError extends Error {}
      const wrapped = wrapSapiomTool(
        buildTool(() => {
          throw new WeatherServiceError("upstream said: user secret");
        }),
        { sapiomClient: createMockClient() },
      );

      await expect((wrapped as any).func({ city: "Tokyo" })).rejects.toThrow(
        "upstream said: user secret",
      );

      await getAnalytics().flush();
      const events = collector.events();
      expect(events).toHaveLength(1);
      expect(events[0].data.status).toBe("error");
      expect(events[0].data.error_class).toBe("WeatherServiceError");
      expect(Object.keys(events[0].data).sort()).toEqual([
        "duration_ms",
        "error_class",
        "status",
        "tool_name",
      ]);
    });

    it("emits nothing when the wrapper is explicitly disabled", async () => {
      const wrapped = wrapSapiomTool(
        buildTool(async () => "ok"),
        {
          sapiomClient: createMockClient(),
          enabled: false,
        },
      );

      await (wrapped as any).func({ city: "Tokyo" });
      await getAnalytics().flush();
      expect(collector.events()).toHaveLength(0);
    });

    it("emits ONE success event with payment_retried:true on successful payment retry", async () => {
      const paymentError = {
        message: JSON.stringify({
          x402Version: 1,
          accepts: [{ scheme: "exact", amount: "100", unit: "sats" }],
        }),
      };
      let callCount = 0;
      const wrapped = wrapSapiomTool(
        buildTool((args: any) => {
          callCount++;
          if (callCount === 1 && !(args as any)._meta?.["x402/payment"]) {
            throw paymentError;
          }
          return "Paid result";
        }),
        { sapiomClient: createMockClientWithPayment() },
      );

      const result = await (wrapped as any).func({ city: "Tokyo" });
      expect(result).toBe("Paid result");
      await getAnalytics().flush();

      const events = collector.events();
      // ONE event — the expected-402 bounce never emits.
      expect(events).toHaveLength(1);
      expect(events[0].data.status).toBe("success");
      expect(events[0].data.payment_retried).toBe(true);
      expect(Object.keys(events[0].data).sort()).toEqual([
        "duration_ms",
        "payment_retried",
        "status",
        "tool_name",
      ]);
    });

    it("emits ONE error event with payment_retried:true when retry also fails", async () => {
      class RetryFailedError extends Error {}
      const paymentError = {
        message: JSON.stringify({
          x402Version: 1,
          accepts: [{ scheme: "exact", amount: "100", unit: "sats" }],
        }),
      };
      let callCount = 0;
      const wrapped = wrapSapiomTool(
        buildTool((args: any) => {
          callCount++;
          if (callCount === 1 && !(args as any)._meta?.["x402/payment"]) {
            throw paymentError;
          }
          throw new RetryFailedError("server still refused");
        }),
        { sapiomClient: createMockClientWithPayment() },
      );

      await expect((wrapped as any).func({ city: "Tokyo" })).rejects.toThrow(
        "server still refused",
      );
      await getAnalytics().flush();

      const events = collector.events();
      // ONE event — the expected-402 bounce is suppressed; retry outcome wins.
      expect(events).toHaveLength(1);
      expect(events[0].data.status).toBe("error");
      expect(events[0].data.error_class).toBe("RetryFailedError");
      expect(events[0].data.payment_retried).toBe(true);
      expect(Object.keys(events[0].data).sort()).toEqual([
        "duration_ms",
        "error_class",
        "payment_retried",
        "status",
        "tool_name",
      ]);
    });

    it("non-payment errors emit ONE error event without payment_retried", async () => {
      class DatabaseError extends Error {}
      const wrapped = wrapSapiomTool(
        buildTool(() => {
          throw new DatabaseError("connection refused");
        }),
        { sapiomClient: createMockClient() },
      );

      await expect((wrapped as any).func({ city: "Tokyo" })).rejects.toThrow(
        "connection refused",
      );
      await getAnalytics().flush();

      const events = collector.events();
      expect(events).toHaveLength(1);
      expect(events[0].data.status).toBe("error");
      expect(events[0].data.error_class).toBe("DatabaseError");
      expect(events[0].data.payment_retried).toBeUndefined();
      expect(Object.keys(events[0].data).sort()).toEqual([
        "duration_ms",
        "error_class",
        "status",
        "tool_name",
      ]);
    });
  });

  describe("tool.call (sapiomTool factory)", () => {
    it("emits metadata-only success events", async () => {
      const tool = sapiomTool(
        async () => "42",
        {
          name: "calculator",
          description: "Calculates",
          schema: z.object({ expression: z.string() }),
        },
        { sapiomClient: createMockClient() },
      );

      const result = await (tool as any).func({ expression: "6*7" });
      expect(result).toBe("42");

      await getAnalytics().flush();
      const events = collector.events();
      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe("tool.call");
      expect(events[0].data.tool_name).toBe("calculator");
      expect(events[0].data.status).toBe("success");
    });
  });

  describe("model.call (SapiomChatOpenAI)", () => {
    it("emits metadata-only success events with token counts", async () => {
      mockOpenAIGenerate("Hi there", {
        input_tokens: 11,
        output_tokens: 22,
        total_tokens: 33,
      });
      const model = new SapiomChatOpenAI(
        { model: "gpt-4", openAIApiKey: "test-key" },
        { sapiomClient: createMockClient() },
      );

      await model.invoke("Hello");
      await getAnalytics().flush();

      const events = collector.events();
      expect(events).toHaveLength(1);
      const event = events[0];
      expect(event.event_type).toBe("model.call");
      expect(event.source).toBe("langchain");
      expect(event.sdk_name).toBe("@sapiom/langchain-classic");
      expect(event.data.status).toBe("success");
      expect(event.data.model).toBe("gpt-4");
      expect(event.data.provider).toBe("openai");
      expect(event.data.input_tokens).toBe(11);
      expect(event.data.output_tokens).toBe(22);
      expect(event.data.total_tokens).toBe(33);
      expect(typeof event.data.duration_ms).toBe("number");
      expect(Object.keys(event.data).sort()).toEqual([
        "duration_ms",
        "input_tokens",
        "model",
        "output_tokens",
        "provider",
        "status",
        "total_tokens",
      ]);
    });

    it("emits error events carrying only the error class", async () => {
      class UpstreamTimeoutError extends Error {}
      jest
        .spyOn(ChatOpenAI.prototype, "generate")
        .mockRejectedValue(new UpstreamTimeoutError("prompt was: secret"));
      const model = new SapiomChatOpenAI(
        { model: "gpt-4", openAIApiKey: "test-key" },
        { sapiomClient: createMockClient() },
      );

      await expect(model.invoke("Hello")).rejects.toThrow("prompt was: secret");
      await getAnalytics().flush();

      const events = collector.events();
      expect(events).toHaveLength(1);
      expect(events[0].data.status).toBe("error");
      expect(events[0].data.error_class).toBe("UpstreamTimeoutError");
      expect(Object.keys(events[0].data).sort()).toEqual([
        "duration_ms",
        "error_class",
        "model",
        "provider",
        "status",
      ]);
    });
  });

  describe("model.call (SapiomChatAnthropic)", () => {
    it("emits metadata-only success events", async () => {
      mockAnthropicGenerate("Hello!", {
        input_tokens: 5,
        output_tokens: 7,
        total_tokens: 12,
      });
      const model = new SapiomChatAnthropic(
        { model: "claude-3-5-sonnet-20241022", anthropicApiKey: "test-key" },
        { sapiomClient: createMockClient() },
      );

      await model.invoke("Hello");
      await getAnalytics().flush();

      const events = collector.events();
      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe("model.call");
      expect(events[0].data.model).toBe("claude-3-5-sonnet-20241022");
      expect(events[0].data.provider).toBe("anthropic");
      expect(events[0].data.status).toBe("success");
      expect(events[0].data.input_tokens).toBe(5);
    });
  });

  describe("redaction boundary (sentinels)", () => {
    it("never lets user content reach the collector", async () => {
      const S = {
        prompt: "SENTINEL_PROMPT_9c2f11aa",
        completion: "SENTINEL_COMPLETION_9c2f11aa",
        argKey: "SENTINEL_ARG_KEY_9c2f11aa",
        argValue: "SENTINEL_ARG_VALUE_9c2f11aa",
        toolResult: "SENTINEL_TOOL_RESULT_9c2f11aa",
        toolDescription: "SENTINEL_TOOL_DESC_9c2f11aa",
        schemaDescription: "SENTINEL_SCHEMA_DESC_9c2f11aa",
        modelError: "SENTINEL_MODEL_ERROR_9c2f11aa",
        toolError: "SENTINEL_TOOL_ERROR_9c2f11aa",
        traceId: "SENTINEL_TRACE_9c2f11aa",
      };

      // 1. Tool succeeding with sentinel args (key AND value), result,
      //    description, and schema description.
      const successTool = wrapSapiomTool(
        new DynamicStructuredTool({
          name: "user_tool",
          description: S.toolDescription,
          schema: z
            .object({ [S.argKey]: z.string(), city: z.string() })
            .describe(S.schemaDescription),
          func: async () => S.toolResult,
        }),
        { sapiomClient: createMockClient(), traceId: S.traceId } as any,
      );
      await (successTool as any).func(
        { [S.argKey]: S.argValue, city: S.argValue },
        undefined,
        { metadata: { __sapiomTraceId: S.traceId } },
      );

      // 2. Tool failing with a sentinel error message.
      const failingTool = wrapSapiomTool(
        new DynamicStructuredTool({
          name: "failing_tool",
          description: S.toolDescription,
          schema: z.object({ city: z.string() }),
          func: async () => {
            throw new Error(S.toolError);
          },
        }),
        { sapiomClient: createMockClient() },
      );
      await expect(
        (failingTool as any).func({ city: S.argValue }),
      ).rejects.toThrow(S.toolError);

      // 3. Model succeeding with sentinel prompt and completion.
      mockOpenAIGenerate(S.completion, {
        input_tokens: 1,
        output_tokens: 2,
        total_tokens: 3,
      });
      const model = new SapiomChatOpenAI(
        { model: "gpt-4", openAIApiKey: "test-key" },
        { sapiomClient: createMockClient(), traceId: S.traceId },
      );
      await model.invoke(S.prompt);

      // 4. Model failing with a sentinel error message.
      jest
        .spyOn(ChatOpenAI.prototype, "generate")
        .mockRejectedValue(new Error(S.modelError));
      const failingModel = new SapiomChatOpenAI(
        { model: "gpt-4", openAIApiKey: "test-key" },
        { sapiomClient: createMockClient() },
      );
      await expect(failingModel.invoke(S.prompt)).rejects.toThrow(S.modelError);

      await getAnalytics().flush();

      // Events flowed…
      expect(collector.events().length).toBe(4);
      expect(collector.requests.length).toBeGreaterThan(0);

      // …but no sentinel appears anywhere in anything the collector saw.
      const sentinels = Object.values(S);
      for (const request of collector.requests) {
        for (const sentinel of sentinels) {
          expect(request.rawBody).not.toContain(sentinel);
        }
      }
      const serializedEvents = JSON.stringify(collector.events());
      for (const sentinel of sentinels) {
        expect(serializedEvents).not.toContain(sentinel);
      }
    });

    it("payload builders drop unknown fields (structural allow-list)", () => {
      const modelData = buildModelCallData({
        status: "success",
        durationMs: 12,
        model: "gpt-4",
        provider: "openai",
        smuggled: "SENTINEL_SMUGGLED",
      } as never);
      expect(JSON.stringify(modelData)).not.toContain("SENTINEL_SMUGGLED");

      const toolData = buildToolCallData({
        status: "error",
        durationMs: 3,
        toolName: "weather",
        errorClass: "Error",
        args: { secret: "SENTINEL_SMUGGLED" },
      } as never);
      expect(JSON.stringify(toolData)).not.toContain("SENTINEL_SMUGGLED");
    });

    it("payload builders cap name-like fields", () => {
      const long = "x".repeat(10_000);
      const modelData = buildModelCallData({
        status: "success",
        durationMs: 1,
        model: long,
        provider: long,
      });
      expect((modelData.model as string).length).toBeLessThanOrEqual(256);
      expect((modelData.provider as string).length).toBeLessThanOrEqual(256);

      const toolData = buildToolCallData({
        status: "error",
        durationMs: 1,
        toolName: long,
        errorClass: long,
      });
      expect((toolData.tool_name as string).length).toBeLessThanOrEqual(256);
      expect((toolData.error_class as string).length).toBeLessThanOrEqual(256);
    });
  });

  describe("opt-out and live-default", () => {
    it.each(["SAPIOM_TELEMETRY_DISABLED", "DO_NOT_TRACK"])(
      "%s=1 results in zero collector requests",
      async (envKey) => {
        process.env[envKey] = "1";
        await __resetAnalyticsForTests();

        const wrapped = wrapSapiomTool(
          new DynamicStructuredTool({
            name: "quiet_tool",
            description: "Quiet",
            schema: z.object({ city: z.string() }),
            func: async () => "ok",
          }),
          { sapiomClient: createMockClient() },
        );
        const result = await (wrapped as any).func({ city: "Tokyo" });

        expect(result).toBe("ok");
        expect(getAnalytics().enabled).toBe(false);
        await getAnalytics().flush();
        expect(collector.requests).toHaveLength(0);
      },
    );

    it("live by default: with no explicit endpoint config, emitter is enabled and events reach the collector", async () => {
      // No explicit `endpoint` on the analytics config, but the env override
      // (SAPIOM_ANALYTICS_ENDPOINT) set by beforeEach points at the mock so
      // nothing hits the production URL. This exercises the live-default
      // fall-through path: resolveEndpoint() returns the hosted collector when
      // no config is set, and the env override redirects that to the mock.
      mockOpenAIGenerate("Hi", {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
      });
      const model = new SapiomChatOpenAI(
        { model: "gpt-4", openAIApiKey: "test-key" },
        { sapiomClient: createMockClient() },
      );
      await model.invoke("Hello");

      expect(getAnalytics().enabled).toBe(true);
      await getAnalytics().flush();
      expect(collector.requests.length).toBeGreaterThan(0);
    });
  });

  describe("fault injection", () => {
    it("collector down: wrapped behavior is identical", async () => {
      collector.setMode({ kind: "down" });

      const wrapped = wrapSapiomTool(
        new DynamicStructuredTool({
          name: "sturdy_tool",
          description: "Sturdy",
          schema: z.object({ city: z.string() }),
          func: async () => "still ok",
        }),
        { sapiomClient: createMockClient() },
      );
      const result = await (wrapped as any).func({ city: "Tokyo" });
      expect(result).toBe("still ok");

      const toolError = new Error("tool failure");
      const failing = wrapSapiomTool(
        new DynamicStructuredTool({
          name: "failing_tool",
          description: "Failing",
          schema: z.object({ city: z.string() }),
          func: async () => {
            throw toolError;
          },
        }),
        { sapiomClient: createMockClient() },
      );
      await expect((failing as any).func({ city: "Tokyo" })).rejects.toBe(
        toolError,
      );

      // flush never rejects even when delivery fails at the socket level.
      await expect(getAnalytics().flush()).resolves.toBeUndefined();
    });

    it("collector 500s: wrapped behavior is identical", async () => {
      collector.setMode({ kind: "status", status: 500 });

      mockOpenAIGenerate("works", {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
      });
      const model = new SapiomChatOpenAI(
        { model: "gpt-4", openAIApiKey: "test-key" },
        { sapiomClient: createMockClient() },
      );
      const result = await model.invoke("Hello");
      expect(result).toBeDefined();
      await expect(getAnalytics().flush()).resolves.toBeUndefined();
    });
  });
});

function restoreEnvVar(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
