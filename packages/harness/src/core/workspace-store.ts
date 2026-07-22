/**
 * Workspace membership store (design.md §4 — the "Workspace" noun; E3).
 *
 * A persistent, user-owned mapping of named workspaces → member agents that
 * survives session (and server) open/close. It replaces the old cwd-derived
 * bucketing that recomputed the rail's grouping from whichever terminals were
 * open — the whole point here is that membership is **saved and stable** and
 * is never inferred from open sessions.
 *
 * Persisted to HARNESS_PATHS.workspaces (`~/.sapiom/harness/workspaces.json`)
 * as `Workspace[]`. The store is a close sibling of {@link WorkflowRegistry}:
 * same load-once / atomic-persist / serialized-write-queue shape, so the two
 * behave identically under concurrent mutation and crash-mid-write. Exposes
 * only the model + CRUD; the Express surface lives in server/workspaces.ts.
 *
 * Mutations are transactional: each computes the next state immutably, writes
 * it to disk, and only then commits it in memory — so a failed write leaves
 * both disk and the in-memory list untouched (no phantom entry that a later
 * successful write would then persist).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { HARNESS_PATHS, type Workspace } from "../shared/types.js";
import { InvalidWorkspaceNameError, UnknownWorkspaceError } from "./errors.js";

function expandHome(inputPath: string): string {
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/")) return path.join(os.homedir(), inputPath.slice(2));
  return inputPath;
}

/** Trims a candidate name and rejects an empty/whitespace-only result. */
function normalizeName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new InvalidWorkspaceNameError();
  return trimmed;
}

export class WorkspaceStore {
  private workspaces: Workspace[] = [];
  private loaded = false;
  /** Serializes mutations so concurrent create/rename/assign calls can't
   *  interleave and drop each other's writes from the persisted file. Mirrors
   *  WorkflowRegistry.writeQueue (workflow-registry.ts:109). */
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly storePath: string = expandHome(HARNESS_PATHS.workspaces)) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await fs.readFile(this.storePath, "utf8");
      this.workspaces = JSON.parse(raw) as Workspace[];
    } catch {
      this.workspaces = [];
    }
    this.loaded = true;
  }

  /**
   * Writes `next` to disk atomically, then commits it in memory. On any write
   * error the in-memory list is left untouched (and the error rethrown), so a
   * failed mutation can never leave memory ahead of disk. Atomic write: temp
   * file in the same directory (so rename is same-filesystem and thus atomic
   * on POSIX), then rename over the target — a crash mid-write leaves the .tmp
   * file, not a torn workspaces.json. Mirrors WorkflowRegistry.persist().
   */
  private async commit(next: Workspace[]): Promise<void> {
    const dir = path.dirname(this.storePath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = `${this.storePath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(next, null, 2));
    await fs.rename(tmpPath, this.storePath);
    this.workspaces = next;
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

  /** Locates a workspace by id or throws UnknownWorkspaceError. */
  private require(id: string): Workspace {
    const workspace = this.workspaces.find((w) => w.id === id);
    if (!workspace) throw new UnknownWorkspaceError(id);
    return workspace;
  }

  /** All workspaces, in creation order. */
  async list(): Promise<Workspace[]> {
    await this.ensureLoaded();
    return this.workspaces;
  }

  /** Creates a new, empty workspace with the given display name. */
  async create(name: string, now = new Date().toISOString()): Promise<Workspace> {
    const trimmed = normalizeName(name);
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const workspace: Workspace = {
        id: crypto.randomUUID(),
        name: trimmed,
        agentPaths: [],
        createdAt: now,
        updatedAt: now,
      };
      await this.commit([...this.workspaces, workspace]);
      return workspace;
    });
  }

  /** Renames a workspace. Throws UnknownWorkspaceError if `id` is unknown. */
  async rename(id: string, name: string, now = new Date().toISOString()): Promise<Workspace> {
    const trimmed = normalizeName(name);
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const existing = this.require(id);
      const updated: Workspace = { ...existing, name: trimmed, updatedAt: now };
      await this.commit(this.workspaces.map((w) => (w.id === id ? updated : w)));
      return updated;
    });
  }

  /** Deletes a workspace. Throws UnknownWorkspaceError if `id` is unknown. */
  async remove(id: string): Promise<void> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      this.require(id);
      await this.commit(this.workspaces.filter((w) => w.id !== id));
    });
  }

  /**
   * Assigns an agent (by registry `path`) to a workspace. Idempotent — a path
   * already in the workspace is a no-op that neither duplicates it nor bumps
   * `updatedAt` (and writes nothing). Throws UnknownWorkspaceError if `id` is
   * unknown.
   */
  async assignAgent(id: string, agentPath: string, now = new Date().toISOString()): Promise<Workspace> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const existing = this.require(id);
      if (existing.agentPaths.includes(agentPath)) return existing;
      const updated: Workspace = {
        ...existing,
        agentPaths: [...existing.agentPaths, agentPath],
        updatedAt: now,
      };
      await this.commit(this.workspaces.map((w) => (w.id === id ? updated : w)));
      return updated;
    });
  }

  /**
   * Removes an agent from a workspace. Idempotent — removing a path that isn't
   * a member is a no-op (writes nothing). Throws UnknownWorkspaceError if `id`
   * is unknown.
   */
  async unassignAgent(id: string, agentPath: string, now = new Date().toISOString()): Promise<Workspace> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const existing = this.require(id);
      if (!existing.agentPaths.includes(agentPath)) return existing;
      const updated: Workspace = {
        ...existing,
        agentPaths: existing.agentPaths.filter((p) => p !== agentPath),
        updatedAt: now,
      };
      await this.commit(this.workspaces.map((w) => (w.id === id ? updated : w)));
      return updated;
    });
  }
}

/**
 * The subset of {@link WorkspaceStore} the workspaces router depends on. Typed
 * structurally (mirrors {@link WorkflowRegistryLike}) so a caller can pass a
 * wrapper without an unsafe cast — a missing method is a compile error, not a
 * runtime crash.
 */
export interface WorkspaceStoreLike {
  list(): Promise<Workspace[]>;
  create(name: string): Promise<Workspace>;
  rename(id: string, name: string): Promise<Workspace>;
  remove(id: string): Promise<void>;
  assignAgent(id: string, agentPath: string): Promise<Workspace>;
  unassignAgent(id: string, agentPath: string): Promise<Workspace>;
}
