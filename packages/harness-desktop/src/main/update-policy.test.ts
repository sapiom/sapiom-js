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

  it("moves a stable install onto betas via the persisted opt-in", () => {
    // The whole point of the toggle: no env var, no launchctl, no relaunch ritual.
    const decision = resolveUpdateChannel("0.3.9", {}, { preRelease: true });
    expect(decision.channel).toBe("beta");
    expect(decision.allowPrerelease).toBe(true);
  });

  it("leaves a stable install alone when the opt-in is off or absent", () => {
    expect(resolveUpdateChannel("0.3.9", {}, { preRelease: false }).channel).toBe("latest");
    expect(resolveUpdateChannel("0.3.9", {}).channel).toBe("latest");
  });

  it("never uses the opt-in to drag a pre-release build back onto stable", () => {
    // Offering `latest` to a machine running 0.3.9-beta.2 would present a
    // DOWNGRADE as an update. The toggle can only move an install onto betas.
    expect(resolveUpdateChannel("0.3.9-beta.2", {}, { preRelease: false }).channel).toBe("beta");
  });

  it("lets the env override beat the persisted opt-in, in both directions", () => {
    // The env var is the one-off debugging escape hatch, so it sits above the
    // stored setting: someone who exported it is asking a more specific question.
    expect(resolveUpdateChannel("0.3.9", { SAPIOM_UPDATE_CHANNEL: "latest" }, { preRelease: true }).channel).toBe(
      "latest",
    );
    expect(resolveUpdateChannel("0.3.9", { SAPIOM_UPDATE_CHANNEL: "beta" }, { preRelease: false }).channel).toBe(
      "beta",
    );
  });

  it("falls back to the opt-in when the env override is unusable", () => {
    const decision = resolveUpdateChannel("0.3.9", { SAPIOM_UPDATE_CHANNEL: "canary" }, { preRelease: true });
    expect(decision.channel).toBe("beta");
    expect(decision.ignoredOverride).toBe("canary");
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

  it("still reads a 429 that GitHubProvider wrapped as a no-release message", () => {
    // Verbatim shape from electron-updater: getLatestTagName wraps ANY failure
    // of /releases/latest in its own "ensure a production release exists"
    // sentence, so a throttled user was told "nothing published yet" — the
    // message that invites another click, which deepens the rate limit.
    const wrapped =
      "Unable to find latest version on GitHub (https://github.com/sapiom/sapiom-js/releases.atom), " +
      "please ensure a production release exists: HttpError: 429 Too Many Requests";
    expect(classifyUpdateError(wrapped).kind).toBe("rate-limited");
  });

  it("names a GitHub 429 as rate-limiting, not jargon and not offline", () => {
    // Seen live: a day of repeated installs/boot-checks from one home IP got
    // the raw "429 Too Many Requests" into a toast. It must NOT classify as
    // "offline" either — that kind gets an immediate retry (updater.ts),
    // which is exactly what a throttled IP doesn't need.
    const { kind, summary } = classifyUpdateError(
      "HttpError: 429 Too Many Requests ... \"method: GET url: https://github.com/sapiom/sapiom-js/releases.atom\"",
    );
    expect(kind).toBe("rate-limited");
    expect(summary).toContain("rate-limiting");
    expect(summary).not.toContain("429");
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

describe("classifyUpdateError: a network answering for GitHub", () => {
  // builder-util-runtime's exact shape (httpExecutor.js createHttpError):
  // `${status} ${statusMessage}\n<JSON description>\nHeaders: <JSON headers>`.
  // For releases.atom the HttpError reaches us intact; for /releases/latest
  // GitHubProvider embeds `e.stack` — the same text — inside its own sentence.
  function httpError(status: number, statusMessage: string, body: string, headers: Record<string, string>): string {
    const description = {
      method: "GET",
      url: "https://github.com/sapiom/sapiom-js/releases.atom",
      data: body,
    };
    return `${status} ${statusMessage}\n${JSON.stringify(description, null, "  ")}\nHeaders: ${JSON.stringify(headers, null, 2)}`;
  }
  const SIGN_IN_PAGE = '<!DOCTYPE html><html lang="en"><head><title>Sign in</title></head><body>Sign in to continue</body></html>';
  const GITHUB = {
    server: "github.com",
    "content-type": "text/html; charset=utf-8",
    "x-github-request-id": "C0DE:1234:ABCD:5678:66F1A2B3",
  };

  it("keeps a GitHub 429 with retry-after and a request id as rate-limited", () => {
    const raw = httpError(429, "Too Many Requests", "<!DOCTYPE html><html>…</html>", {
      ...GITHUB,
      "retry-after": "60",
      "x-ratelimit-remaining": "0",
    });
    expect(classifyUpdateError(raw).kind).toBe("rate-limited");
  });

  it("keeps a GitHub 429 as rate-limited on its request id alone, even without throttle headers", () => {
    expect(classifyUpdateError(httpError(429, "Too Many Requests", "", GITHUB)).kind).toBe("rate-limited");
  });

  it("keeps a 429 with a throttle header as rate-limited, whoever sent it", () => {
    // Waiting and retrying is the right advice for any throttle.
    expect(classifyUpdateError(httpError(429, "Too Many Requests", "", { "retry-after": "30" })).kind).toBe("rate-limited");
  });

  it("reads a 403 with throttle headers as GitHub's secondary rate limit, signed or not", () => {
    const throttle = { "retry-after": "60", "x-ratelimit-remaining": "0" };
    expect(classifyUpdateError(httpError(403, "Forbidden", "", { ...GITHUB, ...throttle })).kind).toBe("rate-limited");
    expect(classifyUpdateError(httpError(403, "Forbidden", "", throttle)).kind).toBe("rate-limited");
  });

  it("calls a 429 text/html with no GitHub headers an interception, not a rate limit", () => {
    const raw = httpError(429, "Too Many Requests", SIGN_IN_PAGE, {
      "content-type": "text/html",
      server: "corp-proxy/2.1",
    });
    const { kind, summary } = classifyUpdateError(raw);
    expect(kind).toBe("intercepted");
    expect(summary).not.toMatch(/rate-limit|429|<html/);
  });

  it("calls a 429 with headers that name neither GitHub nor a throttle an interception", () => {
    // No body, no content-type: the absence of every GitHub header is the evidence.
    expect(classifyUpdateError(httpError(429, "Too Many Requests", "", { via: "1.1 gateway" })).kind).toBe(
      "intercepted",
    );
  });

  it("calls a 403 with an HTML body an interception", () => {
    const raw = httpError(403, "Forbidden", SIGN_IN_PAGE, { "content-type": "text/html; charset=utf-8" });
    expect(classifyUpdateError(raw).kind).toBe("intercepted");
  });

  it("calls a bare 403 / 401 with no GitHub headers an interception (was: 'Couldn't check: 403 Forbidden')", () => {
    expect(classifyUpdateError("403 Forbidden").kind).toBe("intercepted");
    expect(classifyUpdateError("HttpError: 401 Unauthorized").kind).toBe("intercepted");
  });

  it("calls a 407 an interception whatever else it carries", () => {
    expect(classifyUpdateError(httpError(407, "Proxy Authentication Required", "", {})).kind).toBe("intercepted");
    expect(classifyUpdateError("407 Proxy Authentication Required").kind).toBe("intercepted");
    // A retry-after on a challenge does not make it a rate limit.
    const throttle = { "retry-after": "60" };
    expect(classifyUpdateError(httpError(407, "Proxy Authentication Required", "", throttle)).kind).toBe("intercepted");
    expect(classifyUpdateError(httpError(401, "Unauthorized", "", throttle)).kind).toBe("intercepted");
  });

  it("trusts only GitHub's own identity headers — 'github' in a proxy's name is not GitHub", () => {
    expect(classifyUpdateError(httpError(403, "Forbidden", "", GITHUB)).kind).not.toBe("intercepted");
    expect(classifyUpdateError(httpError(403, "Forbidden", "", { server: "github.com" })).kind).not.toBe("intercepted");
    expect(classifyUpdateError(httpError(403, "Forbidden", "", { server: "github-proxy" })).kind).toBe("intercepted");
    expect(classifyUpdateError(httpError(403, "Forbidden", "", { server: "notgithub.com" })).kind).toBe("intercepted");
  });

  it("reads the same 403 when GitHubProvider has wrapped it as a no-release message", () => {
    // /releases/latest failing is wrapped in "Unable to find latest version …",
    // with the HttpError's stack — and therefore its headers — embedded.
    const inner = httpError(403, "Forbidden", SIGN_IN_PAGE, { "content-type": "text/html" });
    const wrapped =
      "Unable to find latest version on GitHub (https://github.com/sapiom/sapiom-js/releases.atom), " +
      `please ensure a production release exists: HttpError: ${inner}\n    at GitHubProvider.getLatestTagName (…/GitHubProvider.js:173:55)`;
    expect(classifyUpdateError(wrapped).kind).toBe("intercepted");
  });

  it("recognises an HTML page where the Atom feed should be", () => {
    const raw =
      "Cannot parse releases feed: Error: No element \"link\"\n    at XElement.element (…/xml.js:36:19)" +
      ",\nXML:\n" +
      SIGN_IN_PAGE;
    expect(classifyUpdateError(raw).kind).toBe("intercepted");
  });

  it("says github.com is not reachable and what to check, without a vendor, a status code, an em dash or a semicolon", () => {
    const { summary } = classifyUpdateError("403 Forbidden");
    expect(summary).toBe(
      "github.com isn't reachable from this network. Check that you can open github.com, then try again.",
    );
    expect(summary).not.toMatch(/okta|403|\u2014|;/i);
    expect(summary.length).toBeLessThanOrEqual(160);
  });

  it("never reads a status code out of a URL", () => {
    // A 4xx-looking path segment with no HttpError head is not a status.
    for (const code of [403, 429]) {
      const raw = `Cannot download "https://github.com/sapiom/sapiom-js/releases/download/v0.4.9/x-${code}-y.zip"`;
      expect(classifyUpdateError(raw).kind).toBe("other");
    }
  });

  it("puts status, server and content-type — and nothing else — in the log detail", () => {
    const raw = httpError(403, "Forbidden", SIGN_IN_PAGE, {
      Server: "corp-proxy/2.1",
      "Content-Type": "text/html; charset=utf-8",
      Location: "https://sso.example.com/login?state=SECRET",
      "Set-Cookie": "session=SECRET; Path=/; HttpOnly",
    });
    const { detail } = classifyUpdateError(raw);
    expect(detail).toBe("status=403 server=corp-proxy/2.1 content-type=text/html; charset=utf-8");
    expect(classifyUpdateError("403 Forbidden").detail).toBe("status=403");
    expect(classifyUpdateError("connect ECONNREFUSED 140.82.121.3:443").detail).toBeUndefined();
  });
});
