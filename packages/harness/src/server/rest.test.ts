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

import type { HarnessSession, MacroDef, WorkflowInfo } from "../shared/types.js";
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
  } as unknown as RestRouterOptions["sessionManager"];
}

describe("createRestRouter", () => {
  let server: ReturnType<express.Express["listen"]>;
  let baseUrl: string;
  let onTelemetryOptInChange: ReturnType<typeof vi.fn>;

  function start(overrides: Partial<RestRouterOptions> = {}) {
    onTelemetryOptInChange = vi.fn();
    const options: RestRouterOptions = {
      sessionManager: fakeSessionManager(),
      adapters: {},
      version: "9.9.9-test",
      identity: null,
      listWorkflows: async () => [],
      listMacros: () => [],
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
      };
      const workflow: WorkflowInfo = { name: "leasing", path: "/tmp/leasing", definitionId: 1, source: "scan" };
      const macro: MacroDef = { id: "run_local", label: "Run local", icon: "Play", action: { kind: "inject", text: "x" } };

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
      expect(await res.json()).toEqual({ telemetryOptIn: false, recentDirs: [] });
    });

    it("persists a patch and returns the merged result", async () => {
      start();
      const res = await fetch(`${baseUrl}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ telemetryOptIn: true }),
      });
      expect(await res.json()).toEqual({ telemetryOptIn: true, recentDirs: [] });

      const reread = await fetch(`${baseUrl}/settings`);
      expect(await reread.json()).toEqual({ telemetryOptIn: true, recentDirs: [] });
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
    it("calls onSessionCreated with the new session's cwd", async () => {
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
      expect(onSessionCreated).toHaveBeenCalledWith("/tmp/proj");
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
  });
});
