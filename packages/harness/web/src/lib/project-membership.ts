/**
 * Which folders are projects — and how one stops being one.
 *
 * Two mechanisms filled a real install's rail with 40 rows for 75 agents, and
 * this module owns both halves of the answer (SAP-2932; design.md § Problem,
 * § Removing a project).
 *
 *  1. **Registering an agent used to mint a project for the agent's own
 *     folder.** "Opening a folder IS opening a workspace" is true of a folder
 *     you CHOSE and false of the directory an agent happens to live in, so a
 *     build inside `acme-app` left you with `acme-app` AND
 *     `acme-app/sales-outreach`. That pattern was 24 of one install's 40 rows.
 *     `agentNeedsOwnProject` is the gate: an agent an open project already
 *     contains needs nothing remembered, because it is already visible where
 *     it belongs.
 *  2. **Nothing ever left the list.** `recentDirs` is capped at 8 but session
 *     cwds are not, so an install carries far more projects than the cap
 *     suggests. The answer is a normal affordance — remove — not a migration
 *     or a purge: nothing a user already had disappears on upgrade, and
 *     everything they no longer want has one obvious way out.
 *
 * Pure and React-free on purpose: the containment decision in (1) is the CAUSE
 * of the accumulation, and a rule that decides it from two string arguments is
 * a rule a test can pin without a browser, a fixture, or an API client.
 */
import type { HarnessSession } from "@shared/types";

import { samePath } from "./paths";
import { rootContains } from "./session-scope";

/**
 * Does this agent need a project of its own?
 *
 * THE CAUSE OF THE ACCUMULATION, as one decision. `connectWorkflow` calls
 * this before it remembers anything: false means an open project already
 * contains the agent and the rail will file it there, so remembering its
 * folder would only add a second row for a place already on screen.
 *
 * True is not a failure — an agent that lands outside every open project
 * earns a root, and its own folder is the honest answer, because the
 * alternative is an agent that exists and nothing shows.
 *
 * `openRoots` is every folder the rail can already show a project for:
 * `recentDirs` AND the session cwds, which is wider than it looks —
 * `recentDirs` is capped at 8 and session cwds are not, so a project can
 * outlive its entry in the list.
 *
 * Containment is `rootContains`, the app's ONE answer (session-scope.ts →
 * paths.isWithinDir). Nothing here re-implements it: three disagreeing copies
 * of that comparison once filed an agent under one project while its session
 * booted in another.
 */
export function agentNeedsOwnProject(
  agentPath: string,
  openRoots: readonly string[],
): boolean {
  return !openRoots.some((root) => rootContains(root, agentPath));
}

/**
 * Is `path` inside a project the user removed?
 *
 * A closed project closes its whole SUBTREE — itself, its directories, its
 * agents, and the sessions that ran in it. Anything less is not a removal: a
 * project whose agents stay behind as strays, or whose session cwds come back
 * as child rows, has been renamed rather than removed.
 *
 * The one exception is a project the user opened SEPARATELY inside it —
 * `~/polsia` and `~/polsia/services/workers` are two real contexts, and
 * closing the outer one must not take the inner one with it. Hence STRICTLY
 * inside: an `openRoots` entry equal to the closed root is the very entry
 * removal is about to drop (and, on the next boot, whatever re-recorded it),
 * so it cannot be what un-closes it. Only a deliberate reopen does that.
 *
 * `openRoots` is the explicitly-opened list — `recentDirs` plus folders
 * mid-creation. Session cwds are deliberately NOT claims here: a session that
 * ran somewhere under a removed project is exactly the residue removal exists
 * to clear.
 */
export function hiddenByClosedProject(
  path: string,
  closedRoots: readonly string[],
  openRoots: readonly string[],
): boolean {
  const closing = closedRoots.filter((root) => rootContains(root, path));
  if (closing.length === 0) return false;
  return !openRoots.some(
    (open) =>
      rootContains(open, path) &&
      closing.some((root) => rootContains(root, open) && !samePath(root, open)),
  );
}

/** What one removal will do, decided before anything is asked of the server. */
export interface ProjectRemovalPlan {
  /** The project being removed, exactly as the rail spells it. */
  root: string;
  /** `recentDirs` with this project gone. Entries NESTED inside it stay: they
   *  are projects the user opened separately and this removal is not about
   *  them. */
  nextRecentDirs: string[];
  /** The LIVE sessions this removal ends — the count the confirm names. */
  endSessionIds: string[];
}

