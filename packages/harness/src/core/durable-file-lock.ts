import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface DurableFileLockOwner {
  ownerId: string;
  pid: number;
  birthId?: string;
  state?: "prelaunch";
  version?: 2;
}

export interface DurableFileLockProcessIdentity {
  pid: number;
  birthId?: string;
  cleanupProof: { path: string; token: string };
}

export interface DurableFileLockRelease {
  (): Promise<void>;
  protectProcess(identity: DurableFileLockProcessIdentity): Promise<void>;
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
  afterProtectionPublished?: () => void | Promise<void>;
  beforeReclaimRename?: () => void | Promise<void>;
  afterReclaimRename?: () => void | Promise<void>;
  isPidAlive?: (pid: number) => boolean;
  processState?: (
    identity: Pick<DurableFileLockProcessIdentity, "pid" | "birthId">,
  ) => "alive" | "dead" | "unknown" | Promise<"alive" | "dead" | "unknown">;
}

export interface DurableFileLockOptions {
  timeoutMs?: number;
  retryMs?: number;
  hooks?: DurableFileLockTestHooks;
  storageError?: () => Error;
  processGuard?: "required";
}

interface StoredCleanupProof {
  relativePath: string;
  token: string;
}

interface ProcessGuard {
  birthId?: string;
  cleanupProof: StoredCleanupProof;
  ownerId: string;
  pid: number;
  version: 2;
}

const ownerIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const cleanupFilePattern = /^cleanup-[0-9a-f]{32}\.json$/;
const cleanupTokenPattern = /^[0-9a-f]{64}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");

const isSafeOwnerId = (value: unknown): value is string =>
  typeof value === "string" &&
  value !== "." &&
  value !== ".." &&
  ownerIdPattern.test(value);

