import { createAnalytics } from "../analytics.js";
import { MAX_FIELD_LENGTH } from "../data.js";
import type { AnalyticsConfig } from "../types.js";
import {
  cleanAnalyticsEnv,
  createCapturingFetch,
  instanceTracker,
  useTempHome,
  UUID_V4_REGEX,
  type TempHome,
} from "./helpers.js";

describe("event envelope", () => {
  let home: TempHome;
  let restoreEnv: () => void;
  const tracker = instanceTracker();

  const baseConfig = (
    overrides: Partial<AnalyticsConfig> = {},
  ): AnalyticsConfig => ({
    source: "tools",
    sdkName: "@sapiom/tools",
    sdkVersion: "1.2.3",
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

  it("emits the full envelope shape", async () => {
    const capture = createCapturingFetch();
    const analytics = tracker.register(
      createAnalytics(baseConfig({ fetchImpl: capture.fetchImpl })),
    );

    analytics.track("capability.call", { capability: "search" });
    await analytics.flush();

    const [event] = capture.batch();
    expect(event.event_id).toMatch(UUID_V4_REGEX);
    expect(event.anonymous_id).toBe(analytics.anonymousId);
    expect(event.session_id).toBe(analytics.sessionId);
    expect(new Date(event.event_timestamp).toString()).not.toBe("Invalid Date");
    expect(event.source).toBe("tools");
    expect(event.event_type).toBe("capability.call");
    expect(event.sdk_name).toBe("@sapiom/tools");
    expect(event.sdk_version).toBe("1.2.3");
    expect(event.schema_version).toBe("1");
    expect(event.data).toEqual({ capability: "search" });
    expect("user_id" in event).toBe(false);
  });

  it("includes user_id only when provided", async () => {
    const capture = createCapturingFetch();
    const analytics = tracker.register(
      createAnalytics(
        baseConfig({ userId: "usr_123", fetchImpl: capture.fetchImpl }),
      ),
    );

    analytics.track("event");
    await analytics.flush();
    expect(capture.batch()[0].user_id).toBe("usr_123");
  });

  it("applies per-event envelope overrides and ignores unknown keys", async () => {
    const capture = createCapturingFetch();
    const analytics = tracker.register(
      createAnalytics(baseConfig({ fetchImpl: capture.fetchImpl })),
    );

    analytics.track(
      "event",
      { a: 1 },
      {
        user_id: "usr_override",
        session_id: "11111111-1111-4111-8111-111111111111",
        environment: "test",
        // Unknown top-level keys must not leak into the envelope.
        ...({ org_id: "org_nope", data: { b: 2 } } as object),
      },
    );
    await analytics.flush();

    const [event] = capture.batch();
    expect(event.user_id).toBe("usr_override");
    expect(event.session_id).toBe("11111111-1111-4111-8111-111111111111");
    expect(event.environment).toBe("test");
    expect("org_id" in event).toBe(false);
    expect(event.data).toEqual({ a: 1 }); // data is not overridable
  });

  it("wraps non-object data as { value }", async () => {
    const capture = createCapturingFetch();
    const analytics = tracker.register(
      createAnalytics(baseConfig({ fetchImpl: capture.fetchImpl })),
    );

    analytics.track(
      "event",
      "plain string" as unknown as Record<string, unknown>,
    );
    analytics.track("event", [1, 2, 3] as unknown as Record<string, unknown>);
    analytics.track("event"); // no data at all
    await analytics.flush();

    const events = capture.batch();
    expect(events[0].data).toEqual({ value: "plain string" });
    expect(events[1].data).toEqual({ value: [1, 2, 3] });
    expect(events[2].data).toEqual({});
  });

  it("never throws on unserializable data (circular, BigInt)", async () => {
    const capture = createCapturingFetch();
    const analytics = tracker.register(
      createAnalytics(baseConfig({ fetchImpl: capture.fetchImpl })),
    );

    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() =>
      analytics.track("event", { circular, big: BigInt(7), fine: "ok" }),
    ).not.toThrow();
    await analytics.flush();

    const [event] = capture.batch();
    expect(event.data.circular).toBe("[unserializable]");
    expect(event.data.big).toBe("[unserializable]");
    expect(event.data.fine).toBe("ok");
    expect(event.data._truncated).toBe(true);
  });

  it("truncates oversized fields and flags data._truncated", async () => {
    const capture = createCapturingFetch();
    const analytics = tracker.register(
      createAnalytics(baseConfig({ fetchImpl: capture.fetchImpl })),
    );

    const huge = "x".repeat(MAX_FIELD_LENGTH + 5_000);
    analytics.track("event", { huge, small: "ok" });
    analytics.track("event", { small: "ok" });
    await analytics.flush();

    const events = capture.batch();
    expect((events[0].data.huge as string).length).toBe(MAX_FIELD_LENGTH);
    expect(events[0].data.small).toBe("ok");
    expect(events[0].data._truncated).toBe(true);
    expect("_truncated" in events[1].data).toBe(false);
  });

  it("caps oversized non-string fields via their serialized form", async () => {
    const capture = createCapturingFetch();
    const analytics = tracker.register(
      createAnalytics(baseConfig({ fetchImpl: capture.fetchImpl })),
    );

    const bigObject = { nested: "y".repeat(MAX_FIELD_LENGTH + 1_000) };
    analytics.track("event", { bigObject });
    await analytics.flush();

    const [event] = capture.batch();
    expect(typeof event.data.bigObject).toBe("string");
    expect((event.data.bigObject as string).length).toBe(MAX_FIELD_LENGTH);
    expect(event.data._truncated).toBe(true);
  });

  it("tolerates a hostile debug hook and a mostly-empty config", async () => {
    const capture = createCapturingFetch();
    const analytics = tracker.register(
      createAnalytics({
        fetchImpl: capture.fetchImpl,
        debug: () => {
          throw new Error("hostile hook");
        },
      } as unknown as AnalyticsConfig),
    );

    expect(() => analytics.track("event")).not.toThrow();
    await expect(analytics.flush()).resolves.toBeUndefined();
  });
});
