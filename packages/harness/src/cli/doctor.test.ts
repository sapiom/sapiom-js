import { describe, it, expect, vi } from "vitest";

// Which binaries `which`/`--version` report as present — mutated per test to
// drive the doctor-matrix below. Reset in each test rather than beforeEach so
// each case's setup reads top-to-bottom next to its assertions.
let presentBinaries: Set<string>;
// The version string `claude --version` reports — mutated per test to exercise
// the minimum-version floor. Defaults to a supported version in each test.
let claudeVersion: string;

vi.mock("node:child_process", () => ({
  execFile: (
    file: string,
    args: string[],
    // The real call sites pass an options object (windowsHide) before the
    // promisify-appended callback — accept both shapes so the mock doesn't
    // silently treat options as the callback and "fail" every probe.
    optionsOrCallback:
      | Record<string, unknown>
      | ((err: Error | null, result?: { stdout: string; stderr: string }) => void),
    maybeCallback?: (err: Error | null, result?: { stdout: string; stderr: string }) => void,
  ) => {
    const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback!;
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
      callback(null, { stdout: `${claudeVersion}\n`, stderr: "" });
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
import { MIN_CLAUDE_CODE_VERSION } from "../core/adapters/claude-code.js";

describe("runDoctor", () => {
  it("passes when node, claude, and git are present and codex is absent", async () => {
    presentBinaries = new Set(["claude", "git"]);
    claudeVersion = "2.1.220 (Claude Code)";
    const report = await runDoctor();
    const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));

    expect(byName.node.ok).toBe(true);
    expect(byName.claude).toEqual({ name: "claude", ok: true, detail: "2.1.220 (Claude Code)" });
    expect(byName.git).toEqual({ name: "git", ok: true, detail: "git version 2.43.0" });
    expect(byName.codex.ok).toBe(false);

    // Overall status only hard-fails when neither agent is available, so a
    // missing codex (with claude present) must not flip it.
    expect(report.ok).toBe(true);
    expect(report.availableHarnesses).toEqual(["claude-code"]);
  });

  it("marks a present-but-too-old claude unavailable, with an upgrade remedy", async () => {
    // Present on PATH and answers --version, but predates the flags every
    // launch relies on (Auto mode and, on older releases, --plugin-dir) — so
    // it exit-1s each session
    // before establishing a session id. Doctor must report it NOT ok.
    presentBinaries = new Set(["claude", "git"]);
    claudeVersion = "1.9.9 (Claude Code)";
    const report = await runDoctor();
    const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));

    expect(byName.claude.ok).toBe(false);
    expect(byName.claude.detail).toContain(MIN_CLAUDE_CODE_VERSION);
    expect(byName.claude.detail).toContain(CLAUDE_INSTALL_COMMAND);
    expect(report.availableHarnesses).not.toContain("claude-code");
    // No other agent present, so the whole report fails — the CLI then refuses
    // to start with the upgrade remedy instead of crash-looping every session.
    expect(report.ok).toBe(false);
  });

  it("accepts a claude at exactly the minimum version", async () => {
    presentBinaries = new Set(["claude", "git"]);
    claudeVersion = `${MIN_CLAUDE_CODE_VERSION} (Claude Code)`;
    const report = await runDoctor();
    expect(report.availableHarnesses).toEqual(["claude-code"]);
  });

  it("passes on codex alone, with claude's check carrying the exact install remedy", async () => {
    presentBinaries = new Set(["codex", "git"]);
    claudeVersion = "2.1.220 (Claude Code)";
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
    claudeVersion = "2.1.220 (Claude Code)";
    const report = await runDoctor();
    const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));

    expect(report.ok).toBe(false);
    expect(report.availableHarnesses).toEqual([]);
    expect(byName.claude.detail).toContain(CLAUDE_INSTALL_COMMAND);
    expect(byName.codex.detail).toContain(CODEX_INSTALL_COMMAND);
  });

  it("prefers claude-code when both agents are present", async () => {
    presentBinaries = new Set(["claude", "codex", "git"]);
    claudeVersion = "2.1.220 (Claude Code)";
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
