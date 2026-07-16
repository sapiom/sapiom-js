/**
 * Integration tests for CLI passthrough mode (cli/passthrough.ts) against
 * real fixture binaries — no mocking of the ingest pipeline, adapters, or
 * inject generators. A fake `claude` proves the hook-POST path end to end
 * (argv/env injection, events.ndjson, exit-code propagation, generated-dir
 * cleanup); a fake `codex` plus a hand-written rollout file proves the
 * transcript-tail path (discovery, tailing, synthesized SessionEnd).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIRST_RUN_NOTICE } from "@sapiom/analytics-core";
import { startMockCollector } from "@sapiom/analytics-core/testing";

import { runPassthrough } from "./passthrough.js";
import { createClaudeCodeAdapter } from "../core/adapters/claude-code.js";
import { createCodexAdapter } from "../core/adapters/codex.js";
import { CLI_SYSTEM_PROMPT } from "../profiles/default.js";
import type { AnalyticsEvent } from "../shared/types.js";
import type { PassthroughInvocation } from "./passthrough-args.js";
import type { RunPassthroughOverrides } from "./passthrough.js";
import type { HarnessIdentity } from "./auth.js";

/**
 * Fixture "claude": handles the adapter's doctor() probe (--version), then
 * captures the argv/env it was launched with (plus the generated mcp-config's
 * content, which is deleted before the runner returns), POSTs the same
 * SessionStart/Stop/SessionEnd sequence a real session's hooks would, and
 * exits with a chosen code.
 */
const FAKE_CLAUDE_SOURCE = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

if (process.argv.includes("--version")) {
  console.log("fake-claude 0.0.1 (test fixture)");
  process.exit(0);
}

const argv = process.argv.slice(2);
let mcpConfig = null;
const mcpConfigIndex = argv.indexOf("--mcp-config");
if (mcpConfigIndex !== -1 && argv[mcpConfigIndex + 1]) {
  try {
    mcpConfig = readFileSync(argv[mcpConfigIndex + 1], "utf8");
  } catch {
    // leave null
  }
}

writeFileSync(
  process.env.FAKE_CLAUDE_CAPTURE,
  JSON.stringify({
    argv,
    env: {
      SAPIOM_HARNESS_INGEST_URL: process.env.SAPIOM_HARNESS_INGEST_URL ?? null,
      SAPIOM_HARNESS_INGEST_TOKEN: process.env.SAPIOM_HARNESS_INGEST_TOKEN ?? null,
      SAPIOM_HARNESS_SESSION_ID: process.env.SAPIOM_HARNESS_SESSION_ID ?? null,
    },
    claudecodePresent: "CLAUDECODE" in process.env,
    mcpConfig,
  }),
);

const url = process.env.SAPIOM_HARNESS_INGEST_URL;
const token = process.env.SAPIOM_HARNESS_INGEST_TOKEN;
const sessionId = process.env.SAPIOM_HARNESS_SESSION_ID;
const post = (hookEvent, payload) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: JSON.stringify({ hookEvent, harnessSessionId: sessionId, payload }),
  });

await post("SessionStart", { source: "startup", session_id: "agent-session-1", cwd: process.cwd() });
await post("Stop", { stop_hook_active: false, last_assistant_message: "all done" });
await post("SessionEnd", { reason: "prompt_input_exit" });

process.exit(Number(process.env.FAKE_CLAUDE_EXIT_CODE ?? "0"));
`;

/**
 * Fixture "codex": handles --version, then idles (like an interactive TUI)
 * until the test signals it to exit by creating $FAKE_CODEX_EXIT_FILE —
 * Codex itself never POSTs anything; all analytics come from the rollout
 * file the test writes, via the tailer.
 */
const FAKE_CODEX_SOURCE = `#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";

if (process.argv.includes("--version")) {
  console.log("fake-codex 0.0.1 (test fixture)");
  process.exit(0);
}

// Tell the test the interactive process is actually up — the rollout file
// it writes must be timestamped AFTER the harness's spawn wall-clock or
// discovery's sinceMs filter would (correctly) skip it as a prior session.
if (process.env.FAKE_CODEX_SPAWNED_FILE) {
  writeFileSync(process.env.FAKE_CODEX_SPAWNED_FILE, "");
}

