/**
 * Workflow registry (workstream W2's backend slice).
 *
 * Discovers orchestration projects by scanning a directory tree (bounded by
 * depth, by directories visited, and by the scan root's own repository) for
 * `sapiom.json` marker files, tracks
 * manually-connected paths, and persists the combined list to
 * HARNESS_PATHS.workflows. Exposes an
 * Express router implementing the /api/workflows surface from
 * src/shared/types.ts; the integrator mounts it (and express.json()) on the
 * shared app.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Router, type Router as ExpressRouter } from "express";

import { HARNESS_PATHS, type WorkflowInfo } from "../shared/types.js";
import {
  type AgentProjectMarker,
  type AgentProjectMarkerInspection,
  AgentProjectScanBudget,
  type AgentProjectWalkAction,
  type AgentProjectWalkOptions,
  inspectAgentProjectMarker,
  isAgentProjectScanIgnoredDir,
  readAgentProjectMarker,
  walkAgentProjectTreeAsync,
} from "./agent-project-discovery.js";
import { hasTraversalSegment, resolveWithinRoot } from "./path-safety.js";

function expandHome(inputPath: string): string {
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/")) return path.join(os.homedir(), inputPath.slice(2));
  return inputPath;
}

// `dir` reaching these sinks is always a resolved absolute path (from
// path.resolve in scan/connectPath, or a confined descent in the scan walk),
// so a
// `..` segment can never survive. Asserting it anyway keeps the no-traversal
// guarantee explicit and local to each fs read, and covers the arbitrary
// path connectPath accepts (which has no scan root to confine it to).

async function readMarker(dir: string): Promise<AgentProjectMarker | null> {
  if (hasTraversalSegment(dir)) return null;
  return readAgentProjectMarker(dir);
}

async function inspectMarker(
  dir: string,
): Promise<AgentProjectMarkerInspection> {
  if (hasTraversalSegment(dir)) return { status: "invalid" };
  return inspectAgentProjectMarker(dir);
}

async function nameFor(dir: string): Promise<string> {
  if (hasTraversalSegment(dir)) return path.basename(dir);
  try {
    const raw = await fs.readFile(path.join(dir, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { name?: string };
    if (pkg.name) return pkg.name;
  } catch {
    // No package.json (or it doesn't parse) — fall back to the directory name.
  }
  return path.basename(dir);
}

/** What one scan of a root turned up, and how far it can be trusted. */
export interface AgentProjectScanResult {
  /** Projects discovered on this pass. */
  found: WorkflowInfo[];
  /** Subtrees left opaque by a transient filesystem error. */
  unreconciledRoots: string[];
  /**
   * Nested repository checkouts the walk declined to enter (see
   * {@link isForeignRepositoryRoot}). A scan that comes back short is then able
   * to say WHY it came back short, which is the difference between "there are
   * no agents there" and "there is another repo there and you did not ask for
   * it". The server logs the count on every scan.
   */
  repositoryBoundaries: string[];
  /** The traversal allowance this scan spent — `visited`, `envelopeDepth`. */
  budget: AgentProjectScanBudget;
}

/**
 * Scans `root` for agent projects, bounded by depth, by directories visited,
 * AND by the repository the root belongs to (core/agent-project-discovery.ts
 * owns that policy and the numbers behind it). A directory carrying a marker is
 * registered and not descended into; a directory that is a repository checkout
 * of its own is reported as a boundary and not descended into either, so one
 * scan registers one project tree rather than every neighbouring clone.
 *
 * Every directory touched is confined to `root` (the tree the caller asked to
 * scan): the walk starts at `root` itself and only ever descends into a direct
 * child, so no crafted entry name can walk the scan outside `root` — and
 * `resolveWithinRoot` re-asserts that at the sink, local to each fs read.
 * Symlinked entries report `isDirectory() === false` (withFileTypes uses raw
 * dirent info, not a followed stat) and so are never descended into either,
 * which is what makes a symlink cycle terminate.
 *
 * Exported so the perf benchmark can measure the real scanner against an
 * explicit budget rather than a copy of its traversal.
 */
