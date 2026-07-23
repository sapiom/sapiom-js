/**
 * Auto-bind (SAP-1897): when a session is unbound and a rescan discovers a
 * workflow at/under the session's cwd, the session must be bound to that
 * workflow automatically — using the same setBoundWorkflowPath mechanism that
 * PATCH /api/sessions/:id/workflow uses.
 *
 * Guardrails:
 *  - Only fires when unbound (never overrides an explicit binding).
 *  - Only binds workflows at or strictly under the session's cwd.
 *  - Idempotent: a second rescan does not re-bind or churn.
 *  - Prefers the workflow at exactly cwd; falls back to the nearest under cwd.
 *  - Propagates the new binding live via the existing session.status broadcast.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

/** Fetch the session list from a running server. */
async function listSessions(port: number): Promise<HarnessSession[]> {
  const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    headers: { "X-Harness-Token": "test-token" },
  });
  return (await res.json()) as HarnessSession[];
}

/** Open the /ws/events WebSocket and return a collector of received messages. */
async function collectEvents(
  port: number,
): Promise<{ messages: BusMessage[]; close: () => void }> {
  const messages: BusMessage[] = [];
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/ws/events?token=test-token`,
  );
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

describe("auto-bind on rescan (SAP-1897)", () => {
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
    await server?.sessionManager.flush();
    await server?.close();
    server = undefined;
    // maxRetries guards against macOS's occasional ENOTEMPTY on temp-dir
    // removal when a watcher handle releases slightly after close().
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  async function startTestServer(): Promise<number> {
    server = await startServer({
      port: 0,
      bootToken: "test-token",
      telemetryOptIn: false,
      adapters: { "claude-code": fakeClaudeAdapter() },
      stateRoot: dir,
      launchDir: cwd,
      autoCreateSession: false,
    });
    return server.port;
  }

  it(
    "binds an unbound session when a workflow appears at exactly session.cwd",
    { retry: 1, timeout: 20_000 },
    async () => {
      const port = await startTestServer();
      // Create a session in cwd — starts unbound.
      const session = await server!.sessionManager.create({
        cwd,
        harness: "claude-code",
      });
      expect(session.boundWorkflowPath).toBeNull();

      events = await collectEvents(port);

      // Scaffold a workflow at exactly cwd — the workspace watcher fires a
      // rescan, which should auto-bind.
      await scaffoldWorkflow(cwd);

      await vi.waitFor(
        async () => {
          const sessions = await listSessions(port);
          const s = sessions.find((x) => x.id === session.id);
          expect(s?.boundWorkflowPath).toBe(cwd);
        },
        { timeout: 8_000, interval: 150 },
      );

      // The binding must have been broadcast as a session.status frame.
      expect(
        events.messages.some(
          (m) =>
            m.type === "session.status" &&
            m.session.id === session.id &&
            m.session.boundWorkflowPath === cwd,
        ),
      ).toBe(true);
    },
  );

  it(
    "binds an unbound session when a workflow appears under session.cwd (nested)",
    { retry: 1, timeout: 20_000 },
    async () => {
      const port = await startTestServer();
      const session = await server!.sessionManager.create({
        cwd,
        harness: "claude-code",
      });
      expect(session.boundWorkflowPath).toBeNull();

      // Scaffold a workflow under a sub-directory of cwd.
      const wfDir = join(cwd, "my-agent");
      await scaffoldWorkflow(wfDir);

      await vi.waitFor(
        async () => {
          const sessions = await listSessions(port);
          const s = sessions.find((x) => x.id === session.id);
          expect(s?.boundWorkflowPath).toBe(wfDir);
        },
        { timeout: 8_000, interval: 150 },
      );
    },
  );

  it(
    "prefers workflow at cwd over a nested one",
    { retry: 1, timeout: 20_000 },
    async () => {
      const port = await startTestServer();
      const session = await server!.sessionManager.create({
        cwd,
        harness: "claude-code",
      });

      // Scaffold a nested workflow first (to register it), then the one at cwd.
      const nested = join(cwd, "nested-agent");
      await scaffoldWorkflow(nested);

      // Wait for nested to appear so both are present when we add the cwd one.
      await vi.waitFor(
        async () => {
          const s = await listSessions(port);
          expect(s.find((x) => x.id === session.id)?.boundWorkflowPath).toBe(
            nested,
          );
        },
        { timeout: 8_000, interval: 150 },
      );

      // Now manually unbind (simulate the user not having an explicit binding)
      // and scaffold at cwd.  The test validates preference logic directly by
      // calling the PATCH route.
      const patchRes = await fetch(
        `http://127.0.0.1:${port}/api/sessions/${session.id}/workflow`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-Harness-Token": "test-token",
          },
          body: JSON.stringify({ workflowPath: null }),
        },
      );
      expect(patchRes.status).toBe(200);

      // Scaffold a workflow at exactly cwd — next rescan should prefer it.
      await scaffoldWorkflow(cwd);

      await vi.waitFor(
        async () => {
          const s = await listSessions(port);
          expect(s.find((x) => x.id === session.id)?.boundWorkflowPath).toBe(
            cwd,
          );
        },
        { timeout: 8_000, interval: 150 },
      );
    },
  );

  it(
    "does not auto-bind when the session already has an explicit binding",
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

      // Explicitly bind to the pre-existing workflow.
      const patchRes = await fetch(
        `http://127.0.0.1:${port}/api/sessions/${session.id}/workflow`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-Harness-Token": "test-token",
          },
          body: JSON.stringify({ workflowPath: preexisting }),
        },
      );
      expect(patchRes.status).toBe(200);

      // Now scaffold a workflow at cwd — a rescan should NOT override the
      // explicit binding.
      await scaffoldWorkflow(cwd);

      // Wait long enough for a rescan to have fired; binding must stay.
      await new Promise<void>((resolve) => setTimeout(resolve, 3_000));
      const sessions = await listSessions(port);
      const s = sessions.find((x) => x.id === session.id);
      expect(s?.boundWorkflowPath).toBe(preexisting);
    },
  );

  it(
    "does not auto-bind when no workflow exists at or under session.cwd",
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

      await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
      const sessions = await listSessions(port);
      const s = sessions.find((x) => x.id === session.id);
      expect(s?.boundWorkflowPath).toBeNull();
    },
  );

  it(
    "is idempotent — a second rescan does not re-bind or emit redundant events",
    { retry: 1, timeout: 25_000 },
    async () => {
      const port = await startTestServer();
      const session = await server!.sessionManager.create({
        cwd,
        harness: "claude-code",
      });

      events = await collectEvents(port);

      // Scaffold the first workflow as a SUBDIRECTORY of cwd (not at cwd itself).
      // This is deliberate: when the first workflow lives at `cwd/first-agent`,
      // the watcher's fingerprint is "cwd/first-agent".  Adding a sibling
      // `cwd/second-agent` later changes the fingerprint to
      // "cwd/first-agent|cwd/second-agent", which fires a real onChange.
      // (If the workflow were at cwd itself, the fingerprint walk stops there
      // and never descends into any sub-directory, so adding a nested entry
      // would NOT change the fingerprint and the watcher would never fire.)
      const firstWorkflow = join(cwd, "first-agent");
      await scaffoldWorkflow(firstWorkflow);

      // Wait for the initial auto-bind to land (session binds to firstWorkflow).
      await vi.waitFor(
        async () => {
          const s = await listSessions(port);
          expect(s.find((x) => x.id === session.id)?.boundWorkflowPath).toBe(
            firstWorkflow,
          );
        },
        { timeout: 8_000, interval: 150 },
      );

      // Count session.status frames after the first (real) bind.
      const framesAfterBind = events.messages.filter(
        (m) => m.type === "session.status" && m.session.id === session.id,
      ).length;
      expect(framesAfterBind).toBeGreaterThan(0);

      // Force a REAL second rescan: scaffold a second (peer) workflow directory
      // under cwd.  The workspace watcher is fingerprint-based — it fires
      // onChange only when the SET of sapiom.json-bearing directories changes.
      // Adding a sibling directory changes the fingerprint and guarantees a
      // rescan fires; the `!session.boundWorkflowPath` guard is now false, so
      // the auto-bind code runs but does NOT re-bind.
      const secondWorkflow = join(cwd, "second-agent");
      await scaffoldWorkflow(secondWorkflow);

      // Wait for the second workflow to appear in the registry — this confirms
      // the workspace watcher detected the structural change, fired onChange,
      // and `rescanWorkspaceForSession` completed.
      await vi.waitFor(
        async () => {
          const res = await fetch(
            `http://127.0.0.1:${port}/api/workflows`,
            { headers: { "X-Harness-Token": "test-token" } },
          );
          const workflows = (await res.json()) as Array<{ path: string }>;
          expect(workflows.some((w) => w.path === secondWorkflow)).toBe(true);
        },
        { timeout: 10_000, interval: 200 },
      );

      // The binding must remain on the FIRST workflow — the
      // `!session.boundWorkflowPath` guard (now false) prevented any re-bind.
      const sessions = await listSessions(port);
      expect(
        sessions.find((x) => x.id === session.id)?.boundWorkflowPath,
      ).toBe(firstWorkflow);

      // No NEW session.status frames should have been emitted for a bind
      // attempt on account of the second rescan (the guard prevented it).
      const framesAfterSecondRescan = events.messages.filter(
        (m) => m.type === "session.status" && m.session.id === session.id,
      ).length;
      expect(framesAfterSecondRescan).toBe(framesAfterBind);
    },
  );
});
