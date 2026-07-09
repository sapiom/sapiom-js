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
import { hasTraversalSegment, resolveWithinRoot } from "./path-safety.js";

const MAX_SCAN_DEPTH = 3;
const SKIP_DIR_NAMES = new Set(["node_modules", ".git"]);

function expandHome(inputPath: string): string {
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/")) return path.join(os.homedir(), inputPath.slice(2));
  return inputPath;
}

interface SapiomMarker {
  definitionId?: number | null;
}

// `dir` reaching these sinks is always a resolved absolute path (from
// path.resolve in scan/connectPath, or a confined descent in scanDir), so a
// `..` segment can never survive. Asserting it anyway keeps the no-traversal
// guarantee explicit and local to each fs read, and covers the arbitrary
// path connectPath accepts (which has no scan root to confine it to).

async function readMarker(dir: string): Promise<SapiomMarker | null> {
  if (hasTraversalSegment(dir)) return null;
  try {
    const raw = await fs.readFile(path.join(dir, "sapiom.json"), "utf8");
    return JSON.parse(raw) as SapiomMarker;
  } catch {
    return null;
  }
}

async function nameFor(dir: string): Promise<string> {
  if (!hasTraversalSegment(dir)) {
    try {
      const raw = await fs.readFile(path.join(dir, "package.json"), "utf8");
      const pkg = JSON.parse(raw) as { name?: string };
      if (pkg.name) return pkg.name;
    } catch {
      // No package.json (or it doesn't parse) — fall back to the directory name.
    }
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
async function scanDir(root: string, dir: string, depth: number, found: WorkflowInfo[]): Promise<void> {
  if (depth > MAX_SCAN_DEPTH) return;

  const safeDir = resolveWithinRoot(root, dir);
  if (!safeDir) return;

  const marker = await readMarker(safeDir);
  if (marker) {
    found.push({
      name: await nameFor(safeDir),
      path: safeDir,
      definitionId: marker.definitionId ?? null,
      source: "scan",
    });
    return;
  }

  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(safeDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIR_NAMES.has(entry.name)) continue;
    await scanDir(root, path.join(safeDir, entry.name), depth + 1, found);
  }
}

export class WorkflowRegistry {
  private workflows: WorkflowInfo[] = [];
  private loaded = false;

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
    await fs.mkdir(path.dirname(this.registryPath), { recursive: true });
    await fs.writeFile(this.registryPath, JSON.stringify(this.workflows, null, 2));
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
  }

  /** Scans `root` and merges discovered projects into the persisted registry. */
  async scan(root: string): Promise<WorkflowInfo[]> {
    await this.ensureLoaded();
    const absoluteRoot = path.resolve(expandHome(root));
    const found: WorkflowInfo[] = [];
    await scanDir(absoluteRoot, absoluteRoot, 0, found);

    const byPath = new Map(this.workflows.map((workflow) => [workflow.path, workflow]));
    for (const workflow of found) {
      const existing = byPath.get(workflow.path);
      // A manually-connected entry keeps its `source`; a scan only refreshes name/definitionId.
      byPath.set(workflow.path, existing ? { ...existing, ...workflow, source: existing.source } : workflow);
    }
    this.workflows = Array.from(byPath.values());
    await this.persist();
    return found;
  }

  /** Registers an arbitrary path (the "+ Connect" flow); marker is optional at connect time. */
  async connectPath(inputPath: string): Promise<WorkflowInfo> {
    await this.ensureLoaded();
    const absolutePath = path.resolve(expandHome(inputPath));
    const marker = await readMarker(absolutePath);
    const info: WorkflowInfo = {
      name: await nameFor(absolutePath),
      path: absolutePath,
      definitionId: marker?.definitionId ?? null,
      source: "connect",
    };
    const idx = this.workflows.findIndex((workflow) => workflow.path === absolutePath);
    if (idx >= 0) this.workflows[idx] = info;
    else this.workflows.push(info);
    await this.persist();
    return info;
  }
}

export function createWorkflowsRouter(registry: WorkflowRegistry): ExpressRouter {
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
