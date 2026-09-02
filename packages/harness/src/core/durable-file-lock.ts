import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface DurableFileLockOwner {
  ownerId: string;
  pid: number;
}

export interface DurableFileLockTestHooks {
  afterDeadOwnerObserved?: (
    owner: DurableFileLockOwner,
  ) => void | Promise<void>;
  afterObservedOwnerChanged?: () => void | Promise<void>;
  afterLiveOwnerObserved?: (
    owner: DurableFileLockOwner,
  ) => void | Promise<void>;
  afterLockAcquired?: (ownerId: string) => void | Promise<void>;
  isPidAlive?: (pid: number) => boolean;
}

export interface DurableFileLockOptions {
  timeoutMs?: number;
  retryMs?: number;
  hooks?: DurableFileLockTestHooks;
  storageError?: () => Error;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sameOwner = (
  left: DurableFileLockOwner | null,
  right: DurableFileLockOwner,
): left is DurableFileLockOwner =>
  left !== null && left.ownerId === right.ownerId && left.pid === right.pid;

/** Cross-process owner-file lock with live-PID protection and dead-owner fencing. */
export class DurableFileLock {
  private readonly timeoutMs: number;
  private readonly retryMs: number;
  private readonly hooks: DurableFileLockTestHooks;
  private readonly failure: () => Error;

  constructor(
    private readonly targetPath: string,
    options: DurableFileLockOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.retryMs = options.retryMs ?? 10;
    this.hooks = options.hooks ?? {};
    this.failure =
      options.storageError ?? (() => new Error("Storage unavailable"));
  }

  async acquire(): Promise<() => Promise<void>> {
    const lockPath = `${this.targetPath}.lock`;
    const owner = { ownerId: randomUUID(), pid: process.pid };
    const deadline = Date.now() + this.timeoutMs;
    try {
      await fs.mkdir(path.dirname(this.targetPath), { recursive: true });
    } catch {
      throw this.failure();
    }
    await this.cleanupArtifacts(lockPath);
    for (;;) {
      if (await this.tryCreate(lockPath, owner))
        return this.acquired(lockPath, owner);
      const observed = await this.readOwner(lockPath);
      if (observed === null || this.isAlive(observed.pid)) {
        if (observed) await this.hooks.afterLiveOwnerObserved?.(observed);
        if (Date.now() >= deadline) throw this.failure();
        await delay(this.retryMs);
        continue;
      }
      await this.hooks.afterDeadOwnerObserved?.(observed);
      const claimPath = `${lockPath}.claim-${observed.ownerId}`;
      if (!(await this.tryCreate(claimPath, owner))) {
        if (Date.now() >= deadline) throw this.failure();
        await delay(this.retryMs);
        continue;
      }
      try {
        const current = await this.readOwner(lockPath);
        if (!sameOwner(current, observed) || this.isAlive(current.pid)) {
          await this.hooks.afterObservedOwnerChanged?.();
          continue;
        }
        const tombstone = `${lockPath}.reclaim-${owner.ownerId}`;
        try {
          await fs.rename(lockPath, tombstone);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw this.failure();
        }
        if (!(await this.tryCreate(lockPath, owner))) {
          await fs.rm(tombstone, { force: true }).catch(() => {});
          continue;
        }
        await fs.rm(tombstone, { force: true });
        return this.acquired(lockPath, owner);
      } finally {
        await this.release(claimPath, owner);
      }
    }
  }

  private async acquired(lockPath: string, owner: DurableFileLockOwner) {
    try {
      await this.hooks.afterLockAcquired?.(owner.ownerId);
    } catch (error) {
      await this.release(lockPath, owner);
      throw error;
    }
    return () => this.release(lockPath, owner);
  }

  private async tryCreate(lockPath: string, owner: DurableFileLockOwner) {
    try {
      await fs.writeFile(lockPath, `${JSON.stringify(owner)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw this.failure();
    }
  }

  private async readOwner(
    lockPath: string,
  ): Promise<DurableFileLockOwner | null> {
    try {
      const decoded = JSON.parse(
        await fs.readFile(lockPath, "utf8"),
      ) as unknown;
      if (
        !isRecord(decoded) ||
        Object.keys(decoded).sort().join(",") !== "ownerId,pid" ||
        typeof decoded.ownerId !== "string" ||
        decoded.ownerId.length === 0 ||
        !Number.isSafeInteger(decoded.pid) ||
        (decoded.pid as number) <= 0
      )
        return null;
      return { ownerId: decoded.ownerId, pid: decoded.pid as number };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      if (error instanceof SyntaxError) return null;
      throw this.failure();
    }
  }

  private isAlive(pid: number): boolean {
    if (this.hooks.isPidAlive) return this.hooks.isPidAlive(pid);
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  private async cleanupArtifacts(lockPath: string): Promise<void> {
    try {
      const directory = path.dirname(lockPath);
      const base = path.basename(lockPath);
      for (const entry of await fs.readdir(directory)) {
        if (
          !entry.startsWith(`${base}.claim-`) &&
          !entry.startsWith(`${base}.reclaim-`)
        )
          continue;
        const artifact = path.join(directory, entry);
        const owner = await this.readOwner(artifact);
        if (owner && !this.isAlive(owner.pid))
          await fs.rm(artifact, { force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw this.failure();
    }
  }

  private async release(
    lockPath: string,
    owner: DurableFileLockOwner,
  ): Promise<void> {
    if (!sameOwner(await this.readOwner(lockPath), owner)) return;
    try {
      await fs.unlink(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw this.failure();
    }
  }
}
