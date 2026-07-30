/**
 * Channel resolution has no failure mode that looks like a failure. Get it
 * wrong and the app updates perfectly — to the wrong build, for the wrong
 * people. The two ways that plays out:
 *
 *  - a stable install offered a pre-release ships an unvalidated build to every
 *    real user, which is the entire reason the beta channel exists;
 *  - a beta install with `allowPrerelease: false` never sees anything, because
 *    the GitHub provider filters pre-releases out of the feed BEFORE it looks
 *    for `beta.yml` — the channel name alone does nothing.
 *
 * The gate is here for a narrower reason: if it ever returns `enabled` during a
 * `--smoke` run, the packaging gate starts depending on the network and on the
 * state of our published releases, and a deterministic check becomes a flaky one.
 */
import { describe, expect, it } from "vitest";
import {
  CHANNEL_ENV_VAR,
  classifyUpdateError,
  DISABLE_ENV_VAR,
  FORCE_ENV_VAR,
  STABLE_ACCEPTS_PRERELEASE,
  resolveUpdateChannel,
  shouldEnableUpdater,
} from "./update-policy.js";

const noEnv: NodeJS.ProcessEnv = {};

describe("resolveUpdateChannel", () => {
  it("follows stable for a final version", () => {
    expect(resolveUpdateChannel("0.1.2", noEnv)).toEqual({
      channel: "latest",
      allowPrerelease: STABLE_ACCEPTS_PRERELEASE,
    });
  });

  it("follows beta for a pre-release version, and accepts pre-releases", () => {
    // Both halves matter: the channel picks the file, allowPrerelease is what
    // lets the provider consider the release that file lives on.
    expect(resolveUpdateChannel("0.1.2-beta.1", noEnv)).toEqual({
      channel: "beta",
      allowPrerelease: true,
    });
  });

  it("treats build metadata as a final release, not a pre-release", () => {
    // `+ci.44` is metadata; the `-` inside `pr-44` must not read as a tag.
    expect(resolveUpdateChannel("0.1.2+ci.44", noEnv).channel).toBe("latest");
    expect(resolveUpdateChannel("0.1.2+pr-44", noEnv).channel).toBe("latest");
  });

  it("does not offer a stable install a pre-release by default", () => {
    // The safety property. If this ever flips, every user is on the beta line.
    expect(resolveUpdateChannel("0.1.2", noEnv).allowPrerelease).toBe(false);
  });

  it("honours the env override in both directions", () => {
    expect(resolveUpdateChannel("0.1.2", { [CHANNEL_ENV_VAR]: "beta" })).toEqual({
      channel: "beta",
      allowPrerelease: true,
    });
    // A tester on a beta build can be pinned back to stable without reinstalling.
    expect(resolveUpdateChannel("0.1.2-beta.1", { [CHANNEL_ENV_VAR]: "latest" })).toEqual({
      channel: "latest",
      allowPrerelease: STABLE_ACCEPTS_PRERELEASE,
    });
  });

  it("accepts a sloppily-typed override", () => {
    // It is set by hand in a shell, so " BETA\n" is the normal case, not an edge one.
    expect(resolveUpdateChannel("0.1.2", { [CHANNEL_ENV_VAR]: " BETA\n" }).channel).toBe("beta");
  });

  it("reports an unusable override instead of silently ignoring it", () => {
    const decision = resolveUpdateChannel("0.1.2", { [CHANNEL_ENV_VAR]: "nightly" });
    expect(decision.channel).toBe("latest"); // falls back, never throws
    expect(decision.ignoredOverride).toBe("nightly");
  });

  it("says nothing when the override is absent or empty", () => {
    expect(resolveUpdateChannel("0.1.2", noEnv).ignoredOverride).toBeUndefined();
    expect(resolveUpdateChannel("0.1.2", { [CHANNEL_ENV_VAR]: "  " }).ignoredOverride).toBeUndefined();
  });

  it("treats an unparseable version as stable rather than throwing", () => {
    // app.getVersion() is whatever package.json says; a bad value must not be
    // able to stop the app from starting.
    for (const version of ["", "not-a-version", "0.1", "v0.1.2"]) {
      expect(resolveUpdateChannel(version, noEnv).channel).toBe("latest");
    }
  });
});

