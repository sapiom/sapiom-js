/**
 * Scan cost as a function of the bound — the measurement the epic's open
 * question ("raising AGENT_PROJECT_SCAN_MAX_DEPTH has a scan-cost consequence
 * not measured here") asked for, run against the real scanner rather than a
 * copy of its traversal.
 *
 * What it defends: the pair of bounds in core/agent-project-discovery.ts. The
 * old cap was 3, which is shallower than where agents sit under a project root
 * a user would actually open, so raising it was not optional. The measurement
 * is what says raising *depth alone* would not have been affordable, and it
 * lives here so a later "just bump the number" arrives with the number.
 *
 * Reference points measured on real roots on one real install (macOS/APFS),
 * warm cache, ~22-25 us per directory entered at every depth:
 *
 *   root                    depth 3       depth 8   unbounded
 *   a single repo             119 dirs      242 dirs    242 dirs
 *   ~/sapiom/sapiom-js        758 dirs    9,016 dirs  9,195 dirs
 *   ~/sapiom/Sapiom         1,298 dirs   35,489 dirs 47,544 dirs
 *
 * Round 2 added the third bound — the repository boundary — and it moves these
 * numbers more than either of the first two, so it is re-measured here rather
 * than left to the docblock. Same install, same day, at the shipped
 * 10,000-node budget; cells are agents / distinct names / dirs / ms:
 *
 *   root                      today                          with the boundary
 *   ~/sapiom/wf-demo-testing   10 / 10,     17 dirs,   0 ms   10 / 10,    17 dirs,   0 ms
 *   ~/sapiom                   88 / 65, 10,000 dirs, 239 ms   68 / 64,   408 dirs,   8 ms
 *   ~/sapiom/sapiom-js         25 /  2,  9,016 dirs, 233 ms    2 /  2,   444 dirs,   8 ms
 *   ~/sapiom/Sapiom             0 /  0, 10,000 dirs, 200 ms    0 /  0, 5,408 dirs, 107 ms
 *
 * The fixture below reproduces the shape of the `sapiom-js` case — a monorepo
 * with ~75 agents scattered from 2 to 7 segments below the root, real per-level
 * width, a `node_modules` big enough that walking it would show up immediately,
 * and (new) a `.trees/` full of worktree checkouts of the same repo, which is
 * where 23 of that install's 25 "agents" actually came from. Wall clock is
 * machine-dependent, so the timing bars are loose regression tripwires; the
 * assertions that decide correctness are counts.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AGENT_PROJECT_SCAN_MAX_DEPTH,
  AGENT_PROJECT_SCAN_MAX_NODES,
  AGENT_PROJECT_WATCH_MAX_NODES,
  AgentProjectScanBudget,
  walkAgentProjectTree,
} from "./agent-project-discovery.js";
import { scanAgentProjects } from "./workflow-registry.js";
import { snapshotWorkspaceWorkflows } from "./workspace-watcher.js";

/**
 * Directories per level, taken from the depth histogram of a real repo
 * (1/10/59/49/87/18/13/4/1 for 242 dirs) and scaled to monorepo size. Level 0
 * is the root itself.
 */
const DIRS_PER_LEVEL = [1, 12, 120, 700, 1_100, 800, 450, 140, 40];
/** Agents per depth — 75 in total, matching the install the design measured. */
const AGENTS_PER_DEPTH: Record<number, number> = { 2: 5, 3: 10, 4: 20, 5: 20, 6: 15, 7: 5 };
const AGENT_TOTAL = Object.values(AGENTS_PER_DEPTH).reduce((a, b) => a + b, 0);
/** Ignored-subtree noise: 150 packages x 3 build dirs = 600 dirs that must cost nothing. */
const NODE_MODULES_PACKAGES = 150;
/**
 * Worktree checkouts of the fixture's own repo, under `.trees/` — the shape
 * that made one real monorepo report 25 agents when it has 2. Each carries a
 * `.git` FILE (that is what a worktree has) and one copy of the same agent.
 */
