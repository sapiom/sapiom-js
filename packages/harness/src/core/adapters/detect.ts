/**
 * Pure-Node executable detection: locate a binary on PATH without shelling
 * out to `which` or `where.exe`, so detectInstalled() works the same on
 * every platform and never depends on the user's shell.
 */
import { constants as fsConstants } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

/** Windows fallback when PATHEXT is unset, matching the OS default. */
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/**
 * Find an executable on PATH, returning the full path of the first match in
 * PATH order, or null when there is none. Never throws.
 *
 * - POSIX: match must be a regular file with execute permission.
 * - Windows (win32): candidates are `name + ext` for each PATHEXT entry plus
 *   the bare name when it already carries an extension; existing as a regular
 *   file is enough (execute bits are meaningless on Windows).
 *
 * Empty PATH segments are skipped rather than treated as the current directory.
 */
export async function findExecutableOnPath(
  name: string,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
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
      ? name.includes(".")
        ? [base, ...extensions.map((ext) => base + ext)]
        : extensions.map((ext) => base + ext)
      : [base];

    for (const candidate of candidates) {
      if (await isExecutableFile(candidate, isWindows)) return candidate;
    }
  }
  return null;
}

/** Convenience wrapper: true when the binary is reachable on PATH. */
export async function isExecutableOnPath(name: string): Promise<boolean> {
  return (await findExecutableOnPath(name)) !== null;
}

async function isExecutableFile(file: string, isWindows: boolean): Promise<boolean> {
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
