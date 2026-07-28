import type { HarnessKind, HarnessSession, SessionResumeMode, SessionSummary } from "@shared/types";

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

/** How many directories one history fan-out will ask for. Each is its own
 *  request, so this is the cap on a single open's cost. */
export const HISTORY_DIR_LIMIT = 12;

/**
 * The directories a history load should cover: the active session's first,
 * then every open session's, then recently-used ones — deduped, capped.
 *
 * Shared because the two surfaces that open history (the command palette and
 * the rail's past-sessions popover) want the same list. They each built it
 * privately, from the same two sources, and the lists differed only in
 * whether the active session's directory was hoisted — so opening both fanned
 * out twice per directory (the observed 24 requests for 12 directories).
 * One builder makes the second open a dedupe hit in `loadHistory` rather than
 * a second round-trip.
 */
export function historyDirs(
  sessions: readonly HarnessSession[],
  recentDirs: readonly string[],
  activeSessionId?: string | null,
): string[] {
  const dirs: string[] = [];
  const push = (dir?: string | null): void => {
    if (dir && !dirs.includes(dir)) dirs.push(dir);
  };
  push(sessions.find((session) => session.id === activeSessionId)?.cwd);
  sessions.forEach((session) => push(session.cwd));
  recentDirs.forEach((dir) => push(dir));
  return dirs.slice(0, HISTORY_DIR_LIMIT);
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
 * What opening a past-session row will actually do — the row's whole status,
 * resolved once from the two facts that decide it.
 *
 * These were previously collapsed into two words ("resumable" / "archived"),
 * which merged the two `rehydrate` cases that behave nothing alike: a real
 * conversation the agent forgot but WE recorded (continuable, from our brief)
 * and a session that ended before its first prompt (nothing exists anywhere).
 * The second is the common one — 29 of 62 rows on one real machine — and it
 * wore the same badge as the first.
 *
 * - `resume` — the agent still holds it; reattaches for real.
 * - `from-summary` — the agent doesn't, but our record does: a fresh session
 *   seeded with a reconstruction. Thinner than a resume, and says so.
 * - `empty` — neither. Opening it can only explain why (the dead-session pane).
 * - `checking` — history hasn't answered for this directory yet. Never guessed:
 *   guessing is what made a third of rows a button guaranteed to fail.
 */
export type SessionRowState = "resume" | "from-summary" | "empty" | "checking";

export function sessionRowState(row: {
  resumeMode?: SessionResumeMode;
  turnCount?: number;
  messageCount?: number;
}): SessionRowState {
  if (row.resumeMode === undefined) return "checking";
  if (row.resumeMode === "agent-resume") return "resume";
  // `rehydrate` splits on whether we recorded anything to rebuild from.
  // `turnCount` covers both live events and the archived record; `messageCount`
  // is the vendor scan, which only exists when a transcript does (and a row
  // with a transcript resolves to agent-resume anyway) — read for completeness,
  // not because it is expected to decide anything here.
  const turns = row.turnCount ?? row.messageCount ?? 0;
  return turns > 0 ? "from-summary" : "empty";
}

/** The state's meta-line word, or null when the state needs no word of its own. */
function stateLabel(state: SessionRowState): string | null {
  switch (state) {
    // The default outcome carries no label: annotating every ordinary row is
    // what crowded the list in the first place. Only the exceptions speak.
    case "resume":
      return null;
    case "from-summary":
      return "from summary";
    case "empty":
      return "nothing recorded";
    case "checking":
      return "checking…";
  }
}

export interface HistoryRowMetaOptions {
  /**
   * Drop the product name. The rail's rows render {@link HarnessBrandIcon}
   * immediately to the left, so spending a segment on "Claude Code" says the
   * same thing twice — and it repeats on every row. Surfaces without the glyph
   * (the dead-session pane) keep it.
   */
  includeHarness?: boolean;
  /** Appends the row's state word — see {@link stateLabel}. */
  state?: SessionRowState;
}

/**
 * The one meta line under a past-session row: git branch and turn count when
 * the server parsed them (optional fields, absent on older servers), what
 * opening the row will do, then relative time. Parts that are absent simply
 * drop out; nothing is fabricated.
 *
 * `turnCount` (our own event index: exact at any size) wins over
 * `messageCount` (the vendor-transcript scan, which gives up above its size
 * cap) whenever both are present.
 *
 * Defaults reproduce the pre-2026-07 line exactly, so the callers that want the
 * full form get it without opting in.
 */
export function historyRowMeta(
  summary: {
    harness: HarnessKind;
    gitBranch?: string;
    messageCount?: number;
    turnCount?: number;
    lastActiveAt: string;
  },
  now: number = Date.now(),
  options: HistoryRowMetaOptions = {},
): string {
  const parts: string[] = [];
  if (options.includeHarness !== false) parts.push(HARNESS_LABELS[summary.harness]);
  if (summary.gitBranch) parts.push(summary.gitBranch);
  const turns = summary.turnCount ?? summary.messageCount;
  if (turns != null && turns > 0) {
    parts.push(`${turns} ${turns === 1 ? "turn" : "turns"}`);
  }
  const state = options.state ? stateLabel(options.state) : null;
  if (state) parts.push(state);
  // Relative time keys off lastActiveAt, never createdAt — a row's age is when
  // it was last actually active, and resume() no longer stamps that field for
  // an attempt that never produced a pty.
  parts.push(formatRelativeTime(summary.lastActiveAt, now));
  return parts.join(" · ");
}
