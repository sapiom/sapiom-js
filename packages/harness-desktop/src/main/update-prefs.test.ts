/**
 * `update-prefs.ts` is kept free of an `electron` import precisely so it can be
 * unit-tested like `update-policy.ts` (the toggle + skip list are the load-bearing
 * state behind the update window, and a silently-corrupt read would either nag a
 * user who skipped a version or auto-install one they didn't want). These exercise
 * the pure sanitize/merge and the read-modify-write helpers against a scratch file.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_UPDATE_PREFS,
  addSkippedVersion,
  clearSkippedVersions,
  loadUpdatePrefs,
  recordAutoCheck,
  sanitizeUpdatePrefs,
  saveUpdatePrefs,
  shouldRunAutoCheck,
  updatePrefsPathIn,
} from "./update-prefs.js";

let dir: string;
let prefsPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sapiom-update-prefs-"));
  prefsPath = updatePrefsPathIn(dir);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("sanitizeUpdatePrefs", () => {
  it("fills defaults for missing/non-object input", () => {
    expect(sanitizeUpdatePrefs(undefined)).toEqual(DEFAULT_UPDATE_PREFS);
    expect(sanitizeUpdatePrefs(null)).toEqual(DEFAULT_UPDATE_PREFS);
    expect(sanitizeUpdatePrefs("nonsense")).toEqual(DEFAULT_UPDATE_PREFS);
    expect(sanitizeUpdatePrefs({})).toEqual(DEFAULT_UPDATE_PREFS);
  });

  it("defaults autoUpdate to true (the toggle ships on) but honors an explicit false", () => {
    expect(sanitizeUpdatePrefs({}).autoUpdate).toBe(true);
    expect(sanitizeUpdatePrefs({ autoUpdate: false }).autoUpdate).toBe(false);
    // A non-boolean is junk, not "off".
    expect(sanitizeUpdatePrefs({ autoUpdate: "false" }).autoUpdate).toBe(true);
  });

  it("keeps only non-empty string versions, deduped", () => {
    expect(
      sanitizeUpdatePrefs({ skippedVersions: ["1.0.0", "1.0.0", "", 2, null, "2.0.0"] }).skippedVersions,
    ).toEqual(["1.0.0", "2.0.0"]);
    expect(sanitizeUpdatePrefs({ skippedVersions: "1.0.0" }).skippedVersions).toEqual([]);
  });
});

describe("load / save round-trip", () => {
  it("returns defaults when the file is absent", async () => {
    expect(await loadUpdatePrefs(prefsPath)).toEqual(DEFAULT_UPDATE_PREFS);
  });

  it("returns defaults (never throws) on a corrupt file", async () => {
    await saveUpdatePrefs({ autoUpdate: false, skippedVersions: ["9.9.9"], lastAutoCheckAt: 0 }, prefsPath);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(prefsPath, "{ not json");
    expect(await loadUpdatePrefs(prefsPath)).toEqual(DEFAULT_UPDATE_PREFS);
  });

  it("persists and reloads both fields", async () => {
    await saveUpdatePrefs({ autoUpdate: false, skippedVersions: ["1.2.3"], lastAutoCheckAt: 0 }, prefsPath);
    expect(await loadUpdatePrefs(prefsPath)).toEqual({
      autoUpdate: false,
      skippedVersions: ["1.2.3"],
      lastAutoCheckAt: 0,
    });
  });
});

describe("addSkippedVersion", () => {
  it("appends and dedupes without disturbing autoUpdate", async () => {
    await saveUpdatePrefs({ autoUpdate: false, skippedVersions: [], lastAutoCheckAt: 0 }, prefsPath);
    await addSkippedVersion("1.0.0", prefsPath);
    await addSkippedVersion("1.0.0", prefsPath); // dupe — no-op
    await addSkippedVersion("2.0.0", prefsPath);
    expect(await loadUpdatePrefs(prefsPath)).toEqual({
      autoUpdate: false,
      skippedVersions: ["1.0.0", "2.0.0"],
      lastAutoCheckAt: 0,
    });
  });

  it("works from a fresh (absent) file", async () => {
    await addSkippedVersion("0.4.2", prefsPath);
    expect((await loadUpdatePrefs(prefsPath)).skippedVersions).toEqual(["0.4.2"]);
  });
});

describe("clearSkippedVersions", () => {
  it("empties the list but keeps autoUpdate", async () => {
    await saveUpdatePrefs(
      { autoUpdate: true, skippedVersions: ["1.0.0", "2.0.0"], lastAutoCheckAt: 0 },
      prefsPath,
    );
    await clearSkippedVersions(prefsPath);
    expect(await loadUpdatePrefs(prefsPath)).toEqual({
      autoUpdate: true,
      skippedVersions: [],
      lastAutoCheckAt: 0,
    });
  });

  it("does not create a file when there is nothing to clear", async () => {
    await clearSkippedVersions(prefsPath);
    expect(existsSync(prefsPath)).toBe(false);
  });
});

describe("shouldRunAutoCheck", () => {
  const HOUR = 60 * 60 * 1000;

  it("runs when nothing has ever been checked, and after the cadence elapses", () => {
    expect(shouldRunAutoCheck(0, Date.now(), 4 * HOUR)).toBe(true);
    expect(shouldRunAutoCheck(1_000, 1_000 + 4 * HOUR, 4 * HOUR)).toBe(true);
  });

  it("skips a relaunch inside the cadence — GitHub rate-limits per IP", () => {
    // A day of test installs (each launch = one unauthenticated latest.yml
    // fetch) earned a 429, after which every boot check failed on a healthy
    // machine. Restarting must not cost a fresh request.
    expect(shouldRunAutoCheck(1_000, 1_000 + 5 * 60_000, 4 * HOUR)).toBe(false);
  });

  it("never wedges on a future timestamp, because the sanitizer drops it", () => {
    const future = Date.now() + 10 * HOUR;
    expect(sanitizeUpdatePrefs({ lastAutoCheckAt: future }).lastAutoCheckAt).toBe(future);
    // …and a non-number/negative heals to 0, which always checks.
    expect(sanitizeUpdatePrefs({ lastAutoCheckAt: -5 }).lastAutoCheckAt).toBe(0);
    expect(sanitizeUpdatePrefs({ lastAutoCheckAt: "soon" }).lastAutoCheckAt).toBe(0);
    expect(shouldRunAutoCheck(0, Date.now(), 4 * HOUR)).toBe(true);
  });
});

describe("recordAutoCheck", () => {
  it("stamps the time while preserving the other prefs", async () => {
    await saveUpdatePrefs({ autoUpdate: false, skippedVersions: ["9.9.9"], lastAutoCheckAt: 0 }, prefsPath);
    await recordAutoCheck(1_700_000_000_000, prefsPath);
    expect(await loadUpdatePrefs(prefsPath)).toEqual({
      autoUpdate: false,
      skippedVersions: ["9.9.9"],
      lastAutoCheckAt: 1_700_000_000_000,
    });
  });
});
