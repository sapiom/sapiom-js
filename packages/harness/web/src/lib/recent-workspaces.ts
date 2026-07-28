/**
 * What the Overview panel means by "Recent workspaces".
 *
 * It used to mean `settings.recentDirs`, which is not workspaces at all:
 * `recordRecentDir()` is called once per boot with the LAUNCH directory, so a
 * developer who always launches the harness from the same folder had exactly
 * one entry forever — under a heading that promised their workspaces, while the
 * rail listed dozens. The label was making a claim the data could not support.
 *
 * A workspace here is a DIRECTORY WORK HAS HAPPENED IN, drawn from the two
 * sources that actually record that:
 *
 *   1. the session registry (`sessions.json`) — every directory any session ran
 *      in, live or exited, each carrying a real `lastActiveAt`. This is the
 *      source that makes the list grow with use, and the reason a returning
 *      user now sees their actual working set;
 *   2. `settings.recentDirs` — still meaningful, but demoted to what it is: a
 *      launch dir is a folder you opened even if nothing ran there yet, so it
 *      belongs in the list, just below anything with genuine session activity.
 *
 * Workflows are deliberately NOT rows. A `sapiom.json` project is an *agent*,
 * which is the rail's unit; folding 56 agents into a list headed "workspaces"
 * would repeat the same label-vs-data mismatch in the other direction. They are
 * counted per row instead (`agentCount`), which is what makes a row worth
 * reading, and totalled by the caller for the "…in the rail" note.
 *
 * Pure and framework-free (vitest tier — see vitest.config.ts): ordering is the
 * part with the bugs in it, and it deserves tests that don't need a browser.
 */

import type { HarnessSession, WorkflowInfo } from "@shared/types";

export interface RecentWorkspace {
  /** Absolute path; a session opens here when the row is clicked. */
  cwd: string;
  /** Folder name — what the rail shows and what a human recognizes. */
  label: string;
  /**
   * Newest session activity in this folder, or null when the folder is known
   * only as a launch dir (in `recentDirs`, never hosted a session). Null is
   * rendered as no timestamp rather than a fabricated one.
   */
  lastActiveAt: string | null;
  /** Agent projects (`sapiom.json`) at or under this folder. */
  agentCount: number;
}

const basename = (path: string): string => path.split("/").filter(Boolean).pop() ?? path;

/** Same containment rule the rail's tree uses: a path is under a folder if it
 *  IS that folder or sits beneath it — never a mere string prefix, so
 *  `/a/scratch-2` is not counted under `/a/scratch`. */
const isUnder = (childPath: string, cwd: string): boolean =>
  childPath === cwd || childPath.startsWith(`${cwd}/`);

/**
 * The Overview list, newest-activity first.
 *
 * Order: folders with session activity (newest `lastActiveAt` wins), then
 * launch-dir-only folders in the order `recentDirs` already holds them (that
 * list is maintained newest-first by `recordRecentDir`). Ties break on path so
 * the list never reshuffles between renders.
 *
 * Returns every known workspace; the caller decides how many to show. Callers
 * that truncate should surface the remainder rather than drop it silently.
 */
export function recentWorkspaces(
  sessions: HarnessSession[],
  recentDirs: string[],
  workflows: WorkflowInfo[],
): RecentWorkspace[] {
  // One entry per directory: a folder with six sessions is still one workspace,
  // stamped with the freshest of them.
  const newestByCwd = new Map<string, string>();
  for (const session of sessions) {
    const previous = newestByCwd.get(session.cwd);
    if (!previous || session.lastActiveAt > previous) {
      newestByCwd.set(session.cwd, session.lastActiveAt);
    }
  }

  const agentCountFor = (cwd: string): number =>
    workflows.filter((workflow) => isUnder(workflow.path, cwd)).length;

  const fromSessions: RecentWorkspace[] = Array.from(newestByCwd.entries())
    .sort(([aCwd, aAt], [bCwd, bAt]) => bAt.localeCompare(aAt) || aCwd.localeCompare(bCwd))
    .map(([cwd, lastActiveAt]) => ({
      cwd,
      label: basename(cwd),
      lastActiveAt,
      agentCount: agentCountFor(cwd),
    }));

  const seen = new Set(newestByCwd.keys());
  const fromLaunchDirs: RecentWorkspace[] = [];
  for (const dir of recentDirs) {
    if (seen.has(dir)) continue; // already carrying a real timestamp
    seen.add(dir); // recentDirs is sanitized server-side, but never trust it to be deduped here
    fromLaunchDirs.push({
      cwd: dir,
      label: basename(dir),
      lastActiveAt: null,
      agentCount: agentCountFor(dir),
    });
  }

  return [...fromSessions, ...fromLaunchDirs];
}

/**
 * How many known agent projects the visible rows do NOT account for — the
 * number behind Overview's "…the rail lists them all" note.
 *
 * Nested workspaces can count one agent twice (a launch dir listed alongside a
 * project inside it), which only ever makes this result smaller. That bias is
 * deliberate and the right way round: the note then appears only when we are
 * certain something is missing, never speculatively.
 */
export function unlistedAgentCount(
  workflows: WorkflowInfo[],
  shown: readonly RecentWorkspace[],
): number {
  const accounted = shown.reduce((total, workspace) => total + workspace.agentCount, 0);
  return Math.max(0, workflows.length - accounted);
}
