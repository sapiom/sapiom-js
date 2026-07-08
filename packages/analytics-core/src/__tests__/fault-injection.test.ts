import { createAnalytics } from "../analytics.js";
import { DEFAULT_ENDPOINT } from "../http-sender.js";
import type { AnalyticsConfig } from "../types.js";
import {
  cleanAnalyticsEnv,
  createCapturingFetch,
  getClosedPort,
  instanceTracker,
  useTempHome,
  type TempHome,
} from "./helpers.js";

describe("fault injection", () => {
  let home: TempHome;
  let restoreEnv: () => void;
  const tracker = instanceTracker();

  const baseConfig = (
    overrides: Partial<AnalyticsConfig> = {},
  ): AnalyticsConfig => ({
    source: "cli",
    sdkName: "@sapiom/test",
    sdkVersion: "0.0.0",
    ...overrides,
  });

  beforeEach(() => {
    restoreEnv = cleanAnalyticsEnv();
    home = useTempHome();
  });

  afterEach(async () => {
    await tracker.shutdownAll();
    home.restore();
    restoreEnv();
  });

  it("collector down (rejecting fetch): no throw, exactly one retry, then silent drop", async () => {
    const capture = createCapturingFetch({ reject: true });
    const analytics = tracker.register(
      createAnalytics(baseConfig({ fetchImpl: capture.fetchImpl })),
    );

    expect(() => analytics.track("event")).not.toThrow();
    await expect(analytics.flush()).resolves.toBeUndefined();

    expect(capture.calls).toHaveLength(2); // initial attempt + 1 retry

    // The batch was dropped — nothing further is ever sent for it.
    await expect(analytics.flush()).resolves.toBeUndefined();
    expect(capture.calls).toHaveLength(2);
  });

  it("collector down (real ECONNREFUSED on a closed port, env endpoint override): never rejects", async () => {
    const port = await getClosedPort();
    process.env.SAPIOM_ANALYTICS_ENDPOINT = `http://127.0.0.1:${port}/collector`;

    // Real global fetch, real connection failure.
    const analytics = tracker.register(createAnalytics(baseConfig()));
    expect(analytics.enabled).toBe(true);

    expect(() => analytics.track("event", { n: 1 })).not.toThrow();
    await expect(analytics.flush()).resolves.toBeUndefined();
    await expect(analytics.shutdown()).resolves.toBeUndefined();
  });

  it("HTTP 500: no throw, at most one retry, then silent drop", async () => {
    const capture = createCapturingFetch({ status: 500 });
    const analytics = tracker.register(
      createAnalytics(baseConfig({ fetchImpl: capture.fetchImpl })),
    );

    analytics.track("event");
    await expect(analytics.flush()).resolves.toBeUndefined();
    expect(capture.calls).toHaveLength(2);

    await expect(analytics.flush()).resolves.toBeUndefined();
    expect(capture.calls).toHaveLength(2); // dropped, not re-sent
  });

  it("HTTP 500 then 202: the single retry succeeds", async () => {
    const capture = createCapturingFetch({ status: [500, 202] });
    const analytics = tracker.register(
      createAnalytics(baseConfig({ fetchImpl: capture.fetchImpl })),
    );

    analytics.track("event");
    await analytics.flush();
    expect(capture.calls).toHaveLength(2);
  });

  it("HTTP 400 is dropped without a retry", async () => {
    const capture = createCapturingFetch({ status: 400 });
    const analytics = tracker.register(
      createAnalytics(baseConfig({ fetchImpl: capture.fetchImpl })),
    );

    analytics.track("event");
    await analytics.flush();
    expect(capture.calls).toHaveLength(1);
  });

  it("HTTP 429 gets the single permitted retry", async () => {
    const capture = createCapturingFetch({ status: [429, 202] });
    const analytics = tracker.register(
      createAnalytics(baseConfig({ fetchImpl: capture.fetchImpl })),
    );

    analytics.track("event");
    await analytics.flush();
    expect(capture.calls).toHaveLength(2);
  });

  it("slow collector never blocks the hot path", async () => {
    const capture = createCapturingFetch({ delayMs: 250 });
    const analytics = tracker.register(
      createAnalytics(baseConfig({ fetchImpl: capture.fetchImpl })),
    );

    const start = Date.now();
    for (let i = 0; i < 50; i++) {
      analytics.track("event", { i });
    }
    const elapsed = Date.now() - start;
    // 50 synchronous enqueues (including three batch-triggered sends)
    // must return immediately, not wait on the 250ms collector.
    expect(elapsed).toBeLessThan(100);

    await expect(analytics.flush()).resolves.toBeUndefined();
    expect(capture.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("uses the default public endpoint when nothing overrides it", async () => {
    const capture = createCapturingFetch();
    const analytics = tracker.register(
      createAnalytics(baseConfig({ fetchImpl: capture.fetchImpl })),
    );

    analytics.track("event");
    await analytics.flush();
    expect(capture.calls[0].url).toBe(DEFAULT_ENDPOINT);
  });

  it("config endpoint beats the environment override", async () => {
    process.env.SAPIOM_ANALYTICS_ENDPOINT = "http://127.0.0.1:9/env";
    const capture = createCapturingFetch();
    const analytics = tracker.register(
      createAnalytics(
        baseConfig({
          endpoint: "http://127.0.0.1:9/config",
          fetchImpl: capture.fetchImpl,
        }),
      ),
    );

    analytics.track("event");
    await analytics.flush();
    expect(capture.calls[0].url).toBe("http://127.0.0.1:9/config");
  });

  it("environment override beats the default", async () => {
    process.env.SAPIOM_ANALYTICS_ENDPOINT = "http://127.0.0.1:9/env";
    const capture = createCapturingFetch();
    const analytics = tracker.register(
      createAnalytics(baseConfig({ fetchImpl: capture.fetchImpl })),
    );

    analytics.track("event");
    await analytics.flush();
    expect(capture.calls[0].url).toBe("http://127.0.0.1:9/env");
  });

  it("sends x-sapiom-api-key only when an apiKey is configured", async () => {
    const withKey = createCapturingFetch();
    const keyed = tracker.register(
      createAnalytics(
        baseConfig({ apiKey: "sk-test-123", fetchImpl: withKey.fetchImpl }),
      ),
    );
    keyed.track("event");
    await keyed.flush();
    expect(withKey.calls[0].init.headers["x-sapiom-api-key"]).toBe(
      "sk-test-123",
    );
    expect(withKey.calls[0].init.headers["content-type"]).toBe(
      "application/json",
    );
    expect(withKey.calls[0].init.method).toBe("POST");

    const withoutKey = createCapturingFetch();
    const anonymous = tracker.register(
      createAnalytics(baseConfig({ fetchImpl: withoutKey.fetchImpl })),
    );
    anonymous.track("event");
    await anonymous.flush();
    expect("x-sapiom-api-key" in withoutKey.calls[0].init.headers).toBe(false);
  });
});
