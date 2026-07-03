/**
 * llm.submit() — dispatch-handle shape, routing headers, resume-token forwarding,
 * wait() polling, and redeem().
 *
 * Injects a fake fetch (no real network) to assert the handle satisfies
 * DispatchHandle, the routing controls ride as x-sapiom-* headers (the body stays
 * a verbatim LLM request), and the engine-injected resume token is forwarded as a
 * header only when present — so standalone use is unaffected.
 */
import { createClient } from "../index.js";
import {
  LLM_ROUTE_RESULT_SIGNAL,
  llmRouteResultSchema,
  LlmRouteResultSchemaError,
  redeem,
  type LlmGrantLink,
} from "./index.js";

const WIRE_LINK = {
  anthropic_base_url: "https://llm.services.sapiom.ai",
  api_key: "sapiom-grant-xyz",
  model: "smart",
  expires_at_ms: 1_726_574_400_000,
  usage: "single_request",
};

interface Captured {
  url?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** 202 on POST (submit), then the given status docs on successive GETs (poll). */
function fakeGatewayFetch(
  capture: Captured,
  statusDocs: Array<Record<string, unknown>> = [],
): typeof globalThis.fetch {
  const polls = [...statusDocs];
  return (async (url: string, init: RequestInit = {}) => {
    if ((init.method ?? "GET") === "POST") {
      capture.url = url;
      capture.headers = init.headers as Record<string, string>;
      capture.body = init.body as string;
      return {
        ok: true,
        status: 202,
        json: async () => ({
          execution_id: "exec-1",
          status: "queued",
          poll: "/v2/route/async/exec-1",
        }),
        text: async () => "",
      } as unknown as Response;
    }
    const doc = polls.length > 1 ? polls.shift() : polls[0];
    return {
      ok: true,
      status: 200,
      json: async () => doc,
      text: async () => "",
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
}

const SPEC = {
  request: { messages: [{ role: "user", content: "hi" }], max_tokens: 64 },
  model: "smart",
  deadlineMinutes: 30,
  complexity: 2,
  webhookUrl: "https://engine.example/llm-callback",
};

describe("llm.submit — dispatch handle", () => {
  it("returns a handle that satisfies DispatchHandle", async () => {
    const sapiom = createClient({
      apiKey: "k",
      fetch: fakeGatewayFetch({}),
    });
    const handle = await sapiom.llm.submit(SPEC);
    expect(handle.executionId).toBe("exec-1");
    expect(handle.dispatch).toEqual({
      correlationId: "exec-1",
      resultSignal: LLM_ROUTE_RESULT_SIGNAL,
    });
  });

  it("LLM_ROUTE_RESULT_SIGNAL is the capability-stable terminal signal", () => {
    expect(LLM_ROUTE_RESULT_SIGNAL).toBe("llm.route.result");
  });
});

describe("llm.submit — routing headers + body", () => {
  it("sends routing controls as x-sapiom-* headers and the request verbatim as the body", async () => {
    const cap: Captured = {};
    const sapiom = createClient({ apiKey: "k", fetch: fakeGatewayFetch(cap) });
    await sapiom.llm.submit(SPEC);
    expect(cap.url).toContain("/v2/route/async");
    expect(cap.headers?.["x-sapiom-webhook-url"]).toBe(SPEC.webhookUrl);
    expect(cap.headers?.["x-sapiom-model"]).toBe("smart");
    expect(cap.headers?.["x-sapiom-deadline"]).toBe("30");
    expect(cap.headers?.["x-sapiom-complexity"]).toBe("2");
    // tenant credential rides Anthropic-style for the LLM gateway
    expect(cap.headers?.["x-api-key"]).toBe("k");
    expect(JSON.parse(cap.body ?? "{}")).toEqual(SPEC.request);
  });

  it("throws without a webhook URL (no spec field, no env)", async () => {
    delete process.env.SAPIOM_LLM_WEBHOOK_URL;
    const sapiom = createClient({ apiKey: "k", fetch: fakeGatewayFetch({}) });
    await expect(
      sapiom.llm.submit({ request: SPEC.request }),
    ).rejects.toThrow(/webhook URL/);
  });

  it("falls back to SAPIOM_LLM_WEBHOOK_URL from the env", async () => {
    process.env.SAPIOM_LLM_WEBHOOK_URL = "https://engine.example/from-env";
    try {
      const cap: Captured = {};
      const sapiom = createClient({
        apiKey: "k",
        fetch: fakeGatewayFetch(cap),
      });
      await sapiom.llm.submit({ request: SPEC.request });
      expect(cap.headers?.["x-sapiom-webhook-url"]).toBe(
        "https://engine.example/from-env",
      );
    } finally {
      delete process.env.SAPIOM_LLM_WEBHOOK_URL;
    }
  });
});

describe("llm.submit — workflow resume token", () => {
  const KEY = "SAPIOM_CAPABILITY_RESUME_TOKEN";
  afterEach(() => {
    delete process.env[KEY];
  });

  it("forwards the env token as the x-sapiom-workflow-token header", async () => {
    process.env[KEY] = "tok-abc";
    const cap: Captured = {};
    const sapiom = createClient({ apiKey: "k", fetch: fakeGatewayFetch(cap) });
    await sapiom.llm.submit(SPEC);
    expect(cap.headers?.["x-sapiom-workflow-token"]).toBe("tok-abc");
    expect(cap.body).not.toContain("tok-abc"); // header, never the body
  });

  it("sends no token header when none is present (standalone)", async () => {
    const cap: Captured = {};
    const sapiom = createClient({ apiKey: "k", fetch: fakeGatewayFetch(cap) });
    await sapiom.llm.submit(SPEC);
    expect(cap.headers?.["x-sapiom-workflow-token"]).toBeUndefined();
  });
});

describe("llm.submit — wait() polling", () => {
  it("polls to granted and maps the link to camelCase", async () => {
    const sapiom = createClient({
      apiKey: "k",
      fetch: fakeGatewayFetch({}, [
        { execution_id: "exec-1", status: "queued" },
        { execution_id: "exec-1", status: "granted", link: WIRE_LINK },
      ]),
    });
    const handle = await sapiom.llm.submit(SPEC);
    const result = await handle.wait({ pollMs: 1 });
    expect(result).toEqual({
      executionId: "exec-1",
      status: "granted",
      link: {
        anthropicBaseUrl: "https://llm.services.sapiom.ai",
        apiKey: "sapiom-grant-xyz",
        model: "smart",
        expiresAtMs: 1_726_574_400_000,
        usage: "single_request",
      },
      error: null,
    });
  });

  it("maps failure terminals (deadline_exhausted / expired / lost) to failed + error", async () => {
    const sapiom = createClient({
      apiKey: "k",
      fetch: fakeGatewayFetch({}, [
        { execution_id: "exec-1", status: "failed", error: "deadline_exhausted" },
      ]),
    });
    const handle = await sapiom.llm.submit(SPEC);
    const result = await handle.wait({ pollMs: 1 });
    expect(result.status).toBe("failed");
    expect(result.error).toBe("deadline_exhausted");
    expect(result.link).toBeNull();
  });
});

describe("llm.redeem", () => {
  const LINK: LlmGrantLink = {
    anthropicBaseUrl: "https://llm.services.sapiom.ai",
    apiKey: "sapiom-grant-xyz",
    model: "smart",
    expiresAtMs: 1,
    usage: "single_request",
  };

  it("POSTs /v1/messages with the grant as x-api-key and pins the granted model", async () => {
    const cap: Captured = {};
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      cap.url = url;
      cap.headers = init.headers as Record<string, string>;
      cap.body = init.body as string;
      return {
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: "hello" }] }),
        text: async () => "",
      } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;

    const out = await redeem(LINK, { messages: [], model: "ignored" }, fetchImpl);
    expect(cap.url).toBe("https://llm.services.sapiom.ai/v1/messages");
    expect(cap.headers?.["x-api-key"]).toBe("sapiom-grant-xyz");
    expect(JSON.parse(cap.body ?? "{}").model).toBe("smart"); // grant's label wins
    expect(out).toEqual({ content: [{ type: "text", text: "hello" }] });
  });
});

describe("llmRouteResultSchema", () => {
  it("accepts a granted payload", () => {
    const payload = {
      executionId: "exec-1",
      status: "granted",
      link: {
        anthropicBaseUrl: "https://llm.services.sapiom.ai",
        apiKey: "sapiom-grant-xyz",
        model: "smart",
        expiresAtMs: 1,
        usage: "single_request",
      },
      error: null,
    };
    expect(llmRouteResultSchema.parse(payload)).toBe(payload);
  });

  it("accepts a failed payload with a null link", () => {
    const payload = {
      executionId: "exec-1",
      status: "failed",
      link: null,
      error: "deadline_exhausted",
    };
    expect(llmRouteResultSchema.parse(payload)).toBe(payload);
  });

  it("rejects a malformed payload", () => {
    expect(() => llmRouteResultSchema.parse({ status: "granted" })).toThrow(
      LlmRouteResultSchemaError,
    );
    expect(() =>
      llmRouteResultSchema.parse({
        executionId: "e",
        status: "granted",
        error: null,
      }),
    ).toThrow(/link is required/);
  });
});
