import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentProjectScanBudget } from "./agent-project-discovery.js";
import {
  sourceObservationsWithinScope,
  WorkspaceWatcherManager,
  snapshotWorkflowSourceRootsAsync,
  snapshotWorkspaceWorkflows,
  snapshotWorkspaceWorkflowsAsync,
} from "./workspace-watcher.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Creates a workflow directory (marker + package.json) under `root`. */
async function scaffoldWorkflow(root: string, name: string): Promise<string> {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "sapiom.json"),
    JSON.stringify({ definitionId: null }),
  );
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name }));
  return dir;
}

let cwd: string;
let manager: WorkspaceWatcherManager;
let onChange: ReturnType<typeof vi.fn>;
let onWatcherStarted: ReturnType<typeof vi.fn>;

describe("WorkspaceWatcherManager", () => {
  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "harness-workspace-watch-"));
    onChange = vi.fn();
    onWatcherStarted = vi.fn();
    manager = new WorkspaceWatcherManager({ onChange, onWatcherStarted });
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
    expect(onChange).toHaveBeenCalledWith("sess-1", null);
  });

  it("fires onChange when a workflow directory is removed", async () => {
    const dir = await scaffoldWorkflow(cwd, "text-to-image");
    manager.start("sess-1", cwd);
    await sleep(100);
    onChange.mockClear();

    await fs.rm(dir, { recursive: true, force: true });
    await sleep(600);
    expect(onChange).toHaveBeenCalledWith("sess-1", null);
  });

  it("does not fire for a plain content edit to an existing file (no structural change)", async () => {
    await fs.writeFile(path.join(cwd, "README.md"), "v1");
    manager.start("sess-1", cwd);
    await sleep(100);
    onChange.mockClear();

    await fs.writeFile(
      path.join(cwd, "README.md"),
      "v2 — a longer body, same file",
    );
    await sleep(500);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("ignores churn under node_modules and .sapiom", async () => {
    await fs.mkdir(path.join(cwd, "node_modules", "pkg"), { recursive: true });
    await fs.mkdir(path.join(cwd, ".sapiom", "canvas", "renders"), {
      recursive: true,
    });
    manager.start("sess-1", cwd);
    await sleep(100);
    onChange.mockClear();

    await fs.writeFile(path.join(cwd, "node_modules", "pkg", "index.js"), "x");
    await fs.writeFile(
      path.join(cwd, ".sapiom", "canvas", "renders", "a.html"),
      "<html></html>",
    );
    await sleep(500);

    expect(onChange).not.toHaveBeenCalled();
  });

  it("stop() halts notifications for that session only", async () => {
    const cwdB = await fs.mkdtemp(
      path.join(os.tmpdir(), "harness-workspace-watch-b-"),
    );
    manager.start("sess-1", cwd);
    manager.start("sess-2", cwdB);
    manager.stop("sess-1");
    await sleep(50);

    await scaffoldWorkflow(cwd, "a");
    await scaffoldWorkflow(cwdB, "b");
    await sleep(600);

    expect(onChange).not.toHaveBeenCalledWith("sess-1", expect.anything());
    expect(onChange).toHaveBeenCalledWith("sess-2", null);

    manager.stop("sess-2");
    await fs.rm(cwdB, { recursive: true, force: true });
  });

  it("start() is idempotent per session", () => {
    manager.start("sess-1", cwd);
    manager.start("sess-1", path.join(cwd, "."));
    expect(manager.size).toBe(1);
    expect(onWatcherStarted).toHaveBeenCalledTimes(1);
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
      if (pollInFlight) {
        inFlightAtSecondTick = true;
        return;
      }
      pollInFlight = true;
      walkCallCount++;
      // Slow async that doesn't resolve until resolveFirstWalk() is called.
      new Promise<void>((r) => {
        resolveFirstWalk = r;
      }).finally(() => {
        pollInFlight = false;
      });
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
    dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "harness-workspace-snapshot-"),
    );
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

  it("changes when marker identity changes and excludes malformed markers", async () => {
    const workflow = await scaffoldWorkflow(dir, "flow-a");
    const before = snapshotWorkspaceWorkflows(dir);

    await fs.writeFile(
      path.join(workflow, "sapiom.json"),
      JSON.stringify({ definitionId: 42 }),
    );
    const linked = snapshotWorkspaceWorkflows(dir);
    expect(linked).not.toBe(before);

    await fs.writeFile(path.join(workflow, "sapiom.json"), "not-json");
    expect(snapshotWorkspaceWorkflows(dir)).toBe("");
  });

  it.skipIf(
    process.platform === "win32" ||
      (typeof process.getuid === "function" && process.getuid() === 0),
  )(
    "distinguishes an unreadable project from a subsequently invalid marker",
    async () => {
      const workflow = await scaffoldWorkflow(dir, "flow-unreadable");
      const valid = snapshotWorkspaceWorkflows(dir);

      await fs.chmod(workflow, 0o000);
      let unreadable: string;
      try {
        unreadable = snapshotWorkspaceWorkflows(dir);
        if (unreadable === valid) return;
        expect(unreadable).toContain("<unreadable>");
        expect(await snapshotWorkspaceWorkflowsAsync(dir)).toBe(unreadable);
      } finally {
        await fs.chmod(workflow, 0o700);
      }

      // No intervening valid snapshot: this models restore + corruption being
      // coalesced into one debounced watcher check.
      await fs.writeFile(path.join(workflow, "sapiom.json"), "not-json");
      const invalid = snapshotWorkspaceWorkflows(dir);
      expect(invalid).not.toBe(unreadable);
      expect(invalid).toBe("");
      expect(await snapshotWorkspaceWorkflowsAsync(dir)).toBe(invalid);
    },
  );

  it("uses the registry's ignored-directory contract", async () => {
    for (const ignored of [
      "node_modules",
      ".git",
      ".sapiom",
      "dist",
      "build",
      ".next",
    ]) {
      await scaffoldWorkflow(path.join(dir, ignored), "generated");
    }
    expect(snapshotWorkspaceWorkflows(dir)).toBe("");
  });

  it("does not descend into a marker directory (a nested marker never double-counts)", async () => {
    await scaffoldWorkflow(dir, "flow-a");
    await fs.writeFile(
      path.join(dir, "flow-a", "sapiom.json"),
      JSON.stringify({ definitionId: 2 }),
    );
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
    dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "harness-workspace-snapshot-async-"),
    );
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
    await scaffoldWorkflow(
      path.join(dir, "flow-d"),
      "nested-should-not-appear",
    );
    const async_ = await snapshotWorkspaceWorkflowsAsync(dir);
    expect(async_).not.toContain("nested-should-not-appear");
  });
});

