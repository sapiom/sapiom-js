import { describe, expect, it } from "vitest";

import { relativeTimeLabel } from "./relative-time";

const MINUTE = 60_000;

describe("relativeTimeLabel", () => {
  it("reads 'just now' inside the first 45 seconds", () => {
    expect(relativeTimeLabel(0, 0)).toBe("just now");
    expect(relativeTimeLabel(0, 44_000)).toBe("just now");
  });

  it("rounds to coarse minute/hour/day buckets (no fake precision)", () => {
    expect(relativeTimeLabel(0, 5 * MINUTE)).toBe("5m ago");
    expect(relativeTimeLabel(0, 3 * 60 * MINUTE)).toBe("3h ago");
    expect(relativeTimeLabel(0, 48 * 60 * MINUTE)).toBe("2d ago");
  });

  it("clock skew (observation in the future) clamps to 'just now'", () => {
    expect(relativeTimeLabel(10_000, 0)).toBe("just now");
  });
});
