/**
 * Pure-Node executable detection: locate a binary on `PATH` without
 * shelling out to `which`/`where.exe`, so `detectInstalled()` works the
 * same on every platform and never depends on a user's shell.
 */
import { constants as fsConstants } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

/** Options for {@link findExecutableOnPath}; injectable for tests. */
export interface FindExecutableOptions {
  /**
   * Environment to read `PATH` (and, on Windows, `PATHEXT`) from.
   * Default: `process.env`.
   */
  env?: Record<string, string | undefined>;
  /** Platform whose lookup rules apply. Default: `process.platform`. */
  platform?: NodeJS.Platform;
}

/** Windows fallback when `PATHEXT` is unset, matching the OS default. */
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/**
 * Find an executable on `PATH`, returning the full path of the first
 * match in `PATH` order, or `null` when there is none. Never throws.
 *
 * - POSIX: a match must be a regular file with execute permission.
 * - Windows (`win32`): candidates are `name + ext` for each `PATHEXT`
 *   entry — plus the bare name when it already carries an extension —
 *   and existing as a regular file is enough, mirroring how the OS
 *   resolves commands (execute bits are meaningless there).
 *
 * Empty `PATH` segments are skipped rather than treated as the current
 * directory.
 */
export async function findExecutableOnPath(
  name: string,
  options: FindExecutableOptions = {},
): Promise<string | null> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const isWindows = platform === "win32";
  const delimiter = isWindows ? ";" : ":";

  const searchPath = env.PATH ?? env.Path ?? "";
  const dirs = searchPath.split(delimiter).filter((dir) => dir.length > 0);

  const extensions = isWindows
    ? (env.PATHEXT ?? DEFAULT_PATHEXT).split(";").filter((e) => e.length > 0)
    : [];

  for (const dir of dirs) {
    const base = path.join(dir, name);
    const candidates = isWindows
      ? // A name that already has an extension can match as-is.
        name.includes(".")
        ? [base, ...extensions.map((ext) => base + ext)]
        : extensions.map((ext) => base + ext)
      : [base];

    for (const candidate of candidates) {
      if (await isExecutableFile(candidate, isWindows)) return candidate;
    }
  }
  return null;
}

/**
 * Convenience wrapper for adapters: `true` when {@link
 * findExecutableOnPath} finds the binary on the current process's `PATH`.
 */
export async function isExecutableOnPath(name: string): Promise<boolean> {
  return (await findExecutableOnPath(name)) !== null;
}

async function isExecutableFile(
  file: string,
  isWindows: boolean,
): Promise<boolean> {
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile()) return false;
    if (isWindows) return true;
    await fsp.access(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}
