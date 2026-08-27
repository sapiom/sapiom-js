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
 * Authority: `from` must be a REGISTERED agent (`resolveAgent`, injected — the
 * same live registry cache `actions.ts` and the canvas route resolve through),
 * so this route cannot be turned into an arbitrary-path `mv`. Mounted under
 * the same `/api` boot-token middleware as the rest of the REST surface
 * (server/index.ts).
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
 * 400 — a malformed or unregistered `from`. 409 — a refusal, with the reason in
 * `error` so the rail can show it verbatim. 200 with `moved: false` — `to`
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
    const source = path.resolve(from);
    const target = path.resolve(to);
    if (deps.resolveAgent(source) == null) {
      res.status(400).json({ error: "from must be a registered agent" });
      return;
    }
    if (source === target) {
      res.json({
        ok: true,
        moved: false,
        from: source,
        to: target,
        kind: null,
      } satisfies AgentMoveResponse);
      return;
    }
    try {
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
