import { describe, it, expect } from "vitest";

import { capText } from "./shared.js";

describe("capText", () => {
  it("returns text unchanged when it already fits the budget", () => {
    const text = "x".repeat(50);
    expect(capText(text, 100)).toBe(text);
    expect(capText(text, 50)).toBe(text);
  });

  it("never exceeds the budget, without a webappUrl", () => {
    const text = "x".repeat(5000);
    const result = capText(text, 2000);
    expect(result.length).toBeLessThanOrEqual(2000);
    expect(result).toContain("[truncated");
  });

  it("never exceeds the budget, with a webappUrl (the case that previously overshot)", () => {
    const text = "x".repeat(5000);
    const result = capText(
      text,
      2000,
      "https://app.sapiom.ai/executions/abc123def456",
    );
    expect(result.length).toBeLessThanOrEqual(2000);
    expect(result).toContain("[truncated");
    expect(result).toContain("app.sapiom.ai");
  });

  it("stays within budget at the default field budget (32k) on a multi-MB body", () => {
    const text = "x".repeat(3_000_000);
    const result = capText(
      text,
      32_000,
      "https://app.sapiom.ai/executions/abc123def456",
    );
    expect(result.length).toBeLessThanOrEqual(32_000);
  });

  it("stays within budget at the small preview budget (2k)", () => {
    const text = "x".repeat(50_000);
    const result = capText(
      text,
      2_000,
      "https://app.sapiom.ai/executions/abc123def456",
    );
    expect(result.length).toBeLessThanOrEqual(2_000);
  });

  it("reports an honest dropped-char count that matches what was actually kept", () => {
    const text = "x".repeat(5000);
    const result = capText(
      text,
      2000,
      "https://app.sapiom.ai/executions/abc123def456",
    );
    const match = result.match(/\[truncated (\d+) chars/);
    expect(match).not.toBeNull();
    const reportedDropped = Number(match![1]);
    // The slice kept plus the reported drop count must reconstruct the
    // original length — the count has to describe the actual output, not
    // a stale estimate from before the marker's own size was accounted for.
    const markerStart = result.indexOf("…[truncated");
    const keptLen = markerStart === -1 ? result.length : markerStart;
    expect(keptLen + reportedDropped).toBe(text.length);
  });

  it("degrades gracefully when the budget is smaller than the marker itself", () => {
    const text = "x".repeat(50);
    // No realistic caller passes a budget this small (defaults are 2_000 and
    // 32_000), but the function should still terminate and produce a
    // well-formed marker rather than slicing negatively or looping forever.
    const result = capText(text, 10);
    expect(result).toContain("[truncated");
    expect(() => capText(text, 0)).not.toThrow();
  });
});
