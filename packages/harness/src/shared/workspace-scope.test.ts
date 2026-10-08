import { describe, expect, it } from "vitest";
import { workspaceRelativeLocalKey } from "./workspace-scope.js";

describe("workspaceRelativeLocalKey", () => {
  it.each([
    ["/repo", "/repo/./agents/../worker", "local:worker"],
    ["/repo", "/repository/worker", null],
    ["/repo", "/repo/../outside", null],
    ["/repo", "/REPO/worker", null],
    ["C:/Repo", "c:/repo/agents/Worker", "local:agents/Worker"],
    ["C:/Repo", "D:/Repo/worker", null],
    ["//server/share/repo", "//SERVER/SHARE/repo/worker", "local:worker"],
    ["//server/share/repo", "//server/other/repo/worker", null],
    ["/repo", "repo/worker", null],
    ["/repo", "/../../repo/worker", null],
  ])("resolves %s → %s without crossing scope boundaries", (root, source, expected) => {
    expect(workspaceRelativeLocalKey(root!, source!)).toBe(expected);
  });

  it("uses a checkout-invariant shared local key for a scope-root agent", () => {
    expect(workspaceRelativeLocalKey("/checkouts/one", "/checkouts/one")).toBe(
      "local:root",
    );
    expect(
      workspaceRelativeLocalKey("/different/name", "/different/name"),
    ).toBe("local:root");
  });

});
