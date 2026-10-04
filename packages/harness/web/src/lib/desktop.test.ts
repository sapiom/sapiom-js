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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  describeUpdateOutcome,
  getDesktopBridge,
  revealAgentFolder,
  revealLabel,
  revealPlatform,
} from "./desktop";

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
      sapiomDesktop: { appVersion: "0.1.2", checkForUpdates: noop },
    });
    expect(bridge).not.toBeNull();
    expect(bridge?.appVersion).toBe("0.1.2");
  });

  it("rejects a bridge missing its method — an older desktop build must read as a browser", () => {
    const host = { sapiomDesktop: { appVersion: "0.1.0" } };
    expect(getDesktopBridge(host)).toBeNull();
  });

  it("tolerates a missing appVersion rather than refusing the bridge", () => {
    // Cosmetic field; losing it must not cost the user the button.
    const host = { sapiomDesktop: { checkForUpdates: noop } };
    expect(getDesktopBridge(host)?.appVersion).toBe("");
  });

  it("ignores junk", () => {
    for (const junk of [null, 0, "yes", true, {}, []]) {
      expect(getDesktopBridge({ sapiomDesktop: junk })).toBeNull();
    }
  });

  it("degrades onUpdateState to undefined on an older desktop build", () => {
    // The subscription is optional: without it the "Update now" card simply
    // never renders — the bridge itself must still be accepted.
    const older = getDesktopBridge({
      sapiomDesktop: { appVersion: "0.2.0", checkForUpdates: noop },
    });
    expect(older).not.toBeNull();
    expect(older?.onUpdateState).toBeUndefined();

    const current = getDesktopBridge({
      sapiomDesktop: {
        appVersion: "0.3.0",
        checkForUpdates: noop,
        onUpdateState: () => () => {},
      },
    });
    expect(typeof current?.onUpdateState).toBe("function");
  });

  it("degrades chooseDirectory to undefined on an older desktop build or browser", () => {
    /* THIS ONE CARRIES THE WHOLE FOLDER PICKER NOW. The SPA used to keep an
       in-app directory listing beside it, so a missing `chooseDirectory` cost
       only a shortcut. With that listing deleted, the browser host's fallback is
       the field itself — so the caller MUST see `undefined` rather than a
       method that rejects, which is how `FolderField` knows not to render a
       Choose button that cannot work. */
    const older = getDesktopBridge({
      sapiomDesktop: { appVersion: "0.2.0", checkForUpdates: noop },
    });
    expect(older).not.toBeNull();
    expect(older?.chooseDirectory).toBeUndefined();

    const current = getDesktopBridge({
      sapiomDesktop: {
        appVersion: "0.3.0",
        checkForUpdates: noop,
        chooseDirectory: () => Promise.resolve("/Users/demo/acme-app"),
      },
    });
    expect(typeof current?.chooseDirectory).toBe("function");
  });

  it("degrades pathForFile to undefined on an older desktop build or browser", () => {
    // Without it a drop on the terminal simply does nothing — the bridge
    // itself must still be accepted.
    const older = getDesktopBridge({
      sapiomDesktop: { appVersion: "0.2.0", checkForUpdates: noop },
    });
    expect(older).not.toBeNull();
    expect(older?.pathForFile).toBeUndefined();

    const current = getDesktopBridge({
      sapiomDesktop: {
        appVersion: "0.3.0",
        checkForUpdates: noop,
        pathForFile: () => "/tmp/shot.png",
      },
    });
    expect(typeof current?.pathForFile).toBe("function");
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

  it("reports an empty channel as a state, not a failure", () => {
    // This is the normal answer before the first final release ships, and calling
    // it an error teaches users to distrust the feature.
    const view = describeUpdateOutcome({ kind: "no-release", channel: "latest" });
    expect(view.tone).toBe("info");
    expect(view.text).toContain("latest");
  });

  it("surfaces why updates are off, and the failure reason", () => {
    expect(describeUpdateOutcome({ kind: "disabled", reason: "not a packaged build" })).toEqual({
      text: "Updates are off: not a packaged build.",
      tone: "error",
    });
    expect(describeUpdateOutcome({ kind: "failed", message: "network down" }).tone).toBe("error");
  });

  it("offers a restart for exactly one outcome", () => {
    // Exactly one outcome means "you must restart" — the desktop app raises that
    // prompt itself, so a second actionable state here would be a claim nothing
    // acts on.
    const outcomes: Parameters<typeof describeUpdateOutcome>[0][] = [
      { kind: "available", version: "1.0.0" },
      { kind: "downloaded", version: "1.0.0" },
      { kind: "up-to-date", version: "1.0.0", channel: "latest" },
      { kind: "no-release", channel: "latest" },
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
      { kind: "no-release" as const, channel: "latest" },
      { kind: "disabled" as const, reason: "x" },
      { kind: "failed" as const, message: "x" },
    ]) {
      expect(describeUpdateOutcome(o).text.length).toBeGreaterThan(0);
    }
  });
});

