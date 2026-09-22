/**
 * orchestrations.launch — dispatch-handle shape, slug URL, resume-token forwarding —
 * plus the resume-payload schema. Injects a fake fetch (no real network).
 */
import { createClient } from "../index.js";
import type { Transport } from "../_client/index.js";
import {
  AGENTS_RESULT_SIGNAL,
  AgentDispatchError,
  AgentResultSchemaError,
  agentResultSchema,
  launch,
} from "./index.js";

function fakeFetch(capture?: {
  headers?: Record<string, string>;
  url?: string;
}): typeof globalThis.fetch {
  return (async (url: string, init: RequestInit = {}) => {
    if (capture) {
      capture.headers = init.headers as Record<string, string>;
      capture.url = url;
    }
    return {
      ok: true,
      status: 201,
      json: async () => ({ status: "enqueued", executionId: "exec-9" }),
      text: async () =>
        JSON.stringify({ status: "enqueued", executionId: "exec-9" }),
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
}

describe("orchestrations.launch — dispatch handle", () => {
  it("returns a handle satisfying DispatchHandle (correlationId = child execution id)", async () => {
    const sapiom = createClient({ apiKey: "k", fetch: fakeFetch() });
    const handle = await sapiom.agents.launch({
      definition: "enrich-lead",
      input: { a: 1 },
    });
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
    expect(capture.url).toContain(
      "/agents/v1/definitions/enrich-lead/executions",
    );
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
  const base = {
    executionId: "e",
    definition: "d",
    version: "1",
    startedAt: "t0",
    finishedAt: "t1",
  };

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
    expect(() =>
      agentResultSchema.parse({ ...base, status: "completed" }),
    ).toThrow(AgentResultSchemaError);
  });
});

/**
 * SAP-3219 — a rejected DISPATCH is data, not a throw. A coordinator dispatching
 * several children by slug must be able to branch on one bad slug (or one input
 * the engine's pre-gate refuses) without the calling step blowing up and
 * retrying to its cap.
 */
describe("orchestrations dispatch rejection — `run` resolves it, `launch` throws it", () => {
  /** A fetch that answers the create-execution POST with one non-2xx. */
  function rejectingFetch(
    status: number,
    body: unknown,
  ): typeof globalThis.fetch {
    return (async () => ({
      ok: false,
      status,
      text: async () =>
        typeof body === "string" ? body : JSON.stringify(body),
    })) as unknown as typeof globalThis.fetch;
  }

  it("resolves an unknown slug (404) as status 'rejected' with code 'not_found'", async () => {
    const body = {
      statusCode: 404,
      code: "definition_not_found",
      message: "no such definition: typo-slug",
    };
    const sapiom = createClient({
      apiKey: "k",
      fetch: rejectingFetch(404, body),
    });

    const result = await sapiom.agents.run({ definition: "typo-slug" });

    expect(result).toEqual({
      executionId: null,
      status: "rejected",
      output: null,
      error: {
        code: "not_found",
        message: "no such definition: typo-slug",
        status: 404,
        details: body,
      },
    });
  });

  it("resolves input the engine's pre-gate refuses (400) as code 'invalid_input'", async () => {
    const body = {
      statusCode: 400,
      code: "step_input_invalid",
      message: "step 'entry' input invalid: /topic must be string",
    };
    const sapiom = createClient({
      apiKey: "k",
      fetch: rejectingFetch(400, body),
    });

    const result = await sapiom.agents.run({
      definition: "research-topic",
      input: { topic: 7 },
    });

    expect(result.status).toBe("rejected");
    expect(result.executionId).toBeNull();
    // `details` keeps the platform's own body, so the author can read its stable
    // code and validation issues.
    expect(result.error).toMatchObject({
      code: "invalid_input",
      status: 400,
      details: body,
    });
  });

  it("resolves a transport fault as 'unknown', NOT 'rejected' — a child may exist", async () => {
    const fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    const sapiom = createClient({ apiKey: "k", fetch });

    const result = await sapiom.agents.run({ definition: "enrich-lead" });

    // The response can be lost AFTER the platform accepted the request, so this
    // does not prove nothing was created. `"rejected"` would license a
    // re-dispatch that duplicates a live child.
    expect(result.status).toBe("unknown");
    expect(result.executionId).toBeNull();
    expect(result.error).toEqual({
      code: "transport",
      message: "fetch failed",
      status: null,
      details: null,
    });
  });

  it("resolves a 5xx as 'unknown' too — the row may have been created then failed", async () => {
    const sapiom = createClient({
      apiKey: "k",
      fetch: rejectingFetch(503, "upstream unavailable"),
    });

    const result = await sapiom.agents.run({ definition: "enrich-lead" });

    expect(result.status).toBe("unknown");
    expect(result.error).toMatchObject({ code: "http", status: 503 });
  });

  it.each([
    [404, "not_found"],
    [400, "invalid_input"],
    [401, "http"],
    [403, "http"],
    [422, "invalid_input"],
  ])(
    "resolves a %i as 'rejected' — the platform's answer proves nothing was created",
    async (status, code) => {
      const sapiom = createClient({
        apiKey: "k",
        fetch: rejectingFetch(status, { message: "no" }),
      });

      const result = await sapiom.agents.run({ definition: "d" });

      expect(result.status).toBe("rejected");
      expect(result.error).toMatchObject({ code, status });
    },
  );

  it("marks the thrown error ambiguous or proven so a launch caller can tell", async () => {
    const proven = createClient({
      apiKey: "k",
      fetch: rejectingFetch(404, { message: "no such slug" }),
    });
    const ambiguous = createClient({
      apiKey: "k",
      fetch: rejectingFetch(503, "upstream unavailable"),
    });

    await expect(
      proven.agents.launch({ definition: "d" }),
    ).rejects.toMatchObject({
      childMayExist: false,
    });
    await expect(
      ambiguous.agents.launch({ definition: "d" }),
    ).rejects.toMatchObject({ childMayExist: true });
  });

  it("keeps a non-JSON error body as raw text in `details`", async () => {
    const sapiom = createClient({
      apiKey: "k",
      fetch: rejectingFetch(503, "upstream unavailable"),
    });

    const result = await sapiom.agents.run({ definition: "enrich-lead" });

    expect(result.error).toMatchObject({ details: "upstream unavailable" });
  });

  it("`status !== 'completed'` is the single branch for a rejection", async () => {
    const sapiom = createClient({
      apiKey: "k",
      fetch: rejectingFetch(404, { message: "gone" }),
    });
    const result = await sapiom.agents.run({ definition: "typo-slug" });
    expect(result.status).not.toBe("completed");
  });

  it("launch THROWS a typed AgentDispatchError rather than a handle that can't be paused on", async () => {
    const body = {
      statusCode: 404,
      code: "definition_not_found",
      message: "gone",
    };
    const sapiom = createClient({
      apiKey: "k",
      fetch: rejectingFetch(404, body),
    });

    // No child exists, so there is no pausable handle to hand back. Throwing
    // beats returning an object that lies about being a RunHandle.
    const error = await sapiom.agents
      .launch({ definition: "typo-slug" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AgentDispatchError);
    expect(error).toMatchObject({
      name: "AgentDispatchError",
      code: "not_found",
      status: 404,
      details: body,
      message: "gone",
    });
  });

  it("the thrown error converts to the same AgentRunError `run` reports as data", async () => {
    const body = { message: "gone" };
    const sapiom = createClient({
      apiKey: "k",
      fetch: rejectingFetch(404, body),
    });

    const thrown = (await sapiom.agents
      .launch({ definition: "typo-slug" })
      .catch((e: unknown) => e)) as AgentDispatchError;
    const viaRun = await sapiom.agents.run({ definition: "typo-slug" });

    // The two entry points differ in MECHANISM, never in what they report.
    expect(thrown.toRunError()).toEqual(viaRun.error);
  });

  it("throws on a refused delayed dispatch (`at`) too", async () => {
    const sapiom = createClient({
      apiKey: "k",
      fetch: rejectingFetch(404, { message: "gone" }),
    });

    await expect(
      sapiom.agents.launch({
        definition: "typo-slug",
        at: "2099-01-01T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ name: "AgentDispatchError", code: "not_found" });
  });

  it("a SUCCESSFUL delayed dispatch is pausable and names no run yet", async () => {
    const fetch = (async () => ({
      ok: true,
      status: 201,
      json: async () => ({ id: "trig-1" }),
      text: async () => "",
    })) as unknown as typeof globalThis.fetch;
    const sapiom = createClient({ apiKey: "k", fetch });

    const handle = await sapiom.agents.launch({
      definition: "enrich-lead",
      at: "2099-01-01T00:00:00.000Z",
    });

    expect(handle.dispatch).toEqual({
      correlationId: "trigger-trig-1",
      resultSignal: AGENTS_RESULT_SIGNAL,
    });
    // `null`, not `""` — there is genuinely no execution until the schedule fires.
    expect(handle.executionId).toBeNull();
  });
});

describe("orchestrations wait() — non-terminal outcomes are data too", () => {
  /** POST the launch, then answer every status read with `doc`. */
  function launchThenStatus(
    doc: () => Promise<unknown>,
  ): typeof globalThis.fetch {
    let first = true;
    return (async () => {
      if (first) {
        first = false;
        return {
          ok: true,
          status: 201,
          json: async () => ({ status: "enqueued", executionId: "exec-9" }),
          text: async () => "",
        } as unknown as Response;
      }
      return (await doc()) as Response;
    }) as unknown as typeof globalThis.fetch;
  }

  it("resolves 'timed_out' (keeping the executionId) instead of throwing at the deadline", async () => {
    const sapiom = createClient({
      apiKey: "k",
      fetch: launchThenStatus(async () => {
        // Outlast the 1ms budget so the deadline has certainly passed by the
        // time the first poll is evaluated.
        await new Promise((r) => setTimeout(r, 5));
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: "running" }),
          text: async () => "",
        };
      }),
    });
    const handle = await sapiom.agents.launch({ definition: "slow-child" });

    const result = await handle.wait({ timeoutMs: 1, pollMs: 1 });

    expect(result).toMatchObject({
      executionId: "exec-9",
      status: "timed_out",
      output: null,
      error: { code: "timeout", status: null },
    });
  });

  it("resolves a 4xx on the status read as 'unknown' — the run may still be live", async () => {
    const sapiom = createClient({
      apiKey: "k",
      fetch: launchThenStatus(async () => ({
        ok: false,
        status: 404,
        text: async () =>
          JSON.stringify({ code: "execution_not_found", message: "gone" }),
      })),
    });
    const handle = await sapiom.agents.launch({ definition: "enrich-lead" });

    const result = await handle.wait({ timeoutMs: 60_000, pollMs: 1 });

    // NOT "rejected": a rejection means nothing was dispatched and is safe to
    // re-dispatch. Here the child exists and may still be running, so the
    // executionId is kept and the status says only "we could not read it".
    expect(result).toMatchObject({
      executionId: "exec-9",
      status: "unknown",
      error: { code: "not_found", status: 404 },
    });
  });

  it("gives up with 'unknown' after a bounded run of consecutive 5xx polls", async () => {
    let reads = 0;
    const sapiom = createClient({
      apiKey: "k",
      fetch: launchThenStatus(async () => {
        reads += 1;
        return {
          ok: false,
          status: 503,
          text: async () => "upstream unavailable",
        };
      }),
    });
    const handle = await sapiom.agents.launch({ definition: "enrich-lead" });

    // A one-hour budget would otherwise mean ~1200 doomed requests.
    const result = await handle.wait({
      timeoutMs: 60 * 60_000,
      pollMs: 1,
      retry: { initialBackoffMs: 1, maxBackoffMs: 1 },
    });

    expect(result).toMatchObject({
      executionId: "exec-9",
      status: "unknown",
      error: { code: "http", status: 503 },
    });
    expect(reads).toBe(12);
  });

  it("a 'timed_out' result always carries code 'timeout', even after earlier poll faults", async () => {
    let reads = 0;
    const sapiom = createClient({
      apiKey: "k",
      fetch: launchThenStatus(async () => {
        reads += 1;
        // One fault, then slow "running" reads that outlast the budget.
        if (reads === 1) {
          return { ok: false, status: 503, text: async () => "blip" };
        }
        await new Promise((r) => setTimeout(r, 5));
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: "running" }),
          text: async () => "",
        };
      }),
    });
    const handle = await sapiom.agents.launch({ definition: "slow-child" });

    const result = await handle.wait({ timeoutMs: 1, pollMs: 1 });

    expect(result.status).toBe("timed_out");
    expect(result.error).toMatchObject({ code: "timeout", status: null });
  });

  it.each([408, 429])(
    "rides out a transient %i on the status read instead of giving up",
    async (transient) => {
      let reads = 0;
      const sapiom = createClient({
        apiKey: "k",
        fetch: launchThenStatus(async () => {
          reads += 1;
          if (reads === 1) {
            return {
              ok: false,
              status: transient,
              text: async () => "slow down",
            };
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({ status: "completed", output: { ok: true } }),
            text: async () => "",
          };
        }),
      });
      const handle = await sapiom.agents.launch({ definition: "enrich-lead" });

      const result = await handle.wait({
        timeoutMs: 60_000,
        pollMs: 1,
        retry: { initialBackoffMs: 1, maxBackoffMs: 1 },
      });

      // One rate-limit answer must not end an hour-long wait.
      expect(result.status).toBe("completed");
      expect(reads).toBe(2);
    },
  );

  it("rides out a transient 5xx and resolves the terminal status", async () => {
    let reads = 0;
    const sapiom = createClient({
      apiKey: "k",
      fetch: launchThenStatus(async () => {
        reads += 1;
        if (reads === 1) {
          return {
            ok: false,
            status: 503,
            text: async () => "upstream unavailable",
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: "completed", output: { ok: true } }),
          text: async () => "",
        };
      }),
    });
    const handle = await sapiom.agents.launch({ definition: "enrich-lead" });

    const result = await handle.wait({
      timeoutMs: 60_000,
      pollMs: 1,
      retry: { initialBackoffMs: 1, maxBackoffMs: 1 },
    });

    expect(result).toEqual({
      executionId: "exec-9",
      status: "completed",
      output: { ok: true },
      error: null,
    });
    expect(reads).toBe(2);
  });
});

