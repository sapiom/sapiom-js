import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { isWithinWorkspacePath, sourceRootsWithinScope } from "./workspace-path.js";

describe("workspace source containment", () => {
  it.each([
    ["/repo", "/repo", true],
    ["/repo", "/repo/agent", true],
    ["/repo", "/repo-other/agent", false],
    ["/repo", "/repo/../outside", false],
    ["C:/Repo", "c:/repo/Agent", true],
    ["C:/Repo", "D:/Repo/Agent", false],
    ["//server/share/repo", "//server/other/repo/Agent", false],
  ] as const)("contains %s → %s: %s", (root, candidate, expected) => {
    expect(isWithinWorkspacePath(root, candidate)).toBe(expected);
  });

  it("matches canonical workflow roots beneath a symlinked workspace", async () => {
    if (process.platform === "win32") return;
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "workspace-symlink-"),
    );
    try {
      const workspaceRoot = path.join(tempRoot, "real-workspace");
      const agentRoot = path.join(workspaceRoot, "agent");
      const nestedRoot = path.join(agentRoot, "nested-agent");
      const outsideRoot = path.join(tempRoot, "outside", "agent");
      const linkedRoot = path.join(tempRoot, "linked-workspace");
      await Promise.all([
        fs.mkdir(nestedRoot, { recursive: true }),
        fs.mkdir(outsideRoot, { recursive: true }),
      ]);
      await fs.symlink(workspaceRoot, linkedRoot, "dir");

      expect(
        sourceRootsWithinScope(linkedRoot, [
          agentRoot,
          nestedRoot,
          outsideRoot,
        ]),
      ).toEqual([await fs.realpath(agentRoot), await fs.realpath(nestedRoot)]);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

});
