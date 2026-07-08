import * as fs from "node:fs/promises";
import * as path from "node:path";
import { HARNESS_PATHS, type HarnessSettings } from "../shared/types.js";
import { expandHome } from "./paths.js";

const DEFAULT_SETTINGS: HarnessSettings = {
  telemetryOptIn: false,
  recentDirs: [],
};

const MAX_RECENT_DIRS = 8;

function settingsFilePath(): string {
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
export async function hasStoredSettings(): Promise<boolean> {
  try {
    await fs.access(settingsFilePath());
    return true;
  } catch {
    return false;
  }
}

export async function loadSettings(): Promise<HarnessSettings> {
  try {
    const raw = await fs.readFile(settingsFilePath(), "utf-8");
    const parsed = { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<HarnessSettings>) };
    return { ...parsed, recentDirs: await sanitizeRecentDirs(parsed.recentDirs) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings: HarnessSettings): Promise<void> {
  const filePath = settingsFilePath();
  const sanitized: HarnessSettings = {
    ...settings,
    recentDirs: await sanitizeRecentDirs(settings.recentDirs),
  };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(sanitized, null, 2) + "\n");
}

/** Record `cwd` as the most-recently-used project directory (validated, deduped, capped). */
export async function recordRecentDir(cwd: string): Promise<void> {
  const settings = await loadSettings();
  await saveSettings({ ...settings, recentDirs: [cwd, ...settings.recentDirs] });
}
