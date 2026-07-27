import type { AddressInfo } from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBootTokenMiddleware } from "./auth.js";

let tmpHome: string;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return { ...actual, homedir: () => tmpHome };
});

import type { HarnessAdapter, HarnessKind, HarnessSession, MacroDef, SessionSummary, SpawnSpec, WorkflowInfo } from "../shared/types.js";
import { MAX_IMAGE_UPLOAD_BYTES } from "../shared/types.js";
import { SessionManager, SessionNotReadyError, UnknownSessionError } from "../core/session-manager.js";
import { AdapterNotFoundError, SessionAlreadyLiveError, SessionNotResumeableError } from "../core/errors.js";
import { createRestRouter, type RestRouterOptions } from "./rest.js";

const TOKEN_HEADER = { "X-Harness-Token": "unused-in-router-tests" };

function fakeSessionManager(initial: HarnessSession[] = []) {
  const sessions = new Map(initial.map((s) => [s.id, s]));
  return {
    list: () => Array.from(sessions.values()),
    get: (id: string) => sessions.get(id),
    create: vi.fn(),
    resume: vi.fn(),
    kill: vi.fn(() => true),
    write: vi.fn(() => true),
    submitInput: vi.fn(async () => true),
    setBoundWorkflowPath: vi.fn((id: string, workflowPath: string | null) => {
      const session = sessions.get(id);
      if (session) session.boundWorkflowPath = workflowPath;
    }),
    registerHistorical: vi.fn((input: { agentSessionId: string; harness: HarnessKind; cwd: string; title: string; lastActiveAt: string }) => {
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
    }),
  } as unknown as RestRouterOptions["sessionManager"];
}

