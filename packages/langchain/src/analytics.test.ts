/**
 * Usage-analytics tests for the LangChain v1.x middleware (metadata-only
 * `model.call` / `tool.call` events).
 *
 * The redaction boundary test is the heart of this suite: every user-content
 * surface the middleware can see (prompts, completions, tool args/results,
 * error messages, …) is marked with unique sentinel strings, and the suite
 * asserts that no sentinel ever reaches the mock collector — in any captured
 * request body, not just parsed events.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { startMockCollector } from "@sapiom/analytics-core/testing";
import type { MockCollector } from "@sapiom/analytics-core/testing";

import { createSapiomMiddleware } from "./middleware";
import {
  __resetAnalyticsForTests,
  buildModelCallData,
  buildToolCallData,
  getAnalytics,
} from "./internal/analytics";

// Mock Sapiom core so transaction tracking never performs network I/O.
jest.mock("@sapiom/core", () => ({
  initializeSapiomClient: jest.fn(() => mockSapiomClient),
  TransactionAuthorizer: jest.fn().mockImplementation(() => mockAuthorizer),
}));

const mockSapiomClient = {
  transactions: {
    addFacts: jest.fn().mockResolvedValue({}),
    complete: jest.fn().mockResolvedValue({}),
  },
};

const mockAuthorizer = {
  createAndAuthorize: jest.fn().mockResolvedValue({ id: "tx-123" }),
};

const ENV_KEYS = [
  "SAPIOM_ANALYTICS_ENDPOINT",
  "SAPIOM_TELEMETRY_DISABLED",
  "DO_NOT_TRACK",
] as const;

/** A model object shaped like a LangChain chat model wrapper. */
class ChatOpenAI {
  modelName = "gpt-4";
  temperature = 0.5;
  stopSequences: string[] = [];
}

function modelRequest(overrides: Record<string, unknown> = {}) {
  return {
    model: new ChatOpenAI(),
    messages: [{ content: "Hello", role: "user" }],
    tools: [],
    state: {},
    runtime: {},
    ...overrides,
  };
}

function modelResponse(overrides: Record<string, unknown> = {}) {
  return {
    content: "Hi there",
    usage_metadata: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
    ...overrides,
  };
}

function toolRequest(overrides: Record<string, unknown> = {}) {
  return {
    toolCall: { name: "weather", args: { city: "Tokyo" }, id: "call-1" },
    tool: { name: "weather", description: "Get weather" },
    state: {},
    runtime: {},
    ...overrides,
  };
}

