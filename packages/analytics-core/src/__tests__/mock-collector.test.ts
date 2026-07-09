/**
 * Exercises the `@sapiom/analytics-core/testing` mock collector the way a
 * downstream package's tests would: a real emitter pointed at the mock's
 * URL, delivering over real HTTP with the native `fetch`.
 */
import { createAnalytics } from "../analytics.js";
import { startMockCollector, type MockCollector } from "../testing/index.js";
import type { AnalyticsConfig } from "../types.js";
import {
  cleanAnalyticsEnv,
  instanceTracker,
  useTempHome,
  type TempHome,
} from "./helpers.js";

describe("mock collector (testing subpath)", () => {
  let home: TempHome;
  let restoreEnv: () => void;
  let collector: MockCollector;
  let stderrSpy: jest.SpyInstance;
  const tracker = instanceTracker();

  const baseConfig = (
    overrides: Partial<AnalyticsConfig> = {},
  ): AnalyticsConfig => ({
    source: "tools",
    sdkName: "@sapiom/tools",
    sdkVersion: "1.2.3",
    endpoint: collector.url,
    ...overrides,
  });

  beforeEach(async () => {
    restoreEnv = cleanAnalyticsEnv();
    home = useTempHome();
    collector = await startMockCollector();
    // Keep the first-run notice out of the test output.
    stderrSpy = jest
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
  });

  afterEach(async () => {
    stderrSpy.mockRestore();
    await tracker.shutdownAll();
    await collector.close();
    home.restore();
    restoreEnv();
  });

  it("captures envelopes end-to-end over real HTTP", async () => {
    const analytics = tracker.register(
      createAnalytics(baseConfig({ apiKey: "sk-test-123" })),
    );

    analytics.track("capability.call", { capability: "search" });
    analytics.track("capability.call", { capability: "scrape" });
    await analytics.flush();

    expect(collector.requests).toHaveLength(1);
    expect(collector.requests[0].method).toBe("POST");
    expect(collector.requests[0].path).toBe("/v1/analytics/collector");
    expect(collector.requests[0].headers["content-type"]).toBe(
      "application/json",
    );
    expect(collector.requests[0].headers["x-sapiom-api-key"]).toBe(
      "sk-test-123",
    );

    const events = collector.events();
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.data.capability)).toEqual([
      "search",
      "scrape",
    ]);
    expect(events[0].source).toBe("tools");
    expect(events[0].anonymous_id).toBe(analytics.anonymousId);
  });

  it("answers healthy requests with contract-shaped responses", async () => {
    const accepted = await fetch(collector.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: [{ event_type: "e1" }, {}] }),
    });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ accepted: 2, dropped: 0 });

    const rejected = await fetch(collector.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json at all {",
    });
    expect(rejected.status).toBe(400);
  });

  it("scripted 500: the emitter retries exactly once, then drops", async () => {
    collector.setMode({ kind: "status", status: 500 });
    const analytics = tracker.register(createAnalytics(baseConfig()));

    analytics.track("event");
    await analytics.flush();
    expect(collector.requests).toHaveLength(2); // initial attempt + 1 retry

    await analytics.flush();
    expect(collector.requests).toHaveLength(2); // dropped, never re-sent
  });

  it("scripted down: socket-level failure, no throw, attempts still captured", async () => {
    collector.setMode({ kind: "down" });
    const analytics = tracker.register(createAnalytics(baseConfig()));

    expect(() => analytics.track("event")).not.toThrow();
    await expect(analytics.flush()).resolves.toBeUndefined();

    expect(collector.requests).toHaveLength(2); // initial attempt + 1 retry
    expect(collector.events()).toHaveLength(0); // nothing delivered
  });

  it("scripted slow: enqueueing stays instant while the response drags", async () => {
    collector.setMode({ kind: "slow", delayMs: 300 });
    const analytics = tracker.register(createAnalytics(baseConfig()));

    const start = Date.now();
    analytics.track("event");
    expect(Date.now() - start).toBeLessThan(100); // enqueue never blocks

    await analytics.flush(); // waits out the slow response
    expect(collector.requests).toHaveLength(1);
    expect(collector.events()).toHaveLength(1);
  });

  it("waitForRequests resolves when batches arrive asynchronously", async () => {
    const analytics = tracker.register(createAnalytics(baseConfig()));

    analytics.track("event");
    void analytics.flush(); // deliberately not awaited
    await collector.waitForRequests(1);
    expect(collector.events()).toHaveLength(1);
  });

  it("reset clears captured traffic and restores healthy mode", async () => {
    collector.setMode({ kind: "status", status: 500 });
    const analytics = tracker.register(createAnalytics(baseConfig()));
    analytics.track("event");
    await analytics.flush();
    expect(collector.requests.length).toBeGreaterThan(0);

    collector.reset();
    expect(collector.requests).toHaveLength(0);

    analytics.track("after_reset");
    await analytics.flush();
    expect(collector.requests).toHaveLength(1); // healthy again: no retry
    expect(collector.events().map((event) => event.event_type)).toEqual([
      "after_reset",
    ]);
  });
});
