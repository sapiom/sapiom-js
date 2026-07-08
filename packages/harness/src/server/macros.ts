/**
 * Macro execution endpoint (workstream W5's backend slice): `GET /api/macros`
 * and `POST /api/macros/:id/run` from src/shared/types.ts. The SPA's action
 * rail already resolves and opens "open-url" macros client-side — it can't
 * carry the boot token through `window.open` anyway — so in practice this
 * only ever executes "inject" macros (routed to the session's pty, or to a
 * headless background task when the macro says `execution: "background"`)
 * and "render-canvas", but it handles every kind per the documented
 * contract. The integrator mounts this (with express.json()) alongside the
 * SessionManager, TaskManager, and WorkflowRegistry.
 */
import * as path from "node:path";
import { Router, type Router as ExpressRouter } from "express";
import { CANVAS_INDEX, type MacroDef, type RunMacroRequest, type WorkflowInfo } from "../shared/types.js";
import { MacroValidationError, resolveMacro } from "../core/macro-runner.js";
import { SessionNotReadyError } from "../core/session-manager.js";
import { TaskAlreadyRunningError, TaskNotSupportedError } from "../core/task-manager.js";

export interface MacrosRouterDeps {
  listMacros(): MacroDef[];
  /** Look up a registered workflow by its path; null when not found. */
  findWorkflow(workflowPath: string): WorkflowInfo | null;
  /** The session's project directory, or null when the session is unknown. */
  getSessionCwd(harnessSessionId: string): string | null;
  /** The session's currently bound workflow path (PATCH /sessions/:id/workflow),
   *  or null when unbound / the session is unknown. Explicit `workflowPath` on
   *  the request always wins — this is only a fallback for when it's omitted. */
  getBoundWorkflowPath(harnessSessionId: string): string | null;
  /** Injects resolved text into the session's pty (the SessionManager). */
  injectInput(harnessSessionId: string, text: string, submit: boolean): Promise<void>;
  /** Runs an "inject" macro marked `execution: "background"` as a headless
   *  one-shot task (the TaskManager) instead of touching the session's pty.
   *  May throw TaskNotSupportedError (session's harness has no headless
   *  mode → 400) or TaskAlreadyRunningError (same macro already in flight
   *  for this session → 409). */
  runBackgroundTask(harnessSessionId: string, macro: MacroDef, prompt: string): Promise<void>;
  /** Opens a URL in the user's default browser (the `open` package). */
  openUrl(url: string): Promise<void>;
  /** Runs the deterministic canvas render for a session (the "visualize"
   *  macro's `render-canvas` action) — never throws (core/canvas-render.ts's
   *  contract), so this has no error path of its own to report. */
  renderCanvas(harnessSessionId: string): Promise<void>;
}

export function createMacrosRouter(deps: MacrosRouterDeps): ExpressRouter {
  const router = Router();

  router.get("/api/macros", (_req, res) => {
    res.json(deps.listMacros());
  });

  router.post("/api/macros/:id/run", async (req, res) => {
    const macro = deps.listMacros().find((m) => m.id === req.params.id);
    if (!macro) {
      res.status(404).json({ error: `Unknown macro '${req.params.id}'` });
      return;
    }

    const body = (req.body ?? {}) as Partial<RunMacroRequest>;
    if (typeof body.harnessSessionId !== "string" || !body.harnessSessionId) {
      res.status(400).json({ error: "harnessSessionId is required" });
      return;
    }

    const cwd = deps.getSessionCwd(body.harnessSessionId);
    if (!cwd) {
      res.status(404).json({ error: `Unknown session '${body.harnessSessionId}'` });
      return;
    }

    const workflowPath =
      typeof body.workflowPath === "string" ? body.workflowPath : deps.getBoundWorkflowPath(body.harnessSessionId);
    const workflow = workflowPath ? deps.findWorkflow(workflowPath) : null;

    try {
      const resolved = resolveMacro(macro, {
        workflow,
        sessionCwd: cwd,
        canvasPath: path.join(cwd, CANVAS_INDEX),
        subject: body.subject,
      });

      if (resolved.kind === "open-url") {
        await deps.openUrl(resolved.url);
      } else if (resolved.kind === "render-canvas") {
        await deps.renderCanvas(body.harnessSessionId);
      } else if (macro.execution === "background") {
        await deps.runBackgroundTask(body.harnessSessionId, macro, resolved.text);
      } else {
        await deps.injectInput(body.harnessSessionId, resolved.text, resolved.submit);
      }

      res.json({ ok: true });
    } catch (err) {
      if (err instanceof MacroValidationError || err instanceof TaskNotSupportedError) {
        res.status(400).json({ error: err.message });
        return;
      }
      if (err instanceof SessionNotReadyError || err instanceof TaskAlreadyRunningError) {
        res.status(409).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
