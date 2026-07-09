/**
 * Transcript-fixture replay tests — verifies that the fake-agent pty fixture
 * (e2e/fixtures/fake-agent/) behaves correctly under the real node-pty spawn.
 *
 * These tests are hermetic: they spawn only `node` (the current executable)
 * with a minimal environment — no external agents, credentials, or network.
 * Each test drives a specific transcript JSON and asserts the expected output.
 *
 * A final test wires one transcript through SessionManager itself (with the
 * real node-pty spawn injected), proving the full create→attach→write→kill
 * path works end-to-end with the fake-agent.
 *
 * Fixture provenance:
 *   basic-echo.json    — synthetic (hand-written)
 *   diagnostics.json   — synthetic (hand-written)
 *   stubborn.json      — synthetic (hand-written)
 *   claude-code-boot.json — hand-modeled on Claude Code v2.x boot output
 *                         under a 100x30 pty; all identifiers (user, org,
 *                         path) are fictional. Not a verbatim recording.
 *   See e2e/fixtures/fake-agent/README.md for the full provenance table.
 *
 * e2e-live.ts uses a separate capture-oriented fixture (fake-claude.mjs) rather
 * than fake-agent.cjs. See e2e/fixtures/fake-agent/README.md § "Test consumer"
 * for the rationale: fake-agent.cjs fires no hook events, so session.ready
 * never flips and submitInput would throw SessionNotReadyError — wiring it into
 * e2e-live.ts would require hook-firing logic (scope creep) or bypassing the
 * ready-gate (breaks the invariant it tests). The vitest suite here covers the
 * same SessionManager pty path without those constraints.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SessionManager } from "./session-manager.js";
import type { HarnessAdapter, SpawnSpec } from "../shared/types.js";

// ---------------------------------------------------------------------------
// node-pty availability — resolve once at module load, skip all tests if
// the native prebuilt is absent on this platform/arch.
// ---------------------------------------------------------------------------

const nodePty = await import("node-pty").then(
  (m) => m,
  () => {
    console.log(
      "[transcript-replay] node-pty native module unavailable on this platform — " +
        "skipping all transcript-replay tests. " +
        "If this is unexpected, try: pnpm rebuild node-pty",
    );
    return null;
  },
);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the fake-agent entry point. Uses .cjs extension because
 * the harness package.json declares "type": "module", which would cause Node to
 * treat a .js file as an ES module — but fake-agent is CommonJS (require-based)
 * so it needs the .cjs extension to opt out of that treatment.
 */
const FAKE_AGENT = path.resolve(
  __dirname,
  "..",
  "..",
  "e2e",
  "fixtures",
  "fake-agent",
  "fake-agent.cjs",
);

/** Absolute path to the transcript directory. */
const TRANSCRIPTS = path.resolve(
  __dirname,
  "..",
  "..",
  "e2e",
  "fixtures",
  "fake-agent",
  "transcripts",
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal env for spawning the fake-agent: only the inherited PATH, a
 * sensible TERM, and HOME pointing to a temp dir so nothing leaks to the real
 * home directory. Tests add FAKE_AGENT_MARKER via the `extra` parameter.
 */
function minimalEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    TERM: "xterm-256color",
    HOME: os.tmpdir(),
    ...extra,
  };
}

/**
 * Collects output from a node-pty data listener and supports async waiting
 * for a specific string to appear. Falls back to a poll every 50ms so tests
 * don't spin-wait.
 */
class OutputCollector {
  private buffer = "";
  private waiters: Array<() => void> = [];

  readonly listener = (chunk: string): void => {
    this.buffer += chunk;
    const waiters = this.waiters.splice(0);
    for (const notify of waiters) notify();
  };

  get text(): string {
    return this.buffer;
  }

  async waitFor(needle: string, timeoutMs = 10_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (!this.buffer.includes(needle)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `Timed out waiting for ${JSON.stringify(needle)}.\nOutput so far:\n${this.buffer}`,
        );
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(remaining, 50));
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return this.buffer;
  }
}

// ---------------------------------------------------------------------------
// Low-level fake-agent pty tests (bypass SessionManager)
// ---------------------------------------------------------------------------

