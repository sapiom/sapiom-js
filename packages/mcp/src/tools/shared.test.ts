/**
 * `capText` — the hard char-budget primitive execution-projection.ts relies on
 * to keep every field bounded "for ANY argument combination" (see that
 * module's doc comment). Regression coverage for a bug where the truncation
 * marker appended after slicing pushed the result past `budget`, since the
 * marker's own length was never subtracted from the content slice.
 */
import { describe, it, expect } from "vitest";
import { capText } from "./shared.js";

describe("capText", () => {
  it("returns text unchanged when it already fits the budget", () => {
    expect(capText("hello", 10)).toBe("hello");
    expect(capText("hello", 5)).toBe("hello");
  });

  it("never returns a string longer than budget, with a webappUrl", () => {
    const text = "x".repeat(50_000);
    const budget = 2_000;
    const result = capText(text, budget, "https://app.sapiom.ai/runs/exec-1");
    expect(result.length).toBeLessThanOrEqual(budget);
    expect(result).toContain("truncated");
    expect(result).toContain("app.sapiom.ai");
  });

  it("never returns a string longer than budget, without a webappUrl", () => {
    const text = "x".repeat(50_000);
    const budget = 2_000;
    const result = capText(text, budget);
    expect(result.length).toBeLessThanOrEqual(budget);
    expect(result).toContain("truncated");
  });

  it("reports an accurate dropped-char count consistent with the actual slice", () => {
    const text = "x".repeat(50_000);
    const budget = 2_000;
    const result = capText(text, budget, "https://app.sapiom.ai/runs/exec-1");
    const match = result.match(/truncated (\d+) chars/);
    expect(match).not.toBeNull();
    const dropped = Number(match![1]);
    // The content actually kept plus what's reported dropped must equal the
    // original length — this is only true if `dropped` is computed from the
    // real (marker-adjusted) slice point, not the naive `text.length - budget`.
    const keptLen = result.length - result.slice(result.indexOf("…")).length;
    expect(keptLen + dropped).toBe(text.length);
  });

  it("stays within budget across a range of budgets, including budgets too small for the marker itself", () => {
    const text = "x".repeat(10_000);
    for (const budget of [0, 1, 5, 10, 20, 50, 100, 500, 2_000, 32_000]) {
      const withUrl = capText(text, budget, "https://app.sapiom.ai/x");
      const withoutUrl = capText(text, budget);
      expect(withUrl.length).toBeLessThanOrEqual(budget);
      expect(withoutUrl.length).toBeLessThanOrEqual(budget);
    }
  });

  it("stays within budget for inputs just over the limit", () => {
    for (const over of [1, 10, 100]) {
      const budget = 2_000;
      const text = "x".repeat(budget + over);
      const result = capText(text, budget, "https://app.sapiom.ai/x");
      expect(result.length).toBeLessThanOrEqual(budget);
    }
  });
});
