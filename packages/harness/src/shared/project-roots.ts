/**
 * WHICH FOLDERS ARE PROJECTS — the one definition, for both hosts.
 *
 * This lived in `web/src/lib/project-tree.ts` and answered only the rail. The
 * SERVER had its own answer: `LocalWorkspaceScopeCatalog` was handed
 * `settings.recentDirs` plus every session cwd, and issued a durable Studio
 * project for each. Two definitions, and they disagreed on the commonest shape
 * there is. Launch Studio inside an agent's own folder and rule 1 below
 * promotes the row to the folder that HOLDS the agent, while the server had
 * registered only the agent folder — so the rail's join of row root to scope
 * cwd found nothing, `mapOwnsCreation` went false, and the retired direct
 * creation UI rendered on a real install while the shipped Agent Map did not.
 *
 * So the derivation moved here and the server calls it. There is one answer to
 * "what is a project", the scope catalog is downstream of it, and a durable
 * Studio project exists for exactly the roots the rail draws.
 *
 * Pure over its inputs, no I/O: the server supplies settings/sessions/registry,
 * the SPA supplies the same three off `AppState`, and `pendingCwds` is the
 * SPA's alone (a folder mid-creation exists in no store yet).
 */
import type { SessionStatus } from "./types.js";
import {
  basenameOf,
  isWithinDir,
  parentOf,
  stripTrailingSep,
} from "./paths.js";

/**
 * Row order within a container. "name" is A-Z; "recent" is
 * newest-activity-first. It reaches this module because project ORDER is part
 * of the derivation's output, and the rail renders that order verbatim.
 */
export type RailSort = "recent" | "name";

const isUnder = (childPath: string, root: string): boolean =>
  isWithinDir(root, childPath);

/** Comparison form: forward slashes, no trailing separator. Never rendered and
 *  never POSTed — what the server sent keeps its native spelling. */
const canonical = (p: string): string =>
  stripTrailingSep(p.replace(/\\/g, "/"));

/**
 * Everything a caller knows about which folders are projects.
 *
 * ONE RULE IS NOT ONE ANSWER, and both callers have to hold that in mind. This
 * module guarantees that the server and the rail apply the same derivation; it
 * cannot guarantee they feed it the same facts, and today they do not:
 *
 *  - `closedProjects` is a browser preference (`web/src/lib/ui-prefs.ts`), so
 *    the rail passes only the agents it is showing and post-filters the result,
 *    while the server passes every registered agent and cannot see the setting.
 *    A project the user removed whose agents stay registered is therefore hidden
 *    in the rail and still a root on the server, which mints a durable project
 *    for it — so a session started there binds to a project the user removed.
 *  - `pendingCwds` is browser-only by nature: a folder mid-creation exists in no
 *    store yet.
 *
 * Any input that lives on ONE side is a place the two answers can diverge. If
 * you add one, either give the other side a way to see it or say here why it
 * cannot matter.
 */
export interface ProjectRootSources {
  /** Upstream's workspace list — most-recently-used project directories,
   *  newest first, already deduped and pruned of dead paths at every boot. */
  recentDirs: readonly string[];
  /** Session cwds widen the candidate set for folders `recentDirs` has not yet
   *  recorded, and carry the recency signal for them. `status` separates the
   *  two very different claims a cwd can make: see rule 2. */
  sessions: readonly {
    cwd: string;
    createdAt: string;
    status?: SessionStatus;
  }[];
  /** Folders whose agent is mid-creation: known before any session or agent
   *  exists under them. */
  pendingCwds: readonly string[];
  /**
   * Every registered agent's OWN directory.
   *
   * Required, not optional. The rule below cannot be stated without it, and a
   * caller that forgets it would silently get the old accumulating behaviour
   * back with every test still green.
   */
  agentPaths: readonly string[];
  sort: RailSort;
}

