import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentProjectScanBudget } from "./agent-project-discovery.js";
import { WorkflowRegistry } from "./workflow-registry.js";

async function writeMarker(
  dir: string,
  definitionId: number | null,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "sapiom.json"),
    JSON.stringify({ definitionId, ...extra }),
  );
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
    // Depth 8: right at the boundary — should be found.
    await writeMarker(path.join(tmpRoot, "a", "b", "c", "d", "e", "f", "g", "h"), 7);
    // Depth 9: past the boundary — should NOT be found.
    await writeMarker(path.join(tmpRoot, "d", "e", "f", "g", "h", "i", "j", "k", "l"), 9);
    // Inside generated/private trees — should never be scanned.
    await writeMarker(path.join(tmpRoot, "node_modules", "some-pkg"), 1);
    await writeMarker(path.join(tmpRoot, ".git", "worktrees", "x"), 1);
    await writeMarker(path.join(tmpRoot, ".sapiom", "generated"), 1);
    await writeMarker(path.join(tmpRoot, "dist", "generated"), 1);
    await writeMarker(path.join(tmpRoot, "build", "generated"), 1);
    await writeMarker(path.join(tmpRoot, ".next", "generated"), 1);

    const found = await registry.scan(tmpRoot);
    const byPath = new Map(found.map((workflow) => [workflow.path, workflow]));

    expect(byPath.get(path.join(tmpRoot, "proj-a"))).toEqual({
      name: "@acme/proj-a",
      path: path.join(tmpRoot, "proj-a"),
      definitionId: 42,
      definitionSlug: null,
      templateId: null,
      forkId: null,
      starterId: null,
      source: "scan",
    });
    expect(byPath.get(path.join(tmpRoot, "proj-b"))).toEqual({
      name: "proj-b",
      path: path.join(tmpRoot, "proj-b"),
      definitionId: null,
      definitionSlug: null,
      templateId: null,
      forkId: null,
      starterId: null,
      source: "scan",
    });
    expect(byPath.has(path.join(tmpRoot, "a", "b", "c", "d", "e", "f", "g", "h"))).toBe(
      true,
    );
    expect(
      byPath.has(path.join(tmpRoot, "d", "e", "f", "g", "h", "i", "j", "k", "l")),
    ).toBe(false);
    expect(
      found.some((workflow) => workflow.path.includes("node_modules")),
    ).toBe(false);
    expect(found.some((workflow) => workflow.path.includes(".git"))).toBe(false);
    expect(found.some((workflow) => workflow.path.includes(".sapiom"))).toBe(false);
    expect(found.some((workflow) => workflow.path.includes("dist"))).toBe(false);
    expect(found.some((workflow) => workflow.path.includes("build"))).toBe(false);
    expect(found.some((workflow) => workflow.path.includes(".next"))).toBe(false);
  });

  it("requires sapiom.json to contain a top-level JSON object", async () => {
    const invalidValues = ["not json", "null", "[]", '"project"', "42"];
    for (const [index, value] of invalidValues.entries()) {
      const dir = path.join(tmpRoot, `invalid-${index}`);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "sapiom.json"), value);
    }
    await writeMarker(path.join(tmpRoot, "valid-empty-object"), null);
    await fs.writeFile(path.join(tmpRoot, "valid-empty-object", "sapiom.json"), "{}");

    const found = await registry.scan(tmpRoot);
    expect(found.map((workflow) => workflow.name)).toEqual(["valid-empty-object"]);
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
      definitionSlug: null,
      templateId: null,
      forkId: null,
      starterId: null,
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

  it("passes marker provenance through both scan and connectPath", async () => {
    // A gallery clone writes templateId AND forkId; a scaffold writes starterId.
    const cloned = path.join(tmpRoot, "cloned");
    await writeMarker(cloned, null, {
      templateId: "web-research-digest",
      forkId: "fork-1",
    });
    const scaffolded = path.join(tmpRoot, "scaffolded");
    await writeMarker(scaffolded, null, { starterId: "coding-pause" });

    const byPath = new Map(
      (await registry.scan(tmpRoot)).map((workflow) => [workflow.path, workflow]),
    );
    expect(byPath.get(cloned)).toMatchObject({
      templateId: "web-research-digest",
      forkId: "fork-1",
      starterId: null,
    });
    expect(byPath.get(scaffolded)).toMatchObject({
      templateId: null,
      forkId: null,
      starterId: "coding-pause",
    });

    // The connect flow must carry the same fields — provenance that appears
    // for scanned agents but not connected ones reads as flaky analytics.
    expect(await registry.connectPath(cloned)).toMatchObject({
      templateId: "web-research-digest",
      forkId: "fork-1",
      starterId: null,
    });
  });

  it("a re-scan refreshes provenance written to the marker after first discovery", async () => {
    // Clone writes provenance after the files land — a row registered from a
    // pre-provenance marker must pick the fields up on the next scan's merge.
    const projectDir = path.join(tmpRoot, "late-provenance");
    await writeMarker(projectDir, null);
    await registry.scan(tmpRoot);

    await writeMarker(projectDir, null, { templateId: "tmpl-x" });
    await registry.scan(tmpRoot);

    const entry = (await registry.list()).find(
      (workflow) => workflow.path === projectDir,
    );
    expect(entry?.templateId).toBe("tmpl-x");
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

  it("reconciles a removed or malformed marker without removing manually connected folders", async () => {
    const scannedDir = path.join(tmpRoot, "scanned");
    const connectedDir = path.join(tmpRoot, "connected");
    await writeMarker(scannedDir, 1);
    await writeMarker(connectedDir, 2);
    await registry.scan(tmpRoot);
    await registry.connectPath(connectedDir);

    await fs.writeFile(path.join(scannedDir, "sapiom.json"), "not-json");
    await fs.rm(path.join(connectedDir, "sapiom.json"));
    await registry.scan(tmpRoot);

    expect((await registry.list()).map((workflow) => workflow.path)).toEqual([connectedDir]);
    expect((await registry.list())[0].source).toBe("connect");
  });

  it.skipIf(
    process.platform === "win32" ||
      (typeof process.getuid === "function" && process.getuid() === 0),
  )(
    "keeps a scanned project when its directory is temporarily unreadable",
    async () => {
      const projectDir = path.join(tmpRoot, "temporarily-unreadable");
      await writeMarker(projectDir, 1);
      await registry.scan(tmpRoot);

      await fs.chmod(projectDir, 0o000);
      try {
        await registry.scan(tmpRoot);

        expect(
          (await registry.list()).map((workflow) => workflow.path),
        ).toEqual([projectDir]);

        // The protection must apply to persisted state, not only this instance.
        const reloaded = new WorkflowRegistry(registryPath);
        expect(
          (await reloaded.list()).map((workflow) => workflow.path),
        ).toEqual([projectDir]);
      } finally {
        await fs.chmod(projectDir, 0o700);
      }
    },
  );

  it("does not reconcile a valid project outside the current scan envelope", async () => {
    const left = path.join(tmpRoot, "left", "project");
    const right = path.join(tmpRoot, "right", "project");
    await writeMarker(left, 1);
    await writeMarker(right, 2);
    await registry.scan(tmpRoot);
    await fs.rm(path.join(right, "sapiom.json"));

    await registry.scan(path.join(tmpRoot, "left"));

    expect((await registry.list()).map((workflow) => workflow.path).sort()).toEqual(
      [left, right].sort(),
    );
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

    it("persist uses atomic tmp-file + rename so a mid-write crash cannot tear workflows.json (C4)", async () => {
      // Verify: after a scan, the registry file exists at registryPath and no
      // .tmp file is left behind (the rename completed atomically).
      await writeMarker(path.join(tmpRoot, "proj-a"), 1);
      await registry.scan(tmpRoot);

      // The final file should exist and be valid JSON.
      const raw = await fs.readFile(registryPath, "utf8");
      const parsed = JSON.parse(raw) as unknown[];
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(1);

      // The .tmp file must NOT be left behind (rename completed).
      const tmpPath = `${registryPath}.tmp`;
      await expect(fs.access(tmpPath)).rejects.toThrow();
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

/**
 * The depth cap that predated the project-rooted rail was 3, which is shallower
 * than where agents actually sit under a root a user would choose. These pin
 * both halves of what replaced it: the reach, and the reconciliation rule that
 * keeps a *bounded* scan from mistaking "I didn't look there" for "it's gone".
 */
describe("WorkflowRegistry deep discovery under a chosen project root", () => {
  let projectRoot: string;
  let registryPath: string;
  let registry: WorkflowRegistry;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "harness-deep-root-"));
    registryPath = path.join(projectRoot, ".state", "workflows.json");
    registry = new WorkflowRegistry(registryPath);
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it("discovers an agent four and more segments below the opened root, under that root", async () => {
    // The real shape from the design doc: ~/polsia/backend/src/agents/ads.
    const ads = path.join(projectRoot, "backend", "src", "agents", "ads");
    const deeper = path.join(
      projectRoot,
      "apps",
      "web",
      "src",
      "features",
      "mail",
      "agents",
      "digest",
    );
    await writeMarker(ads, 1);
    await writeMarker(deeper, 2);

    const found = await registry.scan(projectRoot);
    const paths = found.map((workflow) => workflow.path);

    expect(paths).toContain(ads);
    expect(paths).toContain(deeper);
    // Filing under the root is what the rail does with these rows, so the row's
    // own path has to be inside the root the user opened — not a resolved
    // sibling, not the agent's git root.
    for (const found of paths) {
      expect(found.startsWith(`${projectRoot}${path.sep}`)).toBe(true);
    }
    // 7 segments deep — the design's deepest realistic layout, still inside 8.
    expect(path.relative(projectRoot, deeper).split(path.sep)).toHaveLength(7);
  });

  it("does not reconcile away a project below the depth a budget-truncated scan reached", async () => {
    // This is the failure a node budget introduces if reconciliation keeps
    // trusting the static cap: the scan stops early, finds nothing deep, and
    // deletes every deep row as "gone" on a tree where nothing changed.
    const deep = path.join(projectRoot, "backend", "src", "agents", "ads");
    await writeMarker(deep, 1);
    for (const sibling of ["a", "b", "c", "d", "e", "f"]) {
      await fs.mkdir(path.join(projectRoot, sibling, "child"), { recursive: true });
    }
    await registry.scan(projectRoot);
    expect((await registry.list()).map((workflow) => workflow.path)).toEqual([deep]);

    // Root + a few level-1 dirs and nothing more: the scan cannot have looked
    // at level 4, where the row lives.
    const starved = new AgentProjectScanBudget({ maxNodes: 4 });
    const found = await registry.scan(projectRoot, starved);

    expect(found).toEqual([]);
    expect(starved.truncated).toBe(true);
    expect(starved.envelopeDepth).toBeLessThan(4);
    expect((await registry.list()).map((workflow) => workflow.path)).toEqual([deep]);

    // And a scan that DID cover that depth still reconciles it away when the
    // marker really is gone — the protection is about coverage, not immunity.
    await fs.rm(path.join(deep, "sapiom.json"));
    await registry.scan(projectRoot);
    expect(await registry.list()).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "terminates on a symlink cycle and registers nothing through the link",
    async () => {
      const real = path.join(projectRoot, "pkg", "agents", "one");
      await writeMarker(real, 1);
      // loop -> the root itself: an infinitely deep tree if links were followed.
      await fs.symlink(projectRoot, path.join(projectRoot, "pkg", "loop"), "dir");

      const started = performance.now();
      const found = await registry.scan(projectRoot);
      const elapsed = performance.now() - started;

      expect(found.map((workflow) => workflow.path)).toEqual([real]);
      expect(elapsed).toBeLessThan(2_000);
    },
  );

  it("stays cheap on a large ignored tree — node_modules is never entered", async () => {
    const real = path.join(projectRoot, "pkg", "agents", "one");
    await writeMarker(real, 1);
    // 600 directories that must cost nothing, plus a marker inside one of them
    // that must never be registered.
    for (let i = 0; i < 200; i++) {
      await fs.mkdir(
        path.join(projectRoot, "node_modules", `pkg-${i}`, "dist", "esm"),
        { recursive: true },
      );
    }
    await writeMarker(path.join(projectRoot, "node_modules", "pkg-7", "agent"), 9);

    const budget = new AgentProjectScanBudget();
    const found = await registry.scan(projectRoot, budget);

    expect(found.map((workflow) => workflow.path)).toEqual([real]);
    // root + pkg + agents + one = 4. If node_modules were walked it would be
    // in the hundreds.
    expect(budget.visited).toBeLessThan(10);
  });
});
