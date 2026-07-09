import * as fs from "fs";

import { createAnalytics } from "../analytics.js";
import { SAPIOM_COLLECTOR_ENDPOINT } from "../http-sender.js";
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

  it("treats an explicit empty-string endpoint as absent → hosted default", async () => {
    delete process.env.SAPIOM_ANALYTICS_ENDPOINT;
    const capture = createCapturingFetch();
    const analytics = tracker.register(
      createAnalytics(
        baseConfig({ endpoint: "", fetchImpl: capture.fetchImpl }),
      ),
    );

    expect(analytics.enabled).toBe(true);
    analytics.track("event", { n: 1 });
    await analytics.flush();
    expect(capture.calls).toHaveLength(1);
    expect(capture.calls[0].url).toBe(SAPIOM_COLLECTOR_ENDPOINT);
  });

  it("no endpoint configured → delivers to the hosted collector by default", async () => {
    delete process.env.SAPIOM_ANALYTICS_ENDPOINT;
    const capture = createCapturingFetch();
    const analytics = tracker.register(
      createAnalytics(baseConfig({ fetchImpl: capture.fetchImpl })),
    );

    expect(analytics.enabled).toBe(true);
    expect(() => analytics.track("event", { n: 1 })).not.toThrow();
    await expect(analytics.flush()).resolves.toBeUndefined();
    await expect(analytics.shutdown()).resolves.toBeUndefined();

    expect(capture.calls).toHaveLength(1);
    expect(capture.calls[0].url).toBe(SAPIOM_COLLECTOR_ENDPOINT);
  });

  it("opt-out keeps the true no-op path: zero fetches, zero disk writes", async () => {
    // The live default makes consent the only dark switch — verify it still
    // guarantees a full no-op even when the default endpoint would apply.
    delete process.env.SAPIOM_ANALYTICS_ENDPOINT;
    process.env.SAPIOM_TELEMETRY_DISABLED = "1";
    const capture = createCapturingFetch();

    const optedOutByEnv = tracker.register(
      createAnalytics(baseConfig({ fetchImpl: capture.fetchImpl })),
    );
    expect(optedOutByEnv.enabled).toBe(false);
    expect(() => optedOutByEnv.track("event", { n: 1 })).not.toThrow();
    await expect(optedOutByEnv.flush()).resolves.toBeUndefined();
    await expect(optedOutByEnv.shutdown()).resolves.toBeUndefined();

    delete process.env.SAPIOM_TELEMETRY_DISABLED;
    const optedOutByConfig = tracker.register(
      createAnalytics(
        baseConfig({ disabled: true, fetchImpl: capture.fetchImpl }),
      ),
    );
    expect(optedOutByConfig.enabled).toBe(false);
    optedOutByConfig.track("event", { n: 1 });
    await optedOutByConfig.flush();

    expect(capture.calls).toHaveLength(0);
    expect(fs.existsSync(home.identityPath)).toBe(false);
  });

  it("explicitly passing SAPIOM_COLLECTOR_ENDPOINT targets the hosted collector", async () => {
    delete process.env.SAPIOM_ANALYTICS_ENDPOINT;
    const capture = createCapturingFetch();
    const analytics = tracker.register(
      createAnalytics(
        baseConfig({
          endpoint: SAPIOM_COLLECTOR_ENDPOINT,
          fetchImpl: capture.fetchImpl,
        }),
      ),
    );

    expect(analytics.enabled).toBe(true);
    analytics.track("event");
    await analytics.flush();
    expect(capture.calls[0].url).toBe(SAPIOM_COLLECTOR_ENDPOINT);
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

  it("the environment override configures the endpoint", async () => {
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
