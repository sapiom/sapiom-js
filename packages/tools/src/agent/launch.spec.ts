/**
 * launch() — dispatch-handle shape + workflow resume-token forwarding.
 *
 * Injects a fake fetch (no real network) to assert the launched RunHandle
 * satisfies DispatchHandle, and that the engine-injected resume token rides as a
 * header (never the body) only when present in the env — so standalone use is
 * unaffected.
 */
import { createClient } from "../index.js";
import { CODING_RESULT_SIGNAL } from "./index.js";

function fakeLaunchFetch(capture?: {
  headers?: Record<string, string>;
}): typeof globalThis.fetch {
  return (async (_url: string, init: RequestInit = {}) => {
    if (capture) capture.headers = init.headers as Record<string, string>;
    return {
      ok: true,
      status: 202,
      json: async () => ({
        data: {
          id: "run-123",
          attributes: { status: "pending" },
          relationships: { execution_environment: { data: { id: "env-1" } } },
        },
      }),
      text: async () => "",
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
}

describe("agent.coding.launch — dispatch handle", () => {
  it("returns a handle that satisfies DispatchHandle", async () => {
    const sapiom = createClient({ apiKey: "k", fetch: fakeLaunchFetch() });
    const handle = await sapiom.agent.coding.launch({ task: "do a thing" });
    expect(handle.runId).toBe("run-123");
    expect(handle.dispatch).toEqual({
      correlationId: "run-123",
      resultSignal: CODING_RESULT_SIGNAL,
    });
  });

  it("CODING_RESULT_SIGNAL is the capability-stable terminal signal", () => {
    expect(CODING_RESULT_SIGNAL).toBe("agent.coding.result");
  });
});

describe("agent.coding.launch — workflow resume token", () => {
  const KEY = "SAPIOM_CAPABILITY_RESUME_TOKEN";
  afterEach(() => {
    delete process.env[KEY];
  });

  it("forwards the env token as the x-sapiom-workflow-token header", async () => {
    process.env[KEY] = "tok-abc";
    const capture: { headers?: Record<string, string> } = {};
    const sapiom = createClient({
      apiKey: "k",
      fetch: fakeLaunchFetch(capture),
    });
    await sapiom.agent.coding.launch({ task: "t" });
    expect(capture.headers?.["x-sapiom-workflow-token"]).toBe("tok-abc");
  });

  it("omits the header outside a workflow (no env token)", async () => {
    const capture: { headers?: Record<string, string> } = {};
    const sapiom = createClient({
      apiKey: "k",
      fetch: fakeLaunchFetch(capture),
    });
    await sapiom.agent.coding.launch({ task: "t" });
    expect(capture.headers?.["x-sapiom-workflow-token"]).toBeUndefined();
  });

  it("forwards an explicit createClient({ resumeToken }) — the in-process runtime path", async () => {
    const capture: { headers?: Record<string, string> } = {};
    const sapiom = createClient({
      apiKey: "k",
      resumeToken: "tok-explicit",
      fetch: fakeLaunchFetch(capture),
    });
    await sapiom.agent.coding.launch({ task: "t" });
    expect(capture.headers?.["x-sapiom-workflow-token"]).toBe("tok-explicit");
  });

  it("explicit resumeToken wins over the ambient env token", async () => {
    process.env[KEY] = "tok-env";
    const capture: { headers?: Record<string, string> } = {};
    const sapiom = createClient({
      apiKey: "k",
      resumeToken: "tok-explicit",
      fetch: fakeLaunchFetch(capture),
    });
    await sapiom.agent.coding.launch({ task: "t" });
    expect(capture.headers?.["x-sapiom-workflow-token"]).toBe("tok-explicit");
  });
});
