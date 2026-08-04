import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ROLLING_SUMMARY_MACRO_ID,
  ROLLING_SUMMARY_MAX_TURNS,
  ROLLING_SUMMARY_MODEL,
  buildRollingSummaryPrompt,
  clampToWords,
  createRollingSummarizer,
  readRollingSummary,
  rollingSummaryPath,
  type RollingSummarizerDeps,
} from "./rolling-summary.js";
import type { AnalyticsEvent, BackgroundTask, SessionRecord } from "../shared/types.js";

const SESSION = "harness-1";

function event(type: AnalyticsEvent["type"], harnessSessionId = SESSION): AnalyticsEvent {
  return {
    type,
    ts: "2026-07-27T10:00:00.000Z",
    seq: 1,
    harnessSessionId,
    harness: "claude-code",
    agentSessionId: "agent-1",
    machineId: "machine-1",
    userId: null,
    tenantId: null,
    payload: {},
  } as AnalyticsEvent;
}

function record(): SessionRecord {
  return {
    harnessSessionId: SESSION,
    mergedSessionIds: [SESSION],
    agentSessionId: "agent-1",
    harness: "claude-code",
    cwd: "/Users/dev/project",
    startedAt: "2026-07-27T10:00:00.000Z",
    endedAt: null,
    turns: [
      {
        index: 1,
        prompt: "make the backoff jittered",
        promptAt: "2026-07-27T10:00:00.000Z",
        toolCalls: [],
        assistantText: "done",
        model: "claude-opus-5",
        usage: null,
        completedAt: "2026-07-27T10:01:00.000Z",
        incomplete: false,
      },
    ],
    turnCount: 1,
    eventCount: 2,
    reconstructed: true,
    archivedAt: null, // folded from the live event log, not the archive
    limitations: [],
  };
}

function task(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: "task-1",
    macroId: ROLLING_SUMMARY_MACRO_ID,
    label: "Session summary",
    harnessSessionId: SESSION,
    cwd: "/Users/dev/project",
    workflowPath: null,
    status: "completed",
    startedAt: "2026-07-27T10:00:00.000Z",
    endedAt: "2026-07-27T10:00:10.000Z",
    exitCode: 0,
    statusLines: [],
    resultText: "The session made the retry backoff jittered.",
    errorTail: null,
    ...overrides,
  };
}

