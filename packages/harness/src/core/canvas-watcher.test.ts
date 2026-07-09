import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CanvasWatcherManager, snapshotCanvasDir } from "./canvas-watcher.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let cwd: string;
let manager: CanvasWatcherManager;
let onChange: ReturnType<typeof vi.fn>;

describe("CanvasWatcherManager", () => {
  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "harness-canvas-watch-"));
    onChange = vi.fn();
    manager = new CanvasWatcherManager({ onChange });
  });

  afterEach(async () => {
    manager.stopAll();
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it("fires onChange(harnessSessionId) when a file is created under a not-yet-existing canvas dir", async () => {
    manager.start("sess-1", cwd);

    await fs.mkdir(path.join(cwd, ".sapiom", "canvas"), { recursive: true });
    await fs.writeFile(path.join(cwd, ".sapiom", "canvas", "index.html"), "<html></html>");

    await sleep(500);
    expect(onChange).toHaveBeenCalledWith("sess-1");
  });

  it("fires again when an existing canvas file changes", async () => {
    await fs.mkdir(path.join(cwd, ".sapiom", "canvas"), { recursive: true });
    await fs.writeFile(path.join(cwd, ".sapiom", "canvas", "index.html"), "<html>v1</html>");

    manager.start("sess-1", cwd);
    await sleep(100);

    await fs.writeFile(path.join(cwd, ".sapiom", "canvas", "index.html"), "<html>v2</html>");
    await sleep(500);
    expect(onChange).toHaveBeenCalledWith("sess-1");
  });

  it("debounces rapid successive writes into fewer calls than writes", async () => {
    await fs.mkdir(path.join(cwd, ".sapiom", "canvas"), { recursive: true });
    manager.start("sess-1", cwd);
    await sleep(100);

    for (let i = 0; i < 5; i++) {
      await fs.writeFile(path.join(cwd, ".sapiom", "canvas", "index.html"), `<html>${i}</html>`);
    }
    await sleep(500);

    expect(onChange.mock.calls.length).toBeGreaterThan(0);
    expect(onChange.mock.calls.length).toBeLessThan(5);
  });

  it("does not fire for changes outside the canvas dir", async () => {
    manager.start("sess-1", cwd);
    await sleep(100);

    await fs.writeFile(path.join(cwd, "README.md"), "unrelated change");
    await sleep(400);

    expect(onChange).not.toHaveBeenCalled();
  });

  it("survives the canvas dir being deleted after it existed", async () => {
    await fs.mkdir(path.join(cwd, ".sapiom", "canvas"), { recursive: true });
    await fs.writeFile(path.join(cwd, ".sapiom", "canvas", "index.html"), "<html></html>");
    manager.start("sess-1", cwd);
    await sleep(100);

    await fs.rm(path.join(cwd, ".sapiom"), { recursive: true, force: true });
    await sleep(300);

    // Deleting shouldn't throw or crash the watcher — and a subsequent
    // recreation should still be picked up.
    onChange.mockClear();
    await fs.mkdir(path.join(cwd, ".sapiom", "canvas"), { recursive: true });
    await fs.writeFile(path.join(cwd, ".sapiom", "canvas", "index.html"), "<html>back</html>");
    await sleep(500);
    expect(onChange).toHaveBeenCalledWith("sess-1");
  });

  it("stop() stops further notifications for that session only", async () => {
    const cwdB = await fs.mkdtemp(path.join(os.tmpdir(), "harness-canvas-watch-b-"));
    manager.start("sess-1", cwd);
    manager.start("sess-2", cwdB);
    manager.stop("sess-1");

    await fs.mkdir(path.join(cwd, ".sapiom", "canvas"), { recursive: true });
    await fs.mkdir(path.join(cwdB, ".sapiom", "canvas"), { recursive: true });
    await fs.writeFile(path.join(cwd, ".sapiom", "canvas", "index.html"), "<html></html>");
    await fs.writeFile(path.join(cwdB, ".sapiom", "canvas", "index.html"), "<html></html>");
    await sleep(500);

    expect(onChange).not.toHaveBeenCalledWith("sess-1");
    expect(onChange).toHaveBeenCalledWith("sess-2");

    manager.stop("sess-2");
    await fs.rm(cwdB, { recursive: true, force: true });
  });

  it("stopAll() tears down every session watcher", async () => {
    manager.start("sess-1", cwd);
    expect(manager.size).toBe(1);
    manager.stopAll();
    expect(manager.size).toBe(0);

    await fs.mkdir(path.join(cwd, ".sapiom", "canvas"), { recursive: true });
    await fs.writeFile(path.join(cwd, ".sapiom", "canvas", "index.html"), "<html></html>");
    await sleep(400);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("start() is idempotent per session — replaces rather than leaks a second watcher", () => {
    manager.start("sess-1", cwd);
    manager.start("sess-1", cwd);
    expect(manager.size).toBe(1);
  });
});

describe("snapshotCanvasDir", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-snapshot-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns an empty string when the directory doesn't exist", () => {
    expect(snapshotCanvasDir(path.join(dir, "missing"))).toBe("");
  });

  it("changes when a file is added", async () => {
    const before = snapshotCanvasDir(dir);
    await fs.writeFile(path.join(dir, "index.html"), "hi");
    const after = snapshotCanvasDir(dir);
    expect(after).not.toBe(before);
    expect(after.length).toBeGreaterThan(0);
  });

  it("changes when a file's content (and mtime/size) changes", async () => {
    await fs.writeFile(path.join(dir, "index.html"), "hi");
    const before = snapshotCanvasDir(dir);
    await sleep(10);
    await fs.writeFile(path.join(dir, "index.html"), "a longer body");
    const after = snapshotCanvasDir(dir);
    expect(after).not.toBe(before);
  });

  it("is stable across calls when nothing changed", async () => {
    await fs.writeFile(path.join(dir, "index.html"), "hi");
    expect(snapshotCanvasDir(dir)).toBe(snapshotCanvasDir(dir));
  });
});
