#!/usr/bin/env -S npx tsx
/**
 * End-to-end simulation of the analytics pipeline WITHOUT running `claude`.
 *
 * Pipes fixture SessionStart + UserPromptSubmit hook payloads into a
 * generated emit.cjs (exactly the way Claude Code would invoke it), against
 * a real HTTP server mounting createIngestRouter, and asserts:
 *   1. Both events land in the local ndjson store.
 *   2. The batcher forwards them to a real mock-collector.mjs process, and
 *      the batch shows up in its received-events file.
 *
 * Run with: pnpm sim:e2e
 */

import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import express from "express";
import * as fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { generateClaudeSettings } from "../src/core/inject/claude-settings.js";
import { normalizeHookEvent } from "../src/core/collector/normalizer.js";
import { enrichTurnCompleted } from "../src/core/collector/transcript.js";
import { createEventStore } from "../src/core/collector/store.js";
import { CollectorBatcher } from "../src/core/collector/batcher.js";
import { createIngestRouter, type IngestSessionContext } from "../src/server/ingest.js";
import { ENV } from "../src/shared/types.js";

const INGEST_TOKEN = crypto.randomUUID();
const HARNESS_SESSION_ID = "sim-session-1";
const AGENT_SESSION_ID = "sim-agent-uuid-1";
const MOCK_COLLECTOR_PORT = 4299; // distinct from the default 4199 to avoid clashing with a real one.

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
    throw new Error(message);
  }
  console.log(`ok - ${message}`);
}

function runNode(script: string, args: string[], stdin: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} ${args.join(" ")} exited ${code}: ${stderr}`));
    });
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await fn();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("waitFor timed out");
}

async function main(): Promise<void> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "harness-e2e-sim-"));
  const eventsFile = path.join(tmpRoot, "events.ndjson");
  const generatedRoot = path.join(tmpRoot, "generated");
  const collectorCwd = path.join(tmpRoot, "collector");
  await fs.mkdir(collectorCwd, { recursive: true });

  console.log(`scratch dir: ${tmpRoot}`);

  // --- wire the local store + batcher + ingest router (stand-in for the real server) ---
  const store = createEventStore(eventsFile);
  const sessions = new Map<string, IngestSessionContext>([
    [
      HARNESS_SESSION_ID,
      { harness: "claude-code", userId: "sim-user", machineId: "sim-machine", agentSessionId: null },
    ],
  ]);

  const collectorUrl = `http://127.0.0.1:${MOCK_COLLECTOR_PORT}`;
  const batcher = new CollectorBatcher({
    machineId: "sim-machine",
    telemetryOptIn: true,
    collectorUrl,
    maxBatchSize: 50,
    flushIntervalMs: 60_000, // we flush manually below
    onDebug: (msg) => console.log(`[batcher] ${msg}`),
  });

  const app = express();
  app.use(
    createIngestRouter({
      ingestToken: INGEST_TOKEN,
      normalize: normalizeHookEvent,
      resolveSession: (id) => sessions.get(id),
      onAgentSessionResolved: (harnessSessionId, agentSessionId) => {
        const session = sessions.get(harnessSessionId);
        if (session) session.agentSessionId = agentSessionId;
        console.log(`[ingest] linked ${harnessSessionId} -> agentSessionId ${agentSessionId}`);
      },
      store,
      batcher,
      enrichFromTranscript: enrichTurnCompleted,
      onError: (err) => console.error("[ingest] error", err),
    }),
  );
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  console.log(`ingest server listening on http://127.0.0.1:${port}`);

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
  mockCollector.stdout.on("data", (chunk) => {
    mockCollectorOutput += chunk;
  });
  mockCollector.stderr.on("data", (chunk) => {
    mockCollectorOutput += chunk;
  });
  await waitFor(async () => (mockCollectorOutput.includes("listening on") ? true : undefined));
  console.log("mock-collector is up");

  try {
    // --- generate the settings + emit.cjs exactly like the real launch flow would ---
    const { emitScriptPath } = await generateClaudeSettings({
      harnessSessionId: HARNESS_SESSION_ID,
      generatedRoot,
    });
    console.log(`generated emit script: ${emitScriptPath}`);

    const hookEnv: NodeJS.ProcessEnv = {
      ...process.env,
      [ENV.ingestUrl]: `http://127.0.0.1:${port}/ingest`,
      [ENV.ingestToken]: INGEST_TOKEN,
      [ENV.sessionId]: HARNESS_SESSION_ID,
    };

    // --- pipe fixture hook payloads into emit.cjs, exactly as Claude Code would invoke it ---
    await runNode(
      emitScriptPath,
      ["SessionStart"],
      JSON.stringify({
        session_id: AGENT_SESSION_ID,
        transcript_path: "/dev/null",
        cwd: "/tmp/sim-project",
        hook_event_name: "SessionStart",
        source: "startup",
      }),
      hookEnv,
    );
    console.log("piped SessionStart through emit.cjs");

    await runNode(
      emitScriptPath,
      ["UserPromptSubmit"],
      JSON.stringify({
        session_id: AGENT_SESSION_ID,
        transcript_path: "/dev/null",
        cwd: "/tmp/sim-project",
        hook_event_name: "UserPromptSubmit",
        prompt: "build me a workflow",
      }),
      hookEnv,
    );
    console.log("piped UserPromptSubmit through emit.cjs");

    // --- assert the local ndjson store ---
    const lines = await waitFor(async () => {
      try {
        const content = await fs.readFile(eventsFile, "utf8");
        const parsed = content.trim().split("\n").filter(Boolean);
        return parsed.length >= 2 ? parsed : undefined;
      } catch {
        return undefined;
      }
    });
    const events = lines.map((l) => JSON.parse(l));
    assert(events.length === 2, "exactly 2 events appended to events.ndjson");
    assert(events[0].type === "session.start", "first event is session.start");
    assert(events[0].agentSessionId === AGENT_SESSION_ID, "session.start captured the agent session id");
    assert(events[1].type === "prompt.submitted", "second event is prompt.submitted");
    assert(events[1].payload.prompt === "build me a workflow", "prompt text made it through the pipeline");
    assert(sessions.get(HARNESS_SESSION_ID)?.agentSessionId === AGENT_SESSION_ID, "session registry callback linked agentSessionId");

    // --- force a batch flush and assert the mock collector received it ---
    await batcher.flush();
    const receivedFile = path.join(collectorCwd, "mock-collector-received.ndjson");
    const receivedLines = await waitFor(async () => {
      try {
        const content = await fs.readFile(receivedFile, "utf8");
        const parsed = content.trim().split("\n").filter(Boolean);
        return parsed.length >= 1 ? parsed : undefined;
      } catch {
        return undefined;
      }
    });
    const batch = JSON.parse(receivedLines[receivedLines.length - 1]);
    assert(batch.machineId === "sim-machine", "mock-collector received the right machineId");
    assert(batch.events.length === 2, "mock-collector received both events in one batch");
    assert(
      mockCollectorOutput.includes("session.start=1") || mockCollectorOutput.includes("prompt.submitted=1"),
      "mock-collector logged a batch summary",
    );

    console.log("\nPASS — analytics pipeline e2e simulation succeeded\n");
  } finally {
    await batcher.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    mockCollector.kill();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