const WORKTREE_CHECKOUTS = 20;

/** Loose wall-clock bars — they catch "the bound stopped working", not a slow disk. */
const SCAN_BUDGET_MS = 10_000;
const WATCH_SNAPSHOT_BUDGET_MS = 2_000;
const PATHOLOGICAL_BUDGET_MS = 2_000;

interface Fixture {
  root: string;
  /** Every generated directory, by depth. */
  byDepth: string[][];
  /** Absolute paths of the directories carrying a marker. */
  agents: string[];
  /** The same agent, once per worktree checkout under `.trees/`. */
  worktreeAgents: string[];
  /** Directories a full walk should enter (non-ignored, above no marker). */
  reachable: number;
}

async function buildFixture(root: string): Promise<Fixture> {
  const byDepth: string[][] = [[root]];
  for (let depth = 1; depth < DIRS_PER_LEVEL.length; depth += 1) {
    const parents = byDepth[depth - 1];
    const level: string[] = [];
    for (let i = 0; i < DIRS_PER_LEVEL[depth]; i += 1) {
      level.push(path.join(parents[i % parents.length], `d${depth}-${i}`));
    }
    byDepth.push(level);
    await Promise.all(level.map((dir) => fs.mkdir(dir, { recursive: true })));
  }

  // Agents are added as their own leaf directories at each target depth, so a
  // marker's stop-at-first-marker rule can never swallow a chunk of the
  // fixture's filler and make the level counts a lie.
  const agents: string[] = [];
  for (const [depthKey, count] of Object.entries(AGENTS_PER_DEPTH)) {
    const depth = Number(depthKey);
    const parents = byDepth[depth - 1];
    for (let i = 0; i < count; i += 1) {
      const dir = path.join(parents[i % parents.length], `agent-${depth}-${i}`);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, "sapiom.json"),
        JSON.stringify({ definitionId: null, name: path.basename(dir) }),
      );
      byDepth[depth].push(dir);
      agents.push(dir);
    }
  }

  // Ignored noise, both wide and marker-bearing: neither may be discovered.
  await Promise.all(
    Array.from({ length: NODE_MODULES_PACKAGES }, async (_unused, i) => {
      const pkg = path.join(root, "node_modules", `pkg-${i}`);
      for (const out of ["dist", "esm", "cjs"]) {
        await fs.mkdir(path.join(pkg, out), { recursive: true });
      }
      await fs.writeFile(path.join(pkg, "sapiom.json"), "{}");
    }),
  );
  await fs.mkdir(path.join(root, ".git", "objects", "ab"), { recursive: true });

  // Sibling checkouts of this same repo. Every one holds a directory called
  // `duplicated-agent`, so a walk that crosses the boundary reports the same
  // agent WORKTREE_CHECKOUTS extra times.
  const worktreeAgents: string[] = [];
  byDepth[1].push(path.join(root, ".trees"));
  for (let i = 0; i < WORKTREE_CHECKOUTS; i += 1) {
    const checkout = path.join(root, ".trees", `wt-${i}`);
    const agent = path.join(checkout, "src", "agents", "duplicated-agent");
    await fs.mkdir(agent, { recursive: true });
    await fs.writeFile(path.join(checkout, ".git"), `gitdir: ${root}/.git/worktrees/wt-${i}\n`);
    await fs.writeFile(path.join(agent, "sapiom.json"), JSON.stringify({ name: "duplicated-agent" }));
    worktreeAgents.push(agent);
    // A checkout IS entered — its own marker is inspected before the boundary
    // is considered — so it counts toward what a bounded walk visits. Nothing
    // BELOW it is entered, so nothing below it is recorded here. That
    // asymmetry is the boundary, expressed as an expected directory count.
    byDepth[2].push(checkout);
  }

  return {
    root,
    byDepth,
    agents,
    worktreeAgents,
    reachable: byDepth.flat().length,
  };
}

