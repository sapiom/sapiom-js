import { afterEach, describe, expect, it, vi } from "vitest";

import type { AnalyticsEvent, CollectorContext } from "../../shared/types.js";
import { CollectorBatcher } from "./batcher.js";

const testContext: CollectorContext = {
  harnessVersion: "0.0.1",
  os: "darwin",
  arch: "arm64",
  nodeVersion: "v20.0.0",
};

function makeEvent(eventId: string): AnalyticsEvent {
  return {
    eventId,
    seq: 1,
    ts: "2026-07-08T00:00:00.000Z",
    userId: null,
    tenantId: null,
    machineId: "machine-1",
    harnessSessionId: "session-1",
    agentSessionId: null,
    harness: "claude-code",
    type: "prompt.submitted",
    payload: { prompt: "hi" },
  };
}

function response(status: number): Response {
  return { ok: status >= 200 && status < 300, status } as Response;
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
      context: testContext,
      telemetryOptIn: false,
      collectorUrl: "http://localhost:9999",
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
      context: testContext,
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

  it("posts to <collectorUrl>/v1/harness/events with a full batch envelope", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(202));
    batcher = new CollectorBatcher({
      machineId: "m1",
      context: testContext,
      telemetryOptIn: true,
      collectorUrl: "http://localhost:9999",
      maxBatchSize: 2,
      flushIntervalMs: 60_000,
      fetchImpl,
    });

    batcher.enqueue(makeEvent("evt-1"));
    expect(fetchImpl).not.toHaveBeenCalled();
    batcher.enqueue(makeEvent("evt-2"));

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://localhost:9999/v1/harness/events");

    const body = JSON.parse(init.body as string);
    expect(body.machineId).toBe("m1");
    expect(body.schemaVersion).toBe(1);
    expect(typeof body.batchId).toBe("string");
    expect(body.context).toEqual(testContext);
    expect(body.events).toHaveLength(2);
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("sends Authorization only once an apiKey is set (anonymous by default)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(202));
    batcher = new CollectorBatcher({
      machineId: "m1",
      context: testContext,
      telemetryOptIn: true,
      collectorUrl: "http://localhost:9999",
      maxBatchSize: 1,
      flushIntervalMs: 60_000,
      fetchImpl,
    });

    batcher.setApiKey("sk-test-key");
    batcher.enqueue(makeEvent("evt-1"));

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const init = fetchImpl.mock.calls[0][1];
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-test-key");
  });

  it("strips a trailing slash from collectorUrl before appending the events path", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(202));
    batcher = new CollectorBatcher({
      machineId: "m1",
      context: testContext,
      telemetryOptIn: true,
      collectorUrl: "http://localhost:9999/",
      maxBatchSize: 1,
      flushIntervalMs: 60_000,
      fetchImpl,
    });

    batcher.enqueue(makeEvent("evt-1"));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    expect(fetchImpl.mock.calls[0][0]).toBe("http://localhost:9999/v1/harness/events");
  });

  it("drops a batch on 4xx without retrying", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(400));
    const onDebug = vi.fn();
    batcher = new CollectorBatcher({
      machineId: "m1",
      context: testContext,
      telemetryOptIn: true,
      collectorUrl: "http://localhost:9999",
      maxBatchSize: 1,
      flushIntervalMs: 60_000,
      fetchImpl,
      onDebug,
    });

    batcher.enqueue(makeEvent("evt-1"));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    // give any (incorrect) retry a chance to fire before asserting it didn't
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(onDebug).toHaveBeenCalledWith(expect.stringContaining("rejected with 400"));
  });

  it("retries on 5xx with backoff and drops after exhausting retries", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockResolvedValue(response(503));
    const onDebug = vi.fn();
    batcher = new CollectorBatcher({
      machineId: "m1",
      context: testContext,
      telemetryOptIn: true,
      collectorUrl: "http://localhost:9999",
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

  it("retries on a network error and succeeds if a later attempt goes through", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(response(202));
    batcher = new CollectorBatcher({
      machineId: "m1",
      context: testContext,
      telemetryOptIn: true,
      collectorUrl: "http://localhost:9999",
      maxBatchSize: 1,
      flushIntervalMs: 60_000,
      fetchImpl,
    });

    batcher.enqueue(makeEvent("evt-1"));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
  });

  it("flushes remaining events on close()", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(202));
    batcher = new CollectorBatcher({
      machineId: "m1",
      context: testContext,
      telemetryOptIn: true,
      collectorUrl: "http://localhost:9999",
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
    const fetchImpl = vi.fn().mockResolvedValue(response(202));
    batcher = new CollectorBatcher({
      machineId: "m1",
      context: testContext,
      telemetryOptIn: true,
      collectorUrl: "http://localhost:9999",
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