/**
 * THE FOLDER THAT HOLDS AN AGENT, or null when nothing better than the agent's
 * own directory exists.
 *
 * ONE ANSWER, because there are two callers and they must not disagree. The
 * rail's derivation asks it to decide which row to draw; `openProject` asks it
 * to decide what the picker actually opens when you point it at an agent.
 *
 * `projects` must be the list `projectRoots` produces. The guard below is only
 * as good as the definition of "project" it is handed, and a caller that builds
 * its own will decline hops the rail would have made, which restores the silent
 * no-op this exists to remove. `openProject` therefore passes
 * `projectRoots(...)` verbatim rather than assembling anything.
 *
 * Null means REFUSE, and refusing is safe: the agent's own folder stays the
 * root and renders as a project with that agent inside, which is what opening
 * an agent's folder honestly means.
 *
 * Two reasons to refuse:
 *
 *  1. **A filesystem root.** `paths.parentOf` answers `/` (and `C:\`) rather
 *     than null there, deliberately, so that every result stays a listable
 *     path. Taken literally it turns an agent at `/solo` into a project called
 *     `/` holding the entire disk, and the swallow guard below cannot catch it
 *     because at that point there is no other project to swallow yet.
 *  2. **It would contain another project.** Without this, the clean demo
 *     fixture, whose roots are agent folders sitting beside an ordinary project
 *     under one home directory, promoted them all to `/Users/demo` and produced
 *     a single project holding every other project, with every agent inside it
 *     rendered twice. That is the duplicate-agent rendering this rule exists to
 *     remove, re-created by the repair.
 *
 * KNOWN LIMIT, stated rather than papered over: a directory holding nothing but
 * agent folders and no other project DOES become the project. That is right
 * everywhere except a home directory, and a home directory in practice always
 * holds another project, which is what makes the guard fire. A depth floor was
 * considered and rejected, because every threshold that saves `/Users/demo`
 * also breaks a legitimate two-segment root.
 */
/**
 * WHAT OPENING A FOLDER ACTUALLY OPENS.
 *
 * You cannot open a single agent as a project, so pointing the picker at an
 * agent's own folder opens the folder that holds it. Without this the press is
 * a silent no-op: `projectRoots` declines to draw a row for an agent-rooted
 * entry, so the picker says "This is an agent project", the user presses Open,
 * and nothing changes.
 *
 * THE ELIGIBLE PROJECTS ARE `projectRoots`' OWN OUTPUT, not a list assembled
 * here to resemble it. That is the whole design of this function, and it is the
 * only version of it that has held: the guard inside `holdingProjectFor` asks
 * "would this promotion swallow a project", and the answer is only as good as
 * the definition of "project" it is handed. Four separate attempts to
 * reconstruct that definition locally were each wrong in a different way, and
 * every one of them failed in the same direction, by counting something the
 * rail does not keep and so refusing a hop the rail would have made, which puts
 * the silent no-op back.
 *
 * `projectRoots` is the one place that decides what a project is: chosen
 * folders, folders with a live session, and session-only folders that hold an
 * agent no other root already shows, with agent directories excluded and
 * promotions guarded. Calling it costs one derivation on a user gesture and
 * removes the entire class of drift, because there is no second definition left
 * to disagree with.
 */
export function projectToOpen(
  requested: string,
  sources: ProjectRootSources,
): string {
  const isAgentDir = sources.agentPaths.some(
    (path) => canonical(path) === canonical(requested),
  );
  if (!isAgentDir) return requested;
  return (
    holdingProjectFor(requested, {
      agentPaths: sources.agentPaths,
      projects: projectRoots(sources),
    }) ?? requested
  );
}

export function holdingProjectFor(
  agentDir: string,
  {
    agentPaths,
    projects,
  }: { agentPaths: readonly string[]; projects: readonly string[] },
): string | null {
  const agentDirs = new Set(agentPaths.map(canonical));
  let parent = parentOf(agentDir);
  // An agent nested inside another agent walks up until it clears them all.
  while (parent && agentDirs.has(canonical(parent))) parent = parentOf(parent);
  if (parent === null || parentOf(parent) === null) return null;
  const swallowsAProject = projects.some(
    (held) => isUnder(held, parent!) && canonical(held) !== canonical(parent!),
  );
  return swallowsAProject ? null : parent;
}

