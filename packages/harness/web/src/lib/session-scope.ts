/**
 * Session scope: where a new session is ROOTED.
 *
 * One rule lives here, and it was a bug before it was a rule: a session boots
 * at its PROJECT ROOT, never at the agent's own folder. Rooting in an agent
 * subdirectory is why Claude Code came up without the project's `CLAUDE.md`,
 * `.claude/` or skills — the whole benefit of an embedded agent, lost to a
 * path (SAP-2927; design.md § Sessions, focus, canvas, verbs, criterion 18).
 *
 * Pure and free of React and of fixtures on purpose: a test pins the rule with
 * two string arguments, so the rule cannot quietly start depending on shell
 * state, the mock data, or the API client. Every session-creation entry point
 * in `App.tsx` resolves through `projectRootForAgent` — the original defect
 * was one path that didn't.
 */
import { isWithinDir, stripTrailingSep } from "./paths";

/**
 * True when `root` contains `agentPath`, matched on SEGMENT boundaries.
 *
 * There is exactly ONE containment answer in this app and it is
 * `paths.isWithinDir`, which already normalizes separators (the server hands
 * us native paths, Windows included) and already refuses a bare string prefix
 * — without that, `~/polsia-old` reads as a child of `~/polsia` and the studio
 * boots a session in a project the agent has nothing to do with. This wrapper
 * exists for the one thing the generic helper cannot decide: an EMPTY root is
 * not a root. It prefixes every path, so left alone it would swallow every
 * agent and win the longest-root sort's tie for last place.
 *
 * Equality counts as containment: a project root that IS the agent is one row
 * and one context.
 */
export function rootContains(root: string, agentPath: string): boolean {
  if (root.trim() === "") return false;
  return isWithinDir(root, agentPath);
}

/**
 * The project root that owns an agent: the LONGEST known root containing it.
 *
 * Longest, not first: `recentDirs` is ordered by recency, which says nothing
 * about depth. With both `~/polsia` and `~/polsia/backend/src/agents/ads`
 * opened, the nearer one is the context the user chose for this agent, and the
 * answer must not depend on which they opened last.
 *
 * With no known root containing it we fall back to the agent's own folder —
 * the old behaviour, returned verbatim — so an agent discovered outside every
 * opened project still starts a session rather than failing to start.
 */
export function projectRootForAgent(agentPath: string, roots: readonly string[]): string {
  return (
    roots
      .filter((root) => rootContains(root, agentPath))
      // A root recorded as `~/polsia/` is the same place as `~/polsia`, and the
      // trailing slash must not buy it a character in the sort below.
      .map(stripTrailingSep)
      .sort((a, b) => b.length - a.length)[0] ?? agentPath
  );
}
