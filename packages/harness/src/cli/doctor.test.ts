import { describe, it, expect, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: (
    file: string,
    args: string[],
    callback: (err: Error | null, result?: { stdout: string; stderr: string }) => void,
  ) => {
    const which = process.platform === "win32" ? "where" : "which";
    if (file === which) {
      const bin = args[0];
      if (bin === "claude" || bin === "git") {
        callback(null, { stdout: `/usr/local/bin/${bin}\n`, stderr: "" });
      } else {
        callback(new Error(`${bin}: not found`));
      }
      return;
    }
    if (file === "claude" && args[0] === "--version") {
      callback(null, { stdout: "1.2.3 (Claude Code)\n", stderr: "" });
      return;
    }
    if (file === "git" && args[0] === "--version") {
      callback(null, { stdout: "git version 2.43.0\n", stderr: "" });
      return;
    }
    callback(new Error(`unexpected command: ${file}`));
  },
}));

import { runDoctor } from "./doctor.js";

describe("runDoctor", () => {
  it("passes when node, claude, and git are present and codex is absent", async () => {
    const report = await runDoctor();
    const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));

    expect(byName.node.ok).toBe(true);
    expect(byName.claude).toEqual({ name: "claude", ok: true, detail: "1.2.3 (Claude Code)" });
    expect(byName.git).toEqual({ name: "git", ok: true, detail: "git version 2.43.0" });
    expect(byName.codex.ok).toBe(false);

    // Overall status only hard-fails on node/claude, so a missing optional
    // codex must not flip it.
    expect(report.ok).toBe(true);
  });
});