export async function scanAgentProjects(
  root: string,
  budget: AgentProjectScanBudget = new AgentProjectScanBudget(),
  options: AgentProjectWalkOptions = {},
): Promise<AgentProjectScanResult> {
  const absoluteRoot = path.resolve(root);
  const found: WorkflowInfo[] = [];
  const unreconciledRoots: string[] = [];
  const repositoryBoundaries: string[] = [];

  const onDirectory = async (dir: string): Promise<AgentProjectWalkAction> => {
    const safeDir = resolveWithinRoot(absoluteRoot, dir);
    if (!safeDir) return "stop";

    const markerResult = await inspectMarker(safeDir);
    if (markerResult.status === "valid") {
      const marker = markerResult.marker;
      found.push({
        name: await nameFor(safeDir),
        path: safeDir,
        definitionId: marker.definitionId ?? null,
        definitionSlug: marker.name ?? null,
        templateId: marker.templateId ?? null,
        forkId: marker.forkId ?? null,
        starterId: marker.starterId ?? null,
        source: "scan",
      });
      return "stop";
    }
    if (markerResult.status === "unreadable") {
      // The directory may still be a valid project. Treat the whole subtree as
      // opaque for this pass so a transient filesystem error neither removes an
      // existing entry nor discovers children that should be hidden beneath it.
      unreconciledRoots.push(safeDir);
      return "stop";
    }
    return "descend";
  };

  await walkAgentProjectTreeAsync(
    absoluteRoot,
    {
      onDirectory,
      onUnreadable: (dir) => unreconciledRoots.push(dir),
      onRepositoryBoundary: (dir) => repositoryBoundaries.push(dir),
    },
    budget,
    options,
  );
  return { found, unreconciledRoots, repositoryBoundaries, budget };
}

/**
 * Whether a previously scanned path is inside the exact traversal envelope of
 * a new scan. Only those entries may be reconciled away when their marker is no
 * longer found; a narrow scan must never delete projects discovered from a
 * different root.
 *
 * `envelopeDepth` is the scan's own report of how deep it got, not the static
 * cap: a scan the node budget cut short covered fewer levels than it was
 * allowed to, and reconciling at the allowance would delete rows it simply
 * never looked for. The walk is breadth-first, so every level at or above
 * `envelopeDepth` is complete and safe to reconcile.
 */
function isCoveredByScan(
  root: string,
  candidate: string,
  envelopeDepth: number,
): boolean {
  const relative = path.relative(root, candidate);
  if (relative === "") return true;
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    return false;
  }
  const segments = relative.split(path.sep).filter(Boolean);
  return (
    segments.length <= envelopeDepth &&
    !segments.some((segment) => isAgentProjectScanIgnoredDir(segment))
  );
}

function isProtectedByIncompleteScan(
  candidate: string,
  unreconciledRoots: string[],
): boolean {
  return unreconciledRoots.some(
    (unreconciledRoot) =>
      resolveWithinRoot(unreconciledRoot, candidate) !== null,
  );
}

/**
 * Whether a previously known path sits inside a nested checkout this scan
 * deliberately did not enter.
 *
 * Reconciliation's rule is "the registry may only forget a project it can prove
 * it would have looked for", and the repository boundary changes what a scan
 * looks for. Without this, opening `~/src` after having opened `~/src/some-repo`
 * would DELETE that repo's agents: the scan stops at the boundary, finds no
 * marker below it, and the depth envelope alone would call them gone.
 */
function isBehindRepositoryBoundary(
  candidate: string,
  repositoryBoundaries: string[],
): boolean {
  return repositoryBoundaries.some(
    (boundary) => resolveWithinRoot(boundary, candidate) !== null,
  );
}

/**
 * How often {@link WorkflowRegistry.list} re-checks that every registered path
 * still exists. Round 1's note claimed the registry "prunes lazily"; it did
 * not — pruning only happened where a caller remembered to ask (server boot, a
 * session's workspace rescan, an agent move), so a deleted agent stayed on the
 * rail until one of those happened to run. This interval is what makes the
 * claim true: one `stat` per entry, at most this often, on any read.
 */
