import type { HarnessKind } from "@shared/types";

/** Product names for the agent running a session — shared by the rail's
 *  session rows and the past-sessions list so the same agent never reads
 *  differently in two places. */
export const HARNESS_LABELS: Record<HarnessKind, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

/**
 * "just now" / "12m ago" / "3h ago" / "2d ago", falling back to a short
 * calendar date past a week — relative time is what makes two same-titled
 * sessions distinguishable at a glance.
 * `now` is injectable for tests only.
 */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const deltaMs = now - new Date(iso).getTime();
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}

/**
 * "under a minute" / "42m" / "1h 12m" / "2d 3h" — how long a session ran,
 * from its createdAt/lastActiveAt pair. Null on bad timestamps so callers
 * drop the row instead of showing a fabricated duration.
 */
export function formatDuration(startIso: string, endIso: string): string | null {
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/**
 * The one meta line under a past-session row: harness, then git branch and
 * turn count when the server parsed them (optional
 * fields, absent on older servers), then relative time. Parts that are
 * absent simply drop out; nothing is fabricated.
 */
export function historyRowMeta(summary: {
  harness: HarnessKind;
  gitBranch?: string;
  messageCount?: number;
  lastActiveAt: string;
}): string {
  const parts: string[] = [HARNESS_LABELS[summary.harness]];
  if (summary.gitBranch) parts.push(summary.gitBranch);
  if (summary.messageCount != null && summary.messageCount > 0) {
    parts.push(`${summary.messageCount} ${summary.messageCount === 1 ? "turn" : "turns"}`);
  }
  parts.push(formatRelativeTime(summary.lastActiveAt));
  return parts.join(" · ");
}
