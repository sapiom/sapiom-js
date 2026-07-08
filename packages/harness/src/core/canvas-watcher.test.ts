import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { watchCanvas, snapshotCanvasDir, type CanvasWatcherHandle } from "./canvas-watcher.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let cwd: string;
let handle: CanvasWatcherHandle | null;

describe("watchCanvas", () => {
  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "harness-canvas-watch-"));
    handle = null;
  });

  afterEach(async () => {
    handle?.close();
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it("fires onReload when a file is created under a not-yet-existing canvas dir", async () => {
    let calls = 0;
    handle = watchCanvas(cwd, () => calls++);

    await fs.mkdir(path.join(cwd, ".sapiom", "canvas"), { recursive: true });
    await fs.writeFile(path.join(cwd, ".sapiom", "canvas", "index.html"), "<html></html>");

    await sleep(500);
    expect(calls).toBeGreaterThan(0);
  });

  it("fires onReload again when an existing canvas file changes", async () => {
    await fs.mkdir(path.join(cwd, ".sapiom", "canvas"), { recursive: true });
    await fs.writeFile(path.join(cwd, ".sapiom", "canvas", "index.html"), "<html>v1</html>");

    let calls = 0;
    handle = watchCanvas(cwd, () => calls++);
    await sleep(100);

    await fs.writeFile(path.join(cwd, ".sapiom", "canvas", "index.html"), "<html>v2</html>");
    await sleep(500);
    expect(calls).toBeGreaterThan(0);
  });

  it("debounces rapid successive writes into fewer reloads than writes", async () => {
    await fs.mkdir(path.join(cwd, ".sapiom", "canvas"), { recursive: true });
    let calls = 0;
    handle = watchCanvas(cwd, () => calls++);
    await sleep(100);

    for (let i = 0; i < 5; i++) {
      await fs.writeFile(path.join(cwd, ".sapiom", "canvas", "index.html"), `<html>${i}</html>`);
    }
    await sleep(500);

    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThan(5);
  });

  it("does not fire for changes outside the canvas dir", async () => {
    let calls = 0;
    handle = watchCanvas(cwd, () => calls++);
    await sleep(100);

    await fs.writeFile(path.join(cwd, "README.md"), "unrelated change");
    await sleep(400);

    expect(calls).toBe(0);
  });

  it("close() stops further reloads", async () => {
    let calls = 0;
    handle = watchCanvas(cwd, () => calls++);
    handle.close();

    await fs.mkdir(path.join(cwd, ".sapiom", "canvas"), { recursive: true });
    await fs.writeFile(path.join(cwd, ".sapiom", "canvas", "index.html"), "<html></html>");
    await sleep(400);

    expect(calls).toBe(0);
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
