/**
 * orchestrations.launch({ at }) — delayed (scheduled) dispatch.
 *
 * A step scheduling a child for LATER: launch creates a one-off schedule (not a run now), forwards
 * the parent resume token as a header, and returns a pause-only DispatchHandle whose correlation is
 * derived from the created schedule's id (`trigger-<id>`) — the value the eventually-fired child
 * resumes the step on. status()/wait() throw (no child exists until the scheduled time).
 */
import { createClient } from "../index.js";
import { AGENTS_RESULT_SIGNAL } from "./index.js";

function fakeFetch(capture: { url?: string; init?: RequestInit }): typeof globalThis.fetch {
  return (async (url: string, init: RequestInit = {}) => {
    capture.url = url;
    capture.init = init;
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: "trig-9" }),
      text: async () => "",
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
}

describe("orchestrations.launch — delayed (scheduled) dispatch", () => {
  const KEY = "SAPIOM_CAPABILITY_RESUME_TOKEN";
  afterEach(() => {
    delete process.env[KEY];
  });

  it("schedules a one-off (not a run now) and returns a pause-only handle correlated to the schedule", async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    const sapiom = createClient({ apiKey: "k", fetch: fakeFetch(cap) });

    const handle = await sapiom.agents.launch({
      definition: "B",
      at: "2026-07-01T00:00:00.000Z",
      input: { a: 1 },
    });

    // Hits the schedule (trigger) create route, not the execution route.
    expect(cap.url).toMatch(/\/agents\/v1\/definitions\/B\/triggers$/);
    expect(cap.init?.method).toBe("POST");
    expect(JSON.parse(cap.init?.body as string)).toEqual({
      kind: "schedule_once",
      at: "2026-07-01T00:00:00.000Z",
      input: { a: 1 },
    });
    // Pause-only handle: correlation derived from the created schedule id.
    expect(handle.dispatch).toEqual({
      correlationId: "trigger-trig-9",
      resultSignal: AGENTS_RESULT_SIGNAL,
    });
    expect(() => handle.wait()).toThrow(/scheduled/i);
    expect(() => handle.status()).toThrow(/scheduled/i);
  });

  it("accepts a Date for `at` and sends it as a UTC ISO string", async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    const sapiom = createClient({ apiKey: "k", fetch: fakeFetch(cap) });

    await sapiom.agents.launch({ definition: "B", at: new Date("2026-07-01T00:00:00.000Z") });

    expect(JSON.parse(cap.init?.body as string).at).toBe("2026-07-01T00:00:00.000Z");
  });

  it("forwards the parent resume token as the x-sapiom-workflow-token header", async () => {
    process.env[KEY] = "tok-abc";
    const cap: { url?: string; init?: RequestInit } = {};
    const sapiom = createClient({ apiKey: "k", fetch: fakeFetch(cap) });

    await sapiom.agents.launch({ definition: "B", at: "2026-07-01T00:00:00.000Z" });

    expect((cap.init?.headers as Record<string, string>)["x-sapiom-workflow-token"]).toBe("tok-abc");
  });
});