/** Directories a walk bounded at `maxDepth` can reach in this fixture. */
function reachableWithin(fixture: Fixture, maxDepth: number): number {
  const markers = new Set(fixture.agents);
  let total = 0;
  for (let depth = 0; depth <= maxDepth && depth < fixture.byDepth.length; depth += 1) {
    total += fixture.byDepth[depth].length;
  }
  // A marker directory is entered but not descended into; nothing in this
  // fixture lives under one, so entered-count is unaffected.
  expect([...markers].every((dir) => dir.startsWith(fixture.root))).toBe(true);
  return total;
}

describe("agent project scan cost by bound (deep monorepo fixture)", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "harness-scan-perf-"));
    fixture = await buildFixture(root);
  }, 300_000);

  afterAll(async () => {
    await fs.rm(fixture.root, { recursive: true, force: true });
  });

  it("finds every agent at the shipped bound, and only the shallow ones at the old cap of 3", async () => {
    // Warm the directory cache once so the two readings compare traversal, not
    // disk state — the point of the comparison is nodes visited.
    await scanAgentProjects(fixture.root);

    const baselineBudget = new AgentProjectScanBudget({
      maxDepth: 3,
      maxNodes: Number.MAX_SAFE_INTEGER,
    });
    const baselineStart = performance.now();
    const baseline = await scanAgentProjects(fixture.root, baselineBudget);
    const baselineMs = performance.now() - baselineStart;

    const shippedBudget = new AgentProjectScanBudget();
    const shippedStart = performance.now();
    const shipped = await scanAgentProjects(fixture.root, shippedBudget);
    const shippedMs = performance.now() - shippedStart;

    const shallowAgents = fixture.agents.filter(
      (dir) => path.relative(fixture.root, dir).split(path.sep).length <= 3,
    );

    console.info(
      `[perf] scan ${AGENT_TOTAL} agents / ${fixture.reachable} dirs · ` +
        `depth 3: ${baselineBudget.visited} dirs, ${baseline.found.length} agents, ${baselineMs.toFixed(0)}ms ` +
        `(${((baselineMs * 1000) / baselineBudget.visited).toFixed(1)}us/dir) · ` +
        `depth ${AGENT_PROJECT_SCAN_MAX_DEPTH} + ${AGENT_PROJECT_SCAN_MAX_NODES} nodes: ` +
        `${shippedBudget.visited} dirs, ${shipped.found.length} agents, ${shippedMs.toFixed(0)}ms ` +
        `(${((shippedMs * 1000) / shippedBudget.visited).toFixed(1)}us/dir)`,
    );

    // The reason the cap had to move: at 3, most of this install is invisible.
    expect(baseline.found.length).toBe(shallowAgents.length);
    expect(baseline.found.length).toBeLessThan(AGENT_TOTAL / 2);
    // The reason the new bound is worth its cost: all of it is visible.
    expect(shipped.found.length).toBe(AGENT_TOTAL);
    expect(new Set(shipped.found.map((w) => w.path))).toEqual(new Set(fixture.agents));

    // Cost, deterministically: exactly the directories the depth allows, and
    // never a directory under an ignored name.
    expect(baselineBudget.visited).toBe(reachableWithin(fixture, 3));
    expect(shippedBudget.visited).toBe(reachableWithin(fixture, AGENT_PROJECT_SCAN_MAX_DEPTH));
    expect(shippedBudget.visited).toBeLessThanOrEqual(AGENT_PROJECT_SCAN_MAX_NODES);
    expect(shippedBudget.truncated).toBe(false);
    expect(shipped.found.some((w) => w.path.includes("node_modules"))).toBe(false);

    expect(shippedMs).toBeLessThan(SCAN_BUDGET_MS);
  }, 300_000);

  it("keeps the watcher's synchronous fingerprint inside its tighter node budget", async () => {
    // This walk is the one that lands on the event loop, on a 250 ms debounce,
    // after every save under the session's cwd — so its ceiling is the budget,
    // not the depth.
    snapshotWorkspaceWorkflows(fixture.root); // warm

    const budget = new AgentProjectScanBudget({ maxNodes: AGENT_PROJECT_WATCH_MAX_NODES });
    const start = performance.now();
    const snapshot = snapshotWorkspaceWorkflows(fixture.root, budget);
    const elapsed = performance.now() - start;

    console.info(
      `[perf] watch fingerprint · ${budget.visited} dirs (cap ${AGENT_PROJECT_WATCH_MAX_NODES}), ` +
        `${elapsed.toFixed(0)}ms (${((elapsed * 1000) / budget.visited).toFixed(1)}us/dir), ` +
        `truncated at depth ${String(budget.truncatedAtDepth)}, ` +
        `envelope depth ${budget.envelopeDepth}`,
    );

    expect(budget.visited).toBeLessThanOrEqual(AGENT_PROJECT_WATCH_MAX_NODES);
    expect(elapsed).toBeLessThan(WATCH_SNAPSHOT_BUDGET_MS);
    // Truncated or not, the fingerprint must be reproducible — the watcher
    // compares it against the next one and rescans on any difference.
    expect(
      snapshotWorkspaceWorkflows(
        fixture.root,
        new AgentProjectScanBudget({ maxNodes: AGENT_PROJECT_WATCH_MAX_NODES }),
      ),
    ).toBe(snapshot);
    // Every level above the reported envelope really is complete: the agents at
    // those depths all appear.
    for (const agent of fixture.agents) {
      const depth = path.relative(fixture.root, agent).split(path.sep).length;
      if (depth <= budget.envelopeDepth) expect(snapshot).toContain(agent);
    }
  }, 300_000);

  it("the repository boundary is what stops duplicate registrations, and it is nearly free", async () => {
    // Both readings run the real scanner; the only difference is the boundary.
    await scanAgentProjects(fixture.root); // warm

    const crossingBudget = new AgentProjectScanBudget();
    const crossingStart = performance.now();
    const crossing = await scanAgentProjects(fixture.root, crossingBudget, {
      crossRepositoryBoundaries: true,
    });
    const crossingMs = performance.now() - crossingStart;

    const boundedBudget = new AgentProjectScanBudget();
    const boundedStart = performance.now();
    const bounded = await scanAgentProjects(fixture.root, boundedBudget);
    const boundedMs = performance.now() - boundedStart;

    const distinct = (result: { found: { path: string }[] }): number =>
      new Set(result.found.map((workflow) => path.basename(workflow.path))).size;

    console.info(
      `[perf] repository boundary · crossing: ${crossing.found.length} agents ` +
        `(${distinct(crossing)} distinct), ${crossingBudget.visited} dirs, ${crossingMs.toFixed(0)}ms · ` +
        `bounded: ${bounded.found.length} agents (${distinct(bounded)} distinct), ` +
        `${boundedBudget.visited} dirs, ${boundedMs.toFixed(0)}ms, ` +
        `${bounded.repositoryBoundaries.length} checkouts not entered`,
    );

    // Crossing the boundary registers the same agent once per checkout...
    expect(crossing.found.length).toBe(AGENT_TOTAL + WORKTREE_CHECKOUTS);
    expect(
      crossing.found.filter((w) => path.basename(w.path) === "duplicated-agent"),
    ).toHaveLength(WORKTREE_CHECKOUTS);
    // ...and staying inside it registers none of them, while losing nothing
    // that belongs to the repo the caller actually asked about.
    expect(bounded.found.length).toBe(AGENT_TOTAL);
    expect(new Set(bounded.found.map((w) => w.path))).toEqual(new Set(fixture.agents));
    expect(bounded.repositoryBoundaries.sort()).toEqual(
      fixture.worktreeAgents
        .map((agent) => path.resolve(agent, "..", "..", ".."))
        .sort(),
    );
    // The saving is directories not entered, which is why it is also faster.
    expect(boundedBudget.visited).toBeLessThan(crossingBudget.visited);
  }, 300_000);

  it("spends nothing on a large ignored subtree", () => {
    const budget = new AgentProjectScanBudget();
    walkAgentProjectTree(
      path.join(fixture.root, "node_modules"),
      { onDirectory: () => "descend" },
      budget,
    );
    // Pointed straight at it, the subtree is ~600 directories deep in build
    // output — which is what makes the count below meaningful rather than a
    // fixture that happened to have nothing to skip.
    expect(budget.visited).toBeGreaterThan(NODE_MODULES_PACKAGES);
    // Walked from the root, not one of those 600 is entered: the cost is
    // exactly the fixture's own directories within the depth allowance.
    const scanBudget = new AgentProjectScanBudget();
    walkAgentProjectTree(fixture.root, { onDirectory: () => "descend" }, scanBudget);
    expect(scanBudget.visited).toBe(reachableWithin(fixture, AGENT_PROJECT_SCAN_MAX_DEPTH));
  });
});