describe("revealAgentFolder", () => {
  const agent = "/Users/me/agents/price-watch";
  const refuse = (): Promise<Response> => Promise.reject(new Error("fetch not expected"));

  // The route path reads the boot token off `window.__HARNESS__`; the Node
  // runner has no window.
  beforeEach(() => {
    vi.stubGlobal("window", { __HARNESS__: { token: "boot-token" } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the desktop bridge when it has revealPath, and never the server", async () => {
    const calls: string[] = [];
    const host = {
      sapiomDesktop: {
        checkForUpdates: noop,
        revealPath: async (p: string) => {
          calls.push(p);
          return true;
        },
      },
    };
    await expect(revealAgentFolder(agent, { host, fetch: refuse, mock: false })).resolves.toBe(true);
    expect(calls).toEqual([agent]);
  });

  it("reports a bridge refusal or rejection as false rather than throwing", async () => {
    const refusing = { sapiomDesktop: { checkForUpdates: noop, revealPath: async () => false } };
    const throwing = { sapiomDesktop: { checkForUpdates: noop, revealPath: noop } };
    await expect(revealAgentFolder(agent, { host: refusing, fetch: refuse, mock: false })).resolves.toBe(false);
    await expect(revealAgentFolder(agent, { host: throwing, fetch: refuse, mock: false })).resolves.toBe(false);
  });

  it("falls back to POST /api/fs/reveal in a browser and on an older desktop build", async () => {
    for (const host of [{}, { sapiomDesktop: { checkForUpdates: noop } }]) {
      const requests: Array<{ url: string; init?: RequestInit }> = [];
      const fetchStub = (async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        return new Response(null, { status: 204 });
      }) as typeof fetch;
      await expect(revealAgentFolder(agent, { host, fetch: fetchStub, mock: false })).resolves.toBe(true);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("/api/fs/reveal");
      expect(requests[0]?.init?.method).toBe("POST");
      expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ path: agent });
      expect((requests[0]?.init?.headers as Record<string, string>)["X-Harness-Token"]).toBe("boot-token");
    }
  });

  it("reports a 403 from the server, or a network failure, as false", async () => {
    const forbidden = (async () => new Response(null, { status: 403 })) as typeof fetch;
    const offline = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    await expect(revealAgentFolder(agent, { host: {}, fetch: forbidden, mock: false })).resolves.toBe(false);
    await expect(revealAgentFolder(agent, { host: {}, fetch: offline, mock: false })).resolves.toBe(false);
  });

  it("touches neither the network nor the bridge in mock mode", async () => {
    let bridgeCalls = 0;
    const host = {
      sapiomDesktop: {
        checkForUpdates: noop,
        revealPath: async () => {
          bridgeCalls += 1;
          return false;
        },
      },
    };
    await expect(revealAgentFolder(agent, { host: {}, fetch: refuse, mock: true })).resolves.toBe(true);
    await expect(revealAgentFolder(agent, { host, fetch: refuse, mock: true })).resolves.toBe(true);
    expect(bridgeCalls).toBe(0);
  });
});

describe("revealPlatform and revealLabel", () => {
  it("names each OS's file manager in its own words", () => {
    expect(revealLabel("mac")).toBe("Open in Finder");
    expect(revealLabel("windows")).toBe("Show in Explorer");
    expect(revealLabel("linux")).toBe("Open folder");
  });

  it("reads the platform from userAgentData first, then navigator.platform", () => {
    expect(revealPlatform({ navigator: { platform: "MacIntel" } })).toBe("mac");
    expect(revealPlatform({ navigator: { platform: "Win32" } })).toBe("windows");
    expect(revealPlatform({ navigator: { platform: "Linux x86_64" } })).toBe("linux");
    expect(revealPlatform({ navigator: { platform: "Linux", userAgentData: { platform: "Windows" } } })).toBe(
      "windows",
    );
  });

  it("reads an unknown or missing platform as Linux, the least specific label", () => {
    expect(revealPlatform({})).toBe("linux");
    expect(revealPlatform({ navigator: {} })).toBe("linux");
  });
});
