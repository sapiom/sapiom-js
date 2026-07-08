/**
 * Backfills `turn.completed` events with model + token usage by tail-reading
 * the Claude Code transcript JSONL named in the hook payload's
 * `transcript_path`. The assistant's message text itself comes straight off
 * the Stop hook payload (`last_assistant_message`, see normalizer.ts) — it's
 * available synchronously and doesn't depend on the transcript file, which
 * may not exist on disk yet (or at all) at the moment Stop fires. This
 * module only ever *supplements* that with model/usage, and falls back to
 * its own transcript-derived text if the hook payload somehow didn't have
 * one.
 *
 * Transcripts can grow to hundreds of MB over a long session, so this only
 * ever reads the last ~2MB from the end of the file.
 */

import * as fs from "node:fs/promises";

import type { AnalyticsEvent } from "../../shared/types.js";

const DEFAULT_MAX_TAIL_BYTES = 2 * 1024 * 1024;

export interface TranscriptTurn {
  model: string | null;
  assistantText: string | null;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
  } | null;
}

interface TranscriptContentBlock {
  type?: string;
  text?: string;
}

interface TranscriptMessage {
  role?: string;
  model?: string;
  content?: string | TranscriptContentBlock[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

interface TranscriptLine {
  type?: string;
  message?: TranscriptMessage;
}

function extractText(content: TranscriptMessage["content"]): string | null {
  if (typeof content === "string") return content || null;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return text || null;
}

function extractUsage(usage: TranscriptMessage["usage"]): TranscriptTurn["usage"] {
  if (!usage) return null;
  const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : null;
  const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : null;
  if (inputTokens === null && outputTokens === null) return null;
  return { inputTokens, outputTokens };
}

function tryParseLine(line: string): TranscriptLine | null {
  try {
    return JSON.parse(line) as TranscriptLine;
  } catch {
    return null;
  }
}

/**
 * Read the last `maxBytes` of a transcript JSONL file and return the most
 * recent assistant turn found in it, or `null` if the file is missing,
 * unreadable, or has no assistant turn in the tail window.
 */
export async function readLastAssistantTurn(
  transcriptPath: string,
  maxBytes = DEFAULT_MAX_TAIL_BYTES,
): Promise<TranscriptTurn | null> {
  let handle: fs.FileHandle | null = null;
  try {
    const stat = await fs.stat(transcriptPath);
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    if (length <= 0) return null;

    handle = await fs.open(transcriptPath, "r");
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);

    const lines = buffer.toString("utf8").split("\n").filter((line) => line.length > 0);
    // If we started mid-file, the first line is a truncated fragment.
    if (start > 0 && lines.length > 0) lines.shift();

    for (let i = lines.length - 1; i >= 0; i--) {
      const parsed = tryParseLine(lines[i]);
      const message = parsed?.message;
      if (parsed?.type === "assistant" && message) {
        return {
          model: typeof message.model === "string" ? message.model : null,
          assistantText: extractText(message.content),
          usage: extractUsage(message.usage),
        };
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Enrich a `turn.completed` event's payload with transcript data (model,
 * usage, and a fallback assistantText). No-op for any other event type, or
 * when no transcript path is available, or when the transcript can't be
 * read (e.g. not written to disk yet) — none of that should ever clobber
 * the assistantText the Stop hook payload already supplied.
 */
export async function enrichTurnCompleted(
  event: AnalyticsEvent,
  transcriptPath: string | undefined,
  maxBytes?: number,
): Promise<AnalyticsEvent> {
  if (event.type !== "turn.completed" || !transcriptPath) return event;

  const turn = await readLastAssistantTurn(transcriptPath, maxBytes);
  if (!turn) return event;

  const existingAssistantText =
    typeof event.payload.assistantText === "string" ? event.payload.assistantText : null;

  return {
    ...event,
    payload: {
      ...event.payload,
      model: turn.model,
      assistantText: existingAssistantText ?? turn.assistantText,
      usage: turn.usage,
    },
  };
}
