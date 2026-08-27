/**
 * `POST /api/agents/move` — the Project axis's drag, performed on disk
 * (SAP-2930; design.md § Drag semantics, criteria 15–17).
 *
 * TWO GUARDS, NOT ONE. The rail asks `web/src/lib/agent-move.ts`'s `planMove`
 * before it dispatches, and that planner produces the reason a row shows. This
 * route is not a second opinion, it is the LAST LINE: in the reference
 * prototype the mover rewrote paths unconditionally, so anything that reached
 * it around the rail — a macro, a test, a future keyboard move — got no check
 * at all and clobbered silently. A planner is not a permission system, so this
 * route STATS the destination itself and refuses on its own findings. The
 * co-located test calls it directly, planner bypassed, to prove that.
 *
 * The planner also cannot see what a path list cannot see: a collision with a
 * plain directory that holds no agent. Only a real `stat` answers that, and it
 * happens here.
 *
 * `git mv` WHEN THE DIRECTORY IS TRACKED, plain rename otherwise (the settled
 * decision on SAP-2930). A tracked move that goes through `rename` reaches git
 * as a delete plus a pile of untracked files, which is a worse diff and a
 * worse `git status` than the rename git can record itself. Nothing inside
 * `sapiom.json` is rewritten: nothing in it names the agent's own directory,
 * so a rewrite would be a second, silent edit the user did not ask for — and
 * the registry re-derives the agent from its new path anyway.
 *
 * Authority: NEITHER SIDE OF THE MOVE IS A STRING FROM THE REQUEST. `from` is
 * matched against the live registry (`resolveAgent`, injected — the same cache
 * `actions.ts` and the canvas route resolve through) and the move runs on
 * `agent.path`, which the registry wrote when it scanned the disk. `to` is
 * matched against `listMoveTargetDirs` — every project root the studio knows
 * plus every branching directory the Project axis draws between a root and an
 * agent — and the move runs on `<that directory>/<the registry's basename>`.
 *
 * That is the same shape `server/studio-rail.ts` uses for its writable roots,
 * and it is deliberately stronger than validating the client's path: a
 * destination the rail cannot show is a destination this route will not `mv`
 * to, so the endpoint cannot be turned into an arbitrary-path `mv` even by a
 * caller that never opened the rail. It also means no request string reaches
 * `fs`, which is a barrier a static analyzer can see and a reordered `if`
 * cannot undo. The lexical guards (absolute-only, no `..` segment) stay as
 * defence in depth.
 *
 * Mounted under the same `/api` boot-token middleware as the rest of the REST
 * surface (server/index.ts).
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Router, type Router as ExpressRouter } from "express";

import { hasTraversalSegment } from "../core/path-safety.js";

/** What actually performed the move — reported back so a caller (and the test)
 *  can see which branch ran. */
export type MoveKind = "git" | "rename";

export interface AgentMoveResponse {
  ok: true;
  /** False for the silent no-op: `to` resolved to `from`, nothing happened. */
  moved: boolean;
  from: string;
  to: string;
  kind: MoveKind | null;
}

export interface AgentMoveDeps {
  /**
   * The registered agent at this absolute path, or null. Only a registered
   * agent may be moved: the rail can only drag rows it renders, and the rows
   * it renders come from this same cache.
   */
  resolveAgent: (agentPath: string) => { name: string; path: string } | null;
  /**
   * Every directory an agent may be dropped INTO: the project roots the studio
   * knows about, plus the branching directories the Project axis renders
   * between a root and an agent. `moveTargetDirs` below derives exactly that
   * set from the two things the server already holds, so "a directory the rail
   * can show" and "a directory this route will move into" are one list.
   */
  listMoveTargetDirs: () => string[] | Promise<string[]>;
  /**
   * Applied AFTER a successful move, before the response. The integrator's job:
   * remap live session cwds that sat inside the moved tree, prune the registry
   * of the path that no longer exists, rescan the destination, and broadcast
   * `workflows.changed` so the rail re-derives the tree from the new path.
   */
  onMoved: (from: string, to: string) => Promise<void>;
}

/** Whether `child` IS `parent` or sits beneath it, on segment boundaries — so
 *  `…/ads-v2` is never read as a child of `…/ads`. Node-side twin of the
 *  browser's `paths.isWithinDir`; `path.relative` does the normalizing. */
export function isWithinDir(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Two paths naming one directory. Trailing separators and (on Windows) case are
 * spelling, not identity — the same rule `server/studio-rail.ts` applies to its
 * roots, and for the same reason: the client stores whichever form the user
 * typed while the server stores whatever it resolved.
 */
function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const resolved = path.resolve(p);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return norm(a) === norm(b);
}

