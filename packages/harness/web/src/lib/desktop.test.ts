/**
 * Two properties matter here, and both are about NOT breaking the browser build.
 *
 * `getDesktopBridge` is the only thing standing between a browser user and a
 * button that cannot work. It validates the shape rather than trusting a flag,
 * because a desktop build older than the SPA can expose a bridge missing a newer
 * method — and reading that inside a click handler is a dead button with a console
 * error nobody sees. Anything unrecognised must read as "browser".
 *
 * `describeUpdateOutcome` must give every outcome its own next step. Collapsing
 * them into one cheerful message would make the button as uninformative as no
 * message at all — especially "downloaded", where the user has to restart and
 * nothing else will tell them.
 */
import { describe, expect, it } from "vitest";

import { describeUpdateOutcome, getDesktopBridge } from "./desktop";

const noop = (): Promise<never> => Promise.reject(new Error("not called"));

describe("getDesktopBridge", () => {
  it("returns null when there is no host at all (the unit runner, or SSR)", () => {
    expect(getDesktopBridge(undefined)).toBeNull();
  });

  it("returns null in a browser — nothing was injected", () => {
    expect(getDesktopBridge({})).toBeNull();
  });

  it("returns the bridge when the desktop preload injected a complete one", () => {
    const bridge = getDesktopBridge({
      sapiomDesktop: { appVersion: "0.1.2", checkForUpdates: noop, restartToUpdate: noop },
    });
    expect(bridge).not.toBeNull();
    expect(bridge?.appVersion).toBe("0.1.2");
  });

  it("rejects a bridge missing a method — an older desktop build must read as a browser", () => {
    const host = { sapiomDesktop: { appVersion: "0.1.0", checkForUpdates: noop } };
    expect(getDesktopBridge(host)).toBeNull();
  });

  it("tolerates a missing appVersion rather than refusing the bridge", () => {
    // Cosmetic field; losing it must not cost the user the button.
    const host = { sapiomDesktop: { checkForUpdates: noop, restartToUpdate: noop } };
    expect(getDesktopBridge(host)?.appVersion).toBe("");
  });

  it("ignores junk", () => {
    for (const junk of [null, 0, "yes", true, {}, []]) {
      expect(getDesktopBridge({ sapiomDesktop: junk })).toBeNull();
    }
  });
});

describe("describeUpdateOutcome", () => {
  it("distinguishes downloading from ready-to-install", () => {
    // The distinction IS the information: one means wait, the other means restart.
    expect(describeUpdateOutcome({ kind: "available", version: "0.2.0" })).toEqual({
      text: "Downloading 0.2.0…",
      tone: "info",
    });
    expect(describeUpdateOutcome({ kind: "downloaded", version: "0.2.0" })).toEqual({
      text: "0.2.0 is ready to install.",
      tone: "action",
    });
  });

  it("names the version AND channel when up to date", () => {
    // "Up to date" is only trustworthy if it says up to date with WHAT — a beta
    // install and a stable one are up to date at different versions.
    const view = describeUpdateOutcome({ kind: "up-to-date", version: "0.1.2", channel: "beta" });
    expect(view.text).toContain("0.1.2");
    expect(view.text).toContain("beta");
    expect(view.tone).toBe("info");
  });

  it("surfaces why updates are off, and the failure reason", () => {
    expect(describeUpdateOutcome({ kind: "disabled", reason: "not a packaged build" })).toEqual({
      text: "Updates are off: not a packaged build.",
      tone: "error",
    });
    expect(describeUpdateOutcome({ kind: "failed", message: "network down" }).tone).toBe("error");
  });

  it("offers a restart for exactly one outcome", () => {
    // The Settings row keys its restart button off `tone === "action"`, so an
    // extra one here would offer a restart with nothing downloaded.
    const outcomes: Parameters<typeof describeUpdateOutcome>[0][] = [
      { kind: "available", version: "1.0.0" },
      { kind: "downloaded", version: "1.0.0" },
      { kind: "up-to-date", version: "1.0.0", channel: "latest" },
      { kind: "disabled", reason: "x" },
      { kind: "failed", message: "x" },
    ];
    const actionable = outcomes.filter((o) => describeUpdateOutcome(o).tone === "action");
    expect(actionable).toEqual([{ kind: "downloaded", version: "1.0.0" }]);
  });

  it("always produces non-empty text", () => {
    for (const o of [
      { kind: "available" as const, version: "1.0.0" },
      { kind: "downloaded" as const, version: "1.0.0" },
      { kind: "up-to-date" as const, version: "1.0.0", channel: "latest" },
      { kind: "disabled" as const, reason: "x" },
      { kind: "failed" as const, message: "x" },
    ]) {
      expect(describeUpdateOutcome(o).text.length).toBeGreaterThan(0);
    }
  });
});
