import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AgentProjectScanAllowance,
  AgentProjectScanBudget,
} from "./agent-project-discovery.js";
import { AgentSourceScanBudget } from "./agent-source-discovery.js";
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

async function writeSourceAgent(
  dir: string,
  name: string,
  extraSource = "",
): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "index.ts"),
    `import { defineAgent } from "@sapiom/agent";
${extraSource}
export const agent = defineAgent({ name: ${JSON.stringify(name)} });`,
  );
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("WorkflowRegistry", () => {
  let tmpRoot: string;
  let registryPath: string;
  let registry: WorkflowRegistry;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "harness-workflow-registry-"),
    );
    registryPath = path.join(tmpRoot, "state", "workflows.json");
    registry = new WorkflowRegistry(registryPath);
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("starts empty when no registry file exists", async () => {
    expect(await registry.list()).toEqual([]);
  });

  it("shares one directory and source allowance across composite direct-root scans", async () => {
    const firstRoot = path.join(tmpRoot, "first");
    const secondRoot = path.join(tmpRoot, "second");
    await writeSourceAgent(firstRoot, "first");
    await writeSourceAgent(secondRoot, "second");
    const project = new AgentProjectScanAllowance(2);
    const source = new AgentSourceScanBudget({
      maxModules: 1,
      maxBytes: 1024 * 1024,
      maxLookups: 32,
    });

    const first = await registry.scanDetailed(
      firstRoot,
      new AgentProjectScanBudget({}, project),
      source,
    );
    const second = await registry.scanDetailed(
      secondRoot,
      new AgentProjectScanBudget({}, project),
      source,
    );

    expect(project.visited).toBe(2);
    expect(source.modules).toBe(1);
    expect(first.sourceBudget).toBe(source);
    expect(second.sourceBudget).toBe(source);
    expect(second.status).toBe("degraded");
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
    await writeMarker(
      path.join(tmpRoot, "a", "b", "c", "d", "e", "f", "g", "h"),
      7,
    );
    // Depth 9: past the boundary — should NOT be found.
    await writeMarker(
      path.join(tmpRoot, "d", "e", "f", "g", "h", "i", "j", "k", "l"),
      9,
    );
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
      markerPresent: true,
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
      markerPresent: true,
      templateId: null,
      forkId: null,
      starterId: null,
      source: "scan",
    });
    expect(
      byPath.has(path.join(tmpRoot, "a", "b", "c", "d", "e", "f", "g", "h")),
    ).toBe(true);
    expect(
      byPath.has(
        path.join(tmpRoot, "d", "e", "f", "g", "h", "i", "j", "k", "l"),
      ),
    ).toBe(false);
    expect(
      found.some((workflow) => workflow.path.includes("node_modules")),
    ).toBe(false);
    expect(found.some((workflow) => workflow.path.includes(".git"))).toBe(
      false,
    );
    expect(found.some((workflow) => workflow.path.includes(".sapiom"))).toBe(
      false,
    );
    expect(found.some((workflow) => workflow.path.includes("dist"))).toBe(
      false,
    );
    expect(found.some((workflow) => workflow.path.includes("build"))).toBe(
      false,
    );
    expect(found.some((workflow) => workflow.path.includes(".next"))).toBe(
      false,
    );
  });

  it("requires sapiom.json to contain a top-level JSON object", async () => {
    const invalidValues = ["not json", "null", "[]", '"project"', "42"];
    for (const [index, value] of invalidValues.entries()) {
      const dir = path.join(tmpRoot, `invalid-${index}`);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "sapiom.json"), value);
    }
    await writeMarker(path.join(tmpRoot, "valid-empty-object"), null);
    await fs.writeFile(
      path.join(tmpRoot, "valid-empty-object", "sapiom.json"),
      "{}",
    );

    const found = await registry.scan(tmpRoot);
    expect(found.map((workflow) => workflow.name)).toEqual([
      "valid-empty-object",
    ]);
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

  it("normalizes untrusted marker fields identically for scan, connect, and reload", async () => {
    const projectDir = path.join(tmpRoot, "malformed-fields");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(
      path.join(projectDir, "sapiom.json"),
      JSON.stringify({
        definitionId: "99",
        name: "bad/name",
        templateId: { private: true },
        forkId: "bad\u0085value",
        starterId: 42,
      }),
    );

    const scanned = (await registry.scan(tmpRoot))[0]!;
    const connected = await registry.connectPath(projectDir);
    const reloaded = (await new WorkflowRegistry(registryPath).list())[0]!;

    expect(scanned).toMatchObject({
      definitionId: null,
      definitionSlug: null,
      templateId: null,
      forkId: null,
      starterId: null,
      markerPresent: true,
    });
    expect({ ...connected, source: "scan" }).toEqual(scanned);
    expect(reloaded).toEqual(connected);
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
      (await registry.scan(tmpRoot)).map((workflow) => [
        workflow.path,
        workflow,
      ]),
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

    expect((await registry.list()).map((workflow) => workflow.path)).toEqual([
      connectedDir,
    ]);
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

    expect(
      (await registry.list()).map((workflow) => workflow.path).sort(),
    ).toEqual([left, right].sort());
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
      expect((await registry.list()).map((workflow) => workflow.path)).toEqual([
        liveDir,
      ]);

      // Persisted, not just dropped from the in-memory list.
      const reloaded = new WorkflowRegistry(registryPath);
      expect((await reloaded.list()).map((workflow) => workflow.path)).toEqual([
        liveDir,
      ]);
    });

    it("keeps an existing-but-unbuilt project (only nonexistent paths are pruned)", async () => {
      // A bare directory with a marker and nothing else — no node_modules,
      // no build output. Deleting nothing: prune must keep it.
      const unbuiltDir = path.join(tmpRoot, "unbuilt");
      await writeMarker(unbuiltDir, 3);
      await registry.scan(tmpRoot);

      expect(await registry.prune()).toEqual([]);
      expect((await registry.list()).map((workflow) => workflow.path)).toEqual([
        unbuiltDir,
      ]);
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
    it("compensates a scan superseded after rename so disk never retains unpublished rows", async () => {
      const projectDir = path.join(tmpRoot, "source-agent");
      const renamed = deferred();
      const releaseRename = deferred();
      let pauseNextRename = false;
      const guardedRegistry = new WorkflowRegistry(registryPath, undefined, {
        afterPrimaryRename: async () => {
          if (!pauseNextRename) return;
          pauseNextRename = false;
          renamed.resolve();
          await releaseRename.promise;
        },
      });

      await writeSourceAgent(projectDir, "accepted-a");
      await guardedRegistry.scanDetailed(tmpRoot);
      pauseNextRename = true;
      await writeSourceAgent(projectDir, "intermediate-b");
      const intermediateScan = guardedRegistry.scanDetailed(tmpRoot);
      await renamed.promise;

      const renamedRows = JSON.parse(
        await fs.readFile(registryPath, "utf8"),
      ) as Array<{ sourceDefinitionName?: string }>;
      expect(renamedRows[0]?.sourceDefinitionName).toBe("intermediate-b");

      await writeSourceAgent(projectDir, "accepted-a");
      expect(guardedRegistry.markDiscoveryDirty(tmpRoot)).toBe(true);
      releaseRename.resolve();
      await expect(intermediateScan).rejects.toThrow(/superseded/);

      // This recovery is deliberately row-identical to the in-memory accepted
      // snapshot. Without compensation, it skips persistence and a restart
      // observes the unpublished intermediate-b rename forever.
      await guardedRegistry.scanDetailed(tmpRoot);
      const reloaded = await new WorkflowRegistry(registryPath).list();
      expect(reloaded[0]?.sourceDefinitionName).toBe("accepted-a");
    });

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
describe("WorkflowRegistry path identity under symlinks", () => {
  let tmpRoot: string;
  let registryPath: string;

  beforeEach(async () => {
    // Resolve up front: on macOS `os.tmpdir()` is itself a symlink, which
    // would make every path in the test canonical by accident.
    tmpRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "harness-registry-symlink-")),
    );
    registryPath = path.join(tmpRoot, "state", "workflows.json");
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("connects a symlinked path onto the scanned row instead of duplicating it", async () => {
    const real = path.join(tmpRoot, "workspace");
    await writeMarker(path.join(real, "growth"), null, { name: "growth" });
    const link = path.join(tmpRoot, "linked-workspace");
    await fs.symlink(real, link, "dir");

    const registry = new WorkflowRegistry(registryPath);
    await registry.scan(real, new AgentProjectScanBudget());
    await registry.connectPath(path.join(link, "growth"));

    // One row, still under the spelling the scan stored: a second row for the
    // same directory collides into `local:` keys and drops every edge, while
    // rewriting the kept row's path would unbind a session matching on it.
    expect((await registry.list()).map((workflow) => workflow.path)).toEqual([
      path.join(real, "growth"),
    ]);
  });

});

describe("WorkflowRegistry scan rootedness (the 88-agent accumulation)", () => {
  let tmpRoot: string;
  let registry: WorkflowRegistry;

  /** The measured shape of the anomaly: a launch dir with its own agents, and
   *  sibling checkouts of one repo, each carrying the SAME four agents. */
  async function buildSiblingCheckouts(): Promise<void> {
    await writeMarker(
      path.join(tmpRoot, "wf-demo-testing", "agents", "mine"),
      1,
    );
    await writeMarker(
      path.join(tmpRoot, "wf-demo-testing", "demo", "also-mine"),
      2,
    );
    for (const checkout of [
      "design-eng",
      "design-eng-fix",
      "worktrees/port-pin",
    ]) {
      await fs.mkdir(path.join(tmpRoot, checkout, ".git"), { recursive: true });
      for (const agent of ["ari/orchestration", "brain/agent"]) {
        await writeMarker(path.join(tmpRoot, checkout, agent), null);
      }
    }
  }

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "harness-scan-rooted-"));
    registry = new WorkflowRegistry(
      path.join(tmpRoot, ".state", "workflows.json"),
    );
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("a scan of the launch dir registers exactly the launch dir's agents", async () => {
    await buildSiblingCheckouts();

    const found = await registry.scan(path.join(tmpRoot, "wf-demo-testing"));

    expect(
      found.map((workflow) => path.relative(tmpRoot, workflow.path)).sort(),
    ).toEqual(
      [
        path.join("wf-demo-testing", "agents", "mine"),
        path.join("wf-demo-testing", "demo", "also-mine"),
      ].sort(),
    );
  });

  it("a scan rooted a level too high does not wander into sibling checkouts", async () => {
    await buildSiblingCheckouts();

    // Before the repository boundary this returned 8: the launch dir's 2 plus
    // two agents from each of three checkouts of the same repo — the "six
    // copies of one agent" the rail was showing.
    const found = await registry.scan(tmpRoot);

    expect(
      found.map((workflow) => path.relative(tmpRoot, workflow.path)).sort(),
    ).toEqual(
      [
        path.join("wf-demo-testing", "agents", "mine"),
        path.join("wf-demo-testing", "demo", "also-mine"),
      ].sort(),
    );
    expect(found.some((workflow) => workflow.path.includes("design-eng"))).toBe(
      false,
    );
  });

  it("a checkout that IS an agent is still registered — the marker outranks the boundary", async () => {
    const soloAgent = path.join(tmpRoot, "solo-agent");
    await writeMarker(soloAgent, 7);
    await fs.mkdir(path.join(soloAgent, ".git"), { recursive: true });

    const found = await registry.scan(tmpRoot);

    expect(found.map((workflow) => workflow.path)).toEqual([soloAgent]);
  });

  it("a scan of a parent does not DELETE agents inside a checkout the user opened separately", async () => {
    // The reconciliation trap the boundary introduces: the parent scan stops at
    // the checkout, finds no marker below it, and the depth envelope alone
    // would call every row under it gone.
    const inner = path.join(tmpRoot, "opened-repo", "agents", "worker");
    await fs.mkdir(path.join(tmpRoot, "opened-repo", ".git"), {
      recursive: true,
    });
    await writeMarker(inner, 5);
    await registry.scan(path.join(tmpRoot, "opened-repo"));
    expect((await registry.list()).map((workflow) => workflow.path)).toEqual([
      inner,
    ]);

    await registry.scan(tmpRoot);

    expect((await registry.list()).map((workflow) => workflow.path)).toEqual([
      inner,
    ]);
  });
});

