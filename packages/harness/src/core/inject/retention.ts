/**
 * Retention policy for the per-session generated config dirs
 * (`~/.sapiom/harness/generated/<harnessSessionId>/` — settings.json,
 * emit.cjs, mcp-config.json, system-prompt.txt). Without it every session
 * launch leaves a dir behind forever (real installs accumulate thousands).
 *
 * Lifecycle facts the policy rests on (see the generators in this directory
 * and server/index.ts's createDefaultBuildLaunchOpts):
 * - Most files are consumed at launch — `--settings`/`--mcp-config` are
 *   parsed by the agent at startup, system-prompt.txt is inlined into argv
 *   before spawn — EXCEPT emit.cjs, which the agent re-executes as a child
 *   process on every hook event. A session's dir must therefore survive for
 *   as long as its pty runs.
 * - buildLaunchOpts regenerates every file on BOTH create() and resume(),
 *   so nothing in the dir is needed once the session has exited: deleting
 *   at exit can never break a later resume.
 *
 * Two mechanisms:
 * - removeGeneratedSessionDir(): per-session delete, wired to the session's
 *   "exited" status transition.
 * - sweepGeneratedDirs(): boot-time sweep for dirs the exit-time delete
 *   never reached (crashes, force-kills, pre-retention accumulation) —
 *   age-gated so anything plausibly still in use is left alone.
 *
 * Safety: deletion only ever targets a plain directory that is a direct
 * child of a root that itself looks like a dedicated generated-config dir
 * (resolveGeneratedRoot / childPath). Symlinked entries are never
 * followed and never deleted.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { HARNESS_PATHS } from "../../shared/types.js";
import { expandHome } from "../paths.js";
import { childPath } from "../path-safety.js";

/** Sweep threshold: a non-live dir must be at least this stale (mtime) to be
 *  removed. Generous — the only cost of keeping a dead dir is disk clutter,
 *  while a false positive on some unforeseen liveness signal is worse. */
export const GENERATED_SWEEP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface GeneratedRetentionOptions {
  /** Root directory generated configs live under. Defaults to
   *  HARNESS_PATHS.generated. Override in tests to avoid the real home dir. */
  generatedRoot?: string;
}

export interface SweepGeneratedDirsOptions extends GeneratedRetentionOptions {
  /** Dirs named after a live session id are never removed, whatever their
   *  age. Defaults to treating nothing as live. */
  isLiveSession?: (harnessSessionId: string) => boolean;
  /** Minimum staleness before a dir is swept. Defaults to
   *  GENERATED_SWEEP_MAX_AGE_MS. */
  maxAgeMs?: number;
  /** Injectable clock (epoch ms) for tests. */
  now?: () => number;
}

/**
 * A recursive delete under a misconfigured root would be catastrophic
 * (imagine generatedRoot resolving to the home dir, or "/"). The generators
 * will happily *write* wherever they're pointed, but deletion demands the
 * root at least look like a dedicated generated-config directory: a
 * non-root absolute path whose final segment is "generated".
 */
function resolveGeneratedRoot(generatedRoot?: string): string {
  const root = expandHome(generatedRoot ?? HARNESS_PATHS.generated);
  if (!path.isAbsolute(root) || path.basename(root) !== "generated" || path.dirname(root) === root) {
    throw new Error(`refusing to delete under suspicious generated root "${root}"`);
  }
  return root;
}

/**
 * Deletes one session's generated dir. Only call once the session's pty has
 * exited — the agent re-executes emit.cjs from this dir on every hook event
 * while it runs. Returns true if a directory was removed; a missing entry,
 * an escaping/malformed id, or a symlink (never followed) is false.
 */
export async function removeGeneratedSessionDir(
  harnessSessionId: string,
  options: GeneratedRetentionOptions = {},
): Promise<boolean> {
  const root = resolveGeneratedRoot(options.generatedRoot);
  const dir = childPath(root, harnessSessionId);
  if (!dir) return false;
  const stats = await fs.lstat(dir).catch(() => null);
  if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) return false;
  await fs.rm(dir, { recursive: true, force: true });
  return true;
}

/**
 * Removes every generated dir that (a) isn't a live session's and (b) has
 * been stale for at least `maxAgeMs`. Covers everything the exit-time
 * delete can't: sessions that crashed with the harness, force-killed
 * processes, and accumulation from before retention existed. Only plain
 * directories are candidates — symlinks and stray files are left untouched.
 * Best-effort per entry: one undeletable dir doesn't abort the rest.
 * Returns the names of the dirs it removed.
 */
export async function sweepGeneratedDirs(options: SweepGeneratedDirsOptions = {}): Promise<string[]> {
  const root = resolveGeneratedRoot(options.generatedRoot);
  const maxAgeMs = options.maxAgeMs ?? GENERATED_SWEEP_MAX_AGE_MS;
  const now = options.now ? options.now() : Date.now();

  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const removed: string[] = [];
  for (const entry of entries) {
    // Dirent types come from lstat semantics: a symlink to a directory is
    // isSymbolicLink(), not isDirectory() — so this both skips symlinks and
    // guarantees rm below never follows one out of the root.
    if (!entry.isDirectory()) continue;
    const dir = childPath(root, entry.name);
    if (!dir) continue;
    if (options.isLiveSession?.(entry.name)) continue;
    const stats = await fs.lstat(dir).catch(() => null);
    if (!stats || !stats.isDirectory()) continue;
    if (now - stats.mtimeMs < maxAgeMs) continue;
    try {
      await fs.rm(dir, { recursive: true, force: true });
      removed.push(entry.name);
    } catch {
      // Leave it for the next boot's sweep rather than aborting the rest.
    }
  }
  return removed;
}
