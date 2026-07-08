/**
 * Codex transcript tailer — Codex has no hook system, so this file *is* its
 * entire analytics eventSource (see HarnessAdapter.eventSource ===
 * "transcript-tail" on CodexAdapter). It incrementally reads a rollout JSONL
 * file as Codex appends to it and translates each entry into the same
 * `{hookEvent, payload}` shape Claude Code's hooks would have produced for
 * equivalent activity — so the existing ingest pipeline
 * (core/collector/normalizer.ts's `normalizeHookEvent`) can consume both
 * harnesses unchanged, with zero Codex-specific branching in the normalizer.
 *
 * Self-contained by design: no imports from server/, session-manager.ts, or
 * the rest of core/collector/ (only types, imported for shape-compatibility
 * with the normalizer this feeds). Not wired into the server — see the
 * "Wiring this in" section of the PR description for the integration
 * contract (what to call, and when).
 */

import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ClaudeHookEvent, RawHookPayload } from "./normalizer.js";

const DEFAULT_POLL_INTERVAL_MS = 300;
const MAX_SCAN_DEPTH = 4; // ~/.codex/sessions/YYYY/MM/DD/*.jsonl

// ---------------------------------------------------------------------------
// Live tailing
// ---------------------------------------------------------------------------

export type CodexEventListener = (hookEvent: ClaudeHookEvent, payload: RawHookPayload) => void;

export interface CodexTailerOptions {
  /** Path to the rollout JSONL file. It's fine if this doesn't exist yet —
   * the tailer polls until Codex creates it (there's an unavoidable race
   * between spawning `codex` and it creating its rollout file). */
  rolloutPath: string;
  onEvent: CodexEventListener;
  onError?: (err: unknown) => void;
  pollIntervalMs?: number;
  /**
   * Tail from byte 0 regardless of the file's current size — for a fresh
   * launch, where the caller discovered this rollout file *because* it
   * already contains the session_meta line the caller cares about (a
   * find-then-tail race: by the time a poll-based discovery step returns a
   * path, Codex has necessarily already written to it). Without this, the
   * default "start from current size" baseline (correct for a genuine
   * resume, where prior content really is history to skip) would silently
   * swallow that already-written SessionStart. Defaults to false (resume
   * semantics: skip whatever's already there, only emit new activity).
   */
  startFromBeginning?: boolean;
}

export interface CodexTailerHandle {
  /** Stop polling without emitting anything further. */
  stop(): void;
  /**
   * Synthesize a SessionEnd hook-shaped event and stop polling. Codex's
   * rollout format has no "session ended" line of its own — call this when
   * the harness detects the underlying pty has exited.
   */
  emitSessionEnd(reason?: string): void;
}

interface RolloutLine {
  type?: string;
  payload?: Record<string, unknown>;
}

interface PendingFunctionCall {
  name: string;
  argumentsRaw: string;
}

/**
 * Incrementally tail a Codex rollout file, translating each new line into a
 * Claude-hook-shaped `(hookEvent, payload)` pair via `onEvent`. Only emits
 * for content appended *after* the tailer starts (matching hook semantics —
 * hooks only fire for new activity, never backfill); use
 * `CodexAdapter.listPastSessions` for history.
 */
export function tailCodexRollout(options: CodexTailerOptions): CodexTailerHandle {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let offset = 0;
  let carry = "";
  let sessionStartEmitted = false;
  let stopped = false;
  let polling = false;
  const pendingCalls = new Map<string, PendingFunctionCall>();

  // Resolve the resume-vs-fresh baseline exactly once, immediately, before
  // any poll reads content. `startFromBeginning` (see CodexTailerOptions)
  // always wins when set. Otherwise: if the file already exists right now,
  // its current size becomes the "don't backfill past this" offset (resume
  // — only new activity should be emitted, matching hook semantics); if it
  // doesn't exist yet, the offset stays 0, so once Codex creates the file
  // the very first bytes it writes are read as new.
  let baselineResolved = false;
  if (options.startFromBeginning) {
    baselineResolved = true;
  } else {
    void stat(options.rolloutPath).then(
      (s) => {
        offset = s.size;
        baselineResolved = true;
      },
      () => {
        baselineResolved = true;
      },
    );
  }

  const timer = setInterval(() => {
    void poll();
  }, pollIntervalMs);
  timer.unref?.();

  async function poll(): Promise<void> {
    if (stopped || polling || !baselineResolved) return;
    polling = true;
    try {
      const fileStat = await stat(options.rolloutPath);
      if (fileStat.size <= offset) return;

      const handle = await open(options.rolloutPath, "r");
      try {
        const length = fileStat.size - offset;
        const buffer = Buffer.allocUnsafe(length);
        await handle.read(buffer, 0, length, offset);
        offset = fileStat.size;

        const chunk = carry + buffer.toString("utf8");
        const lines = chunk.split("\n");
        carry = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      } finally {
        await handle.close();
      }
    } catch (err) {
      // ENOENT is the expected steady-state before Codex has created the
      // file yet — anything else is a real read/parse failure worth surfacing.
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        options.onError?.(err);
      }
    } finally {
      polling = false;
    }
  }

  function processLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let entry: RolloutLine;
    try {
      entry = JSON.parse(trimmed) as RolloutLine;
    } catch (err) {
      options.onError?.(err);
      return;
    }
    translate(entry);
  }

  function translate(entry: RolloutLine): void {
    const payload = entry.payload;

    if (entry.type === "session_meta") {
      if (sessionStartEmitted) return;
      sessionStartEmitted = true;
      options.onEvent("SessionStart", {
        source: "codex",
        cwd: typeof payload?.cwd === "string" ? payload.cwd : null,
        // Claude's normalizer resolves agentSessionId from a `session_id`
        // field on the hook payload — matching that field name here is what
        // lets normalizeHookEvent() pick up the rollout id unchanged.
        session_id: typeof payload?.id === "string" ? payload.id : undefined,
      });
      return;
    }

    if (entry.type === "event_msg") {
      if (payload?.type === "user_message" && typeof payload.message === "string") {
        options.onEvent("UserPromptSubmit", { prompt: payload.message });
      } else if (payload?.type === "task_complete") {
        options.onEvent("Stop", { stop_hook_active: false });
      }
      return;
    }

    if (entry.type === "response_item") {
      if (payload?.type === "function_call" && typeof payload.call_id === "string") {
        pendingCalls.set(payload.call_id, {
          name: typeof payload.name === "string" ? payload.name : "unknown",
          argumentsRaw: typeof payload.arguments === "string" ? payload.arguments : "",
        });
      } else if (payload?.type === "function_call_output" && typeof payload.call_id === "string") {
        const call = pendingCalls.get(payload.call_id);
        pendingCalls.delete(payload.call_id);
        options.onEvent("PostToolUse", {
          tool_name: call?.name ?? "unknown",
          tool_input: call?.argumentsRaw ?? "",
          tool_response: payload.output ?? "",
        });
      }
      return;
    }
  }

  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
    emitSessionEnd(reason?: string): void {
      if (stopped) return;
      options.onEvent("SessionEnd", { reason: reason ?? null });
      stopped = true;
      clearInterval(timer);
    },
  };
}

