import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppState } from "@shared/types";

// Mock the posthog-js singleton so we can assert on init/opt-in/opt-out without
// a browser. `vi.hoisted` so the mock object exists before the hoisted vi.mock
// factory references it. Also satisfies events.ts's import (register/capture).
const ph = vi.hoisted(() => {
  const m: {
    __loaded: boolean;
    init: ReturnType<typeof vi.fn>;
    opt_in_capturing: ReturnType<typeof vi.fn>;
    opt_out_capturing: ReturnType<typeof vi.fn>;
    has_opted_out_capturing: ReturnType<typeof vi.fn>;
    identify: ReturnType<typeof vi.fn>;
    group: ReturnType<typeof vi.fn>;
    register: ReturnType<typeof vi.fn>;
    unregister: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
    capture: ReturnType<typeof vi.fn>;
  } = {
    __loaded: false,
    init: vi.fn(() => {
      m.__loaded = true;
    }),
    opt_in_capturing: vi.fn(),
    opt_out_capturing: vi.fn(),
    has_opted_out_capturing: vi.fn(() => false),
    identify: vi.fn(),
    group: vi.fn(),
    register: vi.fn(),
    unregister: vi.fn(),
    reset: vi.fn(),
    capture: vi.fn(),
  };
  return m;
});

vi.mock("posthog-js", () => ({ default: ph }));

import { resetStudioBootIdForTest } from "./events";
import { initAnalytics, resetAnalyticsForTest, syncHarnessKind } from "./posthog";

function appState(over: Partial<AppState> = {}): AppState {
  return {
    version: "test",
    authenticated: true,
    userId: "u1",
    tenantId: "t1",
    organizationName: "Acme",
    telemetryOptIn: false,
    productAnalyticsOptIn: true,
    sessions: [],
    workflows: [],
    macros: [],
    launchDir: "/tmp",
    ...over,
  } as AppState;
}

describe("initAnalytics consent gate", () => {
  beforeEach(() => {
    resetAnalyticsForTest();
    ph.__loaded = false;
    for (const fn of [
      ph.init,
      ph.opt_in_capturing,
      ph.opt_out_capturing,
      ph.identify,
      ph.group,
      ph.reset,
    ]) {
      fn.mockClear();
    }
    ph.has_opted_out_capturing.mockReturnValue(false);
    vi.stubGlobal("window", {
      __HARNESS__: { posthog: { key: "phc_test", apiHost: "https://h", uiHost: "https://u" } },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does NOT init when env-forced-off — the hard kill-switch always wins", () => {
    initAnalytics(appState({ consentSource: "env-forced-off" }));
    expect(ph.init).not.toHaveBeenCalled();
  });

  it("does NOT init when light product analytics is opted out", () => {
    initAnalytics(appState({ productAnalyticsOptIn: false }));
    expect(ph.init).not.toHaveBeenCalled();
  });

  it("inits, identifies, and binds the org group when consent is on", () => {
    initAnalytics(appState());
    expect(ph.init).toHaveBeenCalledTimes(1);
    expect(ph.identify).toHaveBeenCalledWith("u1");
    expect(ph.group).toHaveBeenCalledWith(
      "organization",
      "t1",
      expect.objectContaining({ name: "Acme" }),
    );
  });

  it("never captures without an injected key (analytics disabled)", () => {
    vi.stubGlobal("window", { __HARNESS__: {} });
    initAnalytics(appState());
    expect(ph.init).not.toHaveBeenCalled();
  });

  it("opts out when consent flips off after init", () => {
    initAnalytics(appState());
    expect(ph.init).toHaveBeenCalledTimes(1);
    initAnalytics(appState({ productAnalyticsOptIn: false }));
    expect(ph.opt_out_capturing).toHaveBeenCalled();
  });

  it("inits lazily only once consent flips on", () => {
    initAnalytics(appState({ productAnalyticsOptIn: false }));
    expect(ph.init).not.toHaveBeenCalled();
    initAnalytics(appState({ productAnalyticsOptIn: true }));
    expect(ph.init).toHaveBeenCalledTimes(1);
  });
});

describe("boot context super-properties", () => {
  beforeEach(() => {
    resetAnalyticsForTest();
    resetStudioBootIdForTest();
    ph.__loaded = false;
    for (const fn of [ph.init, ph.register, ph.reset, ph.unregister, ph.identify]) fn.mockClear();
    ph.has_opted_out_capturing.mockReturnValue(false);
    vi.stubGlobal("window", {
      __HARNESS__: { posthog: { key: "phc_test", apiHost: "https://h", uiHost: "https://u" } },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** The merged object of every `posthog.register` call, newest value winning. */
  function registered(): Record<string, unknown> {
    return Object.assign({}, ...ph.register.mock.calls.map((c) => c[0] as Record<string, unknown>));
  }

  it('reports harness_host "cli" in a plain browser (no desktop bridge)', () => {
    initAnalytics(appState());
    expect(registered().harness_host).toBe("cli");
  });

  it('reports harness_host "desktop" when the Electron bridge is present', () => {
    vi.stubGlobal("window", {
      __HARNESS__: { posthog: { key: "phc_test", apiHost: "https://h", uiHost: "https://u" } },
      // getDesktopBridge validates the shape, not just the flag.
      sapiomDesktop: { appVersion: "1.2.3", checkForUpdates: () => Promise.resolve({ kind: "up-to-date" }) },
    });
    initAnalytics(appState());
    expect(registered().harness_host).toBe("desktop");
  });

  it("registers a studio_boot_id, stable across re-syncs within one load", () => {
    initAnalytics(appState());
    const first = registered().studio_boot_id;
    expect(typeof first).toBe("string");
    expect(first).not.toBe("");
    initAnalytics(appState());
    expect(registered().studio_boot_id).toBe(first);
  });

  it("registers boot context BEFORE anything else, so the first pageview carries it", () => {
    initAnalytics(appState());
    // posthog-js defers the initial $pageview behind setTimeout(…, 1); the
    // guarantee we need is that register ran synchronously during init.
    const initOrder = ph.init.mock.invocationCallOrder[0];
    const firstRegisterOrder = ph.register.mock.invocationCallOrder[0];
    expect(firstRegisterOrder).toBeGreaterThan(initOrder);
    expect(ph.capture).not.toHaveBeenCalled();
  });

  it("re-registers host and boot id after a sign-out reset clears them", () => {
    initAnalytics(appState());
    const bootId = registered().studio_boot_id;
    ph.register.mockClear();

    // Identified → anonymous is the only path that calls reset().
    initAnalytics(appState({ authenticated: false, userId: null }));
    expect(ph.reset).toHaveBeenCalledTimes(1);
    expect(registered()).toMatchObject({ harness_host: "cli", studio_boot_id: bootId });
  });

  it("stamps the active session's agent, and clears it when none is active", () => {
    initAnalytics(appState());
    syncHarnessKind("claude-code");
    expect(registered().harness_kind).toBe("claude-code");
    syncHarnessKind(null);
    expect(ph.unregister).toHaveBeenCalledWith("harness_kind");
  });
});
