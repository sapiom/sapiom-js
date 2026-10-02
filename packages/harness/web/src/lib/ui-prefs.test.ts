import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadUiPrefs, saveUiPrefs } from "./ui-prefs";

/**
 * `hiddenSessionIds` (flow-navigation.md Q4) rides the same one-blob store as
 * every other preference, so the two things to pin are the round trip and an
 * install whose stored prefs predate the field.
 */

const KEY = "sapiom-harness-ui-prefs";

function installStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  });
  return store;
}

describe("ui-prefs hiddenSessionIds", () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = installStorage();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("round-trips the hidden set", () => {
    saveUiPrefs({ hiddenSessionIds: ["sess-a", "sess-b"] });
    expect(loadUiPrefs().hiddenSessionIds).toEqual(["sess-a", "sess-b"]);
  });

  it("merges with the slices other owners persisted", () => {
    saveUiPrefs({ railCollapsed: true });
    saveUiPrefs({ hiddenSessionIds: ["sess-a"] });
    expect(loadUiPrefs()).toEqual({ railCollapsed: true, hiddenSessionIds: ["sess-a"] });
  });

  it("reads prefs stored before the field existed as nothing hidden", () => {
    store.set(KEY, JSON.stringify({ rightCollapsed: true, railAxis: "group" }));
    const prefs = loadUiPrefs();
    expect(prefs.hiddenSessionIds).toBeUndefined();
    expect(new Set(prefs.hiddenSessionIds ?? []).size).toBe(0);
    expect(prefs.rightCollapsed).toBe(true);
  });

  it("falls back to defaults when the stored blob is corrupt", () => {
    store.set(KEY, "{not json");
    expect(loadUiPrefs()).toEqual({});
  });
});
