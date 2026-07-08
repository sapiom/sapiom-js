/**
 * REST surface under /api — see src/shared/types.ts for the full contract
 * table. This router covers the session-lifecycle endpoints (W1); workflows,
 * macros and settings are mounted by other workstreams alongside this one.
 */

import express, { Router } from "express";
import { z } from "zod";

import type {
  AppState,
  BindWorkflowRequest,
  CreateSessionRequest,
  HarnessAdapter,
  HarnessKind,
  HarnessSession,
  HarnessSettings,
  InjectInputRequest,
  MacroDef,
  SessionSummary,
  WorkflowInfo,
} from "../shared/types.js";
import { SessionNotReadyError, type SessionManager } from "../core/session-manager.js";
import { loadSettings, saveSettings } from "../cli/settings.js";

const createSessionSchema = z.object({
  cwd: z.string().min(1),
  harness: z.enum(["claude-code", "codex"]),
  profile: z.string().optional(),
}) satisfies z.ZodType<CreateSessionRequest>;

const injectInputSchema = z.object({
  text: z.string(),
  submit: z.boolean().optional(),
}) satisfies z.ZodType<InjectInputRequest>;

const bindWorkflowSchema = z.object({
  workflowPath: z.string().min(1).nullable(),
}) satisfies z.ZodType<BindWorkflowRequest>;

const settingsPatchSchema = z.object({
  telemetryOptIn: z.boolean().optional(),
  recentDirs: z.array(z.string()).optional(),
}) satisfies z.ZodType<Partial<HarnessSettings>>;

export interface RestRouterOptions {
  sessionManager: SessionManager;
  adapters: Partial<Record<HarnessKind, HarnessAdapter>>;
  version: string;
  /** Sapiom identity from CLI auth; null when unauthenticated / --no-auth. */
  identity: { userId: string; organizationName: string } | null;
  listWorkflows: () => Promise<WorkflowInfo[]>;
  listMacros: () => MacroDef[];
  /** Look up a registered workflow by its path; null when not found. Backs
   *  PATCH /sessions/:id/workflow's validation (a bind target must already
   *  be a known workflow — scan/connect it first). */
  findWorkflow: (workflowPath: string) => WorkflowInfo | null;
  /** Mirrors a session's workspace state (its binding plus the full workflow
   *  registry) into HARNESS_CONTEXT_FILE in its cwd — the caller (server/
   *  index.ts) resolves `session.boundWorkflowPath` against the live
   *  registry, so this only needs the session itself. Called on every
   *  successful bind/unbind. Never throws — a write failure is logged by the
   *  implementation, not surfaced as a request error. */
  writeWorkspaceContext: (session: HarnessSession) => Promise<void>;
  /** Re-renders the session's canvas (its bound workflow, or the workspace
   *  overview when unbound) via the deterministic pipeline — called after a
   *  successful bind/unbind so the pane reflects the new selection without
   *  waiting on the agent to run the Visualize macro itself. Never throws
   *  (core/canvas-render.ts's contract); defaults to a no-op for tests that
   *  don't care about canvas output. */
  renderCanvas?: (session: HarnessSession) => Promise<void>;
  /** Called after a settings PATCH persists a changed telemetryOptIn, so the
   * live collector batcher can be gated without a server restart. */
  onTelemetryOptInChange?: (optIn: boolean) => void;
  /** Called (fire-and-forget) after a session is created, with its cwd and id
   * — lets the integrator scan that directory for workflows (so opening a
   * session in a new project discovers them without a manual "+ Connect")
   * and, when the scan discovers one, render the new session's canvas. */
  onSessionCreated?: (cwd: string, harnessSessionId: string) => void;
  /** The directory the CLI was launched against — surfaced in AppState so the
   * SPA can prefill the new-session modal with it. */
  launchDir: string;
  /** Harness kinds confirmed available at CLI boot (doctor()), in
   * default-preference order. Omitted (rather than defaulted here) when the
   * caller doesn't supply it, so AppState.availableHarnesses stays absent in
   * that case too — see its doc comment for how consumers should treat that. */
  availableHarnesses?: HarnessKind[];
}

