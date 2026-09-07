/**
 * Whether a GROUP is live: one of its member agents has a running session
 * (SAP-3200, design-eng DECISIONS D37).
 *
 * The rail lists no sessions, and this does not change that. A header's mark is
 * a DERIVED fact about the agents under it, the same kind of fact the deploy
 * glyph is about one agent, so that "is anything running in here" can be
 * answered at a glance without the rail growing session rows it deliberately
 * does not have.
 *
 * WorkflowsRail first selects the project's live sessions with
 * `liveSessionsForStudioProject`, the same project-ID rule the session tabs
 * use. Only legacy rows without a Studio project use `liveSessionsForProject`.
 * Group membership narrows that list by agent; a shared path cannot make a
 * session light groups in another durable project.
 *
 * Pure, and free of React and of fixtures, for the reason `session-scope.ts`
 * gives: a rule you can call with two arguments is a rule a test can pin.
 */
import { samePath } from "./paths";
import type { ScopedSession } from "./session-scope";

/** Live is anything that has not exited: a session still starting is about to
 *  be running, and a mark that waits for the transition would blink off during
 *  exactly the moment the user just asked about. */
const isLive = (session: ScopedSession): boolean => session.status !== "exited";

/**
 * The live sessions on any of a set of agents: a GROUP's members.
 *
 * The caller supplies sessions already scoped to the owning project. Within
 * that project, membership uses the rule `liveSessionsForFocus` applies to one
 * agent, over several: bound to a member, or unbound and sitting in a member's
 * own folder.
 *
 * A CONSEQUENCE WORTH STATING, because it looks like a bug and is not: a
 * session created at a project root is unbound until the agent it works on is
 * known (`session-manager.ts` binds later), and a project root is nobody's
 * member folder. So a fresh session marks the PROJECT row and no group header
 * under it, and the group headers light as binding arrives. That is the honest
 * reading: until a session is bound, no group can claim it, and picking one
 * would be a guess printed as a fact.
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
