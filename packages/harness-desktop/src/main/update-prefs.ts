/**
 * Persisted, desktop-only update preferences: the "auto-install on quit" toggle
 * and the set of versions the user chose to skip.
 *
 * Deliberately kept free of an `electron` import — like `update-policy.ts`, so it
 * can be unit-tested without the runtime. The functions take an explicit file
 * path; the ONE place that needs Electron's per-user dir passes
 * `updatePrefsPathIn(app.getPath("userData"))` from a caller that already imports
 * `app` (updater.ts / update-window.ts / index.ts). It mirrors the harness's
 * `cli/settings.ts` discipline: never throw on read, sanitize on every read AND
 * write so a hand-edited or older file self-heals instead of needing a migration.
 *
 * These live in a desktop-local file rather than the shared `HarnessSettings`
 * store because updates are a desktop-only concept — `npx @sapiom/harness` has no
 * updater — so the shared settings type (and its REST/zod schema) stays clean.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface UpdatePrefs {
  /**
   * When true, a background-downloaded update installs on the next ordinary quit
   * (`autoUpdater.autoInstallOnAppQuit`). When false, an update is applied ONLY via
   * the update window's "Restart now" — the "we own the restart" behaviour.
   */
  autoUpdate: boolean;
  /** Versions the user picked "Skip this version" for — never re-offered. */
  skippedVersions: string[];
  /**
   * Opt in to pre-release (`beta`) builds — the internal-dogfooding switch.
   *
   * Persisted rather than env-only because `SAPIOM_UPDATE_CHANNEL` is unusable as
   * a user-facing control on macOS: a Finder or Dock launch inherits no shell
   * environment, so it needs `launchctl setenv` plus a full quit, and when it
   * silently fails to take it is indistinguishable from a broken updater. That
   * cost a real debugging session. `SAPIOM_UPDATE_CHANNEL` still wins over this
   * when set, so the escape hatch keeps working for one-off checks.
   */
  preRelease: boolean;
}

export const DEFAULT_UPDATE_PREFS: UpdatePrefs = {
  // Default ON: a downloaded update installs when the user next quits, so testers
  // stop sitting on a build whose fix they already have. The window's toggle turns
  // it off for anyone who wants to own every restart. This intentionally reverses
  // the updater's former hardcoded `autoInstallOnAppQuit = false` (see updater.ts).
  autoUpdate: true,
  skippedVersions: [],
  // Off by default: a pre-release is precisely the build nobody has validated yet,
  // so following it is always a deliberate act.
  preRelease: false,
};

/**
 * The prefs file inside Electron's per-user `userData` dir. Takes the dir as a
 * string (not `app`) so this module carries no electron dependency; the caller
 * supplies `app.getPath("userData")`.
 */
export function updatePrefsPathIn(userDataDir: string): string {
  return path.join(userDataDir, "update-prefs.json");
}

/**
 * Coerce arbitrary parsed JSON into a valid `UpdatePrefs`, dropping junk. Applied
 * on every read and write so a corrupt or older file heals in place. Unknown
 * fields fall back to defaults; `skippedVersions` is filtered to non-empty strings
 * and deduped.
 */
export function sanitizeUpdatePrefs(raw: unknown): UpdatePrefs {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const skipped = Array.isArray(obj.skippedVersions)
    ? [...new Set(obj.skippedVersions.filter((v): v is string => typeof v === "string" && v.length > 0))]
    : [...DEFAULT_UPDATE_PREFS.skippedVersions];
  return {
    autoUpdate: typeof obj.autoUpdate === "boolean" ? obj.autoUpdate : DEFAULT_UPDATE_PREFS.autoUpdate,
    skippedVersions: skipped,
    preRelease: typeof obj.preRelease === "boolean" ? obj.preRelease : DEFAULT_UPDATE_PREFS.preRelease,
  };
}

/**
 * Never throws: a missing or corrupt file resolves to defaults, exactly as the
 * harness settings loader does — update prefs are a convenience, not load-bearing.
 */
export async function loadUpdatePrefs(prefsPath: string): Promise<UpdatePrefs> {
  try {
    return sanitizeUpdatePrefs(JSON.parse(await fs.readFile(prefsPath, "utf-8")));
  } catch {
    return { ...DEFAULT_UPDATE_PREFS, skippedVersions: [] };
  }
}

export async function saveUpdatePrefs(prefs: UpdatePrefs, prefsPath: string): Promise<void> {
  const sanitized = sanitizeUpdatePrefs(prefs);
  await fs.mkdir(path.dirname(prefsPath), { recursive: true });
  await fs.writeFile(prefsPath, JSON.stringify(sanitized, null, 2) + "\n");
}

/**
 * Record a version as skipped (deduped). Read-modify-write so it composes with the
 * `autoUpdate` toggle rather than clobbering it.
 */
export async function addSkippedVersion(version: string, prefsPath: string): Promise<void> {
  const prefs = await loadUpdatePrefs(prefsPath);
  if (prefs.skippedVersions.includes(version)) return;
  await saveUpdatePrefs({ ...prefs, skippedVersions: [...prefs.skippedVersions, version] }, prefsPath);
}

/**
 * Clear every skip. An explicit "Check for updates" is the user asking again, so it
 * un-skips everything — mirroring how `checkForUpdatesNow` clears the per-run
 * `declined` set. Leaves the file untouched when there is nothing to clear.
 */
export async function clearSkippedVersions(prefsPath: string): Promise<void> {
  const prefs = await loadUpdatePrefs(prefsPath);
  if (prefs.skippedVersions.length === 0) return;
  await saveUpdatePrefs({ ...prefs, skippedVersions: [] }, prefsPath);
}
