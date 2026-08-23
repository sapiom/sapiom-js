/**
 * agent.run / agent.launch (default, instant in-server agent) — dispatch-handle
 * shape, terminal-result mapping, and workflow resume-token forwarding. Injects a
 * fake fetch (no real network).
 */
import { createClient } from "../index.js";
import { MODEL_RUN_RESULT_SIGNAL, modelRunResultSchema } from "./index.js";

function fakeFetch(opts: {
  capture?: { headers?: Record<string, string>; url?: string };
  terminal?: boolean;
  wireResult?: Record<string, unknown>;
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
          result: opts.wireResult ?? {
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
    expect(MODEL_RUN_RESULT_SIGNAL).toBe("models.run.result");
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

  it("maps the serving disclosure (servedClass/lane) when the server reports it", async () => {
    const sapiom = createClient({
      apiKey: "k",
      fetch: fakeFetch({
        wireResult: {
          success: true,
          stop_reason: "end_turn",
          turns: 1,
          model_used: "smart",
          served_class: "medium",
          lane: "run_now",
          duration_ms: 1200,
          cost_usd: 0.001,
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      }),
    });
    const result = await sapiom.models.run({ prompt: "say OK" });
    expect(result.result?.servedClass).toBe("medium");
    expect(result.result?.lane).toBe("run_now");
    // The label echo keeps its own meaning, independent of the disclosed class.
    expect(result.result?.modelUsed).toBe("smart");
  });

  it("maps a result from an older server (no disclosure fields) to null, never a fabricated value", async () => {
    // Same wire doc as the base fixture — no served_class/lane keys at all,
    // the shape a pre-disclosure server emits.
    const sapiom = createClient({ apiKey: "k", fetch: fakeFetch({}) });
    const result = await sapiom.models.run({ prompt: "say OK" });
    expect(result.result?.servedClass).toBeNull();
    expect(result.result?.lane).toBeNull();
  });

  it("surfaces routing warnings (SAP-2765: e.g. an unhonored `model` pin)", async () => {
    const sapiom = createClient({
      apiKey: "k",
      fetch: fakeFetch({
        wireResult: {
          success: true,
          stop_reason: "end_turn",
          turns: 1,
          model_used: null,
          duration_ms: 1200,
          cost_usd: 0.001,
          warnings: ["warn-1", "warn-2"],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      }),
    });
    const result = await sapiom.models.run({ prompt: "say OK", model: "not-a-known-label" });
    expect(result.result?.warnings).toEqual(["warn-1", "warn-2"]);
  });

  it("ONE encoding of 'no warnings' — absent for a missing key, a wire [], or malformed values", async () => {
    const wireResult = (warnings?: unknown) => ({
      success: true,
      stop_reason: "end_turn",
      turns: 1,
      model_used: null,
      duration_ms: 1200,
      cost_usd: 0.001,
      ...(warnings !== undefined ? { warnings } : {}),
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const runWith = async (warnings?: unknown) => {
      const sapiom = createClient({ apiKey: "k", fetch: fakeFetch({ wireResult: wireResult(warnings) }) });
      return (await sapiom.models.run({ prompt: "say OK" })).result?.warnings;
    };

    // Missing key → absent.
    expect(await runWith()).toBeUndefined();
    // Wire `[]` → ALSO absent — a consumer's `if (outcome.warnings)` must not
    // render an empty banner depending on which empty encoding the server sent.
    expect(await runWith([])).toBeUndefined();
    // Not an array → absent, never a string leaking into a `string[]` field.
    expect(await runWith("oops")).toBeUndefined();
    // Mixed array → only the string elements survive the guard.
    expect(await runWith([1, "warn-a", null])).toEqual(["warn-a"]);
  });

  it("the resume payload gets the SAME warnings encoding (modelRunResultSchema normalizes)", async () => {
    // A step resumed via pauseUntilSignal receives the server-serialized
    // payload through modelRunResultSchema.parse, not mapModelResult — the
    // one-encoding guarantee must hold there too.
    const payload = (warnings?: unknown) => ({
      runId: "run-abc",
      status: "completed",
      output: "OK",
      result: {
        success: true,
        stopReason: "end_turn",
        turns: 1,
        modelUsed: null,
        durationMs: 1200,
        costUsd: 0.001,
        ...(warnings !== undefined ? { warnings } : {}),
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreateTokens: 0, thinkingTokens: 0 },
      },
      error: null,
    });

    expect(modelRunResultSchema.parse(payload()).result?.warnings).toBeUndefined();
    expect(modelRunResultSchema.parse(payload([])).result?.warnings).toBeUndefined();
    expect(modelRunResultSchema.parse(payload("oops")).result?.warnings).toBeUndefined();
    expect(modelRunResultSchema.parse(payload([1, "warn-a", null])).result?.warnings).toEqual(["warn-a"]);
    expect(modelRunResultSchema.parse(payload(["warn-1"])).result?.warnings).toEqual(["warn-1"]);
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