/**
 * The sessions a removal ends, and the list it leaves behind.
 *
 * Ownership is decided by the same predicate that hides the rows
 * (`hiddenByClosedProject`), so the confirm can never promise to end a session
 * that the rail then keeps showing under a nested project — one rule, two
 * readers.
 */
export function planProjectRemoval({
  root,
  recentDirs,
  sessions,
}: {
  root: string;
  recentDirs: readonly string[];
  sessions: readonly Pick<HarnessSession, "id" | "cwd" | "status">[];
}): ProjectRemovalPlan {
  const closing = [root];
  return {
    root,
    nextRecentDirs: recentDirs.filter((dir) => !samePath(dir, root)),
    endSessionIds: sessions
      .filter(
        (session) =>
          session.status !== "exited" &&
          hiddenByClosedProject(session.cwd, closing, recentDirs),
      )
      .map((session) => session.id),
  };
}

/**
 * The confirm's first line, and the reason the confirm earns its place.
 *
 * Ending live sessions is destructive, so it is confirmed — but an abstract
 * warning ("this may affect running sessions") teaches nothing and gets
 * clicked through. The COUNT is the whole point: "Ends 3 running sessions" is
 * a fact about this folder, right now, and it is what makes the dialog worth
 * reading.
 */
export function describeProjectRemoval(runningCount: number): string {
  if (runningCount === 0) return "No running sessions to end.";
  if (runningCount === 1) return "Ends 1 running session.";
  return `Ends ${runningCount} running sessions.`;
}

/**
 * Everything a removal asks of the world. TWO calls, both of them lists:
 * end these sessions, then store this directory list.
 *
 * Named as a port so the set is auditable — "remove" must never read as
 * "delete my code", and the guarantee behind that copy is that no step of a
 * removal writes, moves or deletes a file. A `project-membership.test.ts` case
 * snapshots a real directory around this function to hold that.
 */
export interface ProjectRemovalPort {
  endSession(id: string): Promise<void>;
  saveRecentDirs(recentDirs: readonly string[]): Promise<void>;
}

/** Sessions that refused to end. The removal still happened — the user asked
 *  for it — so this is reported, not thrown. */
export interface ProjectRemovalOutcome {
  endedCount: number;
  failedSessionIds: string[];
}

/**
 * Runs the plan.
 *
 * Sessions FIRST, then the list: a folder stops being a live context before it
 * stops being a name, so a kill that fails can still be reported against a
 * project the user can still see. The reverse order loses the report.
 *
 * A failed kill does not abort the removal. The user asked for the folder to
 * go; leaving it in the rail because one PTY would not die would be answering
 * a different question.
 */
export async function applyProjectRemoval(
  plan: ProjectRemovalPlan,
  port: ProjectRemovalPort,
): Promise<ProjectRemovalOutcome> {
  const results = await Promise.allSettled(
    plan.endSessionIds.map((id) => port.endSession(id)),
  );
  const failedSessionIds = plan.endSessionIds.filter(
    (_, index) => results[index]?.status === "rejected",
  );
  await port.saveRecentDirs(plan.nextRecentDirs);
  return {
    endedCount: plan.endSessionIds.length - failedSessionIds.length,
    failedSessionIds,
  };
}

/**
 * Dropping tombstones: how a project comes BACK.
 *
 * `reopened` is matched EXACTLY. Starting a session in `~/acme-app/sub` after
 * closing `~/acme-app` opens the subfolder — which the nested-project rule in
 * `hiddenByClosedProject` already shows — and says nothing about the parent
 * the user closed on purpose.
 */
export function reopenedClosedProjects(
  closedRoots: readonly string[],
  reopened: readonly string[],
): string[] {
  return closedRoots.filter(
    (root) => !reopened.some((opened) => samePath(root, opened)),
  );
}

/**
 * The closed projects that would hide `path`.
 *
 * Used for one case, and it is the case that matters: an agent REGISTERED
 * inside a project the user had removed. Filing it there would leave an agent
 * that exists and nothing shows, and giving it a root of its own would mint
 * exactly the row this ticket exists to stop (`acme-app/leasing` under a
 * hidden `acme-app`). Registering an agent is an act of interest in the folder
 * that holds it, so the honest answer is to reopen that folder.
 */
export function closedProjectsHolding(
  closedRoots: readonly string[],
  path: string,
): string[] {
  return closedRoots.filter((root) => rootContains(root, path));
}