/** An exited registry session — the shape a past-sessions row is built from. */
function exitedSession(overrides: Partial<HarnessSession> = {}): HarnessSession {
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
function historyAdapter(opts: {
  canResume?: HarnessAdapter["canResume"];
  listPastSessions?: HarnessAdapter["listPastSessions"];
} = {}): HarnessAdapter {
  return {
    id: "claude-code",
    eventSource: "hooks" as const,
    doctor: async () => [],
    launch: (o): SpawnSpec => ({ command: "fake-claude", args: [], env: {}, cwd: o.cwd }),
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
        organizationName: null,
        telemetryOptIn: false,
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
        identity: { userId: "user-1", organizationName: "Acme" },
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
      expect(await res.json()).toEqual({
        telemetryOptIn: false,
        recentDirs: [],
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
      });

      const reread = await fetch(`${baseUrl}/settings`);
      expect(await reread.json()).toEqual({
        telemetryOptIn: true,
        recentDirs: [],
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

    it("400s a malformed body (missing text)", async () => {
      start();
      const res = await fetch(`${baseUrl}/sessions/sess-1/input`, {
        method: "POST",
        headers: { ...TOKEN_HEADER, "content-type": "application/json" },
        body: JSON.stringify({ submit: true }),
      });
      expect(res.status).toBe(400);
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
  });

  describe("POST /sessions/:id/image", () => {
    // 1×1 transparent PNG.
    const PNG_BASE64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`;

    function seededSession(cwd: string, harness: HarnessKind = "claude-code"): HarnessSession {
      return {
        id: "sess-img",
        agentSessionId: null,
        harness,
        cwd,
        title: "img",
        status: "running",
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        boundWorkflowPath: null,
        ready: true,
      };
    }

    it("writes the image under the session cwd and relays its path into the pty", async () => {
      const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "harness-img-"));
      const sessionManager = fakeSessionManager([seededSession(cwd)]);
      start({ sessionManager });

      const res = await fetch(`${baseUrl}/sessions/sess-img/image`, {
        method: "POST",
        headers: { ...TOKEN_HEADER, "content-type": "application/json" },
        body: JSON.stringify({ dataUrl: PNG_DATA_URL, filename: "shot.png" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { path: string; mediaType: string; bytes: number };
      expect(body.mediaType).toBe("image/png");
      expect(body.bytes).toBeGreaterThan(0);
      expect(body.path.startsWith(path.join(cwd, ".sapiom", "uploads"))).toBe(true);
      expect(body.path.endsWith(".png")).toBe(true);
      // The file really exists and the path (with a trailing space) was injected
      // into the pty without submitting, so the user can add a message.
      await expect(fs.stat(body.path)).resolves.toBeDefined();
      expect(sessionManager.submitInput).toHaveBeenCalledWith("sess-img", `${body.path} `, false);

      await fs.rm(cwd, { recursive: true, force: true });
    });

    it("accepts an image body larger than express's 100 KiB JSON default", async () => {
      // Regression: the JSON parser must be raised above express's 100 KiB
      // default or any real screenshot 413s before the handler runs.
      const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "harness-img-"));
      const sessionManager = fakeSessionManager([seededSession(cwd)]);
      start({ sessionManager });

      const payload = Buffer.alloc(300 * 1024, 0x42); // 300 KiB decoded — well over 100 KiB
      const dataUrl = `data:image/png;base64,${payload.toString("base64")}`;
      const res = await fetch(`${baseUrl}/sessions/sess-img/image`, {
        method: "POST",
        headers: { ...TOKEN_HEADER, "content-type": "application/json" },
        body: JSON.stringify({ dataUrl }),
      });
      expect(res.status).toBe(200);

      await fs.rm(cwd, { recursive: true, force: true });
    });

    it("404s an unknown session", async () => {
      start();
      const res = await fetch(`${baseUrl}/sessions/nope/image`, {
        method: "POST",
        headers: { ...TOKEN_HEADER, "content-type": "application/json" },
        body: JSON.stringify({ dataUrl: PNG_DATA_URL }),
      });
      expect(res.status).toBe(404);
    });

    it("400s a harness that doesn't support image input", async () => {
      const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "harness-img-"));
      // `pi` is a real registry id with imageInput:false — persist a session as
      // that harness to exercise the capability gate. (fakeSessionManager's get
      // just echoes whatever we seed, so the harness kind need not be spawnable.)
      const session = { ...seededSession(cwd), harness: "pi" as HarnessKind };
      const sessionManager = fakeSessionManager([session]);
      start({ sessionManager });

      const res = await fetch(`${baseUrl}/sessions/sess-img/image`, {
        method: "POST",
        headers: { ...TOKEN_HEADER, "content-type": "application/json" },
        body: JSON.stringify({ dataUrl: PNG_DATA_URL }),
      });
      expect(res.status).toBe(400);
      expect(sessionManager.submitInput).not.toHaveBeenCalled();

      await fs.rm(cwd, { recursive: true, force: true });
    });

    it("400s an unsupported image media type", async () => {
      const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "harness-img-"));
      const sessionManager = fakeSessionManager([seededSession(cwd)]);
      start({ sessionManager });

      const res = await fetch(`${baseUrl}/sessions/sess-img/image`, {
        method: "POST",
        headers: { ...TOKEN_HEADER, "content-type": "application/json" },
        body: JSON.stringify({ dataUrl: "data:image/svg+xml;base64,PHN2Zy8+" }),
      });
      expect(res.status).toBe(400);

      await fs.rm(cwd, { recursive: true, force: true });
    });

    it("400s a body that isn't a base64 data URL", async () => {
      const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "harness-img-"));
      const sessionManager = fakeSessionManager([seededSession(cwd)]);
      start({ sessionManager });

      const res = await fetch(`${baseUrl}/sessions/sess-img/image`, {
        method: "POST",
        headers: { ...TOKEN_HEADER, "content-type": "application/json" },
        body: JSON.stringify({ dataUrl: "https://example.com/cat.png" }),
      });
      expect(res.status).toBe(400);

      await fs.rm(cwd, { recursive: true, force: true });
    });

    it("413s an image over the size limit", async () => {
      const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "harness-img-"));
      const sessionManager = fakeSessionManager([seededSession(cwd)]);
      start({ sessionManager });

      // A base64 payload just over MAX_IMAGE_UPLOAD_BYTES once decoded.
      const bigBytes = Buffer.alloc(MAX_IMAGE_UPLOAD_BYTES + 16, 0x41);
      const dataUrl = `data:image/png;base64,${bigBytes.toString("base64")}`;
      const res = await fetch(`${baseUrl}/sessions/sess-img/image`, {
        method: "POST",
        headers: { ...TOKEN_HEADER, "content-type": "application/json" },
        body: JSON.stringify({ dataUrl }),
      });
      expect(res.status).toBe(413);

      await fs.rm(cwd, { recursive: true, force: true });
    });

    it("409s when the session isn't ready yet (SessionNotReadyError)", async () => {
      const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "harness-img-"));
      const sessionManager = fakeSessionManager([seededSession(cwd)]);
      (sessionManager.submitInput as ReturnType<typeof vi.fn>).mockRejectedValue(
        new SessionNotReadyError("sess-img"),
      );
      start({ sessionManager });

      const res = await fetch(`${baseUrl}/sessions/sess-img/image`, {
        method: "POST",
        headers: { ...TOKEN_HEADER, "content-type": "application/json" },
        body: JSON.stringify({ dataUrl: PNG_DATA_URL }),
      });
      expect(res.status).toBe(409);

      await fs.rm(cwd, { recursive: true, force: true });
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
      const res = await fetch(`${baseUrl}/sessions/history?cwd=${encodeURIComponent(cwd)}`, {
        headers: TOKEN_HEADER,
      });
      expect(res.status).toBe(200);
      return (await res.json()) as SessionSummary[];
    }

    it("marks a registry row the agent still holds as agent-resume", async () => {
      start({
        sessionManager: fakeSessionManager([exitedSession()]),
        adapters: { "claude-code": historyAdapter({ canResume: async () => true }) },
      });

      const rows = await history("/tmp/proj");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ agentSessionId: "agent-1", source: "registry", resumeMode: "agent-resume" });
    });

    it("marks a PHANTOM registry row as rehydrate — an agentSessionId is not evidence of a conversation", async () => {
      // The bug this endpoint change exists for: the client used to render
      // `agentSessionId != null` as "resumable", so this row offered a Resume
      // button whose only possible outcome was exit 1.
      start({
        sessionManager: fakeSessionManager([exitedSession()]),
        adapters: { "claude-code": historyAdapter({ canResume: async () => false }) },
      });

      const rows = await history("/tmp/proj");
      expect(rows[0]).toMatchObject({ source: "registry", resumeMode: "rehydrate" });
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
      expect(rows[0]).toMatchObject({ source: "transcript", resumeMode: "agent-resume" });
    });

    it("resolves each row independently — a phantom and a live transcript in one directory", async () => {
      start({
        sessionManager: fakeSessionManager([exitedSession({ id: "sess-phantom", agentSessionId: "agent-phantom" })]),
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

      const byId = new Map((await history("/tmp/proj")).map((row) => [row.agentSessionId, row.resumeMode]));
      expect(byId.get("agent-phantom")).toBe("rehydrate");
      expect(byId.get("agent-real")).toBe("agent-resume");
    });

    it("reports rehydrate rather than failing when the harness has no registered adapter to ask", async () => {
      // e.g. an external-mode harness, or a kind persisted by another build:
      // unverifiable is not the same as resumable.
      start({
        sessionManager: fakeSessionManager([exitedSession({ harness: "conductor" as HarnessKind })]),
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
      (sessionManager.resume as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) => ({
        ...exitedSession({ id, agentSessionId: body.agentSessionId }),
        status: "running",
      }));
      start({ sessionManager, adapters: { "claude-code": historyAdapter({ canResume: async () => true }) } });

      const res = await adopt(body);
      expect(res.status).toBe(200);
      expect((await res.json()) as HarnessSession).toMatchObject({ status: "running" });
      expect(sessionManager.registerHistorical).toHaveBeenCalledWith(body);
      // The whole point: a real resume, not a fresh session.
      expect(sessionManager.resume).toHaveBeenCalledWith("adopted-agent-transcript");
    });

    it("409s SESSION_NOT_RESUMEABLE without registering anything when the agent no longer holds it", async () => {
      const sessionManager = fakeSessionManager();
      start({ sessionManager, adapters: { "claude-code": historyAdapter({ canResume: async () => false }) } });

      const res = await adopt(body);
      expect(res.status).toBe(409);
      expect((await res.json()) as { code: string }).toMatchObject({ code: "SESSION_NOT_RESUMEABLE" });
      // No phantom record left behind by a stale history row.
      expect(sessionManager.registerHistorical).not.toHaveBeenCalled();
      expect(sessionManager.resume).not.toHaveBeenCalled();
    });

    it("re-verifies server-side — a client claiming resumability cannot force a registration", async () => {
      const sessionManager = fakeSessionManager();
      const canResume = vi.fn(async () => false);
      start({ sessionManager, adapters: { "claude-code": historyAdapter({ canResume }) } });

      expect((await adopt({ ...body, resumeMode: "agent-resume" })).status).toBe(409);
      expect(canResume).toHaveBeenCalledWith(body.agentSessionId, body.cwd);
    });

    it("is idempotent: an already-tracked row resumes its existing record instead of duplicating it", async () => {
      const existing = exitedSession({ id: "sess-existing", agentSessionId: body.agentSessionId });
      const sessionManager = fakeSessionManager([existing]);
      (sessionManager.resume as ReturnType<typeof vi.fn>).mockResolvedValue({ ...existing, status: "running" });
      start({ sessionManager, adapters: { "claude-code": historyAdapter({ canResume: async () => true }) } });

      expect((await adopt(body)).status).toBe(200);
      expect(sessionManager.registerHistorical).not.toHaveBeenCalled();
      expect(sessionManager.resume).toHaveBeenCalledWith("sess-existing");
    });

    it("400s on a malformed body and an unspawnable harness", async () => {
      start({ adapters: { "claude-code": historyAdapter() } });
      expect((await adopt({ ...body, agentSessionId: "" })).status).toBe(400);
      expect((await adopt({ ...body, harness: "conductor" })).status).toBe(400);
      expect((await adopt({ cwd: "/tmp/proj" })).status).toBe(400);
    });

    it("is matched ahead of /sessions/:id/resume — ':id' never swallows 'adopt'", async () => {
      const sessionManager = fakeSessionManager();
      start({ sessionManager, adapters: { "claude-code": historyAdapter({ canResume: async () => false }) } });

      // If the :id route won, resume("adopt") would run and this would not be
      // the adopt route's own 409.
      const res = await adopt(body);
      expect(res.status).toBe(409);
      expect(sessionManager.resume).not.toHaveBeenCalled();
    });

    it("maps a resume failure after registration onto the same status the :id route uses", async () => {
      const sessionManager = fakeSessionManager();
      (sessionManager.resume as ReturnType<typeof vi.fn>).mockRejectedValue(
        new SessionAlreadyLiveError("adopted-agent-transcript"),
      );
      start({ sessionManager, adapters: { "claude-code": historyAdapter({ canResume: async () => true }) } });

      const res = await adopt(body);
      expect(res.status).toBe(409);
      expect((await res.json()) as { code: string }).toMatchObject({ code: "SESSION_ALREADY_LIVE" });
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

    it("surfaces each adapter's imageInput capability", async () => {
      start();
      const res = await fetch(`${baseUrl}/harnesses`);
      const body = (await res.json()) as Array<{ id: string; imageInput: boolean }>;
      for (const entry of body) {
        expect(typeof entry.imageInput).toBe("boolean");
      }
      expect(body.find((a) => a.id === "claude-code")!.imageInput).toBe(true);
      expect(body.find((a) => a.id === "codex")!.imageInput).toBe(true);
      expect(body.find((a) => a.id === "conductor")!.imageInput).toBe(false);
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
        ingestToken: "test-token",
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
      const session = sessionManager.registerHistorical({
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

      const session = sessionManager.registerHistorical({
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
});

