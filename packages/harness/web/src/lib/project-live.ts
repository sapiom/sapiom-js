/**
 * Whether a project (or a group) is LIVE: one of its agents has a running
 * session (SAP-3200, design-eng DECISIONS D37).
 *
 * The rail lists no sessions, and this does not change that. It is a DERIVED
 * fact about a project, the same kind of fact the deploy glyph is about an
 * agent, so that "is anything running in here" can be answered at a glance
 * without the rail growing session rows it deliberately does not have.
 *
 * Pure, and free of React and of fixtures, for the reason `session-scope.ts`
 * gives: a rule you can call with two arguments is a rule a test can pin, and
 * the mark and its specs then read ONE definition rather than two that drift.
 *
 * Containment is `rootContains`, the app's one containment answer, applied to
 * the two fields a session can be attached by. Nothing here re-implements it.
 */
import { samePath } from "./paths";
import { rootContains, type ScopedSession } from "./session-scope";

/** Live is anything that has not exited: a session still starting is about to
 *  be running, and a mark that waits for the transition would blink off during
 *  exactly the moment the user just asked for. */
const isLive = (session: ScopedSession): boolean => session.status !== "exited";

/**
 * The live sessions a PROJECT holds: rooted inside it, or bound to an agent
 * inside it.
 *
 * `liveSessionsForProject` (session-scope.ts) answers the tab strip's question
 * with the containment clause alone, and since SAP-2927 every session boots at
 * its project root, so in practice the two agree on every session the app
 * creates. The binding clause is here because the mark answers a slightly
 * different question ("does this project have anything running"), and a
 * session bound to an agent in the project is running in the project whatever
 * its cwd says. It can only ever ADD a session that genuinely belongs here, so
 * the mark cannot claim a project is live on the strength of someone else's
 * session.
 */
export function liveSessionsInProject<S extends ScopedSession>(
  sessions: readonly S[],
  root: string,
): S[] {
  return sessions.filter(
    (session) =>
      isLive(session) &&
      (rootContains(root, session.cwd) ||
        (session.boundWorkflowPath != null &&
          rootContains(root, session.boundWorkflowPath))),
  );
}

/**
 * The live sessions on any of a set of agents: a GROUP's members.
 *
 * A group is a label over agents and has no directory behind it, so it cannot
 * be asked the containment question a project is asked. Membership is the same
 * rule `liveSessionsForFocus` applies to one agent, over several: bound to a
 * member, or unbound and sitting in a member's own folder.
 *
 * `samePath`, not `===`, for the reason that function gives: the server
 * `path.resolve()`s what it stores while the rail holds whatever the registry
 * reported, so a trailing separator or a `C:/…` spelling would hide a session
 * that is plainly running.
 */
export function liveSessionsOnAgents<S extends ScopedSession>(
  sessions: readonly S[],
  agentPaths: readonly string[],
): S[] {
  return sessions.filter((session) => {
    if (!isLive(session)) return false;
    const bound = session.boundWorkflowPath ?? null;
    return bound != null
      ? agentPaths.some((path) => samePath(path, bound))
      : agentPaths.some((path) => samePath(path, session.cwd));
  });
}

/**
 * The mark's words.
 *
 * A bare dot is mute: it is the only thing on the row with no label, and a
 * screen reader reaching it would say nothing at all. The count goes in both
 * the tooltip and the accessible name, so the mark says what it means to
 * everyone who meets it.
 */
export function liveSessionsLabel(count: number): string {
  return count === 1 ? "1 live session" : `${count} live sessions`;
}
