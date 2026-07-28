/**
 * Rolling session summary — the thing that makes rehydration good rather than
 * merely possible.
 *
 * A resume brief built from the last N turns alone tells a fresh session what
 * just happened; it cannot tell it what the session was *for*. So, opt-in, we
 * periodically fold the whole record down to a ≤500-word summary and cache it
 * at `<generated>/<harnessSessionId>/summary.md`. The brief
 * (core/resume-brief.ts) picks it up when it's there and degrades cleanly to
 * last-N-turns when it isn't — which is the default, since this is
 * setting-gated (`HarnessSettings.rollingSummary`).
 *
 * NEVER BLOCKS A TURN. Everything here is fire-and-forget off the ingest path:
 * `noteEvent` returns synchronously, the fold runs as a headless one-shot
 * `TaskManager` job (a separate process, a cheap model, `--max-turns 1` — the
 * bounded shape `HarnessAdapter.launchTask` exists for), and every failure
 * mode short-circuits to "no summary". A user's session must never be slower,
 * or fail, because a summary didn't happen.
 *
 * The task does not write the file itself. It is asked for the summary text
 * and nothing else; we write `summary.md` from its `resultText` when it
 * completes. Two reasons: the target lives under `<generated>/`, outside the
 * session's cwd — which codex's `workspace-write` sandbox forbids and
 * claude-code's `acceptEdits` shouldn't be asked to reach — and a task that
 * writes its own output can half-write it, where a task that returns text
 * either produces a whole summary or none.
 *
 * WHERE IT DOESN'T WORK: `launchTask` is optional on the adapter contract and
 * codex has no non-interactive mode wired for it, so a codex session simply
 * never produces a summary and its briefs are last-N-turns. That is a real
 * gap, stated rather than papered over; the brief is honest either way.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { AnalyticsEvent, BackgroundTask, HarnessKind, SessionRecord } from "../shared/types.js";
import { buildResumeBrief } from "./resume-brief.js";

/** Filename under `<generated>/<harnessSessionId>/`. */
export const ROLLING_SUMMARY_FILE = "summary.md";
/** Completed turns that must accumulate before a re-fold is worth its cost. */
export const ROLLING_SUMMARY_TURN_INTERVAL = 10;
/** The contract stated in the prompt, and the clamp applied to what comes back. */
export const ROLLING_SUMMARY_MAX_WORDS = 500;
/**
 * Model alias for the fold. A summary of text we already hold is the cheapest
 * possible LLM job — pinning a small model here keeps an opt-in background
 * feature from quietly costing what the user's own session does.
 */
export const ROLLING_SUMMARY_MODEL = "haiku";
/** Hard turn cap: one turn in, one summary out. */
export const ROLLING_SUMMARY_MAX_TURNS = 1;
/** Macro id the task is registered under — also TaskManager's dedupe key, so
 *  a session can never have two folds in flight at once. */
export const ROLLING_SUMMARY_MACRO_ID = "rolling-summary";
/**
 * Token budget for the material handed to the fold. Larger than a brief's
 * (this is throwaway input to a cheap model, not a system prompt competing
 * with the user's own context) but still bounded, so a marathon session can't
 * turn one fold into a huge request.
 */
export const ROLLING_SUMMARY_INPUT_MAX_TOKENS = 20_000;

/** Absolute path of a session's cached summary. */
export function rollingSummaryPath(generatedRoot: string, harnessSessionId: string): string {
  return path.join(generatedRoot, harnessSessionId, ROLLING_SUMMARY_FILE);
}

/**
 * The cached summary for a session, or null when there is none — never throws.
 * A brief that fails to find a summary is a brief without one, not an error.
 */