describe.skipIf(!nodePty)("fake-agent fixture (real pty, direct spawn)", () => {
  function spawnAgent(
    transcript: string,
    opts: {
      cols?: number;
      rows?: number;
      env?: Record<string, string>;
      cwd?: string;
    } = {},
  ): { pty: import("node-pty").IPty; output: OutputCollector } {
    // nodePty is non-null inside this describe block (skipIf guards it).
    const output = new OutputCollector();
    const pty = nodePty!.spawn(process.execPath, [FAKE_AGENT, path.join(TRANSCRIPTS, `${transcript}.json`)], {
      name: "xterm-256color",
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      cwd: opts.cwd ?? path.dirname(FAKE_AGENT),
      env: opts.env ?? minimalEnv(),
    });
    pty.onData(output.listener);
    return { pty, output };
  }

  it("streams the boot banner from the basic-echo transcript", async () => {
    const { pty, output } = spawnAgent("basic-echo");
    try {
      await output.waitFor("fake-agent");
      expect(output.text).toContain("v0.1.0");
      await output.waitFor("> ");
    } finally {
      pty.kill();
    }
  }, 20_000);

  it("echoes typed input back after the busy spinner", async () => {
    const { pty, output } = spawnAgent("basic-echo");
    try {
      await output.waitFor("> ");
      pty.write("hello world\r");
      await output.waitFor("you said: hello world");
      // The spinner label from the transcript must have appeared before the echo.
      expect(output.text).toContain("thinking");
    } finally {
      pty.kill();
    }
  }, 20_000);

  it("diagnostics transcript prints terminal size, cwd and env marker", async () => {
    const cwd = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "fake-agent-cwd-")),
    );
    try {
      const { pty, output } = spawnAgent("diagnostics", {
        cols: 100,
        rows: 40,
        env: minimalEnv({ FAKE_AGENT_MARKER: "plumbing-ok" }),
        cwd,
      });
      try {
        await output.waitFor("[size] 100x40");
        await output.waitFor(`[cwd] ${cwd}`);
        await output.waitFor("[env] FAKE_AGENT_MARKER=plumbing-ok");
      } finally {
        pty.kill();
      }
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }, 20_000);

  it("diagnostics transcript announces terminal resize", async () => {
    const { pty, output } = spawnAgent("diagnostics");
    try {
      await output.waitFor("> ");
      pty.resize(120, 30);
      await output.waitFor("[resize] 120x30");
    } finally {
      pty.kill();
    }
  }, 20_000);

  it("stubborn transcript acknowledges SIGTERM but does not exit", async () => {
    const { pty, output } = spawnAgent("stubborn");
    try {
      await output.waitFor("> ");
      // SIGTERM must not kill the process — the transcript sets ignoreSigterm.
      pty.kill("SIGTERM");
      await output.waitFor("SIGTERM ignored");
    } finally {
      pty.kill("SIGKILL");
    }
  }, 20_000);

  it("replays the claude-code-boot transcript and reaches the idle footer", async () => {
    // Hand-modeled at 100x30; replay at the same size so box drawing is faithful.
    const { pty, output } = spawnAgent("claude-code-boot", {
      cols: 100,
      rows: 30,
    });
    try {
      await output.waitFor("Claude Code");
      await output.waitFor("? for shortcuts");
    } finally {
      pty.kill();
    }
  }, 20_000);
});

// ---------------------------------------------------------------------------
// SessionManager integration — wires basic-echo through the full
// create→attach→write→kill path using the real node-pty spawn.
// ---------------------------------------------------------------------------

describe.skipIf(!nodePty)("transcript-fixture replay via SessionManager (real pty)", () => {
  let tmpDir: string;
  let sessionsPath: string;
  let manager: SessionManager;

  /** Adapter that spawns the fake-agent instead of a real coding agent. */
  function makeFakeAgentAdapter(transcript: string): HarnessAdapter {
    return {
      id: "claude-code",
      eventSource: "hooks",
      doctor: async () => [],
      launch: (): SpawnSpec => ({
        command: process.execPath,
        args: [FAKE_AGENT, path.join(TRANSCRIPTS, `${transcript}.json`)],
        env: minimalEnv(),
        cwd: path.dirname(FAKE_AGENT),
      }),
      resume: (_agentSessionId): SpawnSpec => ({
        command: process.execPath,
        args: [FAKE_AGENT, path.join(TRANSCRIPTS, `${transcript}.json`)],
        env: minimalEnv(),
        cwd: path.dirname(FAKE_AGENT),
      }),
      listPastSessions: async () => [],
    };
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-transcript-replay-"));
    sessionsPath = path.join(tmpDir, "sessions.json");
    manager = new SessionManager({
      adapters: { "claude-code": makeFakeAgentAdapter("basic-echo") },
      ingestUrl: "http://127.0.0.1:0",
      ingestToken: "test-token",
      sessionsPath,
      // No spawnPty override — uses the real node-pty.
    });
    await manager.init();
  });

  afterEach(async () => {
    void manager.killAll();
    await manager.flush();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a session against the basic-echo transcript, streams boot output, echoes a line, then kills cleanly", async () => {
    const session = await manager.create({ harness: "claude-code", cwd: tmpDir });

    expect(session.status).toBe("running");

    // Attach and collect output.
    const output = new OutputCollector();
    const detach = manager.attach(session.id, output.listener);
    expect(detach).toBeDefined();

    try {
      // The scrollback buffer replays immediately on attach — wait for the prompt.
      await output.waitFor("> ");
      expect(output.text).toContain("fake-agent");
      expect(output.text).toContain("v0.1.0");

      // Write a line and verify the echo.
      manager.write(session.id, "integration-test\r");
      await output.waitFor("you said: integration-test");
    } finally {
      detach?.();
      void manager.kill(session.id);
    }

    // After kill, the session should be exited.
    await new Promise<void>((resolve) => {
      const unsubscribe = manager.onStatusChange((s) => {
        if (s.id === session.id && s.status === "exited") {
          unsubscribe();
          resolve();
        }
      });
      // Already exited (if kill resolved synchronously via markExited)?
      const current = manager.get(session.id);
      if (current?.status === "exited") {
        unsubscribe();
        resolve();
      }
    });

    expect(manager.get(session.id)?.status).toBe("exited");
  }, 30_000);
});
