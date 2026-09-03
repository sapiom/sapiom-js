import { describe, it, expect } from "vitest";

import { deepLinkFromSearch, tabFromSearch } from "./deep-link";

describe("tabFromSearch", () => {
  it("reads a known tab", () => {
    expect(tabFromSearch("?tab=versions")).toBe("versions");
    expect(tabFromSearch("?tab=canvas")).toBe("canvas");
  });

  /**
   * Falls through to the stored preference rather than wedging the pane on a
   * tab that does not exist — the same failure the stored-value guard already
   * handles for the removed "skills" tab.
   */
  it("ignores an unknown tab", () => {
    expect(tabFromSearch("?tab=skills")).toBeNull();
    expect(tabFromSearch("?tab=")).toBeNull();
  });

  it("is null when the param is absent", () => {
    expect(tabFromSearch("?agent=46")).toBeNull();
    expect(tabFromSearch("")).toBeNull();
  });

  it("coexists with the agent deep link", () => {
    expect(tabFromSearch("?agent=46&tab=versions")).toBe("versions");
    expect(deepLinkFromSearch("?agent=46&tab=versions")).toEqual({
      kind: "agent",
      definitionId: "46",
    });
  });
});
