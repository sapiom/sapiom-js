/**
 * Unit tests for `createRunPollController`.
 *
 * All tests run under vitest with fake timers (node environment — DOM-free).
 * `vi.advanceTimersByTimeAsync` is used throughout so that microtasks flush
 * after each timer advance, matching the async-resolved fetch promises.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunSpend, RunView } from "@shared/types";
import { createRunPollController } from "./run-poll-controller";
import type { RunPollDeps } from "./run-poll-controller";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRunView(
  status: RunView["status"],
  executionId = "exec-1",
): RunView {
  return {
    executionId,
    status,
    steps: [],
  };
}

function makeRunSpend(executionId = "exec-1"): RunSpend {
  return {
    executionId,
    totalUsd: "1.23",
    settleState: "final",
    byStep: [],
  };
}

const POLL_MS = 100;

function setup(fetchImpl: RunPollDeps["fetchRunState"]) {
  const onUpdate = vi.fn<(executionId: string, runView: RunView) => void>();
  const controller = createRunPollController({
    fetchRunState: fetchImpl,
    onUpdate,
    pollMs: POLL_MS,
  });
  return { controller, onUpdate };
}

function setupWithSpend(
  fetchImpl: RunPollDeps["fetchRunState"],
  fetchSpend: NonNullable<RunPollDeps["fetchSpend"]>,
  spendSettleCycles = 3,
) {
  const onUpdate = vi.fn<(executionId: string, runView: RunView) => void>();
  const onSpend = vi.fn<(executionId: string, spend: RunSpend) => void>();
  const controller = createRunPollController({
    fetchRunState: fetchImpl,
    onUpdate,
    pollMs: POLL_MS,
    fetchSpend,
    onSpend,
    spendSettleCycles,
  });
  return { controller, onUpdate, onSpend };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("createRunPollController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts polling on start: immediate fetch triggers onUpdate once", async () => {
    const fetch = vi
      .fn<(id: string, signal: AbortSignal) => Promise<RunView>>()
      .mockResolvedValue(makeRunView("running"));
    const { controller, onUpdate } = setup(fetch);

    controller.start("exec-1");
    // Let the immediate poll's promise resolve.
    await vi.advanceTimersByTimeAsync(0);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith("exec-1", makeRunView("running"));

    controller.stopAll();
  });

  it("polls on the interval: onUpdate is called 3 times total after two ticks", async () => {
    const fetch = vi
      .fn<(id: string, signal: AbortSignal) => Promise<RunView>>()
      .mockResolvedValue(makeRunView("running"));
    const { controller, onUpdate } = setup(fetch);

    controller.start("exec-1");
    // Immediate fetch.
    await vi.advanceTimersByTimeAsync(0);
    // First interval tick.
    await vi.advanceTimersByTimeAsync(POLL_MS);
    // Second interval tick.
    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(onUpdate).toHaveBeenCalledTimes(3);

    controller.stopAll();
  });

  it("stops on terminal status: no further fetches after completed", async () => {
    let callCount = 0;
    const fetch = vi
      .fn<(id: string, signal: AbortSignal) => Promise<RunView>>()
      .mockImplementation(() => {
        callCount++;
        const status: RunView["status"] =
          callCount === 1 ? "running" : "completed";
        return Promise.resolve(makeRunView(status));
      });
    const { controller, onUpdate } = setup(fetch);

    controller.start("exec-1");
    // Immediate fetch → "running".
    await vi.advanceTimersByTimeAsync(0);
    // First tick → "completed" (triggers stop).
    await vi.advanceTimersByTimeAsync(POLL_MS);

    const countAfterTerminal = fetch.mock.calls.length;
    expect(countAfterTerminal).toBe(2);

    // Advance more time — no new fetches should fire.
    await vi.advanceTimersByTimeAsync(POLL_MS * 5);

    expect(fetch.mock.calls.length).toBe(2);
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect((onUpdate.mock.calls[1] as unknown[])[1]).toMatchObject({
      status: "completed",
    });
  });

  it("pause/resume: setPaused(true) suppresses fetches; setPaused(false) resumes them", async () => {
    const fetch = vi
      .fn<(id: string, signal: AbortSignal) => Promise<RunView>>()
      .mockResolvedValue(makeRunView("running"));
    const { controller, onUpdate } = setup(fetch);

    controller.start("exec-1");
    // Immediate fetch before pausing.
    await vi.advanceTimersByTimeAsync(0);

    controller.setPaused(true);

    // Advance two ticks — should NOT fetch while paused.
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledTimes(1);

    controller.setPaused(false);

    // Next tick after resuming should fetch again.
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(onUpdate).toHaveBeenCalledTimes(2);

    controller.stopAll();
  });

  it("idempotent start: calling start twice does not double the interval", async () => {
    const fetch = vi
      .fn<(id: string, signal: AbortSignal) => Promise<RunView>>()
      .mockResolvedValue(makeRunView("running"));
    const { controller, onUpdate } = setup(fetch);

    controller.start("exec-1");
    controller.start("exec-1"); // second call — should be no-op

    // Immediate fetch.
    await vi.advanceTimersByTimeAsync(0);

    // The immediate poll runs exactly once despite start being called twice.
    expect(fetch).toHaveBeenCalledTimes(1);

    // Advance one tick — exactly one more fetch (not two).
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(onUpdate).toHaveBeenCalledTimes(2);

    controller.stopAll();
  });

  it("stopAll aborts in-flight: the in-flight signal is aborted after stopAll", async () => {
    let capturedSignal: AbortSignal | null = null;

    // A fetch that never resolves — we just capture the signal.
    const fetch = vi
      .fn<(id: string, signal: AbortSignal) => Promise<RunView>>()
      .mockImplementation((_id, signal) => {
        capturedSignal = signal;
        return new Promise<RunView>(() => {
          // intentionally never resolves
        });
      });
    const { controller } = setup(fetch);

    controller.start("exec-1");
    // Trigger the immediate fetch so the signal is captured.
    await vi.advanceTimersByTimeAsync(0);

    expect(capturedSignal).not.toBeNull();
    expect((capturedSignal as unknown as AbortSignal).aborted).toBe(false);

    controller.stopAll();

    expect((capturedSignal as unknown as AbortSignal).aborted).toBe(true);
  });

  it("no overlap: a second tick does not start a new fetch while one is in flight", async () => {
    let resolveFirst!: (v: RunView) => void;

    const fetch = vi
      .fn<(id: string, signal: AbortSignal) => Promise<RunView>>()
      .mockImplementationOnce(
        () =>
          new Promise<RunView>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue(makeRunView("running"));

    const { controller, onUpdate } = setup(fetch);

    controller.start("exec-1");
    // Immediate fetch is in flight (never resolved yet).
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);

    // Advance one tick — still in flight, so the interval should not start a second fetch.
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(fetch).toHaveBeenCalledTimes(1);

    // Now resolve the first fetch.
    resolveFirst(makeRunView("running"));
    await vi.advanceTimersByTimeAsync(0);
    expect(onUpdate).toHaveBeenCalledTimes(1);

    // The next interval tick should now fire normally.
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(fetch).toHaveBeenCalledTimes(2);

    controller.stopAll();
  });

  it("gives up after too many consecutive failures (a bad/404 id can't poll forever)", async () => {
    const fetch = vi
      .fn<(id: string, signal: AbortSignal) => Promise<RunView>>()
      .mockRejectedValue(new Error("404"));
    const { controller, onUpdate } = setup(fetch);

    controller.start("exec-bad");
    // Immediate fetch = failure #1, then drive far past the cap.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(POLL_MS * 20);

    // MAX_CONSECUTIVE_FAILURES is 5 → it stops after the 5th failure, forever.
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("a successful read resets the failure streak (intermittent errors don't trip the cap)", async () => {
    let n = 0;
    const fetch = vi
      .fn<(id: string, signal: AbortSignal) => Promise<RunView>>()
      .mockImplementation(() => {
        n += 1;
        // Fail 4×, succeed on the 5th (resets streak), then fail forever.
        if (n === 5) return Promise.resolve(makeRunView("running"));
        return Promise.reject(new Error("transient"));
      });
    const { controller } = setup(fetch);

    controller.start("exec-1");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(POLL_MS * 20);

    // The success at call 5 resets the streak, so it survives past 5 and only
    // stops after 5 MORE consecutive fails (calls 6–10) → 10 total.
    expect(fetch).toHaveBeenCalledTimes(10);

    controller.stopAll();
  });

  // -------------------------------------------------------------------------
  // Spend polling tests
  // -------------------------------------------------------------------------

  it("spend is fetched alongside run-state on each tick when fetchSpend is provided", async () => {
    const fetchState = vi
      .fn<(id: string, signal: AbortSignal) => Promise<RunView>>()
      .mockResolvedValue(makeRunView("running"));
    const fetchSpend = vi
      .fn<(id: string, signal: AbortSignal) => Promise<RunSpend>>()
      .mockResolvedValue(makeRunSpend());
    const { controller, onUpdate, onSpend } = setupWithSpend(
      fetchState,
      fetchSpend,
    );

    controller.start("exec-1");
    // Immediate fetch.
    await vi.advanceTimersByTimeAsync(0);
    // One interval tick.
    await vi.advanceTimersByTimeAsync(POLL_MS);

    // Both run-state and spend fetched on each of the 2 ticks.
    expect(fetchState).toHaveBeenCalledTimes(2);
    expect(fetchSpend).toHaveBeenCalledTimes(2);
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onSpend).toHaveBeenCalledTimes(2);
    expect(onSpend).toHaveBeenCalledWith("exec-1", makeRunSpend());

    controller.stopAll();
  });

  it("spend continues for N settle cycles after terminal status then stops everything", async () => {
    let stateCallCount = 0;
    const fetchState = vi
      .fn<(id: string, signal: AbortSignal) => Promise<RunView>>()
      .mockImplementation(() => {
        stateCallCount++;
        // First call: running; second call: completed (terminal).
        return Promise.resolve(
          makeRunView(stateCallCount === 1 ? "running" : "completed"),
        );
      });
    const fetchSpend = vi
      .fn<(id: string, signal: AbortSignal) => Promise<RunSpend>>()
      .mockResolvedValue(makeRunSpend());

    // Use 2 settle cycles for a quick test.
    const { controller, onSpend } = setupWithSpend(fetchState, fetchSpend, 2);

    controller.start("exec-1");
    // Immediate fetch → running + spend.
    await vi.advanceTimersByTimeAsync(0);
    // Tick 2 → completed + spend (triggers settle mode).
    await vi.advanceTimersByTimeAsync(POLL_MS);
    // Settle tick 1.
    await vi.advanceTimersByTimeAsync(POLL_MS);
    // Settle tick 2.
    await vi.advanceTimersByTimeAsync(POLL_MS);
    // No more ticks — should be fully stopped.
    await vi.advanceTimersByTimeAsync(POLL_MS * 10);

    // run-state called exactly twice (running + completed), not during settle.
    expect(fetchState).toHaveBeenCalledTimes(2);

    // spend called: tick1 + tick2 + 2 settle cycles = 4 total.
    expect(fetchSpend).toHaveBeenCalledTimes(4);
    expect(onSpend).toHaveBeenCalledTimes(4);
  });

  it("a spend error does not stop run-state polling", async () => {
    const fetchState = vi
      .fn<(id: string, signal: AbortSignal) => Promise<RunView>>()
      .mockResolvedValue(makeRunView("running"));
    // fetchSpend always throws.
    const fetchSpend = vi
      .fn<(id: string, signal: AbortSignal) => Promise<RunSpend>>()
      .mockRejectedValue(new Error("spend unavailable"));
    const { controller, onUpdate, onSpend } = setupWithSpend(
      fetchState,
      fetchSpend,
    );

    controller.start("exec-1");
    // Immediate fetch.
    await vi.advanceTimersByTimeAsync(0);
    // Three more ticks.
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);

    // run-state keeps polling normally despite spend failures.
    expect(fetchState).toHaveBeenCalledTimes(4);
    expect(onUpdate).toHaveBeenCalledTimes(4);

    // onSpend is never called (all errors swallowed).
    expect(onSpend).not.toHaveBeenCalled();

    controller.stopAll();
  });
});
