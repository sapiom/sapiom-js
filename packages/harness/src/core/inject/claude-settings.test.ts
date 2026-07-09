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
    // Notification added so the chat attention banner can fire on permission prompts.
    const events = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SessionEnd", "Notification"];
    expect(Object.keys(settings.hooks).sort()).toEqual([...events].sort());

    for (const event of events) {
      const command = settings.hooks[event][0].hooks[0].command;
      expect(command).toBe(`node ${emitScriptPath} ${event}`);
    }
  });

  it("writes a self-contained CommonJS emit.cjs with no requires", async () => {
    const { emitScriptPath } = await generateClaudeSettings({
      harnessSessionId: "session-abc",
      generatedRoot: tmpDir,
    });

    const source = await fs.readFile(emitScriptPath, "utf8");
    expect(source).toContain('"use strict"');
    expect(source).not.toMatch(/require\(/);
    expect(source).not.toMatch(/^import /m);
    expect(source).toContain("process.env.SAPIOM_HARNESS_INGEST_URL");
    expect(source).toContain("process.env.SAPIOM_HARNESS_INGEST_TOKEN");
    expect(source).toContain("process.env.SAPIOM_HARNESS_SESSION_ID");
    expect(source).toContain("AbortController");
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
    // 7 hooks: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SessionEnd, Notification.
    expect(Object.keys(settings.hooks)).toHaveLength(7);
  });
});
