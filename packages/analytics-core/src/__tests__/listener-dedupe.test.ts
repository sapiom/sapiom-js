/**
 * Tests for the module-level shared beforeExit listener.
 *
 * Each BatchQueue instance previously registered its own per-instance
 * beforeExit listener, causing MaxListenersExceededWarning when many
 * short-lived emitters were created. The fix consolidates them into a single
 * module-level listener backed by a registry Set.
 *
 * These tests verify:
 *  1. 50 sequential create/shutdown cycles → listenerCount grows by at most 1
 *     during the cycle and returns to baseline after all are shut down.
 *  2. 50 concurrent live instances → exactly baseline+1 listeners; the shared
 *     listener flushes every registered queue when beforeExit fires.
 */
import { createAnalytics } from "../analytics.js";
import type { AnalyticsConfig } from "../types.js";
import {
  cleanAnalyticsEnv,
  createCapturingFetch,
  useTempHome,
  type TempHome,
  type CapturingFetch,
} from "./helpers.js";

const CYCLE_COUNT = 50;

describe("shared beforeExit listener (listener-dedupe)", () => {
  let home: TempHome;
  let restoreEnv: () => void;

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

  afterEach(() => {
    home.restore();
    restoreEnv();
  });

  it(`${CYCLE_COUNT} sequential create/shutdown cycles: listenerCount grows by at most 1, returns to baseline`, async () => {
    const baseline = process.listenerCount("beforeExit");

    for (let i = 0; i < CYCLE_COUNT; i++) {
      const capture = createCapturingFetch();
      const analytics = createAnalytics(
        baseConfig({ fetchImpl: capture.fetchImpl }),
      );

      // During the cycle there should be at most one extra listener.
      const duringCount = process.listenerCount("beforeExit");
      expect(duringCount).toBeLessThanOrEqual(baseline + 1);

      await analytics.shutdown();
    }

    // After all instances are shut down the listener count must be at baseline.
    expect(process.listenerCount("beforeExit")).toBe(baseline);
  });

  it(`${CYCLE_COUNT} concurrent live instances: exactly baseline+1 listener; all queues flush on beforeExit`, async () => {
    const baseline = process.listenerCount("beforeExit");

    // Create 50 instances, each with their own capturing fetch.
    const captures: CapturingFetch[] = [];
    const instances: Awaited<ReturnType<typeof createAnalytics>>[] = [];

    for (let i = 0; i < CYCLE_COUNT; i++) {
      const capture = createCapturingFetch();
      captures.push(capture);
      const analytics = createAnalytics(
        baseConfig({ fetchImpl: capture.fetchImpl }),
      );
      analytics.track("event", { i });
      instances.push(analytics);
    }

    // All 50 instances are live: exactly one shared listener.
    expect(process.listenerCount("beforeExit")).toBe(baseline + 1);

    // Fire the exit event — the shared listener should flush all queues.
    process.emit("beforeExit", 0);

    // Settle all in-flight sends by flushing each instance.
    await Promise.all(instances.map((a) => a.flush()));

    // Every instance should have delivered its event.
    for (let i = 0; i < CYCLE_COUNT; i++) {
      expect(captures[i].calls.length).toBeGreaterThanOrEqual(1);
    }

    // Shut down all instances.
    await Promise.all(instances.map((a) => a.shutdown()));

    // Listener count must return to baseline.
    expect(process.listenerCount("beforeExit")).toBe(baseline);
  });
});
