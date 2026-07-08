/**
 * agent.run / agent.launch (default, instant in-server agent) — dispatch-handle
 * shape, terminal-result mapping, and workflow resume-token forwarding. Injects a
 * fake fetch (no real network).
 */
import { createClient } from "../index.js";
import { MODEL_RUN_RESULT_SIGNAL } from "./index.js";

function fakeFetch(opts: {
  capture?: { headers?: Record<string, string>; url?: string };
  terminal?: boolean;
}): typeof globalThis.fetch {
  return (async (url: string, init: RequestInit = {}) => {
    if (opts.capture) {
      opts.capture.headers = init.headers as Record<string, string>;
      opts.capture.url = url;
    }
    const isPost = (init.method ?? "GET") === "POST";
    const attributes = isPost
      ? { status: "pending" }
      : {
          status: "completed",
          output: "OK",
          result: {
            success: true,
            stop_reason: "end_turn",
            turns: 1,
            model_used: "claude-sonnet-4-6",
            duration_ms: 1200,
            cost_usd: 0.001,
            usage: { input_tokens: 10, output_tokens: 5 },
          },
          error: null,
        };
    return {
      ok: true,
      status: isPost ? 202 : 200,
      json: async () => ({ data: { id: "run-abc", attributes } }),
      text: async () => "",
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
}

describe("agent.launch — dispatch handle", () => {
  it("returns a handle that satisfies DispatchHandle", async () => {
    const sapiom = createClient({ apiKey: "k", fetch: fakeFetch({}) });
    const handle = await sapiom.models.launch({ prompt: "say OK" });
    expect(handle.runId).toBe("run-abc");
    expect(handle.dispatch).toEqual({
      correlationId: "run-abc",
      resultSignal: MODEL_RUN_RESULT_SIGNAL,
    });
  });

  it("MODEL_RUN_RESULT_SIGNAL is the capability-stable terminal signal", () => {
    expect(MODEL_RUN_RESULT_SIGNAL).toBe("agent.run.result");
  });

  it("posts to /models/v1/runs", async () => {
    const capture: { url?: string } = {};
    const sapiom = createClient({ apiKey: "k", fetch: fakeFetch({ capture }) });
    await sapiom.models.launch({ prompt: "say OK" });
    expect(capture.url).toContain("/models/v1/runs");
  });
});

describe("agent.run — terminal result mapping", () => {
  it("maps the wire result (snake_case) to the SDK shape", async () => {
    const sapiom = createClient({ apiKey: "k", fetch: fakeFetch({}) });
    const result = await sapiom.models.run({ prompt: "say OK" });
    expect(result.status).toBe("completed");
    expect(result.output).toBe("OK");
    expect(result.result?.stopReason).toBe("end_turn");
    expect(result.result?.costUsd).toBe(0.001);
    expect(result.result?.usage.inputTokens).toBe(10);
  });
});

describe("agent.launch — workflow resume token", () => {
  const KEY = "SAPIOM_CAPABILITY_RESUME_TOKEN";
  afterEach(() => {
    delete process.env[KEY];
  });

  it("forwards the env token as the x-sapiom-workflow-token header", async () => {
    process.env[KEY] = "tok-xyz";
    const capture: { headers?: Record<string, string> } = {};
    const sapiom = createClient({ apiKey: "k", fetch: fakeFetch({ capture }) });
    await sapiom.models.launch({ prompt: "t" });
    expect(capture.headers?.["x-sapiom-workflow-token"]).toBe("tok-xyz");
  });

  it("omits the header outside a workflow (no env token)", async () => {
    const capture: { headers?: Record<string, string> } = {};
    const sapiom = createClient({ apiKey: "k", fetch: fakeFetch({ capture }) });
    await sapiom.models.launch({ prompt: "t" });
    expect(capture.headers?.["x-sapiom-workflow-token"]).toBeUndefined();
  });
});
