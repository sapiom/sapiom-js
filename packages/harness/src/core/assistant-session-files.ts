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
    const parent = await fs.open(parentDirectory, "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
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
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new AssistantStorageError();
  }
}

/** fsync before rename; a failed write never truncates the previous checkpoint. */
export async function writeAssistantJson(
  directory: string,
  name: string,
  value: unknown,
  signal?: AbortSignal,
): Promise<void> {
  const temporary = join(directory, `${name}.pending-${randomUUID()}`);
  try {
    const file = await fs.open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    signal?.throwIfAborted();
    await fs.rename(temporary, join(directory, name));
    const parent = await fs.open(directory, "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