/**
 * THE ORDERED LIST OF PROJECT ROOTS.
 *
 * One sentence governs this whole function:
 *
 *     A PROJECT IS A DIRECTORY YOU CHOSE THAT HOLDS AGENTS.
 *
 * Two clauses, and dropping either one is what fills a rail with rows nobody
 * chose. On a large workspace the sources below offer roughly five times as many
 * candidate roots as this function returns.
 *
 * RULE 1, "you chose": an agent's OWN directory is not a project. The project
 * is the directory that HOLDS agents; the agent is the thing inside it. A root
 * that is itself a registered agent is a category error, and it is the single
 * cause of both symptoms a real install shows. Its dependency graph has exactly
 * one node, because nothing else is inside it. And it renders the agent TWICE
 * whenever some other open project also contains it, once correctly nested and
 * once again at top level under a different label, because `buildProjectTree`
 * deliberately files an agent under EVERY root that contains it. So an
 * agent-rooted entry whose agent another project already shows is dropped, and
 * one nothing shows is replaced by its nearest non-agent ancestor.
 *
 * This is not a new rule. `project-membership.agentNeedsOwnProject` has
 * enforced it on every NEW registration since the accumulation was diagnosed:
 * "an agent an open project already contains needs nothing remembered". It was
 * simply never applied to the entries already in the list, so the guard stopped
 * the bleeding and left the wound. Applying one rule in one direction only is
 * why SAP-2927 looked complete while the rail still looked broken.
 *
 * RULE 2, "that holds agents": a folder known ONLY because a session ran there
 * earns a row only if it holds an agent no other project already shows, OR a
 * session is LIVE in it. "A session ran here once and exited" and "something is
 * running here right now" are different claims, and collapsing them cost a real
 * case immediately: a bare scaffold session, a live session in a folder with no
 * agent yet, is exactly how you start an agent in an empty folder, and dropping
 * its row makes a running session unreachable from the rail.
 * `recentDirs` is chosen and capped at 8; session cwds are neither, which is
 * why the second list has to earn its rows and the first does not. Two failures
 * collapse into that one clause. A visited folder with no agent is not a
 * project, while an empty project you OPENED keeps its row, because opening a
 * folder in order to build the first agent in it is the whole point of that
 * row. And a visited folder INSIDE a project you already opened is not a second
 * context: `~/polsia` and `~/polsia/services/workers` are two useful views of
 * one agent when you opened both, and the same agent printed twice when the
 * inner row is merely where a session happened to start.
 *
 * NOTHING IS DELETED. Both rules are derivational: `recentDirs` on disk is
 * untouched and any folder is one "Add a project" away from coming back. That
 * is what makes this safe to apply to an install nobody audited, and why it
 * needs no migration, no first-run flow and no undo. The design's original "no
 * migration, every entry becomes a project" rule is kept in spirit and dropped
 * in letter: nothing a user had disappears, but residue of a fixed bug stops
 * being rendered as a choice they made.
 */
