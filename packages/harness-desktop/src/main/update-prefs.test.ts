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
  sanitizeUpdatePrefs,
  saveUpdatePrefs,
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
    await saveUpdatePrefs({ autoUpdate: false, skippedVersions: ["9.9.9"], preRelease: false }, prefsPath);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(prefsPath, "{ not json");
    expect(await loadUpdatePrefs(prefsPath)).toEqual(DEFAULT_UPDATE_PREFS);
  });

  it("persists and reloads every field", async () => {
    await saveUpdatePrefs({ autoUpdate: false, skippedVersions: ["1.2.3"], preRelease: true }, prefsPath);
    expect(await loadUpdatePrefs(prefsPath)).toEqual({
      autoUpdate: false,
      skippedVersions: ["1.2.3"],
      preRelease: true,
    });
  });
});

describe("addSkippedVersion", () => {
  it("appends and dedupes without disturbing autoUpdate", async () => {
    await saveUpdatePrefs({ autoUpdate: false, skippedVersions: [], preRelease: false }, prefsPath);
    await addSkippedVersion("1.0.0", prefsPath);
    await addSkippedVersion("1.0.0", prefsPath); // dupe — no-op
    await addSkippedVersion("2.0.0", prefsPath);
    expect(await loadUpdatePrefs(prefsPath)).toEqual({
      autoUpdate: false,
      skippedVersions: ["1.0.0", "2.0.0"],
      preRelease: false,
    });
  });

  it("works from a fresh (absent) file", async () => {
    await addSkippedVersion("0.4.2", prefsPath);
    expect((await loadUpdatePrefs(prefsPath)).skippedVersions).toEqual(["0.4.2"]);
  });
});

describe("clearSkippedVersions", () => {
  it("empties the list but keeps autoUpdate", async () => {
    await saveUpdatePrefs({ autoUpdate: true, skippedVersions: ["1.0.0", "2.0.0"], preRelease: false }, prefsPath);
    await clearSkippedVersions(prefsPath);
    expect(await loadUpdatePrefs(prefsPath)).toEqual({ autoUpdate: true, skippedVersions: [], preRelease: false });
  });

  it("does not create a file when there is nothing to clear", async () => {
    await clearSkippedVersions(prefsPath);
    expect(existsSync(prefsPath)).toBe(false);
  });
});