describe("WorkflowRegistry stale entries", () => {
  let tmpRoot: string;
  let registryPath: string;
  let registry: WorkflowRegistry;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "harness-stale-"));
    registryPath = path.join(tmpRoot, ".state", "workflows.json");
    registry = new WorkflowRegistry(registryPath);
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("list() stays cache-backed while its lazy prune runs in the background", async () => {
    const gone = path.join(tmpRoot, "gone");
    const stays = path.join(tmpRoot, "stays");
    await writeMarker(gone, 1);
    await writeMarker(stays, 2);
    await registry.scan(tmpRoot);
    await fs.rm(gone, { recursive: true, force: true });

    // A fresh instance, so the throttle window has not been consumed — this is
    // the shape of "the SPA asks /api/workflows again".
    const reader = new WorkflowRegistry(registryPath);
    expect((await reader.list()).map((workflow) => workflow.path)).toEqual([
      gone,
      stays,
    ]);
    await reader.prune();
    expect((await reader.list()).map((workflow) => workflow.path)).toEqual([
      stays,
    ]);

    // And it is persisted, not merely filtered on the way out.
    expect(JSON.parse(await fs.readFile(registryPath, "utf8"))).toHaveLength(1);
  });

  it("a scan drops a dead entry rooted somewhere the scan never looks", async () => {
    const here = path.join(tmpRoot, "here", "agent");
    const elsewhere = path.join(tmpRoot, "elsewhere", "agent");
    await writeMarker(here, 1);
    await writeMarker(elsewhere, 2);
    await registry.scan(tmpRoot);
    await fs.rm(path.join(tmpRoot, "elsewhere"), {
      recursive: true,
      force: true,
    });

    await registry.scan(path.join(tmpRoot, "here"));

    expect((await registry.list()).map((workflow) => workflow.path)).toEqual([
      here,
    ]);
  });

  it("retires source observations when an unrelated scan prunes their missing row", async () => {
    const here = path.join(tmpRoot, "here", "agent");
    const elsewhere = path.join(tmpRoot, "elsewhere", "agent");
    await writeMarker(here, 1);
    await writeSourceAgent(elsewhere, "elsewhere");
    await registry.scan(tmpRoot);
    expect(
      (await registry.inventorySnapshot(tmpRoot)).sourceObservations.some(
        (observation) => observation.candidateRoot === elsewhere,
      ),
    ).toBe(true);

    await fs.rm(path.join(tmpRoot, "elsewhere"), {
      recursive: true,
      force: true,
    });
    await registry.scan(path.join(tmpRoot, "here"));

    const snapshot = await registry.inventorySnapshot(tmpRoot);
    expect(snapshot.workflows.map((workflow) => workflow.path)).toEqual([here]);
    expect(
      snapshot.sourceObservations.some(
        (observation) =>
          observation.candidateRoot === elsewhere ||
          observation.paths.some((observedPath) =>
            observedPath.startsWith(elsewhere),
          ),
      ),
    ).toBe(false);
  });

  it("prune retires canonical identity and source-observation sidecars", async () => {
    const gone = path.join(tmpRoot, "gone");
    await writeSourceAgent(gone, "gone");
    await registry.scan(tmpRoot);
    await fs.rm(gone, { recursive: true, force: true });

    await registry.prune();

    const snapshot = await registry.inventorySnapshot(tmpRoot);
    expect(snapshot.workflows).toEqual([]);
    expect(snapshot.canonicalWorkflowRoots).toEqual([]);
    expect(snapshot.sourceObservations).toEqual([]);
  });

  it("keeps an unreadable-but-present directory: only a confirmed-missing path leaves", async () => {
    const unbuilt = path.join(tmpRoot, "unbuilt");
    await writeMarker(unbuilt, 1);
    await registry.scan(tmpRoot);
    await fs.rm(path.join(unbuilt, "sapiom.json"));

    // Marker gone but directory present: reconciled out of the scan envelope,
    // never touched by the missing-path sweep. (Here the scan removes it; the
    // point is that the sweep is not what did.)
    const reader = new WorkflowRegistry(registryPath);
    expect((await reader.list()).map((workflow) => workflow.path)).toEqual([
      unbuilt,
    ]);
  });
});

