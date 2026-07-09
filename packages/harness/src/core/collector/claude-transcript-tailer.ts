/**
 * Claude Code session transcript tailer — produces chat events (ChatTurn,
 * ChatToolCall) from Claude Code's session JSONL files.
 *
 * Claude Code stores session transcripts at:
 *   ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
 *
 * where <encoded-cwd> strips the leading "/" and replaces "/" and "." with "-"
 * (see ClaudeCodeAdapter.encodeProjectPath / listPastSessions).
 *
 * Each line is a JSON object with a `type` field:
 *   - "user" — user message (content: string | ContentBlock[])
 *   - "assistant" — assistant turn (message.content: ContentBlock[])
 *   - "summary" — compact session summary (not a conversation turn)
 *   - "tool_use" — not directly present; tool_use blocks are inside assistant content
 *   - "tool_result" — not directly present; follow as user turns with tool_result blocks
 *
 * Actual Claude Code JSONL line shapes (observed):
 *   { "type": "user", "message": { "role": "user", "content": "..." } }
 *   { "type": "assistant", "message": { "role": "assistant", "content": [...] } }
 *   { "type": "summary", "summary": "..." }
 *
 * The assistant's content array can include:
 *   { "type": "text", "text": "..." }
 *   { "type": "tool_use", "id": "...", "name": "...", "input": {...} }
 *
 * A following user message may contain:
 *   { "type": "tool_result", "tool_use_id": "...", "content": "..." }
 *
 * This tailer:
 *   1. Reads history from the transcript on open (modest head + tail to cap I/O)
 *   2. Polls for new content at the same 300ms cadence as the codex tailer
 *   3. Translates each new line into chat.turn / chat.tool bus events
 *
 * Privacy: outputs only chat UI events — nothing here writes to the analytics
 * store. The hook pipeline already captures prompts via UserPromptSubmit.
 */

import { open, stat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import * as crypto from "node:crypto";

import type { ChatTurn, ChatToolCall } from "../../shared/types.js";

const DEFAULT_POLL_INTERVAL_MS = 300;

/** Maximum bytes read for the history snapshot on session open. */
const HISTORY_MAX_BYTES = 128 * 1024;

export type ChatTurnListener = (turn: ChatTurn) => void;
export type ChatToolListener = (call: ChatToolCall) => void;

export interface ClaudeTranscriptTailerOptions {
  transcriptPath: string;
  onTurn: ChatTurnListener;
  onToolCall: ChatToolListener;
  onError?: (err: unknown) => void;
  pollIntervalMs?: number;
  /** If true, emit from byte 0 (fresh launch). Default: start after current size. */
  startFromBeginning?: boolean;
}

export interface ClaudeTranscriptTailerHandle {
  stop(): void;
  /** Read and return history turns (already-written lines) for the open snapshot. */
  readHistory(): Promise<ChatTurn[]>;
}

interface TranscriptLine {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
  summary?: string;
}

interface ContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as ContentBlock[])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n");
  }
  return "";
}

function extractToolUseBlocks(content: unknown): ContentBlock[] {
  if (!Array.isArray(content)) return [];
  return (content as ContentBlock[]).filter((b) => b.type === "tool_use" && typeof b.id === "string");
}

function extractToolResultBlocks(content: unknown): ContentBlock[] {
  if (!Array.isArray(content)) return [];
  return (content as ContentBlock[]).filter(
    (b) => b.type === "tool_result" && typeof b.tool_use_id === "string",
  );
}

function makeId(): string {
  return crypto.randomUUID();
}

/**
 * Parse JSONL content into chat turns and tool calls.
 * Returns them in order as they appear in the transcript.
 */
