import { createAnalytics } from "../analytics.js";
import { FLUSH_INTERVAL_MS, MAX_BATCH_SIZE } from "../batch-queue.js";
import type { AnalyticsConfig } from "../types.js";
import {
  cleanAnalyticsEnv,
  createCapturingFetch,
  instanceTracker,
  useTempHome,
  type TempHome,
} from "./helpers.js";

describe("batching", () => {
  let home: TempHome;
  let restoreEnv: () => void;
  const tracker = instanceTracker();

  const baseConfig = (
    overrides: Partial<AnalyticsConfig> = {},
  ): AnalyticsConfig => ({
    source: "mcp",
    sdkName: "@sapiom/test",
    sdkVersion: "0.0.0",
    ...overrides,
  });

  beforeEach(() => {
    restoreEnv = cleanAnalyticsEnv();
    home = useTempHome();
  });

  afterEach(async () => {
    jest.useRealTimers();
    await tracker.shutdownAll();
    home.restore();
    restoreEnv();
  });

  it(`flushes immediately at ${MAX_BATCH_SIZE} events`, async () => {
    const capture = createCapturingFetch();
    const analytics = tracker.register(
      createAnalytics(baseConfig({ fetchImpl: capture.fetchImpl })),
    );

    for (let i = 0; i < MAX_BATCH_SIZE; i++) {
      analytics.track("event", { i });
    }
    await analytics.flush();

    expect(capture.calls).toHaveLength(1);
    expect(capture.batch()).toHaveLength(MAX_BATCH_SIZE);
  });

  it("splits overflow into the next batch", async () => {
    const capture = createCapturingFetch();
    const analytics = tracker.register(
      createAnalytics(baseConfig({ fetchImpl: capture.fetchImpl })),
    );

    for (let i = 0; i < MAX_BATCH_SIZE + 5; i++) {
      analytics.track("event", { i });
    }
    await analytics.flush();

    expect(capture.calls).toHaveLength(2);
    expect(capture.batch(0)).toHaveLength(MAX_BATCH_SIZE);
    expect(capture.batch(1)).toHaveLength(5);
  });

  it(`flushes on the ${FLUSH_INTERVAL_MS}ms timer`, async () => {
    jest.useFakeTimers();
    const capture = createCapturingFetch();
    const analytics = tracker.register(
      createAnalytics(baseConfig({ fetchImpl: capture.fetchImpl })),
    );

    analytics.track("event_a");
    analytics.track("event_b");
    expect(capture.calls).toHaveLength(0);

    await jest.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS - 1);
    expect(capture.calls).toHaveLength(0);

    await jest.advanceTimersByTimeAsync(1);
    expect(capture.calls).toHaveLength(1);
    expect(capture.batch()).toHaveLength(2);
  });

  it("does not call the collector when nothing was tracked", async () => {
    jest.useFakeTimers();
    const capture = createCapturingFetch();
    const analytics = tracker.register(
      createAnalytics(baseConfig({ fetchImpl: capture.fetchImpl })),
    );

    await jest.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS * 3);
    await analytics.flush();
    expect(capture.calls).toHaveLength(0);
  });

  it("flushes best-effort on beforeExit", async () => {
    const capture = createCapturingFetch();
    const analytics = tracker.register(
      createAnalytics(baseConfig({ fetchImpl: capture.fetchImpl })),
    );

    analytics.track("event");
    expect(capture.calls).toHaveLength(0);

    process.emit("beforeExit", 0);
    await analytics.flush(); // settle the in-flight send

    expect(capture.calls).toHaveLength(1);
  });

  it("stops flushing on beforeExit after shutdown (listener removed)", async () => {
    const capture = createCapturingFetch();
    const analytics = tracker.register(
      createAnalytics(baseConfig({ fetchImpl: capture.fetchImpl })),
    );

    const listenersBefore = process.listenerCount("beforeExit");
    analytics.track("event");
    await analytics.shutdown();
    expect(process.listenerCount("beforeExit")).toBe(listenersBefore - 1);

    analytics.track("late_event"); // no-op after shutdown
    process.emit("beforeExit", 0);
    await analytics.flush();

    expect(capture.calls).toHaveLength(1); // only the pre-shutdown flush
  });

  it("flush on an empty queue resolves; shutdown is idempotent", async () => {
    const analytics = tracker.register(
      createAnalytics(
        baseConfig({ fetchImpl: createCapturingFetch().fetchImpl }),
      ),
    );
    await expect(analytics.flush()).resolves.toBeUndefined();
    await expect(analytics.shutdown()).resolves.toBeUndefined();
    await expect(analytics.shutdown()).resolves.toBeUndefined();
  });
});
