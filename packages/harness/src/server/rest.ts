/**
 * REST surface under /api — see src/shared/types.ts for the full contract
 * table. This router covers the session-lifecycle endpoints (W1); workflows,
 * macros and settings are mounted by other workstreams alongside this one.
 */

import express, { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  AnalyticsEvent,
  AppState,
  AttachImageRequest,
  AttachImageResponse,
  BackgroundTask,
  BindWorkflowRequest,
  CreateSessionRequest,
  HarnessAdapter,
  HarnessKind,
  HarnessSession,
  HarnessSettings,
  ImageMediaType,
  InjectInputRequest,
  MacroDef,
  SampleProjectSeedResponse,
  SessionSummary,
  UiEventName,
  UiTrackRequest,
  WorkflowInfo,
} from "../shared/types.js";
import {
  ALLOWED_IMAGE_MEDIA_TYPES,
  HARNESS_UPLOADS_DIR,
  JSON_BODY_LIMIT_BYTES,
  MAX_IMAGE_UPLOAD_BYTES,
  SPAWNABLE_HARNESS_KINDS,
} from "../shared/types.js";
import { AdapterNotFoundError, ExternalHarnessError, SessionAlreadyLiveError, SessionNotResumeableError } from "../core/errors.js";
import { SessionNotReadyError, UnknownSessionError, type SessionManager } from "../core/session-manager.js";
import { getHarnessAdapter, listHarnessAdapters } from "../core/adapters/registry.js";
import { resolveWithinRoot } from "../core/path-safety.js";
import { loadSettings, saveSettings } from "../cli/settings.js";

// Cap image attaches per client so a runaway paste/drop loop can't fill the
// disk or wedge the pty — the route is otherwise unauthenticated beyond the
// boot token. (Added by CodeQL's rate-limiting finding.)
const imageUploadRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

/** File extension to store an accepted image under, keyed by media type. */
const IMAGE_EXTENSIONS: Record<ImageMediaType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** `data:<mediaType>;base64,<payload>` — captures the media type and payload. */
const DATA_URL_RE = /^data:([a-z0-9.+/-]+);base64,([\s\S]+)$/i;

// Derived from SPAWNABLE_HARNESS_KINDS (shared/types.ts) so the zod
// validation and the TypeScript type can never drift from each other.
// Adding a new spawnable harness means updating that one constant; the
// validator here and the HarnessKind type both pick up the change automatically.
const createSessionSchema = z.object({
  cwd: z.string().min(1),
  harness: z.enum(SPAWNABLE_HARNESS_KINDS),
  profile: z.string().optional(),
}) satisfies z.ZodType<CreateSessionRequest>;

const injectInputSchema = z.object({
  text: z.string(),
  submit: z.boolean().optional(),
}) satisfies z.ZodType<InjectInputRequest>;

const attachImageSchema = z.object({
  dataUrl: z.string().min(1),
  filename: z.string().optional(),
}) satisfies z.ZodType<AttachImageRequest>;

const bindWorkflowSchema = z.object({
  workflowPath: z.string().min(1).nullable(),
}) satisfies z.ZodType<BindWorkflowRequest>;

const settingsPatchSchema = z.object({
  telemetryOptIn: z.boolean().optional(),
  recentDirs: z.array(z.string()).optional(),
}) satisfies z.ZodType<Partial<HarnessSettings>>;

const UI_EVENT_NAMES: readonly UiEventName[] = [
  "prompt.submitted",
  "session.switched",
  "macro.invoked",
  "visualize.triggered",
  "consent.changed",
  "session.created",
  "skill.viewed",
  "skill.used",
  "mcp.install",
];

/**
 * Primitive-only value type for /api/track's `data` field — enforces that the
 * payload is provably metadata-only (no nested objects or arrays that could
 * carry arbitrary content). Keyed and value length-capped so the endpoint
 * cannot be used as a vector to push large payloads through the remote batcher.
 */
const uiTrackDataValue = z.union([
  z.string().max(256),
  z.number(),
  z.boolean(),
]);
const uiTrackDataSchema = z
  .record(z.string().max(64), uiTrackDataValue)
  .refine((obj) => Object.keys(obj).length <= 20, {
    message: "data must have at most 20 keys",
  });

