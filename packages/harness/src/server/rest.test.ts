import type { AddressInfo } from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpHome: string;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return { ...actual, homedir: () => tmpHome };
});

import type {
  HarnessAdapter,
  HarnessKind,
  HarnessSession,
  MacroDef,
  SessionRecord,
  SessionSummary,
  SpawnSpec,
  WorkflowInfo,
} from "../shared/types.js";
import {
  ProjectSessionScopeUnavailableError,
  SessionBackgroundInputPreemptedError,
  SessionManager,
  SessionManagerClosingError,
  SessionNotReadyError,
  UnknownSessionError,
} from "../core/session-manager.js";
import type { SessionRecordReader } from "../core/session-record.js";
import { IngestCredentialRegistry } from "../core/ingest-credentials.js";
import {
  AdapterNotFoundError,
  ExternalHarnessError,
  SessionAlreadyLiveError,
  SessionNotResumeableError,
  SpawnTargetError,
} from "../core/errors.js";
import { createRestRouter, type RestRouterOptions } from "./rest.js";

const TOKEN_HEADER = { "X-Harness-Token": "unused-in-router-tests" };

function fakeSessionManager(initial: HarnessSession[] = []) {
  const sessions = new Map(initial.map((s) => [s.id, s]));
  return {
    list: () => Array.from(sessions.values()),
    get: (id: string) => sessions.get(id),
    getAgentSessionOwner: vi.fn((agentSessionId: string) =>
      Array.from(sessions.values()).find(
        (session) => session.agentSessionId === agentSessionId,
      ),
    ),
    isAgentSessionIdentityReserved: vi.fn((agentSessionId: string) =>
      Array.from(sessions.values()).some(
        (session) => session.agentSessionId === agentSessionId,
      ),
    ),
    create: vi.fn(),
    resume: vi.fn(),
    kill: vi.fn(() => true),
    write: vi.fn(() => true),
    submitInput: vi.fn(async () => true),
    setBoundWorkflowPath: vi.fn((id: string, workflowPath: string | null) => {
      const session = sessions.get(id);
      if (session) session.boundWorkflowPath = workflowPath;
    }),
    registerHistorical: vi.fn(
      async (input: {
        agentSessionId: string;
        harness: HarnessKind;
        cwd: string;
        title: string;
        lastActiveAt: string;
      }) => {
        const session: HarnessSession = {
          id: `adopted-${input.agentSessionId}`,
          agentSessionId: input.agentSessionId,
          harness: input.harness,
          cwd: input.cwd,
          title: input.title,
          status: "exited",
          createdAt: input.lastActiveAt,
          lastActiveAt: input.lastActiveAt,
          exitCode: null,
          boundWorkflowPath: null,
          ready: false,
        };
        sessions.set(session.id, session);
        return session;
      },
    ),
  } as unknown as RestRouterOptions["sessionManager"];
}

/** An exited registry session — the shape a past-sessions row is built from. */
function exitedSession(
  overrides: Partial<HarnessSession> = {},
): HarnessSession {
  return {
    id: "sess-1",
    agentSessionId: "agent-1",
    harness: "claude-code",
    cwd: "/tmp/proj",
    title: "proj",
    status: "exited",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActiveAt: "2026-01-01T01:00:00.000Z",
    exitCode: 0,
    boundWorkflowPath: null,
    ready: false,
    ...overrides,
  };
}

/** A history adapter whose resumability answer and transcript listing are both
 *  controllable — the two independent inputs the history endpoint merges. */
function historyAdapter(
  opts: {
    canResume?: HarnessAdapter["canResume"];
    listPastSessions?: HarnessAdapter["listPastSessions"];
  } = {},
): HarnessAdapter {
  return {
    id: "claude-code",
    eventSource: "hooks" as const,
    doctor: async () => [],
    launch: (o): SpawnSpec => ({
      command: "fake-claude",
      args: [],
      env: {},
      cwd: o.cwd,
    }),
    resume: (agentSessionId, o): SpawnSpec => ({
      command: "fake-claude",
      args: ["--resume", agentSessionId],
      env: {},
      cwd: o.cwd,
    }),
    listPastSessions: opts.listPastSessions ?? (async () => []),
    canResume: opts.canResume ?? (async () => true),
  };
}

