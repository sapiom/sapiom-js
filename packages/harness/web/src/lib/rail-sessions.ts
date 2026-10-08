/**
 * Project › Sessions: which sessions the rail lists under which project, in
 * what order, wearing which mark (flow-navigation.md 4.1, design.md I1).
 *
 * ONE membership rule for the whole shell. The tab strip this replaces had
 * three hand-kept copies of its filter (the strip, Cmd/Ctrl+1..9, and the
 * rail's live count), and they already disagreed: the rail's copy had two
 * branches, the App's four. Three copies of one rule is how a shortcut comes
 * to open a session the screen is not showing. The rail, the shortcut and the
 * map's agent panel all read this module, and nothing else filters sessions by
 * project.
 *
 * Membership is the server-issued project identity, never a path: a session
 * belongs to exactly one project (`agentMapIdentity.projectId`), so an outer
 * project cannot absorb a nested project's sessions just because its root
 * contains their cwd.
 *
 * Pure and structurally typed, like `session-scope.ts`: a test pins a rule
 * with an object literal, and nothing here can start depending on React state.
 */

/** The session fields these rules read. `HarnessSession` satisfies it. */
export interface ListedSession {
  id: string;
  status: string;
  createdAt: string;
  lastActiveAt?: string | null;
  boundWorkflowPath?: string | null;
  agentMapIdentity?: { projectId: string } | null;
}

/** How long an exited session stays in the rail before it is History only
 *  (flow Q4). Older ones are one glyph away, in the Past sessions card. */
export const EXITED_LISTING_DAYS = 7;

/** A running session quiet for longer than this reads as idle, not live. The
 *  mark answers "is anything happening in there", and a process that has been
 *  alive and silent since lunch is not happening. */
export const IDLE_AFTER_MINUTES = 10;

export type SessionMark = "live" | "idle" | "exited";

const activityOf = (session: ListedSession): string =>
  session.lastActiveAt ?? session.createdAt;

/**
 * Whether the rail lists a session at all (flow Q4): every live one, and an
 * exited one only while it was active in the last seven days and the user has
 * not hidden it with `×`. Only an exited session can be hidden: a hidden live
 * row would be a running process with no row to stop it from.
 */
export function isListed(
  session: ListedSession,
  hidden: ReadonlySet<string>,
  now: number,
): boolean {
  if (session.status !== "exited") return true;
  if (hidden.has(session.id)) return false;
  const at = new Date(activityOf(session)).getTime();
  if (!Number.isFinite(at)) return false;
  return now - at <= EXITED_LISTING_DAYS * 24 * 60 * 60_000;
}

/** Newest activity first, then newest created, then id, so two sessions with
 *  one timestamp never swap places between renders. */
export function byNewestActivity(a: ListedSession, b: ListedSession): number {
  return (
    activityOf(b).localeCompare(activityOf(a)) ||
    b.createdAt.localeCompare(a.createdAt) ||
    a.id.localeCompare(b.id)
  );
}

/**
 * The rail's sessions for one project, in rail order. Cmd/Ctrl+1..9 indexes
 * this same list, so the shortcut can never pick a session the rail is not
 * showing. A session with no project identity belongs to no project: History
 * and Search reach it.
 */
export function railSessions<S extends ListedSession>(
  sessions: readonly S[],
  projectId: string | null,
  hidden: ReadonlySet<string>,
  now: number,
): S[] {
  if (!projectId) return [];
  const seen = new Set<string>();
  return sessions
    .filter(
      (session) =>
        session.agentMapIdentity?.projectId === projectId &&
        isListed(session, hidden, now),
    )
    .sort(byNewestActivity)
    .filter((session) => {
      // A malformed duplicate projection must not draw one session twice.
      if (seen.has(session.id)) return false;
      seen.add(session.id);
      return true;
    });
}

/** An agent's own sessions, for the map's agent panel: the ones bound to it
 *  that its project lists, in the order the rail shows them. */
export function sessionsForAgent<S extends ListedSession>(
  sessions: readonly S[],
  projectId: string | null,
  agentPath: string,
  hidden: ReadonlySet<string>,
  now: number,
): S[] {
  return railSessions(sessions, projectId, hidden, now).filter(
    (session) => (session.boundWorkflowPath ?? null) === agentPath,
  );
}

/** live / idle / exited. `busy` is the bus's "output in the last few
 *  seconds", which is live whatever the timestamp says. */
export function sessionMark(
  session: ListedSession,
  busy: boolean,
  now: number,
): SessionMark {
  if (session.status === "exited") return "exited";
  if (busy || session.status === "starting") return "live";
  const at = new Date(activityOf(session)).getTime();
  if (!Number.isFinite(at)) return "live";
  return now - at > IDLE_AFTER_MINUTES * 60_000 ? "idle" : "live";
}

/**
 * The session Cmd/Ctrl+N selects: the Nth row of the SELECTED project, which
 * is the project whose map is showing, else the selected session's project.
 */
export function sessionForShortcut<S extends ListedSession>(
  n: number,
  input: {
    sessions: readonly S[];
    hidden: ReadonlySet<string>;
    now: number;
    /** The project whose map (or agent canvas) is the centre, if any. */
    shownProjectId: string | null;
    activeSessionId: string | null;
  },
): S | null {
  const active =
    input.sessions.find((session) => session.id === input.activeSessionId) ??
    null;
  const projectId =
    input.shownProjectId ?? active?.agentMapIdentity?.projectId ?? null;
  return (
    railSessions(input.sessions, projectId, input.hidden, input.now)[n - 1] ??
    null
  );
}
