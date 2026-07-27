import type { HarnessKind, SessionSummary } from "@shared/types";

/**
 * Folds a fresh history load into the existing store: rows for the directories
 * that answered are REPLACED, every other directory's rows are retained.
 *
 * Callers request different scopes — the sessions popover asks for up to twelve
 * directories, the dead pane for the single one it needs a verified
 * `resumeMode` for. Replacing the whole store (what a plain `setHistory` does)
 * therefore lets the narrow caller evict the broad caller's rows, and the rail
 * rows that read `resumeMode` out of this store fall back to "checking…" until
 * something happens to reload them.
 *
 * Scoping by cwd rather than merging unconditionally keeps the other direction
 * honest too: re-loading a directory must be able to DROP a row whose
 * transcript is gone, which a blind merge could never do.
 *
 * Deduped by `agentSessionId` (a directory can appear under more than one
 * source) with fresh rows winning, and sorted newest first — the menu renders
 * one flat, global list.
 */
export function mergeHistory(
  previous: readonly SessionSummary[],
  refreshed: readonly SessionSummary[],
  refreshedCwds: ReadonlySet<string>,
): SessionSummary[] {
  const byAgentSessionId = new Map<string, SessionSummary>();
  for (const summary of refreshed) {
    if (!byAgentSessionId.has(summary.agentSessionId)) byAgentSessionId.set(summary.agentSessionId, summary);
  }
  for (const summary of previous) {
    if (refreshedCwds.has(summary.cwd)) continue; // superseded by this load
    if (!byAgentSessionId.has(summary.agentSessionId)) byAgentSessionId.set(summary.agentSessionId, summary);
  }
  return Array.from(byAgentSessionId.values()).sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
}

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
 *
 * A zero (or inverted) span is also null, not "under a minute": a session
 * adopted out of transcript history has `createdAt === lastActiveAt` because
 * nothing has run under our management yet, and "Ran for under a minute" would
 * be a number we invented. No measurable span → no duration row.
 */
export function formatDuration(startIso: string, endIso: string): string | null {
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
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
export function historyRowMeta(
  summary: {
    harness: HarnessKind;
    gitBranch?: string;
    messageCount?: number;
    lastActiveAt: string;
  },
  now: number = Date.now(),
): string {
  const parts: string[] = [HARNESS_LABELS[summary.harness]];
  if (summary.gitBranch) parts.push(summary.gitBranch);
  if (summary.messageCount != null && summary.messageCount > 0) {
    parts.push(`${summary.messageCount} ${summary.messageCount === 1 ? "turn" : "turns"}`);
  }
  // Relative time keys off lastActiveAt, never createdAt — a row's age is when
  // it was last actually active, and resume() no longer stamps that field for
  // an attempt that never produced a pty.
  parts.push(formatRelativeTime(summary.lastActiveAt, now));
  return parts.join(" · ");
}
