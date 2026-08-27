import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AGENT_PROJECT_MARKER } from "../shared/types.js";
import {
  AGENT_PROJECT_SCAN_MAX_DEPTH,
  AGENT_PROJECT_SCAN_MAX_NODES,
  AGENT_PROJECT_WATCH_MAX_NODES,
  AgentProjectScanBudget,
  type AgentProjectWalkAction,
  readAgentProjectMarker,
  readAgentProjectMarkerSync,
  walkAgentProjectTree,
  walkAgentProjectTreeAsync,
} from "./agent-project-discovery.js";

describe("agent project marker reads", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "harness-agent-marker-"));
  });

  afterEach(async () => {
    await fs.rm(root, { force: true, recursive: true });
  });

  it("reads the fixed marker directly beneath the selected directory", async () => {
    // Includes the provenance fields to pin the parser's wholesale cast:
    // fields it doesn't know by name still round-trip.
    const marker = {
      definitionId: 42,
      name: "approval-agent",
      templateId: "tmpl-1",
      forkId: "fork-1",
      starterId: "coding-pause",
    };
    await fs.writeFile(
      path.join(root, AGENT_PROJECT_MARKER),
      JSON.stringify(marker),
    );

    expect(await readAgentProjectMarker(root)).toEqual(marker);
    expect(readAgentProjectMarkerSync(root)).toEqual(marker);
  });

  it("rejects a marker symlink instead of following it to another file", async () => {
    const outside = path.join(
      path.dirname(root),
      `${path.basename(root)}-outside.json`,
    );
    await fs.writeFile(outside, JSON.stringify({ definitionId: 999 }));
    await fs.symlink(outside, path.join(root, AGENT_PROJECT_MARKER));

    try {
      expect(await readAgentProjectMarker(root)).toBeNull();
      expect(readAgentProjectMarkerSync(root)).toBeNull();
    } finally {
      await fs.rm(outside, { force: true });
    }
  });
});

/**
 * The traversal policy that replaced the fixed depth cap. These assert the
 * three properties the bound is *sold* on — breadth-first so a budget cut
 * degrades by depth, sorted so the cut is reproducible, and dirent-typed so a
 * symlink cycle terminates — plus that the sync and async walks agree.
 */