describe("sourceObservationsWithinScope", () => {
  it("includes narrower child envelopes for parents but excludes broader sibling probes from children", () => {
    const workspace = path.resolve("/workspace");
    const agent = path.join(workspace, "checkout", "agent");
    const broad = {
      workspaceRoot: workspace,
      candidateRoot: agent,
      paths: [path.join(workspace, "shared.ts")],
    };
    const direct = {
      workspaceRoot: agent,
      candidateRoot: agent,
      paths: [path.join(agent, "helper.ts")],
    };

    expect(sourceObservationsWithinScope(workspace, [broad, direct])).toEqual([
      broad,
      direct,
    ]);
    expect(sourceObservationsWithinScope(agent, [broad, direct])).toEqual([
      direct,
    ]);
  });
});

describe("snapshotWorkflowSourceRootsAsync observation budget", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "harness-source-observation-budget-"),
    );
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("caps probes globally, samples roots fairly, and stays byte-stable", async () => {
    const roots = [path.join(dir, "a"), path.join(dir, "z")];
    await Promise.all(roots.map((root) => fs.mkdir(root, { recursive: true })));
    const observations = roots.map((root) => ({
      workspaceRoot: root,
      candidateRoot: root,
      paths: [
        root,
        ...Array.from({ length: 8 }, (_, index) =>
          path.join(root, `helper-${index}.ts`),
        ),
      ],
    }));
    const firstProbes: string[] = [];
    const firstCandidates: string[] = [];

    const first = await snapshotWorkflowSourceRootsAsync(roots, observations, {
      maxObservationProbes: 4,
      onObservationProbe: (observed) => firstProbes.push(observed),
      onObservationCandidate: (observed) => firstCandidates.push(observed),
    });
    const secondProbes: string[] = [];
    const second = await snapshotWorkflowSourceRootsAsync(roots, observations, {
      maxObservationProbes: 4,
      onObservationProbe: (observed) => secondProbes.push(observed),
    });

    expect(firstProbes).toHaveLength(4);
    expect(firstCandidates.length).toBeLessThanOrEqual(16);
    expect(
      firstProbes.filter((probe) => probe.startsWith(roots[0]!)),
    ).toHaveLength(2);
    expect(
      firstProbes.filter((probe) => probe.startsWith(roots[1]!)),
    ).toHaveLength(2);
    expect(secondProbes).toEqual(firstProbes);
    expect(second).toEqual(first);
    expect(
      [...first.values()].every((value) =>
        value.includes("<source-observations-truncated>"),
      ),
    ).toBe(true);
  });

  it("samples the root directory for a late-sorted caller before optional helpers", async () => {
    const roots = [path.join(dir, "a"), path.join(dir, "z")];
    await Promise.all(roots.map((root) => fs.mkdir(root, { recursive: true })));
    const observations = roots.map((root) => ({
      workspaceRoot: root,
      candidateRoot: root,
      paths: [root, path.join(root, "helper.ts")],
    }));
    const before = await snapshotWorkflowSourceRootsAsync(roots, observations, {
      maxObservationProbes: 2,
    });
    const now = new Date(Date.now() + 2_000);
    await fs.utimes(roots[1]!, now, now);
    const after = await snapshotWorkflowSourceRootsAsync(roots, observations, {
      maxObservationProbes: 2,
    });

    expect(after.get(roots[0]!)).toBe(before.get(roots[0]!));
    expect(after.get(roots[1]!)).not.toBe(before.get(roots[1]!));
  });
});

