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
    reset: vi.fn(),
    capture: vi.fn(),
  };
  return m;
});

vi.mock("posthog-js", () => ({ default: ph }));

import { initAnalytics, resetAnalyticsForTest } from "./posthog";

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
