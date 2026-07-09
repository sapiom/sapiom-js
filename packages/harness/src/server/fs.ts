/**
 * Filesystem browsing for the SPA's path-picker autocomplete: `GET
 * /api/fs/list?path=<abs-or-~>` → directories only, one level deep. This is
 * a self-contained express Router with no dependency on the rest of the
 * server — the integrator mounts it (behind the boot token, like the rest
 * of /api) alongside everything else.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Router, type Router as ExpressRouter } from "express";
import type { FsDirEntry, FsListResponse } from "../shared/types.js";
import { hasTraversalSegment } from "../core/path-safety.js";

export type { FsDirEntry, FsListResponse } from "../shared/types.js";

const MAX_RESULTS = 200;

function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

export function createFsRouter(): ExpressRouter {
  const router = Router();

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

    const dirs: FsDirEntry[] = entries
      .filter((entry) => entry.isDirectory())
      .filter((entry) => includeHidden || !entry.name.startsWith("."))
      .map((entry) => ({ name: entry.name, path: path.join(resolved, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, MAX_RESULTS);

    const response: FsListResponse = {
      path: resolved,
      parent: path.dirname(resolved),
      dirs,
    };
    res.json(response);
  });

  return router;
}
