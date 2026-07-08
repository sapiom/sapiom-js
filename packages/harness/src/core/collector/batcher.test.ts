import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AnalyticsEvent } from "../../shared/types.js";
import { CollectorBatcher } from "./batcher.js";

function makeEvent(eventId: string): AnalyticsEvent {
  return {
    eventId,
    ts: "2026-07-08T00:00:00.000Z",
    userId: null,
    machineId: "machine-1",
    harnessSessionId: "session-1",
    agentSessionId: null,
    harness: "claude-code",
    type: "prompt.submitted",
    payload: { prompt: "hi" },
  };
}

function okResponse(): Response {
  return { ok: true, status: 200 } as Response;
}

describe("CollectorBatcher", () => {
  let batcher: CollectorBatcher | null;

  afterEach(async () => {
    await batcher?.close();
    batcher = null;
    vi.useRealTimers();
  });

  it("is a no-op when telemetry is opted out", async () => {
    const fetchImpl = vi.fn();
    batcher = new CollectorBatcher({
      machineId: "m1",
      telemetryOptIn: false,
      collectorUrl: "http://localhost:9999/batch",
      fetchImpl,
    });

    batcher.enqueue(makeEvent("evt-1"));
    await batcher.flush();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("is a no-op when no collector URL is configured", async () => {
    const fetchImpl = vi.fn();
    const onDebug = vi.fn();
    batcher = new CollectorBatcher({
      machineId: "m1",
      telemetryOptIn: true,
      collectorUrl: undefined,
      fetchImpl,
      onDebug,
    });

    batcher.enqueue(makeEvent("evt-1"));
    await batcher.flush();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(onDebug).toHaveBeenCalledWith(expect.stringContaining("not set"));
  });

  it("flushes immediately once maxBatchSize is reached", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    batcher = new CollectorBatcher({
      machineId: "m1",
      telemetryOptIn: true,
      collectorUrl: "http://localhost:9999/batch",
      maxBatchSize: 2,
      flushIntervalMs: 60_000,
      fetchImpl,
    });

    batcher.enqueue(makeEvent("evt-1"));
    expect(fetchImpl).not.toHaveBeenCalled();
    batcher.enqueue(makeEvent("evt-2"));

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const [, init] = fetchImpl.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.machineId).toBe("m1");
    expect(body.events).toHaveLength(2);
  });

  it("retries with backoff and drops the batch after exhausting retries", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    const onDebug = vi.fn();
    batcher = new CollectorBatcher({
      machineId: "m1",
      telemetryOptIn: true,
      collectorUrl: "http://localhost:9999/batch",
      maxBatchSize: 1,
      flushIntervalMs: 60_000,
      fetchImpl,
      onDebug,
    });

    batcher.enqueue(makeEvent("evt-1"));
    // 1 initial attempt + 3 retries = 4 total fetch calls.
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5000);
    }

    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(onDebug).toHaveBeenCalledWith(expect.stringContaining("dropping batch"));
  });

  it("flushes remaining events on close()", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    batcher = new CollectorBatcher({
      machineId: "m1",
      telemetryOptIn: true,
      collectorUrl: "http://localhost:9999/batch",
      maxBatchSize: 50,
      flushIntervalMs: 60_000,
      fetchImpl,
    });

    batcher.enqueue(makeEvent("evt-1"));
    batcher.enqueue(makeEvent("evt-2"));
    expect(fetchImpl).not.toHaveBeenCalled();

    await batcher.close();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("drops the queue immediately when opting out mid-flight", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    batcher = new CollectorBatcher({
      machineId: "m1",
      telemetryOptIn: true,
      collectorUrl: "http://localhost:9999/batch",
      maxBatchSize: 50,
      flushIntervalMs: 60_000,
      fetchImpl,
    });

    batcher.enqueue(makeEvent("evt-1"));
    batcher.setTelemetryOptIn(false);
    await batcher.close();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
