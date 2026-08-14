import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_SYSTEM_PROMPT } from "../../profiles/default.js";
import {
  ClaudeCodeAdapter,
  encodeProjectPath,
  isClaudeVersionSupported,
  parseClaudeVersion,
  MIN_CLAUDE_CODE_VERSION,
} from "./claude-code.js";

describe("ClaudeCodeAdapter", () => {
  describe("readiness fallback surface", () => {
    it("declares hook-timeout (never immediate) so the SessionStart hook stays primary", () => {
      const adapter = new ClaudeCodeAdapter({ binary: "fake-claude" });
      expect(adapter.readyFallback).toBe("hook-timeout");
      expect(adapter.assumesBracketedPaste).toBe(true);
    });

    it("detectBlockingPrompt matches Claude's known blocking screens through ANSI noise", () => {
      const adapter = new ClaudeCodeAdapter({ binary: "fake-claude" });
      // ANSI-decorated, as a real pty frame renders them.
      expect(
        adapter.detectBlockingPrompt("\x1b[1mDo you trust the files in this folder?\x1b[0m"),
      ).toBe(true);
      expect(adapter.detectBlockingPrompt("Do you trust the files in this directory?")).toBe(true);
      expect(adapter.detectBlockingPrompt("Choose the text style that looks best")).toBe(true);
      expect(adapter.detectBlockingPrompt("Select login method:")).toBe(true);
      expect(adapter.detectBlockingPrompt("> welcome, composer is ready")).toBe(false);
    });
  });

  describe("launch/resume — pluginDir flag", () => {
    it("includes --plugin-dir in launch args when pluginDir is set", () => {
      const adapter = new ClaudeCodeAdapter({ binary: "fake-claude" });
      const spec = adapter.launch({
        harnessSessionId: "h-plugin",
        cwd: "/tmp/proj",
        pluginDir: "/tmp/generated/h-plugin/skills-plugin",
      });
      expect(spec.args).toContain("--plugin-dir");
      const idx = spec.args.indexOf("--plugin-dir");
      expect(spec.args[idx + 1]).toBe("/tmp/generated/h-plugin/skills-plugin");
    });

    it("includes --plugin-dir in resume args when pluginDir is set", () => {
      const adapter = new ClaudeCodeAdapter({ binary: "fake-claude" });
      const spec = adapter.resume("agent-uuid-456", {
        harnessSessionId: "h-plugin",
        cwd: "/tmp/proj",
        pluginDir: "/tmp/generated/h-plugin/skills-plugin",
      });
      expect(spec.args).toContain("--plugin-dir");
      const idx = spec.args.indexOf("--plugin-dir");
      expect(spec.args[idx + 1]).toBe("/tmp/generated/h-plugin/skills-plugin");
    });

    it("omits --plugin-dir from args when pluginDir is not set", () => {
      const adapter = new ClaudeCodeAdapter({ binary: "fake-claude" });
      const spec = adapter.launch({ harnessSessionId: "h-no-plugin", cwd: "/tmp/proj" });
      expect(spec.args).not.toContain("--plugin-dir");
    });
  });

  describe("launch/resume", () => {
    it("builds a launch SpawnSpec with settings/mcp-config/system-prompt flags and unsets CLAUDECODE", async () => {
      const promptDir = await mkdtemp(join(tmpdir(), "harness-claude-test-"));
      const promptFile = join(promptDir, "prompt.txt");
      await writeFile(promptFile, DEFAULT_SYSTEM_PROMPT, "utf8");

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
        "--permission-mode",
        "auto",
        "--append-system-prompt",
        DEFAULT_SYSTEM_PROMPT,
      ]);

      const resumed = adapter.resume("agent-uuid-123", {
        harnessSessionId: "h1",
        cwd: "/tmp/proj",
        systemPromptFile: promptFile,
      });
      expect(resumed.args).toEqual([
        "--resume",
        "agent-uuid-123",
        "--permission-mode",
        "auto",
        "--append-system-prompt",
        DEFAULT_SYSTEM_PROMPT,
      ]);

      await rm(promptDir, { recursive: true, force: true });
    });

    it("builds a resume SpawnSpec with --resume <agentSessionId>", () => {
      const adapter = new ClaudeCodeAdapter({ binary: "fake-claude" });
      const spec = adapter.resume("agent-uuid-123", { harnessSessionId: "h1", cwd: "/tmp/proj" });

      expect(spec.command).toBe("fake-claude");
      expect(spec.args).toEqual([
        "--resume",
        "agent-uuid-123",
        "--permission-mode",
        "auto",
      ]);
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

  describe("launchTask", () => {
    it("builds a headless -p SpawnSpec with the same config flags plus acceptEdits and stream-json output", async () => {
      const promptDir = await mkdtemp(join(tmpdir(), "harness-claude-test-"));
      const promptFile = join(promptDir, "prompt.txt");
      await writeFile(promptFile, "Be terse.", "utf8");

      const adapter = new ClaudeCodeAdapter({ binary: "fake-claude" });
      const spec = adapter.launchTask({
        harnessSessionId: "task-1",
        cwd: "/tmp/proj",
        prompt: "draw the canvas",
        settingsFile: "/tmp/gen/settings.json",
        mcpConfigFile: "/tmp/gen/mcp.json",
        systemPromptFile: promptFile,
      });

      expect(spec.command).toBe("fake-claude");
      expect(spec.cwd).toBe("/tmp/proj");
      expect(spec.env).toEqual({ CLAUDECODE: null });
      expect(spec.args).toEqual([
        "-p",
        "draw the canvas",
        "--settings",
        "/tmp/gen/settings.json",
        "--mcp-config",
        "/tmp/gen/mcp.json",
        "--append-system-prompt",
        "Be terse.",
        "--permission-mode",
        "acceptEdits",
        "--output-format",
        "stream-json",
        "--verbose",
      ]);
      await rm(promptDir, { recursive: true, force: true });
    });

    it("throws when no prompt is provided — a task with nothing to run is a caller bug", () => {
      const adapter = new ClaudeCodeAdapter({ binary: "fake-claude" });
      expect(() => adapter.launchTask({ harnessSessionId: "task-1", cwd: "/tmp/proj" })).toThrow(
        /requires opts\.prompt/,
      );
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

  describe("version floor", () => {
    it("parses the semver out of a claude --version line", () => {
      expect(parseClaudeVersion("2.1.3 (Claude Code)")).toEqual([2, 1, 3]);
      expect(parseClaudeVersion("1.0.62")).toEqual([1, 0, 62]);
      expect(parseClaudeVersion("")).toBeNull();
      expect(parseClaudeVersion(null)).toBeNull();
      expect(parseClaudeVersion("no version here")).toBeNull();
    });

    it("rejects a version below the floor and accepts the floor and above", () => {
      expect(isClaudeVersionSupported("1.9.9 (Claude Code)")).toBe(false);
      expect(isClaudeVersionSupported("0.5.0")).toBe(false);
      expect(isClaudeVersionSupported("2.1.82 (Claude Code)")).toBe(false);
      expect(isClaudeVersionSupported(`${MIN_CLAUDE_CODE_VERSION} (Claude Code)`)).toBe(true);
      expect(isClaudeVersionSupported("2.4.1 (Claude Code)")).toBe(true);
      expect(isClaudeVersionSupported("10.0.0")).toBe(true);
    });

    it("treats an absent or unparseable version as supported (never mass-rejects on a format change)", () => {
      // The floor exists to catch provably-ancient binaries, not to gate on our
      // own parser's limits — an unreadable version is left alone on purpose.
      expect(isClaudeVersionSupported(null)).toBe(true);
      expect(isClaudeVersionSupported("")).toBe(true);
      expect(isClaudeVersionSupported("some future format with no dotted number")).toBe(true);
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

    // Uses the adapter's OWN encoder, not a copy: a private re-implementation
    // here would keep passing if the real encoding drifted, which is exactly
    // the regression these tests exist to catch.
    function encodedProjectDir(home: string, projectCwd: string): string {
      return join(home, ".claude", "projects", encodeProjectPath(projectCwd));
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

      // Force the head/tail-window path (not a full scan) with a tiny cap.
      const adapter = new ClaudeCodeAdapter({ homeDir, fullScanMaxBytes: 1_024 });
      const summaries = await adapter.listPastSessions(cwd);
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toMatchObject({ title: "Found in the tail" });
      // A file too large to fully scan reports no exact turn count.
      expect(summaries[0]!.messageCount).toBeUndefined();
    });

    it("prefers Claude's ai-title over the (often boilerplate) first prompt and never returns a UUID", async () => {
      const projectDir = encodedProjectDir(homeDir, cwd);
      await mkdir(projectDir, { recursive: true });

      const content = [
        JSON.stringify({
          type: "user",
          origin: { kind: "human" },
          gitBranch: "feat/SAP-1632",
          message: { role: "user", content: "You are an AI coding agent managed by the Orchestrator. Do X." },
        }),
        JSON.stringify({ type: "ai-title", aiTitle: "Fix resume history row labels" }),
        JSON.stringify({ type: "assistant", gitBranch: "feat/SAP-1632", message: { role: "assistant", content: "ok" } }),
      ].join("\n");
      await writeFile(join(projectDir, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"), content + "\n", "utf8");

      const adapter = new ClaudeCodeAdapter({ homeDir });
      const summaries = await adapter.listPastSessions(cwd);
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toMatchObject({
        title: "Fix resume history row labels",
        gitBranch: "feat/SAP-1632",
      });
      expect(summaries[0]!.title).not.toContain("aaaaaaaa");
    });

    it("extracts gitBranch and an exact human-turn count, excluding tool results and sub-agent turns", async () => {
      const projectDir = encodedProjectDir(homeDir, cwd);
      await mkdir(projectDir, { recursive: true });

      const content = [
        JSON.stringify({ type: "user", origin: { kind: "human" }, gitBranch: "main", message: { role: "user", content: "first" } }),
        JSON.stringify({ type: "assistant", gitBranch: "main", message: { role: "assistant", content: "working" } }),
        // Tool result echoed back with role "user" — not a human turn.
        JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "done" }] } }),
        // Sub-agent (sidechain) prompt — not a top-level human turn.
        JSON.stringify({ type: "user", isSidechain: true, message: { role: "user", content: "sub-agent ask" } }),
        JSON.stringify({ type: "user", origin: { kind: "human" }, gitBranch: "feat/x", message: { role: "user", content: "second" } }),
      ].join("\n");
      await writeFile(join(projectDir, "session-turns.jsonl"), content + "\n", "utf8");

      const adapter = new ClaudeCodeAdapter({ homeDir });
      const [summary] = await adapter.listPastSessions(cwd);
      expect(summary).toMatchObject({ messageCount: 2, gitBranch: "feat/x", title: "first" });
    });

    it("falls back to the directory basename (never a bare UUID) when a session has no title, summary, or prompt", async () => {
      const projectDir = encodedProjectDir(homeDir, cwd);
      await mkdir(projectDir, { recursive: true });

      const content = [
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: "no user prompt here" } }),
      ].join("\n");
      await writeFile(join(projectDir, "11111111-2222-3333-4444-555555555555.jsonl"), content + "\n", "utf8");

      const adapter = new ClaudeCodeAdapter({ homeDir });
      const [summary] = await adapter.listPastSessions(cwd);
      // cwd is "/Users/test/my-project" → basename "my-project".
      expect(summary!.title).toBe("my-project");
      expect(summary!.title).not.toContain("11111111");
    });
  });

  describe("canResume", () => {
    const cwd = "/Users/test/my-project";
    const sessionId = "8f2b1c6a-4d3e-4a11-9c2f-1a2b3c4d5e6f";
    let homeDir: string;

    beforeEach(async () => {
      homeDir = await mkdtemp(join(tmpdir(), "harness-claude-canresume-"));
    });

    afterEach(async () => {
      await rm(homeDir, { recursive: true, force: true });
    });

    // Uses the adapter's OWN encoder, not a copy: a private re-implementation
    // here would keep passing if the real encoding drifted, which is exactly
    // the regression these tests exist to catch.
    function encodedProjectDir(home: string, projectCwd: string): string {
      return join(home, ".claude", "projects", encodeProjectPath(projectCwd));
    }

    async function writeTranscript(projectCwd: string, id: string, body: string): Promise<void> {
      const dir = encodedProjectDir(homeDir, projectCwd);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${id}.jsonl`), body, "utf8");
    }

    it("is true when the transcript for that id exists under the encoded project dir", async () => {
      await writeTranscript(cwd, sessionId, JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n");
      const adapter = new ClaudeCodeAdapter({ homeDir });
      expect(await adapter.canResume(sessionId, cwd)).toBe(true);
    });

    it("is false for a phantom: an id we hold with no transcript written for it", async () => {
      // The real-world shape — the SessionStart hook gave us an id, but the
      // user never submitted a prompt, so Claude Code wrote nothing at all.
      // The project dir itself exists because OTHER sessions in it did run.
      await writeTranscript(cwd, "some-other-session", JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n");
      const adapter = new ClaudeCodeAdapter({ homeDir });
      expect(await adapter.canResume(sessionId, cwd)).toBe(false);
    });

    it("is false when no project directory exists for the cwd at all", async () => {
      const adapter = new ClaudeCodeAdapter({ homeDir });
      expect(await adapter.canResume(sessionId, "/nonexistent/project")).toBe(false);
    });

    it("is false for a zero-byte transcript — the file exists but holds no conversation", async () => {
      await writeTranscript(cwd, sessionId, "");
      const adapter = new ClaudeCodeAdapter({ homeDir });
      expect(await adapter.canResume(sessionId, cwd)).toBe(false);
    });

    it("is scoped to the cwd: the same id under another project does not count", async () => {
      await writeTranscript("/Users/test/other-project", sessionId, JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n");
      const adapter = new ClaudeCodeAdapter({ homeDir });
      expect(await adapter.canResume(sessionId, cwd)).toBe(false);
      expect(await adapter.canResume(sessionId, "/Users/test/other-project")).toBe(true);
    });

    it("is false for a directory that happens to be named <id>.jsonl", async () => {
      await mkdir(join(encodedProjectDir(homeDir, cwd), `${sessionId}.jsonl`), { recursive: true });
      const adapter = new ClaudeCodeAdapter({ homeDir });
      expect(await adapter.canResume(sessionId, cwd)).toBe(false);
    });

    it("resolves a symlinked cwd — Claude Code encodes the realpath, not the path opened through", async () => {
      // The regression this guards: on macOS `/tmp` is a symlink to
      // `/private/tmp`, so a session whose registry cwd is `/tmp/foo` has its
      // transcript under the encoding of `/private/tmp/foo`. Encoding the raw
      // string stats a path that doesn't exist and reports "no conversation"
      // for a conversation that IS there — refusing a resume that works.
      const root = await mkdtemp(join(tmpdir(), "harness-claude-symlink-"));
      const realProject = join(root, "real-project");
      const linkedProject = join(root, "linked-project");
      await mkdir(realProject, { recursive: true });
      await symlink(realProject, linkedProject);

      // Write where Claude actually would: under the FULLY resolved path
      // (mkdtemp itself sits under a symlinked /var/folders on macOS).
      const dir = encodedProjectDir(homeDir, await realpath(realProject));
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, `${sessionId}.jsonl`),
        JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n",
        "utf8",
      );

      const adapter = new ClaudeCodeAdapter({ homeDir });
      expect(await adapter.canResume(sessionId, linkedProject)).toBe(true);
      expect(await adapter.canResume(sessionId, realProject)).toBe(true);
      // History discovery shares the fix, and must not double-count the
      // session when the raw and resolved dirs both resolve.
      const summaries = await adapter.listPastSessions(linkedProject);
      expect(summaries).toHaveLength(1);
      // The row reports the cwd the caller asked about, so resuming it stays
      // in the directory the user is actually working in.
      expect(summaries[0]).toMatchObject({ agentSessionId: sessionId, cwd: linkedProject });

      await rm(root, { recursive: true, force: true });
    });

    it("still answers for a cwd that no longer exists on disk (realpath fails, raw encoding stands)", async () => {
      await writeTranscript(cwd, sessionId, JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n");
      const adapter = new ClaudeCodeAdapter({ homeDir });
      // `cwd` here is a path that was never created — realpath rejects, and the
      // raw encoding is the only candidate left. It must still resolve.
      expect(await adapter.canResume(sessionId, cwd)).toBe(true);
    });

    it("never throws and refuses ids that would escape the project dir", async () => {
      const adapter = new ClaudeCodeAdapter({ homeDir });
      // Ids reach this from HTTP via POST /api/sessions/adopt, so a traversal
      // attempt must be rejected outright rather than statted.
      expect(await adapter.canResume("../../../../etc/passwd", cwd)).toBe(false);
      expect(await adapter.canResume("..", cwd)).toBe(false);
      expect(await adapter.canResume("a/b", cwd)).toBe(false);
      expect(await adapter.canResume("", cwd)).toBe(false);
    });
  });
});
