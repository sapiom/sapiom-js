import { describe, expect, it } from "vitest";

import { getByAgentPath } from "./agent-path-lookup";

describe("getByAgentPath", () => {
  it("reads the exact key", () => {
    expect(getByAgentPath(new Map([["/p/leasing", 1]]), "/p/leasing")).toBe(1);
  });

  it("reads a key spelled with a trailing separator", () => {
    expect(getByAgentPath(new Map([["/p/leasing/", ["exec-1"]]]), "/p/leasing")).toEqual([
      "exec-1",
    ]);
  });

  it("is undefined for another agent", () => {
    expect(getByAgentPath(new Map([["/p/leasing", 1]]), "/p/rfq")).toBeUndefined();
  });
});
