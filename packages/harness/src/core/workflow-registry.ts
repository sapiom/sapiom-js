/**
 * Workflow registry (workstream W2's backend slice).
 *
 * Discovers orchestration projects by scanning a directory tree (bounded
 * depth) for `sapiom.json` marker files, tracks manually-connected paths,
 * and persists the combined list to HARNESS_PATHS.workflows. Exposes an
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
  AGENT_PROJECT_SCAN_MAX_DEPTH,
  type AgentProjectMarker,
  type AgentProjectMarkerInspection,
  inspectAgentProjectMarker,
  isAgentProjectScanIgnoredDir,
  readAgentProjectMarker,
} from "./agent-project-discovery.js";
import { hasTraversalSegment, resolveWithinRoot } from "./path-safety.js";

function expandHome(inputPath: string): string {
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/")) return path.join(os.homedir(), inputPath.slice(2));
  return inputPath;
}

// `dir` reaching these sinks is always a resolved absolute path (from
// path.resolve in scan/connectPath, or a confined descent in scanDir), so a
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

function isConfirmedMissingPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
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

/**
 * Depth-first scan; a directory carrying a marker is registered and not
 * descended into. Every directory touched is confined to `root` (the tree the
 * caller asked to scan): the initial call is `root` itself, and recursion only
 * ever descends into a direct child, so no crafted entry name can walk the
 * scan outside `root`. Symlinked entries report `isDirectory() === false`
 * (withFileTypes uses raw dirent info, not a followed stat) and so are never
 * descended into either.
 */
async function scanDir(
  root: string,
  dir: string,
  depth: number,
  found: WorkflowInfo[],
  unreconciledRoots: string[],
): Promise<void> {
  if (depth > AGENT_PROJECT_SCAN_MAX_DEPTH) return;

  const safeDir = resolveWithinRoot(root, dir);
  if (!safeDir) return;

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
    return;
  }
  if (markerResult.status === "unreadable") {
    // The directory may still be a valid project. Treat the whole subtree as
    // opaque for this pass so a transient filesystem error neither removes an
    // existing entry nor discovers children that should be hidden beneath it.
    unreconciledRoots.push(safeDir);
    return;
  }

  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(safeDir, { withFileTypes: true });
  } catch (error) {
    if (!isConfirmedMissingPath(error)) unreconciledRoots.push(safeDir);
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || isAgentProjectScanIgnoredDir(entry.name)) continue;
    await scanDir(
      root,
      path.join(safeDir, entry.name),
      depth + 1,
      found,
      unreconciledRoots,
    );
  }
}

/**
 * Whether a previously scanned path is inside the exact traversal envelope of
 * a new scan. Only those entries may be reconciled away when their marker is no
 * longer found; a narrow scan must never delete projects discovered from a
 * different root.
 */
function isCoveredByScan(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  if (relative === "") return true;
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    return false;
  }
  const segments = relative.split(path.sep).filter(Boolean);
  return (
    segments.length <= AGENT_PROJECT_SCAN_MAX_DEPTH &&
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

export class WorkflowRegistry {
  private workflows: WorkflowInfo[] = [];
  private loaded = false;
  /** Serializes mutations so concurrent prune/scan/connectPath calls can't
   *  interleave and drop entries from the persisted file. Mirrors the pattern
   *  used by SessionManager.persist() (session-manager.ts:278,851-853). */
  private writeQueue: Promise<void> = Promise.resolve();

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

  async list(): Promise<WorkflowInfo[]> {
    await this.ensureLoaded();
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
      const kept: WorkflowInfo[] = [];
      const pruned: WorkflowInfo[] = [];
      for (const workflow of this.workflows) {
        try {
          await fs.stat(workflow.path);
          kept.push(workflow);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ENOENT" || code === "ENOTDIR") pruned.push(workflow);
          else kept.push(workflow);
        }
      }
      if (pruned.length > 0) {
        this.workflows = kept;
        await this.persist();
      }
      return pruned;
    });
  }

  /**
   * Scans `root`, refreshes discovered projects, and removes scan-sourced rows
   * in this scan's traversal envelope when their marker is confirmed gone or
   * invalid. Rows beneath a temporarily unreadable directory survive this pass;
   * manually connected rows remain until their path itself is pruned.
   */
  async scan(root: string): Promise<WorkflowInfo[]> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const absoluteRoot = path.resolve(expandHome(root));
      const found: WorkflowInfo[] = [];
      const unreconciledRoots: string[] = [];
      await scanDir(absoluteRoot, absoluteRoot, 0, found, unreconciledRoots);

      const foundPaths = new Set(found.map((workflow) => workflow.path));
      const byPath = new Map(
        this.workflows
          .filter(
            (workflow) =>
              workflow.source !== "scan" ||
              !isCoveredByScan(absoluteRoot, workflow.path) ||
              foundPaths.has(workflow.path) ||
              isProtectedByIncompleteScan(workflow.path, unreconciledRoots),
          )
          .map((workflow) => [workflow.path, workflow]),
      );
      for (const workflow of found) {
        const existing = byPath.get(workflow.path);
        // A manually-connected entry keeps its `source`; a scan only refreshes name/definitionId.
        byPath.set(workflow.path, existing ? { ...existing, ...workflow, source: existing.source } : workflow);
      }
      this.workflows = Array.from(byPath.values());
      await this.persist();
      return found;
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
