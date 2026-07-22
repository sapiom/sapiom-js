import { describe, it, expect, vi } from "vitest";

import { createSpineClient } from "./spine-client.js";
import type { SpineFrame } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockResponse {
  status: number;
  body: unknown;
}

function res(status: number, body: unknown): MockResponse {
  return { status, body };
}

/**
 * A fetch mock that answers the START POST (`/v1/workflows/executions`) with
 * `startRes`, and each subsequent poll GET (`/agents/v1/executions/:id`) with
 * the next entry from `pollResponses` (repeating the last once exhausted).
 */
function makeFetch(
  startRes: MockResponse,
  pollResponses: MockResponse[],
): { fetchImpl: typeof fetch; calls: () => { url: string; init?: RequestInit }[] } {
  const recorded: { url: string; init?: RequestInit }[] = [];
  let pollIdx = 0;
  const fetchImpl = vi
    .fn()
    .mockImplementation((url: string, init?: RequestInit) => {
      recorded.push({ url, init });
      const isStart = init?.method === "POST";
      const picked = isStart
        ? startRes
        : (pollResponses[Math.min(pollIdx++, pollResponses.length - 1)] ??
          res(404, { error: "not found" }));
      return Promise.resolve({
        status: picked.status,
        ok: picked.status >= 200 && picked.status < 300,
        json: () => Promise.resolve(picked.body),
      } as Response);
    });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls: () => recorded };
}

/** A raw execution projection with a single step at the given status. */
function projection(runStatus: string, stepStatus: string) {
  return {
    id: "exec_1",
    name: "explain-agent",
    status: runStatus,
    currentStep: null,
    startedAt: "2026-07-01T10:00:00.000Z",
    finishedAt: runStatus === "running" ? null : "2026-07-01T10:00:05.000Z",
    steps: [
      {
        id: "step_0",
        stepName: "explain",
        stepOrder: 0,
        attempt: 1,
        status: stepStatus,
        spanId: "span_explain",
        startedAt: "2026-07-01T10:00:00.000Z",
        finishedAt: stepStatus === "running" ? null : "2026-07-01T10:00:05.000Z",
        logs: [],
        error: null,
      },
    ],
  };
}

const baseOpts = {
  coreBaseUrl: "https://core.test",
  agentsBaseUrl: "https://agents.test",
  // No real waiting between polls.
  sleep: () => Promise.resolve(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSpineClient", () => {
  it("starts a run on our account and streams a frame per step transition", async () => {
    const { fetchImpl, calls } = makeFetch(
      res(200, { status: "enqueued", executionId: "exec_1" }),
      [
        res(200, projection("running", "running")),
        res(200, projection("completed", "succeeded")),
      ],
    );
    const frames: SpineFrame[] = [];
    const onStarted = vi.fn();
    const onFinished = vi.fn();

    const client = createSpineClient({
      apiKey: "sk-test",
      fetchImpl,
      ...baseOpts,
    });
    const result = await client.run(
      "def-explain",
      { agentId: "42" },
      { onStarted, onFrame: (f) => frames.push(f), onFinished },
    );

    expect(result).toEqual({
      ok: true,
      executionId: "exec_1",
      status: "completed",
    });
    expect(onStarted).toHaveBeenCalledWith("exec_1");
    expect(onFinished).toHaveBeenCalledWith("exec_1", "completed");

    // One frame for `running`, one for the `passed` transition — not re-emitted.
    expect(frames.map((f) => f.step.status)).toEqual(["running", "passed"]);
    expect(frames[0].step.name).toBe("explain");

    // START hit the CORE surface with the key and the definition/input body.
    const start = calls()[0];
    expect(start.url).toBe("https://core.test/v1/workflows/executions");
    expect(start.init?.method).toBe("POST");
    expect(
      (start.init?.headers as Record<string, string>)["x-api-key"],
    ).toBe("sk-test");
    expect(JSON.parse(start.init?.body as string)).toEqual({
      definitionId: "def-explain",
      input: { agentId: "42" },
    });

    // POLL hit the AGENTS surface for the enqueued execution.
    expect(calls()[1].url).toBe(
      "https://agents.test/agents/v1/executions/exec_1",
    );
  });

  it("returns 503 and never touches the network without an API key", async () => {
    const spy = vi.fn();
    const onError = vi.fn();
    const client = createSpineClient({
      apiKey: null,
      fetchImpl: spy as unknown as typeof fetch,
      ...baseOpts,
    });

    const result = await client.run("def", {}, { onError });

    expect(result).toEqual({
      ok: false,
      status: 503,
      error: "harness is not signed in to Sapiom",
    });
    expect(onError).toHaveBeenCalledWith("harness is not signed in to Sapiom");
    expect(spy).not.toHaveBeenCalled();
  });

  it("surfaces a start failure without polling", async () => {
    const { fetchImpl, calls } = makeFetch(res(500, { error: "boom" }), [
      res(200, projection("completed", "succeeded")),
    ]);
    const onError = vi.fn();

    const client = createSpineClient({ apiKey: "sk", fetchImpl, ...baseOpts });
    const result = await client.run("def", {}, { onError });

    expect(result).toEqual({
      ok: false,
      status: 502,
      error: "gateway responded 500",
    });
    expect(onError).toHaveBeenCalledWith("gateway responded 500");
    // Only the start call — no poll after a failed start.
    expect(calls()).toHaveLength(1);
  });

  it("keeps polling through a 404 projection until it materializes", async () => {
    const { fetchImpl } = makeFetch(
      res(200, { status: "enqueued", executionId: "exec_1" }),
      [
        res(404, { error: "not found" }), // projection lags the enqueue
        res(200, projection("completed", "succeeded")),
      ],
    );
    const frames: SpineFrame[] = [];

    const client = createSpineClient({ apiKey: "sk", fetchImpl, ...baseOpts });
    const result = await client.run(
      "def",
      {},
      { onFrame: (f) => frames.push(f) },
    );

    expect(result.ok).toBe(true);
    expect(frames.map((f) => f.step.status)).toEqual(["passed"]);
  });

  it("times out a run that never leaves running", async () => {
    const { fetchImpl } = makeFetch(
      res(200, { status: "enqueued", executionId: "exec_1" }),
      [res(200, projection("running", "running"))],
    );
    const onError = vi.fn();
    // Clock jumps past the 10ms budget on the second read.
    let t = 0;
    const now = (): number => (t += 20);

    const client = createSpineClient({
      apiKey: "sk",
      fetchImpl,
      ...baseOpts,
      timeoutMs: 10,
      now,
    });
    const result = await client.run("def", {}, { onError });

    expect(result).toEqual({
      ok: false,
      status: 504,
      error: "timed out waiting for the run to finish",
    });
    expect(onError).toHaveBeenCalledWith(
      "timed out waiting for the run to finish",
    );
  });
});
