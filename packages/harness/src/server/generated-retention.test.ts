/**
 * Wiring-level proof of the generated-dir retention policy (see
 * core/inject/retention.ts for the unit-level tests of the mechanisms
 * themselves): the boot-time sweep runs when the server starts, and a
 * session's generated dir — written by the real default buildLaunchOpts —
 * survives while the pty is alive and is deleted once it exits.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { access, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer, type HarnessServer } from "./index.js";
import type { HarnessAdapter, LaunchOpts, SpawnSpec } from "../shared/types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A claude-code-shaped adapter that spawns bash — a real pty we can kill. */
function fakeClaudeAdapter(): HarnessAdapter {
  return {
    id: "claude-code",
    eventSource: "hooks",
    doctor: async () => [],
    launch: (opts: LaunchOpts): SpawnSpec => ({ command: "bash", args: [], env: {}, cwd: opts.cwd }),
    resume: (_agentSessionId: string, opts: LaunchOpts): SpawnSpec => ({
      command: "bash",
      args: [],
      env: {},
      cwd: opts.cwd,
    }),
    listPastSessions: async () => [],
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("generated-dir retention wiring", () => {
  let dir: string;
  let generatedRoot: string;
  let cwd: string;
  let server: HarnessServer | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "harness-retention-wiring-"));
    generatedRoot = join(dir, "generated");
    cwd = join(dir, "project");
    await mkdir(cwd, { recursive: true });
  });

  afterEach(async () => {
    await server?.sessionManager.flush();
    await server?.close();
    await server?.sessionManager.flush();
    server = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  async function boot(): Promise<HarnessServer> {
    return startServer({
      port: 0,
      bootToken: "test-token",
      telemetryOptIn: false,
      autoCreateSession: false,
      adapters: { "claude-code": fakeClaudeAdapter() },
      stateRoot: dir,
    });
  }

  it("sweeps stale orphaned dirs at boot and keeps fresh ones", async () => {
    const staleDir = join(generatedRoot, "orphan-from-a-crash");
    const freshDir = join(generatedRoot, "recent-orphan");
    await mkdir(staleDir, { recursive: true });
    await writeFile(join(staleDir, "settings.json"), "{}\n");
    const then = new Date(Date.now() - 8 * DAY_MS);
    await utimes(staleDir, then, then);
    await mkdir(freshDir, { recursive: true });

    server = await boot();

    await vi.waitFor(async () => {
      expect(await exists(staleDir)).toBe(false);
    });
    expect(await exists(freshDir)).toBe(true);
  });

  it("keeps a running session's dir and deletes it once the session exits", async () => {
    server = await boot();

    const session = await server.sessionManager.create({ cwd, harness: "claude-code" });
    expect(session.status).toBe("running");

    // The real default buildLaunchOpts wrote this session's config dir —
    // and it must survive for as long as the pty runs (the agent re-executes
    // emit.cjs from it on every hook event).
    const sessionDir = join(generatedRoot, session.id);
    expect(await exists(join(sessionDir, "settings.json"))).toBe(true);
    expect(await exists(join(sessionDir, "emit.cjs"))).toBe(true);

    void server.sessionManager.kill(session.id);
    await vi.waitFor(
      async () => {
        expect(server!.sessionManager.get(session.id)?.status).toBe("exited");
        expect(await exists(sessionDir)).toBe(false);
      },
      { timeout: 10_000, interval: 100 },
    );
  }, 15_000);
});
