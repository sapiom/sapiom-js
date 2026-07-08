import * as fs from "fs";
import * as path from "path";

import { createAnalytics, FIRST_RUN_NOTICE } from "../analytics.js";
import type { AnalyticsConfig } from "../types.js";
import {
  cleanAnalyticsEnv,
  createCapturingFetch,
  instanceTracker,
  useTempHome,
  UUID_V4_REGEX,
  type TempHome,
} from "./helpers.js";

describe("identity store + first-run notice", () => {
  let home: TempHome;
  let restoreEnv: () => void;
  let stderrSpy: jest.SpyInstance;
  const tracker = instanceTracker();

  const baseConfig = (
    overrides: Partial<AnalyticsConfig> = {},
  ): AnalyticsConfig => ({
    source: "tools",
    sdkName: "@sapiom/test",
    sdkVersion: "0.0.0",
    fetchImpl: createCapturingFetch().fetchImpl,
    ...overrides,
  });

  const noticeCount = (): number =>
    stderrSpy.mock.calls.filter((call) =>
      String(call[0]).includes(FIRST_RUN_NOTICE),
    ).length;

  beforeEach(() => {
    restoreEnv = cleanAnalyticsEnv();
    home = useTempHome();
    stderrSpy = jest
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
  });

  afterEach(async () => {
    stderrSpy.mockRestore();
    await tracker.shutdownAll();
    home.restore();
    restoreEnv();
  });

  it("creates ~/.sapiom/analytics.json lazily with mode 0600 and a uuid4", () => {
    const analytics = tracker.register(createAnalytics(baseConfig()));
    expect(fs.existsSync(home.identityPath)).toBe(false); // lazy: not yet

    analytics.track("first_event");

    expect(fs.existsSync(home.identityPath)).toBe(true);
    expect(fs.statSync(home.identityPath).mode & 0o777).toBe(0o600);

    const record = JSON.parse(fs.readFileSync(home.identityPath, "utf8"));
    expect(record.anonymous_id).toMatch(UUID_V4_REGEX);
    expect(analytics.anonymousId).toBe(record.anonymous_id);
  });

  it("reuses the persisted anonymous id across instances", () => {
    const first = tracker.register(createAnalytics(baseConfig()));
    first.track("event");
    const firstId = first.anonymousId;
    expect(firstId).toMatch(UUID_V4_REGEX);

    const second = tracker.register(createAnalytics(baseConfig()));
    second.track("event");
    expect(second.anonymousId).toBe(firstId);
  });

  it("silently regenerates a corrupt identity file", () => {
    fs.mkdirSync(path.dirname(home.identityPath), { recursive: true });
    fs.writeFileSync(home.identityPath, "not json at all {{{");

    const analytics = tracker.register(createAnalytics(baseConfig()));
    analytics.track("event");

    expect(analytics.anonymousId).toMatch(UUID_V4_REGEX);
    const record = JSON.parse(fs.readFileSync(home.identityPath, "utf8"));
    expect(record.anonymous_id).toBe(analytics.anonymousId);
  });

  it("regenerates when the file is valid JSON but the wrong shape", () => {
    fs.mkdirSync(path.dirname(home.identityPath), { recursive: true });
    fs.writeFileSync(home.identityPath, JSON.stringify({ hello: "world" }));

    const analytics = tracker.register(createAnalytics(baseConfig()));
    analytics.track("event");
    expect(analytics.anonymousId).toMatch(UUID_V4_REGEX);
  });

  it("prints the first-run notice exactly once across separate instances", () => {
    const first = tracker.register(createAnalytics(baseConfig()));
    first.track("event_one");
    first.track("event_two");
    expect(noticeCount()).toBe(1);

    const record = JSON.parse(fs.readFileSync(home.identityPath, "utf8"));
    expect(typeof record.first_run_notice_at).toBe("string");
    expect(new Date(record.first_run_notice_at).toString()).not.toBe(
      "Invalid Date",
    );

    // A second instance with the same HOME simulates a later process:
    // the persisted marker suppresses the notice.
    const second = tracker.register(createAnalytics(baseConfig()));
    second.track("event_three");
    expect(noticeCount()).toBe(1);
  });

  it("prints no notice and writes no file when disabled", async () => {
    process.env.SAPIOM_TELEMETRY_DISABLED = "1";
    const analytics = tracker.register(createAnalytics(baseConfig()));
    analytics.track("event");
    await analytics.flush();

    expect(noticeCount()).toBe(0);
    expect(fs.existsSync(home.identityPath)).toBe(false);
  });

  it("keeps emitting (anonymous_id null, no notice) when HOME is unwritable", async () => {
    // Point HOME below a regular file so mkdir must fail.
    const blocker = path.join(home.dir, "blocker");
    fs.writeFileSync(blocker, "i am a file");
    process.env.HOME = path.join(blocker, "nested");
    process.env.USERPROFILE = process.env.HOME;

    const capture = createCapturingFetch();
    const analytics = tracker.register(
      createAnalytics(baseConfig({ fetchImpl: capture.fetchImpl })),
    );

    expect(() => analytics.track("event")).not.toThrow();
    await analytics.flush();

    expect(noticeCount()).toBe(0);
    expect(capture.calls).toHaveLength(1);
    expect(capture.batch()[0].anonymous_id).toBeNull();
    expect(analytics.anonymousId).toBeNull();
  });

  it("shares one session id per process and exposes it as uuid4", () => {
    const first = tracker.register(createAnalytics(baseConfig()));
    const second = tracker.register(createAnalytics(baseConfig()));
    expect(first.sessionId).toMatch(UUID_V4_REGEX);
    expect(second.sessionId).toBe(first.sessionId);
  });
});
