/**
 * Unit tests for `formatUsd`.
 *
 * Pure, DOM-free — runs under vitest node.
 */
import { describe, expect, it } from "vitest";

import { formatUsd } from "./format-usd";

describe("formatUsd", () => {
  it('returns "$0.00" for NaN input (unparseable string)', () => {
    expect(formatUsd("not-a-number")).toBe("$0.00");
    expect(formatUsd("")).toBe("$0.00");
  });

  it('returns "$0.00" for zero', () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd("0")).toBe("$0.00");
    expect(formatUsd("0.00")).toBe("$0.00");
  });

  it("formats values >= 1 with 2 decimal places", () => {
    expect(formatUsd(1)).toBe("$1.00");
    expect(formatUsd("28.630476")).toBe("$28.63");
    expect(formatUsd(100)).toBe("$100.00");
    expect(formatUsd("1.5")).toBe("$1.50");
  });

  it("formats values between 0 and 1 with up to 4 significant decimal digits trimmed", () => {
    // 0.809676 → 4 sig figs → 0.8097
    expect(formatUsd("0.809676")).toBe("$0.8097");
    // 0.05 → already only 1 sig fig of significance, 4 sig figs → 0.05000 → trimmed → 0.05
    expect(formatUsd("0.05")).toBe("$0.05");
    // 0.1 → 4 sig figs → 0.1000 → trimmed → 0.10 (2dp minimum)
    expect(formatUsd("0.1")).toBe("$0.10");
    // 0.001 → 4 sig figs → 0.001000 → trimmed → 0.001 (3dp, already above 2dp minimum)
    expect(formatUsd("0.001")).toBe("$0.001");
  });

  it("accepts a numeric value directly", () => {
    expect(formatUsd(28.630476)).toBe("$28.63");
    expect(formatUsd(0.809676)).toBe("$0.8097");
  });
});