describe("rolling summary", () => {
  let generatedRoot: string;
  let runs: Parameters<RollingSummarizerDeps["runTask"]>[0][];
  let errors: unknown[];

  beforeEach(async () => {
    generatedRoot = await mkdtemp(join(tmpdir(), "harness-rolling-summary-"));
    runs = [];
    errors = [];
  });

  afterEach(async () => {
    await rm(generatedRoot, { recursive: true, force: true });
  });

  function summarizer(overrides: Partial<RollingSummarizerDeps> = {}) {
    return createRollingSummarizer({
      generatedRoot,
      enabled: async () => true,
      readRecord: async () => record(),
      getSession: () => ({ harness: "claude-code", cwd: "/Users/dev/project" }),
      runTask: async (req) => {
        runs.push(req);
        return task({ id: `task-${runs.length}`, status: "running", resultText: null, endedAt: null });
      },
      turnInterval: 3,
      onError: (err) => errors.push(err),
      ...overrides,
    });
  }

  describe("the opt-in gate", () => {
    it("never runs a fold when the setting is off", async () => {
      const rolling = summarizer({ enabled: async () => false });
      for (let i = 0; i < 10; i += 1) rolling.noteEvent(event("turn.completed"));
      rolling.noteEvent(event("session.end"));
      await rolling.idle();
      expect(runs).toEqual([]);
      expect(await readRollingSummary(generatedRoot, SESSION)).toBeNull();
    });

    it("re-reads the gate per fold, so toggling it takes effect without a restart", async () => {
      let on = false;
      const rolling = summarizer({ enabled: async () => on });
      for (let i = 0; i < 3; i += 1) rolling.noteEvent(event("turn.completed"));
      await rolling.idle();
      expect(runs).toHaveLength(0);

      on = true;
      for (let i = 0; i < 3; i += 1) rolling.noteEvent(event("turn.completed"));
      await rolling.idle();
      expect(runs).toHaveLength(1);
    });
  });

  describe("when it folds", () => {
    it("waits for the turn interval rather than folding every turn", async () => {
      const rolling = summarizer();
      rolling.noteEvent(event("turn.completed"));
      rolling.noteEvent(event("turn.completed"));
      await rolling.idle();
      expect(runs).toHaveLength(0);

      rolling.noteEvent(event("turn.completed"));
      await rolling.idle();
      expect(runs).toHaveLength(1);
    });

    it("folds again at session end when turns accumulated since the last one", async () => {
      const rolling = summarizer();
      for (let i = 0; i < 4; i += 1) rolling.noteEvent(event("turn.completed"));
      await rolling.idle();
      expect(runs).toHaveLength(1);

      // The 4th turn is unaccounted for — the summary a later rehydration
      // reads must not be a whole interval stale.
      rolling.noteEvent(event("session.end"));
      await rolling.idle();
      expect(runs).toHaveLength(2);
    });

    it("does not fold at session end when nothing happened since the last fold", async () => {
      const rolling = summarizer();
      for (let i = 0; i < 3; i += 1) rolling.noteEvent(event("turn.completed"));
      await rolling.idle();
      rolling.noteEvent(event("session.end"));
      await rolling.idle();
      expect(runs).toHaveLength(1);
    });

    it("counts turns per session, so two live sessions don't fold each other early", async () => {
      const rolling = summarizer();
      rolling.noteEvent(event("turn.completed", "session-a"));
      rolling.noteEvent(event("turn.completed", "session-b"));
      rolling.noteEvent(event("turn.completed", "session-a"));
      await rolling.idle();
      expect(runs).toHaveLength(0);

      rolling.noteEvent(event("turn.completed", "session-a"));
      await rolling.idle();
      expect(runs.map((run) => run.harnessSessionId)).toEqual(["session-a"]);
    });

    it("skips a session with nothing recorded", async () => {
      const rolling = summarizer({ readRecord: async () => null });
      for (let i = 0; i < 3; i += 1) rolling.noteEvent(event("turn.completed"));
      await rolling.idle();
      expect(runs).toEqual([]);
    });

    it("skips an id the registry no longer knows (a swept session, or a task's own id)", async () => {
      const rolling = summarizer({ getSession: () => undefined });
      for (let i = 0; i < 3; i += 1) rolling.noteEvent(event("turn.completed"));
      await rolling.idle();
      expect(runs).toEqual([]);
    });
  });

  describe("the task it runs", () => {
    it("is a bounded, cheap, one-shot run", async () => {
      const rolling = summarizer();
      for (let i = 0; i < 3; i += 1) rolling.noteEvent(event("turn.completed"));
      await rolling.idle();
      expect(runs[0]).toMatchObject({
        macroId: ROLLING_SUMMARY_MACRO_ID,
        harness: "claude-code",
        cwd: "/Users/dev/project",
        model: ROLLING_SUMMARY_MODEL,
        maxTurns: ROLLING_SUMMARY_MAX_TURNS,
      });
    });

    it("never throws into the ingest path when the task can't be spawned", async () => {
      // TaskManager throws TaskNotSupportedError for a harness with no
      // launchTask (codex today). That must be a log line, not an exception
      // travelling back up through a hook POST.
      const rolling = summarizer({
        runTask: async () => {
          throw new Error("codex sessions don't support background tasks yet");
        },
      });
      expect(() => {
        for (let i = 0; i < 3; i += 1) rolling.noteEvent(event("turn.completed"));
      }).not.toThrow();
      await rolling.idle();
      expect(errors).toHaveLength(1);
      expect(await readRollingSummary(generatedRoot, SESSION)).toBeNull();
    });
  });

  describe("writing summary.md", () => {
    it("writes the completed task's result text", async () => {
      const rolling = summarizer();
      for (let i = 0; i < 3; i += 1) rolling.noteEvent(event("turn.completed"));
      await rolling.idle();
      rolling.noteTaskStatus(task({ id: "task-1" }));
      await rolling.idle();
      expect(await readRollingSummary(generatedRoot, SESSION)).toBe(
        "The session made the retry backoff jittered.",
      );
    });

    it("ignores a task it did not start", async () => {
      const rolling = summarizer();
      rolling.noteTaskStatus(task({ id: "some-other-task", macroId: "visualize" }));
      await rolling.idle();
      expect(await readRollingSummary(generatedRoot, SESSION)).toBeNull();
    });

    it("leaves the previous summary in place when a fold fails", async () => {
      await mkdir(join(generatedRoot, SESSION), { recursive: true });
      await writeFile(rollingSummaryPath(generatedRoot, SESSION), "the older, still-true summary\n");

      const rolling = summarizer();
      for (let i = 0; i < 3; i += 1) rolling.noteEvent(event("turn.completed"));
      await rolling.idle();
      rolling.noteTaskStatus(task({ id: "task-1", status: "failed", resultText: null, errorTail: "boom" }));
      await rolling.idle();

      expect(await readRollingSummary(generatedRoot, SESSION)).toBe("the older, still-true summary");
      expect(errors).toHaveLength(1);
    });

    it("clamps a runaway summary to the word cap and marks the cut", async () => {
      const rolling = summarizer();
      for (let i = 0; i < 3; i += 1) rolling.noteEvent(event("turn.completed"));
      await rolling.idle();
      rolling.noteTaskStatus(task({ id: "task-1", resultText: "word ".repeat(2_000) }));
      await rolling.idle();
      const written = await readRollingSummary(generatedRoot, SESSION);
      expect(written).toContain("…[summary truncated]");
      expect(written!.split(/\s+/).length).toBeLessThan(2_000);
    });
  });

  describe("the fold prompt", () => {
    it("carries the record and asks for a bounded, tool-free, honest summary", () => {
      const prompt = buildRollingSummaryPrompt(record(), null);
      expect(prompt).toContain("at most 500 words");
      expect(prompt).toContain("FRESH coding-agent session");
      expect(prompt).not.toContain("FRESH agent session");
      expect(prompt).toContain("Do not use any tools");
      expect(prompt).toContain("Do not invent anything the material does not state");
      expect(prompt).toContain("make the backoff jittered");
    });

    it("folds the previous summary back in, since the material is itself capped", () => {
      const prompt = buildRollingSummaryPrompt(record(), "earlier: chose exponential backoff");
      expect(prompt).toContain("earlier: chose exponential backoff");
    });
  });

  it("clampToWords leaves a summary inside the cap untouched", () => {
    expect(clampToWords("a short summary", 500)).toBe("a short summary");
  });

  it("readRollingSummary answers null for a missing or blank file", async () => {
    expect(await readRollingSummary(generatedRoot, "never-existed")).toBeNull();
    await mkdir(join(generatedRoot, "blank"), { recursive: true });
    await writeFile(rollingSummaryPath(generatedRoot, "blank"), "   \n");
    expect(await readRollingSummary(generatedRoot, "blank")).toBeNull();
  });

  it("never lets a fold reject unhandled", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const rolling = summarizer({ readRecord: async () => Promise.reject(new Error("store on fire")) });
    for (let i = 0; i < 3; i += 1) rolling.noteEvent(event("turn.completed"));
    await rolling.idle();
    await new Promise((resolve) => setImmediate(resolve));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(errors).toHaveLength(1);
  });
});
