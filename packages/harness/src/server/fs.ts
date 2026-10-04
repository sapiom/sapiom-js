/**
 * Filesystem routes for the SPA:
 *  - `GET /api/fs/list?path=<abs-or-~>` → directories only, one level deep,
 *    for the path-picker autocomplete;
 *  - `POST /api/fs/reveal {path}` → show a registered agent's folder in the
 *    OS file manager. The browser fallback for the desktop app's `revealPath`
 *    bridge (`harness-desktop/src/main/dialogs.ts`).
 *
 * A self-contained express Router — the integrator mounts it (behind the boot
 * token, like the rest of /api) and hands in the registry lookup the reveal
 * route needs.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { json, Router, type Router as ExpressRouter } from "express";
import { type FsDirEntry, type FsListResponse } from "../shared/types.js";
import {
  isAgentProjectScanIgnoredDir,
  readAgentProjectMarker,
} from "../core/agent-project-discovery.js";
import { hasTraversalSegment } from "../core/path-safety.js";

export type { FsDirEntry, FsListResponse } from "../shared/types.js";

const MAX_RESULTS = 200;

function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

/** The OS command that shows `target` in the file manager, as argv (no shell). */
export interface RevealCommand {
  command: string;
  args: string[];
  /** Windows only: pass `args` through unquoted (see `revealCommand`). */
  windowsVerbatimArguments?: boolean;
}

/**
 * macOS and Windows select the folder inside its parent; Linux has no portable
 * "select" verb, so `xdg-open` opens the folder itself (the card labels it
 * "Open folder" there).
 */
export function revealCommand(target: string, platform: NodeJS.Platform): RevealCommand {
  if (platform === "darwin") return { command: "open", args: ["-R", target] };
  if (platform === "win32") {
    // Explorer parses `/select,` itself and does not accept Node's default
    // quoting of the whole argument ("/select,C:\a b"); it needs the path quoted
    // after the comma, so the argument is passed verbatim.
    return {
      command: "explorer.exe",
      args: [`/select,"${target}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { command: "xdg-open", args: [target] };
}

function spawnReveal(cmd: RevealCommand): void {
  const child = spawn(cmd.command, cmd.args, {
    detached: true,
    stdio: "ignore",
    windowsVerbatimArguments: cmd.windowsVerbatimArguments,
  });
  // A missing binary (no xdg-open on a headless box) arrives as an async
  // 'error' event; without a listener it would crash the server. The request
  // has already been answered, so the log is the only place it can surface.
  child.on("error", (err) => {
    console.error(`[harness] reveal failed (${cmd.command}): ${err.message}`);
  });
  child.unref();
}

export interface FsRouterDeps {
  /**
   * True when `resolvedPath` is the folder of an agent in the workflow
   * registry. The reveal route acts only on these: it runs an OS command on a
   * path from the request body, so it must not take arbitrary paths. Absent,
   * every reveal is refused (403).
   */
  isAgentPath?: (resolvedPath: string) => boolean | Promise<boolean>;
  /** Injectable for tests; defaults to spawning the platform command detached. */
  reveal?: (cmd: RevealCommand) => void;
  /** Injectable for tests; defaults to `process.platform`. */
  platform?: NodeJS.Platform;
}

export function createFsRouter(deps: FsRouterDeps = {}): ExpressRouter {
  const router = Router();
  const reveal = deps.reveal ?? spawnReveal;
  const platform = deps.platform ?? process.platform;

  router.get("/api/fs/list", async (req, res) => {
    const rawPath = req.query.path;
    if (typeof rawPath !== "string" || !rawPath.trim()) {
      res.status(400).json({ error: "path query param is required" });
      return;
    }

    const expanded = expandHome(rawPath);
    if (!path.isAbsolute(expanded)) {
      res.status(400).json({ error: `path must be absolute (or start with ~): ${rawPath}` });
      return;
    }
    // Normalizes `..`/`.`/duplicate-slash segments; still absolute since the
    // input already was (checked above), so this can't turn a validated
    // absolute path into a relative one.
    const resolved = path.resolve(expanded);

    // This picker intentionally browses any absolute directory the user names,
    // so there's no single root to confine to — but a fully resolved path must
    // never retain a `..` segment. Assert that explicitly at the sink: it
    // rejects nothing legitimate (resolve() already normalized traversal away)
    // and makes the no-traversal guarantee local to the readdir below.
    if (hasTraversalSegment(resolved)) {
      res.status(400).json({ error: `path must not contain traversal segments: ${rawPath}` });
      return;
    }

    const includeHidden = req.query.hidden === "1";

    let entries: import("node:fs").Dirent[];
    try {
      // withFileTypes uses the OS's raw dirent info (not a followed lstat/stat),
      // so a symlink — even one pointing at a directory — reports
      // isDirectory() === false here and is naturally excluded below rather
      // than being traversed into.
      entries = await fs.readdir(resolved, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        res.status(404).json({ error: `no such directory: ${resolved}` });
        return;
      }
      if (code === "ENOTDIR") {
        res.status(400).json({ error: `not a directory: ${resolved}` });
        return;
      }
      if (code === "EACCES" || code === "EPERM") {
        res.status(403).json({ error: `permission denied: ${resolved}` });
        return;
      }
      res.status(500).json({ error: (err as Error).message });
      return;
    }

    const candidates = entries
      .filter((entry) => entry.isDirectory())
      .filter((entry) => includeHidden || !entry.name.startsWith("."))
      .map((entry) => ({ name: entry.name, path: path.join(resolved, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, MAX_RESULTS);

    // One marker probe per listed directory, capped at MAX_RESULTS (200) by the
    // slice above and issued concurrently — so this is a fixed, bounded amount
    // of local stat work, not an unbounded walk. An unreadable child reports
    // `false` rather than failing the whole listing: the picker must still be
    // able to show a folder it can't inspect.
    const dirs: FsDirEntry[] = await Promise.all(
      candidates.map(async (dir) => ({
        ...dir,
        // Match the recursive registry: ignored children are not scan targets,
        // and a marker must parse as a top-level JSON object (including `{}`).
        hasAgentProject:
          !isAgentProjectScanIgnoredDir(dir.name) &&
          (await readAgentProjectMarker(dir.path)) !== null,
      })),
    );

    const response: FsListResponse = {
      path: resolved,
      parent: path.dirname(resolved),
      dirs,
    };
    res.json(response);
  });

  router.post("/api/fs/reveal", json(), async (req, res) => {
    const rawPath: unknown = (req.body as { path?: unknown } | undefined)?.path;
    if (typeof rawPath !== "string" || !path.isAbsolute(rawPath)) {
      res.status(400).json({ error: "path must be an absolute path" });
      return;
    }
    const resolved = path.resolve(rawPath);
    // Registry before existence: answering 404 for unregistered paths would
    // tell any caller which arbitrary paths exist on this machine.
    if (!deps.isAgentPath || !(await deps.isAgentPath(resolved))) {
      res.status(403).json({ error: `not a registered agent folder: ${resolved}` });
      return;
    }
    try {
      await fs.stat(resolved);
    } catch {
      // A registered agent whose folder was deleted since the last scan.
      res.status(404).json({ error: `no such folder: ${resolved}` });
      return;
    }
    reveal(revealCommand(resolved, platform));
    res.status(204).end();
  });

  return router;
}
