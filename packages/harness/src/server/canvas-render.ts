/**
 * `POST /api/canvas/:sessionId/render` — the deterministic, zero-LLM render
 * trigger. Mounted under the same `/api` boot-token middleware as the rest of
 * the REST surface (see server/index.ts). Renders the session's bound
 * workflow to its per-workflow render file (a cheap no-op when unbound);
 * writing the file is enough to hot-reload an already-open canvas pane
 * (CanvasWatcherManager picks up the change on its own).
 */
import { Router, type Router as ExpressRouter } from "express";
import { renderCanvasForSession, type RenderableSession, type RenderableWorkflow } from "../core/canvas-render.js";

export interface CanvasRenderRouterDeps {
  /** Look up a session's cwd + current binding; undefined when unknown. */
  getSession(harnessSessionId: string): RenderableSession | undefined;
  /** The live workflow registry snapshot. */
  listWorkflows(): RenderableWorkflow[];
}

export function createCanvasRenderRouter(deps: CanvasRenderRouterDeps): ExpressRouter {
  const router = Router();

  router.post("/canvas/:sessionId/render", async (req, res) => {
    const session = deps.getSession(req.params.sessionId);
    if (!session) {
      res.status(404).json({ error: `Unknown session '${req.params.sessionId}'` });
      return;
    }
    const outcome = await renderCanvasForSession(session, deps.listWorkflows());
    res.json({ ok: true, ...outcome });
  });

  return router;
}