const exitFile = process.env.FAKE_CODEX_EXIT_FILE;
const startedAt = Date.now();
const timer = setInterval(() => {
  if ((exitFile && existsSync(exitFile)) || Date.now() - startedAt > 15_000) {
    clearInterval(timer);
    process.exit(0);
  }
}, 50);
`;

/**
 * Fixture "noisy claude": before its normal hook sequence it sends the two
 * request shapes that make express's default finalhandler stack-trace to
 * stderr — a truncated JSON body (SyntaxError → 400) and a body over
 * express.json's 1mb limit (PayloadTooLargeError → 413). The passthrough
 * error middleware must swallow both into deferredErrors instead.
 */
const FAKE_NOISY_CLAUDE_SOURCE = `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("fake-noisy-claude 0.0.1 (test fixture)");
  process.exit(0);
}

const url = process.env.SAPIOM_HARNESS_INGEST_URL;
const token = process.env.SAPIOM_HARNESS_INGEST_TOKEN;
const sessionId = process.env.SAPIOM_HARNESS_SESSION_ID;
const headers = { "content-type": "application/json", authorization: "Bearer " + token };
// The server may reset the socket on the oversized body — that's fine.
const tryPost = async (body) => {
  try {
    await fetch(url, { method: "POST", headers, body });
  } catch {}
};

await tryPost('{"hookEvent": "SessionStart", "harnessSessi'); // truncated JSON
await tryPost(
  JSON.stringify({
    hookEvent: "PostToolUse",
    harnessSessionId: sessionId,
    payload: { big: "x".repeat(1100 * 1024) },
  }),
); // > 1mb

const post = (hookEvent, payload) =>
  fetch(url, { method: "POST", headers, body: JSON.stringify({ hookEvent, harnessSessionId: sessionId, payload }) });
await post("SessionStart", { source: "startup", session_id: "agent-session-1", cwd: process.cwd() });
await post("Stop", { stop_hook_active: false, last_assistant_message: "all done" });
await post("SessionEnd", { reason: "prompt_input_exit" });
process.exit(0);
`;

/**
 * Fixture "fast-exit codex": signals it's up, then exits immediately —
 * before rollout discovery can possibly attach. Models a codex startup
 * failure or an instant user quit.
 */
const FAKE_CODEX_FAST_EXIT_SOURCE = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";

if (process.argv.includes("--version")) {
  console.log("fake-codex 0.0.1 (test fixture)");
  process.exit(0);
}

if (process.env.FAKE_CODEX_SPAWNED_FILE) {
  writeFileSync(process.env.FAKE_CODEX_SPAWNED_FILE, "");
}
process.exit(0);
`;

interface Capture {
  argv: string[];
  env: Record<string, string | null>;
  claudecodePresent: boolean;
  mcpConfig: string | null;
}

async function readEvents(eventStorePath: string): Promise<AnalyticsEvent[]> {
  try {
    const content = await readFile(eventStorePath, "utf8");
    return content
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as AnalyticsEvent);
  } catch {
    return [];
  }
}

function sessionMetaLine(id: string, cwd: string, timestamp: string): string {
  return JSON.stringify({ timestamp, type: "session_meta", payload: { id, timestamp, cwd } }) + "\n";
}
function userMessageLine(message: string): string {
  return JSON.stringify({ type: "event_msg", payload: { type: "user_message", message } }) + "\n";
}
function taskCompleteLine(): string {
  return JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }) + "\n";
}