const uiTrackSchema = z.object({
  event: z.enum(UI_EVENT_NAMES as [UiEventName, ...UiEventName[]]),
  data: uiTrackDataSchema.optional(),
  harnessSessionId: z.string().optional(),
}) satisfies z.ZodType<UiTrackRequest>;

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
  /** The Agents API base URL (env-configurable) — surfaced in AppState so the
   * snippet panel's executions host matches where the server resolves slugs.
   * Omitted by tests, leaving AppState.agentsBaseUrl absent (the SPA then uses
   * the SDK's default host). */
  agentsBaseUrl?: string;
  /** Background tasks known to this boot (TaskManager.list) — surfaced in
   *  AppState so a page load mid-run shows the canvas activity state without
   *  waiting for the next task.status frame. Optional: omitted by callers
   *  without a TaskManager (tests), leaving AppState.tasks absent. */
  listTasks?: () => BackgroundTask[];
  /** Harness kinds confirmed available at CLI boot (doctor()), in
   * default-preference order. Omitted (rather than defaulted here) when the
   * caller doesn't supply it, so AppState.availableHarnesses stays absent in
   * that case too — see its doc comment for how consumers should treat that. */
  availableHarnesses?: HarnessKind[];
  /** "This boot found no prior harness use" — computed by the CLI before it
   * mutated any state, surfaced verbatim in AppState.firstRun. Omitted when
   * the caller doesn't supply it (tests), leaving AppState.firstRun absent. */
  firstRun?: boolean;
  /** How telemetry consent was determined at boot — surfaced in AppState so the
   * UI can show the first-run notice when the user never explicitly answered.
   * Omitted when the caller didn't run the consent flow (tests). */
  consentSource?: AppState["consentSource"];
  /** Which env var forced telemetry off — surfaced in AppState for the
   * tracking indicator's "off (env)" label. Null/absent otherwise. */
  consentEnvReason?: string | null;
  /** Seeds (or reuses) the bundled example project and returns where it
   * landed — backs POST /api/sample-project (the welcome panel's "Run the
   * sample project"). Optional so callers without the real seeder (tests)
   * get a 501 from the route instead of having to stub one. */
  seedSampleProject?: () => Promise<SampleProjectSeedResponse>;
  /** Where GET/PATCH /settings (and /state's settings read) persist to.
   * Omitted, the real `~/.sapiom/harness/settings.json` — the integrator
   * (server/index.ts) passes the path under its resolved state root so an
   * isolated boot never reads or writes the developer's real settings. */
  settingsPath?: string;
  /**
   * Dependencies for POST /api/track (UI-interaction analytics).
   * Optional: when omitted, /api/track returns 501 (tests that don't care
   * about UI analytics don't need to stub these).
   */
  uiTrack?: {
    store: {
      append(event: import("../shared/types.js").AnalyticsEvent): Promise<void>;
    };
    batcher: {
      enqueue(event: import("../shared/types.js").AnalyticsEvent): void;
    };
    /** Per-boot seq counter shared with the ingest pipeline. */
    nextSeq: (sessionId: string) => number;
    machineId: string;
    userId: string | null;
    tenantId: string | null;
  };
}

