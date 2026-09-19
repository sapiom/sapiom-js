/**
 * orchestrations.launch — dispatch-handle shape, slug URL, resume-token forwarding —
 * plus the resume-payload schema. Injects a fake fetch (no real network).
 */
import { createClient } from "../index.js";
import {
  AGENTS_RESULT_SIGNAL,
  AgentDispatchError,
  AgentResultSchemaError,
  agentResultSchema,
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
    const result = await handle.wait({ timeoutMs: 60 * 60_000, pollMs: 1 });

    expect(result).toMatchObject({
      executionId: "exec-9",
      status: "unknown",
      error: { code: "http", status: 503 },
    });
    expect(reads).toBe(5);
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

      const result = await handle.wait({ timeoutMs: 60_000, pollMs: 1 });

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

    const result = await handle.wait({ timeoutMs: 60_000, pollMs: 1 });

    expect(result).toEqual({
      executionId: "exec-9",
      status: "completed",
      output: { ok: true },
      error: null,
    });
    expect(reads).toBe(2);
  });
});
