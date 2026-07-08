import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CodexAdapter } from "./codex.js";

/** A minimal, synthetic (not real-user-data) rollout line set matching the
 * schema of an installed codex-cli 0.134.0 on the build machine. */
function sessionMetaLine(id: string, cwd: string, timestamp: string): string {
  return JSON.stringify({
    timestamp,
    type: "session_meta",
    payload: { id, timestamp, cwd, originator: "codex-cli", cli_version: "0.134.0" },
  });
}

function userMessageLine(message: string): string {
  return JSON.stringify({
    timestamp: "2026-01-01T00:00:01.000Z",
    type: "event_msg",
    payload: { type: "user_message", message, images: [] },
  });
}

describe("CodexAdapter", () => {
  describe("launch/resume", () => {
    it("builds a launch SpawnSpec with update check off, never-ask approvals, workspace-write sandbox, and no env overrides", () => {
      const adapter = new CodexAdapter({ binary: "fake-codex" });
      const spec = adapter.launch({ harnessSessionId: "h1", cwd: "/tmp/proj" });

      expect(spec.command).toBe("fake-codex");
      expect(spec.cwd).toBe("/tmp/proj");
      expect(spec.env).toEqual({});
      expect(spec.args).toEqual([
        "-c",
        "check_for_update_on_startup=false",
        "-c",
        'approval_policy="never"',
        "-c",
        'sandbox_mode="workspace-write"',
      ]);
    });

    it("embeds the systemPromptFile's content inline via -c developer_instructions=<value>", async () => {
      const promptDir = await mkdtemp(join(tmpdir(), "harness-codex-prompt-"));
      const promptFile = join(promptDir, "prompt.txt");
      await writeFile(promptFile, "You are a Sapiom workflow builder.\nBe concise.", "utf8");

      const adapter = new CodexAdapter({ binary: "fake-codex" });
      const spec = adapter.launch({ harnessSessionId: "h1", cwd: "/tmp/proj", systemPromptFile: promptFile });

      // Reading the file's content in and embedding it (rather than passing
      // codex a path to re-read at its own startup) is the actual fix here —
      // an unreadable model_instructions_file path kills codex instantly
      // with no trust prompt, no TUI, which is exactly the "session has no
      // live pty" symptom a user sees with no indication why. -c values
      // parse as TOML; JSON.stringify produces a valid TOML string literal
      // for a value with embedded newlines/quotes.
      expect(spec.args).toEqual([
        "-c",
        "check_for_update_on_startup=false",
        "-c",
        'approval_policy="never"',
        "-c",
        'sandbox_mode="workspace-write"',
        "-c",
        `developer_instructions=${JSON.stringify("You are a Sapiom workflow builder.\nBe concise.")}`,
      ]);

      await rm(promptDir, { recursive: true, force: true });
    });

    it("launches without a system prompt (rather than a guaranteed-crashing arg) when systemPromptFile can't be read", () => {
      const adapter = new CodexAdapter({ binary: "fake-codex" });
      const spec = adapter.launch({
        harnessSessionId: "h1",
        cwd: "/tmp/proj",
        systemPromptFile: "/does/not/exist/prompt.txt",
      });

      expect(spec.args).toEqual([
        "-c",
        "check_for_update_on_startup=false",
        "-c",
        'approval_policy="never"',
        "-c",
        'sandbox_mode="workspace-write"',
      ]);
    });

    it("builds a resume SpawnSpec with `resume <rolloutId>` as the leading args", () => {
      const adapter = new CodexAdapter({ binary: "fake-codex" });
      const spec = adapter.resume("019e62d5-a020-75f1-b5e8-253383076f83", {
        harnessSessionId: "h1",
        cwd: "/tmp/proj",
      });

      expect(spec.command).toBe("fake-codex");
      expect(spec.args).toEqual([
        "resume",
        "019e62d5-a020-75f1-b5e8-253383076f83",
        "-c",
        "check_for_update_on_startup=false",
        "-c",
        'approval_policy="never"',
        "-c",
        'sandbox_mode="workspace-write"',
      ]);
      expect(spec.env).toEqual({});
    });

    it("ignores mcpConfigFile/settingsFile — Codex has no per-session injection point for either", () => {
      const adapter = new CodexAdapter({ binary: "fake-codex" });
      const spec = adapter.launch({
        harnessSessionId: "h1",
        cwd: "/tmp/proj",
        mcpConfigFile: "/tmp/proj/.sapiom/mcp.json",
        settingsFile: "/tmp/proj/.sapiom/settings.json",
      });
      expect(spec.args).toEqual([
        "-c",
        "check_for_update_on_startup=false",
        "-c",
        'approval_policy="never"',
        "-c",
        'sandbox_mode="workspace-write"',
      ]);
    });
  });

  describe("detectBlockingPrompt", () => {
    // Real capture from a locally installed codex-cli 0.134.0's trust-dialog
    // screen: it positions each *word* with its own cursor-addressing escape
    // sequence instead of emitting literal spaces between them, and other
    // frames interleave OSC title-setting sequences using both BEL and ST
    // terminators.
    const REAL_TRUST_PROMPT_CAPTURE =
      "\x1b[1;1H\x1b[J\x1b[1;3H\x1b[1mYou are in \x1b[22m/private/tmp/proj" +
      "\x1b[3;3HDo\x1b[3;6Hyou\x1b[3;10Htrust\x1b[3;16Hthe\x1b[3;20Hcontents" +
      "\x1b[3;29Hof\x1b[3;32Hthis\x1b[3;37Hdirectory?\x1b[3;48HWorking" +
      "\x1b[3;56Hwith\x1b[3;61Huntrusted\x1b[4;3Hinjection." +
      "\x1b[6;1H\x1b[38;5;6;49m› 1. Yes, continue\x1b[7;3H\x1b[39;49m2." +
      "\x1b[7;6HNo,\x1b[7;10Hquit\x1b[9;3H\x1b[2mPress enter to continue";

    it("detects the trust prompt in a real, unmodified pty capture", () => {
      const adapter = new CodexAdapter();
      expect(adapter.detectBlockingPrompt(REAL_TRUST_PROMPT_CAPTURE)).toBe(true);
    });

    it("does not false-positive on ordinary composer/output text", () => {
      const adapter = new CodexAdapter();
      const composer =
        "\x1b]0;my-project\x07\x1b[1;1H\x1b[38;2;231;231;231;49m› Find and fix a bug in @filename" +
        "\x1b[3;1Hgpt-5.5 xhigh · /private/tmp/proj";
      expect(adapter.detectBlockingPrompt(composer)).toBe(false);
    });

    it("does not false-positive on an OSC sequence terminated by ST (ESC \\\\) rather than BEL", () => {
      // Regression: a greedy (not lazy) OSC-stripping pattern doesn't
      // exclude ST (`\x1b\\`) from what it can consume, so it backtracks to
      // the LAST reachable terminator in the whole string instead of the
      // next one — silently swallowing real content (including this exact
      // trust-prompt text) in between. Confirmed against this real capture
      // shape: two OSC 10/11 color queries (ST-terminated) followed later by
      // an OSC 0 title (BEL-terminated), then the trust prompt.
      const capture =
        "\x1b]10;?\x1b\\\x1b]11;?\x1b\\\x1b]0;proj\x07" +
        "\x1b[3;3HDo\x1b[3;6Hyou\x1b[3;10Htrust\x1b[3;16Hthe\x1b[3;20Hcontents" +
        "\x1b[3;29Hof\x1b[3;32Hthis\x1b[3;37Hdirectory?";
      const adapter = new CodexAdapter();
      expect(adapter.detectBlockingPrompt(capture)).toBe(true);
    });

    it("returns false for plain text with no escape sequences at all", () => {
      const adapter = new CodexAdapter();
      expect(adapter.detectBlockingPrompt("just some ordinary agent output, nothing special")).toBe(false);
    });
  });

  describe("doctor", () => {
    it("reports ok:false when the binary isn't on PATH", async () => {
      const adapter = new CodexAdapter({ binary: "definitely-not-a-real-binary-xyz" });
      const checks = await adapter.doctor();
      expect(checks).toHaveLength(1);
      expect(checks[0]).toMatchObject({ name: "codex", ok: false });
    });
  });

  describe("listPastSessions", () => {
    const cwd = "/Users/test/my-project";
    let homeDir: string;

    beforeEach(async () => {
      homeDir = await mkdtemp(join(tmpdir(), "harness-codex-home-"));
    });

    afterEach(async () => {
      await rm(homeDir, { recursive: true, force: true });
    });

    function rolloutDir(home: string): string {
      return join(home, ".codex", "sessions", "2026", "01", "01");
    }

    it("returns [] when no sessions directory exists", async () => {
      const adapter = new CodexAdapter({ homeDir });
      expect(await adapter.listPastSessions("/nonexistent/project")).toEqual([]);
    });

    it("finds rollout files whose session_meta.cwd matches, ignoring others", async () => {
      const dir = rolloutDir(homeDir);
      await mkdir(dir, { recursive: true });

      const matchingId = "019e62d5-a020-75f1-b5e8-253383076f83";
      await writeFile(
        join(dir, `rollout-2026-01-01T00-00-00-${matchingId}.jsonl`),
        [
          sessionMetaLine(matchingId, cwd, "2026-01-01T00:00:00.000Z"),
          userMessageLine("help me build a workflow"),
        ].join("\n") + "\n",
        "utf8",
      );

      const otherId = "019e62d5-a020-75f1-b5e8-253383076f84";
      await writeFile(
        join(dir, `rollout-2026-01-01T00-05-00-${otherId}.jsonl`),
        sessionMetaLine(otherId, "/some/other/project", "2026-01-01T00:05:00.000Z") + "\n",
        "utf8",
      );

      const adapter = new CodexAdapter({ homeDir });
      const summaries = await adapter.listPastSessions(cwd);

      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toMatchObject({
        agentSessionId: matchingId,
        harness: "codex",
        cwd,
        title: "help me build a workflow",
        source: "transcript",
      });
    });

    it("falls back to the rollout id as the title when no user message is present", async () => {
      const dir = rolloutDir(homeDir);
      await mkdir(dir, { recursive: true });
      const id = "019e62d5-a020-75f1-b5e8-253383076f85";
      await writeFile(
        join(dir, `rollout-2026-01-01T00-00-00-${id}.jsonl`),
        sessionMetaLine(id, cwd, "2026-01-01T00:00:00.000Z") + "\n",
        "utf8",
      );

      const adapter = new CodexAdapter({ homeDir });
      const summaries = await adapter.listPastSessions(cwd);
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toMatchObject({ agentSessionId: id, title: id });
    });

    it("skips files that don't start with a session_meta line instead of throwing", async () => {
      const dir = rolloutDir(homeDir);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "rollout-not-a-real-session.jsonl"), "not json at all\n", "utf8");
      await writeFile(join(dir, "notes.txt"), "irrelevant, not .jsonl", "utf8");

      const adapter = new CodexAdapter({ homeDir });
      expect(await adapter.listPastSessions(cwd)).toEqual([]);
    });

    it("recurses through the YYYY/MM/DD date-sharded directory structure", async () => {
      const dirA = join(homeDir, ".codex", "sessions", "2026", "01", "01");
      const dirB = join(homeDir, ".codex", "sessions", "2026", "02", "15");
      await mkdir(dirA, { recursive: true });
      await mkdir(dirB, { recursive: true });
      const idA = "019e62d5-a020-75f1-b5e8-253383076fa1";
      const idB = "019e62d5-a020-75f1-b5e8-253383076fb2";
      await writeFile(
        join(dirA, `rollout-2026-01-01T00-00-00-${idA}.jsonl`),
        sessionMetaLine(idA, cwd, "2026-01-01T00:00:00.000Z") + "\n",
        "utf8",
      );
      await writeFile(
        join(dirB, `rollout-2026-02-15T00-00-00-${idB}.jsonl`),
        sessionMetaLine(idB, cwd, "2026-02-15T00:00:00.000Z") + "\n",
        "utf8",
      );

      const adapter = new CodexAdapter({ homeDir });
      const summaries = await adapter.listPastSessions(cwd);
      const ids = summaries.map((s) => s.agentSessionId).sort();
      expect(ids).toEqual([idA, idB].sort());
    });
  });
});
