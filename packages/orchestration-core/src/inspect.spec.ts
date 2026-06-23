/**
 * waitForExecution — the bounded poll loop the inspect tool uses so callers
 * never hand-roll a sleep loop. Uses injected sleep/now for determinism.
 */
import type { GatewayClient } from "./client.js";
import {
  isExecutionTerminal,
  waitForExecution,
  type ExecutionDetail,
} from "./inspect.js";

/** A GatewayClient whose `get` returns the queued snapshots (last one repeats). */
function fakeClient(snapshots: Partial<ExecutionDetail>[]): {
  client: GatewayClient;
  calls: () => number;
} {
  let i = 0;
  const client = {
    get: async () => {
      const snap = snapshots[Math.min(i, snapshots.length - 1)];
      i += 1;
      return { id: "e1", status: "running", ...snap } as ExecutionDetail;
    },
  } as unknown as GatewayClient;
  return { client, calls: () => i };
}

const noopSleep = () => Promise.resolve();

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
