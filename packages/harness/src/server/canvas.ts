/**
 * Canvas serving (workstream W5's backend slice).
 *
 * Serves files under `<cwd>/.sapiom/canvas/` (see CANVAS_DIR) at
 * `GET /canvas/:harnessSessionId/*`. The root request resolves by binding:
 * a session bound to a workflow gets that workflow's deterministic render
 * (`renders/<slug>.html` — resolved at request time, so switching the
 * binding is instant, no file rewrite involved); an unbound session gets the
 * legacy agent-authored `index.html` (custom canvases, the seeded template)
 * exactly as before. The SPA's CanvasPane embeds this in a sandboxed iframe
 * and probes it with a HEAD request (`fetch('/canvas/<id>/', { method:
 * 'HEAD' })`), so this stays intentionally simple and unauthenticated — the
 * server binds 127.0.0.1 only, and an iframe `src` / HEAD probe can't carry
 * the boot token anyway. The integrator mounts this alongside the
 * SessionManager.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Router, type Router as ExpressRouter, type Request, type Response } from "express";
import { CANVAS_DIR, CANVAS_INDEX } from "../shared/types.js";
import { slugForWorkflowPath } from "../core/canvas-render.js";

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

// Agent-generated HTML is expected to be self-contained (inline <script>/<style>,
// no build step — see the canvas convention), so this can't be a locked-down
// "no inline" policy. It still meaningfully narrows what that content can do:
// no plugins, no fetch-y content types, and it can only be framed by the
// harness's own origin (the SPA embeds it same-origin, in a sandboxed iframe
// with no allow-same-origin — this is defense in depth on top of that, not a
// replacement for it).
const CANVAS_CSP =
  "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; " +
  "style-src 'self' 'unsafe-inline'; img-src * data: blob:; connect-src *; " +
  "object-src 'none'; frame-ancestors 'self'";

const EMPTY_STATE_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Canvas — nothing here yet</title></head>
<body style="font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; color: #444; text-align: center; padding: 0 2rem;">
  <div>
    <h1 style="font-size: 1.1rem; margin-bottom: 0.5rem;">Nothing rendered yet</h1>
    <p style="margin: 0;">Bind a workflow to see its diagram here, or ask your agent to write HTML to
    <code>.sapiom/canvas/index.html</code> in this project — this pane hot-reloads whenever it changes.</p>
  </div>
</body>
</html>`;

/** Served for a BOUND session whose render file hasn't been written yet
 *  (render in flight, or a server restart before any re-render). The pane
 *  hot-reloads the moment the render lands, so this is only ever briefly
 *  visible. */
const PENDING_RENDER_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Canvas — rendering</title></head>
<body style="font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; color: #444; text-align: center; padding: 0 2rem;">
  <div>
    <h1 style="font-size: 1.1rem; margin-bottom: 0.5rem;">Rendering workflow diagram…</h1>
    <p style="margin: 0;">This pane reloads automatically when the diagram is ready.</p>
  </div>
</body>
</html>`;

export interface CanvasSession {
  cwd: string;
  /** The workflow the session is bound to, if any — decides what the canvas
   *  root request serves (the workflow's render vs. the legacy index.html). */
  boundWorkflowPath?: string | null;
}

/** Looks up a session by harnessSessionId; undefined when unknown (the real
 *  implementation is the SessionManager, once workstream W1 lands). */
export type CanvasSessionLookup = (harnessSessionId: string) => CanvasSession | undefined;

/** `relative === null` means "the canvas root" — what it resolves to depends
 *  on the session's current binding, decided per request so switching the
 *  bound workflow needs no file rewrite at all. */
function serveCanvas(getSession: CanvasSessionLookup, req: Request, res: Response, relative: string | null): void {
  res.setHeader("Content-Security-Policy", CANVAS_CSP);

  const session = getSession(req.params.harnessSessionId);
  if (!session) {
    res.status(404).end();
    return;
  }

  const isRoot = relative === null;
  const bound = isRoot ? (session.boundWorkflowPath ?? null) : null;
  const resolved = isRoot
    ? bound
      ? path.join("renders", `${slugForWorkflowPath(bound)}.html`)
      : INDEX_FILENAME
    : relative;

  const canvasRoot = path.resolve(session.cwd, CANVAS_DIR);
  const filePath = path.resolve(canvasRoot, resolved);

  // Path traversal guard: the resolved file must stay under canvasRoot.
  if (filePath !== canvasRoot && !filePath.startsWith(canvasRoot + path.sep)) {
    res.status(400).end();
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // A bound session whose render file isn't on disk yet gets the
      // "rendering…" page — the pane hot-reloads once the render lands.
      if (isRoot && bound) {
        res.status(200).setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(PENDING_RENDER_HTML);
        return;
      }
      // The canvas index specifically missing gets a friendly explainer
      // (useful when this URL is opened directly, e.g. in a new tab during a
      // demo); any other missing file (a referenced asset) stays a plain 404.
      if (resolved === INDEX_FILENAME) {
        res.status(404).setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(EMPTY_STATE_HTML);
        return;
      }
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
    serveCanvas(getSession, req, res, wildcard || null);
  });

  router.get(["/canvas/:harnessSessionId", "/canvas/:harnessSessionId/"], (req, res) => {
    serveCanvas(getSession, req, res, null);
  });

  return router;
}
