import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorkflowRegistry } from "./workflow-registry.js";

async function writeMarker(dir: string, definitionId: number | null): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "sapiom.json"), JSON.stringify({ definitionId }));
}

describe("WorkflowRegistry", () => {
  let tmpRoot: string;
  let registryPath: string;
  let registry: WorkflowRegistry;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "harness-workflow-registry-"));
    registryPath = path.join(tmpRoot, "state", "workflows.json");
    registry = new WorkflowRegistry(registryPath);
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("starts empty when no registry file exists", async () => {
    expect(await registry.list()).toEqual([]);
  });

  it("scans a tree for sapiom.json markers, honoring depth and skip rules", async () => {
    // Depth 1: has package.json, deployed.
    await writeMarker(path.join(tmpRoot, "proj-a"), 42);
    await fs.writeFile(
      path.join(tmpRoot, "proj-a", "package.json"),
      JSON.stringify({ name: "@acme/proj-a" }),
    );
    // Depth 1: no package.json, undeployed.
    await writeMarker(path.join(tmpRoot, "proj-b"), null);
    // Depth 3: right at the boundary — should be found.
    await writeMarker(path.join(tmpRoot, "a", "b", "c"), 7);
    // Depth 4: past the boundary — should NOT be found.
    await writeMarker(path.join(tmpRoot, "d", "e", "f", "g"), 9);
    // Inside node_modules / .git — should never be scanned.
    await writeMarker(path.join(tmpRoot, "node_modules", "some-pkg"), 1);
    await writeMarker(path.join(tmpRoot, ".git", "worktrees", "x"), 1);

    const found = await registry.scan(tmpRoot);
    const byPath = new Map(found.map((workflow) => [workflow.path, workflow]));

    expect(byPath.get(path.join(tmpRoot, "proj-a"))).toEqual({
      name: "@acme/proj-a",
      path: path.join(tmpRoot, "proj-a"),
      definitionId: 42,
      source: "scan",
    });
    expect(byPath.get(path.join(tmpRoot, "proj-b"))).toEqual({
      name: "proj-b",
      path: path.join(tmpRoot, "proj-b"),
      definitionId: null,
      source: "scan",
    });
    expect(byPath.has(path.join(tmpRoot, "a", "b", "c"))).toBe(true);
    expect(byPath.has(path.join(tmpRoot, "d", "e", "f", "g"))).toBe(false);
    expect(
      found.some((workflow) => workflow.path.includes("node_modules")),
    ).toBe(false);
    expect(found.some((workflow) => workflow.path.includes(".git"))).toBe(false);
  });

  it("persists scan results and reloads them for a fresh registry instance", async () => {
    await writeMarker(path.join(tmpRoot, "proj-a"), 1);
    await registry.scan(tmpRoot);

    const reloaded = new WorkflowRegistry(registryPath);
    const list = await reloaded.list();
    expect(list).toHaveLength(1);
    expect(list[0].path).toBe(path.join(tmpRoot, "proj-a"));
  });

  it("connectPath registers a path even without a sapiom.json marker yet", async () => {
    const projectDir = path.join(tmpRoot, "not-yet-linked");
    await fs.mkdir(projectDir, { recursive: true });

    const info = await registry.connectPath(projectDir);
    expect(info).toEqual({
      name: "not-yet-linked",
      path: projectDir,
      definitionId: null,
      source: "connect",
    });
    expect(await registry.list()).toEqual([info]);
  });

  it("connectPath picks up an existing marker's definitionId", async () => {
    const projectDir = path.join(tmpRoot, "linked");
    await writeMarker(projectDir, 99);

    const info = await registry.connectPath(projectDir);
    expect(info.definitionId).toBe(99);
  });

  it("a scan does not overwrite a connect-sourced entry's source", async () => {
    const projectDir = path.join(tmpRoot, "linked");
    await writeMarker(projectDir, 1);
    await registry.connectPath(projectDir);

    await registry.scan(tmpRoot);

    const list = await registry.list();
    const entry = list.find((workflow) => workflow.path === projectDir);
    expect(entry?.source).toBe("connect");
  });

  describe("prune", () => {
    it("drops entries whose path no longer exists and persists the result", async () => {
      const liveDir = path.join(tmpRoot, "live");
      const deadDir = path.join(tmpRoot, "dead");
      await writeMarker(liveDir, 1);
      await writeMarker(deadDir, 2);
      await registry.scan(tmpRoot);
      await fs.rm(deadDir, { recursive: true, force: true });

      const pruned = await registry.prune();
      expect(pruned.map((workflow) => workflow.path)).toEqual([deadDir]);
      expect((await registry.list()).map((workflow) => workflow.path)).toEqual([liveDir]);

      // Persisted, not just dropped from the in-memory list.
      const reloaded = new WorkflowRegistry(registryPath);
      expect((await reloaded.list()).map((workflow) => workflow.path)).toEqual([liveDir]);
    });

    it("keeps an existing-but-unbuilt project (only nonexistent paths are pruned)", async () => {
      // A bare directory with a marker and nothing else — no node_modules,
      // no build output. Deleting nothing: prune must keep it.
      const unbuiltDir = path.join(tmpRoot, "unbuilt");
      await writeMarker(unbuiltDir, 3);
      await registry.scan(tmpRoot);

      expect(await registry.prune()).toEqual([]);
      expect((await registry.list()).map((workflow) => workflow.path)).toEqual([unbuiltDir]);
    });

    it("does not rewrite the registry file when nothing was pruned", async () => {
      const liveDir = path.join(tmpRoot, "live");
      await writeMarker(liveDir, 1);
      await registry.scan(tmpRoot);
      const before = await fs.stat(registryPath);

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(await registry.prune()).toEqual([]);
      const after = await fs.stat(registryPath);
      expect(after.mtimeMs).toBe(before.mtimeMs);
    });

    it("is a no-op when no registry file exists yet", async () => {
      expect(await registry.prune()).toEqual([]);
      await expect(fs.access(registryPath)).rejects.toThrow();
    });
  });

  describe("write serialization", () => {
    it("concurrent scan/prune calls serialize so no entry is lost from the persisted file", async () => {
      // Seed N workflow directories and fire scan + prune concurrently.
      // Without the write queue, a prune that starts reading this.workflows
      // before a concurrent scan finishes writing it can overwrite the just-
      // merged entries. With serialization, the persisted file must contain
      // all discovered paths.
      const N = 5;
      for (let i = 0; i < N; i++) {
        await writeMarker(path.join(tmpRoot, `proj-${i}`), i);
      }

      // Fire N scans and N prunes all at once.
      const ops: Promise<unknown>[] = [];
      for (let i = 0; i < N; i++) {
        ops.push(registry.scan(tmpRoot));
        ops.push(registry.prune());
      }
      await Promise.all(ops);

      // All N workflow paths must survive in the persisted file.
      const reloaded = new WorkflowRegistry(registryPath);
      const list = await reloaded.list();
      const paths = new Set(list.map((w) => w.path));
      for (let i = 0; i < N; i++) {
        expect(paths.has(path.join(tmpRoot, `proj-${i}`))).toBe(true);
      }
    });

    it("a failed persist does not poison the queue — subsequent writes succeed", async () => {
      // Seed one workflow so there's something to scan.
      await writeMarker(path.join(tmpRoot, "proj-ok"), 1);

      // Make the registry path a DIRECTORY so writeFile throws EISDIR
      // (mkdir({ recursive: true }) on the parent won't help because the
      // path itself is already a directory, not a file destination).
      const badPath = path.join(tmpRoot, "workflows-dir");
      await fs.mkdir(badPath, { recursive: true }); // now badPath is a dir, not a file

      const brokenRegistry = new WorkflowRegistry(badPath);

      // Scan — persist will throw (EISDIR: illegal operation on a directory).
      // The write queue must swallow the error so the next op can proceed.
      await expect(brokenRegistry.scan(tmpRoot)).rejects.toThrow();

      // Clear the obstruction and scan again on the SAME instance — the
      // queue must not be poisoned by the earlier rejection.
      await fs.rmdir(badPath);
      await brokenRegistry.scan(tmpRoot);
      const list = await brokenRegistry.list();
      expect(list).toHaveLength(1);
      expect(list[0].path).toBe(path.join(tmpRoot, "proj-ok"));
    });
  });
});
