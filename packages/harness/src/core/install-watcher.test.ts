import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { InstallWatcherManager } from "./install-watcher.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Simulate `npm install` completing — the SDK package esbuild must resolve
 *  (its package.json present, as the readiness probe checks). The project has
 *  no package.json, so the probe falls back to requiring just the SDK. */
async function installDeps(projectDir: string): Promise<void> {
  const dir = path.join(projectDir, "node_modules", "@sapiom/agent");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "@sapiom/agent" }));
}

let projectDir: string;
let manager: InstallWatcherManager;
let onInstalled: ReturnType<typeof vi.fn>;
let onTimeout: ReturnType<typeof vi.fn>;

describe("InstallWatcherManager", () => {
  beforeEach(async () => {
    // Outside the repo, so no ancestor node_modules resolves @sapiom/agent
    // until this test creates it — a genuine pre-install project.
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "install-watch-"));
    onInstalled = vi.fn();
    onTimeout = vi.fn();
    manager = new InstallWatcherManager(
      { onInstalled, onTimeout },
      { pollIntervalMs: 20, timeoutMs: 10_000 },
    );
  });

  afterEach(async () => {
    manager.stopAll();
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it("fires onInstalled once deps land, then self-removes", async () => {
    manager.start("sess-1", projectDir);
    await sleep(60);
    expect(onInstalled).not.toHaveBeenCalled();
    expect(manager.size).toBe(1);

    await installDeps(projectDir);
    await sleep(80);

    expect(onInstalled).toHaveBeenCalledWith("sess-1");
    expect(onInstalled).toHaveBeenCalledTimes(1);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(manager.size).toBe(0); // one-shot: removed itself
  });

  it("fires onInstalled promptly when deps are already present at arm time", async () => {
    await installDeps(projectDir);
    manager.start("sess-1", projectDir);
    await sleep(40);

    expect(onInstalled).toHaveBeenCalledWith("sess-1");
    expect(manager.size).toBe(0);
  });

  it("fires onTimeout (not onInstalled) when install never completes", async () => {
    const timed = new InstallWatcherManager(
      { onInstalled, onTimeout },
      { pollIntervalMs: 20, timeoutMs: 60 },
    );
    timed.start("sess-1", projectDir);
    await sleep(140);

    expect(onTimeout).toHaveBeenCalledWith("sess-1");
    expect(onInstalled).not.toHaveBeenCalled();
    expect(timed.size).toBe(0);
    timed.stopAll();
  });

  it("stop() cancels a pending watcher — no callback fires afterward", async () => {
    manager.start("sess-1", projectDir);
    await sleep(40);
    manager.stop("sess-1");
    expect(manager.size).toBe(0);

    await installDeps(projectDir);
    await sleep(80);
    expect(onInstalled).not.toHaveBeenCalled();
  });

  it("is idempotent for the same project — a repeated arm keeps one watcher and fires once", async () => {
    manager.start("sess-1", projectDir);
    manager.start("sess-1", projectDir);
    manager.start("sess-1", projectDir);
    expect(manager.size).toBe(1);

    await installDeps(projectDir);
    await sleep(80);
    expect(onInstalled).toHaveBeenCalledTimes(1);
  });
});
