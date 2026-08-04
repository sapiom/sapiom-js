/**
 * Display mode is two facts, not one: the *setting* (light / dark / system)
 * and the *theme* it resolves to right now. These tests pin the pure half —
 * the mapping between them, and what a page falls back to when nothing has
 * been chosen — which is what the pre-paint script in web/index.html
 * reimplements in plain JS and must keep agreeing with.
 */
import { describe, expect, it } from "vitest";

import { normalizeDisplayMode, resolveTheme } from "./theme";

describe("resolveTheme", () => {
  it("pins light and dark regardless of what the OS says", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("follows the OS in system mode", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});

describe("normalizeDisplayMode", () => {
  it("accepts the three modes", () => {
    expect(normalizeDisplayMode("light")).toBe("light");
    expect(normalizeDisplayMode("dark")).toBe("dark");
    expect(normalizeDisplayMode("system")).toBe("system");
  });

  it("rejects anything else, so a stale or hand-edited value can't paint", () => {
    // Undefined rather than a substituted default: each caller has its own next
    // source to try (injected attribute → localStorage → legacy key → dark).
    for (const junk of ["sepia", "", null, undefined, 1, {}]) {
      expect(normalizeDisplayMode(junk)).toBeUndefined();
    }
  });
});