describe("WorkflowRegistry deep discovery under a chosen project root", () => {
  let projectRoot: string;
  let registryPath: string;
  let registry: WorkflowRegistry;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "harness-deep-root-"),
    );
    registryPath = path.join(projectRoot, ".state", "workflows.json");
    registry = new WorkflowRegistry(registryPath);
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it("discovers an agent four and more segments below the opened root, under that root", async () => {
    // The shape the design doc describes: <root>/backend/src/agents/<agent>.
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
      await fs.mkdir(path.join(projectRoot, sibling, "child"), {
        recursive: true,
      });
    }
    await registry.scan(projectRoot);
    expect((await registry.list()).map((workflow) => workflow.path)).toEqual([
      deep,
    ]);

    // Root + a few level-1 dirs and nothing more: the scan cannot have looked
    // at level 4, where the row lives.
    const starved = new AgentProjectScanBudget({ maxNodes: 4 });
    const found = await registry.scan(projectRoot, starved);

    expect(found).toEqual([]);
    expect(starved.truncated).toBe(true);
    expect(starved.envelopeDepth).toBeLessThan(4);
    expect((await registry.list()).map((workflow) => workflow.path)).toEqual([
      deep,
    ]);

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
      await fs.symlink(
        projectRoot,
        path.join(projectRoot, "pkg", "loop"),
        "dir",
      );

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
    await writeMarker(
      path.join(projectRoot, "node_modules", "pkg-7", "agent"),
      9,
    );

    const budget = new AgentProjectScanBudget();
    const found = await registry.scan(projectRoot, budget);

    expect(found.map((workflow) => workflow.path)).toEqual([real]);
    // root + pkg + agents + one = 4. If node_modules were walked it would be
    // in the hundreds.
    expect(budget.visited).toBeLessThan(10);
  });
});