describe("agent project scan on pathological trees", () => {
  let root: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "harness-scan-patho-"));
    // A 100-level chain: a dozen times the depth allowance.
    await fs.mkdir(
      path.join(root, "chain", Array.from({ length: 100 }, (_unused, i) => `d${i}`).join(path.sep)),
      { recursive: true },
    );
    // A symlink cycle, two ways: a link back to the root, and a pair of
    // directories linking to each other.
    await fs.mkdir(path.join(root, "loop", "a"), { recursive: true });
    await fs.mkdir(path.join(root, "loop", "b"), { recursive: true });
    await fs.writeFile(path.join(root, "loop", "sapiom.json"), "{}");
    await fs.mkdir(path.join(root, "cycle"), { recursive: true });
    await fs.symlink(root, path.join(root, "cycle", "up"), "dir");
    await fs.symlink(path.join(root, "cycle"), path.join(root, "cycle-alias"), "dir");
    // A wide ignored tree.
    for (let i = 0; i < 300; i += 1) {
      await fs.mkdir(path.join(root, "node_modules", `p-${i}`, "dist"), { recursive: true });
    }
  }, 300_000);

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")(
    "terminates promptly and within budget on deep chains, a symlink cycle, and a wide ignored tree",
    async () => {
      const budget = new AgentProjectScanBudget();
      const start = performance.now();
      const result = await scanAgentProjects(root, budget);
      const elapsed = performance.now() - start;

      console.info(
        `[perf] pathological · ${budget.visited} dirs, ${elapsed.toFixed(0)}ms, ` +
          `truncated=${String(budget.truncated)}`,
      );

      expect(elapsed).toBeLessThan(PATHOLOGICAL_BUDGET_MS);
      // The chain is bounded by depth, not by exhausting the node budget: 100
      // levels of one directory each, of which 8 are reachable.
      expect(budget.truncated).toBe(false);
      // root + chain(8) + loop + cycle + cycle-alias-as-symlink(not entered).
      expect(budget.visited).toBeLessThan(50);
      // The symlink cycle contributed nothing, and no path in the result
      // repeats a segment the way a followed cycle would.
      expect(result.found.map((workflow) => path.relative(root, workflow.path))).toEqual([
        "loop",
      ]);
      // And the synchronous fingerprint walk agrees.
      const syncBudget = new AgentProjectScanBudget();
      const syncStart = performance.now();
      snapshotWorkspaceWorkflows(root, syncBudget);
      expect(performance.now() - syncStart).toBeLessThan(PATHOLOGICAL_BUDGET_MS);
      expect(syncBudget.truncated).toBe(false);
    },
    300_000,
  );
});
