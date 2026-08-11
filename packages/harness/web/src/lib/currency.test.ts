import { describe, expect, it } from "vitest";

import { formatUsd } from "./currency";

describe("formatUsd", () => {
  it("drops cents on whole dollars", () => {
    expect(formatUsd(50)).toBe("$50");
    expect(formatUsd(0)).toBe("$0");
  });

  it("keeps exactly two decimals otherwise", () => {
    expect(formatUsd(12.4)).toBe("$12.40");
    expect(formatUsd(0.5)).toBe("$0.50");
  });

  it("rounds sub-cent residue from upstream decimal strings", () => {
    expect(formatUsd(12.399999999)).toBe("$12.40");
    expect(formatUsd(49.999999)).toBe("$50");
  });
});