describe("shouldEnableUpdater", () => {
  const packaged = { isPackaged: true, devMode: false, smoke: false, env: noEnv };

  it("is on for a plain packaged launch", () => {
    expect(shouldEnableUpdater(packaged)).toEqual({ enabled: true });
  });

  it("is off during a smoke run, so CI never depends on GitHub", () => {
    const gate = shouldEnableUpdater({ ...packaged, smoke: true });
    expect(gate.enabled).toBe(false);
    expect(gate.reason).toBe("smoke run");
  });

  it("is off unpackaged — there is no app-update.yml to read", () => {
    expect(shouldEnableUpdater({ ...packaged, isPackaged: false }).enabled).toBe(false);
  });

  it("is off in --dev, including against a packaged build", () => {
    expect(shouldEnableUpdater({ ...packaged, devMode: true }).enabled).toBe(false);
  });

  it("can be switched off outright", () => {
    const gate = shouldEnableUpdater({ ...packaged, env: { [DISABLE_ENV_VAR]: "1" } });
    expect(gate.enabled).toBe(false);
    expect(gate.reason).toContain(DISABLE_ENV_VAR);
  });

  it("can be forced on from an unpackaged build, and says so", () => {
    // The dev loop for this feature: without `forced`, the caller wouldn't set
    // forceDevUpdateConfig and electron-updater would throw looking for the
    // app-update.yml that only packaging writes.
    const gate = shouldEnableUpdater({
      ...packaged,
      isPackaged: false,
      devMode: true,
      env: { [FORCE_ENV_VAR]: "1" },
    });
    expect(gate).toEqual({ enabled: true, forced: true });
  });

  it("keeps a smoke run hermetic even when the updater is forced on", () => {
    // CI hermeticity outranks the developer convenience: no combination of env
    // vars may make the packaging gate depend on the network.
    const gate = shouldEnableUpdater({ ...packaged, smoke: true, env: { [FORCE_ENV_VAR]: "1" } });
    expect(gate.enabled).toBe(false);
    expect(gate.reason).toBe("smoke run");
  });

  it("lets the opt-out beat the force override", () => {
    // A user who asked for no update traffic gets none, whatever else is set.
    const gate = shouldEnableUpdater({
      ...packaged,
      env: { [DISABLE_ENV_VAR]: "1", [FORCE_ENV_VAR]: "1" },
    });
    expect(gate.enabled).toBe(false);
  });

  it("always reports a reason when disabled", () => {
    // The reason is the only thing a user's log will show; an empty one turns
    // "updates aren't working" into an unanswerable question.
    for (const input of [
      { ...packaged, smoke: true },
      { ...packaged, isPackaged: false },
      { ...packaged, devMode: true },
      { ...packaged, env: { [DISABLE_ENV_VAR]: "1" } },
    ]) {
      const gate = shouldEnableUpdater(input);
      expect(gate.enabled).toBe(false);
      expect(gate.reason).toBeTruthy();
    }
  });
});

describe("classifyUpdateError", () => {
  // The real thing, abbreviated: electron-updater appends the ENTIRE releases Atom
  // feed after ", XML:", plus a full stack trace. Forwarding this to the UI put
  // kilobytes of XML into a toast.
  const REAL_NO_RELEASE = [
    "Unable to find latest version on GitHub (https://github.com/sapiom/sapiom-js/releases.atom),",
    " please ensure a production release exists: HttpError: 404",
    '\n    at GitHubProvider.getLatestTagName (/Applications/Sapiom.app/Contents/Resources/app.asar/node_modules/electron-updater/out/providers/GitHubProvider.js:173:55)',
    "\n    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
    ', XML: <?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">',
    "<title>Release notes from sapiom-js</title><entry><id>tag:github.com,2008:Repository/1094593670/harness-desktop-v0.1.0</id></entry></feed>",
  ].join("");

  it("recognises an empty channel, and drops the feed and the stack", () => {
    const { kind, summary } = classifyUpdateError(REAL_NO_RELEASE);
    expect(kind).toBe("no-release");
    expect(summary).not.toMatch(/<\?xml|<feed|GitHubProvider|app\.asar/);
    expect(summary.length).toBeLessThan(120);
  });

  it("never lets a message through long enough to wreck a toast", () => {
    // The property that actually matters, independent of classification.
    for (const raw of [REAL_NO_RELEASE, `Boom${"x".repeat(5000)}`, `a\n${"y".repeat(5000)}`]) {
      expect(classifyUpdateError(raw).summary.length).toBeLessThanOrEqual(160);
    }
  });

  it("names an offline machine as such", () => {
    expect(classifyUpdateError("request to https://github.com failed, reason: getaddrinfo ENOTFOUND github.com").kind).toBe(
      "offline",
    );
    expect(classifyUpdateError("connect ECONNREFUSED 140.82.121.3:443").kind).toBe("offline");
  });

  it("keeps an unrecognised message, bounded, rather than replacing it", () => {
    // A truncated real message still beats a generic one when diagnosing from a
    // screenshot.
    const { kind, summary } = classifyUpdateError("ENOSPC: no space left on device, write");
    expect(kind).toBe("other");
    expect(summary).toContain("ENOSPC");
  });

  it("always produces something to show", () => {
    for (const raw of ["", "   ", "\n\n"]) {
      expect(classifyUpdateError(raw).summary.length).toBeGreaterThan(0);
    }
  });
});