describe("WorkflowRegistry syntax-only inventory reconciliation", () => {
  let root: string;
  let registryPath: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "harness-source-registry-"));
    registryPath = path.join(root, ".state", "workflows.json");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("discovers, persists, and reloads a source-only row without shape drift", async () => {
    const agent = path.join(root, "agents", "billing");
    await writeSourceAgent(agent, "billing");
    await fs.writeFile(
      path.join(agent, "package.json"),
      JSON.stringify({ name: "@acme/billing" }),
    );
    const registry = new WorkflowRegistry(registryPath);

    const found = await registry.scan(root);
    expect(found).toEqual([
      {
        name: "@acme/billing",
        path: agent,
        definitionId: null,
        definitionSlug: null,
        sourceDefinitionName: "billing",
        activeBuildRunId: null,
        activeBuildRunStatus: null,
        templateId: null,
        forkId: null,
        starterId: null,
        source: "scan",
      },
    ]);
    expect((await registry.inventorySnapshot(root)).status).toBe("complete");

    const reloaded = new WorkflowRegistry(registryPath);
    expect(await reloaded.list()).toEqual(await registry.list());
    expect((await reloaded.inventorySnapshot(root)).status).toBe("degraded");
  });

  it("retires the candidate's syntax observations when a valid marker takes precedence", async () => {
    const agent = path.join(root, "agent");
    await writeSourceAgent(
      agent,
      "source-name",
      `import { helper } from "./helper";\nvoid helper;`,
    );
    await fs.writeFile(
      path.join(agent, "helper.ts"),
      `export const helper = 1;`,
    );
    const registry = new WorkflowRegistry(registryPath);
    await registry.scan(root);
    expect(
      (await registry.inventorySnapshot(root)).sourceObservations.some(
        (observation) => observation.candidateRoot === agent,
      ),
    ).toBe(true);

    await writeMarker(agent, null, { name: "marker-name" });
    await registry.scan(root);

    expect(
      (await registry.inventorySnapshot(root)).sourceObservations.some(
        (observation) => observation.candidateRoot === agent,
      ),
    ).toBe(false);
  });

  it("keeps source observations scoped to the scan envelope across a direct child rescan", async () => {
    const agent = path.join(root, "agent");
    const shared = path.join(root, "shared.ts");
    await fs.mkdir(agent, { recursive: true });
    await fs.writeFile(
      shared,
      `export { defineAgent as makeAgent } from "@sapiom/agent";`,
    );
    await fs.writeFile(
      path.join(agent, "index.ts"),
      `import { makeAgent } from "../shared.js";
export const agent = makeAgent({ name: "broad-agent" });`,
    );
    const registry = new WorkflowRegistry(registryPath);
    await registry.scan(root);
    await registry.scan(agent);

    const observations = (await registry.inventorySnapshot(root))
      .sourceObservations;
    const broad = observations.find(
      (observation) =>
        observation.workspaceRoot === root &&
        observation.candidateRoot === agent,
    );
    const direct = observations.find(
      (observation) =>
        observation.workspaceRoot === agent &&
        observation.candidateRoot === agent,
    );
    expect(broad?.paths).toContain(shared);
    expect(direct?.paths).not.toContain(shared);
  });

  it.skipIf(process.platform === "win32")(
    "projects lexical watch paths into a symlink-selected canonical envelope",
    async () => {
      const realWorkspace = path.join(root, "real-workspace");
      const linkedWorkspace = path.join(root, "linked-workspace");
      const realAgent = path.join(realWorkspace, "agent");
      await fs.mkdir(realAgent, { recursive: true });
      await fs.writeFile(
        path.join(realAgent, "index.ts"),
        `import { makeAgent } from "./helper.js";
export const agent = makeAgent({ name: "linked-agent" });`,
      );
      await fs.writeFile(
        path.join(realAgent, "helper.ts"),
        `export { defineAgent as makeAgent } from "@sapiom/agent";`,
      );
      await fs.symlink(realWorkspace, linkedWorkspace, "dir");
      const registry = new WorkflowRegistry(registryPath);

      await registry.scan(linkedWorkspace);

      const observation = (
        await registry.inventorySnapshot(linkedWorkspace)
      ).sourceObservations.find((entry) => entry.candidateRoot === realAgent);
      expect(observation?.workspaceRoot).toBe(realWorkspace);
      expect(observation?.paths).toContain(path.join(realAgent, "helper.ts"));
      expect(
        observation?.paths.some((observedPath) =>
          observedPath.startsWith(linkedWorkspace),
        ),
      ).toBe(false);
    },
  );

  it("falls through an invalid marker but not a foreign repository boundary", async () => {
    const nested = path.join(root, "nested-repo");
    await writeSourceAgent(nested, "nested");
    await fs.writeFile(path.join(nested, "sapiom.json"), "not-json");
    await fs.mkdir(path.join(nested, ".git"));
    const parentRegistry = new WorkflowRegistry(registryPath);

    expect(await parentRegistry.scan(root)).toEqual([]);

    const directRegistry = new WorkflowRegistry(
      path.join(root, ".state", "direct.json"),
    );
    await expect(directRegistry.scan(nested)).resolves.toMatchObject([
      { path: nested, sourceDefinitionName: "nested" },
    ]);
  });

  it("continues below an incomplete source candidate to nested agents and markers", async () => {
    const unresolved = path.join(root, "unresolved");
    await fs.mkdir(unresolved, { recursive: true });
    await fs.writeFile(
      path.join(unresolved, "index.ts"),
      `export { agent } from "./missing";`,
    );
    const nestedSource = path.join(unresolved, "nested-source");
    const nestedMarker = path.join(unresolved, "nested-marker");
    await writeSourceAgent(nestedSource, "nested-source");
    await writeMarker(nestedMarker, 17, { name: "nested-marker" });
    const registry = new WorkflowRegistry(registryPath);

    const found = await registry.scan(root);

    expect(found).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: nestedSource,
          sourceDefinitionName: "nested-source",
        }),
        expect.objectContaining({
          path: nestedMarker,
          definitionId: 17,
        }),
      ]),
    );
    expect((await registry.inventorySnapshot(root)).status).toBe("degraded");
  });

  it.each(["marker", "source"] as const)(
    "preserves directly proven descendants below a discovered %s stop root",
    async (parentKind) => {
      const parent = path.join(root, `${parentKind}-parent`);
      const nested = path.join(parent, "nested-agent");
      await writeSourceAgent(nested, "nested-agent");
      const registry = new WorkflowRegistry(registryPath);

      await registry.scan(nested);
      expect((await registry.inventorySnapshot(nested)).status).toBe(
        "complete",
      );

      if (parentKind === "marker") {
        await writeMarker(parent, 77, { name: "parent-marker" });
      } else {
        await writeSourceAgent(parent, "parent-source");
      }
      await registry.scan(root);

      expect((await registry.list()).map((row) => row.path).sort()).toEqual(
        [nested, parent].sort(),
      );
      expect((await registry.inventorySnapshot(root)).status).toBe("complete");
      // The parent candidate was proven, but its descendants were deliberately
      // not traversed after the discovery stop.
      expect((await registry.inventorySnapshot(nested)).status).toBe(
        "complete",
      );
    },
  );

  it("preserves connected cloud evidence while syntax identity becomes canonical", async () => {
    const agent = path.join(root, "connected");
    await writeMarker(agent, 42, {
      name: "payments",
      templateId: "template-old",
    });
    const registry = new WorkflowRegistry(registryPath);
    await registry.connectPath(agent);
    await fs.rm(path.join(agent, "sapiom.json"));
    await writeSourceAgent(agent, "billing");

    await registry.scan(root);
    expect(await registry.list()).toMatchObject([
      {
        path: agent,
        source: "connect",
        definitionId: 42,
        definitionSlug: "payments",
        templateId: "template-old",
        sourceDefinitionName: "billing",
      },
    ]);

    await writeMarker(agent, 99, { name: "current-marker" });
    await registry.scan(root);
    const adoptedMarker = (await registry.list())[0]!;
    expect(adoptedMarker.definitionId).toBe(42);
    expect(adoptedMarker.definitionSlug).toBe("payments");
    expect(adoptedMarker).not.toHaveProperty("sourceDefinitionName");
  });

  it.each(["remove", "ordinary"])(
    "retires stale source evidence from a connected row after a definitive %s",
    async (mode) => {
      const agent = path.join(root, "connected");
      await writeSourceAgent(agent, "before");
      const registry = new WorkflowRegistry(registryPath);
      await registry.scan(root);
      await registry.connectPath(agent);

      if (mode === "remove") {
        await fs.rm(path.join(agent, "index.ts"));
      } else {
        await fs.writeFile(
          path.join(agent, "index.ts"),
          `export const ordinary = true;`,
        );
      }
      await registry.scan(root);

      const row = (await registry.list())[0]!;
      expect(row.source).toBe("connect");
      expect(row).not.toHaveProperty("sourceDefinitionName");
    },
  );

  it.skipIf(process.platform === "win32")(
    "deduplicates canonical aliases while preserving lexical path and complementary evidence",
    async () => {
      const real = path.join(root, "real-agent");
      const alias = path.join(root, "agent-alias");
      await fs.mkdir(real);
      await fs.symlink(real, alias, "dir");
      await fs.mkdir(path.dirname(registryPath), { recursive: true });
      await fs.writeFile(
        registryPath,
        JSON.stringify([
          {
            name: "connected",
            path: alias,
            definitionId: 7,
            definitionSlug: "marker-name",
            sourceDefinitionName: null,
            templateId: null,
            forkId: "fork-1",
            starterId: null,
            source: "connect",
          },
          {
            name: "source",
            path: real,
            definitionId: null,
            definitionSlug: null,
            sourceDefinitionName: "source-name",
            templateId: "template-1",
            forkId: null,
            starterId: "starter-1",
            source: "scan",
          },
        ]),
      );

      const registry = new WorkflowRegistry(registryPath);
      expect(await registry.list()).toMatchObject([
        {
          path: alias,
          source: "connect",
          definitionId: 7,
          definitionSlug: "marker-name",
          sourceDefinitionName: "source-name",
          templateId: "template-1",
          forkId: "fork-1",
          starterId: "starter-1",
        },
      ]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps a scan row's lexical alias stable across canonical-root rescans",
    async () => {
      const realRoot = path.join(root, "real-workspace");
      const linkedRoot = path.join(root, "workspace-link");
      const realAgent = path.join(realRoot, "agent");
      await writeSourceAgent(realAgent, "stable-path");
      await fs.symlink(realRoot, linkedRoot, "dir");
      const registry = new WorkflowRegistry(registryPath);

      await registry.scan(linkedRoot);
      const lexicalAgent = path.join(linkedRoot, "agent");
      expect((await registry.list())[0]?.path).toBe(lexicalAgent);
      const before = await registry.inventorySnapshot(linkedRoot);

      await registry.scan(realRoot);
      expect((await registry.list())[0]?.path).toBe(lexicalAgent);
      expect((await registry.inventorySnapshot(realRoot)).workflows).toEqual(
        before.workflows,
      );
      expect((await registry.inventorySnapshot(linkedRoot)).status).toBe(
        "complete",
      );
      expect((await registry.inventorySnapshot(realRoot)).status).toBe(
        "complete",
      );
    },
  );

  it("sanitizes source identity and bounded package labels before persistence", async () => {
    const invalid = path.join(root, "invalid-package");
    await writeSourceAgent(invalid, "bad/name");
    await fs.writeFile(
      path.join(invalid, "package.json"),
      JSON.stringify({ name: 42, padding: "x".repeat(70 * 1024) }),
    );
    const registry = new WorkflowRegistry(registryPath);

    await registry.scan(root);
    expect(await registry.list()).toMatchObject([
      {
        name: "invalid-package",
        sourceDefinitionName: null,
      },
    ]);
    expect(await new WorkflowRegistry(registryPath).list()).toEqual(
      await registry.list(),
    );
  });

  it.skipIf(process.platform === "win32")(
    "does not follow a package.json symlink for a display label",
    async () => {
      const agent = path.join(root, "symlink-package");
      const external = path.join(root, "external-package.json");
      await writeSourceAgent(agent, "safe");
      await fs.writeFile(external, JSON.stringify({ name: "external-secret" }));
      await fs.symlink(external, path.join(agent, "package.json"));
      const registry = new WorkflowRegistry(registryPath);

      await registry.scan(root);
      expect((await registry.list())[0]?.name).toBe("symlink-package");
    },
  );

  it("keeps completeness honest and supersedes only proven child coverage", async () => {
    const child = path.join(root, "child");
    await writeSourceAgent(child, "child");
    const registry = new WorkflowRegistry(registryPath);
    expect((await registry.inventorySnapshot(root)).status).toBe("degraded");

    await registry.scan(child);
    expect((await registry.inventorySnapshot(child)).status).toBe("complete");
    await fs.writeFile(
      path.join(child, "index.ts"),
      `export { agent } from "./missing";`,
    );
    await registry.scan(root);
    expect((await registry.inventorySnapshot(child)).status).toBe("degraded");
    expect((await registry.inventorySnapshot(root)).status).toBe("degraded");

    await writeSourceAgent(child, "child");
    await registry.scan(root);
    expect((await registry.inventorySnapshot(root)).status).toBe("complete");
    expect((await registry.inventorySnapshot(child)).status).toBe("complete");
  });

  it("preserves a complete child claim when uncertainty is confined to a sibling", async () => {
    const proven = path.join(root, "proven");
    const unresolved = path.join(root, "unresolved");
    await writeSourceAgent(proven, "proven");
    await fs.mkdir(unresolved, { recursive: true });
    await fs.writeFile(
      path.join(unresolved, "index.ts"),
      `export { agent } from "./missing";`,
    );
    const registry = new WorkflowRegistry(registryPath);
    await registry.scan(proven);
    expect((await registry.inventorySnapshot(proven)).status).toBe("complete");

    await registry.scan(root);

    expect((await registry.inventorySnapshot(root)).status).toBe("degraded");
    expect((await registry.inventorySnapshot(proven)).status).toBe("complete");
  });

  it("keeps exact ignored-child status separate from a complete parent envelope", async () => {
    const ignored = path.join(root, "node_modules", "selected-agent");
    await fs.mkdir(ignored, { recursive: true });
    await fs.writeFile(
      path.join(ignored, "index.ts"),
      `export { agent } from "./missing";`,
    );
    const registry = new WorkflowRegistry(registryPath);
    await registry.scan(ignored);
    expect((await registry.inventorySnapshot(ignored)).status).toBe("degraded");

    await registry.scan(root);

    expect((await registry.inventorySnapshot(root)).status).toBe("complete");
    expect((await registry.inventorySnapshot(ignored)).status).toBe("degraded");
  });

  it("preserves a directly scanned source row and its proof below an ignored parent boundary", async () => {
    const ignored = path.join(root, "node_modules", "selected-agent");
    await writeSourceAgent(
      ignored,
      "selected-agent",
      `import { helper } from "./helper";\nvoid helper;`,
    );
    await fs.writeFile(
      path.join(ignored, "helper.ts"),
      `export const helper = true;`,
    );
    const registry = new WorkflowRegistry(registryPath);

    await registry.scan(ignored);
    const direct = await registry.inventorySnapshot(ignored);
    expect(direct.workflows.map((workflow) => workflow.path)).toEqual([
      ignored,
    ]);
    expect(direct.canonicalWorkflowRoots).toEqual([
      expect.objectContaining({
        canonicalRoot: ignored,
        identityEvidence: "source",
      }),
    ]);
    expect(
      direct.sourceObservations.some(
        (observation) => observation.candidateRoot === ignored,
      ),
    ).toBe(true);

    await registry.scan(root);

    const parent = await registry.inventorySnapshot(root);
    expect(parent.workflows.map((workflow) => workflow.path)).toEqual([
      ignored,
    ]);
    expect(parent.canonicalWorkflowRoots).toEqual([
      expect.objectContaining({
        canonicalRoot: ignored,
        identityEvidence: "source",
      }),
    ]);
    expect(
      parent.sourceObservations.some(
        (observation) => observation.candidateRoot === ignored,
      ),
    ).toBe(true);
    expect((await registry.inventorySnapshot(ignored)).status).toBe("complete");
  });

  it.skipIf(process.platform === "win32")(
    "retires a parent-owned source row when that candidate becomes a foreign repository",
    async () => {
      const checkout = path.join(root, "checkout");
      await writeSourceAgent(checkout, "checkout-agent");
      const registry = new WorkflowRegistry(registryPath);

      await registry.scan(root);
      expect((await registry.list()).map((workflow) => workflow.path)).toEqual([
        checkout,
      ]);

      await fs.mkdir(path.join(checkout, ".git"));
      await registry.scan(root);
      expect(await registry.list()).toEqual([]);

      // Selecting the repository itself is explicit proof. A later parent
      // scan preserves that directly-owned row behind the boundary.
      await registry.scan(checkout);
      expect((await registry.list()).map((workflow) => workflow.path)).toEqual([
        checkout,
      ]);
      await registry.scan(root);
      expect((await registry.list()).map((workflow) => workflow.path)).toEqual([
        checkout,
      ]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps nested-repository completeness exact across parent scans",
    async () => {
      const checkout = path.join(root, "checkout");
      await writeSourceAgent(checkout, "checkout-agent");
      await fs.mkdir(path.join(checkout, ".git"));
      const registry = new WorkflowRegistry(registryPath);

      await registry.scan(root);
      expect((await registry.inventorySnapshot(root)).status).toBe("complete");
      expect((await registry.inventorySnapshot(checkout)).status).toBe(
        "degraded",
      );

      await registry.scan(checkout);
      expect((await registry.inventorySnapshot(checkout)).status).toBe(
        "complete",
      );

      await registry.scan(root);
      expect((await registry.inventorySnapshot(root)).status).toBe("complete");
      expect((await registry.inventorySnapshot(checkout)).status).toBe(
        "complete",
      );
    },
  );
});
