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
    it("builds a launch SpawnSpec disabling the update check and no env overrides", () => {
      const adapter = new CodexAdapter({ binary: "fake-codex" });
      const spec = adapter.launch({ harnessSessionId: "h1", cwd: "/tmp/proj" });

      expect(spec.command).toBe("fake-codex");
      expect(spec.cwd).toBe("/tmp/proj");
      expect(spec.env).toEqual({});
      expect(spec.args).toEqual(["-c", "check_for_update_on_startup=false"]);
    });

    it("adds -c model_instructions_file=<path> when a systemPromptFile is given", () => {
      const adapter = new CodexAdapter({ binary: "fake-codex" });
      const spec = adapter.launch({
        harnessSessionId: "h1",
        cwd: "/tmp/proj",
        systemPromptFile: "/tmp/proj/.sapiom/prompt.txt",
      });

      expect(spec.args).toEqual([
        "-c",
        "check_for_update_on_startup=false",
        "-c",
        "model_instructions_file=/tmp/proj/.sapiom/prompt.txt",
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
      expect(spec.args).toEqual(["-c", "check_for_update_on_startup=false"]);
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
