import { describe, it, expect, vi } from "vitest";

// Which binaries `which`/`--version` report as present — mutated per test to
// drive the doctor-matrix below. Reset in each test rather than beforeEach so
// each case's setup reads top-to-bottom next to its assertions.
let presentBinaries: Set<string>;

vi.mock("node:child_process", () => ({
  execFile: (
    file: string,
    args: string[],
    callback: (err: Error | null, result?: { stdout: string; stderr: string }) => void,
  ) => {
    const which = process.platform === "win32" ? "where" : "which";
    if (file === which) {
      const bin = args[0];
      if (presentBinaries.has(bin)) {
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
    if (file === "codex" && args[0] === "--version") {
      callback(null, { stdout: "0.134.0 (Codex)\n", stderr: "" });
      return;
    }
    if (file === "git" && args[0] === "--version") {
      callback(null, { stdout: "git version 2.43.0\n", stderr: "" });
      return;
    }
    callback(new Error(`unexpected command: ${file}`));
  },
}));

import { runDoctor, pickDefaultHarness, CLAUDE_INSTALL_COMMAND, CODEX_INSTALL_COMMAND } from "./doctor.js";

describe("runDoctor", () => {
  it("passes when node, claude, and git are present and codex is absent", async () => {
    presentBinaries = new Set(["claude", "git"]);
    const report = await runDoctor();
    const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));

    expect(byName.node.ok).toBe(true);
    expect(byName.claude).toEqual({ name: "claude", ok: true, detail: "1.2.3 (Claude Code)" });
    expect(byName.git).toEqual({ name: "git", ok: true, detail: "git version 2.43.0" });
    expect(byName.codex.ok).toBe(false);

    // Overall status only hard-fails when neither agent is available, so a
    // missing codex (with claude present) must not flip it.
    expect(report.ok).toBe(true);
    expect(report.availableHarnesses).toEqual(["claude-code"]);
  });

  it("passes on codex alone, with claude's check carrying the exact install remedy", async () => {
    presentBinaries = new Set(["codex", "git"]);
    const report = await runDoctor();
    const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));

    expect(report.ok).toBe(true);
    expect(report.availableHarnesses).toEqual(["codex"]);
    expect(byName.claude.ok).toBe(false);
    expect(byName.claude.detail).toContain(CLAUDE_INSTALL_COMMAND);
    expect(byName.codex).toEqual({ name: "codex", ok: true, detail: "0.134.0 (Codex)" });
  });

  it("fails only when neither claude nor codex is present, surfacing both install remedies", async () => {
    presentBinaries = new Set(["git"]);
    const report = await runDoctor();
    const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));

    expect(report.ok).toBe(false);
    expect(report.availableHarnesses).toEqual([]);
    expect(byName.claude.detail).toContain(CLAUDE_INSTALL_COMMAND);
    expect(byName.codex.detail).toContain(CODEX_INSTALL_COMMAND);
  });

  it("prefers claude-code when both agents are present", async () => {
    presentBinaries = new Set(["claude", "codex", "git"]);
    const report = await runDoctor();

    expect(report.ok).toBe(true);
    expect(report.availableHarnesses).toEqual(["claude-code", "codex"]);
  });
});

describe("pickDefaultHarness", () => {
  it("picks the first available harness", () => {
    expect(pickDefaultHarness({ checks: [], ok: true, availableHarnesses: ["claude-code", "codex"] })).toBe(
      "claude-code",
    );
    expect(pickDefaultHarness({ checks: [], ok: true, availableHarnesses: ["codex"] })).toBe("codex");
  });

  it("falls back to claude-code for an empty report rather than throwing", () => {
    expect(pickDefaultHarness({ checks: [], ok: false, availableHarnesses: [] })).toBe("claude-code");
  });
});
