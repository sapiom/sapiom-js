/**
 * Canvas serving (workstream W5's backend slice).
 *
 * Serves whatever a session's agent wrote to `<cwd>/.sapiom/canvas/` (see
 * CANVAS_DIR) at `GET /canvas/:harnessSessionId/*`. The SPA's CanvasPane
 * embeds this in a sandboxed iframe and probes it with a HEAD request
 * (`fetch('/canvas/<id>/', { method: 'HEAD' })`), so this stays
 * intentionally simple and unauthenticated — the server binds 127.0.0.1
 * only, and an iframe `src` / HEAD probe can't carry the boot token anyway.
 * The integrator mounts this alongside the SessionManager.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Router, type Router as ExpressRouter, type Request, type Response } from "express";
import { CANVAS_DIR, CANVAS_INDEX } from "../shared/types.js";

const INDEX_FILENAME = path.basename(CANVAS_INDEX);

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

function contentTypeFor(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export interface CanvasSession {
  cwd: string;
}

/** Looks up a session by harnessSessionId; undefined when unknown (the real
 *  implementation is the SessionManager, once workstream W1 lands). */
export type CanvasSessionLookup = (harnessSessionId: string) => CanvasSession | undefined;

function serveCanvas(getSession: CanvasSessionLookup, req: Request, res: Response, relative: string): void {
  const session = getSession(req.params.harnessSessionId);
  if (!session) {
    res.status(404).end();
    return;
  }

  const canvasRoot = path.resolve(session.cwd, CANVAS_DIR);
  const filePath = path.resolve(canvasRoot, relative);

  // Path traversal guard: the resolved file must stay under canvasRoot.
  if (filePath !== canvasRoot && !filePath.startsWith(canvasRoot + path.sep)) {
    res.status(400).end();
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.status(404).end();
      return;
    }
    res.setHeader("Content-Type", contentTypeFor(filePath));
    res.setHeader("Cache-Control", "no-store");
    fs.createReadStream(filePath).pipe(res);
  });
}

export function createCanvasRouter(getSession: CanvasSessionLookup): ExpressRouter {
  const router = Router();

  router.get("/canvas/:harnessSessionId/*", (req, res) => {
    // Express's route-param typing doesn't model the unnamed `*` wildcard —
    // it's there at runtime as params[0], just not in the inferred type.
    const wildcard = (req.params as unknown as Record<string, string>)[0];
    serveCanvas(getSession, req, res, wildcard || INDEX_FILENAME);
  });

  router.get(["/canvas/:harnessSessionId", "/canvas/:harnessSessionId/"], (req, res) => {
    serveCanvas(getSession, req, res, INDEX_FILENAME);
  });

  return router;
}