function parseTranscriptLines(lines: string[]): { turns: ChatTurn[]; toolCalls: ChatToolCall[] } {
  const turns: ChatTurn[] = [];
  const toolCalls: ChatToolCall[] = [];

  // Track pending tool_use ids so we can emit ok when tool_result arrives
  const pendingToolUses = new Map<string, { name: string; callId: string }>();

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let entry: TranscriptLine;
    try {
      entry = JSON.parse(line) as TranscriptLine;
    } catch {
      continue;
    }

    const ts = new Date().toISOString();

    if (entry.type === "user") {
      const content = entry.message?.content;
      // Check for tool_result blocks first — these are not user messages to show
      const toolResults = extractToolResultBlocks(content);
      if (toolResults.length > 0) {
        for (const block of toolResults) {
          const pending = pendingToolUses.get(block.tool_use_id ?? "");
          if (pending) {
            pendingToolUses.delete(block.tool_use_id ?? "");
            toolCalls.push({ callId: pending.callId, toolName: pending.name, status: "ok", ts });
          }
        }
        // A user message can be ONLY tool_results (no text turn) or mixed
        const text = extractText(
          Array.isArray(content) ? content.filter((b: ContentBlock) => b.type !== "tool_result") : content,
        );
        if (text.trim()) {
          turns.push({ turnId: makeId(), role: "user", content: text.trim(), ts });
        }
      } else {
        const text = extractText(content);
        if (text.trim()) {
          turns.push({ turnId: makeId(), role: "user", content: text.trim(), ts });
        }
      }
    } else if (entry.type === "assistant") {
      const content = entry.message?.content;

      // Emit tool_use starts before the text turn
      const toolUseBlocks = extractToolUseBlocks(content);
      for (const block of toolUseBlocks) {
        const callId = makeId();
        const name = typeof block.name === "string" ? block.name : "unknown";
        const id = typeof block.id === "string" ? block.id : "";
        if (id) pendingToolUses.set(id, { name, callId });
        toolCalls.push({ callId, toolName: name, status: "start", ts });
      }

      const text = extractText(
        Array.isArray(content) ? content.filter((b: ContentBlock) => b.type !== "tool_use") : content,
      );
      if (text.trim()) {
        turns.push({ turnId: makeId(), role: "assistant", content: text.trim(), ts });
      }
    }
    // "summary" lines are not conversation turns — skip
  }

  return { turns, toolCalls };
}

/**
 * Tail a Claude Code session transcript JSONL, emitting chat events for new
 * content. The handle's `readHistory()` provides the already-written portion.
 */
export function tailClaudeTranscript(options: ClaudeTranscriptTailerOptions): ClaudeTranscriptTailerHandle {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let offset = 0;
  let carry = "";
  let stopped = false;
  let polling = false;

  // Track pending tool_use ids across incremental polls
  const pendingToolUses = new Map<string, { name: string; callId: string }>();

  // Resolve the baseline offset exactly once before polling starts
  let baselineResolved = false;
  if (options.startFromBeginning) {
    baselineResolved = true;
  } else {
    void stat(options.transcriptPath).then(
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
      const fileStat = await stat(options.transcriptPath);
      if (fileStat.size <= offset) return;

      const handle = await open(options.transcriptPath, "r");
      try {
        const length = fileStat.size - offset;
        const buffer = Buffer.allocUnsafe(length);
        await handle.read(buffer, 0, length, offset);
        offset = fileStat.size;

        const chunk = carry + buffer.toString("utf8");
        const lines = chunk.split("\n");
        carry = lines.pop() ?? "";
        for (const line of lines) processLine(line, new Date().toISOString());
      } finally {
        await handle.close();
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        options.onError?.(err);
      }
    } finally {
      polling = false;
    }
  }

  function processLine(raw: string, ts: string): void {
    const line = raw.trim();
    if (!line) return;
    let entry: TranscriptLine;
    try {
      entry = JSON.parse(line) as TranscriptLine;
    } catch (err) {
      options.onError?.(err);
      return;
    }
    translateLine(entry, ts);
  }

  function translateLine(entry: TranscriptLine, ts: string): void {
    if (entry.type === "user") {
      const content = entry.message?.content;
      const toolResults = extractToolResultBlocks(content);
      if (toolResults.length > 0) {
        for (const block of toolResults) {
          const pending = pendingToolUses.get(block.tool_use_id ?? "");
          if (pending) {
            pendingToolUses.delete(block.tool_use_id ?? "");
            options.onToolCall({ callId: pending.callId, toolName: pending.name, status: "ok", ts });
          }
        }
        const textContent = Array.isArray(content)
          ? content.filter((b: ContentBlock) => b.type !== "tool_result")
          : content;
        const text = extractText(textContent);
        if (text.trim()) {
          options.onTurn({ turnId: makeId(), role: "user", content: text.trim(), ts });
        }
      } else {
        const text = extractText(content);
        if (text.trim()) {
          options.onTurn({ turnId: makeId(), role: "user", content: text.trim(), ts });
        }
      }
    } else if (entry.type === "assistant") {
      const content = entry.message?.content;

      const toolUseBlocks = extractToolUseBlocks(content);
      for (const block of toolUseBlocks) {
        const callId = makeId();
        const name = typeof block.name === "string" ? block.name : "unknown";
        const id = typeof block.id === "string" ? block.id : "";
        if (id) pendingToolUses.set(id, { name, callId });
        options.onToolCall({ callId, toolName: name, status: "start", ts });
      }

      const textContent = Array.isArray(content)
        ? content.filter((b: ContentBlock) => b.type !== "tool_use")
        : content;
      const text = extractText(textContent);
      if (text.trim()) {
        options.onTurn({ turnId: makeId(), role: "assistant", content: text.trim(), ts });
      }
    }
    // "summary" lines are not conversation turns — skip
  }

  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },

    async readHistory(): Promise<ChatTurn[]> {
      // Read up to HISTORY_MAX_BYTES from the beginning of the transcript
      let content: string;
      try {
        const fileStat = await stat(options.transcriptPath);
        const length = Math.min(fileStat.size, HISTORY_MAX_BYTES);
        const handle = await open(options.transcriptPath, "r");
        try {
          const buffer = Buffer.allocUnsafe(length);
          await handle.read(buffer, 0, length, 0);
          content = buffer.toString("utf8");
        } finally {
          await handle.close();
        }
      } catch {
        return [];
      }

      const lines = content.split("\n");
      // Drop the last line if we hit the byte cap (may be truncated)
      if (content.length >= HISTORY_MAX_BYTES) lines.pop();

      const { turns } = parseTranscriptLines(lines);
      return turns;
    },
  };
}

