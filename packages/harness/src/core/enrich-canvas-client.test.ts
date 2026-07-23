import { describe, expect, it, vi } from "vitest";

import { createEnrichCanvasClient } from "./enrich-canvas-client.js";

// ---------------------------------------------------------------------------
// fetch fake — branches the START POST vs the poll GET, records every call.
// ---------------------------------------------------------------------------

interface MockResponse {
  status: number;
  body: unknown;
}
function res(status: number, body: unknown): MockResponse {
  return { status, body };
}

/** A raw execution-projection doc as the agents surface returns it. `output`
 *  is only populated on a completed run — the field the client reads. */
function projection(status: string, output: unknown = null): Record<string, unknown> {
  return { id: "exec_1", status, output, steps: [] };
}

function makeFetch(startRes: MockResponse, pollResponses: MockResponse[]) {
  const recorded: { url: string; init?: RequestInit }[] = [];
  let pollIdx = 0;
  const fetchImpl = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    recorded.push({ url, init });
    const isStart = init?.method === "POST";
    const picked = isStart
      ? startRes
      : (pollResponses[Math.min(pollIdx++, pollResponses.length - 1)] ?? res(404, { error: "not found" }));
    return Promise.resolve({
      status: picked.status,
      ok: picked.status >= 200 && picked.status < 300,
      json: () => Promise.resolve(picked.body),
    } as Response);
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls: () => recorded };
}

const baseOpts = {
  coreBaseUrl: "https://core.test",
  agentsBaseUrl: "https://agents.test",
  sleep: () => Promise.resolve(),
};

describe("createEnrichCanvasClient", () => {
  it("starts the run on our account and returns the completed run's output", async () => {
    const { fetchImpl, calls } = makeFetch(res(200, { executionId: "exec_1" }), [
      res(200, projection("running")),
      res(200, projection("completed", { summary: "routes orders" })),
    ]);
    const client = createEnrichCanvasClient({ apiKey: "sk", fetchImpl, ...baseOpts });

    const result = await client.run("def_enrich", { graph: { nodes: [] }, stepBodies: {} });

    expect(result).toEqual({ ok: true, executionId: "exec_1", output: { summary: "routes orders" } });

    const start = calls()[0];
    expect(start.url).toBe("https://core.test/v1/workflows/executions");
    expect(start.init?.method).toBe("POST");
    expect((start.init?.headers as Record<string, string>)["x-api-key"]).toBe("sk");
    expect(JSON.parse(start.init?.body as string)).toEqual({
      definitionId: "def_enrich",
      input: { graph: { nodes: [] }, stepBodies: {} },
    });

    const poll = calls()[1];
    expect(poll.url).toBe("https://agents.test/agents/v1/executions/exec_1");
    expect((poll.init?.headers as Record<string, string>)["x-sapiom-api-key"]).toBe("sk");
  });

  it("returns 503 and never touches the network without an API key", async () => {
    const fetchImpl = vi.fn();
    const client = createEnrichCanvasClient({
      apiKey: null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...baseOpts,
    });

    const result = await client.run("def_enrich", {});

    expect(result).toEqual({ ok: false, status: 503, error: "harness is not signed in to Sapiom" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("surfaces a start failure without polling", async () => {
    const { fetchImpl, calls } = makeFetch(res(500, { error: "boom" }), [res(200, projection("completed"))]);
    const client = createEnrichCanvasClient({ apiKey: "sk", fetchImpl, ...baseOpts });

    const result = await client.run("def_enrich", {});

    expect(result).toEqual({ ok: false, status: 502, error: "gateway responded 500" });
    expect(calls()).toHaveLength(1); // no poll
  });

  it("keeps polling through a 404 projection until it materializes", async () => {
    const { fetchImpl } = makeFetch(res(200, { executionId: "exec_1" }), [
      res(404, { error: "not found" }),
      res(200, projection("completed", { summary: "hi" })),
    ]);
    const client = createEnrichCanvasClient({ apiKey: "sk", fetchImpl, ...baseOpts });

    const result = await client.run("def_enrich", {});

    expect(result).toEqual({ ok: true, executionId: "exec_1", output: { summary: "hi" } });
  });

  it("reports a non-completed terminal run as a typed failure", async () => {
    const { fetchImpl } = makeFetch(res(200, { executionId: "exec_1" }), [res(200, projection("failed"))]);
    const client = createEnrichCanvasClient({ apiKey: "sk", fetchImpl, ...baseOpts });

    const result = await client.run("def_enrich", {});

    expect(result).toEqual({ ok: false, status: 502, error: "enrich-canvas run ended failed" });
  });

  it("times out a run that never leaves running", async () => {
    const { fetchImpl } = makeFetch(res(200, { executionId: "exec_1" }), [res(200, projection("running"))]);
    let t = 0;
    const now = (): number => (t += 20); // jumps past the 10ms budget on the 2nd read
    const client = createEnrichCanvasClient({ apiKey: "sk", fetchImpl, ...baseOpts, timeoutMs: 10, now });

    const result = await client.run("def_enrich", {});

    expect(result).toEqual({ ok: false, status: 504, error: "timed out waiting for the run to finish" });
  });
});