export function createRestRouter(options: RestRouterOptions): Router {
  const { sessionManager, adapters, version, identity, listWorkflows, listMacros } = options;
  const router = Router();
  router.use(express.json());

  router.get("/state", async (_req, res, next) => {
    try {
      const settings = await loadSettings();
      const state: AppState = {
        version,
        authenticated: identity !== null,
        userId: identity?.userId ?? null,
        organizationName: identity?.organizationName ?? null,
        telemetryOptIn: settings.telemetryOptIn,
        sessions: sessionManager.list(),
        workflows: await listWorkflows(),
        macros: listMacros(),
        launchDir: options.launchDir,
        ...(options.availableHarnesses ? { availableHarnesses: options.availableHarnesses } : {}),
      };
      res.json(state);
    } catch (err) {
      next(err);
    }
  });

  router.get("/settings", async (_req, res, next) => {
    try {
      res.json(await loadSettings());
    } catch (err) {
      next(err);
    }
  });

  router.patch("/settings", async (req, res, next) => {
    const parsed = settingsPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    try {
      const current = await loadSettings();
      const updated: HarnessSettings = { ...current, ...parsed.data };
      await saveSettings(updated);
      if (
        parsed.data.telemetryOptIn !== undefined &&
        parsed.data.telemetryOptIn !== current.telemetryOptIn
      ) {
        options.onTelemetryOptInChange?.(parsed.data.telemetryOptIn);
      }
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  router.post("/sessions", async (req, res, next) => {
    const parsed = createSessionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    try {
      // sessionManager.create() writes the initial harness-context.json
      // itself (before spawning) so every entry point gets it, not just
      // this REST route — see SessionManager.create().
      const session = await sessionManager.create(parsed.data);
      res.status(201).json(session);
      options.onSessionCreated?.(parsed.data.cwd, session.id);
    } catch (err) {
      next(err);
    }
  });

  router.patch("/sessions/:id/workflow", async (req, res, next) => {
    const parsed = bindWorkflowSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const session = sessionManager.get(req.params.id);
    if (!session) {
      res.status(404).json({ error: "session not found" });
      return;
    }

    const { workflowPath } = parsed.data;
    if (workflowPath !== null && !options.findWorkflow(workflowPath)) {
      res.status(400).json({
        error: `Unknown workflow path '${workflowPath}' — scan or connect it before binding a session to it`,
      });
      return;
    }

    try {
      sessionManager.setBoundWorkflowPath(req.params.id, workflowPath);
      // setBoundWorkflowPath() mutates the same session object in place, so
      // `session` here already reflects the new boundWorkflowPath — the
      // callee resolves it against the live registry itself.
      await options.writeWorkspaceContext(session);
      await (options.renderCanvas ?? (async () => {}))(session);
      res.json(sessionManager.get(req.params.id));
    } catch (err) {
      next(err);
    }
  });

  router.get("/sessions", (_req, res) => {
    res.json(sessionManager.list());
  });

  router.get("/sessions/history", async (req, res, next) => {
    const cwd = typeof req.query.cwd === "string" ? req.query.cwd : undefined;
    if (!cwd) {
      res.status(400).json({ error: "cwd query param is required" });
      return;
    }
    try {
      // Registry entries win over transcript-scanned history for the same
      // agent session — they carry live status the transcript can't know.
      const byAgentSessionId = new Map<string, SessionSummary>();
      for (const session of sessionManager.list()) {
        if (session.cwd !== cwd || !session.agentSessionId) continue;
        byAgentSessionId.set(session.agentSessionId, {
          harnessSessionId: session.id,
          agentSessionId: session.agentSessionId,
          harness: session.harness,
          cwd: session.cwd,
          title: session.title,
          lastActiveAt: session.lastActiveAt,
          source: "registry",
        });
      }
      for (const adapter of Object.values(adapters)) {
        if (!adapter) continue;
        for (const summary of await adapter.listPastSessions(cwd)) {
          if (!byAgentSessionId.has(summary.agentSessionId)) {
            byAgentSessionId.set(summary.agentSessionId, summary);
          }
        }
      }
      const merged = Array.from(byAgentSessionId.values()).sort((a, b) =>
        a.lastActiveAt < b.lastActiveAt ? 1 : -1,
      );
      res.json(merged);
    } catch (err) {
      next(err);
    }
  });

  router.post("/sessions/:id/resume", async (req, res, next) => {
    try {
      const session = await sessionManager.resume(req.params.id);
      res.json(session);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Unknown session")) {
        res.status(404).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  router.delete("/sessions/:id", (req, res) => {
    const existed = sessionManager.get(req.params.id) !== undefined;
    if (!existed) {
      res.status(404).json({ error: "session not found" });
      return;
    }
    sessionManager.kill(req.params.id);
    res.json({ ok: true });
  });

  router.post("/sessions/:id/input", async (req, res, next) => {
    const parsed = injectInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    try {
      const submit = parsed.data.submit ?? true;
      const ok = await sessionManager.submitInput(req.params.id, parsed.data.text, submit);
      if (!ok) {
        res.status(404).json({ error: "session not found or has no live pty" });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof SessionNotReadyError) {
        res.status(409).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  return router;
}
