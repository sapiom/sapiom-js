/**
 * waitForExecution — the bounded poll loop the inspect tool uses so callers
 * never hand-roll a sleep loop. Uses injected sleep/now for determinism.
 */
import type { GatewayClient } from "./client.js";
import { isExecutionTerminal, waitForExecution } from "./inspect.js";
import type { ExecutionProjection, SseEvent } from "./types.js";

/** A GatewayClient whose `get` returns the queued snapshots (last one repeats). */
function fakeClient(snapshots: Partial<ExecutionProjection>[]): {
  client: GatewayClient;
  calls: () => number;
} {
  let i = 0;
  const client = {
    get: async () => {
      const snap = snapshots[Math.min(i, snapshots.length - 1)];
      i += 1;
      return { id: "e1", status: "running", ...snap };
    },
  } as unknown as GatewayClient;
  return { client, calls: () => i };
}

const noopSleep = () => Promise.resolve();

/** A `watch` that yields the given events then completes. */
function fakeWatch(events: SseEvent[]): NonNullable<
  Parameters<typeof waitForExecution>[0]["watch"]
> {
  return async function* () {
    for (const ev of events) yield ev;
  };
}

const EV: SseEvent = {
  type: "step.captured",
  executionId: "e1",
  traceRoot: null,
  nodeId: "s1",
};

describe("isExecutionTerminal", () => {
  it("treats completed/failed as terminal and running/paused as not", () => {
    expect(isExecutionTerminal("completed")).toBe(true);
    expect(isExecutionTerminal("failed")).toBe(true);
    expect(isExecutionTerminal("running")).toBe(false);
    expect(isExecutionTerminal("paused")).toBe(false);
  });
});

describe("waitForExecution", () => {
  it("polls until a terminal status, then resolves done", async () => {
    const { client, calls } = fakeClient([
      { status: "running" },
      { status: "running" },
      { status: "completed" },
    ]);

    const res = await waitForExecution(
      { executionId: "e1", sleep: noopSleep, now: () => 0 },
      client,
    );

    expect(res.reason).toBe("terminal");
    expect(res.done).toBe(true);
    expect(res.execution.status).toBe("completed");
    expect(calls()).toBe(3);
  });

  it("keeps waiting through an auto-resuming (coding) pause", async () => {
    const { client } = fakeClient([
      { status: "paused", pausedSignalName: "agent.coding.result" },
      { status: "completed" },
    ]);

    const res = await waitForExecution(
      { executionId: "e1", sleep: noopSleep, now: () => 0 },
      client,
    );

    expect(res.reason).toBe("terminal");
    expect(res.done).toBe(true);
  });

  it("keeps waiting through a video generation pause (auto-resume signal)", async () => {
    const { client } = fakeClient([
      { status: "paused", pausedSignalName: "contentGeneration.video.result" },
      { status: "completed" },
    ]);

    const res = await waitForExecution(
      { executionId: "e1", sleep: noopSleep, now: () => 0 },
      client,
    );

    expect(res.reason).toBe("terminal");
    expect(res.done).toBe(true);
  });

  it("returns needs-signal on a pause that won't auto-resume", async () => {
    const { client, calls } = fakeClient([
      { status: "paused", pausedSignalName: "await-approval" },
    ]);

    const res = await waitForExecution(
      { executionId: "e1", sleep: noopSleep, now: () => 0 },
      client,
    );

    expect(res.reason).toBe("needs-signal");
    expect(res.done).toBe(false);
    expect(calls()).toBe(1); // returns immediately, no further polling
  });

  it("wakes on SSE events and refetches until terminal (live path)", async () => {
    const { client, calls } = fakeClient([
      { status: "running" }, // initial read
      { status: "running" }, // after event 1
      { status: "completed" }, // after event 2
    ]);

    const res = await waitForExecution(
      {
        executionId: "e1",
        sleep: noopSleep,
        now: () => 0,
        watch: fakeWatch([EV, EV]),
      },
      client,
    );

    expect(res.reason).toBe("terminal");
    expect(res.done).toBe(true);
    // Initial read + one refetch per event; no poll sleeps were needed.
    expect(calls()).toBe(3);
  });

  it("tears down the SSE iterator once the run settles", async () => {
    const { client } = fakeClient([{ status: "running" }, { status: "completed" }]);
    let torn = false;
    // An infinite stream: only the consumer returning early can end it.
    const watch: NonNullable<Parameters<typeof waitForExecution>[0]["watch"]> =
      async function* () {
        try {
          for (;;) yield EV;
        } finally {
          torn = true;
        }
      };

    const res = await waitForExecution(
      { executionId: "e1", sleep: noopSleep, now: () => 0, watch },
      client,
    );

    expect(res.reason).toBe("terminal");
    expect(torn).toBe(true);
  });

  it("reverts to polling when the SSE watch throws (SSE drop)", async () => {
    const { client, calls } = fakeClient([
      { status: "running" }, // initial read
      { status: "completed" }, // poll-fallback read
    ]);
    const watch: NonNullable<Parameters<typeof waitForExecution>[0]["watch"]> =
      // eslint-disable-next-line require-yield
      async function* () {
        throw new Error("SSE connection dropped");
      };

    const res = await waitForExecution(
      { executionId: "e1", sleep: noopSleep, now: () => 0, watch },
      client,
    );

    expect(res.reason).toBe("terminal");
    expect(res.done).toBe(true);
    expect(calls()).toBe(2);
  });

  it("reverts to polling when the SSE stream ends without settling", async () => {
    const { client, calls } = fakeClient([
      { status: "running" }, // initial read
      { status: "completed" }, // poll-fallback read
    ]);

    const res = await waitForExecution(
      { executionId: "e1", sleep: noopSleep, now: () => 0, watch: fakeWatch([]) },
      client,
    );

    expect(res.reason).toBe("terminal");
    expect(res.done).toBe(true);
    expect(calls()).toBe(2);
  });

  it("returns timeout (not done) when the budget elapses before terminal", async () => {
    const { client } = fakeClient([{ status: "running" }]);
    // now() advances 600ms per call; with a 1000ms budget the deadline passes
    // after the first sleep.
    let t = 0;
    const now = () => {
      const v = t;
      t += 600;
      return v;
    };

    const res = await waitForExecution(
      { executionId: "e1", maxWaitMs: 1000, sleep: noopSleep, now },
      client,
    );

    expect(res.reason).toBe("timeout");
    expect(res.done).toBe(false);
    expect(res.execution.status).toBe("running");
  });
});