describe("runPassthrough", () => {
  let dir: string;
  let cwd: string;
  let generatedRoot: string;
  let eventStorePath: string;
  let captureFile: string;
  const savedEnv: Record<string, string | undefined> = {};

  const claudeInvocation = (extra: Partial<PassthroughInvocation> = {}): PassthroughInvocation => ({
    kind: "claude-code",
    agent: "claude",
    agentArgs: [],
    noAuth: true,
    noTelemetry: true,
    ...extra,
  });

  const baseOverrides = (extra: Partial<RunPassthroughOverrides> = {}): RunPassthroughOverrides => ({
    cwd,
    generatedRoot,
    eventStorePath,
    machineIdPath: join(dir, "machine-id"),
    analyticsJsonPath: join(dir, "analytics.json"),
    telemetryOptIn: false,
    stdio: "ignore",
    exitDrainMs: 250,
    ...extra,
  });

  async function writeFixture(name: string, source: string): Promise<string> {
    const fixturePath = join(dir, name);
    await writeFile(fixturePath, source, { mode: 0o755 });
    return fixturePath;
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "harness-passthrough-"));
    // The safety guard in removeGeneratedSessionDir requires the root's
    // basename to literally be "generated" — same shape as the real default.
    generatedRoot = join(dir, "generated");
    eventStorePath = join(dir, "events.ndjson");
    cwd = join(dir, "project");
    captureFile = join(dir, "capture.json");
    await mkdir(cwd, { recursive: true });
    // Pre-existing analytics.json makes migrateHarnessIdentity a no-op, so a
    // test run never seeds the developer's real ~/.sapiom/analytics.json.
    await writeFile(join(dir, "analytics.json"), "{}\n", "utf8");
    for (const key of [
      "FAKE_CLAUDE_CAPTURE",
      "FAKE_CLAUDE_EXIT_CODE",
      "FAKE_CODEX_EXIT_FILE",
      "FAKE_CODEX_SPAWNED_FILE",
      "CLAUDECODE",
    ]) {
      savedEnv[key] = process.env[key];
    }
    process.env.FAKE_CLAUDE_CAPTURE = captureFile;
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  });

  describe("claude-code (hooks path)", () => {
    it("injects config flags + env, records the session's events, propagates exit code 0, and cleans up", async () => {
      // Prove the CLAUDECODE unset actually happens (the harness itself may
      // or may not be running inside a Claude Code session).
      process.env.CLAUDECODE = "1";
      const binary = await writeFixture("fake-claude.mjs", FAKE_CLAUDE_SOURCE);

      const exitCode = await runPassthrough(
        claudeInvocation({ agentArgs: ["--model", "opus"] }),
        baseOverrides({ adapters: { "claude-code": createClaudeCodeAdapter({ binary }) } }),
      );
      expect(exitCode).toBe(0);

      const capture = JSON.parse(await readFile(captureFile, "utf8")) as Capture;

      // --- argv: the injected config flags plus the user's verbatim args ---
      expect(capture.argv).toContain("--settings");
      expect(capture.argv).toContain("--mcp-config");
      const promptIndex = capture.argv.indexOf("--append-system-prompt");
      expect(promptIndex).toBeGreaterThan(-1);
      const prompt = capture.argv[promptIndex + 1]!;
      expect(prompt).toBe(CLI_SYSTEM_PROMPT);
      expect(prompt.toLowerCase()).not.toContain("canvas");
      expect(capture.argv.slice(-2)).toEqual(["--model", "opus"]);

      // --- env: the SAPIOM_HARNESS_* trio present, CLAUDECODE unset ---
      expect(capture.env.SAPIOM_HARNESS_INGEST_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/ingest$/);
      expect(capture.env.SAPIOM_HARNESS_INGEST_TOKEN).toMatch(/^[0-9a-f]{64}$/);
      const harnessSessionId = capture.env.SAPIOM_HARNESS_SESSION_ID;
      expect(harnessSessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(capture.claudecodePresent).toBe(false);

      // --- events.ndjson: the session's lifecycle, seq-ordered ---
      const events = await readEvents(eventStorePath);
      expect(events.map((e) => e.type)).toEqual(["session.start", "turn.completed", "session.end"]);
      expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
      for (const event of events) {
        expect(event.harnessSessionId).toBe(harnessSessionId);
        expect(event.harness).toBe("claude-code");
        expect(event.agentSessionId).toBe("agent-session-1");
        expect(event.userId).toBeNull();
      }
      expect(events[1]!.payload).toMatchObject({ assistantText: "all done" });

      // --- --no-auth: the generated mcp-config carries no API key ---
      expect(capture.mcpConfig).not.toBeNull();
      expect(capture.mcpConfig).not.toContain("x-api-key");

      // --- generated/<id> removed after exit ---
      await expect(readdir(generatedRoot)).resolves.toEqual([]);
    }, 20_000);

    it("propagates a non-zero child exit code", async () => {
      const binary = await writeFixture("fake-claude.mjs", FAKE_CLAUDE_SOURCE);
      process.env.FAKE_CLAUDE_EXIT_CODE = "3";

      const exitCode = await runPassthrough(
        claudeInvocation(),
        baseOverrides({ adapters: { "claude-code": createClaudeCodeAdapter({ binary }) } }),
      );
      expect(exitCode).toBe(3);
    }, 20_000);

    it("an injected identity's api key lands in the generated mcp-config", async () => {
      const binary = await writeFixture("fake-claude.mjs", FAKE_CLAUDE_SOURCE);
      const identity: HarnessIdentity = {
        userId: "user-1",
        tenantId: "tenant-1",
        organizationName: "Test Org",
        apiKey: "sk_test_passthrough",
        source: "cached",
      };

      const exitCode = await runPassthrough(
        claudeInvocation(),
        baseOverrides({ adapters: { "claude-code": createClaudeCodeAdapter({ binary }) }, identity }),
      );
      expect(exitCode).toBe(0);

      const capture = JSON.parse(await readFile(captureFile, "utf8")) as Capture;
      expect(capture.mcpConfig).toContain('"x-api-key": "sk_test_passthrough"');

      const events = await readEvents(eventStorePath);
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) {
        expect(event.userId).toBe("user-1");
        expect(event.tenantId).toBe("tenant-1");
      }
    }, 20_000);

    it("teardown is a completion barrier, not a sleep: every event lands even with a zero drain window", async () => {
      const binary = await writeFixture("fake-claude.mjs", FAKE_CLAUDE_SOURCE);

      const exitCode = await runPassthrough(
        claudeInvocation(),
        baseOverrides({
          adapters: { "claude-code": createClaudeCodeAdapter({ binary }) },
          // With a fixed-sleep drain this would race the fire-and-forget
          // ingest processing; the pendingIngests barrier makes it exact.
          exitDrainMs: 0,
        }),
      );
      expect(exitCode).toBe(0);

      const events = await readEvents(eventStorePath);
      expect(events.map((e) => e.type)).toEqual(["session.start", "turn.completed", "session.end"]);
      expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    }, 20_000);

    it("buffers ingest HTTP errors (oversized/malformed bodies) — express never stack-traces onto the terminal", async () => {
      const binary = await writeFixture("fake-noisy-claude.mjs", FAKE_NOISY_CLAUDE_SOURCE);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const exitCode = await runPassthrough(
          claudeInvocation(),
          baseOverrides({ adapters: { "claude-code": createClaudeCodeAdapter({ binary }) } }),
        );
        expect(exitCode).toBe(0);

        const consoleOut = errorSpy.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
        const stderrOut = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
        // No raw express stack trace anywhere (finalhandler prints
        // multi-line "    at ..." frames when no error middleware exists)…
        expect(consoleOut + stderrOut).not.toMatch(/\n\s+at /);
        // …the failures surface as deferred [harness] lines after exit.
        expect(consoleOut).toContain("[harness] ingest http error");
      } finally {
        errorSpy.mockRestore();
        stderrSpy.mockRestore();
      }

      // The well-formed events around the bad requests still landed.
      const events = await readEvents(eventStorePath);
      expect(events.map((e) => e.type)).toEqual(["session.start", "turn.completed", "session.end"]);
    }, 20_000);

    it("mirrors the server's boot sweeps: prunes >30-day events.ndjson lines and stale generated dirs", async () => {
      const binary = await writeFixture("fake-claude.mjs", FAKE_CLAUDE_SOURCE);

      // An events.ndjson line past the 30-day age cap…
      const staleTs = "2020-01-01T00:00:00.000Z";
      await writeFile(eventStorePath, JSON.stringify({ ts: staleTs, type: "session.start" }) + "\n");
      // …and a generated dir orphaned by a (simulated) crash 8 days ago.
      const orphanDir = join(generatedRoot, "00000000-dead-4bee-8888-000000000000");
      await mkdir(orphanDir, { recursive: true });
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      await utimes(orphanDir, eightDaysAgo, eightDaysAgo);

      const exitCode = await runPassthrough(
        claudeInvocation(),
        baseOverrides({ adapters: { "claude-code": createClaudeCodeAdapter({ binary }) } }),
      );
      expect(exitCode).toBe(0);

      const events = await readEvents(eventStorePath);
      expect(events.some((e) => e.ts === staleTs)).toBe(false);
      expect(events.map((e) => e.type)).toEqual(["session.start", "turn.completed", "session.end"]);
      expect(existsSync(orphanDir)).toBe(false);
      await expect(readdir(generatedRoot)).resolves.toEqual([]);
    }, 20_000);

    it("prints the analytics first-run notice pre-spawn, never into the child's terminal window", async () => {
      const binary = await writeFixture("fake-claude.mjs", FAKE_CLAUDE_SOURCE);
      const collector = await startMockCollector();
      const homeDir = join(dir, "home");
      await mkdir(homeDir, { recursive: true });
      const prevEnv = {
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
        SAPIOM_TELEMETRY_DISABLED: process.env.SAPIOM_TELEMETRY_DISABLED,
        SAPIOM_ANALYTICS_ENDPOINT: process.env.SAPIOM_ANALYTICS_ENDPOINT,
      };
      // Opt in for real: fresh HOME (no first-run marker), env guard cleared,
      // delivery redirected to a mock collector.
      process.env.HOME = homeDir;
      process.env.USERPROFILE = homeDir;
      delete process.env.SAPIOM_TELEMETRY_DISABLED;
      process.env.SAPIOM_ANALYTICS_ENDPOINT = collector.url;
      const stderrWrites: string[] = [];
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        stderrWrites.push(String(chunk));
        return true;
      });
      try {
        const exitCode = await runPassthrough(
          claudeInvocation(),
          baseOverrides({
            adapters: { "claude-code": createClaudeCodeAdapter({ binary }) },
            telemetryOptIn: true,
          }),
        );
        expect(exitCode).toBe(0);

        const noticeIndex = stderrWrites.findIndex((w) => w.includes(FIRST_RUN_NOTICE));
        const bannerIndex = stderrWrites.findIndex((w) => w.includes("sapiom harness →"));
        // Printed exactly once, and BEFORE the banner that immediately
        // precedes spawn — i.e. while the parent still owned the terminal.
        expect(stderrWrites.filter((w) => w.includes(FIRST_RUN_NOTICE))).toHaveLength(1);
        expect(bannerIndex).toBeGreaterThan(-1);
        expect(noticeIndex).toBeGreaterThan(-1);
        expect(noticeIndex).toBeLessThan(bannerIndex);

        // Marker persisted: no later process reprints it.
        const record = JSON.parse(
          await readFile(join(homeDir, ".sapiom", "analytics.json"), "utf8"),
        ) as { first_run_notice_at: string | null };
        expect(typeof record.first_run_notice_at).toBe("string");
      } finally {
        stderrSpy.mockRestore();
        for (const [key, value] of Object.entries(prevEnv)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        await collector.close();
      }
    }, 20_000);

    it("returns 1 when doctor fails (binary missing), without spawning anything", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const exitCode = await runPassthrough(
          claudeInvocation(),
          baseOverrides({
            adapters: { "claude-code": createClaudeCodeAdapter({ binary: join(dir, "no-such-binary") }) },
          }),
        );
        expect(exitCode).toBe(1);
        const printed = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
        expect(printed).toContain("npm i -g @anthropic-ai/claude-code");
      } finally {
        errorSpy.mockRestore();
      }
      // Nothing ran: no capture, no events.
      await expect(readFile(captureFile, "utf8")).rejects.toThrow();
      expect(await readEvents(eventStorePath)).toEqual([]);
    }, 20_000);
  });

  describe("codex (transcript-tail path)", () => {
    it("discovers + tails the rollout file and synthesizes SessionEnd on exit", async () => {
      const binary = await writeFixture("fake-codex.mjs", FAKE_CODEX_SOURCE);
      const codexHomeDir = join(dir, "codex-home");
      const rolloutDir = join(codexHomeDir, ".codex", "sessions", "2026", "07", "15");
      await mkdir(rolloutDir, { recursive: true });
      const exitFile = join(dir, "codex-exit-signal");
      const spawnedFile = join(dir, "codex-spawned");
      process.env.FAKE_CODEX_EXIT_FILE = exitFile;
      process.env.FAKE_CODEX_SPAWNED_FILE = spawnedFile;

      const run = runPassthrough(
        { kind: "codex", agent: "codex", agentArgs: [], noAuth: true, noTelemetry: true },
        baseOverrides({
          adapters: { codex: createCodexAdapter({ binary }) },
          codexHomeDir,
          rolloutDiscoveryPollMs: 50,
          rolloutDiscoveryTimeoutMs: 5_000,
          // Must exceed the tailer's 300ms poll so lines appended just
          // before exit are drained before SessionEnd is synthesized.
          exitDrainMs: 700,
        }),
      );

      // Wait until the fake codex process is actually up — the rollout's
      // session_meta timestamp must postdate the harness's spawn wall-clock
      // or discovery's sinceMs filter would skip it as an older session.
      await vi.waitFor(() => {
        expect(existsSync(spawnedFile)).toBe(true);
      }, { timeout: 10_000, interval: 50 });

      // Simulate Codex creating its rollout file shortly after spawn. Codex
      // records the OS-canonicalized cwd (macOS /var -> /private/var), so
      // mirror that to exercise findRolloutFile's realpath matching.
      const agentSessionId = "0199-codex-passthrough-test";
      const rolloutPath = join(rolloutDir, `rollout-2026-07-15T00-00-00-${agentSessionId}.jsonl`);
      await writeFile(
        rolloutPath,
        sessionMetaLine(agentSessionId, await realpath(cwd), new Date().toISOString()) +
          userMessageLine("build me a workflow") +
          taskCompleteLine(),
      );

      // Wait until the tailer has fed the pipeline, then let the child exit.
      await vi.waitFor(
        async () => {
          const events = await readEvents(eventStorePath);
          expect(events.some((e) => e.type === "turn.completed")).toBe(true);
        },
        { timeout: 10_000, interval: 100 },
      );
      await writeFile(exitFile, "", "utf8");

      const exitCode = await run;
      expect(exitCode).toBe(0);

      const events = await readEvents(eventStorePath);
      expect(events.map((e) => e.type)).toEqual([
        "session.start",
        "prompt.submitted",
        "turn.completed",
        "session.end",
      ]);
      expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
      for (const event of events) {
        expect(event.harness).toBe("codex");
      }
      expect(events[0]!.agentSessionId).toBe(agentSessionId);
      expect(events[1]!.payload).toMatchObject({ prompt: "build me a workflow" });
      expect(events[3]!.payload).toMatchObject({ reason: "process exited (code 0)" });

      // Generated dir cleanup applies to codex sessions too.
      await expect(readdir(generatedRoot)).resolves.toEqual([]);
    }, 30_000);

    it("fast exit: a rollout found after codex already exited is still tailed, recorded, and closed with SessionEnd", async () => {
      const binary = await writeFixture("fake-codex-fast.mjs", FAKE_CODEX_FAST_EXIT_SOURCE);
      const codexHomeDir = join(dir, "codex-home");
      const rolloutDir = join(codexHomeDir, ".codex", "sessions", "2026", "07", "15");
      await mkdir(rolloutDir, { recursive: true });
      const spawnedFile = join(dir, "codex-spawned");
      process.env.FAKE_CODEX_SPAWNED_FILE = spawnedFile;

      const run = runPassthrough(
        { kind: "codex", agent: "codex", agentArgs: [], noAuth: true, noTelemetry: true },
        baseOverrides({
          adapters: { codex: createCodexAdapter({ binary }) },
          codexHomeDir,
          // Discovery's first poll misses (no rollout yet); the child exits
          // long before the second — which must still pick the file up
          // instead of discarding it because childExited.
          rolloutDiscoveryPollMs: 600,
          rolloutDiscoveryTimeoutMs: 10_000,
          // ≥ the tailer's 300ms poll, so its post-exit read pass lands.
          exitDrainMs: 700,
        }),
      );

      // The child has (or is about to have) exited; only now does its
      // rollout appear on disk — the shape of a codex that wrote its session
      // and died before discovery could attach.
      await vi.waitFor(() => {
        expect(existsSync(spawnedFile)).toBe(true);
      }, { timeout: 10_000, interval: 25 });
      const agentSessionId = "0199-codex-fast-exit-test";
      await writeFile(
        join(rolloutDir, `rollout-2026-07-15T00-00-01-${agentSessionId}.jsonl`),
        sessionMetaLine(agentSessionId, await realpath(cwd), new Date().toISOString()) +
          userMessageLine("quick question") +
          taskCompleteLine(),
      );

      const exitCode = await run;
      expect(exitCode).toBe(0);

      const events = await readEvents(eventStorePath);
      expect(events.map((e) => e.type)).toEqual([
        "session.start",
        "prompt.submitted",
        "turn.completed",
        "session.end",
      ]);
      expect(events[0]!.agentSessionId).toBe(agentSessionId);
    }, 30_000);

    it("resume: tails the existing rollout with resume semantics — no history replay, new activity recorded", async () => {
      const binary = await writeFixture("fake-codex.mjs", FAKE_CODEX_SOURCE);
      const codexHomeDir = join(dir, "codex-home");
      const rolloutDir = join(codexHomeDir, ".codex", "sessions", "2026", "07", "14");
      await mkdir(rolloutDir, { recursive: true });
      const exitFile = join(dir, "codex-exit-signal");
      const spawnedFile = join(dir, "codex-spawned");
      process.env.FAKE_CODEX_EXIT_FILE = exitFile;
      process.env.FAKE_CODEX_SPAWNED_FILE = spawnedFile;

      // A rollout from a PRIOR session: its session_meta timestamp predates
      // this spawn (the exact shape the fresh-launch sinceMs filter rejects),
      // and its content is history that must NOT be replayed.
      const agentSessionId = "0199-codex-resume-test";
      const rolloutPath = join(rolloutDir, `rollout-2026-07-14T00-00-00-${agentSessionId}.jsonl`);
      await writeFile(
        rolloutPath,
        sessionMetaLine(agentSessionId, await realpath(cwd), new Date(Date.now() - 60 * 60 * 1000).toISOString()) +
          userMessageLine("old prompt from the prior session") +
          taskCompleteLine(),
      );

      const run = runPassthrough(
        { kind: "codex", agent: "codex", agentArgs: ["resume"], noAuth: true, noTelemetry: true },
        baseOverrides({
          adapters: { codex: createCodexAdapter({ binary }) },
          codexHomeDir,
          rolloutDiscoveryPollMs: 50,
          rolloutDiscoveryTimeoutMs: 5_000,
          exitDrainMs: 700,
        }),
      );

      await vi.waitFor(() => {
        expect(existsSync(spawnedFile)).toBe(true);
      }, { timeout: 10_000, interval: 50 });
      // Give discovery + the tailer's resume baseline (stat of the current
      // size) ample time to settle before appending new activity.
      await new Promise((resolve) => setTimeout(resolve, 800));

      // Codex appends the resumed session's NEW activity.
      await appendFile(rolloutPath, userMessageLine("new prompt after resume") + taskCompleteLine());
      await vi.waitFor(
        async () => {
          const events = await readEvents(eventStorePath);
          expect(events.some((e) => e.type === "turn.completed")).toBe(true);
        },
        { timeout: 10_000, interval: 100 },
      );
      await writeFile(exitFile, "", "utf8");

      const exitCode = await run;
      expect(exitCode).toBe(0);

      const events = await readEvents(eventStorePath);
      // Resume semantics: prior history skipped (no session.start, no old
      // prompt) — only new activity plus the synthesized session.end.
      expect(events.map((e) => e.type)).toEqual(["prompt.submitted", "turn.completed", "session.end"]);
      expect(events[0]!.payload).toMatchObject({ prompt: "new prompt after resume" });
      expect(JSON.stringify(events)).not.toContain("old prompt from the prior session");
    }, 30_000);
  });
});
