#!/usr/bin/env -S npx tsx
/**
 * Full-loop, live proof that the integration wiring is actually connected —
 * WITHOUT running a real `claude`. Boots the real `startServer()` (the
 * actual production wiring, not a hand-assembled stand-in like
 * scripts/e2e-sim.ts's analytics-only simulation), with the claude-code
 * adapter's binary overridden to a tiny fixture (scripts/fixtures/fake-claude.mjs)
 * that captures its own argv/env and then stays alive — a real pty's kernel
 * line discipline echoes written input back on its own, so the fixture
 * doesn't need to cooperate for the pty lifecycle to behave realistically.
 *
 * Proves, end to end:
 *   1. POST /api/sessions launches with real, session-scoped generated
 *      --settings / --mcp-config / --append-system-prompt, and the pty env
 *      carries SAPIOM_HARNESS_INGEST_URL/_TOKEN/_SESSION_ID.
 *   2. POST /api/sessions/:id/input is accepted by a running session.
 *   3. A hook POST to /ingest lands in events.ndjson and reaches the mock
 *      collector as a batch.
 *   4. A tool.call event's localhost:<port> reference produces a
 *      port.detected frame on /ws/events.
 *   5. Writing to the session's canvas dir produces a canvas.reload frame,
 *      and GET /canvas/:id/ serves what was written.
 *   6. POST /api/macros/:id/run is accepted (injects into the pty).
 *   7. The CLI's launch directory is scanned for workflows at boot, and a
 *      new directory is scanned when a session opens in it — both fire a
 *      workflows.changed frame on /ws/events.
 *
 * Run with: pnpm e2e:live
 */
import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

import { startServer } from "../src/server/index.js";
import { createClaudeCodeAdapter } from "../src/core/adapters/claude-code.js";
import { createCodexAdapter } from "../src/core/adapters/codex.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(SCRIPT_DIR, "fixtures", "fake-claude.mjs");
const MOCK_COLLECTOR_PORT = 4298; // distinct from e2e-sim.ts's 4299, avoids clashing if both run at once

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    throw new Error(message);
  }
  console.log(`ok - ${message}`);
}

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 8000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await fn();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("waitFor timed out");
}

interface FakeClaudeCapture {
  argv: string[];
  env: Record<string, string | null>;
}

/**
 * node-pty ships prebuilt native binaries rather than compiling from source.
 * Observed in the wild: a pnpm-managed install (even with
 * onlyBuiltDependencies configured) can extract the darwin/linux
 * `spawn-helper` without its executable bit set, which fails every single
 * pty spawn with an opaque "posix_spawnp failed" — nothing to do with this
 * script or the harness's own code. session-manager.ts's loadDefaultSpawn()
 * self-heals this on first real use, but this script spawns real ptys as
 * its whole point, so fail fast here with an actionable message rather than
 * an obscure native stack trace three layers down.
 */
async function preflightNodePty(): Promise<void> {
  try {
    const nodePty = await import("node-pty");
    const probe = nodePty.spawn(process.execPath, ["-e", "process.exit(0)"], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("node-pty preflight spawn timed out")), 3000);
      probe.onExit(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  } catch (err) {
    console.error(
      "\nnode-pty preflight failed — every session spawn in this run would fail the same way.\n" +
        "This usually means the platform's spawn-helper binary landed without its executable bit\n" +
        "set (a known pnpm + node-pty interaction, even with onlyBuiltDependencies configured).\n" +
        "Try: pnpm rebuild node-pty — or manually chmod +x the spawn-helper under\n" +
        "node_modules/.pnpm/node-pty*/node_modules/node-pty/prebuilds/<platform>-<arch>/spawn-helper\n",
    );
    console.error(`Original error: ${err instanceof Error ? err.message : String(err)}\n`);
    throw err;
  }
}