describe("bounded agent-project traversal", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "harness-agent-walk-"));
  });

  afterEach(async () => {
    await fs.rm(root, { force: true, recursive: true });
  });

  /** Records every directory the walk enters, in order, and descends always. */
  function recorder(): { visits: [string, number][]; onDirectory: (dir: string, depth: number) => AgentProjectWalkAction } {
    const visits: [string, number][] = [];
    return {
      visits,
      onDirectory: (dir, depth) => {
        visits.push([path.relative(root, dir) || ".", depth]);
        return "descend";
      },
    };
  }

  async function mkdirs(...relative: string[]): Promise<void> {
    for (const rel of relative) await fs.mkdir(path.join(root, rel), { recursive: true });
  }

  it("visits shallowest-first, so a truncated walk loses the DEEPEST level, not a branch", async () => {
    await mkdirs("a/deep/deeper", "b/deep/deeper", "c/deep/deeper");

    const rec = recorder();
    const budget = walkAgentProjectTree(root, rec, new AgentProjectScanBudget());
    const depths = rec.visits.map(([, depth]) => depth);

    // Non-decreasing depth is what "breadth-first" means operationally, and it
    // is the whole reason the node budget is a safe replacement for the cap.
    expect(depths).toEqual([...depths].sort((x, y) => x - y));
    expect(budget.visited).toBe(rec.visits.length);
    expect(budget.truncated).toBe(false);
    expect(budget.envelopeDepth).toBe(budget.maxDepth);
  });

  it("stops the node budget at maxNodes and reports one level above the cut as trustworthy", async () => {
    // 1 root + 4 children + 16 grandchildren.
    for (const a of ["a", "b", "c", "d"]) {
      for (const b of ["w", "x", "y", "z"]) await mkdirs(`${a}/${b}`);
    }

    const budget = walkAgentProjectTree(
      root,
      recorder(),
      new AgentProjectScanBudget({ maxNodes: 10 }),
    );

    expect(budget.visited).toBe(10);
    // Root + 4 children fit; the cut therefore lands inside level 2.
    expect(budget.truncatedAtDepth).toBe(2);
    // Levels 0 and 1 are complete, so only those may be reconciled against.
    expect(budget.envelopeDepth).toBe(1);
  });

  it("truncates at the same place twice, so a fingerprint built from it holds still", async () => {
    for (const a of ["a", "b", "c", "d", "e", "f"]) {
      for (const b of ["m", "n", "o", "p"]) await mkdirs(`${a}/${b}`);
    }

    const runs = [0, 1].map(() => {
      const rec = recorder();
      walkAgentProjectTree(root, rec, new AgentProjectScanBudget({ maxNodes: 12 }));
      return rec.visits.map(([rel]) => rel);
    });

    expect(runs[0]).toEqual(runs[1]);
    expect(runs[0].length).toBe(12);
  });

  it("never enters an ignored directory, however deep the allowance", async () => {
    await mkdirs("node_modules/pkg/nested", "src/agents/one", ".git/objects");

    const rec = recorder();
    walkAgentProjectTree(root, rec, new AgentProjectScanBudget({ maxDepth: 20 }));
    const seen = rec.visits.map(([rel]) => rel);

    expect(seen).toContain(path.join("src", "agents", "one"));
    expect(seen.some((rel) => rel.split(path.sep).includes("node_modules"))).toBe(false);
    expect(seen.some((rel) => rel.split(path.sep).includes(".git"))).toBe(false);
  });

  it("obeys maxDepth exactly: a directory at maxDepth is entered, one below is not", async () => {
    await mkdirs("l1/l2/l3/l4");

    const rec = recorder();
    walkAgentProjectTree(root, rec, new AgentProjectScanBudget({ maxDepth: 3 }));
    const seen = rec.visits.map(([rel]) => rel);

    expect(seen).toContain(path.join("l1", "l2", "l3"));
    expect(seen).not.toContain(path.join("l1", "l2", "l3", "l4"));
  });

  it("does not descend into a directory the visitor stopped at", async () => {
    await mkdirs("project/inner/deeper");

    const visits: string[] = [];
    walkAgentProjectTree(root, {
      onDirectory: (dir) => {
        const rel = path.relative(root, dir) || ".";
        visits.push(rel);
        return rel === "project" ? "stop" : "descend";
      },
    });

    expect(visits).toEqual([".", "project"]);
  });

  it.skipIf(process.platform === "win32")(
    "never follows a symlinked directory — which is what makes a symlink CYCLE terminate",
    async () => {
      // b/loop -> root. A followed link makes this tree infinitely deep; the
      // depth cap used to hide that, and it must not be what saves us now that
      // the allowance is 8 levels and a node budget.
      await mkdirs("a/b");
      await fs.symlink(root, path.join(root, "a", "b", "loop"), "dir");
      await fs.symlink(path.join(root, "a"), path.join(root, "alias"), "dir");

      const rec = recorder();
      // A deliberately absurd allowance: if the walk followed links, only the
      // node budget could stop it, and it would stop by exhausting 100k dirs.
      const budget = walkAgentProjectTree(
        root,
        rec,
        new AgentProjectScanBudget({ maxDepth: 64, maxNodes: 100_000 }),
      );

      expect(budget.truncated).toBe(false);
      expect(rec.visits.map(([rel]) => rel).sort()).toEqual([
        ".",
        "a",
        path.join("a", "b"),
      ]);
      expect(await walkAgentProjectTreeAsync(root, recorder(), new AgentProjectScanBudget({ maxDepth: 64 })))
        .toMatchObject({ visited: 3, truncatedAtDepth: null });
    },
  );

  it("terminates on a pathologically deep chain in maxDepth steps, not by exhausting the budget", async () => {
    // 100 levels — a dozen times the allowance, and short enough to stay
    // inside PATH_MAX on every platform this runs on.
    await mkdirs(Array.from({ length: 100 }, (_, i) => `d${i}`).join("/"));

    const budget = walkAgentProjectTree(root, recorder(), new AgentProjectScanBudget());
    // One directory per level, root inclusive — the chain is never wider.
    expect(budget.visited).toBe(budget.maxDepth + 1);
    expect(budget.truncated).toBe(false);
  });

  it.skipIf(
    process.platform === "win32" ||
      (typeof process.getuid === "function" && process.getuid() === 0),
  )("reports an unreadable directory once, and a vanished one not at all", async () => {
    await mkdirs("locked/child", "gone");
    await fs.rm(path.join(root, "gone"), { recursive: true, force: true });
    await fs.chmod(path.join(root, "locked"), 0o000);

    const unreadable: string[] = [];
    try {
      walkAgentProjectTree(root, {
        onDirectory: () => "descend",
        onUnreadable: (dir) => unreadable.push(path.relative(root, dir)),
      });
    } finally {
      await fs.chmod(path.join(root, "locked"), 0o700);
    }

    expect(unreadable).toEqual(["locked"]);
  });

  it("sync and async walks agree on order and on what the budget bought", async () => {
    await mkdirs("z/1", "a/2/3", "m/4", "node_modules/x");

    const syncRec = recorder();
    const syncBudget = walkAgentProjectTree(root, syncRec, new AgentProjectScanBudget());
    const asyncRec = recorder();
    const asyncBudget = await walkAgentProjectTreeAsync(
      root,
      asyncRec,
      new AgentProjectScanBudget(),
    );

    expect(asyncRec.visits).toEqual(syncRec.visits);
    expect(asyncBudget.visited).toBe(syncBudget.visited);
    expect(asyncBudget.envelopeDepth).toBe(syncBudget.envelopeDepth);
  });

  it("defaults to the shipped policy: depth 8, 10k directories", () => {
    const budget = new AgentProjectScanBudget();
    expect(budget.maxDepth).toBe(AGENT_PROJECT_SCAN_MAX_DEPTH);
    expect(budget.maxNodes).toBe(AGENT_PROJECT_SCAN_MAX_NODES);
    // The cap this replaced was 3, which is below every realistic agent path
    // under a chosen project root (`<root>/backend/src/agents/ads` is 4).
    expect(AGENT_PROJECT_SCAN_MAX_DEPTH).toBeGreaterThanOrEqual(6);
    // The watcher's synchronous fingerprint must stay the cheaper of the two.
    expect(AGENT_PROJECT_WATCH_MAX_NODES).toBeLessThan(AGENT_PROJECT_SCAN_MAX_NODES);
  });
});
