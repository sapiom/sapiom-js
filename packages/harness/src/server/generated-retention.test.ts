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

vi.mock("../core/inject/retention.js", { spy: true });

import { startServer, type HarnessServer } from "./index.js";
import type { HarnessAdapter, LaunchOpts, SpawnSpec } from "../shared/types.js";
import { removeGeneratedSessionDir } from "../core/inject/retention.js";

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
    canResume: async () => true,
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
    vi.mocked(removeGeneratedSessionDir).mockClear();
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

  /** Starts an isolated server with optional launch and adapter overrides. */
  async function boot(options: Pick<Parameters<typeof startServer>[0], "buildLaunchOpts" | "adapters"> = {}): Promise<HarnessServer> {
    return startServer({
      port: 0,
      bootToken: "test-token",
      telemetryOptIn: false,
      autoCreateSession: false,
      adapters: { "claude-code": fakeClaudeAdapter() },
      stateRoot: dir,
      ...options,
    });
  }

  /** Writes a real MCP configuration file so tests can verify its deletion. */
  async function writeMcpConfig(id: string): Promise<string> {
    const sessionDir = join(generatedRoot, id);
    await mkdir(sessionDir, { recursive: true });
    const mcpConfigFile = join(sessionDir, "mcp-config.json");
    await writeFile(mcpConfigFile, '{"mcpServers":{}}');
    return mcpConfigFile;
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

  it("ignores repeated exited metadata broadcasts while resume regenerates configuration", async () => {
    let builds = 0;
    server = await boot({
      buildLaunchOpts: async (id) => {
        const mcpConfigFile = await writeMcpConfig(id);
        if (++builds === 2) {
          // Resume has awaited the prior exit's cleanup. A workspace scan
          // may publish metadata while the new configuration is being built.
          expect(server!.sessionManager.get(id)?.status).toBe("starting");
          server!.sessionManager.setBoundWorkflowPath(id, cwd);
          // No second removal may begin against the regenerated files.
          expect(removeGeneratedSessionDir).toHaveBeenCalledTimes(1);
        }
        return { mcpConfigFile };
      },
    });
    const session = await server.sessionManager.create({ cwd, harness: "claude-code" });
    await server.sessionManager.setAgentSessionId(session.id, "retention-rollout");
    await server.sessionManager.kill(session.id);
    await vi.waitFor(async () => {
      expect(await exists(join(generatedRoot, session.id))).toBe(false);
    });
    // A completed removal still guards later metadata from the same lifetime.
    server.sessionManager.setBoundWorkflowPath(session.id, cwd);
    expect(removeGeneratedSessionDir).toHaveBeenCalledTimes(1);
    await server.sessionManager.resume(session.id);
    expect(await exists(join(generatedRoot, session.id, "mcp-config.json"))).toBe(true);

    // Regenerating configuration resets the guard, so its next exit still cleans
    // up normally rather than retaining credentials indefinitely.
    await server.sessionManager.kill(session.id);
    expect(removeGeneratedSessionDir).toHaveBeenCalledTimes(2);
    await vi.waitFor(async () => {
      expect(await exists(join(generatedRoot, session.id))).toBe(false);
    });
  });

  it.each(["restart", "adopted history"])("protects regenerated configuration when resuming after %s", async (source) => {
    const buildLaunchOpts = async (id: string) => {
      const mcpConfigFile = await writeMcpConfig(id);
      if (server!.sessionManager.get(id)) {
        // Restored/imported history also enters its new lifetime before
        // generation, so metadata broadcasts cannot remove these files.
        expect(server!.sessionManager.get(id)?.status).toBe("starting");
        const removalsBeforeMetadata = vi.mocked(removeGeneratedSessionDir).mock.calls.length;
        server!.sessionManager.setBoundWorkflowPath(id, cwd);
        expect(removeGeneratedSessionDir).toHaveBeenCalledTimes(removalsBeforeMetadata);
      }
      return { mcpConfigFile };
    };
    server = await boot({ buildLaunchOpts });
    let id: string;
    if (source === "restart") {
      const session = await server.sessionManager.create({ cwd, harness: "claude-code" });
      id = session.id;
      await server.sessionManager.setAgentSessionId(id, "restored-rollout");
      await server.sessionManager.kill(id);
      await vi.waitFor(async () => expect(await exists(join(generatedRoot, id))).toBe(false));
      await server.sessionManager.flush();
      await server.close();
      await server.sessionManager.flush();
      vi.mocked(removeGeneratedSessionDir).mockClear();
      server = await boot({ buildLaunchOpts });
    } else {
      const session = await server.sessionManager.registerHistorical({
        harness: "claude-code",
        cwd,
        agentSessionId: "imported-rollout",
        title: "Imported session",
        lastActiveAt: "2026-01-01T00:00:00.000Z",
      });
      id = session.id;
    }
    expect(server.sessionManager.get(id)?.status).toBe("exited");
    await server.sessionManager.resume(id);
    expect(await exists(join(generatedRoot, id, "mcp-config.json"))).toBe(true);
    const removalsBeforeExit = vi.mocked(removeGeneratedSessionDir).mock.calls.length;
    await server.sessionManager.kill(id);
    expect(removeGeneratedSessionDir).toHaveBeenCalledTimes(removalsBeforeExit + 1);
    await vi.waitFor(async () => expect(await exists(join(generatedRoot, id))).toBe(false));
  });

  it.each(["configuration", "adapter"])("cleans regenerated files when resume fails during %s", async (failure) => {
    let fail = true;
    const adapter = fakeClaudeAdapter();
    const resume = adapter.resume;
    adapter.resume = (agentSessionId, opts) => {
      if (fail && failure === "adapter") throw new Error("resume preparation failed");
      return resume(agentSessionId, opts);
    };
    server = await boot({
      adapters: { "claude-code": adapter },
      buildLaunchOpts: async (id) => {
        const mcpConfigFile = await writeMcpConfig(id);
        if (fail && failure === "configuration") throw new Error("resume preparation failed");
        return { mcpConfigFile };
      },
    });
    const session = await server.sessionManager.registerHistorical({
      harness: "claude-code",
      cwd,
      agentSessionId: "failed-resume-rollout",
      title: "Imported session",
      lastActiveAt: "2026-01-01T00:00:00.000Z",
    });
    await expect(server.sessionManager.resume(session.id)).rejects.toThrow("resume preparation failed");
    expect(server.sessionManager.get(session.id)).toMatchObject({
      status: "exited",
      lastActiveAt: "2026-01-01T00:00:00.000Z",
    });
    await vi.waitFor(async () => expect(await exists(join(generatedRoot, session.id))).toBe(false));
    expect(removeGeneratedSessionDir).toHaveBeenCalledTimes(1);

    // The failed attempt must not prevent a retry or that lifetime's cleanup.
    fail = false;
    await server.sessionManager.resume(session.id);
    expect(await exists(join(generatedRoot, session.id, "mcp-config.json"))).toBe(true);
    await server.sessionManager.kill(session.id);
    await vi.waitFor(async () => expect(await exists(join(generatedRoot, session.id))).toBe(false));
    expect(removeGeneratedSessionDir).toHaveBeenCalledTimes(2);
  });
});