/**
 * SAP-3615: a 429 on a status read failed the whole parent run when ~100
 * parents polled their children from one egress IP. `wait()` now backs off
 * (2 s → 4 s → … capped at 30 s, honouring `Retry-After`), never past the
 * caller's deadline, and gives up only after a bounded run of faults.
 *
 * Fake timers drive the schedule: `Date.now()` is faked too, so both the
 * back-off and the deadline check run in virtual time.
 */
describe("wait() back-off on transient status-read faults [SAP-3615]", () => {
  type Answer =
    | { kind: "doc"; status: string; output?: unknown }
    | { kind: "http"; status: number; retryAfter?: string }
    | { kind: "throw"; error: unknown };

  /** POST the launch, then answer each status read from `script` in order (the last answer repeats). */
  function scripted(script: Answer[]) {
    const readAt: number[] = [];
    let first = true;
    let i = 0;
    const fetch = (async () => {
      if (first) {
        first = false;
        return {
          ok: true,
          status: 201,
          json: async () => ({ status: "enqueued", executionId: "exec-9" }),
          text: async () => "",
        } as unknown as Response;
      }
      readAt.push(Date.now());
      const answer = script[Math.min(i, script.length - 1)];
      i += 1;
      if (answer.kind === "throw") throw answer.error;
      if (answer.kind === "http") {
        return {
          ok: false,
          status: answer.status,
          headers: {
            get: (name: string) =>
              name.toLowerCase() === "retry-after"
                ? (answer.retryAfter ?? null)
                : null,
          },
          text: async () =>
            JSON.stringify({
              statusCode: answer.status,
              message: "ThrottlerException: Too Many Requests",
            }),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: answer.status, output: answer.output }),
        text: async () => "",
      } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;
    return { fetch, readAt, reads: () => readAt.length };
  }

  /** Gaps between consecutive reads, in virtual ms. */
  const gaps = (readAt: number[]) =>
    readAt.slice(1).map((t, idx) => t - readAt[idx]);

  const doc = (status: string, output?: unknown): Answer => ({
    kind: "doc",
    status,
    output,
  });
  const http = (status: number, retryAfter?: string): Answer => ({
    kind: "http",
    status,
    retryAfter,
  });

  beforeEach(() => {
    jest.useFakeTimers();
    // Deterministic schedule: no jitter unless a test asks for it.
    jest.spyOn(Math, "random").mockReturnValue(0);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("(a) 429 → running → completed resolves, backing off 2 s after the 429 and pollMs after 'running'", async () => {
    const s = scripted([http(429), doc("running"), doc("completed", { n: 1 })]);
    const sapiom = createClient({ apiKey: "k", fetch: s.fetch });
    const handle = await sapiom.agents.launch({ definition: "enrich-lead" });

    const pending = handle.wait({ timeoutMs: 60_000, pollMs: 3_000 });
    await jest.runAllTimersAsync();
    const result = await pending;

    expect(result).toEqual({
      executionId: "exec-9",
      status: "completed",
      output: { n: 1 },
      error: null,
    });
    expect(s.reads()).toBe(3);
    expect(gaps(s.readAt)).toEqual([2_000, 3_000]);
  });

  it("(b) a 404 on the read ends the wait at once — no back-off, one read", async () => {
    const s = scripted([http(404)]);
    const sapiom = createClient({ apiKey: "k", fetch: s.fetch });
    const handle = await sapiom.agents.launch({ definition: "enrich-lead" });

    const pending = handle.wait({ timeoutMs: 60_000 });
    await jest.runAllTimersAsync();
    const result = await pending;

    expect(result).toMatchObject({
      status: "unknown",
      error: { code: "not_found", status: 404 },
    });
    expect(s.reads()).toBe(1);
  });

  it("(c) a 429 storm past the deadline resolves 'timed_out' at the deadline, carrying the last 429", async () => {
    const s = scripted([http(429)]);
    const sapiom = createClient({ apiKey: "k", fetch: s.fetch });
    const handle = await sapiom.agents.launch({ definition: "enrich-lead" });

    const startedAt = Date.now();
    const pending = handle.wait({ timeoutMs: 60_000 });
    await jest.runAllTimersAsync();
    const result = await pending;

    expect(result).toMatchObject({
      executionId: "exec-9",
      status: "timed_out",
      error: {
        code: "timeout",
        status: null,
        details: { code: "http", status: 429 },
      },
    });
    // 2 + 4 + 8 + 16 + 30 = 60 s of back-off: reads at 0, 2, 6, 14, 30, 60 —
    // the last one sits exactly on the deadline's edge, never beyond it.
    expect(Date.now() - startedAt).toBe(60_000);
    expect(s.readAt.map((t) => t - startedAt)).toEqual([
      0, 2_000, 6_000, 14_000, 30_000, 60_000,
    ]);
  });

  it("caps the back-off at 30 s and gives up 'unknown' after 12 consecutive faults", async () => {
    const s = scripted([http(429)]);
    const sapiom = createClient({ apiKey: "k", fetch: s.fetch });
    const handle = await sapiom.agents.launch({ definition: "enrich-lead" });

    const pending = handle.wait({ timeoutMs: 60 * 60_000 });
    await jest.runAllTimersAsync();
    const result = await pending;

    expect(result).toMatchObject({
      executionId: "exec-9",
      status: "unknown",
      error: { code: "http", status: 429 },
    });
    expect(s.reads()).toBe(12);
    expect(gaps(s.readAt)).toEqual([
      2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000, 30_000, 30_000,
      30_000, 30_000,
    ]);
  });

  it("jitter only lengthens a delay, by at most 20%, and never breaches the cap", async () => {
    (Math.random as jest.Mock).mockReturnValue(1);
    const s = scripted([http(503), http(503), doc("completed")]);
    const sapiom = createClient({ apiKey: "k", fetch: s.fetch });
    const handle = await sapiom.agents.launch({ definition: "enrich-lead" });

    const pending = handle.wait({
      timeoutMs: 60_000,
      retry: { initialBackoffMs: 20_000, maxBackoffMs: 30_000 },
    });
    await jest.runAllTimersAsync();
    await pending;

    // 20 s × 1.2 = 24 s; then 40 s × 1.2 would be 48 s, capped to 30 s.
    expect(gaps(s.readAt)).toEqual([24_000, 30_000]);
  });

  it("(d) honours a Retry-After header (seconds) over the computed back-off", async () => {
    const s = scripted([http(429, "7"), doc("completed")]);
    const sapiom = createClient({ apiKey: "k", fetch: s.fetch });
    const handle = await sapiom.agents.launch({ definition: "enrich-lead" });

    const pending = handle.wait({ timeoutMs: 60_000 });
    await jest.runAllTimersAsync();
    const result = await pending;

    expect(result.status).toBe("completed");
    expect(gaps(s.readAt)).toEqual([7_000]);
  });

  it("(d) honours a Retry-After HTTP-date too, and clamps it to the caller's deadline", async () => {
    const at = new Date(Date.now() + 90_000).toUTCString();
    const s = scripted([http(429, at), doc("running")]);
    const sapiom = createClient({ apiKey: "k", fetch: s.fetch });
    const handle = await sapiom.agents.launch({ definition: "enrich-lead" });

    const startedAt = Date.now();
    const pending = handle.wait({ timeoutMs: 60_000 });
    await jest.runAllTimersAsync();
    const result = await pending;

    // The platform asked for 90 s; the caller allowed 60. The one retry lands
    // at the deadline and the wait times out there — 30 s early is the
    // caller's call, not the platform's.
    expect(result.status).toBe("timed_out");
    expect(s.readAt.map((t) => t - startedAt)).toEqual([0, 60_000]);
  });

  it("rides out a network fault (fetch failed / ECONNRESET) like a 5xx", async () => {
    const reset = new TypeError("fetch failed");
    (reset as { cause?: unknown }).cause = { code: "ECONNRESET" };
    const s = scripted([
      { kind: "throw", error: reset },
      { kind: "throw", error: new Error("read ETIMEDOUT") },
      doc("completed", "ok"),
    ]);
    const sapiom = createClient({ apiKey: "k", fetch: s.fetch });
    const handle = await sapiom.agents.launch({ definition: "enrich-lead" });

    const pending = handle.wait({ timeoutMs: 60_000 });
    await jest.runAllTimersAsync();
    const result = await pending;

    expect(result).toMatchObject({ status: "completed", output: "ok" });
    expect(gaps(s.readAt)).toEqual([2_000, 4_000]);
  });

  it("a malformed 2xx body (schema fault) is permanent: 'unknown' at once", async () => {
    const s = scripted([
      { kind: "throw", error: new SyntaxError("Unexpected token < in JSON") },
    ]);
    const sapiom = createClient({ apiKey: "k", fetch: s.fetch });
    const handle = await sapiom.agents.launch({ definition: "enrich-lead" });

    const pending = handle.wait({ timeoutMs: 60_000 });
    await jest.runAllTimersAsync();
    const result = await pending;

    expect(result).toMatchObject({
      status: "unknown",
      error: { code: "transport", status: null },
    });
    expect(s.reads()).toBe(1);
  });

  it("the SDK's own deadline error is never treated as transient", async () => {
    const s = scripted([
      {
        kind: "throw",
        error: new Error("coding run r-1 timed out after 60000ms"),
      },
    ]);
    const sapiom = createClient({ apiKey: "k", fetch: s.fetch });
    const handle = await sapiom.agents.launch({ definition: "enrich-lead" });

    const pending = handle.wait({ timeoutMs: 60_000 });
    await jest.runAllTimersAsync();
    const result = await pending;

    expect(result.status).toBe("unknown");
    expect(s.reads()).toBe(1);
  });

  it("a successful read resets the consecutive-fault count", async () => {
    const s = scripted([
      ...Array.from({ length: 11 }, () => http(429)),
      doc("running"),
      ...Array.from({ length: 11 }, () => http(503)),
      doc("completed"),
    ]);
    const sapiom = createClient({ apiKey: "k", fetch: s.fetch });
    const handle = await sapiom.agents.launch({ definition: "enrich-lead" });

    const pending = handle.wait({
      timeoutMs: 24 * 60 * 60_000,
      retry: { initialBackoffMs: 1, maxBackoffMs: 1 },
    });
    await jest.runAllTimersAsync();
    const result = await pending;

    // 22 faults in total, never 12 in a row.
    expect(result.status).toBe("completed");
    expect(s.reads()).toBe(24);
  });

  it("falls back to the status in a plain error message when the transport is not typed", async () => {
    // An older/third-party transport: a bare Error with the arrow-status shape.
    let calls = 0;
    const transport = {
      resumeToken: undefined,
      async request(url: string) {
        if (url.endsWith("/executions")) {
          return { status: "enqueued", executionId: "exec-9" };
        }
        calls += 1;
        if (calls === 1) {
          throw new Error(
            `GET ${url} → 429 {"statusCode":429,"message":"ThrottlerException: Too Many Requests"}`,
          );
        }
        if (calls === 2) {
          throw new Error(`GET ${url} → 404 {"code":"execution_not_found"}`);
        }
        return { status: "completed" };
      },
    } as unknown as Transport;
    const handle = await launch({ definition: "d" }, transport, "https://t");

    const pending = handle.wait({ timeoutMs: 60_000 });
    await jest.runAllTimersAsync();
    const result = await pending;

    // The 429 was ridden out (read #2 happened); the 404 ended the wait.
    expect(result).toMatchObject({
      status: "unknown",
      error: { code: "not_found", status: 404 },
    });
    expect(calls).toBe(2);
  });

  describe("status()", () => {
    it("retries a transient fault briefly, then answers", async () => {
      const s = scripted([http(429), doc("paused")]);
      const sapiom = createClient({ apiKey: "k", fetch: s.fetch });
      const handle = await sapiom.agents.launch({ definition: "enrich-lead" });

      const pending = handle.status();
      await jest.runAllTimersAsync();

      await expect(pending).resolves.toBe("paused");
      expect(gaps(s.readAt)).toEqual([2_000]);
    });

    it("throws a permanent fault (404) at once", async () => {
      const s = scripted([http(404)]);
      const sapiom = createClient({ apiKey: "k", fetch: s.fetch });
      const handle = await sapiom.agents.launch({ definition: "enrich-lead" });

      await expect(handle.status()).rejects.toMatchObject({ status: 404 });
      expect(s.reads()).toBe(1);
    });

    it("throws the last fault after three consecutive transient ones", async () => {
      const s = scripted([http(503)]);
      const sapiom = createClient({ apiKey: "k", fetch: s.fetch });
      const handle = await sapiom.agents.launch({ definition: "enrich-lead" });

      const pending = handle.status();
      // Swallow here so an unhandled rejection can't fire while timers run.
      const outcome = pending.then(
        () => "resolved",
        (e: unknown) => e,
      );
      await jest.runAllTimersAsync();

      await expect(outcome).resolves.toMatchObject({ status: 503 });
      expect(s.reads()).toBe(3);
      expect(gaps(s.readAt)).toEqual([2_000, 4_000]);
    });
  });
});
