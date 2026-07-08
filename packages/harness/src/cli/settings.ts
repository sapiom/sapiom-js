import * as fs from "node:fs/promises";
import * as path from "node:path";
import { HARNESS_PATHS, type HarnessSettings } from "../shared/types.js";
import { expandHome } from "./paths.js";

const DEFAULT_SETTINGS: HarnessSettings = {
  telemetryOptIn: false,
  recentDirs: [],
};

const MAX_RECENT_DIRS = 10;

function settingsFilePath(): string {
  return expandHome(HARNESS_PATHS.settings);
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
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<HarnessSettings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings: HarnessSettings): Promise<void> {
  const filePath = settingsFilePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(settings, null, 2) + "\n");
}

/** Record `cwd` as the most-recently-used project directory (deduped, capped). */
export async function recordRecentDir(cwd: string): Promise<void> {
  const settings = await loadSettings();
  const recentDirs = [cwd, ...settings.recentDirs.filter((dir) => dir !== cwd)].slice(
    0,
    MAX_RECENT_DIRS,
  );
  await saveSettings({ ...settings, recentDirs });
}
