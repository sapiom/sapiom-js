/**
 * Workspaces CRUD router — the `/api/workspaces` surface from
 * src/shared/types.ts, exposing the persistent workspace membership store
 * (core/workspace-store.ts) to the SPA. The integrator mounts it (and
 * express.json()) on the shared app; see server/index.ts.
 *
 *   GET    /api/workspaces                → Workspace[]
 *   POST   /api/workspaces                { name } → Workspace
 *   PATCH  /api/workspaces/:id            { name } → Workspace   (rename)
 *   DELETE /api/workspaces/:id            → { ok: true }
 *   POST   /api/workspaces/:id/agents     { agentPath } → Workspace   (assign)
 *   DELETE /api/workspaces/:id/agents     { agentPath } → Workspace   (unassign)
 */

import { Router, type Request, type Response, type Router as ExpressRouter } from "express";

import { HarnessError, InvalidWorkspaceNameError, UnknownWorkspaceError } from "../core/errors.js";
import type { WorkspaceStoreLike } from "../core/workspace-store.js";

/** Maps a thrown error to a JSON error response. Typed harness errors get
 *  their stable code + a specific status; anything else is a 500. */
function sendError(res: Response, err: unknown): void {
  if (err instanceof UnknownWorkspaceError) {
    res.status(404).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof InvalidWorkspaceNameError) {
    res.status(400).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof HarnessError) {
    res.status(400).json({ error: err.message, code: err.code });
    return;
  }
  res.status(500).json({ error: (err as Error).message });
}

/** Reads a required non-empty string field from a JSON body, or 400s. */
function requireStringField(req: Request, res: Response, field: string): string | null {
  const value = (req.body as Record<string, unknown> | undefined)?.[field];
  if (typeof value !== "string" || !value.trim()) {
    res.status(400).json({ error: `${field} is required` });
    return null;
  }
  return value;
}

export function createWorkspacesRouter(store: WorkspaceStoreLike): ExpressRouter {
  const router = Router();

  router.get("/api/workspaces", async (_req, res) => {
    res.json(await store.list());
  });

  router.post("/api/workspaces", async (req, res) => {
    const name = requireStringField(req, res, "name");
    if (name === null) return;
    try {
      res.status(201).json(await store.create(name));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.patch("/api/workspaces/:id", async (req, res) => {
    const name = requireStringField(req, res, "name");
    if (name === null) return;
    try {
      res.json(await store.rename(req.params.id, name));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.delete("/api/workspaces/:id", async (req, res) => {
    try {
      await store.remove(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post("/api/workspaces/:id/agents", async (req, res) => {
    const agentPath = requireStringField(req, res, "agentPath");
    if (agentPath === null) return;
    try {
      res.json(await store.assignAgent(req.params.id, agentPath));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.delete("/api/workspaces/:id/agents", async (req, res) => {
    const agentPath = requireStringField(req, res, "agentPath");
    if (agentPath === null) return;
    try {
      res.json(await store.unassignAgent(req.params.id, agentPath));
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}
