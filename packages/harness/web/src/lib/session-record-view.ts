/**
 * Presentation helpers for a reconstructed {@link SessionRecord} — the wording
 * of the honesty labels, and the small formatters the transcript view needs.
 *
 * Kept out of the component so the *claims the UI makes* are unit-testable
 * (React components are covered by the Playwright tier, see vitest.config.ts).
 * If the server grows a new limitation code, the fallback below keeps the note
 * honest rather than silently hiding a gap the user should know about.
 */
import type { SessionRecordLimitation, SessionRecordTurn } from "@shared/types";

/** One sentence per gap, in the order the UI should list them. */
const LIMITATION_NOTES: Record<SessionRecordLimitation, string> = {
  "assistant-narration-gap":
    "Only each turn's final assistant message was recorded — anything said between tool calls is missing.",
  "truncated-tool-output": "Large tool results were truncated when recorded and can't be shown in full.",
  "missing-assistant-text": "This agent doesn't report assistant text to the harness, so replies aren't shown.",
  "incomplete-final-turn": "The last turn never completed — the session ended while it was still running.",
};

const LIMITATION_ORDER: SessionRecordLimitation[] = [
  "assistant-narration-gap",
  "truncated-tool-output",
  "missing-assistant-text",
  "incomplete-final-turn",
];

/**
 * The notes to show under the "Reconstructed" label, deduped and in a stable
 * order. An unrecognized code (a newer server) still produces a note — an
 * unexplained gap is worse than an unpolished sentence.
 */
export function describeLimitations(limitations: readonly SessionRecordLimitation[]): string[] {
  const present = new Set(limitations);
  const known = LIMITATION_ORDER.filter((code) => present.has(code)).map((code) => LIMITATION_NOTES[code]);
  const unknown = [...present]
    .filter((code) => !(code in LIMITATION_NOTES))
    .map((code) => `Known gap reported by the harness: ${code}.`);
  return [...known, ...unknown];
}

/** "18.4k in · 612 out" — null when the turn recorded no usage at all. */
export function formatUsage(usage: SessionRecordTurn["usage"]): string | null {
  if (!usage) return null;
  const parts: string[] = [];
  if (usage.inputTokens != null) parts.push(`${formatTokens(usage.inputTokens)} in`);
  if (usage.outputTokens != null) parts.push(`${formatTokens(usage.outputTokens)} out`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  const thousands = count / 1000;
  // One decimal up to 100k (18.4k reads as a real number); whole thousands
  // above that, where the tenth is noise.
  return `${thousands < 100 ? thousands.toFixed(1) : Math.round(thousands)}k`;
}

/**
 * The per-turn timestamp: "14:32" for today, "1 Jul, 14:32" for any other day.
 *
 * The date isn't decoration — a past session can span days, and bare clock times
 * then repeat with no boundary between them, which reads as one long afternoon.
 * Returns null (rather than "Invalid Date") when the timestamp is missing or
 * unparsable. `now` is injectable for tests only.
 */
export function formatClockTime(iso: string | null, now: number = Date.now()): string | null {
  if (!iso) return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  const time = parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const today = new Date(now);
  const sameDay =
    parsed.getFullYear() === today.getFullYear() &&
    parsed.getMonth() === today.getMonth() &&
    parsed.getDate() === today.getDate();
  if (sameDay) return time;
  return `${parsed.toLocaleDateString([], { day: "numeric", month: "short" })}, ${time}`;
}

/** Compact one-line label for a tool call's collapsed summary row. */
export function toolCallLabel(name: string | null, input: string | null): string {
  const toolName = name ?? "unknown tool";
  if (!input) return toolName;
  const flattened = input.replace(/\s+/g, " ").trim();
  if (!flattened) return toolName;
  const clipped = flattened.length > 80 ? `${flattened.slice(0, 80)}…` : flattened;
  return `${toolName} · ${clipped}`;
}