export async function readRollingSummary(
  generatedRoot: string,
  harnessSessionId: string,
): Promise<string | null> {
  try {
    const text = await fs.readFile(rollingSummaryPath(generatedRoot, harnessSessionId), "utf8");
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/** Trim `text` to at most `maxWords` words, marking the cut. */
export function clampToWords(text: string, maxWords: number = ROLLING_SUMMARY_MAX_WORDS): string {
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) return text.trim();
  return `${words.slice(0, maxWords).join(" ")} …[summary truncated]`;
}

/**
 * The one-shot prompt handed to `launchTask`. The material is the record
 * rendered by {@link buildResumeBrief} at a larger budget — deliberately the
 * same renderer the brief uses, so the fold reads exactly the shape a future
 * brief will present, and there is one place where "what a record looks like
 * as text" is defined.
 *
 * `previous` is folded back in rather than discarded: the record itself is
 * capped at the input budget, so on a long session the earliest turns are
 * already gone from the material, and the last summary is the only surviving
 * account of them.
 */
export function buildRollingSummaryPrompt(record: SessionRecord, previous: string | null): string {
  const material = buildResumeBrief(record, {
    summary: previous,
    maxTokens: ROLLING_SUMMARY_INPUT_MAX_TOKENS,
    maxTurns: Number.MAX_SAFE_INTEGER,
  });
  return [
    `Summarize the coding session described below in at most ${ROLLING_SUMMARY_MAX_WORDS} words.`,
    "",
    "The summary is read by a FRESH agent session that has none of this context,",
    "so write for someone picking the work up cold. Cover, in this order and only",
    "where the material actually supports it:",
    "",
    "1. What the session was trying to accomplish.",
    "2. What was decided, and why — decisions are the part a transcript replay",
    "   cannot reconstruct.",
    "3. What was actually changed (files, behaviour).",
    "4. What is unfinished, blocked, or known-broken.",
    "",
    "Rules:",
    "- Output ONLY the summary as markdown prose. No preamble, no sign-off, no",
    "  code fences around the whole thing.",
    "- Do not invent anything the material does not state. If something is",
    "  unclear or was never recorded, say so or leave it out — a confident",
    "  summary of a gap is the single worst outcome here.",
    "- Do not use any tools. Everything you need is in this prompt.",
    "",
    "--- SESSION MATERIAL ---",
    "",
    material,
  ].join("\n");
}

/** What the summarizer needs from the outside world. All injectable, so the
 *  unit tests drive it without a filesystem or a spawned process. */
export interface RollingSummarizerDeps {
  /** Root the per-session generated dirs live under. */
  generatedRoot: string;
  /** The `HarnessSettings.rollingSummary` gate, re-read per fold so toggling
   *  the setting takes effect without a restart. Never throws. */
  enabled: () => Promise<boolean>;
  /** Reads the reconstructed record for a session (SessionRecordReader.read). */
  readRecord: (harnessSessionId: string) => Promise<SessionRecord | null>;
  /** The live session, for the harness kind and cwd the task runs as. Returns
   *  undefined once the session is gone from the registry. */
  getSession: (harnessSessionId: string) => { harness: HarnessKind; cwd: string } | undefined;
  /** TaskManager.run, narrowed to what this needs. */
  runTask: (req: {
    macroId: string;
    label: string;
    harnessSessionId: string;
    harness: HarnessKind;
    cwd: string;
    prompt: string;
    model: string;
    maxTurns: number;
  }) => Promise<BackgroundTask>;
  /** Completed turns between folds. Default {@link ROLLING_SUMMARY_TURN_INTERVAL}. */
  turnInterval?: number;
  /** Diagnostics sink. Defaults to console.error — a fold failing is worth a
   *  log line and nothing more. */
  onError?: (err: unknown) => void;
}

export interface RollingSummarizer {
  /**
   * Feed one normalized analytics event. Synchronous and total: it counts
   * `turn.completed`, triggers a fold on the interval and on `session.end`,
   * and ignores everything else. Any work it starts is detached.
   */
  noteEvent(event: AnalyticsEvent): void;
  /**
   * Feed a task status change (TaskManager.onStatusChange). A completed fold
   * task's `resultText` is what becomes `summary.md`.
   */
  noteTaskStatus(task: BackgroundTask): void;
  /** Resolves when no fold this summarizer started is still in flight. For
   *  tests and for shutdown; production callers never need to await it. */
  idle(): Promise<void>;
}

export function createRollingSummarizer(deps: RollingSummarizerDeps): RollingSummarizer {
  const turnInterval = deps.turnInterval ?? ROLLING_SUMMARY_TURN_INTERVAL;
  const onError = deps.onError ?? ((err: unknown) => console.error("[harness] rolling summary failed:", err));

  /** Completed turns seen for a session since its last fold was *started*. */
  const turnsSinceFold = new Map<string, number>();
  /** Fold task id → the session it summarizes, so a completion can be routed
   *  back. Only ids this summarizer started are ever in here, which is what
   *  keeps it from writing summary.md for some other background task. */
  const foldTargets = new Map<string, string>();
  /** In-flight promises, awaited by `idle()`. */
  const pending = new Set<Promise<void>>();

  const track = (work: Promise<void>): void => {
    const tracked = work.catch(onError).finally(() => pending.delete(tracked));
    pending.add(tracked);
  };

  async function fold(harnessSessionId: string): Promise<void> {
    if (!(await deps.enabled())) return;
    const session = deps.getSession(harnessSessionId);
    // Gone from the registry (swept, or a task's own id leaking through the
    // ingest path) — there is nothing to run the fold as.
    if (!session) return;
    const record = await deps.readRecord(harnessSessionId);
    if (!record || record.turns.length === 0) return;

    const previous = await readRollingSummary(deps.generatedRoot, harnessSessionId);
    const task = await deps.runTask({
      macroId: ROLLING_SUMMARY_MACRO_ID,
      label: "Session summary",
      harnessSessionId,
      harness: session.harness,
      cwd: session.cwd,
      prompt: buildRollingSummaryPrompt(record, previous),
      model: ROLLING_SUMMARY_MODEL,
      maxTurns: ROLLING_SUMMARY_MAX_TURNS,
    });
    foldTargets.set(task.id, harnessSessionId);
  }

  async function writeSummary(harnessSessionId: string, text: string): Promise<void> {
    const clamped = clampToWords(text.trim());
    if (clamped.length === 0) return;
    const filePath = rollingSummaryPath(deps.generatedRoot, harnessSessionId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${clamped}\n`, "utf8");
  }

  return {
    noteEvent(event: AnalyticsEvent): void {
      const sessionId = event.harnessSessionId;
      if (event.type === "turn.completed") {
        const count = (turnsSinceFold.get(sessionId) ?? 0) + 1;
        if (count < turnInterval) {
          turnsSinceFold.set(sessionId, count);
          return;
        }
        // Reset BEFORE the fold rather than after it completes: the counter
        // paces how often folds are *started*, and resetting on completion
        // would let a slow fold queue up a second one the moment it lands.
        turnsSinceFold.set(sessionId, 0);
        track(fold(sessionId));
        return;
      }
      if (event.type === "session.end") {
        // Always fold at session end when anything at all happened since the
        // last one — this is the summary a future rehydration will actually
        // read, so it must not be `turnInterval - 1` turns stale.
        const pendingTurns = turnsSinceFold.get(sessionId) ?? 0;
        turnsSinceFold.delete(sessionId);
        if (pendingTurns > 0) track(fold(sessionId));
      }
    },

    noteTaskStatus(task: BackgroundTask): void {
      const harnessSessionId = foldTargets.get(task.id);
      if (harnessSessionId === undefined) return;
      if (task.status === "running") return;
      foldTargets.delete(task.id);
      if (task.status === "failed" || !task.resultText) {
        // A failed fold leaves the previous summary in place — a stale summary
        // is strictly better than none, and the brief labels its own age via
        // the record's own timestamps either way.
        if (task.status === "failed") onError(new Error(task.errorTail ?? "rolling summary task failed"));
        return;
      }
      track(writeSummary(harnessSessionId, task.resultText));
    },

    async idle(): Promise<void> {
      // Re-read the set each pass: writing a summary is itself tracked work
      // started by an earlier tracked promise.
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}
