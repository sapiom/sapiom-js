import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_SYSTEM_PROMPT } from "../../profiles/default.js";
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
      await writeFile(promptFile, DEFAULT_SYSTEM_PROMPT, "utf8");

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
        `developer_instructions=${JSON.stringify(DEFAULT_SYSTEM_PROMPT)}`,
      ]);

      const resumed = adapter.resume("019e62d5-a020-75f1-b5e8-253383076f83", {
        harnessSessionId: "h1",
        cwd: "/tmp/proj",
        systemPromptFile: promptFile,
      });
      expect(resumed.args.at(-1)).toBe(
        `developer_instructions=${JSON.stringify(DEFAULT_SYSTEM_PROMPT)}`,
      );

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

    it("injects Agent Map MCP config per process while keeping the secret out of argv", () => {
      const adapter = new CodexAdapter({ binary: "fake-codex" });
      const agentMapMcp = {
        url: "http://127.0.0.1:4312/mcp/agent-map",
        bearerToken: "private-map-token",
      };
      for (const spec of [
        adapter.launch({ harnessSessionId: "h1", cwd: "/tmp/proj", agentMapMcp }),
        adapter.resume("rollout", { harnessSessionId: "h1", cwd: "/tmp/proj", agentMapMcp }),
      ]) {
        expect(spec.args).toContain(
          `mcp_servers.agent-map.url=${JSON.stringify(agentMapMcp.url)}`,
        );
        expect(spec.args).toContain(
          'mcp_servers.agent-map.bearer_token_env_var="SAPIOM_AGENT_MAP_CAPABILITY"',
        );
        expect(spec.args.join(" ")).not.toContain(agentMapMcp.bearerToken);
        expect(spec.env).toEqual({
          SAPIOM_AGENT_MAP_CAPABILITY: agentMapMcp.bearerToken,
        });
      }
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

    // Codex commonly positions words independently. Build that same output
    // shape around stable copy from codex-cli 0.147.0's checked-in TUI
    // sources so every signature is also exercised without literal spaces.
    const cursorPositioned = (...lines: string[]) =>
      lines
        .map((line, row) =>
          line
            .split(" ")
            .map((word, column) => `\x1b[${row + 1};${column * 8 + 1}H${word}`)
            .join(""),
        )
        .join("");

    it("detects the trust prompt in a real, unmodified pty capture", () => {
      const adapter = new CodexAdapter();
      expect(adapter.detectBlockingPrompt(REAL_TRUST_PROMPT_CAPTURE)).toBe(true);
    });

    it.each([
      [
        "the sign-in chooser",
        cursorPositioned(
          "Sign in with ChatGPT to use Codex as part of your paid plan",
          "or connect an API key for usage-based billing",
          "Sign in with Device Code",
          "Provide your own API key",
        ),
      ],
      [
        "browser authentication",
        cursorPositioned(
          "Finish signing in via your browser",
          "If the link doesn't open automatically, open the following link to authenticate:",
        ),
      ],
      [
        "device-code authentication",
        cursorPositioned(
          "Preparing device code login",
          "1. Open this link in your browser and sign in",
          "2. Enter this one-time code after you are signed in",
        ),
      ],
      [
        "API-key entry",
        cursorPositioned(
          "Use your own OpenAI API key for usage-based billing",
          "Paste or type your API key below. It will be stored locally in auth.json.",
        ),
      ],
      [
        "the post-login onboarding notice",
        cursorPositioned(
          "Before you start:",
          "Decide how much autonomy you want to grant Codex",
          "Codex can make mistakes",
        ),
      ],
      [
        "model migration",
        cursorPositioned(
          "Codex just got an upgrade. Introducing GPT-5.5.",
          "Choose how you'd like Codex to proceed.",
          "1. Try new model",
          "2. Use existing model",
        ),
      ],
      [
        "personality selection",
        cursorPositioned(
          "Select Personality",
          "Choose a communication style for Codex.",
          "Press enter to confirm or esc to go back",
        ),
      ],
      [
        "syntax-theme selection",
        cursorPositioned(
          "Select Syntax Theme",
          "Type to filter themes...",
          "Move up/down to live preview themes",
        ),
      ],
    ])("detects %s as blocking", (_name, capture) => {
      const adapter = new CodexAdapter();
      expect(adapter.detectBlockingPrompt(capture)).toBe(true);
    });

    it("does not false-positive on ordinary composer/output text", () => {
      const adapter = new CodexAdapter();
      const composer =
        "\x1b]0;my-project\x07\x1b[1;1H\x1b[38;2;231;231;231;49m› Find and fix a bug in @filename" +
        "\x1b[3;1Hgpt-5.5 xhigh · /private/tmp/proj";
      expect(adapter.detectBlockingPrompt(composer)).toBe(false);
    });

    it("does not treat MCP startup authentication warnings as blocking prompts", () => {
      const adapter = new CodexAdapter();
      expect(
        adapter.detectBlockingPrompt(
          "MCP client for `notion` failed to start: Auth error: OAuth authorization required\r\n" +
            "MCP startup incomplete (failed: notion, render)",
        ),
      ).toBe(false);
    });

    it("does not treat one isolated onboarding label in ordinary output as a whole blocking screen", () => {
      const adapter = new CodexAdapter();
      expect(
        adapter.detectBlockingPrompt(
          "The docs say to trust the contents of this directory.",
        ),
      ).toBe(false);
      expect(
        adapter.detectBlockingPrompt(
          "The docs mention Sign in with ChatGPT to use Codex as part of your paid plan.",
        ),
      ).toBe(false);
      expect(
        adapter.detectBlockingPrompt(
          "You can choose Provide your own API key during setup.",
        ),
      ).toBe(false);
      expect(
        adapter.detectBlockingPrompt(
          "The next heading says Select Personality.",
        ),
      ).toBe(false);
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
        "\x1b[3;29Hof\x1b[3;32Hthis\x1b[3;37Hdirectory?" +
        "\x1b[6;3HYes,\x1b[6;8Hcontinue\x1b[7;3HNo,\x1b[7;7Hquit";
      const adapter = new CodexAdapter();
      expect(adapter.detectBlockingPrompt(capture)).toBe(true);
    });

    it("returns false for plain text with no escape sequences at all", () => {
      const adapter = new CodexAdapter();
      expect(adapter.detectBlockingPrompt("just some ordinary agent output, nothing special")).toBe(false);
    });
  });

  describe("detectReadyPrompt", () => {
    it("recognizes the empty Codex composer through cursor-positioned rendering", () => {
      const adapter = new CodexAdapter();
      expect(
        adapter.detectReadyPrompt(
          "\x1b[?2026h\x1b[12;3HAsk\x1b[12;7HCodex\x1b[12;13Hto\x1b[12;16Hdo" +
            "\x1b[12;19Hanything\x1b[?2026l",
        ),
      ).toBe(true);
    });

    it("recognizes the Codex 0.143 empty-composer copy", () => {
      const adapter = new CodexAdapter();
      expect(
        adapter.detectReadyPrompt(
          "\x1b[?2026h\x1b[12;3HUse\x1b[12;7H/skills\x1b[12;15Hto" +
            "\x1b[12;18Hlist\x1b[12;23Havailable\x1b[12;33Hskills\x1b[?2026l",
        ),
      ).toBe(true);
    });

    it("recognizes a future composer copy from its input marker and cwd footer", () => {
      const adapter = new CodexAdapter();
      expect(
        adapter.detectReadyPrompt(
          "\x1b[?2026h\x1b[12;3H› A future placeholder\r\n" +
            "\x1b[14;3Hgpt-next medium · C:\\work\\project\x1b[?2026l",
        ),
      ).toBe(true);
      expect(
        adapter.detectStructuralReadyPrompt(
          "\x1b[?2026h\x1b[12;3H› A future placeholder\r\n" +
            "\x1b[14;3Hgpt-next medium · C:\\work\\project\x1b[?2026l",
        ),
      ).toBe(false);
    });

    it("recognizes a narrow-width composer without a cwd footer via structural proof", () => {
      const adapter = new CodexAdapter();
      const frame =
        "\x1b[?2026h\x1b[12;3H› Some unknown placeholder copy\r\n" +
        "\x1b[14;3Hgpt-next medium\x1b[?2026l";
      expect(adapter.detectReadyPrompt(frame)).toBe(true);
      expect(adapter.detectStructuralReadyPrompt(frame)).toBe(true);
    });

    it("does not treat a selection marker without the cwd footer as a composer", () => {
      const adapter = new CodexAdapter();
      expect(
        adapter.detectReadyPrompt(
          "\x1b[?2026h\x1b[6;3H› 1. Yes, continue\r\n" +
            "\x1b[7;3H2. No, quit\x1b[?2026l",
        ),
      ).toBe(false);
    });

    it("vetoes a partial trust repaint even when the underlying cwd footer is visible", () => {
      const adapter = new CodexAdapter();
      expect(
        adapter.detectReadyPrompt(
          "\x1b[?2026h\x1b[6;3H  1. Yes, continue\r\n" +
            "\x1b[7;3H› 2. No, quit\r\n" +
            "\x1b[14;3Hgpt-5.5 default · /tmp/proj\x1b[?2026l",
        ),
      ).toBe(false);
    });

    it("does not mistake an onboarding screen for the empty composer", () => {
      const adapter = new CodexAdapter();
      expect(
        adapter.detectReadyPrompt(
          "Finish signing in via your browser\r\nopen the following link to authenticate",
        ),
      ).toBe(false);
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

  describe("canResume", () => {
    const cwd = "/Users/test/my-project";
    const sessionId = "019e62d5-a020-75f1-b5e8-253383076f83";
    let homeDir: string;

    beforeEach(async () => {
      homeDir = await mkdtemp(join(tmpdir(), "harness-codex-canresume-"));
    });

    afterEach(async () => {
      await rm(homeDir, { recursive: true, force: true });
    });

    async function writeRollout(id: string, rolloutCwd: string, day = "01"): Promise<void> {
      const dir = join(homeDir, ".codex", "sessions", "2026", "01", day);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, `rollout-2026-01-${day}T00-00-00-${id}.jsonl`),
        [sessionMetaLine(id, rolloutCwd, `2026-01-${day}T00:00:00.000Z`), userMessageLine("hello")].join("\n") + "\n",
        "utf8",
      );
    }

    it("is true when a rollout file's session_meta carries that id and cwd", async () => {
      await writeRollout(sessionId, cwd);
      const adapter = new CodexAdapter({ homeDir });
      expect(await adapter.canResume(sessionId, cwd)).toBe(true);
    });

    it("is false for a phantom: an id we hold with no rollout file written for it", async () => {
      // Codex writes no rollout until the FIRST turn is submitted (the same
      // rule detectBlockingPrompt exists for), so an abandoned session leaves
      // us a SessionStart id and nothing behind it. Another session in the
      // same directory did run, so the sessions tree itself is populated.
      await writeRollout("019e62d5-a020-75f1-b5e8-253383076f99", cwd);
      const adapter = new CodexAdapter({ homeDir });
      expect(await adapter.canResume(sessionId, cwd)).toBe(false);
    });

    it("is false when no sessions directory exists at all", async () => {
      const adapter = new CodexAdapter({ homeDir });
      expect(await adapter.canResume(sessionId, cwd)).toBe(false);
    });

    it("is scoped to the cwd: the right id recorded against another directory does not count", async () => {
      await writeRollout(sessionId, "/Users/test/other-project");
      const adapter = new CodexAdapter({ homeDir });
      expect(await adapter.canResume(sessionId, cwd)).toBe(false);
      expect(await adapter.canResume(sessionId, "/Users/test/other-project")).toBe(true);
    });

    it("finds a match across the YYYY/MM/DD shards, not just the first day", async () => {
      await writeRollout("019e62d5-a020-75f1-b5e8-253383076f01", cwd, "01");
      await writeRollout(sessionId, cwd, "15");
      const adapter = new CodexAdapter({ homeDir });
      expect(await adapter.canResume(sessionId, cwd)).toBe(true);
    });

    it("matches a rollout recorded against the realpath of a symlinked cwd", async () => {
      // Not vendor-confirmed for codex (it is for claude-code), so the adapter
      // accepts either form rather than betting on one — a probe that answers
      // "no" for a conversation that exists is the failure worth avoiding.
      const root = await mkdtemp(join(tmpdir(), "harness-codex-symlink-"));
      const realProject = join(root, "real-project");
      const linkedProject = join(root, "linked-project");
      await mkdir(realProject, { recursive: true });
      await symlink(realProject, linkedProject);
      await writeRollout(sessionId, await realpath(realProject));

      const adapter = new CodexAdapter({ homeDir });
      expect(await adapter.canResume(sessionId, linkedProject)).toBe(true);
      expect(await adapter.listPastSessions(linkedProject)).toHaveLength(1);

      await rm(root, { recursive: true, force: true });
    });

    it("never throws on an empty or malformed id", async () => {
      await writeRollout(sessionId, cwd);
      const adapter = new CodexAdapter({ homeDir });
      expect(await adapter.canResume("", cwd)).toBe(false);
      expect(await adapter.canResume("../../etc/passwd", cwd)).toBe(false);
    });
  });
});
