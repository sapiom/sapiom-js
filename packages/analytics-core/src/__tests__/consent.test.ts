import * as fs from "fs";

import { createAnalytics } from "../analytics.js";
import type { AnalyticsConfig } from "../types.js";
import {
  cleanAnalyticsEnv,
  createCapturingFetch,
  instanceTracker,
  useTempHome,
  type TempHome,
} from "./helpers.js";

describe("consent resolution", () => {
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

  describe.each([
    ["SAPIOM_TELEMETRY_DISABLED", "1"],
    ["SAPIOM_TELEMETRY_DISABLED", "true"],
    ["SAPIOM_TELEMETRY_DISABLED", "TRUE"],
    ["DO_NOT_TRACK", "1"],
    ["DO_NOT_TRACK", "true"],
  ])("%s=%s", (envVar, value) => {
    it("disables analytics: zero fetch calls, no identity file", async () => {
      process.env[envVar] = value;
      const capture = createCapturingFetch();
      const analytics = tracker.register(
        createAnalytics(baseConfig({ fetchImpl: capture.fetchImpl })),
      );

      expect(analytics.enabled).toBe(false);
      expect(analytics.anonymousId).toBeNull();

      analytics.track("some_event", { a: 1 });
      await analytics.flush();
      await analytics.shutdown();

      expect(capture.calls).toHaveLength(0);
      expect(fs.existsSync(home.identityPath)).toBe(false);
    });
  });

  it("does not treat other env values as opt-out", async () => {
    process.env.SAPIOM_TELEMETRY_DISABLED = "0";
    process.env.DO_NOT_TRACK = "no";
    const capture = createCapturingFetch();
    const analytics = tracker.register(
      createAnalytics(baseConfig({ fetchImpl: capture.fetchImpl })),
    );

    expect(analytics.enabled).toBe(true);
    analytics.track("some_event");
    await analytics.flush();
    expect(capture.calls).toHaveLength(1);
  });

  it("disabled: true wins over everything", async () => {
    const capture = createCapturingFetch();
    const analytics = tracker.register(
      createAnalytics(
        baseConfig({
          disabled: true,
          consentProvider: () => true,
          fetchImpl: capture.fetchImpl,
        }),
      ),
    );

    expect(analytics.enabled).toBe(false);
    analytics.track("some_event");
    await analytics.flush();
    expect(capture.calls).toHaveLength(0);
    expect(fs.existsSync(home.identityPath)).toBe(false);
  });

  it("env opt-out wins over a consent provider that grants", () => {
    process.env.SAPIOM_TELEMETRY_DISABLED = "1";
    const analytics = tracker.register(
      createAnalytics(baseConfig({ consentProvider: () => true })),
    );
    expect(analytics.enabled).toBe(false);
  });

  it("consent provider returning false disables", async () => {
    const capture = createCapturingFetch();
    const analytics = tracker.register(
      createAnalytics(
        baseConfig({
          consentProvider: () => false,
          fetchImpl: capture.fetchImpl,
        }),
      ),
    );

    expect(analytics.enabled).toBe(false);
    analytics.track("some_event");
    await analytics.flush();
    expect(capture.calls).toHaveLength(0);
  });

  it("consent provider returning true enables", () => {
    const analytics = tracker.register(
      createAnalytics(
        baseConfig({
          consentProvider: () => true,
          fetchImpl: createCapturingFetch().fetchImpl,
        }),
      ),
    );
    expect(analytics.enabled).toBe(true);
  });

  it.each([
    ["undefined", () => undefined],
    [
      "throwing",
      () => {
        throw new Error("boom");
      },
    ],
  ])(
    "consent provider with no opinion (%s) falls through to default ON",
    (_label, provider) => {
      const analytics = tracker.register(
        createAnalytics(
          baseConfig({
            consentProvider: provider as () => boolean | undefined,
            fetchImpl: createCapturingFetch().fetchImpl,
          }),
        ),
      );
      expect(analytics.enabled).toBe(true);
    },
  );

  it("defaults to enabled with a clean environment", () => {
    const analytics = tracker.register(
      createAnalytics(
        baseConfig({ fetchImpl: createCapturingFetch().fetchImpl }),
      ),
    );
    expect(analytics.enabled).toBe(true);
  });

  it("disabled instance flush/shutdown resolve and never reject", async () => {
    process.env.DO_NOT_TRACK = "1";
    const analytics = tracker.register(createAnalytics(baseConfig()));
    await expect(analytics.flush()).resolves.toBeUndefined();
    await expect(analytics.shutdown()).resolves.toBeUndefined();
  });
});
