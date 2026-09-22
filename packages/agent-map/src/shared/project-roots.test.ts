import { expect, it } from "vitest";
import { matchProjectRootForPath } from "./project-roots.js";

it.each([
  ["/repo", "/repo/../other"],
  ["C:\\Repo", "c:/repo/../Other"],
  ["\\\\server\\share\\repo", "//SERVER/share/repo/../other"],
])("does not resolve a traversal outside %s", (cwd, target) => {
  expect(matchProjectRootForPath(target, [{ projectId: "one", cwd }])).toEqual({
    kind: "unregistered",
  });
});

it.each([
  ["/repo/unused/..", "/repo//./src/../src"],
  ["C:\\Repo\\unused\\..", "c:/repo//./src\\..\\src"],
  ["\\\\server\\share\\repo\\unused\\..", "//SERVER/share/repo//./src/../src"],
])(
  "normalizes both inputs and preserves the original root %s",
  (cwd, target) => {
    const root = { projectId: "one", cwd, label: "Original" };
    const result = matchProjectRootForPath(target, [root]);
    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved") expect(result.root).toBe(root);
  },
);

it.each([
  ["/repo", "/../../repo/src"],
  ["C:\\Repo", "c:/../../repo/src"],
  ["\\\\server\\share\\repo", "//SERVER/share/../../repo/src"],
])(
  "keeps traversal within the filesystem or share root of %s",
  (cwd, target) => {
    const root = { projectId: "one", cwd };
    expect(matchProjectRootForPath(target, [root])).toEqual({
      kind: "resolved",
      root,
    });
  },
);

it("ranks normalized depths rather than the spelling of a root", () => {
  const outer = { projectId: "outer", cwd: "/repo/unused/.././" };
  const inner = { projectId: "inner", cwd: "/repo/app" };
  expect(matchProjectRootForPath("/repo/app/src", [outer, inner])).toEqual({
    kind: "resolved",
    root: inner,
  });
});

it("reports ambiguity for equivalent normalized roots from different projects", () => {
  expect(
    matchProjectRootForPath("/repo/src", [
      { projectId: "two", cwd: "/repo/unused/.." },
      { projectId: "one", cwd: "/repo" },
    ]),
  ).toEqual({ kind: "ambiguous", projectIds: ["one", "two"] });
});

it("selects equivalent same-project bindings independently of input order", () => {
  const first = { projectId: "one", cwd: "/repo" };
  const second = { projectId: "one", cwd: "/repo/unused/.." };
  for (const roots of [
    [first, second],
    [second, first],
  ]) {
    expect(matchProjectRootForPath("/repo/src", roots)).toEqual({
      kind: "resolved",
      root: first,
    });
  }
});