const isContainedPath = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    !path.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`)
  );
};

const sameOwner = (
  left: DurableFileLockOwner | null,
  right: DurableFileLockOwner,
): left is DurableFileLockOwner =>
  left !== null &&
  left.ownerId === right.ownerId &&
  left.pid === right.pid &&
  left.birthId === right.birthId &&
  left.state === right.state &&
  left.version === right.version;

/** Cross-process owner-file lock with opt-in detached-process fencing. */
export class DurableFileLock {
  private readonly timeoutMs: number;
  private readonly retryMs: number;
  private readonly hooks: DurableFileLockTestHooks;
  private readonly failure: () => Error;
  private readonly processGuard: boolean;

  constructor(
    private readonly targetPath: string,
    options: DurableFileLockOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.retryMs = options.retryMs ?? 10;
    this.hooks = options.hooks ?? {};
    this.failure =
      options.storageError ?? (() => new Error("Storage unavailable"));
    this.processGuard = options.processGuard === "required";
  }

  async acquire(): Promise<DurableFileLockRelease> {
    const lockPath = `${this.targetPath}.lock`;
    const birthId = await this.birthId(process.pid);
    const owner: DurableFileLockOwner = {
      ownerId: randomUUID(),
      pid: process.pid,
      ...(birthId === undefined ? {} : { birthId }),
      ...(this.processGuard
        ? { state: "prelaunch" as const, version: 2 as const }
        : {}),
    };
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
      if (observed === null) {
        if (Date.now() >= deadline) throw this.failure();
        await delay(this.retryMs);
        continue;
      }
      const disposition = await this.ownerDisposition(lockPath, observed);
      if (disposition !== "dead") {
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
        let current = await this.readOwner(lockPath);
        if (
          !sameOwner(current, observed) ||
          (await this.ownerDisposition(lockPath, current)) !== "dead"
        ) {
          await this.hooks.afterObservedOwnerChanged?.();
          continue;
        }
        await this.hooks.beforeReclaimRename?.();
        current = await this.readOwner(lockPath);
        if (
          !sameOwner(current, observed) ||
          (await this.ownerDisposition(lockPath, current)) !== "dead"
        ) {
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
        await this.hooks.afterReclaimRename?.();
        if (!(await this.tryCreate(lockPath, owner))) {
          await this.cleanupProtection(lockPath, observed);
          await fs.rm(tombstone, { force: true });
          continue;
        }
        await this.cleanupProtection(lockPath, observed);
        await fs.rm(tombstone, { force: true });
        return this.acquired(lockPath, owner);
      } finally {
        await this.releaseFile(claimPath, owner);
      }
    }
  }

  private async acquired(
    lockPath: string,
    owner: DurableFileLockOwner,
  ): Promise<DurableFileLockRelease> {
    try {
      await this.hooks.afterLockAcquired?.(owner.ownerId);
    } catch (error) {
      await this.releaseFile(lockPath, owner);
      throw error;
    }
    let operation = Promise.resolve();
    let releaseStarted = false;
    const serialize = <T>(work: () => Promise<T>): Promise<T> => {
      const next = operation.then(work, work);
      operation = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    };
    const release = (() => {
      releaseStarted = true;
      return serialize(async () => {
        await this.cleanupProtection(lockPath, owner);
        await this.releaseFile(lockPath, owner);
      });
    }) as DurableFileLockRelease;
    release.protectProcess = (identity) => {
      if (!this.processGuard || releaseStarted)
        return Promise.reject(this.failure());
      return serialize(async () => {
        if (releaseStarted) throw this.failure();
        const cleanupProof = await this.validateIdentity(lockPath, identity);
        const guardPath = this.guardPath(lockPath, owner);
        const guard: ProcessGuard = {
          ownerId: owner.ownerId,
          version: 2,
          pid: identity.pid,
          ...(identity.birthId === undefined
            ? {}
            : { birthId: identity.birthId }),
          cleanupProof,
        };
        await this.writeAtomic(guardPath, guard);
        try {
          await this.hooks.afterProtectionPublished?.();
          if (
            releaseStarted ||
            !sameOwner(await this.readOwner(lockPath), owner)
          )
            throw this.failure();
        } catch (error) {
          await fs.rm(guardPath, { force: true }).catch(() => {});
          throw error;
        }
      });
    };
    return release;
  }

  private async validateIdentity(
    lockPath: string,
    identity: DurableFileLockProcessIdentity,
  ): Promise<StoredCleanupProof> {
    if (
      !Number.isSafeInteger(identity.pid) ||
      identity.pid <= 0 ||
      (identity.birthId !== undefined &&
        (typeof identity.birthId !== "string" || !identity.birthId)) ||
      !isRecord(identity.cleanupProof) ||
      !hasExactKeys(identity.cleanupProof, ["path", "token"]) ||
      typeof identity.cleanupProof.path !== "string" ||
      !path.isAbsolute(identity.cleanupProof.path) ||
      typeof identity.cleanupProof.token !== "string" ||
      !cleanupTokenPattern.test(identity.cleanupProof.token)
    )
      throw this.failure();
    const cleanupProof = await this.externalCleanupProof(
      lockPath,
      identity.cleanupProof.path,
      identity.cleanupProof.token,
    );
    if (cleanupProof === null) throw this.failure();
    return cleanupProof;
  }

  private async tryCreate(
    lockPath: string,
    owner: DurableFileLockOwner,
  ): Promise<boolean> {
    try {
      const file = await fs.open(lockPath, "wx", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await this.syncDirectory(path.dirname(lockPath));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw this.failure();
    }
  }

  private async writeAtomic(filePath: string, value: unknown): Promise<void> {
    const pending = `${filePath}.pending-${randomUUID()}`;
    try {
      const file = await fs.open(pending, "wx", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(value)}\n`, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await fs.link(pending, filePath);
      await this.syncDirectory(path.dirname(filePath));
    } catch {
      throw this.failure();
    } finally {
      await fs.rm(pending, { force: true }).catch(() => {});
    }
  }

  private async syncDirectory(directory: string): Promise<void> {
    try {
      const handle = await fs.open(directory, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (
        !["EINVAL", "ENOTSUP", "EPERM"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
    }
  }

  private async readOwner(
    lockPath: string,
  ): Promise<DurableFileLockOwner | null> {
    try {
      const decoded = JSON.parse(
        await fs.readFile(lockPath, "utf8"),
      ) as unknown;
      if (!isRecord(decoded)) return null;
      const guarded = decoded.version === 2 || decoded.state !== undefined;
      if (
        !hasExactKeys(decoded, [
          ...(decoded.birthId === undefined ? [] : ["birthId"]),
          "ownerId",
          "pid",
          ...(guarded ? ["state", "version"] : []),
        ]) ||
        !isSafeOwnerId(decoded.ownerId) ||
        !Number.isSafeInteger(decoded.pid) ||
        (decoded.pid as number) <= 0 ||
        (decoded.birthId !== undefined &&
          (typeof decoded.birthId !== "string" || !decoded.birthId)) ||
        (guarded && (decoded.version !== 2 || decoded.state !== "prelaunch"))
      )
        return null;
      return {
        ownerId: decoded.ownerId,
        pid: decoded.pid as number,
        ...(decoded.birthId === undefined
          ? {}
          : { birthId: decoded.birthId as string }),
        ...(guarded
          ? { state: "prelaunch" as const, version: 2 as const }
          : {}),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      if (error instanceof SyntaxError) return null;
      throw this.failure();
    }
  }

  private async readGuard(
    lockPath: string,
    owner: DurableFileLockOwner,
  ): Promise<ProcessGuard | "absent" | "invalid"> {
    try {
      const decoded = JSON.parse(
        await fs.readFile(this.guardPath(lockPath, owner), "utf8"),
      ) as unknown;
      if (
        !isRecord(decoded) ||
        !hasExactKeys(decoded, [
          ...(decoded.birthId === undefined ? [] : ["birthId"]),
          "cleanupProof",
          "ownerId",
          "pid",
          "version",
        ]) ||
        decoded.ownerId !== owner.ownerId ||
        decoded.version !== 2 ||
        !Number.isSafeInteger(decoded.pid) ||
        (decoded.pid as number) <= 0 ||
        (decoded.birthId !== undefined &&
          (typeof decoded.birthId !== "string" || !decoded.birthId)) ||
        !isRecord(decoded.cleanupProof) ||
        !hasExactKeys(decoded.cleanupProof, ["relativePath", "token"]) ||
        typeof decoded.cleanupProof.relativePath !== "string" ||
        typeof decoded.cleanupProof.token !== "string" ||
        !cleanupTokenPattern.test(decoded.cleanupProof.token)
      )
        return "invalid";
      const cleanupProof = {
        relativePath: decoded.cleanupProof.relativePath,
        token: decoded.cleanupProof.token,
      };
      if ((await this.resolveCleanupProof(lockPath, cleanupProof)) === null)
        return "invalid";
      return {
        ownerId: owner.ownerId,
        version: 2,
        pid: decoded.pid as number,
        ...(decoded.birthId === undefined
          ? {}
          : { birthId: decoded.birthId as string }),
        cleanupProof,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
      if (error instanceof SyntaxError) return "invalid";
      throw this.failure();
    }
  }

  private async ownerDisposition(
    lockPath: string,
    owner: DurableFileLockOwner,
  ): Promise<"dead" | "blocked"> {
    if ((await this.processState(owner)) !== "dead") return "blocked";
    if (!this.processGuard) return "dead";
    if (owner.version !== 2 || owner.state !== "prelaunch") return "blocked";
    const guard = await this.readGuard(lockPath, owner);
    if (guard === "absent") return "dead";
    if (guard === "invalid") return "blocked";
    return (await this.hasCleanupProof(lockPath, guard)) ? "dead" : "blocked";
  }

  private async hasCleanupProof(
    lockPath: string,
    guard: ProcessGuard,
  ): Promise<boolean> {
    try {
      const proofPath = await this.resolveCleanupProof(
        lockPath,
        guard.cleanupProof,
      );
      if (proofPath === null) return false;
      const stat = await fs.lstat(proofPath);
      if (stat.isSymbolicLink() || !stat.isFile()) return false;
      const file = await fs.open(
        proofPath,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
      );
      let encoded: string;
      try {
        encoded = await file.readFile("utf8");
      } finally {
        await file.close();
      }
      const decoded = JSON.parse(encoded) as unknown;
      return (
        isRecord(decoded) &&
        hasExactKeys(decoded, ["status", "token"]) &&
        decoded.status === "complete" &&
        decoded.token === guard.cleanupProof.token
      );
    } catch (error) {
      if (
        ["ELOOP", "ENOENT"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        ) ||
        error instanceof SyntaxError
      )
        return false;
      throw this.failure();
    }
  }

  private async processState(
    identity: Pick<DurableFileLockProcessIdentity, "pid" | "birthId">,
  ): Promise<"alive" | "dead" | "unknown"> {
    if (this.hooks.processState) return this.hooks.processState(identity);
    if (this.hooks.isPidAlive)
      return this.hooks.isPidAlive(identity.pid) ? "alive" : "dead";
    if (process.platform === "linux") {
      try {
        const stat = await fs.readFile(`/proc/${identity.pid}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        if (identity.birthId !== undefined && fields[19] !== identity.birthId)
          return "dead";
        return fields[0] === "Z" ? "dead" : "alive";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "dead";
        return "unknown";
      }
    }
    try {
      process.kill(identity.pid, 0);
      return "unknown";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH"
        ? "dead"
        : "unknown";
    }
  }

  private async birthId(pid: number): Promise<string | undefined> {
    if (process.platform !== "linux") return undefined;
    try {
      const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    } catch {
      return undefined;
    }
  }

  private guardPath(lockPath: string, owner: DurableFileLockOwner): string {
    return `${lockPath}.guard-${owner.ownerId}`;
  }

  private async externalCleanupProof(
    lockPath: string,
    proofPath: string,
    token: string,
  ): Promise<StoredCleanupProof | null> {
    if (!cleanupFilePattern.test(path.basename(proofPath))) return null;
    const root = path.resolve(path.dirname(lockPath));
    const resolvedProofPath = path.resolve(proofPath);
    const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    if (!resolvedProofPath.startsWith(rootPrefix)) return null;
    const relativePath = path.relative(root, resolvedProofPath);
    if (!isContainedPath(root, resolvedProofPath)) return null;
    const cleanupProof = { relativePath, token };
    const resolved = await this.resolveCleanupProof(lockPath, cleanupProof);
    if (resolved === null) return null;
    try {
      await fs.lstat(resolved);
      return null;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? cleanupProof
        : null;
    }
  }

  private async resolveCleanupProof(
    lockPath: string,
    proof: StoredCleanupProof,
  ): Promise<string | null> {
    if (
      !cleanupTokenPattern.test(proof.token) ||
      !proof.relativePath ||
      path.isAbsolute(proof.relativePath) ||
      path.normalize(proof.relativePath) !== proof.relativePath ||
      !cleanupFilePattern.test(path.basename(proof.relativePath))
    )
      return null;
    const root = path.resolve(path.dirname(lockPath));
    const proofPath = path.resolve(root, proof.relativePath);
    const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    if (!proofPath.startsWith(rootPrefix)) return null;
    if (!isContainedPath(root, proofPath)) return null;
    try {
      const [realRoot, realParent] = await Promise.all([
        fs.realpath(root),
        fs.realpath(path.dirname(proofPath)),
      ]);
      if (!isContainedPath(realRoot, realParent) && realParent !== realRoot)
        return null;
      return proofPath;
    } catch {
      return null;
    }
  }

  private async cleanupProtection(
    lockPath: string,
    owner: DurableFileLockOwner,
  ): Promise<void> {
    const guardPath = this.guardPath(lockPath, owner);
    const guard = await this.readGuard(lockPath, owner);
    if (guard !== "absent" && guard !== "invalid") {
      const proofPath = await this.resolveCleanupProof(
        lockPath,
        guard.cleanupProof,
      );
      if (proofPath !== null) {
        const stat = await fs.lstat(proofPath).catch(() => null);
        if (stat?.isFile() && !stat.isSymbolicLink())
          await fs.rm(proofPath, { force: true }).catch(() => {});
      }
    }
    await fs.rm(guardPath, { force: true }).catch(() => {});
  }

  private async cleanupArtifacts(lockPath: string): Promise<void> {
    try {
      const directory = path.dirname(lockPath);
      const base = path.basename(lockPath);
      for (const entry of await fs.readdir(directory)) {
        const prefix = [`${base}.claim-`, `${base}.reclaim-`].find(
          (candidate) => entry.startsWith(candidate),
        );
        if (prefix === undefined || !isSafeOwnerId(entry.slice(prefix.length)))
          continue;
        const artifact = path.join(directory, entry);
        const owner = await this.readOwner(artifact);
        if (owner && (await this.processState(owner)) === "dead")
          await fs.rm(artifact, { force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw this.failure();
    }
  }

  private async releaseFile(
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
