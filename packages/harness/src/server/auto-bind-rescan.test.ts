/**
 * No auto-bind (SAP-3834, design-map-chat.md I2). A rescan that discovers a
 * workflow at or under an unbound session's cwd lists it on the rail and never
 * binds or renders it for that session: the server once picked the first agent
 * folder under a new project-root session and rendered it, which showed an
 * unrelated agent's "No index.ts found" card. Binding happens only through
 * PATCH /api/sessions/:id/workflow (or the FTUX draft build on the client).
 *
 * The automatic Canvas render of an explicitly bound session stays, and so do
 * its execution guards, exercised here through the source watcher.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

import { startServer, type HarnessServer } from "./index.js";
import type {
  BusMessage,
  HarnessAdapter,
  HarnessSession,
  LaunchOpts,
  SpawnSpec,
} from "../shared/types.js";

/** Adapter that spawns bash so the pty reaches "running". */
function fakeClaudeAdapter(): HarnessAdapter {
  const spec = (opts: LaunchOpts): SpawnSpec => ({
    command: "bash",
    args: [],
    env: {},
    cwd: opts.cwd,
  });
  return {
    id: "claude-code",
    eventSource: "hooks",
    doctor: async () => [],
    launch: spec,
    resume: (_agentSessionId: string, opts: LaunchOpts): SpawnSpec =>
      spec(opts),
    listPastSessions: async () => [],
    canResume: async () => true,
  };
}

/** Write a minimal sapiom.json into `dir`, creating the directory first. */
async function scaffoldWorkflow(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "sapiom.json"),
    JSON.stringify({ definitionId: null }),
  );
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: dir.split("/").pop() }),
  );
}

async function scaffoldHostileSourceWorkflow(
  workflowDir: string,
  sideEffectPath: string,
): Promise<void> {
  await mkdir(workflowDir, { recursive: true });
  await writeFile(
    join(workflowDir, "index.ts"),
    `import { writeFileSync } from "node:fs";
import { defineAgent } from "@sapiom/agent";
writeFileSync(${JSON.stringify(sideEffectPath)}, "executed");
export const agent = defineAgent({ name: "hostile-source-only" });`,
  );
}

/** Fetch the session list from a running server. */
async function listSessions(port: number): Promise<HarnessSession[]> {
  const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    headers: { "X-Harness-Token": "test-token" },
  });
  return (await res.json()) as HarnessSession[];
}

async function expectPrivateWorkflowEvidenceHidden(
  port: number,
): Promise<void> {
  const headers = { "X-Harness-Token": "test-token" };
  const workflows = (await (
    await fetch(`http://127.0.0.1:${port}/api/workflows`, { headers })
  ).json()) as Array<Record<string, unknown>>;
  const state = (await (
    await fetch(`http://127.0.0.1:${port}/api/state`, { headers })
  ).json()) as { workflows: Array<Record<string, unknown>> };
  for (const workflow of [...workflows, ...state.workflows]) {
    expect(workflow).not.toHaveProperty("sourceDefinitionName");
    expect(workflow).not.toHaveProperty("markerPresent");
  }
}

/** Open the /ws/events WebSocket and return a collector of received messages. */
async function collectEvents(
  port: number,
): Promise<{ messages: BusMessage[]; close: () => void }> {
  const messages: BusMessage[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/events?token=test-token`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.on("message", (raw) => {
    messages.push(JSON.parse(raw.toString()) as BusMessage);
  });
  return {
    messages,
    close: () => ws.close(),
  };
}

async function waitForWorkflow(port: number, path: string): Promise<void> {
  await vi.waitFor(
    async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/workflows`, {
        headers: { "X-Harness-Token": "test-token" },
      });
      const workflows = (await res.json()) as Array<{ path: string }>;
      expect(workflows.some((w) => w.path === path)).toBe(true);
    },
    { timeout: 10_000, interval: 150 },
  );
}

async function bindSession(
  port: number,
  sessionId: string,
  workflowPath: string,
): Promise<void> {
  const res = await fetch(
    `http://127.0.0.1:${port}/api/sessions/${sessionId}/workflow`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-Harness-Token": "test-token",
      },
      body: JSON.stringify({ workflowPath }),
    },
  );
  expect(res.status).toBe(200);
}