async function main(): Promise<void> {
  await preflightNodePty();
  console.log("node-pty preflight ok");

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "harness-e2e-live-"));
  const projectDir = path.join(tmpRoot, "project");
  await fs.mkdir(projectDir, { recursive: true });
  // A sapiom.json marker here, in the CLI's launch directory, proves the
  // boot-time workflow scan (item 7 below) — it must be in place before
  // startServer() runs its one-shot scan of launchDir.
  await fs.writeFile(path.join(projectDir, "sapiom.json"), JSON.stringify({ definitionId: 4821 }));
  const collectorCwd = path.join(tmpRoot, "collector");
  await fs.mkdir(collectorCwd, { recursive: true });
  console.log(`scratch dir: ${tmpRoot}`);

  const bootToken = crypto.randomUUID();
  const captureFile = path.join(tmpRoot, "fake-claude-capture.json");
  const eventStorePath = path.join(tmpRoot, "events.ndjson");

  // SessionManager builds each spawned process's env starting from this
  // script's own process.env — setting it here is how the fixture (running
  // as a totally separate process) learns where to write its capture file.
  process.env.FAKE_CLAUDE_CAPTURE = captureFile;

  // --- spawn the real mock-collector.mjs as tonight's "remote" ---
  const mockCollector = spawn(
    process.execPath,
    [path.join(process.cwd(), "scripts", "mock-collector.mjs")],
    {
      cwd: collectorCwd,
      env: { ...process.env, MOCK_COLLECTOR_PORT: String(MOCK_COLLECTOR_PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let mockCollectorOutput = "";
  mockCollector.stdout.on("data", (chunk) => (mockCollectorOutput += chunk));
  mockCollector.stderr.on("data", (chunk) => (mockCollectorOutput += chunk));
  await waitFor(async () => (mockCollectorOutput.includes("listening on") ? true : undefined));
  console.log("mock-collector is up");

  const server = await startServer({
    port: 0,
    bootToken,
    telemetryOptIn: true,
    collectorUrl: `http://127.0.0.1:${MOCK_COLLECTOR_PORT}`,
    identity: { userId: "e2e-user", tenantId: "e2e-tenant", organizationName: "E2E Org", apiKey: "e2e-key" },
    machineId: "e2e-machine",
    adapters: {
      "claude-code": createClaudeCodeAdapter({ binary: FAKE_CLAUDE }),
      codex: createCodexAdapter(),
    },
    sessionsPath: path.join(tmpRoot, "sessions.json"),
    eventStorePath,
    workflowsRegistryPath: path.join(tmpRoot, "workflows.json"),
    launchDir: projectDir,
  });
  console.log(`harness server listening on http://127.0.0.1:${server.port}`);

  const baseUrl = `http://127.0.0.1:${server.port}`;
  const headers = { "Content-Type": "application/json", "X-Harness-Token": bootToken };
  let ws: WebSocket | undefined;

  try {
    // --- connect to /ws/events before anything happens, so we don't race the frames ---
    const wsMessages: Array<Record<string, unknown>> = [];
    ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws/events?token=${bootToken}`);
    ws.on("message", (data) => {
      try {
        wsMessages.push(JSON.parse(data.toString()));
      } catch {
        // ignore malformed frames
      }
    });
    await new Promise<void>((resolve, reject) => {
      ws!.once("open", () => resolve());
      ws!.once("error", reject);
    });
    console.log("connected to /ws/events");

    // --- 1. create a session; the claude-code adapter spawns FAKE_CLAUDE with the real injected flags ---
    const createRes = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ cwd: projectDir, harness: "claude-code" }),
    });
    assert(createRes.status === 201, "POST /api/sessions returns 201");
    const session = (await createRes.json()) as { id: string };
    const sessionId = session.id;
    console.log(`created session ${sessionId}`);

    // --- 2. the fixture captured its own argv/env — proves the launch-opts wiring ---
    const capture = await waitFor<FakeClaudeCapture>(async () => {
      try {
        return JSON.parse(await fs.readFile(captureFile, "utf8")) as FakeClaudeCapture;
      } catch {
        return undefined;
      }
    });

    const settingsIdx = capture.argv.indexOf("--settings");
    const mcpConfigIdx = capture.argv.indexOf("--mcp-config");
    const promptIdx = capture.argv.indexOf("--append-system-prompt");
    assert(settingsIdx !== -1, "launched with --settings");
    assert(mcpConfigIdx !== -1, "launched with --mcp-config");
    assert(promptIdx !== -1, "launched with --append-system-prompt");

    const settingsPath = capture.argv[settingsIdx + 1];
    const mcpConfigPath = capture.argv[mcpConfigIdx + 1];
    const systemPromptText = capture.argv[promptIdx + 1];
    assert(settingsPath?.includes(sessionId), "--settings path is scoped to this session");
    assert(mcpConfigPath?.includes(sessionId), "--mcp-config path is scoped to this session");
    assert((systemPromptText?.length ?? 0) > 0, "--append-system-prompt carries non-empty text");

    const settingsJson = JSON.parse(await fs.readFile(settingsPath, "utf8")) as { hooks?: Record<string, unknown> };
    assert(Object.keys(settingsJson.hooks ?? {}).length === 6, "generated settings.json registers all 6 hooks");

    const mcpConfigJson = JSON.parse(await fs.readFile(mcpConfigPath, "utf8")) as {
      mcpServers?: Record<string, { type?: string; command?: string }>;
    };
    assert(mcpConfigJson.mcpServers?.sapiom?.type === "http", "generated mcp-config registers the remote sapiom MCP");
    assert(
      mcpConfigJson.mcpServers?.["sapiom-dev"]?.command === "npx",
      "generated mcp-config registers the local sapiom-dev MCP",
    );

    assert(capture.env.SAPIOM_HARNESS_INGEST_URL?.endsWith("/ingest"), "pty env carries SAPIOM_HARNESS_INGEST_URL");
    assert(
      capture.env.SAPIOM_HARNESS_INGEST_TOKEN === bootToken,
      "pty env carries the boot token as SAPIOM_HARNESS_INGEST_TOKEN",
    );
    assert(capture.env.SAPIOM_HARNESS_SESSION_ID === sessionId, "pty env carries SAPIOM_HARNESS_SESSION_ID");

    // --- 3. wait for the session to report "running" (this is what starts the canvas watcher) ---
    await waitFor(async () => {
      const res = await fetch(`${baseUrl}/api/sessions`, { headers });
      const sessions = (await res.json()) as Array<{ id: string; status: string }>;
      return sessions.find((s) => s.id === sessionId)?.status === "running" ? true : undefined;
    });
    console.log("session reported running");

    // --- 4. write to the pty via /api/sessions/:id/input ---
    const inputRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/input`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "echo hi", submit: true }),
    });
    assert(inputRes.status === 200, "POST /api/sessions/:id/input returns 200");

    // --- 5. simulate SessionStart + a PostToolUse (tool.call with a localhost port) hook POST to /ingest ---
    const ingestHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${bootToken}` };
    const agentSessionId = "e2e-agent-session-1";

    const sessionStartRes = await fetch(`${baseUrl}/ingest`, {
      method: "POST",
      headers: ingestHeaders,
      body: JSON.stringify({
        hookEvent: "SessionStart",
        harnessSessionId: sessionId,
        payload: { session_id: agentSessionId, cwd: projectDir, source: "startup" },
      }),
    });
    assert(sessionStartRes.status === 200, "POST /ingest (SessionStart) returns 200");

    const toolCallRes = await fetch(`${baseUrl}/ingest`, {
      method: "POST",
      headers: ingestHeaders,
      body: JSON.stringify({
        hookEvent: "PostToolUse",
        harnessSessionId: sessionId,
        payload: {
          session_id: agentSessionId,
          tool_name: "Bash",
          tool_input: "npm run dev",
          tool_response: "ready - started server on http://localhost:5544",
        },
      }),
    });
    assert(toolCallRes.status === 200, "POST /ingest (PostToolUse) returns 200");

    // --- 6. assert both events landed in events.ndjson ---
    const eventLines = await waitFor(async () => {
      try {
        const content = await fs.readFile(eventStorePath, "utf8");
        const lines = content.trim().split("\n").filter(Boolean);
        return lines.length >= 2 ? lines : undefined;
      } catch {
        return undefined;
      }
    });
    const events = eventLines.map((line) => JSON.parse(line) as { type: string });
    assert(events.some((e) => e.type === "session.start"), "session.start event landed in events.ndjson");
    assert(events.some((e) => e.type === "tool.call"), "tool.call event landed in events.ndjson");

    // --- 7. assert the batch reached the mock collector (natural flush interval, no manual trigger available) ---
    const receivedFile = path.join(collectorCwd, "mock-collector-received.ndjson");
    const receivedLines = await waitFor(async () => {
      try {
        const content = await fs.readFile(receivedFile, "utf8");
        const lines = content.trim().split("\n").filter(Boolean);
        return lines.length >= 1 ? lines : undefined;
      } catch {
        return undefined;
      }
    }, 10_000);
    assert(receivedLines.length >= 1, "batch reached the mock collector");

    // --- 8. assert port.detected arrived on /ws/events from the tool.call above ---
    const portMsg = await waitFor(async () => {
      return wsMessages.find((m) => m.type === "port.detected" && m.harnessSessionId === sessionId);
    });
    assert(portMsg.port === 5544, "port.detected frame reports port 5544 from the tool.call output");
    assert(portMsg.url === "http://localhost:5544", "port.detected frame carries the right url");

    // --- 9. write to the session's canvas dir, assert canvas.reload arrives, and the file is served ---
    const canvasDir = path.join(projectDir, ".sapiom", "canvas");
    await fs.mkdir(canvasDir, { recursive: true });
    await fs.writeFile(path.join(canvasDir, "index.html"), "<html><body>e2e</body></html>");

    await waitFor(async () => {
      return wsMessages.find((m) => m.type === "canvas.reload" && m.harnessSessionId === sessionId);
    });
    console.log("canvas.reload frame received");

    const canvasRes = await fetch(`${baseUrl}/canvas/${sessionId}/`);
    assert(canvasRes.status === 200, "GET /canvas/:id/ serves the written index.html");
    assert((await canvasRes.text()).includes("e2e"), "served canvas content matches what was written");

    // --- 10. run the visualize macro (inject kind) — proves the macro engine reaches the pty ---
    const macroRes = await fetch(`${baseUrl}/api/macros/visualize/run`, {
      method: "POST",
      headers,
      body: JSON.stringify({ harnessSessionId: sessionId, subject: "the e2e proof" }),
    });
    assert(macroRes.status === 200, "POST /api/macros/visualize/run returns 200");
    const macroBody = (await macroRes.json()) as { ok: boolean };
    assert(macroBody.ok === true, "macro run responds { ok: true }");

    // --- 11. the launch directory's sapiom.json (written before startServer) was scanned at boot ---
    // Note: WorkflowInfo.name comes from package.json (or the directory's own
    // basename) — the sapiom.json marker itself only carries definitionId —
    // so that's what distinguishes "found the real marker" from "found some
    // other directory".
    type WorkflowInfoLike = { name: string; path: string; definitionId: number | null };
    const bootWorkflows = await waitFor(async () => {
      const res = await fetch(`${baseUrl}/api/workflows`, { headers });
      const workflows = (await res.json()) as WorkflowInfoLike[];
      return workflows.some((w) => w.path === projectDir) ? workflows : undefined;
    });
    assert(
      bootWorkflows.some((w) => w.path === projectDir && w.definitionId === 4821),
      "boot-time scan of the CLI's launch directory discovered its sapiom.json (definitionId read from the marker)",
    );

    // --- 12. opening a session in a brand-new directory scans it too, and broadcasts workflows.changed ---
    const secondProjectDir = path.join(tmpRoot, "second-project");
    await fs.mkdir(secondProjectDir, { recursive: true });
    await fs.writeFile(path.join(secondProjectDir, "sapiom.json"), JSON.stringify({ definitionId: 9001 }));

    const workflowsChangedBefore = wsMessages.filter((m) => m.type === "workflows.changed").length;
    const secondSessionRes = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ cwd: secondProjectDir, harness: "claude-code" }),
    });
    assert(secondSessionRes.status === 201, "POST /api/sessions (second directory) returns 201");

    await waitFor(async () => {
      const count = wsMessages.filter((m) => m.type === "workflows.changed").length;
      return count > workflowsChangedBefore ? true : undefined;
    });
    console.log("workflows.changed frame received for the new session directory");

    const afterSecondSession = await waitFor(async () => {
      const res = await fetch(`${baseUrl}/api/workflows`, { headers });
      const workflows = (await res.json()) as WorkflowInfoLike[];
      return workflows.some((w) => w.path === secondProjectDir) ? workflows : undefined;
    });
    assert(
      afterSecondSession.some((w) => w.path === secondProjectDir && w.definitionId === 9001),
      "creating a session in a new directory scanned and discovered its sapiom.json",
    );

    console.log("\nPASS — live integration proof succeeded\n");
  } finally {
    ws?.close();
    await server.close();
    mockCollector.kill();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

// Explicit exit: the harness session's pty child (fake-claude) deliberately
// stays alive and is not torn down by server.close(), so without this the
// script hangs forever after PASS — which stalls any runner that awaits it.
main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