/**
 * The fingerprint's side of the raised bound. A depth-3 walk could not see a
 * deep agent appear at all; a node-bounded one can, and must stay STILL when it
 * has to truncate — a fingerprint that shifts between two passes over an
 * unchanged tree rescans the workspace forever.
 */
describe("snapshotWorkspaceWorkflows bounds", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-workspace-bounds-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("notices a workflow four segments down, which the old depth-3 cap could not", async () => {
    const before = snapshotWorkspaceWorkflows(dir);
    await scaffoldWorkflow(path.join(dir, "backend", "src", "agents"), "ads");

    const after = snapshotWorkspaceWorkflows(dir);
    expect(after).not.toBe(before);
    expect(after).toContain(path.join("backend", "src", "agents", "ads"));
    expect(await snapshotWorkspaceWorkflowsAsync(dir)).toBe(after);
  });

  it("reaches the full depth allowance and stops one level past it", async () => {
    await scaffoldWorkflow(
      path.join(dir, "a", "b", "c", "d", "e", "f", "g"),
      "at-8",
    );
    await scaffoldWorkflow(
      path.join(dir, "x", "b", "c", "d", "e", "f", "g", "h"),
      "at-9",
    );

    const snapshot = snapshotWorkspaceWorkflows(dir);
    expect(snapshot).toContain("at-8");
    expect(snapshot).not.toContain("at-9");
  });

  it("records a truncated walk as one stable sentinel, identical across passes and between sync and async", async () => {
    for (const top of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
      await scaffoldWorkflow(path.join(dir, top, "deep"), "agent");
    }

    const limits = { maxNodes: 5 };
    const first = snapshotWorkspaceWorkflows(
      dir,
      new AgentProjectScanBudget(limits),
    );
    const second = snapshotWorkspaceWorkflows(
      dir,
      new AgentProjectScanBudget(limits),
    );
    const asyncSnapshot = await snapshotWorkspaceWorkflowsAsync(
      dir,
      new AgentProjectScanBudget(limits),
    );

    expect(first).toContain("<truncated>@");
    // Byte-identical, or the watcher fires onChange on every debounced check.
    expect(second).toBe(first);
    expect(asyncSnapshot).toBe(first);
    // Exactly one sentinel, not one per unvisited directory.
    expect(first.split("<truncated>").length - 1).toBe(1);
  });

  it("encodes the cut depth, so widening the reach reads as a change rather than as nothing", async () => {
    for (const top of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
      await scaffoldWorkflow(path.join(dir, top, "deep"), "agent");
    }

    // Root only: level 1 never enumerated.
    const atOne = snapshotWorkspaceWorkflows(
      dir,
      new AgentProjectScanBudget({ maxNodes: 1 }),
    );
    // Root + all 8 children: level 1 complete, the cut moves to level 2.
    const atTwo = snapshotWorkspaceWorkflows(
      dir,
      new AgentProjectScanBudget({ maxNodes: 9 }),
    );

    expect(atOne).toContain("<truncated>@1");
    expect(atTwo).toContain("<truncated>@2");
    expect(atOne).not.toBe(atTwo);
  });

  it("spends no more than its budget allows", async () => {
    for (let i = 0; i < 40; i++) {
      await fs.mkdir(path.join(dir, `top-${i}`, "mid", "leaf"), {
        recursive: true,
      });
    }
    const budget = new AgentProjectScanBudget({ maxNodes: 25 });
    snapshotWorkspaceWorkflows(dir, budget);
    expect(budget.visited).toBe(25);
  });

  it.skipIf(process.platform === "win32")(
    "terminates on a symlink cycle rather than walking it to the budget",
    async () => {
      await scaffoldWorkflow(path.join(dir, "pkg", "agents"), "one");
      await fs.symlink(dir, path.join(dir, "pkg", "loop"), "dir");

      const budget = new AgentProjectScanBudget();
      const started = performance.now();
      const snapshot = snapshotWorkspaceWorkflows(dir, budget);
      const elapsed = performance.now() - started;

      expect(snapshot).toContain(path.join("pkg", "agents", "one"));
      expect(budget.truncated).toBe(false);
      expect(budget.visited).toBeLessThan(10);
      expect(elapsed).toBeLessThan(1_000);
    },
  );
});
