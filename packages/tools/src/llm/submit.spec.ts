/**
 * llm.run() / llm.submit() — direct-route wire shape, dispatch-handle shape,
 * routing headers, resume-token forwarding, wait() polling, and redeem().
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

describe("llm.run — direct routed call", () => {
  function fakeDirectFetch(
    cap: Captured,
    response: Record<string, unknown>,
  ): typeof globalThis.fetch {
    return (async (url: string, init: RequestInit = {}) => {
      cap.url = url;
      cap.headers = init.headers as Record<string, string>;
      cap.body = init.body as string;
      return {
        ok: true,
        status: 200,
        json: async () => response,
        text: async () => "",
      } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;
  }

  it("POSTs the verbatim request to /v2/anthropic/v1/messages with routing + identity headers", async () => {
    const cap: Captured = {};
    const completion = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "m2.7",
      content: [{ type: "text", text: "hi" }],
    };
    const sapiom = createClient({
      apiKey: "k",
      fetch: fakeDirectFetch(cap, completion),
    });
    const res = await sapiom.llm.run({
      request: SPEC.request,
      model: "m2.7",
      complexity: 3,
    });
    expect(cap.url).toContain("/v2/anthropic/v1/messages");
    expect(cap.headers?.["x-sapiom-model"]).toBe("m2.7");
    expect(cap.headers?.["x-sapiom-complexity"]).toBe("3");
    expect(cap.headers?.["x-sapiom-api-key"]).toBe("k");
    // Workflow surface: never-fail defaults ON and is sent EXPLICITLY (the gateway's
    // own direct default is OFF for drop-in callers — 07-15 contract, per-mode).
    expect(cap.headers?.["x-sapiom-never-fail"]).toBe("true");
    // direct is synchronous — no async control headers
    expect(cap.headers?.["x-sapiom-webhook-url"]).toBeUndefined();
    expect(cap.headers?.["x-sapiom-deadline"]).toBeUndefined();
    expect(JSON.parse(cap.body ?? "{}")).toEqual(SPEC.request);
    expect(res).toEqual(completion);
  });

  it("run(): neverFail: false opts into plain 429s (header sent as false)", async () => {
    const cap: Captured = {};
    const sapiom = createClient({ apiKey: "k", fetch: fakeDirectFetch(cap, { ok: true }) });
    await sapiom.llm.run({ request: SPEC.request, model: "m2.7", neverFail: false });
    expect(cap.headers?.["x-sapiom-never-fail"]).toBe("false");
  });

  it("submit(): neverFail is passed through only when specified (gateway async default is ON)", async () => {
    const cap: Captured = {};
    let sapiom = createClient({ apiKey: "k", fetch: fakeGatewayFetch(cap) });
    await sapiom.llm.submit({ ...SPEC });
    expect(cap.headers?.["x-sapiom-never-fail"]).toBeUndefined();

    const cap2: Captured = {};
    sapiom = createClient({ apiKey: "k", fetch: fakeGatewayFetch(cap2) });
    await sapiom.llm.submit({ ...SPEC, neverFail: false });
    expect(cap2.headers?.["x-sapiom-never-fail"]).toBe("false");
  });

  it("omits routing headers when unset (gateway falls back to its default label)", async () => {
    const cap: Captured = {};
    const sapiom = createClient({
      apiKey: "k",
      fetch: fakeDirectFetch(cap, { ok: true }),
    });
    await sapiom.llm.run({ request: SPEC.request });
    expect(cap.headers?.["x-sapiom-model"]).toBeUndefined();
    expect(cap.headers?.["x-sapiom-complexity"]).toBeUndefined();
  });

  it("surfaces a non-2xx gateway answer as an error with the status", async () => {
    const failFetch = (async () =>
      ({
        ok: false,
        status: 429,
        text: async () => "no capacity",
        json: async () => ({}),
      }) as unknown as Response) as unknown as typeof globalThis.fetch;
    const sapiom = createClient({ apiKey: "k", fetch: failFetch });
    await expect(sapiom.llm.run({ request: SPEC.request })).rejects.toThrow(
      /429/,
    );
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
    // tenant credential rides the edge identity header (SAP-1496: the x402
    // edge's IdentityVerificationGuard reads x-sapiom-api-key)
    expect(cap.headers?.["x-sapiom-api-key"]).toBe("k");
    expect(JSON.parse(cap.body ?? "{}")).toEqual(SPEC.request);
  });

  it("throws without a webhook URL (no spec field, no env)", async () => {
    delete process.env.SAPIOM_LLM_WEBHOOK_URL;
    const sapiom = createClient({ apiKey: "k", fetch: fakeGatewayFetch({}) });
    await expect(sapiom.llm.submit({ request: SPEC.request })).rejects.toThrow(
      /webhook URL/,
    );
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
        {
          execution_id: "exec-1",
          status: "failed",
          error: "deadline_exhausted",
        },
      ]),
    });
    const handle = await sapiom.llm.submit(SPEC);
    const result = await handle.wait({ pollMs: 1 });
    expect(result.status).toBe("failed");
    expect(result.error).toBe("deadline_exhausted");
    expect(result.link).toBeNull();
  });

  it("status polls (GET) carry the identity credential — SAP-1496 gates /v2 status before id validation", async () => {
    // The edge 401s ANY /v2 call without a resolved Sapiom identity, status GETs
    // included. Pin that polling sends x-sapiom-api-key on every GET, not just on
    // the submit POST.
    const getHeaders: Array<Record<string, string>> = [];
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      if ((init.method ?? "GET") === "POST") {
        return {
          ok: true,
          status: 202,
          json: async () => ({ execution_id: "exec-1", status: "queued" }),
          text: async () => "",
        } as unknown as Response;
      }
      getHeaders.push(init.headers as Record<string, string>);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          execution_id: "exec-1",
          status: "granted",
          link: WIRE_LINK,
        }),
        text: async () => "",
      } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;
    const sapiom = createClient({ apiKey: "k", fetch: fetchImpl });
    const handle = await sapiom.llm.submit(SPEC);
    await handle.status();
    await handle.wait({ pollMs: 1 });
    expect(getHeaders.length).toBeGreaterThanOrEqual(2);
    for (const h of getHeaders) {
      expect(h?.["x-sapiom-api-key"]).toBe("k");
    }
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

  it("POSTs /v2/anthropic/v1/messages with the grant header + identity credential (payment at redemption)", async () => {
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

    const sapiom = createClient({ apiKey: "k", fetch: fetchImpl });
    const out = await sapiom.llm.redeem(LINK, {
      messages: [],
      model: "ignored",
    });
    expect(cap.url).toBe("https://llm.services.sapiom.ai/v2/anthropic/v1/messages");
    // the grant rides its own header; the reserved deployment wins server-side
    expect(cap.headers?.["x-sapiom-grant-token"]).toBe("sapiom-grant-xyz");
    // the caller's API key settles billing at the edge (SAP-1496)
    expect(cap.headers?.["x-sapiom-api-key"]).toBe("k");
    // body is re-sent verbatim — no client-side model rewrite
    expect(JSON.parse(cap.body ?? "{}").model).toBe("ignored");
    expect(out).toEqual({ content: [{ type: "text", text: "hello" }] });
  });

  it("standalone redeem() uses the ambient transport credential", async () => {
    const cap: Captured = {};
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      cap.headers = init.headers as Record<string, string>;
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => "",
      } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;
    const { Transport } = await import("../_client/index.js");
    await redeem(
      LINK,
      { messages: [] },
      new Transport({ apiKey: "k2", fetch: fetchImpl }),
    );
    expect(cap.headers?.["x-sapiom-grant-token"]).toBe("sapiom-grant-xyz");
    expect(cap.headers?.["x-sapiom-api-key"]).toBe("k2");
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