const LAZY_PRUNE_INTERVAL_MS = 30_000;

/**
 * Splits entries into "path still there" and "path confirmed gone". Only
 * ENOENT/ENOTDIR counts as gone: an unbuilt, unreadable or momentarily
 * unstattable directory is kept, because losing a real project to a transient
 * filesystem error is far worse than carrying a dead row for one more sweep.
 */
async function partitionByPathExists(
  workflows: WorkflowInfo[],
): Promise<{ kept: WorkflowInfo[]; pruned: WorkflowInfo[] }> {
  const kept: WorkflowInfo[] = [];
  const pruned: WorkflowInfo[] = [];
  for (const workflow of workflows) {
    try {
      await fs.stat(workflow.path);
      kept.push(workflow);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") pruned.push(workflow);
      else kept.push(workflow);
    }
  }
  return { kept, pruned };
}

export class WorkflowRegistry {
  private workflows: WorkflowInfo[] = [];
  private loaded = false;
  /** Serializes mutations so concurrent prune/scan/connectPath calls can't
   *  interleave and drop entries from the persisted file. Mirrors the pattern
   *  used by SessionManager.persist() (session-manager.ts:278,851-853). */
  private writeQueue: Promise<void> = Promise.resolve();
  /** Epoch ms of the last confirmed-missing sweep — see LAZY_PRUNE_INTERVAL_MS. */
  private lastPruneAt = 0;

