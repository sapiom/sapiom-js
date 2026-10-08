import { createServer as createHttpServer } from "node:http";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StudioProjectCatalog } from "@sapiom/agent-map/node/studio-project-catalog";
import { SessionManagerClosingError } from "../core/session-manager.js";
import type { HarnessAdapter, LaunchOpts, SpawnSpec } from "../shared/types.js";
import { startServer, type HarnessServer } from "./index.js";

describe("server close and post-listen startup failure", () => {
  let stateRoot: string;
  let existingRoot: string;
  let newRoot: string;
  let webDir: string;
  let server: HarnessServer | undefined;
  let launches: LaunchOpts[];

  beforeEach(async () => {
    stateRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "harness-server-close-"),
    );
    existingRoot = path.join(stateRoot, "existing-project");
    newRoot = path.join(stateRoot, "new-project");
    webDir = path.join(stateRoot, "web");
    await Promise.all([
      fs.mkdir(existingRoot),
      fs.mkdir(newRoot),
      fs.mkdir(webDir),
    ]);
    await fs.writeFile(path.join(webDir, "index.html"), "<html></html>");
    await new StudioProjectCatalog(
      path.join(stateRoot, "studio-projects.json"),
    ).reconcile([{ workspaceKey: "existing", cwd: existingRoot }]);
    await fs.writeFile(
      path.join(stateRoot, "settings.json"),
      JSON.stringify({ recentDirs: [existingRoot] }),
    );
    launches = [];
  });

  afterEach(async () => {
    await server?.close();
    vi.restoreAllMocks();
    await fs.rm(stateRoot, { recursive: true, force: true, maxRetries: 5 });
  });


  function adapter(): HarnessAdapter {
    const launch = (options: LaunchOpts): SpawnSpec => {
      launches.push(options);
      return { command: "bash", args: [], env: {}, cwd: options.cwd };
    };
    return {
      id: "claude-code",
      eventSource: "hooks",
      doctor: async () => [],
      launch,
      resume: (_agentSessionId, options) => launch(options),
      listPastSessions: async () => [],
      canResume: async () => true,
    };
  }

  async function boot(
    selectedAdapter: HarnessAdapter = adapter(),
  ): Promise<HarnessServer> {
    return startServer({
      port: 0,
      bootToken: "boot-token",
      telemetryOptIn: false,
      identity: null,
      machineId: "machine-1",
      adapters: { "claude-code": selectedAdapter },
      stateRoot,
      launchDir: existingRoot,
      webDir,
      autoCreateSession: false,
      loadSystemPrompt: async () => "ordinary coding prompt",
    });
  }


  it("fully closes a post-listen startup failure before rejecting", async () => {
    let rejectedPort = 0;

    await expect(
      startServer({
        port: 0,
        bootToken: "boot-token",
        telemetryOptIn: false,
        identity: null,
        machineId: "machine-1",
        adapters: { "claude-code": adapter() },
        stateRoot,
        launchDir: existingRoot,
        webDir,
        autoCreateSession: false,
        loadSystemPrompt: async () => "ordinary coding prompt",
        startupTestHooks: {
          afterListen: (port) => {
            rejectedPort = port;
            throw new Error("simulated post-listen recovery failure");
          },
        },
      }),
    ).rejects.toThrow("simulated post-listen recovery failure");

    expect(rejectedPort).toBeGreaterThan(0);
    const rebound = createHttpServer();
    await new Promise<void>((resolve, reject) => {
      rebound.once("error", reject);
      rebound.listen(rejectedPort, "127.0.0.1", () => resolve());
    });
    await new Promise<void>((resolve, reject) => {
      rebound.close((error) => (error ? reject(error) : resolve()));
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(launches).toEqual([]);
  });

  it.each(["session flush"] as const)(
    "releases the listener with admission fenced when %s teardown never settles",
    async () => {
      server = await boot();
      const active = server;
      const port = active.port;
      let releaseTeardown!: () => void;
      const teardown = new Promise<void>((resolve) => {
        releaseTeardown = resolve;
      });
      const kills = vi.spyOn(active.sessionManager, "killAll");
      const stalled = vi.spyOn(active.sessionManager, "flush")
        .mockImplementation(() => teardown);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let closed = false;
      const closing = active.close().then(() => { closed = true; });

      try {
        await vi.waitFor(() => expect(stalled).toHaveBeenCalled());
        await expect(active.sessionManager.create({
          harness: "claude-code", cwd: newRoot,
        })).rejects.toBeInstanceOf(SessionManagerClosingError);
        await vi.waitFor(() => expect(kills).toHaveBeenCalled());
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(5_001);
        await vi.waitFor(() => expect(closed).toBe(true), {
          timeout: 250,
        });
        await closing;
        server = undefined;

        const rebound = createHttpServer();
        await new Promise<void>((resolve, reject) => {
          rebound.once("error", reject);
          rebound.listen(port, "127.0.0.1", () => resolve());
        });
        await new Promise<void>((resolve, reject) => {
          rebound.close((error) => (error ? reject(error) : resolve()));
        });
        expect(launches).toEqual([]);
      } finally {
        releaseTeardown();
        vi.useRealTimers();
        await closing;
      }
    },
  );

  it("makes concurrent server close calls share one complete teardown", async () => {
    server = await boot();
    const port = server.port;

    await Promise.all([server.close(), server.close(), server.close()]);
    server = undefined;

    const rebound = createHttpServer();
    await new Promise<void>((resolve, reject) => {
      rebound.once("error", reject);
      rebound.listen(port, "127.0.0.1", () => resolve());
    });
    await new Promise<void>((resolve, reject) => {
      rebound.close((error) => (error ? reject(error) : resolve()));
    });
    expect(launches).toEqual([]);
  });
});
