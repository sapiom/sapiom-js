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
 * THE PROJECT SIDE OF THE MARK IS NOT HERE. A project's live sessions are
 * `liveSessionsForProject` (session-scope.ts), the same function the session tab
 * strip renders from, and the mark calls it rather than defining membership a
 * second time. An earlier draft of this module added a binding clause on top of
 * that containment, which would have let one session mark two projects at once
 * after `POST /api/agents/move` moved an agent out from under a running session,
 * while the strip on the second project stayed empty. That is precisely the
 * disagreement `session-scope.ts` says it exists to prevent, and one function
 * answering the question is the only way to keep it prevented.
 *
 * What remains here is the part session-scope has no answer for: a group is a
 * label over agents with no directory behind it, so it cannot be asked the
 * containment question a project is asked.
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
 * A group is a label over agents and has no directory behind it, so it cannot
 * be asked the containment question a project is asked. Membership is the same
 * rule `liveSessionsForFocus` applies to one agent, over several: bound to a
 * member, or unbound and sitting in a member's own folder.
 *
 * A CONSEQUENCE WORTH STATING, because it looks like a bug and is not: a
 * session created at a project root is unbound until the agent it works on is
 * known (`session-manager.ts` binds later), and a project root is nobody's
 * member folder. So a fresh session marks the PROJECT row and no group header
 * under it, and the group headers light as binding arrives. That is the honest
 * reading: until a session is bound, no group can claim it, and picking one
 * would be a guess printed as a fact.
 *
 * THE ASYMMETRY RUNS THE OTHER WAY TOO, and is deliberate. A project row counts
 * by containment alone (`liveSessionsForProject`), while a group counts by
 * binding, so a session bound to an agent under a project but rooted OUTSIDE it
 * lights the group header and leaves the project row dark: a child marked live
 * inside a parent that is not. `POST /api/agents/move` is the way to produce it,
 * by moving an agent out from under a running session.
 *
 * It is left standing rather than fixed, because both halves are already right
 * on their own terms and the alternative is worse. A group is a label over
 * agents with nothing on disk behind it, so binding is the only membership it
 * has; this is the same rule `liveSessionsForFocus` applies to one agent, and
 * that agent's own tab strip lists the very same session. Intersecting the
 * group rule with the project's containment would make a group mean something
 * different from the agent rows inside it, and adding containment to the
 * project rule is the second membership answer SAP-3200's first review round
 * removed. The mark is briefly odd; the rules stay singular.
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