  constructor(private readonly registryPath: string = expandHome(HARNESS_PATHS.workflows)) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await fs.readFile(this.registryPath, "utf8");
      this.workflows = JSON.parse(raw) as WorkflowInfo[];
    } catch {
      this.workflows = [];
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const dir = path.dirname(this.registryPath);
    await fs.mkdir(dir, { recursive: true });
    // Atomic write: write to a temp file in the same directory (so rename is
    // same-filesystem and thus atomic on POSIX), then rename over the target.
    // A crash mid-write leaves the .tmp file, not a torn workflows.json.
    // Mirrors the pattern used by SessionManager.persist().
    const tmpPath = `${this.registryPath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(this.workflows, null, 2));
    await fs.rename(tmpPath, this.registryPath);
  }

  /** Chains `run` onto the write queue so concurrent mutations never
   *  interleave — a failed run never poisons later ones. */
  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.catch(() => {}).then(run);
    this.writeQueue = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  /**
   * The registry as it stands — and the point at which stale entries actually
   * leave. A read runs {@link prune} when one is due
   * (LAZY_PRUNE_INTERVAL_MS), so an agent whose directory the user deleted
   * disappears from `GET /api/workflows` on its own rather than waiting for the
   * next server boot. Cheap by construction: one `stat` per entry, throttled,
   * and the file is only rewritten when something was actually dropped.
   */
  async list(): Promise<WorkflowInfo[]> {
    await this.ensureLoaded();
    if (Date.now() - this.lastPruneAt >= LAZY_PRUNE_INTERVAL_MS) await this.prune();
    return this.workflows;
  }

  /**
   * Drops entries whose `path` no longer exists on disk and persists the
   * result — users delete projects, and a crashed run can leave a temp
   * directory registered. Deliberately narrow: only a confirmed-missing
   * path (ENOENT/ENOTDIR) is pruned. A directory that exists but is
   * merely unbuilt, unreadable (permissions), or temporarily unstattable
   * stays registered. Returns what was pruned so the caller can log it.
   */
  async prune(): Promise<WorkflowInfo[]> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const { kept, pruned } = await partitionByPathExists(this.workflows);
      this.lastPruneAt = Date.now();
      if (pruned.length > 0) {
        this.workflows = kept;
        await this.persist();
      }
      return pruned;
    });
  }

  /**
   * `budget` is overridable so a caller (and the tests that pin this rule) can
   * scan with a narrower allowance than the shipped default; the reconciliation
   * envelope follows whatever the scan actually managed to cover.
   *
   * Scans `root`, refreshes discovered projects, and removes scan-sourced rows
   * in this scan's traversal envelope when their marker is confirmed gone or
   * invalid. Rows beneath a temporarily unreadable directory survive this pass,
   * as do rows below the depth the scan actually completed when the node budget
   * cut it short; manually connected rows remain until their path itself is
   * pruned.
   */
  async scan(
    root: string,
    budget: AgentProjectScanBudget = new AgentProjectScanBudget(),
  ): Promise<WorkflowInfo[]> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const absoluteRoot = path.resolve(expandHome(root));
      const { found, unreconciledRoots, repositoryBoundaries } =
        await scanAgentProjects(absoluteRoot, budget);

      const foundPaths = new Set(found.map((workflow) => workflow.path));
      const byPath = new Map(
        this.workflows
          .filter(
            (workflow) =>
              workflow.source !== "scan" ||
              !isCoveredByScan(absoluteRoot, workflow.path, budget.envelopeDepth) ||
              foundPaths.has(workflow.path) ||
              isProtectedByIncompleteScan(workflow.path, unreconciledRoots) ||
              isBehindRepositoryBoundary(workflow.path, repositoryBoundaries),
          )
          .map((workflow) => [workflow.path, workflow]),
      );
      for (const workflow of found) {
        const existing = byPath.get(workflow.path);
        // A manually-connected entry keeps its `source`; a scan only refreshes name/definitionId.
        byPath.set(workflow.path, existing ? { ...existing, ...workflow, source: existing.source } : workflow);
      }
      // Registry-wide, not envelope-wide: a scan is the most frequent write
      // this file gets, and an entry whose directory is CONFIRMED gone has no
      // claim to survive it regardless of which root turned it up. Without
      // this, a dead row rooted somewhere the studio never scans again lives
      // for as long as the install does.
      const { kept, pruned } = await partitionByPathExists(
        Array.from(byPath.values()),
      );
      this.lastPruneAt = Date.now();
      this.workflows = kept;
      await this.persist();
      return found.filter(
        (workflow) => !pruned.some((dead) => dead.path === workflow.path),
      );
    });
  }

  /** Registers an arbitrary path (the "+ Connect" flow); marker is optional at connect time. */
  async connectPath(inputPath: string): Promise<WorkflowInfo> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const absolutePath = path.resolve(expandHome(inputPath));
      const marker = await readMarker(absolutePath);
      const info: WorkflowInfo = {
        name: await nameFor(absolutePath),
        path: absolutePath,
        definitionId: marker?.definitionId ?? null,
        definitionSlug: marker?.name ?? null,
        templateId: marker?.templateId ?? null,
        forkId: marker?.forkId ?? null,
        starterId: marker?.starterId ?? null,
        source: "connect",
      };
      const idx = this.workflows.findIndex((workflow) => workflow.path === absolutePath);
      if (idx >= 0) this.workflows[idx] = info;
      else this.workflows.push(info);
      await this.persist();
      return info;
    });
  }
}

/**
 * The subset of {@link WorkflowRegistry} the workflows router depends on. Typed
 * structurally so a caller can pass a wrapper (e.g. one that enriches `list()`
 * with resolved slugs) without an unsafe cast — a missing method is then a
 * compile error, not a runtime crash.
 */
export interface WorkflowRegistryLike {
  list(): Promise<WorkflowInfo[]>;
  scan(root: string): Promise<WorkflowInfo[]>;
  connectPath(inputPath: string): Promise<WorkflowInfo>;
}

export function createWorkflowsRouter(registry: WorkflowRegistryLike): ExpressRouter {
  const router = Router();

  router.get("/api/workflows", async (_req, res) => {
    res.json(await registry.list());
  });

  router.post("/api/workflows/connect", async (req, res) => {
    const inputPath = (req.body as { path?: unknown } | undefined)?.path;
    if (typeof inputPath !== "string" || !inputPath.trim()) {
      res.status(400).json({ error: "path is required" });
      return;
    }
    try {
      res.json(await registry.connectPath(inputPath));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/api/workflows/scan", async (req, res) => {
    const root = (req.body as { root?: unknown } | undefined)?.root;
    if (typeof root !== "string" || !root.trim()) {
      res.status(400).json({ error: "root is required" });
      return;
    }
    try {
      res.json(await registry.scan(root));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
