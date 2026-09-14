import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";

export const studioIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
export const authorityScopePattern = /^[a-f0-9]{64}$/;
export class AssistantStorageError extends Error {
  constructor() {
    super("Assistant history storage is unavailable");
  }
}
/** Publication may be readable despite a failed durability/rollback acknowledgement.
 * Callers must reconcile their operation proof; absence of success is not rollback. */
export class AssistantStorageCommitUnconfirmedError extends AssistantStorageError {
  readonly code = "ASSISTANT_STORAGE_COMMIT_UNCONFIRMED";
}

/** Only server-derived identifiers may select private directories. Reject symlink escapes. */
export async function assistantDirectory(
  root: string,
  id: string,
  scope?: string,
): Promise<string> {
  if (
    !isAbsolute(root) ||
    !studioIdPattern.test(id) ||
    (scope !== undefined && !authorityScopePattern.test(scope))
  )
    throw new AssistantStorageError();
  let directory = resolve(root);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  directory = await fs.realpath(directory);
  for (const part of [
    "assistant-sessions",
    id,
    ...(scope ? ["bindings", scope] : []),
  ]) {
    const parentDirectory = directory;
    directory = join(directory, part);
    await fs
      .mkdir(directory, { mode: 0o700 })
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new AssistantStorageError();
    await syncDirectory(parentDirectory);
  }
  return directory;
}

export async function readAssistantJson(
  file: string,
  limit = 65536,
): Promise<unknown | null> {
  try {
    const handle = await fs.open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > limit)
        throw new AssistantStorageError();
      const bytes = await handle.readFile();
      if (bytes.length > limit) throw new AssistantStorageError();
      const value: unknown = JSON.parse(bytes.toString("utf8"));
      if (value === null) throw new AssistantStorageError();
      return value;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return file.endsWith(".previous")
        ? null
        : readAssistantJson(`${file}.previous`, limit);
    throw new AssistantStorageError();
  }
}

/** Caller holds the record lock. Keep a durable prior generation through publication failure. */
export async function writeAssistantJson(
  directory: string,
  name: string,
  value: unknown,
  signal?: AbortSignal,
): Promise<void> {
  const temporary = join(directory, `${name}.pending-${randomUUID()}`);
  const destination = join(directory, name);
  const previous = `${destination}.previous`;
  const backup = `${temporary}.backup`,
    rollback = `${temporary}.rollback`;
  let retained = false,
    published = false;
  let cleanupFailure: PromiseRejectedResult | undefined;
  try {
    const file = await fs.open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    signal?.throwIfAborted();
    try {
      await fs.link(destination, backup);
      retained = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (retained) {
      await fs.rename(backup, previous);
      await syncDirectory(directory);
    }
    signal?.throwIfAborted();
    await fs.rename(temporary, destination);
    published = true;
    await syncDirectory(directory);
  } catch (error) {
    let restored = false;
    if (published && retained) {
      // The backup remains recoverable even if the filesystem also refuses rollback.
      try {
        await fs.link(previous, rollback);
        await fs.rename(rollback, destination);
        await syncDirectory(directory);
        restored = true;
      } catch {
        /* Preserve both generations for a later successful read. */
      }
    }
    if (published && !restored)
      throw new AssistantStorageCommitUnconfirmedError();
    throw error;
  } finally {
    const cleanup = await Promise.allSettled(
      [temporary, backup, rollback].map((file) => fs.rm(file, { force: true })),
    );
    // Cleanup must not disguise whether the durable publication is uncertain.
    cleanupFailure = cleanup.find((result) => result.status === "rejected");
  }
  if (cleanupFailure) throw cleanupFailure.reason;
}

/** Match DurableFileLock on platforms without directory-handle fsync support. */
async function syncDirectory(directory: string): Promise<void> {
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
