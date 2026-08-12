import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { generateClaudeSettings } from "./claude-settings.js";

describe("generateClaudeSettings", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-settings-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes settings.json registering all hooks pointed at emit.cjs", async () => {
    const { settingsPath, emitScriptPath } = await generateClaudeSettings({
      harnessSessionId: "session-abc",
      generatedRoot: tmpDir,
    });

    expect(settingsPath).toBe(path.join(tmpDir, "session-abc", "settings.json"));
    expect(emitScriptPath).toBe(path.join(tmpDir, "session-abc", "emit.cjs"));

    const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    const events = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"];
    expect(Object.keys(settings.hooks).sort()).toEqual([...events].sort());

    for (const event of events) {
      const command = settings.hooks[event][0].hooks[0].command;
      expect(command).toBe(`node "${emitScriptPath}" ${event}`);
    }
  });

  it("double-quotes the hook command's script path so a home dir with a space still runs", async () => {
    // A space in the home directory is the real-world trigger: Claude Code
    // runs the command hook through a shell, so an unquoted path word-splits
    // and the SessionStart hook never fires (agentSessionId stays null).
    const spacedRoot = path.join(tmpDir, "First Last", ".sapiom", "generated");
    const { emitScriptPath } = await generateClaudeSettings({
      harnessSessionId: "session-space",
      generatedRoot: spacedRoot,
    });
    expect(emitScriptPath).toContain(" ");

    const settings = JSON.parse(
      await fs.readFile(path.join(spacedRoot, "session-space", "settings.json"), "utf8"),
    );
    const command = settings.hooks.SessionStart[0].hooks[0].command;
    expect(command).toBe(`node "${emitScriptPath}" SessionStart`);
    // Guard against a regression to the unquoted form that word-splits on the space.
    expect(command).not.toBe(`node ${emitScriptPath} SessionStart`);
  });

  it("writes a self-contained CommonJS emit.cjs — node builtins only", async () => {
    const { emitScriptPath } = await generateClaudeSettings({
      harnessSessionId: "session-abc",
      generatedRoot: tmpDir,
    });

    const source = await fs.readFile(emitScriptPath, "utf8");
    expect(source).toContain('"use strict"');
    // The real invariant: the script runs from an arbitrary user project with
    // no node_modules resolvable, so every require must be a `node:` builtin.
    for (const match of source.matchAll(/require\(([^)]*)\)/g)) {
      expect(match[1]).toMatch(/^"node:[a-z/]+"$/);
    }
    expect(source).not.toMatch(/^import /m);
    expect(source).toContain("process.env.SAPIOM_HARNESS_INGEST_URL");
    expect(source).toContain("process.env.SAPIOM_HARNESS_INGEST_TOKEN");
    expect(source).toContain("process.env.SAPIOM_HARNESS_SESSION_ID");
    expect(source).toContain("AbortController");
  });

  it("gives the ready-signal POST budgets that survive a cold Windows loopback", async () => {
    // 200ms abort / 1s hard-stop raced a cold ConPTY boot and the SessionStart
    // POST — the only signal that flips a session to "ready" — silently lost,
    // so the held first prompt was dropped. Ordering invariant: stdin give-up
    // plus fetch abort must stay under the hard stop.
    const { emitScriptPath } = await generateClaudeSettings({
      harnessSessionId: "session-abc",
      generatedRoot: tmpDir,
    });
    const source = await fs.readFile(emitScriptPath, "utf8");
    const hardStop = Number(/}, (\d+)\);\n\n\/\/ Best-effort breadcrumb/.exec(source)?.[1]);
    const abort = Number(/controller\.abort\(\), (\d+)\)/.exec(source)?.[1]);
    const stdinGiveUp = Number(/setTimeout\(\(\) => resolve\(data\), (\d+)\)/.exec(source)?.[1]);
    expect(abort).toBeGreaterThanOrEqual(2000);
    expect(hardStop).toBeGreaterThan(stdinGiveUp + abort);
    // Breadcrumb on failure, capped so it can't grow unboundedly.
    expect(source).toContain("emit-debug.log");
    expect(source).toContain("65536");
  });

  it("omits the theme key by default (Claude keeps its default rendering)", async () => {
    const { settingsPath } = await generateClaudeSettings({
      harnessSessionId: "session-abc",
      generatedRoot: tmpDir,
    });
    const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    expect(settings).not.toHaveProperty("theme");
    expect(settings.hooks).toBeDefined();
  });

  it("pins the ANSI theme when claudeTheme is given, alongside the hooks", async () => {
    // The ANSI theme is what makes the terminal's own palette control Claude's
    // colors; the hooks must still be written next to it.
    const { settingsPath } = await generateClaudeSettings({
      harnessSessionId: "session-abc",
      generatedRoot: tmpDir,
      claudeTheme: "light-ansi",
    });
    const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    expect(settings.theme).toBe("light-ansi");
    expect(Object.keys(settings.hooks)).toHaveLength(6);
  });

  it("invokes a BARE `node` in every hook command — the one spelling all three hook shells resolve", async () => {
    // Claude Code runs hooks through Git Bash on Windows (PowerShell
    // fallback), /bin/sh on POSIX. Bare `node` resolves under all of them
    // (the desktop host ships .cmd AND extensionless sh shims); an absolute
    // "C:\...\node.exe" would parse as a string EXPRESSION, not an
    // invocation, under PowerShell's -Command form. Pinned so a future
    // "improvement" back to an embedded path has to argue with this test.
    const { settingsPath } = await generateClaudeSettings({
      harnessSessionId: "session-abc",
      generatedRoot: tmpDir,
    });
    const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    for (const event of Object.keys(settings.hooks)) {
      expect(settings.hooks[event][0].hooks[0].command).toMatch(/^node "/);
    }
  });

  it("is safe to regenerate for the same session (overwrites in place)", async () => {
    const first = await generateClaudeSettings({
      harnessSessionId: "session-abc",
      generatedRoot: tmpDir,
    });
    const second = await generateClaudeSettings({
      harnessSessionId: "session-abc",
      generatedRoot: tmpDir,
    });
    expect(second.settingsPath).toBe(first.settingsPath);
    const settings = JSON.parse(await fs.readFile(second.settingsPath, "utf8"));
    // 6 hooks: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SessionEnd.
    expect(Object.keys(settings.hooks)).toHaveLength(6);
  });
});