describe("langchain middleware usage analytics", () => {
  let collector: MockCollector;
  let tempHome: string;
  const savedHome: Record<string, string | undefined> = {};
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    // Sandbox the analytics identity file (~/.sapiom/analytics.json).
    savedHome.HOME = process.env.HOME;
    savedHome.USERPROFILE = process.env.USERPROFILE;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "sapiom-langchain-"));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
  });

  afterAll(() => {
    restoreEnvVar("HOME", savedHome.HOME);
    restoreEnvVar("USERPROFILE", savedHome.USERPROFILE);
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    mockAuthorizer.createAndAuthorize.mockResolvedValue({ id: "tx-123" });
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
  });

  describe("model.call", () => {
    it("emits metadata-only success events", async () => {
      const middleware = createSapiomMiddleware();
      const response = modelResponse();
      const handler = jest.fn().mockResolvedValue(response);

      const result = await middleware.wrapModelCall!(
        modelRequest() as any,
        handler,
      );

      expect(result).toBe(response);
      await getAnalytics().flush();

      const events = collector.events();
      expect(events).toHaveLength(1);
      const event = events[0];
      expect(event.event_type).toBe("model.call");
      expect(event.source).toBe("langchain");
      expect(event.sdk_name).toBe("@sapiom/langchain");
      expect(event.data.status).toBe("success");
      expect(event.data.model).toBe("gpt-4");
      expect(event.data.provider).toBe("openai");
      expect(event.data.input_tokens).toBe(10);
      expect(event.data.output_tokens).toBe(20);
      expect(event.data.total_tokens).toBe(30);
      expect(typeof event.data.duration_ms).toBe("number");
      // Strict allow-list: no other keys may appear.
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
      class RateLimitTestError extends Error {}
      const middleware = createSapiomMiddleware();
      const handler = jest
        .fn()
        .mockRejectedValue(new RateLimitTestError("secret detail"));

      await expect(
        middleware.wrapModelCall!(modelRequest() as any, handler),
      ).rejects.toThrow("secret detail");

      await getAnalytics().flush();

      const events = collector.events();
      expect(events).toHaveLength(1);
      expect(events[0].data.status).toBe("error");
      expect(events[0].data.error_class).toBe("RateLimitTestError");
      expect(Object.keys(events[0].data).sort()).toEqual([
        "duration_ms",
        "error_class",
        "model",
        "provider",
        "status",
      ]);
    });
  });

  describe("tool.call", () => {
    it("emits metadata-only success events (tool name only)", async () => {
      const middleware = createSapiomMiddleware();
      const handler = jest.fn().mockResolvedValue("Sunny, 25C");

      await middleware.wrapToolCall!(toolRequest() as any, handler);
      await getAnalytics().flush();

      const events = collector.events();
      expect(events).toHaveLength(1);
      const event = events[0];
      expect(event.event_type).toBe("tool.call");
      expect(event.source).toBe("langchain");
      expect(event.data.status).toBe("success");
      expect(event.data.tool_name).toBe("weather");
      expect(typeof event.data.duration_ms).toBe("number");
      expect(Object.keys(event.data).sort()).toEqual([
        "duration_ms",
        "status",
        "tool_name",
      ]);
    });

    it("emits error events carrying only the error class", async () => {
      class ToolExplodedError extends Error {}
      const middleware = createSapiomMiddleware();
      const handler = jest
        .fn()
        .mockRejectedValue(new ToolExplodedError("boom with user data"));

      await expect(
        middleware.wrapToolCall!(toolRequest() as any, handler),
      ).rejects.toThrow("boom with user data");

      await getAnalytics().flush();

      const events = collector.events();
      expect(events).toHaveLength(1);
      expect(events[0].data.status).toBe("error");
      expect(events[0].data.error_class).toBe("ToolExplodedError");
      expect(Object.keys(events[0].data).sort()).toEqual([
        "duration_ms",
        "error_class",
        "status",
        "tool_name",
      ]);
    });

    it("emits ONE success event with payment_retried:true on successful payment retry", async () => {
      const middleware = createSapiomMiddleware();
      const paymentError = new Error(
        JSON.stringify({
          x402Version: 1,
          accepts: [{ scheme: "exact", amount: "100", unit: "sats" }],
        }),
      );
      const handler = jest
        .fn()
        .mockRejectedValueOnce(paymentError)
        .mockResolvedValueOnce("Success after payment");
      mockAuthorizer.createAndAuthorize
        .mockResolvedValueOnce({ id: "tx-tool" })
        .mockResolvedValueOnce({
          id: "tx-payment",
          payment: { authorizationPayload: "auth-token" },
        });

      const result = await middleware.wrapToolCall!(
        toolRequest() as any,
        handler,
      );

      expect(result).toBe("Success after payment");
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
      const middleware = createSapiomMiddleware();
      const paymentError = new Error(
        JSON.stringify({
          x402Version: 1,
          accepts: [{ scheme: "exact", amount: "100", unit: "sats" }],
        }),
      );
      const handler = jest
        .fn()
        .mockRejectedValueOnce(paymentError)
        .mockRejectedValueOnce(new RetryFailedError("server still refused"));
      mockAuthorizer.createAndAuthorize
        .mockResolvedValueOnce({ id: "tx-tool" })
        .mockResolvedValueOnce({
          id: "tx-payment",
          payment: { authorizationPayload: "auth-token" },
        });

      await expect(
        middleware.wrapToolCall!(toolRequest() as any, handler),
      ).rejects.toThrow("server still refused");

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
      const middleware = createSapiomMiddleware();
      const handler = jest
        .fn()
        .mockRejectedValue(new DatabaseError("connection refused"));

      await expect(
        middleware.wrapToolCall!(toolRequest() as any, handler),
      ).rejects.toThrow("connection refused");

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

  describe("redaction boundary (sentinels)", () => {
    it("never lets user content reach the collector", async () => {
      const S = {
        prompt: "SENTINEL_PROMPT_bd41c0de",
        system: "SENTINEL_SYSTEM_bd41c0de",
        multimodal: "SENTINEL_MULTIMODAL_bd41c0de",
        completion: "SENTINEL_COMPLETION_bd41c0de",
        argKey: "SENTINEL_ARG_KEY_bd41c0de",
        argValue: "SENTINEL_ARG_VALUE_bd41c0de",
        toolResult: "SENTINEL_TOOL_RESULT_bd41c0de",
        toolDescription: "SENTINEL_TOOL_DESC_bd41c0de",
        modelError: "SENTINEL_MODEL_ERROR_bd41c0de",
        toolError: "SENTINEL_TOOL_ERROR_bd41c0de",
        traceId: "SENTINEL_TRACE_bd41c0de",
        stopSequence: "SENTINEL_STOP_bd41c0de",
      };
      const middleware = createSapiomMiddleware();

      const sentinelModel = new ChatOpenAI();
      sentinelModel.stopSequences = [S.stopSequence];

      const sentinelModelRequest = () =>
        modelRequest({
          model: sentinelModel,
          messages: [
            { content: S.system, role: "system" },
            { content: S.prompt, role: "user" },
            { content: [{ type: "text", text: S.multimodal }], role: "user" },
          ],
          state: { __sapiomTraceId: S.traceId },
        });

      // 1. Model call succeeding with sentinel completion content.
      await middleware.wrapModelCall!(
        sentinelModelRequest() as any,
        jest.fn().mockResolvedValue(
          modelResponse({
            content: S.completion,
            tool_calls: [{ name: "inner_tool", args: { q: S.argValue } }],
          }),
        ),
      );

      // 2. Model call failing with a sentinel error message.
      await expect(
        middleware.wrapModelCall!(
          sentinelModelRequest() as any,
          jest.fn().mockRejectedValue(new Error(S.modelError)),
        ),
      ).rejects.toThrow(S.modelError);

      const sentinelToolRequest = () =>
        toolRequest({
          toolCall: {
            name: "user_tool",
            args: { [S.argKey]: S.argValue, city: S.argValue },
            id: "call-9",
          },
          tool: { name: "user_tool", description: S.toolDescription },
          state: { __sapiomTraceId: S.traceId },
        });

      // 3. Tool call succeeding with a sentinel result.
      await middleware.wrapToolCall!(
        sentinelToolRequest() as any,
        jest.fn().mockResolvedValue(S.toolResult),
      );

      // 4. Tool call failing with a sentinel error message.
      await expect(
        middleware.wrapToolCall!(
          sentinelToolRequest() as any,
          jest.fn().mockRejectedValue(new Error(S.toolError)),
        ),
      ).rejects.toThrow(S.toolError);

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

        const middleware = createSapiomMiddleware();
        const response = modelResponse();
        const result = await middleware.wrapModelCall!(
          modelRequest() as any,
          jest.fn().mockResolvedValue(response),
        );
        await middleware.wrapToolCall!(
          toolRequest() as any,
          jest.fn().mockResolvedValue("ok"),
        );

        expect(result).toBe(response);
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
      const middleware = createSapiomMiddleware();
      const response = modelResponse();
      const result = await middleware.wrapModelCall!(
        modelRequest() as any,
        jest.fn().mockResolvedValue(response),
      );

      expect(result).toBe(response);
      expect(getAnalytics().enabled).toBe(true);
      await getAnalytics().flush();
      expect(collector.requests.length).toBeGreaterThan(0);
    });
  });

  describe("fault injection", () => {
    it("collector down: wrapped behavior is identical", async () => {
      collector.setMode({ kind: "down" });

      const middleware = createSapiomMiddleware();
      const response = modelResponse();
      const result = await middleware.wrapModelCall!(
        modelRequest() as any,
        jest.fn().mockResolvedValue(response),
      );
      expect(result).toBe(response);

      const toolError = new Error("tool failure");
      await expect(
        middleware.wrapToolCall!(
          toolRequest() as any,
          jest.fn().mockRejectedValue(toolError),
        ),
      ).rejects.toBe(toolError);

      // flush never rejects even when delivery fails at the socket level.
      await expect(getAnalytics().flush()).resolves.toBeUndefined();
    });

    it("collector 500s: wrapped behavior is identical", async () => {
      collector.setMode({ kind: "status", status: 500 });

      const middleware = createSapiomMiddleware();
      const result = await middleware.wrapToolCall!(
        toolRequest() as any,
        jest.fn().mockResolvedValue("still works"),
      );
      expect(result).toBe("still works");
      await expect(getAnalytics().flush()).resolves.toBeUndefined();
    });
  });
});

function restoreEnvVar(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