/** Rescans fire on their own schedule; give one time to land before asserting. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 1_500));

async function boundPath(
  port: number,
  sessionId: string,
): Promise<string | null | undefined> {
  return (await listSessions(port)).find((s) => s.id === sessionId)
    ?.boundWorkflowPath;
}

function bindFrames(
  events: { messages: BusMessage[] },
  sessionId: string,
): BusMessage[] {
  return events.messages.filter(
    (m) =>
      m.type === "session.status" &&
      m.session.id === sessionId &&
      m.session.boundWorkflowPath !== null,
  );
}

describe("no auto-bind on rescan (SAP-3834)", () => {
  let dir: string;
  let cwd: string;
  let server: HarnessServer | undefined;
  let events: { messages: BusMessage[]; close: () => void } | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "harness-autobind-"));
    cwd = join(dir, "project");
    await mkdir(cwd, { recursive: true });
  });

  afterEach(async () => {
    events?.close();
    events = undefined;
    await server?.sessionManager.flush();
    await server?.close();
    server = undefined;
    // maxRetries guards against macOS's occasional ENOTEMPTY on temp-dir
    // removal when a watcher handle releases slightly after close().
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  });

  async function startTestServer(
    options: {
      autoCreateSession?: boolean;
      beforeAutomaticCanvasLaunch?: (
        workflowPath: string,
      ) => void | Promise<void>;
    } = {},
  ): Promise<number> {
    server = await startServer({
      port: 0,
      bootToken: "test-token",
      telemetryOptIn: false,
      adapters: { "claude-code": fakeClaudeAdapter() },
      stateRoot: dir,
      launchDir: cwd,
      autoCreateSession: options.autoCreateSession ?? false,
      workflowDiscoveryTestHooks: {
        beforeAutomaticCanvasLaunch: options.beforeAutomaticCanvasLaunch,
      },
    });
    return server.port;
  }

  it(
    "neither binds nor executes a hostile source-only workflow discovered by the watcher",
    { timeout: 20_000 },
    async () => {
      const launches = vi.fn();
      const sideEffect = join(dir, "source-executed");
      const port = await startTestServer({
        beforeAutomaticCanvasLaunch: launches,
      });
      const session = await server!.sessionManager.create({
        cwd,
        harness: "claude-code",
      });

      await scaffoldHostileSourceWorkflow(cwd, sideEffect);
      await waitForWorkflow(port, cwd);
      await settle();

      expect(await boundPath(port, session.id)).toBeNull();
      expect(launches).not.toHaveBeenCalled();
      await expect(access(sideEffect)).rejects.toThrow();
      await expectPrivateWorkflowEvidenceHidden(port);
    },
  );

  it(
    "never binds or executes a hostile source-only workflow during boot auto-create",
    { timeout: 20_000 },
    async () => {
      const launches = vi.fn();
      const sideEffect = join(dir, "boot-source-executed");
      await scaffoldHostileSourceWorkflow(cwd, sideEffect);

      await startTestServer({
        autoCreateSession: true,
        beforeAutomaticCanvasLaunch: launches,
      });
      await vi.waitFor(() => {
        expect(server!.sessionManager.list().length).toBeGreaterThan(0);
      });
      await settle();

      expect(
        server!.sessionManager.list().map((s) => s.boundWorkflowPath),
      ).toEqual([null]);
      expect(launches).not.toHaveBeenCalled();
      await expect(access(sideEffect)).rejects.toThrow();
    },
  );

  it(
    "never binds or executes a hostile source-only workflow on REST session creation",
    { timeout: 20_000 },
    async () => {
      const launches = vi.fn();
      const sideEffect = join(dir, "session-source-executed");
      await scaffoldHostileSourceWorkflow(cwd, sideEffect);
      const port = await startTestServer({
        beforeAutomaticCanvasLaunch: launches,
      });

      const response = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-harness-token": "test-token",
        },
        body: JSON.stringify({ cwd, harness: "claude-code" }),
      });
      expect(response.status).toBe(201);
      const { id } = (await response.json()) as HarnessSession;
      await settle();

      expect(await boundPath(port, id)).toBeNull();
      expect(launches).not.toHaveBeenCalled();
      await expect(access(sideEffect)).rejects.toThrow();
    },
  );

  it(
    "revalidates marker proof at the automatic extraction boundary of an explicitly bound session",
    { timeout: 25_000 },
    async () => {
      const sideEffect = join(dir, "late-marker-removal-executed");
      await scaffoldHostileSourceWorkflow(cwd, sideEffect);
      await scaffoldWorkflow(cwd);
      const beforeLaunch = vi.fn(async (workflowPath: string) => {
        await rm(join(workflowPath, "sapiom.json"));
      });

      const port = await startTestServer({
        beforeAutomaticCanvasLaunch: beforeLaunch,
      });
      const session = await server!.sessionManager.create({
        cwd,
        harness: "claude-code",
      });
      await waitForWorkflow(port, cwd);
      await settle();
      // The explicit bind renders without dependencies installed: a
      // placeholder, no extraction, and the install watcher armed.
      await bindSession(port, session.id, cwd);
      // Installing dependencies triggers the automatic render, so the hook
      // sits after the dependency probe and source fingerprint, immediately
      // before the child launch. They land in the parent folder, which module
      // resolution reaches: a new entry inside cwd would dirty the workspace
      // inventory on Linux and refuse the render before the boundary.
      await symlink(
        join(process.cwd(), "node_modules"),
        join(dir, "node_modules"),
        "dir",
      );
      await vi.waitFor(() => expect(beforeLaunch).toHaveBeenCalledOnce(), {
        timeout: 10_000,
      });
      // Long enough for a refused launch to have run had it been allowed: the
      // hook-free mutation of this test writes the side effect within ~5s.
      await new Promise((resolve) => setTimeout(resolve, 6_000));

      expect(beforeLaunch).toHaveBeenCalledWith(cwd);
      await expect(access(sideEffect)).rejects.toThrow();
    },
  );

  it(
    "preserves legacy automatic Canvas authorization for a markerless cloud-linked source row bound explicitly",
    { timeout: 25_000 },
    async () => {
      const launches = vi.fn();
      await writeFile(
        join(cwd, "index.ts"),
        `import { defineAgent } from "@sapiom/agent";
export const agent = defineAgent({ name: "linked-source" });`,
      );
      await symlink(
        join(process.cwd(), "node_modules"),
        join(cwd, "node_modules"),
        "dir",
      );
      await writeFile(
        join(dir, "workflows.json"),
        JSON.stringify([
          {
            name: "linked-source",
            path: cwd,
            definitionId: 42,
            definitionSlug: "linked-source",
            sourceDefinitionName: "linked-source",
            activeBuildRunId: null,
            activeBuildRunStatus: null,
            templateId: null,
            forkId: null,
            starterId: null,
            source: "connect",
          },
        ]),
      );

      const port = await startTestServer({
        beforeAutomaticCanvasLaunch: launches,
      });
      const session = await server!.sessionManager.create({
        cwd,
        harness: "claude-code",
      });
      await settle();
      expect(await boundPath(port, session.id)).toBeNull();
      expect(launches).not.toHaveBeenCalled();

      await bindSession(port, session.id, cwd);
      await writeFile(
        join(cwd, "index.ts"),
        `import { defineAgent } from "@sapiom/agent";
export const agent = defineAgent({ name: "linked-source-edited" });`,
      );
      await vi.waitFor(() => expect(launches).toHaveBeenCalled(), {
        timeout: 10_000,
      });
      expect(launches).toHaveBeenCalledWith(cwd);
    },
  );

  it(
    "leaves an unbound session unbound when a workflow appears at exactly session.cwd",
    { retry: 1, timeout: 20_000 },
    async () => {
      const port = await startTestServer();
      const session = await server!.sessionManager.create({
        cwd,
        harness: "claude-code",
      });
      expect(session.boundWorkflowPath).toBeNull();
      events = await collectEvents(port);

      await scaffoldWorkflow(cwd);
      await waitForWorkflow(port, cwd);
      await settle();

      expect(await boundPath(port, session.id)).toBeNull();
      expect(bindFrames(events, session.id)).toEqual([]);
      await expectPrivateWorkflowEvidenceHidden(port);
    },
  );

  it(
    "leaves an unbound session unbound when a workflow appears under session.cwd (nested)",
    { retry: 1, timeout: 20_000 },
    async () => {
      const port = await startTestServer();
      const session = await server!.sessionManager.create({
        cwd,
        harness: "claude-code",
      });
      events = await collectEvents(port);

      const wfDir = join(cwd, "my-agent");
      await scaffoldWorkflow(wfDir);
      await waitForWorkflow(port, wfDir);
      await settle();

      expect(await boundPath(port, session.id)).toBeNull();
      expect(bindFrames(events, session.id)).toEqual([]);
    },
  );

  it(
    "leaves an unbound session unbound with workflows both at and under session.cwd",
    { retry: 1, timeout: 20_000 },
    async () => {
      const port = await startTestServer();
      const session = await server!.sessionManager.create({
        cwd,
        harness: "claude-code",
      });

      const nested = join(cwd, "nested-agent");
      await scaffoldWorkflow(nested);
      await waitForWorkflow(port, nested);
      await scaffoldWorkflow(cwd);
      await waitForWorkflow(port, cwd);
      await settle();

      expect(await boundPath(port, session.id)).toBeNull();
    },
  );

  it(
    "keeps an explicit binding when a workflow appears at session.cwd",
    { retry: 1, timeout: 20_000 },
    async () => {
      const port = await startTestServer();

      // Pre-register a workflow so we can bind to it.
      const preexisting = join(dir, "other-agent");
      await scaffoldWorkflow(preexisting);
      // Connect it via the API so the registry knows it.
      const connectRes = await fetch(
        `http://127.0.0.1:${port}/api/workflows/connect`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Harness-Token": "test-token",
          },
          body: JSON.stringify({ path: preexisting }),
        },
      );
      expect(connectRes.status).toBe(200);

      const session = await server!.sessionManager.create({
        cwd,
        harness: "claude-code",
      });
      await bindSession(port, session.id, preexisting);

      // Scaffold a workflow at cwd — a rescan must not change the binding.
      await scaffoldWorkflow(cwd);
      await waitForWorkflow(port, cwd);
      await settle();

      expect(await boundPath(port, session.id)).toBe(preexisting);
    },
  );

  it(
    "does not bind when no workflow exists at or under session.cwd",
    { retry: 1, timeout: 20_000 },
    async () => {
      const port = await startTestServer();
      const session = await server!.sessionManager.create({
        cwd,
        harness: "claude-code",
      });

      // Scaffold a workflow OUTSIDE the session's cwd — must not trigger bind.
      const outside = join(dir, "unrelated-agent");
      await scaffoldWorkflow(outside);
      await fetch(`http://127.0.0.1:${port}/api/workflows/connect`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Harness-Token": "test-token",
        },
        body: JSON.stringify({ path: outside }),
      });

      await settle();
      expect(await boundPath(port, session.id)).toBeNull();
    },
  );

  it(
    "never binds across repeated rescans",
    { retry: 1, timeout: 25_000 },
    async () => {
      const port = await startTestServer();
      const session = await server!.sessionManager.create({
        cwd,
        harness: "claude-code",
      });
      events = await collectEvents(port);

      // Two structural changes under cwd, each firing a real rescan: the
      // watcher's fingerprint is the set of sapiom.json-bearing directories,
      // and adding a sibling changes it.
      const firstWorkflow = join(cwd, "first-agent");
      await scaffoldWorkflow(firstWorkflow);
      await waitForWorkflow(port, firstWorkflow);
      const secondWorkflow = join(cwd, "second-agent");
      await scaffoldWorkflow(secondWorkflow);
      await waitForWorkflow(port, secondWorkflow);
      await settle();

      expect(await boundPath(port, session.id)).toBeNull();
      expect(bindFrames(events, session.id)).toEqual([]);
    },
  );

  it(
    "leaves a session unbound when its workflow exists before the session starts (on-start rescan)",
    { retry: 1, timeout: 20_000 },
    async () => {
      // The cloned/deployed-template case: the watcher's baseline already
      // holds the workflow, so only the one-time on-start rescan sees it.
      await scaffoldWorkflow(cwd);

      const port = await startTestServer();
      events = await collectEvents(port);
      const session = await server!.sessionManager.create({
        cwd,
        harness: "claude-code",
      });
      await waitForWorkflow(port, cwd);
      await settle();

      expect(await boundPath(port, session.id)).toBeNull();
      expect(bindFrames(events, session.id)).toEqual([]);
    },
  );
});
