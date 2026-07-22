#!/usr/bin/env -S npx tsx
/**
 * End-to-end simulation of the analytics pipeline WITHOUT running `claude`.
 *
 * Pipes fixture SessionStart + UserPromptSubmit hook payloads into a
 * generated emit.cjs (exactly the way Claude Code would invoke it), against
 * a real HTTP server mounting createIngestRouter, and asserts:
 *   1. Both events land in the local ndjson store.
 *   2. The harness emitter forwards them to startMockCollector() from
 *      @sapiom/analytics-core/testing, using the analytics-core envelope
 *      (POST /v1/analytics/collector, source "harness", analytics-core fields).
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

import { startMockCollector } from "@sapiom/analytics-core/testing";
import { generateClaudeSettings } from "../src/core/inject/claude-settings.js";
import { normalizeHookEvent } from "../src/core/collector/normalizer.js";
import { enrichTurnCompleted } from "../src/core/collector/transcript.js";
import { createEventStore } from "../src/core/collector/store.js";
import { createHarnessEmitter } from "../src/core/collector/analytics-emitter.js";
import { createIngestRouter, type IngestSessionContext } from "../src/server/ingest.js";
import { ENV, type CollectorContext } from "../src/shared/types.js";

const INGEST_TOKEN = crypto.randomUUID();
const HARNESS_SESSION_ID = "sim-session-1";
const AGENT_SESSION_ID = "sim-agent-uuid-1";

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
  await fs.mkdir(generatedRoot, { recursive: true });

  console.log(`scratch dir: ${tmpRoot}`);

  // --- start the analytics-core mock collector ---
  const mockCollector = await startMockCollector();
  // Clear the global test guard so the emitter actually sends.
  delete process.env.SAPIOM_TELEMETRY_DISABLED;

  console.log(`mock collector listening on ${mockCollector.url}`);

  // --- wire the local store + emitter + ingest router (stand-in for the real server) ---
  const store = createEventStore(eventsFile);
  const sessions = new Map<string, IngestSessionContext>([
    [
      HARNESS_SESSION_ID,
      {
        harness: "claude-code",
        userId: "sim-user",
        tenantId: "sim-tenant",
        machineId: "sim-machine",
        agentSessionId: null,
      },
    ],
  ]);

  const collectorContext: CollectorContext = {
    harnessVersion: "0.0.1",
    os: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
  };

  // Use a temp HOME so analytics.json is created in scratch, not in ~/.sapiom.
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpRoot;
  process.env.USERPROFILE = tmpRoot;

  const batcher = createHarnessEmitter({
    telemetryOptIn: true,
    context: collectorContext,
    sdkName: "@sapiom/harness",
    sdkVersion: "0.0.1",
    // Point directly at the in-process mock collector.
    endpoint: mockCollector.url,
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
    assert(events[0].tenantId === "sim-tenant", "session.start carries tenantId from server-side context");
    assert(events[0].seq === 1, "session.start got seq 1");
    assert(events[1].type === "prompt.submitted", "second event is prompt.submitted");
    assert(events[1].payload.prompt === "build me a workflow", "prompt text made it through the pipeline");
    assert(events[1].seq === 2, "prompt.submitted got seq 2 (monotonic per harnessSessionId)");
    assert(sessions.get(HARNESS_SESSION_ID)?.agentSessionId === AGENT_SESSION_ID, "session registry callback linked agentSessionId");

    // --- force a batch flush and assert the analytics-core mock collector received it ---
    await batcher.flush();
    await mockCollector.waitForRequests(1, 10_000);

    const collectorEvents = mockCollector.events();
    assert(collectorEvents.length >= 2, `mock collector received at least 2 events (got ${collectorEvents.length})`);

    // Assert analytics-core envelope shape
    for (const ev of collectorEvents) {
      assert(ev.source === "harness", `event source is "harness" (got ${String(ev.source)})`);
      assert(typeof ev.session_id === "string", `event has session_id (got ${String(ev.session_id)})`);
      assert(ev.sdk_name === "@sapiom/harness", `event sdk_name is @sapiom/harness (got ${String(ev.sdk_name)})`);
      assert(ev.schema_version === "1", `event schema_version is "1" (got ${String(ev.schema_version)})`);
    }

    const eventTypes = collectorEvents.map((e) => e.event_type);
    assert(eventTypes.includes("session.start"), "collector received a session.start event");
    assert(eventTypes.includes("prompt.submitted"), "collector received a prompt.submitted event");

    // Assert harness-specific data fields
    const sessionStartEv = collectorEvents.find((e) => e.event_type === "session.start");
    const data = sessionStartEv?.data as Record<string, unknown> | undefined;
    assert(data?.harness_session_id === HARNESS_SESSION_ID, `data.harness_session_id is ${HARNESS_SESSION_ID}`);
    assert(data?.harness_kind === "claude-code", `data.harness_kind is "claude-code"`);
    assert(typeof data?.context === "object" && data.context !== null, "data.context is present");
    const ctx = data?.context as Record<string, unknown>;
    assert(ctx.app_version === "0.0.1", `data.context.app_version is "0.0.1"`);

    // seq monotonic
    const seqs = collectorEvents.map((e) => (e.data as Record<string, unknown>)?.seq as number);
    assert(seqs.includes(1), "collector received event with seq=1");
    assert(seqs.includes(2), "collector received event with seq=2");

    console.log("\nPASS — analytics pipeline e2e simulation succeeded\n");
  } finally {
    await batcher.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await mockCollector.close();
    // Restore env
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    process.env.SAPIOM_TELEMETRY_DISABLED = "1";
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