// ---------------------------------------------------------------------------
// Discovery: find the transcript file for a Claude Code session
// ---------------------------------------------------------------------------

/**
 * Encode a project cwd the same way Claude Code does for its transcript
 * directory names: strip leading "/" and replace "/" and "." with "-".
 */
export function encodeProjectPath(cwd: string): string {
  const normalized = cwd.replace(/\\/g, "/");
  return normalized.replace(/:/g, "").replace(/[/.]/g, "-");
}

export interface FindTranscriptOptions {
  cwd: string;
  /** Match a specific agent session id (UUID = transcript basename). */
  agentSessionId?: string;
  /** Override for tests. */
  homeDir?: string;
}

/**
 * Find the transcript file for a Claude Code session.
 * With `agentSessionId`: returns `<projects-dir>/<encoded-cwd>/<id>.jsonl`.
 * Without: returns the most-recently-modified transcript in the cwd directory.
 */
export async function findClaudeTranscript(options: FindTranscriptOptions): Promise<string | null> {
  const homeDir = options.homeDir ?? homedir();
  const projectDir = join(homeDir, ".claude", "projects", encodeProjectPath(options.cwd));

  if (options.agentSessionId) {
    return join(projectDir, `${options.agentSessionId}.jsonl`);
  }

  // Find most-recently-modified .jsonl in the project directory
  let entries: string[];
  try {
    entries = await readdir(projectDir);
  } catch {
    return null;
  }

  let best: { path: string; mtimeMs: number } | null = null;
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    const filePath = join(projectDir, entry);
    try {
      const s = await stat(filePath);
      if (!best || s.mtimeMs > best.mtimeMs) {
        best = { path: filePath, mtimeMs: s.mtimeMs };
      }
    } catch {
      // Skip unreadable files
    }
  }
  return best?.path ?? null;
}

/**
 * Return a transcript path given a session's agentSessionId and cwd.
 * Called from server/index.ts when a session becomes running (hooks adapter).
 */
export function transcriptPathForSession(cwd: string, agentSessionId: string, homeDir?: string): string {
  const home = homeDir ?? homedir();
  return join(home, ".claude", "projects", encodeProjectPath(cwd), `${agentSessionId}.jsonl`);
}

/** Extract just the session id (UUID) from a transcript file path. */
export function agentSessionIdFromTranscriptPath(transcriptPath: string): string {
  return basename(transcriptPath, ".jsonl");
}