export function projectRoots({
  recentDirs,
  sessions,
  pendingCwds,
  agentPaths,
  sort,
}: ProjectRootSources): string[] {
  // Newest activity per directory, for folders `recentDirs` has not heard of.
  const newestByCwd = new Map<string, string>();
  for (const session of sessions) {
    const key = canonical(session.cwd);
    const prev = newestByCwd.get(key);
    if (!prev || session.createdAt > prev)
      newestByCwd.set(key, session.createdAt);
  }

  // First spelling wins: recentDirs and a session cwd can name one directory
  // in two forms (the server `path.resolve`s what it stores, the SPA holds
  // what the user typed), and two rows for one folder is unreadable.
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const dir of [
    ...pendingCwds,
    ...recentDirs,
    ...sessions.map((s) => s.cwd),
  ]) {
    const key = canonical(dir);
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    candidates.push(dir);
  }

  const agentDirs = new Set(agentPaths.map(canonical));
  const isAgentDir = (dir: string): boolean => agentDirs.has(canonical(dir));
  // A folder mid-creation is as deliberate an act as opening one, and its agent
  // does not exist yet, so it can never be an agent directory either. A folder
  // with a LIVE session counts too: you are working in it right now, which is a
  // stronger claim than any list of remembered paths.
  // `status !== "exited"` is the SAME reading `bareSessionAt` uses, so the row
  // the rail keeps and the session it offers cannot disagree. An absent status
  // reads as not live: the only callers that omit it name a folder's recency,
  // and a missing field must never silently keep a row.
  const liveCwds = sessions
    .filter((session) => session.status != null && session.status !== "exited")
    .map((session) => session.cwd);
  const chosen = new Set(
    [...pendingCwds, ...recentDirs, ...liveCwds].map(canonical),
  );
  const wasChosen = (dir: string): boolean => chosen.has(canonical(dir));
  const agentsUnder = (root: string): string[] =>
    agentPaths.filter(
      (path) => isUnder(path, root) && canonical(path) !== canonical(root),
    );

  /** What each surviving root was DERIVED FROM, so a promoted row inherits the
   *  recency of the entry that produced it rather than sorting as an unknown. */
  const from = new Map<string, string>();
  const kept: string[] = [];
  const holds = (root: string): boolean =>
    kept.some((held) => canonical(held) === canonical(root));

  // The folders the user CHOSE, unconditionally and in order. `recentDirs` is a
  // list of deliberate acts; second-guessing it is how a rail starts hiding a
  // project somebody opened on purpose.
  for (const dir of candidates) {
    if (!wasChosen(dir) || isAgentDir(dir)) continue;
    kept.push(dir);
    from.set(canonical(dir), dir);
  }

  /* RULE 2, over the session-only folders, SHALLOWEST FIRST.
     The order is load-bearing, not tidiness. Taken in candidate order an inner
     folder is reached before the outer one that would have explained it, and so
     keeps a row it does not need: a captured install kept
     `harness-e2e/projects/research-micro-site-<hash>` as its own project and
     then added `harness-e2e` above it, printing both of its agents twice.
     Shallowest first means the outermost folder that explains an agent wins and
     every folder below it is measured against a list that already holds it. */
  const sessionOnly = candidates
    .filter((dir) => !wasChosen(dir) && !isAgentDir(dir))
    .sort(
      (a, b) =>
        canonical(a).split("/").length - canonical(b).split("/").length ||
        a.localeCompare(b),
    );
  for (const dir of sessionOnly) {
    const under = agentsUnder(dir);
    if (under.length === 0) continue;
    if (under.every((path) => kept.some((root) => isUnder(path, root))))
      continue;
    kept.push(dir);
    from.set(canonical(dir), dir);
  }

  // RULE 1, over the agent-rooted entries, in candidate order so the result is
  // deterministic. `kept` grows as promotions land, so a later entry can be
  // absorbed by an earlier one's promotion.
  for (const dir of candidates) {
    if (!isAgentDir(dir)) continue;
    if (
      kept.some(
        (root) => isUnder(dir, root) && canonical(root) !== canonical(dir),
      )
    )
      continue;
    const root = holdingProjectFor(dir, { agentPaths, projects: kept }) ?? dir;
    if (holds(root)) continue;
    kept.push(root);
    from.set(canonical(root), dir);
  }

  const pendingRank = new Map(
    pendingCwds.map((cwd, index) => [canonical(cwd), index]),
  );
  const recentRank = new Map(
    recentDirs.map((dir, index) => [canonical(dir), index]),
  );
  /** Rank and recency are asked of the ENTRY a row came from, so a promoted
   *  parent sorts where the agent that produced it sorted. */
  const source = (root: string): string => from.get(canonical(root)) ?? root;

  const byRecency = (a: string, b: string): number => {
    const ia = recentRank.get(canonical(source(a))) ?? -1;
    const ib = recentRank.get(canonical(source(b))) ?? -1;
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0 || ib >= 0) return ia >= 0 ? -1 : 1;
    return (newestByCwd.get(canonical(source(b))) ?? "").localeCompare(
      newestByCwd.get(canonical(source(a))) ?? "",
    );
  };

  return kept.sort((a, b) => {
    // A folder mid-creation outranks everything, on either sort — the user's
    // attention is on it. Among several pending folders, newest first.
    const ra = pendingRank.get(canonical(source(a)));
    const rb = pendingRank.get(canonical(source(b)));
    if (ra !== undefined || rb !== undefined) {
      if (ra !== undefined && rb !== undefined) return ra - rb;
      return ra !== undefined ? -1 : 1;
    }
    if (sort === "name")
      return basenameOf(a).localeCompare(basenameOf(b)) || a.localeCompare(b);
    return byRecency(a, b) || a.localeCompare(b);
  });
}
