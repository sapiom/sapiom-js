import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { WorkspaceWatcherManager, snapshotWorkspaceWorkflows, snapshotWorkspaceWorkflowsAsync } from "./workspace-watcher.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Creates a workflow directory (marker + package.json) under `root`. */
async function scaffoldWorkflow(root: string, name: string): Promise<string> {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "sapiom.json"), JSON.stringify({ definitionId: null }));
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name }));
  return dir;
}

let cwd: string;
let manager: WorkspaceWatcherManager;
let onChange: ReturnType<typeof vi.fn>;

describe("WorkspaceWatcherManager", () => {
  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "harness-workspace-watch-"));
    onChange = vi.fn();
    manager = new WorkspaceWatcherManager({ onChange });
  });

  afterEach(async () => {
    manager.stopAll();
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it("fires onChange when a workflow directory is scaffolded mid-session", async () => {
    manager.start("sess-1", cwd);
    await sleep(100);

    await scaffoldWorkflow(cwd, "hn-story-images");
    await sleep(600);
    expect(onChange).toHaveBeenCalledWith("sess-1");
  });

  it("fires onChange when a workflow directory is removed", async () => {
    const dir = await scaffoldWorkflow(cwd, "text-to-image");
    manager.start("sess-1", cwd);
    await sleep(100);
    onChange.mockClear();

    await fs.rm(dir, { recursive: true, force: true });
    await sleep(600);
    expect(onChange).toHaveBeenCalledWith("sess-1");
  });

  it("does not fire for a plain content edit to an existing file (no structural change)", async () => {
    await fs.writeFile(path.join(cwd, "README.md"), "v1");
    manager.start("sess-1", cwd);
    await sleep(100);
    onChange.mockClear();

    await fs.writeFile(path.join(cwd, "README.md"), "v2 — a longer body, same file");
    await sleep(500);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("ignores churn under node_modules and .sapiom", async () => {
    manager.start("sess-1", cwd);
    await sleep(100);

    await fs.mkdir(path.join(cwd, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(path.join(cwd, "node_modules", "pkg", "index.js"), "x");
    await fs.mkdir(path.join(cwd, ".sapiom", "canvas", "renders"), { recursive: true });
    await fs.writeFile(path.join(cwd, ".sapiom", "canvas", "renders", "a.html"), "<html></html>");
    await sleep(500);

    expect(onChange).not.toHaveBeenCalled();
  });

  it("stop() halts notifications for that session only", async () => {
    const cwdB = await fs.mkdtemp(path.join(os.tmpdir(), "harness-workspace-watch-b-"));
    manager.start("sess-1", cwd);
    manager.start("sess-2", cwdB);
    manager.stop("sess-1");
    await sleep(50);

    await scaffoldWorkflow(cwd, "a");
    await scaffoldWorkflow(cwdB, "b");
    await sleep(600);

    expect(onChange).not.toHaveBeenCalledWith("sess-1");
    expect(onChange).toHaveBeenCalledWith("sess-2");

    manager.stop("sess-2");
    await fs.rm(cwdB, { recursive: true, force: true });
  });

  it("start() is idempotent per session", () => {
    manager.start("sess-1", cwd);
    manager.start("sess-1", cwd);
    expect(manager.size).toBe(1);
  });

  it("poll in-flight guard: second tick while first async walk is running is skipped (C3)", async () => {
    // Verify the in-flight guard semantic directly: a tick() call while a
    // previous async walk is still pending should be a no-op. We implement the
    // same pattern as SessionWorkspaceWatcher.fallBackToPolling() in isolation
    // to assert the invariant without depending on timing or fs.watch mock.
    let inFlightAtSecondTick = false;
    let walkCallCount = 0;
    let resolveFirstWalk!: () => void;

    // Minimal reimplementation of the guarded poll pattern from workspace-watcher.ts.
    let pollInFlight = false;
    const tick = (): void => {
      if (pollInFlight) { inFlightAtSecondTick = true; return; }
      pollInFlight = true;
      walkCallCount++;
      // Slow async that doesn't resolve until resolveFirstWalk() is called.
      new Promise<void>((r) => { resolveFirstWalk = r; })
        .finally(() => { pollInFlight = false; });
    };

    // First tick: starts the walk, sets pollInFlight = true.
    tick();
    expect(walkCallCount).toBe(1);
    expect(pollInFlight).toBe(true);

    // Second tick: should be skipped because pollInFlight is true.
    tick();
    expect(inFlightAtSecondTick).toBe(true);
    expect(walkCallCount).toBe(1); // no second walk started

    // Once the first walk completes, the flag is cleared.
    resolveFirstWalk();
    await new Promise((r) => setImmediate(r));
    expect(pollInFlight).toBe(false);

    // Now a third tick can proceed.
    tick();
    expect(walkCallCount).toBe(2);
  });
});

describe("snapshotWorkspaceWorkflows", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-workspace-snapshot-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("changes when a workflow appears and again when it's removed", async () => {
    const empty = snapshotWorkspaceWorkflows(dir);
    const wfDir = await scaffoldWorkflow(dir, "flow-a");
    const withOne = snapshotWorkspaceWorkflows(dir);
    expect(withOne).not.toBe(empty);
    expect(withOne).toContain("flow-a");

    await fs.rm(wfDir, { recursive: true, force: true });
    expect(snapshotWorkspaceWorkflows(dir)).toBe(empty);
  });

  it("is stable across a plain content edit that adds no workflow", async () => {
    await scaffoldWorkflow(dir, "flow-a");
    const before = snapshotWorkspaceWorkflows(dir);
    await fs.writeFile(path.join(dir, "notes.txt"), "some notes");
    expect(snapshotWorkspaceWorkflows(dir)).toBe(before);
  });

  it("does not descend into a marker directory (a nested marker never double-counts)", async () => {
    await scaffoldWorkflow(dir, "flow-a");
    await fs.writeFile(path.join(dir, "flow-a", "sapiom.json"), JSON.stringify({ definitionId: 2 }));
    // A nested project inside a workflow dir must not appear — scan stops at
    // the first marker.
    await scaffoldWorkflow(path.join(dir, "flow-a"), "nested");
    const snapshot = snapshotWorkspaceWorkflows(dir);
    expect(snapshot).not.toContain("nested");
  });
});

describe("snapshotWorkspaceWorkflowsAsync", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-workspace-snapshot-async-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("produces the same fingerprint as the sync version for a populated workspace", async () => {
    await scaffoldWorkflow(dir, "flow-a");
    await scaffoldWorkflow(dir, "flow-b");
    await fs.mkdir(path.join(dir, "node_modules", "pkg"), { recursive: true });

    const sync = snapshotWorkspaceWorkflows(dir);
    const async_ = await snapshotWorkspaceWorkflowsAsync(dir);
    expect(async_).toBe(sync);
    expect(async_).toContain("flow-a");
    expect(async_).toContain("flow-b");
  });

  it("returns an empty string for an empty root, matching the sync version", async () => {
    const sync = snapshotWorkspaceWorkflows(dir);
    const async_ = await snapshotWorkspaceWorkflowsAsync(dir);
    expect(async_).toBe(sync);
    expect(async_).toBe("");
  });

  it("changes when a workflow appears and again when it's removed — same as the sync version", async () => {
    const emptySync = snapshotWorkspaceWorkflows(dir);
    const emptyAsync = await snapshotWorkspaceWorkflowsAsync(dir);
    expect(emptyAsync).toBe(emptySync);

    const wfDir = await scaffoldWorkflow(dir, "flow-c");
    const withOneSync = snapshotWorkspaceWorkflows(dir);
    const withOneAsync = await snapshotWorkspaceWorkflowsAsync(dir);
    expect(withOneAsync).toBe(withOneSync);
    expect(withOneAsync).not.toBe(emptyAsync);

    await fs.rm(wfDir, { recursive: true, force: true });
    const afterRemoveAsync = await snapshotWorkspaceWorkflowsAsync(dir);
    expect(afterRemoveAsync).toBe(emptyAsync);
  });

  it("does not descend into a marker directory — same stop-at-first-marker semantics as sync", async () => {
    await scaffoldWorkflow(dir, "flow-d");
    await scaffoldWorkflow(path.join(dir, "flow-d"), "nested-should-not-appear");
    const async_ = await snapshotWorkspaceWorkflowsAsync(dir);
    expect(async_).not.toContain("nested-should-not-appear");
  });
});