export function createRestRouter(options: RestRouterOptions): Router {
  const {
    sessionManager,
    adapters,
    version,
    identity,
    listWorkflows,
    listMacros,
  } = options;
  const router = Router();
  router.use(express.json({ limit: JSON_BODY_LIMIT_BYTES }));

  router.get("/state", async (_req, res, next) => {
    try {
      const settings = await loadSettings(options.settingsPath);
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
        ...(options.availableHarnesses
          ? { availableHarnesses: options.availableHarnesses }
          : {}),
        ...(options.listTasks ? { tasks: options.listTasks() } : {}),
        ...(options.firstRun !== undefined
          ? { firstRun: options.firstRun }
          : {}),
        ...(options.consentSource !== undefined
          ? { consentSource: options.consentSource }
          : {}),
        ...(options.consentEnvReason !== undefined
          ? { consentEnvReason: options.consentEnvReason }
          : {}),
        ...(options.agentsBaseUrl
          ? { agentsBaseUrl: options.agentsBaseUrl }
          : {}),
      };
      res.json(state);
    } catch (err) {
      next(err);
    }
  });

  router.get("/settings", async (_req, res, next) => {
    try {
      res.json(await loadSettings(options.settingsPath));
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
      const current = await loadSettings(options.settingsPath);
      const updated: HarnessSettings = { ...current, ...parsed.data };
      await saveSettings(updated, options.settingsPath);
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

  // Deliberately does NOT create a session itself — the SPA follows up with
  // its normal POST /sessions against the returned root, so recent-dirs
  // bookkeeping, workflow scanning, and tab state all flow through the one
  // existing session-creation path.
  router.post("/sample-project", async (_req, res, next) => {
    if (!options.seedSampleProject) {
      res
        .status(501)
        .json({
          error: "sample project seeding is not available on this server",
        });
      return;
    }
    try {
      res.json(await options.seedSampleProject());
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/harnesses — registry-driven listing of all known harness
   * adapters with their mode (embedded vs external), label, and whether
   * the binary is installed on this machine.
   *
   * Embedded adapters can be used in POST /sessions (harness field).
   * External adapters expose mode:"external" so the UI can render them
   * differently (e.g. a "companion app" chip) without being selectable
   * as session targets.
   *
   * `installed` is best-effort and never throws — it may lag PATH changes
   * by at most one request cycle since it probes the filesystem per request.
   */
  router.get("/harnesses", async (_req, res, next) => {
    try {
      const adapters = listHarnessAdapters();
      const entries = await Promise.all(
        adapters.map(async (adapter) => ({
          id: adapter.id,
          label: adapter.label,
          mode: adapter.mode,
          experimental: adapter.experimental ?? false,
          installed: await adapter.detectInstalled(),
          installMcpPrompt: adapter.installMcpPrompt(),
          imageInput: adapter.imageInput,
        })),
      );
      res.json(entries);
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
      if (err instanceof AdapterNotFoundError) {
        res.status(400).json({ error: err.message, code: err.code });
        return;
      }
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
      if (err instanceof UnknownSessionError) {
        res.status(404).json({ error: err.message });
        return;
      }
      if (err instanceof AdapterNotFoundError) {
        // A persisted session with an unknown harness kind (e.g. from a future
        // or removed harness type) cannot be resumed.
        res.status(400).json({ error: err.message, code: err.code });
        return;
      }
      if (
        err instanceof ExternalHarnessError ||
        err instanceof SessionAlreadyLiveError ||
        err instanceof SessionNotResumeableError
      ) {
        res
          .status(409)
          .json({ error: err.message, code: (err as { code: string }).code });
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
    void sessionManager.kill(req.params.id);
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
      const ok = await sessionManager.submitInput(
        req.params.id,
        parsed.data.text,
        submit,
      );
      if (!ok) {
        res.status(404).json({ error: "session not found or has no live pty" });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      if (
        err instanceof SessionNotReadyError ||
        err instanceof ExternalHarnessError
      ) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      next(err);
    }
  });

  /**
   * POST /api/sessions/:id/image — attach an image (composer file picker,
   * paste, or drag-drop) and relay it to the agent.
   *
   * The harness has no direct image-content-block channel to a CLI agent, so
   * "relay as an image" means: write the decoded image into the session's
   * project directory (under HARNESS_UPLOADS_DIR) and inject its absolute path
   * into the pty (submit:false) — the supported agents read an image referenced
   * by path in their prompt. The attach is only offered/accepted for harnesses
   * whose adapter declares `imageInput`, so an image never gets relayed to an
   * agent that can't consume it.
   */
  router.post("/sessions/:id/image", imageUploadRateLimiter, async (req, res, next) => {
    const parsed = attachImageSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const session = sessionManager.get(req.params.id);
    if (!session) {
      res.status(404).json({ error: "session not found" });
      return;
    }

    // Respect the adapter's declared image support — reject rather than write a
    // file the agent will never look at.
    if (!getHarnessAdapter(session.harness).imageInput) {
      res.status(400).json({ error: `Harness '${session.harness}' does not support image input` });
      return;
    }

    const match = DATA_URL_RE.exec(parsed.data.dataUrl);
    if (!match) {
      res.status(400).json({ error: "dataUrl must be a base64 data: URL" });
      return;
    }
    const mediaType = match[1].toLowerCase();
    if (!(ALLOWED_IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType)) {
      res.status(400).json({
        error: `Unsupported image type '${mediaType}' — allowed: ${ALLOWED_IMAGE_MEDIA_TYPES.join(", ")}`,
      });
      return;
    }
    const buffer = Buffer.from(match[2], "base64");
    if (buffer.byteLength === 0) {
      res.status(400).json({ error: "image payload is empty" });
      return;
    }
    if (buffer.byteLength > MAX_IMAGE_UPLOAD_BYTES) {
      res.status(413).json({
        error: `Image is ${buffer.byteLength} bytes; the limit is ${MAX_IMAGE_UPLOAD_BYTES} bytes`,
      });
      return;
    }

    // Confine the write to the session cwd; the stored name is a fresh uuid
    // (never the client-supplied filename) so an image can't be written outside
    // the uploads directory regardless of what the browser reported.
    const uploadsDir = resolveWithinRoot(session.cwd, HARNESS_UPLOADS_DIR);
    if (!uploadsDir) {
      res.status(500).json({ error: "could not resolve the uploads directory" });
      return;
    }
    const ext = IMAGE_EXTENSIONS[mediaType as ImageMediaType];
    const filePath = path.join(uploadsDir, `${randomUUID()}.${ext}`);

    try {
      await fs.mkdir(uploadsDir, { recursive: true });
      await fs.writeFile(filePath, buffer);
      // A trailing space so the user's own message doesn't run into the path.
      const injected = await sessionManager.submitInput(req.params.id, `${filePath} `, false);
      if (!injected) {
        res.status(404).json({ error: "session not found or has no live pty" });
        return;
      }
      const response: AttachImageResponse = {
        path: filePath,
        mediaType: mediaType as ImageMediaType,
        bytes: buffer.byteLength,
      };
      res.json(response);
    } catch (err) {
      if (err instanceof SessionNotReadyError || err instanceof ExternalHarnessError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      next(err);
    }
  });

  /**
   * POST /api/track — UI-interaction analytics.
   *
   * Feeds the same store + batcher pipeline as hook events from /ingest, so
   * ui.* events get the same local ndjson write (always) and remote delivery
   * (per consent) that agent hook events do.  The client fires fire-and-forget
   * — we always respond 200 fast, then process.
   *
   * Consent semantics: store.append always; batcher.enqueue only when opted in
   * (batcher.enqueue is gated by the HarnessEmitter's disabled flag, which
   * mirrors the live consent state — same as hook events).
   */
  router.post("/track", (req, res) => {
    if (!options.uiTrack) {
      // Not wired in this server instance (tests without UI analytics deps).
      res.status(501).json({ error: "ui tracking not available" });
      return;
    }

    // Validate before responding — bad shape gets a 400 synchronously.
    const parsed = uiTrackSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    // Respond immediately — fire-and-forget from the client's perspective.
    res.json({ ok: true });

    const { store, batcher, nextSeq, machineId, userId, tenantId } =
      options.uiTrack;
    const { event, data, harnessSessionId } = parsed.data;
    // Use the provided session id for seq tracking; fall back to a synthetic
    // one-use id so ui events without a session still get a valid seq.
    const sessionId = harnessSessionId ?? `ui-${randomUUID()}`;

    const analyticsEvent: AnalyticsEvent = {
      eventId: randomUUID(),
      seq: nextSeq(sessionId),
      ts: new Date().toISOString(),
      userId,
      tenantId,
      machineId,
      harnessSessionId: sessionId,
      agentSessionId: null,
      harness: "claude-code", // ui events have no harness kind; use canonical placeholder
      type: event,
      payload: {
        ...(data ?? {}),
        surface: "ui",
      },
    };

    void store.append(analyticsEvent).catch((err: unknown) => {
      // Non-fatal: local write failure should never surface to the user.
      void err;
    });
    batcher.enqueue(analyticsEvent);
  });

  return router;
}