describe("createRestRouter", () => {
  let server: ReturnType<express.Express["listen"]>;
  let baseUrl: string;
  let onTelemetryOptInChange: ReturnType<typeof vi.fn>;
  let writeWorkspaceContext: ReturnType<typeof vi.fn>;

  function start(overrides: Partial<RestRouterOptions> = {}) {
    onTelemetryOptInChange = vi.fn();
    writeWorkspaceContext = vi.fn().mockResolvedValue(undefined);
    const options: RestRouterOptions = {
      sessionManager: fakeSessionManager(),
      adapters: {},
      version: "9.9.9-test",
      identity: null,
      listWorkflows: async () => [],
      listMacros: () => [],
      findWorkflow: () => null,
      writeWorkspaceContext,
      onTelemetryOptInChange,
      launchDir: "/tmp/launch-dir",
      ...overrides,
    };
    const app = express();
    app.use(createRestRouter(options));
    server = app.listen(0);
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  }

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "harness-rest-test-"));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  describe("GET /state", () => {
    it("reports unauthenticated with empty workflows/macros/sessions by default", async () => {
      start();
      const res = await fetch(`${baseUrl}/state`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        version: "9.9.9-test",
        authenticated: false,
        userId: null,
        tenantId: null,
        organizationName: null,
        telemetryOptIn: false,
        productAnalyticsOptIn: true,
        sessions: [],
        workflows: [],
        macros: [],
        launchDir: "/tmp/launch-dir",
      });
    });

    it("reports the server's launchDir", async () => {
      start({ launchDir: "/Users/demo/acme-app" });
      const res = await fetch(`${baseUrl}/state`);
      const body = (await res.json()) as { launchDir: string };
      expect(body.launchDir).toBe("/Users/demo/acme-app");
    });

    it("surfaces opaque workspace identities when the server supplies them", async () => {
      start({
        listWorkspaceScopes: () => [
          { workspaceKey: "workspace-app", cwd: "/Users/demo/acme-app" },
        ],
      });
      const res = await fetch(`${baseUrl}/state`);
      const body = (await res.json()) as { workspaceScopes: unknown[] };
      expect(body.workspaceScopes).toEqual([
        { workspaceKey: "workspace-app", cwd: "/Users/demo/acme-app" },
      ]);
    });

    it("omits availableHarnesses when the caller doesn't supply it", async () => {
      start();
      const res = await fetch(`${baseUrl}/state`);
      const body = (await res.json()) as Record<string, unknown>;
      expect("availableHarnesses" in body).toBe(false);
    });

    it("reports availableHarnesses (in preference order) when supplied", async () => {
      start({ availableHarnesses: ["codex"] });
      const res = await fetch(`${baseUrl}/state`);
      const body = (await res.json()) as { availableHarnesses: string[] };
      expect(body.availableHarnesses).toEqual(["codex"]);
    });

    it("omits firstRun when the caller doesn't supply it", async () => {
      start();
      const res = await fetch(`${baseUrl}/state`);
      const body = (await res.json()) as Record<string, unknown>;
      expect("firstRun" in body).toBe(false);
    });

    it("reports firstRun verbatim when supplied — including an explicit false", async () => {
      start({ firstRun: false });
      const res = await fetch(`${baseUrl}/state`);
      const body = (await res.json()) as { firstRun: boolean };
      expect(body.firstRun).toBe(false);
    });

    it("omits agentsBaseUrl when the caller doesn't supply it", async () => {
      start();
      const res = await fetch(`${baseUrl}/state`);
      const body = (await res.json()) as Record<string, unknown>;
      expect("agentsBaseUrl" in body).toBe(false);
    });

    it("surfaces agentsBaseUrl when supplied", async () => {
      start({ agentsBaseUrl: "https://tools.sapiom.ai" });
      const res = await fetch(`${baseUrl}/state`);
      const body = (await res.json()) as { agentsBaseUrl: string };
      expect(body.agentsBaseUrl).toBe("https://tools.sapiom.ai");
    });

    it("reflects identity, sessions, workflows, and macros from their sources", async () => {
      const session: HarnessSession = {
        id: "s1",
        agentSessionId: null,
        harness: "claude-code",
        cwd: "/tmp/proj",
        title: "proj",
        status: "running",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastActiveAt: "2026-01-01T00:00:00.000Z",
        exitCode: null,
        boundWorkflowPath: null,
        ready: true,
      };
      const workflow: WorkflowInfo = {
        name: "leasing",
        path: "/tmp/leasing",
        definitionId: 1,
        definitionSlug: "leasing",
        source: "scan",
      };
      const macro: MacroDef = {
        id: "run_local",
        label: "Run local",
        icon: "Play",
        action: { kind: "inject", text: "x" },
      };

      start({
        sessionManager: fakeSessionManager([session]),
        identity: {
          userId: "user-1",
          tenantId: "user-1",
          organizationName: "Acme",
        },
        listWorkflows: async () => [workflow],
        listMacros: () => [macro],
      });

      const res = await fetch(`${baseUrl}/state`);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.authenticated).toBe(true);
      expect(body.userId).toBe("user-1");
      expect(body.organizationName).toBe("Acme");
      expect(body.sessions).toEqual([session]);
      expect(body.workflows).toEqual([workflow]);
      expect(body.macros).toEqual([macro]);
    });

    it("reflects the live persisted telemetryOptIn value, not a fixed default", async () => {
      start();
      await fetch(`${baseUrl}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ telemetryOptIn: true }),
      });
      const res = await fetch(`${baseUrl}/state`);
      const body = (await res.json()) as { telemetryOptIn: boolean };
      expect(body.telemetryOptIn).toBe(true);
    });
  });

  describe("GET/PATCH /settings", () => {
    it("returns defaults before anything is persisted", async () => {
      start();
      const res = await fetch(`${baseUrl}/settings`);
      // Exact shape, deliberately: every default here is a contract with the
      // SPA, and `rollingSummary` in particular must default OFF — it spends
      // tokens on a background LLM call the user never asked for.
      expect(await res.json()).toEqual({
        telemetryOptIn: false,
        recentDirs: [],
        rollingSummary: false,
      });
    });

    it("persists a patch and returns the merged result", async () => {
      start();
      const res = await fetch(`${baseUrl}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ telemetryOptIn: true }),
      });
      expect(await res.json()).toEqual({
        telemetryOptIn: true,
        recentDirs: [],
        rollingSummary: false,
      });

      const reread = await fetch(`${baseUrl}/settings`);
      expect(await reread.json()).toEqual({
        telemetryOptIn: true,
        recentDirs: [],
        rollingSummary: false,
      });
    });

    it("persists the rolling-summary opt-in", async () => {
      start();
      const res = await fetch(`${baseUrl}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rollingSummary: true }),
      });
      expect(await res.json()).toMatchObject({ rollingSummary: true });
      const reread = await fetch(`${baseUrl}/settings`);
      expect(await reread.json()).toMatchObject({ rollingSummary: true });
    });

    it("initializes only genuinely added committed recent directories", async () => {
      const onRecentDirAdded = vi.fn(async () => {});
      start({ onRecentDirAdded });
      const existing = path.join(tmpHome, "existing");
      const first = path.join(tmpHome, "first");
      const second = path.join(tmpHome, "second");
      await Promise.all([existing, first, second].map((dir) => fs.mkdir(dir)));
      const update = (recentDirs: string[]) =>
        fetch(`${baseUrl}/settings`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ recentDirs }),
        });

      expect((await update([existing])).status).toBe(200);
      onRecentDirAdded.mockClear();
      expect((await update([first, existing, second])).status).toBe(200);
      expect((await update([first, existing, second])).status).toBe(200);
      expect((await update([second, existing, first])).status).toBe(200);

      expect(onRecentDirAdded.mock.calls).toEqual([[first], [second]]);
    });

    it("keeps a committed settings PATCH successful when project initialization is deferred", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const first = path.join(tmpHome, "first");
      const second = path.join(tmpHome, "second");
      await Promise.all([first, second].map((dir) => fs.mkdir(dir)));
      const onRecentDirAdded = vi.fn(async (root: string) => {
        if (root === first) throw new Error(`private failure at ${root}`);
      });
      start({ onRecentDirAdded });

      const response = await fetch(`${baseUrl}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ recentDirs: [first, second] }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        recentDirs: [first, second],
      });
      expect(onRecentDirAdded.mock.calls).toEqual([[first], [second]]);
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(
        "[harness] project initialization deferred after settings commit",
      );
      expect(JSON.stringify(error.mock.calls)).not.toContain(tmpHome);

      const reread = await fetch(`${baseUrl}/settings`);
      expect(await reread.json()).toMatchObject({
        recentDirs: [first, second],
      });
    });

    it("calls onTelemetryOptInChange only when telemetryOptIn actually changes", async () => {
      start();
      await fetch(`${baseUrl}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ recentDirs: ["/tmp/a"] }),
      });
      expect(onTelemetryOptInChange).not.toHaveBeenCalled();

      await fetch(`${baseUrl}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ telemetryOptIn: true }),
      });
      expect(onTelemetryOptInChange).toHaveBeenCalledWith(true);
      expect(onTelemetryOptInChange).toHaveBeenCalledTimes(1);

      // Same value again — should not re-fire.
      await fetch(`${baseUrl}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ telemetryOptIn: true }),
      });
      expect(onTelemetryOptInChange).toHaveBeenCalledTimes(1);
    });

    /**
     * The one-time dismissals — the first-run explainer (SAP-2991) and the
     * telemetry notice — are the fields whose ONLY job is to survive a
     * restart, and they are the ones a missing schema entry breaks silently:
     * zod strips unknown keys, so the PATCH 200s, the response looks right,
     * and nothing reaches disk. `telemetryNoticeDismissed` shipped that way.
     * Asserting the RE-READ, not the response, is what catches it.
     */
    it("persists the one-time dismissals across a re-read", async () => {
      start();
      const res = await fetch(`${baseUrl}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          helpSeen: true,
          telemetryNoticeDismissed: true,
        }),
      });
      expect(await res.json()).toMatchObject({
        helpSeen: true,
        telemetryNoticeDismissed: true,
      });

      const reread = await fetch(`${baseUrl}/settings`);
      expect(await reread.json()).toMatchObject({
        helpSeen: true,
        telemetryNoticeDismissed: true,
      });
    });

    it("rejects a malformed patch body", async () => {
      start();
      const res = await fetch(`${baseUrl}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ telemetryOptIn: "yes" }),
      });
      expect(res.status).toBe(400);
    });
  });

  it("sanity: session endpoints still respond (covered in depth by session-manager.test.ts)", async () => {
    start();
    const res = await fetch(`${baseUrl}/sessions`, { headers: TOKEN_HEADER });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  describe("POST /sessions", () => {
    it("calls onSessionCreated with the new session's cwd and id", async () => {
      const onSessionCreated = vi.fn();
      const sessionManager = fakeSessionManager();
      (sessionManager.create as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "sess-1",
        cwd: "/tmp/proj",
        harness: "claude-code",
        status: "starting",
      });
      start({ sessionManager, onSessionCreated });

      const res = await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { ...TOKEN_HEADER, "content-type": "application/json" },
        body: JSON.stringify({ cwd: "/tmp/proj", harness: "claude-code" }),
      });

      expect(res.status).toBe(201);
      expect(onSessionCreated).toHaveBeenCalledWith("/tmp/proj", "sess-1");
    });

    it("does not call onSessionCreated when the request body is invalid", async () => {
      const onSessionCreated = vi.fn();
      start({ onSessionCreated });

      const res = await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { ...TOKEN_HEADER, "content-type": "application/json" },
        body: JSON.stringify({ cwd: "" }),
      });

      expect(res.status).toBe(400);
      expect(onSessionCreated).not.toHaveBeenCalled();
    });

    it("rejects role and project spoofing on generic session creation", async () => {
      const sessionManager = fakeSessionManager();
      start({ sessionManager });

      const res = await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { ...TOKEN_HEADER, "content-type": "application/json" },
        body: JSON.stringify({
          cwd: "/tmp/proj",
          harness: "codex",
          role: "map-planner",
          projectId: "forged-project",
        }),
      });

      expect(res.status).toBe(400);
      expect(sessionManager.create).not.toHaveBeenCalled();
    });

    it("does not itself write the workspace context file — that's sessionManager.create()'s job now", async () => {
      // The initial write used to happen here, in this route, which meant
      // any caller that reached the session-creation path without going
      // through this exact handler (autoCreateSession, notably) silently
      // skipped it. It now lives inside SessionManager.create() itself, so
      // this route just has to not duplicate it. See session-manager.test.ts
      // for the "create() writes the workspace context" coverage.
      const sessionManager = fakeSessionManager();
      (sessionManager.create as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "sess-1",
        cwd: "/tmp/proj",
        harness: "claude-code",
        status: "starting",
        boundWorkflowPath: null,
      });
      start({ sessionManager });

      const res = await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { ...TOKEN_HEADER, "content-type": "application/json" },
        body: JSON.stringify({ cwd: "/tmp/proj", harness: "claude-code" }),
      });

      expect(res.status).toBe(201);
      expect(writeWorkspaceContext).not.toHaveBeenCalled();
    });

    it("normalizes the cwd before create() sees it", async () => {
      // The SPA can't know the host separator; resolve() at the route makes a
      // duplicated-separator/traversal path canonical for every consumer
      // (pty cwd, sessions.json, startsWith containment). Mixed "\\"/"/" is the
      // Windows shape of this bug; the posix-expressible equivalent is pinned
      // here since tests run on POSIX CI (win32 case: cwd-normalize.test.ts).
      const sessionManager = fakeSessionManager();
      (sessionManager.create as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "sess-1",
        cwd: "/tmp/proj",
        harness: "claude-code",
        status: "starting",
      });
      start({ sessionManager });

      const res = await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { ...TOKEN_HEADER, "content-type": "application/json" },
        body: JSON.stringify({
          cwd: "/tmp//projects/../proj",
          harness: "claude-code",
        }),
      });

      expect(res.status).toBe(201);
      expect(sessionManager.create).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: "/tmp/proj" }),
      );
    });

    it("maps SpawnTargetError to a 400 carrying the actionable message", async () => {
      // "claude isn't on PATH" / "self-update broke the install" used to
      // surface as 500 {"error":"internal error"} — the one string telling the
      // user what to do was discarded. The dialog renders this body verbatim.
      const sessionManager = fakeSessionManager();
      (sessionManager.create as ReturnType<typeof vi.fn>).mockRejectedValue(
        new SpawnTargetError(
          'cannot spawn "claude" on Windows: not found on PATH',
        ),
      );
      start({ sessionManager });

      const res = await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { ...TOKEN_HEADER, "content-type": "application/json" },
        body: JSON.stringify({ cwd: "/tmp/proj", harness: "claude-code" }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; code: string };
      expect(body.code).toBe("SPAWN_TARGET");
      expect(body.error).toContain("not found on PATH");
    });

    it("maps ExternalHarnessError to a 409", async () => {
      const sessionManager = fakeSessionManager();
      (sessionManager.create as ReturnType<typeof vi.fn>).mockRejectedValue(
        new ExternalHarnessError("conductor", "Conductor"),
      );
      start({ sessionManager });

      const res = await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { ...TOKEN_HEADER, "content-type": "application/json" },
        body: JSON.stringify({ cwd: "/tmp/proj", harness: "claude-code" }),
      });

      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe(
        "HARNESS_EXTERNAL",
      );
    });

    it.each([
      {
        error: new ProjectSessionScopeUnavailableError("secret-session-id"),
        code: "PROJECT_SESSION_SCOPE_UNAVAILABLE",
        message: "the session's Studio project scope could not be revalidated",
      },
      {
        error: new SessionManagerClosingError(),
        code: "SESSION_MANAGER_CLOSING",
        message: "session manager is shutting down",
      },
    ])("maps $code to a bounded 409", async ({ error, code, message }) => {
      const sessionManager = fakeSessionManager();
      (sessionManager.create as ReturnType<typeof vi.fn>).mockRejectedValue(
        error,
      );
      start({ sessionManager });

      const res = await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { ...TOKEN_HEADER, "content-type": "application/json" },
        body: JSON.stringify({ cwd: "/tmp/proj", harness: "claude-code" }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body).toEqual({ code, error: message });
      expect(JSON.stringify(body)).not.toContain("secret-session-id");
    });
  });

  describe("POST /sessions/:id/attachments", () => {
    let projectRoot: string;
    let sessionManager: RestRouterOptions["sessionManager"];

    beforeEach(async () => {
      projectRoot = path.join(tmpHome, "project");
      await fs.mkdir(projectRoot, { recursive: true });
      projectRoot = await fs.realpath(projectRoot);
      sessionManager = fakeSessionManager([
        exitedSession({
          id: "sess-upload",
          cwd: projectRoot,
          status: "running",
          exitCode: null,
        }),
      ]);
      start({ sessionManager });
    });

    const postAttachment = (
      body: unknown,
      sessionId = "sess-upload",
    ): Promise<Response> =>
      fetch(`${baseUrl}/sessions/${sessionId}/attachments`, {
        method: "POST",
        headers: { ...TOKEN_HEADER, "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    it("materializes clipboard bytes under the session cwd without injecting input", async () => {
      const res = await postAttachment({
        filename: "screenshot.png",
        dataUrl: "data:image/png;base64,cGl4ZWxz",
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        path: string;
        mediaType: string;
        bytes: number;
      };
      expect(body.mediaType).toBe("image/png");
      expect(body.bytes).toBe(6);
      const relativePath = path.relative(projectRoot, body.path);
      const relativeParts = relativePath.split(path.sep);
      expect(relativeParts.slice(0, 2)).toEqual([".sapiom", "uploads"]);
      expect(relativeParts[2]).toMatch(/^[0-9a-f-]+\.png$/);
      await expect(fs.readFile(body.path, "utf8")).resolves.toBe("pixels");
      expect(sessionManager.submitInput).not.toHaveBeenCalled();
    });

    it("uses a server-owned filename for a traversal-shaped display name", async () => {
      const res = await postAttachment({
        filename: "../../outside/escape.pdf",
        dataUrl: "data:application/pdf;base64,UERG",
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { path: string };
      expect(path.dirname(body.path)).toBe(
        path.join(projectRoot, ".sapiom", "uploads"),
      );
      expect(path.basename(body.path)).toMatch(/^[0-9a-f-]+\.pdf$/);
      expect(path.basename(body.path)).not.toBe("escape.pdf");
    });

    it.each([
      ["image/png", "image.png"],
      ["application/pdf", "document.pdf"],
      ["text/plain", "notes.txt"],
      ["application/octet-stream", "data.bin"],
    ])("accepts %s clipboard data", async (mediaType, filename) => {
      const res = await postAttachment({
        filename,
        dataUrl: `data:${mediaType};base64,YQ==`,
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ mediaType, bytes: 1 });
    });

    it.each([
      [{ filename: "bad.bin", dataUrl: "not-a-data-url" }, 400],
      [{ filename: "bad.bin", dataUrl: "data:text/plain;base64,%%%" }, 400],
      [{ filename: "empty.bin", dataUrl: "data:text/plain;base64," }, 400],
      [{ dataUrl: "data:text/plain;base64,YQ==" }, 400],
    ])("rejects an invalid attachment request", async (body, status) => {
      const res = await postAttachment(body);
      expect(res.status).toBe(status);
    });

    it("rejects a decoded payload over 10 MiB", async () => {
      const encoded = Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64");
      const res = await postAttachment({
        filename: "too-large.bin",
        dataUrl: `data:application/octet-stream;base64,${encoded}`,
      });
      expect(res.status).toBe(413);
    });

    it("rejects an unknown session", async () => {
      const res = await postAttachment(
        { filename: "note.txt", dataUrl: "data:text/plain;base64,YQ==" },
        "missing",
      );
      expect(res.status).toBe(404);
    });

    it.skipIf(process.platform === "win32")(
      "rejects an uploads symlink that escapes the session cwd",
      async () => {
        const outside = path.join(tmpHome, "outside");
        await fs.mkdir(path.join(projectRoot, ".sapiom"), { recursive: true });
        await fs.mkdir(outside, { recursive: true });
        await fs.symlink(outside, path.join(projectRoot, ".sapiom", "uploads"));

        const res = await postAttachment({
          filename: "escape.txt",
          dataUrl: "data:text/plain;base64,YQ==",
        });

        expect(res.status).toBe(400);
        await expect(fs.readdir(outside)).resolves.toEqual([]);
      },
    );

    it("rate limits a runaway attachment client", async () => {
      for (let index = 0; index < 30; index += 1) {
        const res = await postAttachment({
          filename: `note-${index}.txt`,
          dataUrl: "data:text/plain;base64,YQ==",
        });
        expect(res.status).toBe(200);
      }
      const limited = await postAttachment({
        filename: "one-too-many.txt",
        dataUrl: "data:text/plain;base64,YQ==",
      });
      expect(limited.status).toBe(429);
    });
  });

  describe("POST /sessions/:id/input", () => {
    it("submits input and returns ok:true", async () => {
      const sessionManager = fakeSessionManager();
      start({ sessionManager });

      const res = await fetch(`${baseUrl}/sessions/sess-1/input`, {
        method: "POST",
        headers: { ...TOKEN_HEADER, "content-type": "application/json" },
        body: JSON.stringify({ text: "hello", submit: true }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(sessionManager.submitInput).toHaveBeenCalledWith(
        "sess-1",
        "hello",
        true,
      );
    });

    it("forwards submitted and editable input through the injected canonical authority exactly once", async () => {
      const submitSessionInput = vi.fn(
        async (
          _sessionId: string,
          _text: string,
          _submit: boolean,
          requestId?: string,
        ) =>
          requestId
            ? {
                ok: true as const,
                receipt: {
                  requestId,
                  inputId: "input-1",
                  status: "queued" as const,
                  acceptedAt: "2026-09-04T00:00:00.000Z",
                },
              }
            : true,
      );
      start({ submitSessionInput });

      const [submitted, editable] = await Promise.all([
        fetch(`${baseUrl}/sessions/bootstrap-owned/input`, {
          method: "POST",
          headers: { ...TOKEN_HEADER, "content-type": "application/json" },
          body: JSON.stringify({
            text: "build now",
            requestId: "request-build-now",
          }),
        }),
        fetch(`${baseUrl}/sessions/bootstrap-owned/input`, {
          method: "POST",
          headers: { ...TOKEN_HEADER, "content-type": "application/json" },
          body: JSON.stringify({ text: "draft", submit: false }),
        }),
      ]);

      expect(submitted.status).toBe(200);
      expect(editable.status).toBe(200);
      expect(await submitted.json()).toEqual({
        ok: true,
        receipt: {
          requestId: "request-build-now",
          inputId: "input-1",
          status: "queued",
          acceptedAt: "2026-09-04T00:00:00.000Z",
        },
      });
      expect(submitSessionInput).toHaveBeenCalledTimes(2);
      expect(submitSessionInput).toHaveBeenCalledWith(
        "bootstrap-owned",
        "build now",
        true,
        "request-build-now",
      );
      expect(submitSessionInput).toHaveBeenCalledWith(
        "bootstrap-owned",
        "draft",
        false,
        undefined,
      );
    });

    it("returns the durable request-id conflict from the canonical input authority", async () => {
      const conflict = Object.assign(
        new Error(
          "project bootstrap request id was reused with different input",
        ),
        { code: "project_bootstrap_request_id_reused" },
      );
      const submitSessionInput = vi.fn(async () => {
        throw conflict;
      });
      start({ submitSessionInput });

      const response = await fetch(
        `${baseUrl}/sessions/bootstrap-owned/input`,
        {
          method: "POST",
          headers: { ...TOKEN_HEADER, "content-type": "application/json" },
          body: JSON.stringify({
            text: "changed payload",
            requestId: "request-reused",
          }),
        },
      );

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: conflict.message,
        code: conflict.code,
      });
      expect(submitSessionInput).toHaveBeenCalledWith(
        "bootstrap-owned",
        "changed payload",
        true,
        "request-reused",
      );
    });

    it("returns bounded durable-input capacity from the canonical input authority", async () => {
      const capacity = Object.assign(
        new Error(
          "project bootstrap input receipt capacity is temporarily full",
        ),
        { code: "project_bootstrap_input_capacity" },
      );
      const submitSessionInput = vi.fn(async () => {
        throw capacity;
      });
      start({ submitSessionInput });

      const response = await fetch(
        `${baseUrl}/sessions/bootstrap-owned/input`,
        {
          method: "POST",
          headers: { ...TOKEN_HEADER, "content-type": "application/json" },
          body: JSON.stringify({
            text: "new logical request",
            requestId: "request-at-capacity",
          }),
        },
      );

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: capacity.message,
        code: capacity.code,
      });
      expect(submitSessionInput).toHaveBeenCalledWith(
        "bootstrap-owned",
        "new logical request",
        true,
        "request-at-capacity",
      );
    });

    it("400s a malformed body (missing text)", async () => {
      start();
      const res = await fetch(`${baseUrl}/sessions/sess-1/input`, {
        method: "POST",
        headers: { ...TOKEN_HEADER, "content-type": "application/json" },
        body: JSON.stringify({ submit: true }),
      });
      expect(res.status).toBe(400);
    });

    it("accepts ordinary input for a former planner session without a role-specific 409", async () => {
      const planner = exitedSession({
        id: "planner-1",
        agentMapIdentity: {
          projectId: "project-1",
          sessionId: "planner-1",
          userId: "user-1",
        },
        planning: {
          identity: {
            projectId: "project-1",
            sessionId: "planner-1",
            userId: "user-1",
            role: "map-planner",
          },
          greeting: { status: "pending" },
          queuedInputIds: [],
        },
      });
      const sessionManager = fakeSessionManager([planner]);
      start({ sessionManager });

      const res = await fetch(`${baseUrl}/sessions/planner-1/input`, {
        method: "POST",
        headers: { ...TOKEN_HEADER, "content-type": "application/json" },
        body: JSON.stringify({ text: "bypass" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(sessionManager.submitInput).toHaveBeenCalledWith(
        planner.id,
        "bypass",
        true,
      );
    });

    it("404s when submitInput reports no live pty for the session", async () => {
      const sessionManager = fakeSessionManager();
      (
        sessionManager.submitInput as ReturnType<typeof vi.fn>
      ).mockResolvedValue(false);
      start({ sessionManager });

      const res = await fetch(`${baseUrl}/sessions/sess-1/input`, {
        method: "POST",
        headers: { ...TOKEN_HEADER, "content-type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      });
      expect(res.status).toBe(404);
    });

    it("409s with a UI-visible reason when the session isn't ready yet (SessionNotReadyError) — never silently swallows the input", async () => {
      const sessionManager = fakeSessionManager();
      (
        sessionManager.submitInput as ReturnType<typeof vi.fn>
      ).mockRejectedValue(new SessionNotReadyError("sess-1"));
      start({ sessionManager });

      const res = await fetch(`${baseUrl}/sessions/sess-1/input`, {
        method: "POST",
        headers: { ...TOKEN_HEADER, "content-type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      });

      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/not ready yet/i);
      expect(body.error).toMatch(/trust the folder/i);
    });

    it("409s a concurrent staged submission without adding another dispatch", async () => {
      const submitSessionInput = vi.fn(async () => {
        throw new SessionBackgroundInputPreemptedError(false);
      });
      start({ submitSessionInput });

      const res = await fetch(`${baseUrl}/sessions/sess-1/input`, {
        method: "POST",
        headers: { ...TOKEN_HEADER, "content-type": "application/json" },
        body: JSON.stringify({ text: "overlapping input" }),
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        code: "SESSION_BACKGROUND_INPUT_PREEMPTED",
        error: "background session input was preempted by user input",
      });
      expect(submitSessionInput).toHaveBeenCalledOnce();
    });
  });

  describe("PATCH /sessions/:id/workflow", () => {
    const workflow: WorkflowInfo = {
      name: "leasing",
      path: "/tmp/leasing",
      definitionId: 1,
      definitionSlug: "leasing",
      source: "scan",
    };
    const baseSession: HarnessSession = {
      id: "sess-1",
      agentSessionId: null,
      harness: "claude-code",
      cwd: "/tmp/proj",
      title: "proj",
      status: "running",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastActiveAt: "2026-01-01T00:00:00.000Z",
      exitCode: null,
      boundWorkflowPath: null,
      ready: true,
    };

    it("binds a known workflow: validates it, updates the session, and writes the context file", async () => {
      const sessionManager = fakeSessionManager([baseSession]);
      start({
        sessionManager,
        findWorkflow: (p) => (p === workflow.path ? workflow : null),
      });

      const res = await fetch(
        `${baseUrl}/sessions/${baseSession.id}/workflow`,
        {
          method: "PATCH",
          headers: { ...TOKEN_HEADER, "content-type": "application/json" },
          body: JSON.stringify({ workflowPath: workflow.path }),
        },
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as HarnessSession;
      expect(body.boundWorkflowPath).toBe(workflow.path);
      expect(sessionManager.setBoundWorkflowPath).toHaveBeenCalledWith(
        baseSession.id,
        workflow.path,
      );
      // setBoundWorkflowPath() mutates the fake manager's session in place —
      // the route hands the whole (already-updated) session to the callee,
      // which resolves the bound workflow against the live registry itself.
      expect(writeWorkspaceContext).toHaveBeenCalledWith(
        expect.objectContaining({
          id: baseSession.id,
          cwd: "/tmp/proj",
          boundWorkflowPath: workflow.path,
        }),
      );
    });

    it("unbinds with workflowPath: null, writing boundWorkflow: null to the context file", async () => {
      const bound: HarnessSession = {
        ...baseSession,
        boundWorkflowPath: workflow.path,
      };
      const sessionManager = fakeSessionManager([bound]);
      start({
        sessionManager,
        findWorkflow: (p) => (p === workflow.path ? workflow : null),
      });

      const res = await fetch(`${baseUrl}/sessions/${bound.id}/workflow`, {
        method: "PATCH",
        headers: { ...TOKEN_HEADER, "content-type": "application/json" },
        body: JSON.stringify({ workflowPath: null }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as HarnessSession;
      expect(body.boundWorkflowPath).toBeNull();
      expect(writeWorkspaceContext).toHaveBeenCalledWith(
        expect.objectContaining({
          id: bound.id,
          cwd: "/tmp/proj",
          boundWorkflowPath: null,
        }),
      );
    });

    it("400s when workflowPath isn't a registered workflow", async () => {
      const sessionManager = fakeSessionManager([baseSession]);
      start({ sessionManager, findWorkflow: () => null });

      const res = await fetch(
        `${baseUrl}/sessions/${baseSession.id}/workflow`,
        {
          method: "PATCH",
          headers: { ...TOKEN_HEADER, "content-type": "application/json" },
          body: JSON.stringify({ workflowPath: "/not/registered" }),
        },
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error:
          "Unknown agent path '/not/registered' — scan or connect it before binding a session to it",
      });
      expect(sessionManager.setBoundWorkflowPath).not.toHaveBeenCalled();
      expect(writeWorkspaceContext).not.toHaveBeenCalled();
    });

    it("404s for an unknown session", async () => {
      start({ findWorkflow: () => workflow });
      const res = await fetch(`${baseUrl}/sessions/does-not-exist/workflow`, {
        method: "PATCH",
        headers: { ...TOKEN_HEADER, "content-type": "application/json" },
        body: JSON.stringify({ workflowPath: workflow.path }),
      });
      expect(res.status).toBe(404);
    });

    it("400s a malformed body (missing workflowPath)", async () => {
      const sessionManager = fakeSessionManager([baseSession]);
      start({ sessionManager });
      const res = await fetch(
        `${baseUrl}/sessions/${baseSession.id}/workflow`,
        {
          method: "PATCH",
          headers: { ...TOKEN_HEADER, "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      expect(res.status).toBe(400);
    });
  });

  describe("POST /sessions/:id/resume — error class → HTTP status mapping", () => {
    it("resumes a former planner through the ordinary endpoint without a role-specific 409", async () => {
      const planner = exitedSession({
        id: "planner-1",
        agentMapIdentity: {
          projectId: "project-1",
          sessionId: "planner-1",
          userId: "user-1",
        },
        planning: {
          identity: {
            projectId: "project-1",
            sessionId: "planner-1",
            userId: "user-1",
            role: "map-planner",
          },
          greeting: { status: "delivered", messageId: "message-1" },
          queuedInputIds: [],
        },
      });
      const sessionManager = fakeSessionManager([planner]);
      (sessionManager.resume as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...planner,
        status: "running",
      });
      start({ sessionManager });

      const res = await fetch(`${baseUrl}/sessions/planner-1/resume`, {
        method: "POST",
        headers: TOKEN_HEADER,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        id: planner.id,
        status: "running",
      });
      expect(sessionManager.resume).toHaveBeenCalledWith(planner.id);
    });

    it("404s when resume() throws UnknownSessionError (class-based dispatch, not string match)", async () => {
      const sessionManager = fakeSessionManager();
      (sessionManager.resume as ReturnType<typeof vi.fn>).mockRejectedValue(
        new UnknownSessionError("does-not-exist"),
      );
      start({ sessionManager });

      const res = await fetch(`${baseUrl}/sessions/does-not-exist/resume`, {
        method: "POST",
        headers: TOKEN_HEADER,
      });
      expect(res.status).toBe(404);
    });

    it("404s even when UnknownSessionError carries a reworded message — proves class dispatch, not string-match", async () => {
      // This is the point of the port: the old code did
      //   err.message.startsWith("Unknown session")
      // so any rewording would silently fall to a 500. Now that the route
      // checks instanceof, the message can say anything.
      const sessionManager = fakeSessionManager();
      const err = new UnknownSessionError("xyz");
      Object.defineProperty(err, "message", {
        value: "session xyz could not be located",
      });
      (sessionManager.resume as ReturnType<typeof vi.fn>).mockRejectedValue(
        err,
      );
      start({ sessionManager });

      const res = await fetch(`${baseUrl}/sessions/xyz/resume`, {
        method: "POST",
        headers: TOKEN_HEADER,
      });
      // Old string-match would give 500 here; class dispatch gives 404.
      expect(res.status).toBe(404);
    });

    it("409s when resume() throws SessionAlreadyLiveError (double-resume guard)", async () => {
      const sessionManager = fakeSessionManager();
      (sessionManager.resume as ReturnType<typeof vi.fn>).mockRejectedValue(
        new SessionAlreadyLiveError("sess-live"),
      );
      start({ sessionManager });

      const res = await fetch(`${baseUrl}/sessions/sess-live/resume`, {
        method: "POST",
        headers: TOKEN_HEADER,
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; code: string };
      expect(body.code).toBe("SESSION_ALREADY_LIVE");
    });

    it("409s when resume() throws SessionNotResumeableError (no agentSessionId to resume from)", async () => {
      const sessionManager = fakeSessionManager();
      (sessionManager.resume as ReturnType<typeof vi.fn>).mockRejectedValue(
        new SessionNotResumeableError("sess-no-agent"),
      );
      start({ sessionManager });

      const res = await fetch(`${baseUrl}/sessions/sess-no-agent/resume`, {
        method: "POST",
        headers: TOKEN_HEADER,
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; code: string };
      expect(body.code).toBe("SESSION_NOT_RESUMEABLE");
    });

    it("409s with a bounded code when project scope cannot be revalidated", async () => {
      const sessionManager = fakeSessionManager();
      (sessionManager.resume as ReturnType<typeof vi.fn>).mockRejectedValue(
        new ProjectSessionScopeUnavailableError("private-session-id"),
      );
      start({ sessionManager });

      const res = await fetch(`${baseUrl}/sessions/private-session-id/resume`, {
        method: "POST",
        headers: TOKEN_HEADER,
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: "the session's Studio project scope could not be revalidated",
        code: "PROJECT_SESSION_SCOPE_UNAVAILABLE",
      });
    });

    it("400s when resume() throws AdapterNotFoundError (persisted session with unknown harness kind — C2)", async () => {
      // Simulates a sessions.json entry with harness: "future-harness" that
      // has no registered adapter — should be a 400 not a 500.
      const sessionManager = fakeSessionManager();
      (sessionManager.resume as ReturnType<typeof vi.fn>).mockRejectedValue(
        new AdapterNotFoundError("future-harness"),
      );
      start({ sessionManager });

      const res = await fetch(`${baseUrl}/sessions/sess-unknown-kind/resume`, {
        method: "POST",
        headers: TOKEN_HEADER,
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; code: string };
      expect(body.code).toBe("ADAPTER_NOT_FOUND");
    });
  });

  describe("GET /sessions/history — server-verified resumeMode", () => {
    async function history(cwd: string): Promise<SessionSummary[]> {
      const res = await fetch(
        `${baseUrl}/sessions/history?cwd=${encodeURIComponent(cwd)}`,
        {
          headers: TOKEN_HEADER,
        },
      );
      expect(res.status).toBe(200);
      return (await res.json()) as SessionSummary[];
    }

    it("marks a registry row the agent still holds as agent-resume", async () => {
      start({
        sessionManager: fakeSessionManager([exitedSession()]),
        adapters: {
          "claude-code": historyAdapter({ canResume: async () => true }),
        },
      });

      const rows = await history("/tmp/proj");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        agentSessionId: "agent-1",
        source: "registry",
        resumeMode: "agent-resume",
      });
    });

    it("marks a PHANTOM registry row as rehydrate — an agentSessionId is not evidence of a conversation", async () => {
      // The bug this endpoint change exists for: the client used to render
      // `agentSessionId != null` as "resumable", so this row offered a Resume
      // button whose only possible outcome was exit 1.
      start({
        sessionManager: fakeSessionManager([exitedSession()]),
        adapters: {
          "claude-code": historyAdapter({ canResume: async () => false }),
        },
      });

      const rows = await history("/tmp/proj");
      expect(rows[0]).toMatchObject({
        source: "registry",
        resumeMode: "rehydrate",
      });
    });

    it("probes with the row's own agentSessionId and cwd", async () => {
      const canResume = vi.fn(async () => true);
      start({
        sessionManager: fakeSessionManager([exitedSession()]),
        adapters: { "claude-code": historyAdapter({ canResume }) },
      });

      await history("/tmp/proj");
      expect(canResume).toHaveBeenCalledWith("agent-1", "/tmp/proj");
    });

    it("marks a transcript-only row as agent-resume — the adapter reading it out of the agent's store IS the proof", async () => {
      // Previously hardcoded un-resumable on the client, which hid genuinely
      // recoverable conversations behind a "New session here" button.
      start({
        adapters: {
          "claude-code": historyAdapter({
            listPastSessions: async () => [
              {
                agentSessionId: "agent-transcript",
                harness: "claude-code",
                cwd: "/tmp/proj",
                title: "Wire the webhook",
                lastActiveAt: "2026-01-01T00:00:00.000Z",
                source: "transcript",
              },
            ],
          }),
        },
      });

      const rows = await history("/tmp/proj");
      expect(rows[0]).toMatchObject({
        source: "transcript",
        resumeMode: "agent-resume",
      });
    });

    it("resolves each row independently — a phantom and a live transcript in one directory", async () => {
      start({
        sessionManager: fakeSessionManager([
          exitedSession({
            id: "sess-phantom",
            agentSessionId: "agent-phantom",
          }),
        ]),
        adapters: {
          "claude-code": historyAdapter({
            canResume: async (id) => id !== "agent-phantom",
            listPastSessions: async () => [
              {
                agentSessionId: "agent-real",
                harness: "claude-code",
                cwd: "/tmp/proj",
                title: "real conversation",
                lastActiveAt: "2026-01-02T00:00:00.000Z",
                source: "transcript",
              },
            ],
          }),
        },
      });

      const byId = new Map(
        (await history("/tmp/proj")).map((row) => [
          row.agentSessionId,
          row.resumeMode,
        ]),
      );
      expect(byId.get("agent-phantom")).toBe("rehydrate");
      expect(byId.get("agent-real")).toBe("agent-resume");
    });

    it("settles a registry row from the single history scan, without a second probe", async () => {
      // Cost guard: codex's canResume walks the whole ~/.codex/sessions tree
      // and reads every rollout head. Probing per registry row would turn one
      // walk into one walk per row, on a user-blocking dropdown open. A row the
      // scan already found needs no probe — finding it IS the verification.
      const canResume = vi.fn(async () => true);
      const listPastSessions = vi.fn(async () => [
        {
          agentSessionId: "agent-1",
          harness: "claude-code" as HarnessKind,
          cwd: "/tmp/proj",
          title: "found by the scan",
          lastActiveAt: "2026-01-01T00:00:00.000Z",
          source: "transcript" as const,
        },
      ]);
      start({
        sessionManager: fakeSessionManager([exitedSession()]),
        adapters: {
          "claude-code": historyAdapter({ canResume, listPastSessions }),
        },
      });

      const rows = await history("/tmp/proj");
      expect(rows).toHaveLength(1);
      // Registry row wins the merge (it carries live status) and is resumable.
      expect(rows[0]).toMatchObject({
        source: "registry",
        resumeMode: "agent-resume",
      });
      expect(listPastSessions).toHaveBeenCalledTimes(1);
      expect(canResume).not.toHaveBeenCalled();
    });

    it("probes only the rows the scan missed", async () => {
      const canResume = vi.fn(async () => false);
      start({
        sessionManager: fakeSessionManager([
          exitedSession({ id: "sess-found", agentSessionId: "agent-found" }),
          exitedSession({ id: "sess-missed", agentSessionId: "agent-missed" }),
        ]),
        adapters: {
          "claude-code": historyAdapter({
            canResume,
            listPastSessions: async () => [
              {
                agentSessionId: "agent-found",
                harness: "claude-code",
                cwd: "/tmp/proj",
                title: "found",
                lastActiveAt: "2026-01-01T00:00:00.000Z",
                source: "transcript",
              },
            ],
          }),
        },
      });

      const byId = new Map(
        (await history("/tmp/proj")).map((r) => [
          r.agentSessionId,
          r.resumeMode,
        ]),
      );
      expect(byId.get("agent-found")).toBe("agent-resume");
      expect(byId.get("agent-missed")).toBe("rehydrate");
      expect(canResume.mock.calls).toEqual([["agent-missed", "/tmp/proj"]]);
    });

    it("reports rehydrate rather than failing when the harness has no registered adapter to ask", async () => {
      // e.g. an external-mode harness, or a kind persisted by another build:
      // unverifiable is not the same as resumable.
      start({
        sessionManager: fakeSessionManager([
          exitedSession({ harness: "conductor" as HarnessKind }),
        ]),
        adapters: {},
      });

      const rows = await history("/tmp/proj");
      expect(rows[0]).toMatchObject({ resumeMode: "rehydrate" });
    });

    it("survives an adapter whose canResume throws, despite the never-throws contract", async () => {
      start({
        sessionManager: fakeSessionManager([exitedSession()]),
        adapters: {
          "claude-code": historyAdapter({
            canResume: async () => {
              throw new Error("EACCES");
            },
          }),
        },
      });

      const rows = await history("/tmp/proj");
      expect(rows[0]).toMatchObject({ resumeMode: "rehydrate" });
    });
  });

  describe("POST /sessions/adopt", () => {
    const body = {
      agentSessionId: "agent-transcript",
      harness: "claude-code" as HarnessKind,
      cwd: "/tmp/proj",
      title: "Wire the webhook",
      lastActiveAt: "2026-01-01T00:00:00.000Z",
    };

    async function adopt(payload: unknown) {
      return fetch(`${baseUrl}/sessions/adopt`, {
        method: "POST",
        headers: { ...TOKEN_HEADER, "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    }

    it("registers a transcript-only row and resumes it for real", async () => {
      const sessionManager = fakeSessionManager();
      (sessionManager.resume as ReturnType<typeof vi.fn>).mockImplementation(
        async (id: string) => ({
          ...exitedSession({ id, agentSessionId: body.agentSessionId }),
          status: "running",
        }),
      );
      start({
        sessionManager,
        adapters: {
          "claude-code": historyAdapter({ canResume: async () => true }),
        },
      });

      const res = await adopt(body);
      expect(res.status).toBe(200);
      expect((await res.json()) as HarnessSession).toMatchObject({
        status: "running",
      });
      expect(sessionManager.registerHistorical).toHaveBeenCalledWith(body);
      // The whole point: a real resume, not a fresh session.
      expect(sessionManager.resume).toHaveBeenCalledWith(
        "adopted-agent-transcript",
      );
    });

    it("409s SESSION_NOT_RESUMEABLE without registering anything when the agent no longer holds it", async () => {
      const sessionManager = fakeSessionManager();
      start({
        sessionManager,
        adapters: {
          "claude-code": historyAdapter({ canResume: async () => false }),
        },
      });

      const res = await adopt(body);
      expect(res.status).toBe(409);
      expect((await res.json()) as { code: string }).toMatchObject({
        code: "SESSION_NOT_RESUMEABLE",
      });
      // No phantom record left behind by a stale history row.
      expect(sessionManager.registerHistorical).not.toHaveBeenCalled();
      expect(sessionManager.resume).not.toHaveBeenCalled();
    });

    it("re-verifies server-side — a client claiming resumability cannot force a registration", async () => {
      const sessionManager = fakeSessionManager();
      const canResume = vi.fn(async () => false);
      start({
        sessionManager,
        adapters: { "claude-code": historyAdapter({ canResume }) },
      });

      expect(
        (await adopt({ ...body, resumeMode: "agent-resume" })).status,
      ).toBe(409);
      expect(canResume).toHaveBeenCalledWith(body.agentSessionId, body.cwd);
    });

    it("is idempotent: an already-tracked row resumes its existing record instead of duplicating it", async () => {
      const existing = exitedSession({
        id: "sess-existing",
        agentSessionId: body.agentSessionId,
      });
      const sessionManager = fakeSessionManager([existing]);
      (sessionManager.resume as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...existing,
        status: "running",
      });
      start({
        sessionManager,
        adapters: {
          "claude-code": historyAdapter({ canResume: async () => true }),
        },
      });

      expect((await adopt(body)).status).toBe(200);
      expect(sessionManager.registerHistorical).not.toHaveBeenCalled();
      expect(sessionManager.resume).toHaveBeenCalledWith("sess-existing");
    });

    it("bounds a scope-revalidation failure on the ordinary adopt path", async () => {
      const existing = exitedSession({
        id: "sess-existing",
        agentSessionId: body.agentSessionId,
      });
      const sessionManager = fakeSessionManager([existing]);
      (sessionManager.resume as ReturnType<typeof vi.fn>).mockRejectedValue(
        new ProjectSessionScopeUnavailableError(existing.id),
      );
      start({
        sessionManager,
        adapters: {
          "claude-code": historyAdapter({ canResume: async () => true }),
        },
      });

      const res = await adopt(body);

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: "the session's Studio project scope could not be revalidated",
        code: "PROJECT_SESSION_SCOPE_UNAVAILABLE",
      });
      expect(sessionManager.registerHistorical).not.toHaveBeenCalled();
      expect(sessionManager.resume).toHaveBeenCalledWith(existing.id);
    });

    it("reuses a former planner owner through ordinary adopt without duplicating its record", async () => {
      const planner = exitedSession({
        id: "planner-existing",
        agentSessionId: body.agentSessionId,
        agentMapIdentity: {
          projectId: "foreign-project",
          sessionId: "planner-existing",
          userId: "foreign-user",
        },
        planning: {
          identity: {
            projectId: "foreign-project",
            sessionId: "planner-existing",
            userId: "foreign-user",
            role: "map-planner",
          },
          greeting: { status: "delivered", messageId: "message-1" },
          queuedInputIds: [],
        },
      });
      const original = structuredClone(planner.planning);
      const sessionManager = fakeSessionManager([planner]);
      (sessionManager.resume as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...planner,
        status: "running",
      });
      const canResume = vi.fn(async () => true);
      start({
        sessionManager,
        adapters: {
          "claude-code": historyAdapter({ canResume }),
        },
      });

      const res = await adopt(body);

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        id: planner.id,
        status: "running",
      });
      expect(canResume).toHaveBeenCalledWith(body.agentSessionId, body.cwd);
      expect(sessionManager.registerHistorical).not.toHaveBeenCalled();
      expect(sessionManager.resume).toHaveBeenCalledWith(planner.id);
      expect(sessionManager.get("planner-existing")?.planning).toEqual(
        original,
      );
    });

    it("rejects a durable rotated provider alias independently of its former role", async () => {
      const planner = exitedSession({
        id: "planner-rotated",
        agentSessionId: "vendor-new",
        planning: {
          identity: {
            projectId: "project-1",
            sessionId: "planner-rotated",
            userId: "user-1",
            role: "map-planner",
          },
          greeting: { status: "delivered", messageId: "message-1" },
          queuedInputIds: [],
        },
      });
      const sessionManager = fakeSessionManager([planner]);
      (
        sessionManager.getAgentSessionOwner as unknown as ReturnType<
          typeof vi.fn
        >
      ).mockImplementation((agentSessionId: string) =>
        agentSessionId === body.agentSessionId ? planner : undefined,
      );
      (
        sessionManager.isAgentSessionIdentityReserved as unknown as ReturnType<
          typeof vi.fn
        >
      ).mockReturnValue(true);
      const canResume = vi.fn(async () => true);
      start({
        sessionManager,
        adapters: { "claude-code": historyAdapter({ canResume }) },
      });

      const response = await adopt(body);

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "AGENT_SESSION_IDENTITY_RESERVED",
      });
      expect(canResume).not.toHaveBeenCalled();
      expect(sessionManager.registerHistorical).not.toHaveBeenCalled();
      expect(sessionManager.resume).not.toHaveBeenCalled();
    });

    it("409s a generic session's historical alias before any adapter probe or mutation", async () => {
      const owner = exitedSession({
        id: "generic-rotated",
        agentSessionId: "vendor-after-clear",
      });
      const original = structuredClone(owner);
      const sessionManager = fakeSessionManager([owner]);
      (
        sessionManager.getAgentSessionOwner as unknown as ReturnType<
          typeof vi.fn
        >
      ).mockImplementation((agentSessionId: string) =>
        agentSessionId === body.agentSessionId ? owner : undefined,
      );
      (
        sessionManager.isAgentSessionIdentityReserved as unknown as ReturnType<
          typeof vi.fn
        >
      ).mockImplementation(
        (agentSessionId: string) => agentSessionId === body.agentSessionId,
      );
      const canResume = vi.fn(async () => true);
      start({
        sessionManager,
        adapters: { "claude-code": historyAdapter({ canResume }) },
      });

      const response = await adopt(body);

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        code: "AGENT_SESSION_IDENTITY_RESERVED",
        error: "This conversation identity is already owned by a local session",
      });
      expect(canResume).not.toHaveBeenCalled();
      expect(sessionManager.registerHistorical).not.toHaveBeenCalled();
      expect(sessionManager.resume).not.toHaveBeenCalled();
      expect(sessionManager.list()).toEqual([original]);
    });

    it("400s on a malformed body and an unspawnable harness", async () => {
      start({ adapters: { "claude-code": historyAdapter() } });
      expect((await adopt({ ...body, agentSessionId: "" })).status).toBe(400);
      expect((await adopt({ ...body, harness: "conductor" })).status).toBe(400);
      expect((await adopt({ cwd: "/tmp/proj" })).status).toBe(400);
    });

    it("is handled as its own route — 'adopt' is never read as a session id", async () => {
      // Today this is structural: `/sessions/adopt` is two path segments and
      // `/sessions/:id/resume` is three, so they cannot collide and no
      // `POST /sessions/:id` exists to catch it. This pins that, so adding
      // such a route later can't silently reroute adopt through resume().
      const sessionManager = fakeSessionManager();
      start({
        sessionManager,
        adapters: {
          "claude-code": historyAdapter({ canResume: async () => false }),
        },
      });

      const res = await adopt(body);
      expect(res.status).toBe(409);
      expect(sessionManager.resume).not.toHaveBeenCalled();
    });

    it("maps a resume failure after registration onto the same status the :id route uses", async () => {
      const sessionManager = fakeSessionManager();
      (sessionManager.resume as ReturnType<typeof vi.fn>).mockRejectedValue(
        new SessionAlreadyLiveError("adopted-agent-transcript"),
      );
      start({
        sessionManager,
        adapters: {
          "claude-code": historyAdapter({ canResume: async () => true }),
        },
      });

      const res = await adopt(body);
      expect(res.status).toBe(409);
      expect((await res.json()) as { code: string }).toMatchObject({
        code: "SESSION_ALREADY_LIVE",
      });
    });
  });

  describe("GET /harnesses", () => {
    it("returns a list of adapter descriptors with id, label, mode, experimental, installed, and installMcpPrompt", async () => {
      start();
      const res = await fetch(`${baseUrl}/harnesses`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{
        id: string;
        label: string;
        mode: string;
        experimental: boolean;
        installed: boolean;
        installMcpPrompt: string;
      }>;
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(5); // claude-code, codex, pi, opencode, conductor

      // All entries have the required shape.
      for (const entry of body) {
        expect(typeof entry.id).toBe("string");
        expect(typeof entry.label).toBe("string");
        expect(["embedded", "external"]).toContain(entry.mode);
        expect(typeof entry.experimental).toBe("boolean");
        expect(typeof entry.installed).toBe("boolean");
        // installMcpPrompt must be a non-empty string — it's the copy that
        // the MCP setup UI renders in the Install MCP modal.
        expect(typeof entry.installMcpPrompt).toBe("string");
        expect(entry.installMcpPrompt.length).toBeGreaterThan(0);
      }
    });

    it("includes both embedded and external adapters", async () => {
      start();
      const res = await fetch(`${baseUrl}/harnesses`);
      const body = (await res.json()) as Array<{ id: string; mode: string }>;

      const embeddedIds = body
        .filter((a) => a.mode === "embedded")
        .map((a) => a.id);
      const externalIds = body
        .filter((a) => a.mode === "external")
        .map((a) => a.id);

      expect(embeddedIds).toContain("claude-code");
      expect(embeddedIds).toContain("codex");
      expect(externalIds).toContain("conductor");
    });

    it("conductor appears as mode:external", async () => {
      start();
      const res = await fetch(`${baseUrl}/harnesses`);
      const body = (await res.json()) as Array<{ id: string; mode: string }>;
      const conductor = body.find((a) => a.id === "conductor");
      expect(conductor).toBeDefined();
      expect(conductor!.mode).toBe("external");
    });

    it("claude-code appears as mode:embedded and not experimental", async () => {
      start();
      const res = await fetch(`${baseUrl}/harnesses`);
      const body = (await res.json()) as Array<{
        id: string;
        mode: string;
        experimental: boolean;
      }>;
      const claudeCode = body.find((a) => a.id === "claude-code");
      expect(claudeCode).toBeDefined();
      expect(claudeCode!.mode).toBe("embedded");
      expect(claudeCode!.experimental).toBe(false);
    });
  });

  describe("ExternalHarnessError → 409 mapping (real-path, no mocks)", () => {
    /**
     * These tests use a real SessionManager (only claude-code adapter registered)
     * with a session persisted at harness="conductor". Calling resume() or
     * submitInput() on that session exercises the real getAdapter() / submitInput()
     * code path that throws ExternalHarnessError — no mock-throw involved.
     */
    let smDir: string;
    const liveManagers: SessionManager[] = [];

    beforeEach(async () => {
      smDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "harness-rest-ext-test-"),
      );
    });

    afterEach(async () => {
      // Settle every manager's queued sessions.json write before removing the
      // dir — a write landing mid-rm walk races into ENOTEMPTY on slower CI.
      await Promise.all(liveManagers.map((m) => m.flush().catch(() => {})));
      liveManagers.length = 0;
      try {
        await fs.rm(smDir, { recursive: true, force: true });
      } catch {
        // One straggler retry: any writer that lost the flush race is done now.
        await new Promise((r) => setTimeout(r, 150));
        await fs.rm(smDir, { recursive: true, force: true });
      }
    });

    function makeMinimalAdapter(): HarnessAdapter {
      return {
        id: "claude-code",
        eventSource: "hooks" as const,
        doctor: async () => [],
        launch: (opts): SpawnSpec => ({
          command: "fake-claude",
          args: [],
          env: {},
          cwd: opts.cwd,
        }),
        resume: (agentSessionId, opts): SpawnSpec => ({
          command: "fake-claude",
          args: ["--resume", agentSessionId],
          env: {},
          cwd: opts.cwd,
        }),
        listPastSessions: async () => [],
        canResume: async () => true,
      };
    }

    function makeRealSessionManager(): SessionManager {
      const manager = new SessionManager({
        adapters: { "claude-code": makeMinimalAdapter() },
        ingestUrl: "http://127.0.0.1:4100",
        ingestCredentials: new IngestCredentialRegistry(() => "test-token"),
        sessionsPath: path.join(smDir, "sessions.json"),
        // spawnPty not provided — tests only call resume/submitInput which
        // throw before reaching spawn for external-harness sessions.
      });
      liveManagers.push(manager);
      return manager;
    }

    it("POST /sessions/:id/resume returns 409 HARNESS_EXTERNAL for a session persisted with harness='conductor'", async () => {
      const sessionManager = makeRealSessionManager();

      // Simulate a session record written by an earlier build or hand-edited.
      const session = await sessionManager.registerHistorical({
        agentSessionId: "agent-abc",
        harness: "conductor" as HarnessKind,
        cwd: "/tmp/conductor-proj",
        title: "conductor-proj",
        lastActiveAt: new Date().toISOString(),
      });

      start({
        sessionManager:
          sessionManager as unknown as RestRouterOptions["sessionManager"],
      });

      const res = await fetch(`${baseUrl}/sessions/${session.id}/resume`, {
        method: "POST",
        headers: TOKEN_HEADER,
      });

      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; code: string };
      expect(body.code).toBe("HARNESS_EXTERNAL");
      expect(body.error).toMatch(/Conductor/);
    });

    it("POST /sessions/:id/input returns 409 HARNESS_EXTERNAL for a session persisted with harness='conductor'", async () => {
      const sessionManager = makeRealSessionManager();

      const session = await sessionManager.registerHistorical({
        agentSessionId: "agent-def",
        harness: "conductor" as HarnessKind,
        cwd: "/tmp/conductor-proj",
        title: "conductor-proj",
        lastActiveAt: new Date().toISOString(),
      });

      start({
        sessionManager:
          sessionManager as unknown as RestRouterOptions["sessionManager"],
      });

      const res = await fetch(`${baseUrl}/sessions/${session.id}/input`, {
        method: "POST",
        headers: { ...TOKEN_HEADER, "content-type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      });

      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; code: string };
      expect(body.code).toBe("HARNESS_EXTERNAL");
      expect(body.error).toMatch(/Conductor/);
    });
  });

  describe("session records", () => {
    const record: SessionRecord = {
      harnessSessionId: "sess-1",
      mergedSessionIds: ["sess-1"],
      agentSessionId: "agent-1",
      harness: "claude-code",
      cwd: "/repo",
      startedAt: "2026-07-01T10:00:00.000Z",
      endedAt: null,
      turns: [
        {
          index: 1,
          prompt: "go",
          promptAt: "2026-07-01T10:00:00.000Z",
          toolCalls: [],
          assistantText: "done",
          model: "claude-opus-4-6",
          usage: { inputTokens: 10, outputTokens: 2 },
          completedAt: "2026-07-01T10:00:01.000Z",
          incomplete: false,
        },
      ],
      turnCount: 1,
      eventCount: 3,
      reconstructed: true,
      archivedAt: null,
      limitations: [],
    };

    function stubRecords(
      overrides: Partial<SessionRecordReader> = {},
    ): SessionRecordReader {
      const find = async (id: string): Promise<SessionRecord | null> =>
        id === "sess-1" || id === "agent-1" ? record : null;
      return {
        read: find,
        readFromEvents: find,
        turnCounts: async () => new Map([["agent-1", 7]]),
        conversationIds: async () => ["sess-1"],
        ...overrides,
      };
    }

    it("GET /sessions/:id/record returns the reconstructed record", async () => {
      start({ sessionRecords: stubRecords() });
      const res = await fetch(`${baseUrl}/sessions/sess-1/record`, {
        headers: TOKEN_HEADER,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(record);
    });

    it("GET /sessions/:id/record resolves an agent session id too", async () => {
      start({ sessionRecords: stubRecords() });
      const res = await fetch(`${baseUrl}/sessions/agent-1/record`, {
        headers: TOKEN_HEADER,
      });
      expect(res.status).toBe(200);
    });

    it("GET /sessions/:id/record is 404 when nothing was recorded for the session", async () => {
      start({ sessionRecords: stubRecords() });
      const res = await fetch(`${baseUrl}/sessions/unknown/record`, {
        headers: TOKEN_HEADER,
      });
      expect(res.status).toBe(404);
    });

    it("GET /sessions/:id/record is 501 when the server has no record reader", async () => {
      start();
      const res = await fetch(`${baseUrl}/sessions/sess-1/record`, {
        headers: TOKEN_HEADER,
      });
      expect(res.status).toBe(501);
    });

    it("GET /sessions/history stamps turnCount from the index", async () => {
      const session: HarnessSession = {
        id: "sess-1",
        agentSessionId: "agent-1",
        boundWorkflowPath: null,
        harness: "claude-code",
        cwd: "/repo",
        title: "repo",
        status: "exited",
        createdAt: "2026-07-01T10:00:00.000Z",
        lastActiveAt: "2026-07-01T10:00:05.000Z",
        ready: false,
      };
      start({
        sessionManager: fakeSessionManager([session]),
        sessionRecords: stubRecords(),
      });

      const res = await fetch(
        `${baseUrl}/sessions/history?cwd=${encodeURIComponent("/repo")}`,
        {
          headers: TOKEN_HEADER,
        },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as SessionSummary[];
      expect(body).toHaveLength(1);
      expect(body[0].turnCount).toBe(7);
    });

    it("GET /sessions/history still answers when the record reader fails", async () => {
      const session: HarnessSession = {
        id: "sess-1",
        agentSessionId: "agent-1",
        boundWorkflowPath: null,
        harness: "claude-code",
        cwd: "/repo",
        title: "repo",
        status: "exited",
        createdAt: "2026-07-01T10:00:00.000Z",
        lastActiveAt: "2026-07-01T10:00:05.000Z",
        ready: false,
      };
      start({
        sessionManager: fakeSessionManager([session]),
        sessionRecords: stubRecords({
          turnCounts: async () => {
            throw new Error("events.ndjson unreadable");
          },
        }),
      });

      const res = await fetch(
        `${baseUrl}/sessions/history?cwd=${encodeURIComponent("/repo")}`,
        {
          headers: TOKEN_HEADER,
        },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as SessionSummary[];
      expect(body).toHaveLength(1);
      expect(body[0].turnCount).toBeUndefined();
    });
  });
});
