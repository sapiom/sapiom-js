import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DISPLAY_MODES, HARNESS_PATHS, type DisplayMode, type HarnessSettings } from "../shared/types.js";
import { expandHome } from "./paths.js";

const DEFAULT_SETTINGS: HarnessSettings = {
  telemetryOptIn: false,
  recentDirs: [],
  // Opt-in: the rolling summary spends tokens on a background LLM call the
  // user never asked for. Off, portable continue still works — its brief just
  // degrades to the last N turns. See core/rolling-summary.ts.
  rollingSummary: false,
  // Dark, not "system": the Studio has always opened dark regardless of the
  // OS, and an installed app must not change appearance because a setting was
  // added underneath it. "System" is a choice, not the fallback.
  displayMode: "dark",
};

const MAX_RECENT_DIRS = 8;

/** The real settings file. Every function below accepts an explicit path so
 *  tests and scripted checks can point at a scratch state root instead —
 *  omitted, they operate on the real file, unchanged for CLI users. */
function defaultSettingsFilePath(): string {
  return expandHome(HARNESS_PATHS.settings);
}

/**
 * Resolves a candidate recent-dir entry to an absolute, existing directory
 * path, or null if it doesn't qualify. Rejects anything that isn't a real
 * directory on disk right now — relative paths, stray free text (e.g. typed
 * into the directory field by mistake), and directories that have since been
 * deleted all fall out here rather than accumulating in the list.
 */
async function normalizeRecentDir(candidate: string): Promise<string | null> {
  const expanded = expandHome(candidate.trim());
  if (!path.isAbsolute(expanded)) return null;
  const resolved = path.resolve(expanded);
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) return null;
  } catch {
    return null;
  }
  return resolved;
}

/** A stored `displayMode`, or undefined for anything this build doesn't know. */
function normalizeDisplayMode(candidate: unknown): DisplayMode | undefined {
  return DISPLAY_MODES.find((mode) => mode === candidate);
}

/**
 * The persisted display mode, read synchronously.
 *
 * The static router bakes it into the served HTML so the desktop app paints
 * the right theme on the first frame (server/static.ts) — that path is inside
 * a request handler with no await to spend, and it must see the CURRENT value
 * rather than one captured at boot. One small local read per HTML navigation.
 * Returns undefined when the file is missing/unreadable/unrecognised, leaving
 * the page's own fallback in charge.
 */
export function readDisplayModeSync(settingsPath: string = defaultSettingsFilePath()): DisplayMode | undefined {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as Partial<HarnessSettings>;
    return normalizeDisplayMode(parsed.displayMode);
  } catch {
    return undefined;
  }
}

/**
 * Normalize a `projectRoot`: expand `~`, require absolute, resolve.
 *
 * Deliberately does NOT require the directory to exist, unlike
 * normalizeRecentDir. A recent dir is a place something already happened; a
 * project root is a place things WILL happen, and it is created when the first
 * project lands there. Requiring existence would silently reset the user's
 * chosen default the moment they picked a folder they hadn't made yet.
 *
 * Returns undefined for junk so the field simply falls back to the host default.
 */
function normalizeProjectRoot(candidate: unknown): string | undefined {
  if (typeof candidate !== "string" || !candidate.trim()) return undefined;
  const expanded = expandHome(candidate.trim());
  if (!path.isAbsolute(expanded)) return undefined;
  return path.resolve(expanded);
}

/**
 * Validates, normalizes, case-sensitively dedupes (first occurrence wins —
 * callers order newest-first), and caps a candidate recent-dirs list.
 * Applied on every write (via saveSettings) and on every read (via
 * loadSettings), so junk already on disk self-heals the next time it's
 * loaded instead of requiring a migration.
 */
export async function sanitizeRecentDirs(candidates: string[]): Promise<string[]> {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of candidates) {
    if (result.length >= MAX_RECENT_DIRS) break;
    const normalized = await normalizeRecentDir(candidate);
    if (normalized === null || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

/** Whether settings have ever been persisted — used to detect first run. */
export async function hasStoredSettings(settingsPath: string = defaultSettingsFilePath()): Promise<boolean> {
  try {
    await fs.access(settingsPath);
    return true;
  } catch {
    return false;
  }
}

export async function loadSettings(settingsPath: string = defaultSettingsFilePath()): Promise<HarnessSettings> {
  try {
    const raw = await fs.readFile(settingsPath, "utf-8");
    const parsed = { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<HarnessSettings>) };
    const projectRoot = normalizeProjectRoot(parsed.projectRoot);
    return {
      ...parsed,
      displayMode: normalizeDisplayMode(parsed.displayMode) ?? DEFAULT_SETTINGS.displayMode,
      recentDirs: await sanitizeRecentDirs(parsed.recentDirs),
      // Omit rather than store undefined, so JSON.stringify on the way back out
      // doesn't leave a dangling `"projectRoot": null`-shaped hole.
      ...(projectRoot ? { projectRoot } : { projectRoot: undefined }),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(
  settings: HarnessSettings,
  settingsPath: string = defaultSettingsFilePath(),
): Promise<void> {
  const normalizedRoot = normalizeProjectRoot(settings.projectRoot);
  const sanitized: HarnessSettings = {
    ...settings,
    displayMode: normalizeDisplayMode(settings.displayMode) ?? DEFAULT_SETTINGS.displayMode,
    recentDirs: await sanitizeRecentDirs(settings.recentDirs),
    ...(normalizedRoot ? { projectRoot: normalizedRoot } : { projectRoot: undefined }),
  };
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify(sanitized, null, 2) + "\n");
}

/** Record `cwd` as the most-recently-used project directory (validated, deduped, capped). */
export async function recordRecentDir(cwd: string, settingsPath: string = defaultSettingsFilePath()): Promise<void> {
  const settings = await loadSettings(settingsPath);
  await saveSettings({ ...settings, recentDirs: [cwd, ...settings.recentDirs] }, settingsPath);
}

/**
 * Boot-time hygiene: persist the removal of recent-dir entries whose path no
 * longer exists on disk. sanitizeRecentDirs() already drops them from every
 * in-memory read, but a read alone never rewrites the file — so a dead entry
 * (deleted project, a crashed check's temp dir) would otherwise sit in
 * settings.json indefinitely. Returns the entries that were dropped; leaves
 * the file completely untouched (not even created) when there is nothing to
 * prune, so this can never break first-run detection (hasStoredSettings).
 */
export async function pruneDeadRecentDirs(settingsPath: string = defaultSettingsFilePath()): Promise<string[]> {
  let stored: Partial<HarnessSettings>;
  try {
    stored = JSON.parse(await fs.readFile(settingsPath, "utf-8")) as Partial<HarnessSettings>;
  } catch {
    return []; // no settings file yet (or unreadable) — nothing to prune
  }
  const recentDirs = Array.isArray(stored.recentDirs)
    ? stored.recentDirs.filter((entry): entry is string => typeof entry === "string")
    : [];
  const dead: string[] = [];
  for (const entry of recentDirs) {
    if ((await normalizeRecentDir(entry)) === null) dead.push(entry);
  }
  if (dead.length === 0) return [];
  // saveSettings' own sanitize pass is what actually drops the dead entries.
  await saveSettings({ ...DEFAULT_SETTINGS, ...stored, recentDirs }, settingsPath);
  return dead;
}