/**
 * Every directory the Project axis can offer as a drop target, derived from the
 * only two things the server holds: the roots the studio knows about and the
 * agents the registry has found.
 *
 * This mirrors `web/src/lib/project-tree.ts` exactly, because it has to. That
 * module tries each root, keeps the agents beneath it, and renders the path
 * segments between them as directory rows; a row that exists there is a row a
 * drag can land on, and nothing else is. So: each root, plus each directory
 * between a root and an agent inside it.
 *
 * KNOWN GAP, deliberately: the rail also shows `pendingCwds` — a folder chosen
 * for an agent that is still being created — and the server has no such list.
 * Dropping into a project that exists only mid-creation is refused with the
 * "directory the studio doesn't show" message until the folder lands in
 * `recentDirs`, which is the next thing that happens to it. Refusing a rare
 * drop is the right side to fail on for a route that renames user code.
 */
export function moveTargetDirs(
  roots: readonly string[],
  agentPaths: readonly string[],
): string[] {
  const resolvedRoots = roots
    .filter((root) => typeof root === "string" && root.trim() !== "")
    .map((root) => path.resolve(root));
  const dirs = new Set<string>(resolvedRoots);

  for (const raw of agentPaths) {
    if (typeof raw !== "string" || raw.trim() === "") continue;
    const agent = path.resolve(raw);
    for (const root of resolvedRoots) {
      if (!isWithinDir(root, agent)) continue;
      // Every segment between the root and the agent's own folder. The agent's
      // folder itself is NOT a target: an agent row is not a drop target, and
      // `mv a a/b` is the one move that destroys the thing being moved.
      let dir = path.dirname(agent);
      while (isWithinDir(root, dir)) {
        dirs.add(dir);
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
  }
  return [...dirs];
}

/**
 * The path `p` becomes once `from` has moved to `to` — unchanged when `p` is
 * not inside `from`.
 *
 * Everything under the moved directory travels with it, so a nested agent and a
 * SESSION whose cwd sat inside the tree are remapped by the same rule. Without
 * this a session keeps pointing at a directory that no longer exists.
 */
export function remapUnder(p: string, from: string, to: string): string {
  if (!isWithinDir(from, p)) return p;
  const rel = path.relative(path.resolve(from), path.resolve(p));
  return rel === "" ? path.resolve(to) : path.join(path.resolve(to), rel);
}

/**
 * Rewrites every live session that sat inside the moved tree, IN PLACE, and
 * returns how many changed.
 *
 * A function rather than a loop at the wiring site because this is the criterion
 * "sessions whose cwd sat inside the moved directory follow it", and a rule that
 * lives inside a route's callback cannot be tested. On disk the session's own
 * process cwd follows the directory automatically (a cwd is an inode, not a
 * string), so what has to be corrected is the RECORD — the path the studio shows,
 * files under, and reboots the session at. Left stale, the session's project row
 * points at a directory that no longer exists.
 *
 * `boundWorkflowPath` travels the same way: the binding names the agent's
 * directory, and the agent just moved.
 *
 * In place, because the session manager owns these objects and hands out live
 * references — `setBoundWorkflowPath` mutates them the same way.
 */
export function remapSessions(
  sessions: Array<{ cwd: string; boundWorkflowPath?: string | null }>,
  from: string,
  to: string,
): number {
  let changed = 0;
  for (const session of sessions) {
    const cwd = remapUnder(session.cwd, from, to);
    const bound =
      session.boundWorkflowPath == null
        ? session.boundWorkflowPath
        : remapUnder(session.boundWorkflowPath, from, to);
    if (cwd === session.cwd && bound === session.boundWorkflowPath) continue;
    session.cwd = cwd;
    session.boundWorkflowPath = bound;
    changed += 1;
  }
  return changed;
}

/** `git`, with a bounded timeout — a hung git must not hold a request open. */
function git(args: string[]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { timeout: 10_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve({ ok: err == null, stdout: stdout.toString() }),
    );
  });
}

/**
 * Whether git TRACKS anything inside `dir`.
 *
 * `ls-files` rather than `rev-parse --is-inside-work-tree`: a directory can sit
 * inside a repo and be entirely gitignored (a scratch agent under a checkout's
 * `tmp/`), and `git mv` refuses those. "Inside a repo" is the wrong question;
 * "does git know about these files" is the one that predicts whether `git mv`
 * can do the job. No repo at all, or git not installed, reads as untracked.
 */
export async function isGitTracked(dir: string): Promise<boolean> {
  const res = await git(["-C", dir, "ls-files", "--", "."]);
  return res.ok && res.stdout.trim() !== "";
}

/**
 * Moves the directory, preferring the tracked path.
 *
 * A `git mv` failure falls THROUGH to the plain rename rather than failing the
 * request: the commonest reason is a destination outside this work tree (moving
 * an agent out of a checkout is a legitimate move), and the untracked branch
 * would have done exactly this anyway. What must never happen is a move that
 * half-succeeds, and neither branch can do that — both are single operations.
 */
export async function performMove(from: string, to: string): Promise<MoveKind> {
  if (await isGitTracked(from)) {
    const res = await git(["-C", from, "mv", "--", from, to]);
    if (res.ok) return "git";
  }
  await fs.rename(from, to);
  return "rename";
}

