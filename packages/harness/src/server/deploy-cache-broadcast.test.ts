/**
 * Integration test for the deploy → cache-refresh → broadcast wiring.
 *
 * Verifies that the scan-and-broadcast pattern (used by onWorkflowConfigChanged
 * in index.ts) correctly propagates a definitionId written to sapiom.json into
 * the server's live workflow cache and broadcasts `workflows.changed` to
 * connected /ws/events clients.
 *
 * The actions unit tests (actions.test.ts) prove that the deploy route CALLS
 * onWorkflowConfigChanged at the right time. This test proves the IMPLEMENTATION
 * of that callback — scan → cache update → broadcast — is wired correctly by
 * verifying the equivalent code path (scanWorkflowsAndBroadcast, which uses the
 * same workflowRegistry.scan + workflowsCache assignment + bus.publish chain)
 * with a real server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";

import { startServer, type HarnessServer } from "./index.js";
import type {
  BusMessage,
  HarnessAdapter,
  LaunchOpts,
  SpawnSpec,
  WorkflowInfo,
} from "../shared/types.js";

/** Adapter that spawns bash so the pty reaches "running" synchronously. */
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
    resume: (_id: string, opts: LaunchOpts): SpawnSpec => spec(opts),
    listPastSessions: async () => [],
  };
}

/** Fetch the workflow list from a running server. */
async function listWorkflows(port: number): Promise<WorkflowInfo[]> {
  const res = await fetch(`http://127.0.0.1:${port}/api/workflows`, {
    headers: { "X-Harness-Token": "test-token" },
  });
  return (await res.json()) as WorkflowInfo[];
}

/** Open /ws/events and count incoming `workflows.changed` frames. */
async function connectEvents(
  port: number,
): Promise<{ changedCount: () => number; close: () => void }> {
  let count = 0;
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/ws/events?token=test-token`,
  );
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString()) as BusMessage;
    if (msg.type === "workflows.changed") count += 1;
  });
  return { changedCount: () => count, close: () => ws.close() };
}

describe("deploy cache-refresh and broadcast wiring", () => {
  let tmpDir: string;
  let server: HarnessServer | undefined;
  let events: { changedCount: () => number; close: () => void } | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "harness-deploy-broadcast-"));
  });

  afterEach(async () => {
    events?.close();
    events = undefined;
    await server?.sessionManager.flush();
    await server?.close();
    server = undefined;
    // maxRetries guards against macOS's occasional ENOTEMPTY on temp-dir
    // removal when a watcher handle releases slightly after close().
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it(
    "re-reads definitionId from sapiom.json and broadcasts workflows.changed after a scan",
    { timeout: 20_000 },
    async () => {
      // ── Setup: a workflow starting with no definitionId (Draft) ────────
      const workflowDir = join(tmpDir, "my-agent");
      await mkdir(workflowDir);
      await writeFile(
        join(workflowDir, "sapiom.json"),
        JSON.stringify({ definitionId: null }),
      );
      await writeFile(
        join(workflowDir, "package.json"),
        JSON.stringify({ name: "my-agent" }),
      );

      server = await startServer({
        port: 0,
        bootToken: "test-token",
        telemetryOptIn: false,
        adapters: { "claude-code": fakeClaudeAdapter() },
        stateRoot: tmpDir,
        launchDir: workflowDir,
        autoCreateSession: false,
      });
      const port = server.port;

      // Wait for the boot scan to register the workflow.
      await vi.waitFor(
        async () => {
          const wf = await listWorkflows(port);
          expect(wf.some((w) => w.path === workflowDir)).toBe(true);
        },
        { timeout: 8_000, interval: 100 },
      );

      // Confirm initial state: definitionId is null (Draft).
      const wfBefore = (await listWorkflows(port)).find(
        (w) => w.path === workflowDir,
      )!;
      expect(wfBefore.definitionId).toBeNull();

      events = await connectEvents(port);
      const framesBefore = events.changedCount();

      // ── Simulate what the deploy route's writeConfig() does: update ────
      // sapiom.json on disk with the link-resolved definitionId.
      const newDefinitionId = 42;
      await writeFile(
        join(workflowDir, "sapiom.json"),
        JSON.stringify({ definitionId: newDefinitionId, name: "my-agent" }),
      );

      // ── Trigger a re-scan via the session-create path (scanWorkflowsAndBroadcast).
      // This uses the same workflowRegistry.scan + cache-update + bus.publish
      // sequence that onWorkflowConfigChanged executes in index.ts. The session-
      // create endpoint calls onSessionCreated → scanWorkflowsAndBroadcast.
      const createRes = await fetch(
        `http://127.0.0.1:${port}/api/sessions`,
        {
          method: "POST",
          headers: {
            "X-Harness-Token": "test-token",
            "content-type": "application/json",
          },
          body: JSON.stringify({ cwd: workflowDir, harness: "claude-code" }),
        },
      );
      expect(createRes.ok).toBe(true);

      // ── Verify: workflows.changed was broadcast and GET /api/workflows ──
      // returns the updated definitionId.
      await vi.waitFor(
        async () => {
          expect(events!.changedCount()).toBeGreaterThan(framesBefore);
          const wf = await listWorkflows(port);
          const updated = wf.find((w) => w.path === workflowDir);
          expect(updated?.definitionId).toBe(newDefinitionId);
        },
        { timeout: 8_000, interval: 100 },
      );
    },
  );
});