// ---------------------------------------------------------------------------
// Discovery: find the rollout file for a freshly-launched or resumed session
// ---------------------------------------------------------------------------

export interface FindRolloutFileOptions {
  /** Match a rollout file whose session_meta.cwd equals this exactly. */
  cwd: string;
  /** Only consider sessions created at/after this time (ms epoch) —
   * disambiguates a freshly-launched session from older ones sharing a cwd.
   * Ignored when `agentSessionId` is given (an exact id match is a strictly
   * stronger signal than a time-window heuristic). */
  sinceMs?: number;
  /**
   * Match a rollout file by its exact session_meta.id (the rollout/agent
   * session id) instead of by recency — needed when resuming a session,
   * where `sinceMs` can't disambiguate it from other sessions sharing the
   * same cwd that happen to have been touched more recently.
   */
  agentSessionId?: string;
  /** Overridable for tests. */
  homeDir?: string;
}

interface RolloutSessionMeta {
  id: string | null;
  cwd: string;
  timestampMs: number | null;
}

async function readSessionMetaHead(filePath: string, maxBytes = 65_536): Promise<RolloutSessionMeta | null> {
  let content: string;
  try {
    const handle = await open(filePath, "r");
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, maxBytes);
      const buffer = Buffer.allocUnsafe(length);
      await handle.read(buffer, 0, length, 0);
      content = buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }

  for (const line of content.split("\n").slice(0, 20)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: RolloutLine;
    try {
      parsed = JSON.parse(trimmed) as RolloutLine;
    } catch {
      continue;
    }
    if (parsed.type !== "session_meta") continue;
    const cwd = typeof parsed.payload?.cwd === "string" ? parsed.payload.cwd : undefined;
    if (!cwd) return null;
    const id = typeof parsed.payload?.id === "string" ? parsed.payload.id : null;
    const timestamp = typeof parsed.payload?.timestamp === "string" ? Date.parse(parsed.payload.timestamp) : NaN;
    return { id, cwd, timestampMs: Number.isNaN(timestamp) ? null : timestamp };
  }
  return null;
}

async function collectRolloutFiles(dir: string, depth = 0): Promise<string[]> {
  if (depth > MAX_SCAN_DEPTH) return [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const results: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await collectRolloutFiles(fullPath, depth + 1)));
    } else if (entry.name.endsWith(".jsonl")) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Finds a rollout file matching `cwd`. With `agentSessionId`, matches that
 * exact session (for resume — cwd alone is ambiguous when multiple sessions
 * share a directory). Otherwise returns the most-recently-modified match,
 * optionally bounded by `sinceMs`. Intended to be polled by the integrator
 * right after spawning a fresh `codex` process — there's no way to know the
 * exact rollout path in advance (it's a timestamp+UUID Codex generates itself).
 */
export async function findRolloutFile(options: FindRolloutFileOptions): Promise<string | null> {
  const homeDir = options.homeDir ?? homedir();
  const root = join(homeDir, ".codex", "sessions");
  const files = await collectRolloutFiles(root);

  let best: { path: string; mtimeMs: number } | null = null;
  for (const filePath of files) {
    const meta = await readSessionMetaHead(filePath);
    if (!meta || meta.cwd !== options.cwd) continue;

    if (options.agentSessionId !== undefined) {
      if (meta.id !== options.agentSessionId) continue;
      return filePath;
    }

    if (options.sinceMs !== undefined && meta.timestampMs !== null && meta.timestampMs < options.sinceMs) continue;

    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat) continue;
    if (!best || fileStat.mtimeMs > best.mtimeMs) best = { path: filePath, mtimeMs: fileStat.mtimeMs };
  }
  return best?.path ?? null;
}
