/**
 * orchestrations.launch — dispatch-handle shape, slug URL, resume-token forwarding —
 * plus the resume-payload schema. Injects a fake fetch (no real network).
 */
import { createClient } from "../index.js";
import {
  AGENTS_RESULT_SIGNAL,
  AgentResultSchemaError,
  agentResultSchema,
} from "./index.js";

function fakeFetch(capture?: { headers?: Record<string, string>; url?: string }): typeof globalThis.fetch {
  return (async (url: string, init: RequestInit = {}) => {
    if (capture) {
      capture.headers = init.headers as Record<string, string>;
      capture.url = url;
    }
    return {
      ok: true,
      status: 201,
      json: async () => ({ status: "enqueued", executionId: "exec-9" }),
      text: async () => JSON.stringify({ status: "enqueued", executionId: "exec-9" }),
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
}

describe("orchestrations.launch — dispatch handle", () => {
  it("returns a handle satisfying DispatchHandle (correlationId = child execution id)", async () => {
    const sapiom = createClient({ apiKey: "k", fetch: fakeFetch() });
    const handle = await sapiom.agents.launch({ definition: "enrich-lead", input: { a: 1 } });
    expect(handle.executionId).toBe("exec-9");
    expect(handle.dispatch).toEqual({
      correlationId: "exec-9",
      resultSignal: AGENTS_RESULT_SIGNAL,
    });
  });

  it("POSTs to /agents/v1/definitions/:slug/executions (by slug)", async () => {
    const capture: { url?: string } = {};
    const sapiom = createClient({ apiKey: "k", fetch: fakeFetch(capture) });
    await sapiom.agents.launch({ definition: "enrich-lead" });
    expect(capture.url).toContain("/agents/v1/definitions/enrich-lead/executions");
  });

  it("AGENTS_RESULT_SIGNAL is the capability-stable terminal signal", () => {
    expect(AGENTS_RESULT_SIGNAL).toBe("agents.result");
  });
});

describe("orchestrations.launch — workflow resume token", () => {
  const KEY = "SAPIOM_CAPABILITY_RESUME_TOKEN";
  afterEach(() => {
    delete process.env[KEY];
  });

  it("forwards the env token as the x-sapiom-workflow-token header", async () => {
    process.env[KEY] = "tok-abc";
    const capture: { headers?: Record<string, string> } = {};
    const sapiom = createClient({ apiKey: "k", fetch: fakeFetch(capture) });
    await sapiom.agents.launch({ definition: "d" });
    expect(capture.headers?.["x-sapiom-workflow-token"]).toBe("tok-abc");
  });

  it("omits the header outside a workflow (no env token)", async () => {
    const capture: { headers?: Record<string, string> } = {};
    const sapiom = createClient({ apiKey: "k", fetch: fakeFetch(capture) });
    await sapiom.agents.launch({ definition: "d" });
    expect(capture.headers?.["x-sapiom-workflow-token"]).toBeUndefined();
  });
});

describe("agentResultSchema", () => {
  const base = { executionId: "e", definition: "d", version: "1", startedAt: "t0", finishedAt: "t1" };

  it("accepts a completed payload", () => {
    const p = { ...base, status: "completed", output: { ok: true } };
    expect(agentResultSchema.parse(p)).toBe(p);
  });

  it("accepts a failed payload", () => {
    const p = { ...base, status: "failed", error: { message: "x" } };
    expect(agentResultSchema.parse(p).status).toBe("failed");
  });

  it("rejects an unknown status", () => {
    expect(() => agentResultSchema.parse({ ...base, status: "weird" })).toThrow(
      AgentResultSchemaError,
    );
  });

  it("rejects a completed payload missing output", () => {
    expect(() => agentResultSchema.parse({ ...base, status: "completed" })).toThrow(
      AgentResultSchemaError,
    );
  });
});
