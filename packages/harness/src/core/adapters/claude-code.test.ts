import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ClaudeCodeAdapter } from "./claude-code.js";

describe("ClaudeCodeAdapter", () => {
  describe("launch/resume", () => {
    it("builds a launch SpawnSpec with settings/mcp-config/system-prompt flags and unsets CLAUDECODE", async () => {
      const promptDir = await mkdtemp(join(tmpdir(), "harness-claude-test-"));
      const promptFile = join(promptDir, "prompt.txt");
      await writeFile(promptFile, "You are a Sapiom workflow builder.", "utf8");

      const adapter = new ClaudeCodeAdapter({ binary: "fake-claude" });
      const spec = adapter.launch({
        harnessSessionId: "h1",
        cwd: "/tmp/proj",
        settingsFile: "/tmp/proj/.sapiom/settings.json",
        mcpConfigFile: "/tmp/proj/.sapiom/mcp.json",
        systemPromptFile: promptFile,
      });

      expect(spec.command).toBe("fake-claude");
      expect(spec.cwd).toBe("/tmp/proj");
      expect(spec.env).toEqual({ CLAUDECODE: null });
      expect(spec.args).toEqual([
        "--settings",
        "/tmp/proj/.sapiom/settings.json",
        "--mcp-config",
        "/tmp/proj/.sapiom/mcp.json",
        "--append-system-prompt",
        "You are a Sapiom workflow builder.",
      ]);

      await rm(promptDir, { recursive: true, force: true });
    });

    it("builds a resume SpawnSpec with --resume <agentSessionId>", () => {
      const adapter = new ClaudeCodeAdapter({ binary: "fake-claude" });
      const spec = adapter.resume("agent-uuid-123", { harnessSessionId: "h1", cwd: "/tmp/proj" });

      expect(spec.command).toBe("fake-claude");
      expect(spec.args).toEqual(["--resume", "agent-uuid-123"]);
      expect(spec.env).toEqual({ CLAUDECODE: null });
    });

    it("throws a descriptive error when the systemPromptFile can't be read", () => {
      const adapter = new ClaudeCodeAdapter({ binary: "fake-claude" });
      expect(() =>
        adapter.launch({
          harnessSessionId: "h1",
          cwd: "/tmp/proj",
          systemPromptFile: "/does/not/exist.txt",
        }),
      ).toThrow(/failed to read systemPromptFile/);
    });
  });

  describe("doctor", () => {
    it("reports ok:false when the binary isn't on PATH", async () => {
      const adapter = new ClaudeCodeAdapter({ binary: "definitely-not-a-real-binary-xyz" });
      const checks = await adapter.doctor();
      expect(checks).toHaveLength(1);
      expect(checks[0]).toMatchObject({ name: "claude", ok: false });
    });
  });

  describe("listPastSessions", () => {
    const cwd = "/Users/test/my-project";
    let homeDir: string;

    beforeEach(async () => {
      homeDir = await mkdtemp(join(tmpdir(), "harness-claude-home-"));
    });

    afterEach(async () => {
      await rm(homeDir, { recursive: true, force: true });
    });

    // Claude Code encodes the project cwd into a directory name by stripping
    // the leading "/" and replacing "/" and "." with "-".
    function encodedProjectDir(home: string, projectCwd: string): string {
      const encoded = projectCwd.replace(/[/.]/g, "-");
      return join(home, ".claude", "projects", encoded);
    }

    it("returns [] when no transcript directory exists for the cwd", async () => {
      const adapter = new ClaudeCodeAdapter({ homeDir });
      const summaries = await adapter.listPastSessions("/nonexistent/project");
      expect(summaries).toEqual([]);
    });

    it("extracts title (summary entry preferred, else first user message) and ignores non-.jsonl files", async () => {
      const projectDir = encodedProjectDir(homeDir, cwd);
      await mkdir(projectDir, { recursive: true });

      const withSummary = [
        JSON.stringify({ type: "user", message: { role: "user", content: "help me build a workflow" } }),
        JSON.stringify({ type: "summary", summary: "Build a leasing workflow" }),
      ].join("\n");
      await writeFile(join(projectDir, "session-aaa.jsonl"), withSummary + "\n", "utf8");

      const fallbackToUserMessage = [
        JSON.stringify({ type: "user", message: { role: "user", content: "just chatting, no summary yet" } }),
      ].join("\n");
      await writeFile(join(projectDir, "session-bbb.jsonl"), fallbackToUserMessage + "\n", "utf8");

      // Not a transcript file — must be ignored.
      await writeFile(join(projectDir, "notes.txt"), "irrelevant", "utf8");

      const adapter = new ClaudeCodeAdapter({ homeDir });
      const summaries = await adapter.listPastSessions(cwd);

      expect(summaries).toHaveLength(2);
      const byId = new Map(summaries.map((s) => [s.agentSessionId, s]));
      expect(byId.get("session-aaa")).toMatchObject({
        title: "Build a leasing workflow",
        harness: "claude-code",
        cwd,
        source: "transcript",
      });
      expect(byId.get("session-bbb")).toMatchObject({
        title: "just chatting, no summary yet",
      });
    });

    it("skips malformed lines instead of throwing, using whatever entries do parse", async () => {
      const projectDir = encodedProjectDir(homeDir, cwd);
      await mkdir(projectDir, { recursive: true });

      const content = [
        "not json at all",
        JSON.stringify({ type: "summary", summary: "Recovered summary" }),
      ].join("\n");
      await writeFile(join(projectDir, "session-ccc.jsonl"), content + "\n", "utf8");

      const adapter = new ClaudeCodeAdapter({ homeDir });
      const summaries = await adapter.listPastSessions(cwd);
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toMatchObject({ agentSessionId: "session-ccc", title: "Recovered summary" });
    });

    it("reads only the tail of large transcripts, still finding a title near the end", async () => {
      const projectDir = encodedProjectDir(homeDir, cwd);
      await mkdir(projectDir, { recursive: true });

      // Pad well past the adapter's 64KB tail-read window with valid (but
      // irrelevant) JSONL lines, then append the entry that should be found.
      const padLine = JSON.stringify({ type: "progress" }) + "x".repeat(200);
      const padding = Array.from({ length: 1000 }, () => padLine).join("\n");
      const content = `${padding}\n${JSON.stringify({ type: "summary", summary: "Found in the tail" })}\n`;
      expect(Buffer.byteLength(content, "utf8")).toBeGreaterThan(65_536);
      await writeFile(join(projectDir, "session-large.jsonl"), content, "utf8");

      const adapter = new ClaudeCodeAdapter({ homeDir });
      const summaries = await adapter.listPastSessions(cwd);
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toMatchObject({ title: "Found in the tail" });
    });
  });
});
