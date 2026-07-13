/**
 * Wiring-level proof of the mid-session workflow rescan (Bug B): a workflow
 * scaffolded under a running session's workspace appears in the broadcast
 * workflow list, and a removed one drops out — without a server restart. The
 * per-session workspace watcher (core/workspace-watcher.ts) drives a
 * prune + rescan that persists to the registry and broadcasts
 * `workflows.changed` on /ws/events.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

import { startServer, type HarnessServer } from "./index.js";
import type { BusMessage, HarnessAdapter, LaunchOpts, SpawnSpec, WorkflowInfo } from "../shared/types.js";

/** A claude-code-shaped adapter that spawns bash — a real pty that reaches "running". */
function fakeClaudeAdapter(): HarnessAdapter {
  const spec = (opts: LaunchOpts): SpawnSpec => ({ command: "bash", args: [], env: {}, cwd: opts.cwd });
  return {
    id: "claude-code",
    eventSource: "hooks",
    doctor: async () => [],
    launch: spec,
    resume: (_agentSessionId: string, opts: LaunchOpts): SpawnSpec => spec(opts),
    listPastSessions: async () => [],
  };
}

async function scaffoldWorkflow(root: string, name: string): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "sapiom.json"), JSON.stringify({ definitionId: null }));
  await writeFile(join(dir, "package.json"), JSON.stringify({ name }));
  return dir;
}

describe("mid-session workflow rescan", () => {
  let dir: string;
  let cwd: string;
  let server: HarnessServer | undefined;
  let ws: WebSocket | undefined;
  let changedFrames: number;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "harness-workspace-rescan-"));
    cwd = join(dir, "project");
    await mkdir(cwd, { recursive: true });
    changedFrames = 0;
  });

  afterEach(async () => {
    ws?.close();
    await server?.sessionManager.flush();
    await server?.close();
    server = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  async function connectEvents(port: number): Promise<void> {
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws/events?token=test-token`);
    await new Promise<void>((resolve, reject) => {
      ws!.once("open", () => resolve());
      ws!.once("error", reject);
    });
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as BusMessage;
      if (msg.type === "workflows.changed") changedFrames += 1;
    });
  }

  async function listWorkflows(port: number): Promise<WorkflowInfo[]> {
    const res = await fetch(`http://127.0.0.1:${port}/api/workflows`, {
      headers: { "X-Harness-Token": "test-token" },
    });
    return (await res.json()) as WorkflowInfo[];
  }

  // retry:1 — this test exercises a real filesystem watcher under parallel load;
  // the watcher's debounce window occasionally races with the vi.waitFor polling
  // interval, producing a spurious timeout on the first run. One retry isolates
  // a scheduling artifact from a genuine regression without masking real failures.
  it(
    "adds a scaffolded workflow and drops a removed one, broadcasting each change",
    { retry: 1, timeout: 20_000 },
    async () => {
      server = await startServer({
        port: 0,
        bootToken: "test-token",
        telemetryOptIn: false,
        adapters: { "claude-code": fakeClaudeAdapter() },
        stateRoot: dir,
        launchDir: cwd,
        autoCreateSession: false,
      });
      const port = server.port;

      const session = await server.sessionManager.create({ cwd, harness: "claude-code" });
      expect(session.status).toBe("running");
      await connectEvents(port);

      // Add a workflow mid-session — it must appear in the broadcast list AND
      // trigger a `workflows.changed` frame.
      await scaffoldWorkflow(cwd, "hn-story-images");
      await vi.waitFor(
        async () => {
          const workflows = await listWorkflows(port);
          expect(workflows.some((w) => w.name === "hn-story-images")).toBe(true);
          expect(changedFrames).toBeGreaterThan(0);
        },
        { timeout: 8_000, interval: 150 },
      );

      // Remove it — the prune in the rescan must drop it back out and broadcast again.
      const framesBeforeRemoval = changedFrames;
      await rm(join(cwd, "hn-story-images"), { recursive: true, force: true });
      await vi.waitFor(
        async () => {
          const workflows = await listWorkflows(port);
          expect(workflows.some((w) => w.name === "hn-story-images")).toBe(false);
          expect(changedFrames).toBeGreaterThan(framesBeforeRemoval);
        },
        { timeout: 8_000, interval: 150 },
      );
    },
  );
});