/**
 * The route's OWN refusal, from the filesystem rather than from a path list —
 * a message when the move must not happen, null when it may.
 *
 * Ordered so the most specific truth wins: a destination inside the source is
 * the move that destroys the thing being moved (`mv a a/b` relocates the
 * destination along with the source and leaves nothing behind), and it is worth
 * saying so rather than reporting whatever `stat` happens to find there.
 */
export async function refuseMoveOnDisk(from: string, to: string): Promise<string | null> {
  const name = path.basename(to);
  if (isWithinDir(from, to)) return `Can't move ${path.basename(from)} inside itself.`;

  let sourceStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    sourceStat = await fs.lstat(from);
  } catch {
    return `${from} no longer exists.`;
  }
  if (!sourceStat.isDirectory()) return `${from} is not a directory.`;

  // THE INDEPENDENT GUARD. `lstat`, not `stat`: a dangling symlink at the
  // destination is still something `rename` would replace, and something the
  // user put there.
  try {
    await fs.lstat(to);
    return `${to} already exists. Moving ${name} there would overwrite it.`;
  } catch {
    // Absent — which is the only acceptable state for a destination.
  }

  const parent = path.dirname(to);
  try {
    const parentStat = await fs.stat(parent);
    if (!parentStat.isDirectory()) return `${parent} is not a directory.`;
  } catch {
    return `${parent} does not exist.`;
  }
  return null;
}

/**
 * POST /api/agents/move  { from, to } -> AgentMoveResponse
 *
 * 400 — a malformed or unregistered `from`, or a `to` that asks for a rename.
 * 409 — a refusal, with the reason in `error` so the rail can show it verbatim:
 * a destination inside the source, a destination the studio doesn't show, or
 * anything `stat` finds already sitting there. 200 with `moved: false` — `to`
 * resolved to `from`: the user let go somewhere harmless, and the SILENT no-op
 * is a success, not a complaint.
 */
export function createAgentMoveRouter(deps: AgentMoveDeps): ExpressRouter {
  const router = Router();

  router.post("/api/agents/move", async (req, res, next) => {
    const body = (req.body ?? {}) as { from?: unknown; to?: unknown };
    const { from, to } = body;
    if (typeof from !== "string" || typeof to !== "string") {
      res.status(400).json({ error: "from and to must be absolute paths" });
      return;
    }
    if (
      !path.isAbsolute(from) ||
      !path.isAbsolute(to) ||
      hasTraversalSegment(from) ||
      hasTraversalSegment(to)
    ) {
      res.status(400).json({ error: "from and to must be absolute paths" });
      return;
    }
    const requestedTarget = path.resolve(to);
    // The `from` lookup, and the last use of that string: everything below
    // moves `agent.path`, which the registry wrote when it scanned the disk.
    const agent = deps.resolveAgent(path.resolve(from));
    if (agent == null) {
      res.status(400).json({ error: "from must be a registered agent" });
      return;
    }
    const source = path.resolve(agent.path);
    const name = path.basename(source);

    if (samePath(source, requestedTarget)) {
      res.json({
        ok: true,
        moved: false,
        from: source,
        to: source,
        kind: null,
      } satisfies AgentMoveResponse);
      return;
    }
    // Answered here, ahead of the destination lookup, because it is the most
    // specific truth about the gesture and no `stat` can improve on it: `mv a
    // a/b` relocates the destination along with the source and leaves nothing
    // behind. Pure path arithmetic — nothing reaches the filesystem yet.
    if (isWithinDir(source, requestedTarget)) {
      res.status(409).json({ error: `Can't move ${name} inside itself.` });
      return;
    }

    try {
      // THE DESTINATION BARRIER. The requested parent is matched against the
      // directories the rail can show, and the DIRECTORY FROM THAT LIST is what
      // the move uses — the request's spelling is discarded with the rest of
      // the string. A destination the studio has never been pointed at is a
      // destination this route will not rename user code into.
      const requestedParent = path.dirname(requestedTarget);
      const targetDir = (await deps.listMoveTargetDirs()).find(
        (dir) => typeof dir === "string" && dir.trim() !== "" && samePath(dir, requestedParent),
      );
      if (targetDir == null) {
        res.status(409).json({
          error: `Can't move ${name} into ${requestedParent} — Studio doesn't show that folder as a project.`,
        });
        return;
      }
      // A move keeps the agent's own folder name; `planMove` builds `to` that
      // way and nothing else may ask for a different one. Refusing here rather
      // than silently moving to `<targetDir>/<name>` keeps the endpoint honest
      // about the one thing it does.
      if (path.basename(requestedTarget) !== name) {
        res.status(400).json({ error: "a move may not rename the agent's directory" });
        return;
      }
      // `path.resolve` on the LIST's entry, not the request's: an injected
      // list may spell a directory however its source stored it.
      const target = path.join(path.resolve(targetDir), name);

      const refusal = await refuseMoveOnDisk(source, target);
      if (refusal != null) {
        res.status(409).json({ error: refusal });
        return;
      }
      const kind = await performMove(source, target);
      await deps.onMoved(source, target);
      res.json({
        ok: true,
        moved: true,
        from: source,
        to: target,
        kind,
      } satisfies AgentMoveResponse);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
