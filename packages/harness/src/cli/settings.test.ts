import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

let tmpDir: string;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return { ...actual, homedir: () => tmpDir };
});

import {
  hasStoredSettings,
  loadSettings,
  saveSettings,
  recordRecentDir,
  pruneDeadRecentDirs,
  readDisplayModeSync,
} from "./settings.js";

/** A real, existing directory to use as a valid recent-dir candidate. */
async function makeRealDir(name: string): Promise<string> {
  const dir = path.join(tmpDir, name);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

describe("settings persistence", () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-settings-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("reports no stored settings before first save", async () => {
    expect(await hasStoredSettings()).toBe(false);
  });

  it("loadSettings returns defaults when nothing is persisted", async () => {
    expect(await loadSettings()).toEqual({ telemetryOptIn: false, recentDirs: [], rollingSummary: false, displayMode: "dark" });
  });

  it("round-trips saved settings", async () => {
    const a = await makeRealDir("a");
    await saveSettings({ telemetryOptIn: true, recentDirs: [a] });
    expect(await hasStoredSettings()).toBe(true);
    expect(await loadSettings()).toEqual({ telemetryOptIn: true, recentDirs: [a], rollingSummary: false, displayMode: "dark" });
  });

  describe("recordRecentDir", () => {
    it("prepends and dedupes", async () => {
      const a = await makeRealDir("a");
      const b = await makeRealDir("b");
      await recordRecentDir(a);
      await recordRecentDir(b);
      await recordRecentDir(a);
      const settings = await loadSettings();
      expect(settings.recentDirs).toEqual([a, b]);
    });

    it("caps history at 8 entries", async () => {
      const dirs: string[] = [];
      for (let i = 0; i < 12; i++) {
        dirs.push(await makeRealDir(`dir-${i}`));
      }
      for (const dir of dirs) {
        await recordRecentDir(dir);
      }
      const settings = await loadSettings();
      expect(settings.recentDirs).toHaveLength(8);
      expect(settings.recentDirs[0]).toBe(dirs[11]);
    });

    it("silently drops entries that aren't absolute paths", async () => {
      const valid = await makeRealDir("valid");
      await recordRecentDir(valid);
      await recordRecentDir("this /Users/someone/project");
      const settings = await loadSettings();
      expect(settings.recentDirs).toEqual([valid]);
    });

    it("silently drops entries that don't exist on disk", async () => {
      const valid = await makeRealDir("valid");
      await recordRecentDir(valid);
      await recordRecentDir(path.join(tmpDir, "does-not-exist"));
      const settings = await loadSettings();
      expect(settings.recentDirs).toEqual([valid]);
    });

    it("silently drops entries that resolve to a file, not a directory", async () => {
      const valid = await makeRealDir("valid");
      const filePath = path.join(tmpDir, "a-file.txt");
      await fs.writeFile(filePath, "not a directory");
      await recordRecentDir(valid);
      await recordRecentDir(filePath);
      const settings = await loadSettings();
      expect(settings.recentDirs).toEqual([valid]);
    });

    it("expands a leading ~ before validating", async () => {
      const nested = await makeRealDir("nested");
      await recordRecentDir(`~/${path.basename(nested)}`);
      const settings = await loadSettings();
      expect(settings.recentDirs).toEqual([nested]);
    });

    it("normalizes trailing slashes and .. segments to the same entry", async () => {
      const a = await makeRealDir("a");
      await recordRecentDir(`${a}/`);
      await recordRecentDir(`${a}/../${path.basename(a)}`);
      const settings = await loadSettings();
      expect(settings.recentDirs).toEqual([a]);
    });

    it("dedupes case-sensitively", async () => {
      // Two distinct real directories differing only by case — both are kept
      // since the filesystem (here) treats them as different entries.
      const lower = await makeRealDir("case-test");
      const upper = await makeRealDir("CASE-TEST");
      await recordRecentDir(lower);
      await recordRecentDir(upper);
      const settings = await loadSettings();
      expect(settings.recentDirs).toEqual([upper, lower]);
    });
  });

  describe("loadSettings self-healing", () => {
    it("drops previously-recorded entries that no longer exist", async () => {
      const survivor = await makeRealDir("survivor");
      const doomed = await makeRealDir("doomed");
      await saveSettings({ telemetryOptIn: false, recentDirs: [doomed, survivor] });
      await fs.rm(doomed, { recursive: true, force: true });

      const settings = await loadSettings();
      expect(settings.recentDirs).toEqual([survivor]);
    });

    it("drops junk that was written before validation existed", async () => {
      const survivor = await makeRealDir("survivor");
      const filePath = settingsFilePathFor(tmpDir);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(
        filePath,
        JSON.stringify({
          telemetryOptIn: false,
          recentDirs: ["this /Users/someone/project", survivor, "relative/path"],
        }),
      );

      const settings = await loadSettings();
      expect(settings.recentDirs).toEqual([survivor]);
    });
  });

  describe("displayMode", () => {
    it("round-trips a mode, and reads back the same value the SPA will paint with", async () => {
      const settingsPath = path.join(tmpDir, "display", "settings.json");
      await saveSettings({ telemetryOptIn: false, recentDirs: [], displayMode: "system" }, settingsPath);

      expect((await loadSettings(settingsPath)).displayMode).toBe("system");
      // The sync reader is what the static router stamps into the HTML; it has
      // to agree with the async load or the page paints one mode and the
      // Settings panel then shows another.
      expect(readDisplayModeSync(settingsPath)).toBe("system");
    });

    it("falls back to dark for a missing, unknown, or unparseable value", async () => {
      // An install that predates the setting must keep opening dark, not start
      // following the OS because a field was added underneath it.
      const legacyPath = path.join(tmpDir, "legacy", "settings.json");
      await fs.mkdir(path.dirname(legacyPath), { recursive: true });
      await fs.writeFile(legacyPath, JSON.stringify({ telemetryOptIn: true, recentDirs: [] }));
      expect((await loadSettings(legacyPath)).displayMode).toBe("dark");

      // A value from a future build (or hand-edited junk) is not a mode this
      // build can paint, so it is not one it will honour.
      const junkPath = path.join(tmpDir, "junk", "settings.json");
      await fs.mkdir(path.dirname(junkPath), { recursive: true });
      await fs.writeFile(junkPath, JSON.stringify({ displayMode: "sepia" }));
      expect((await loadSettings(junkPath)).displayMode).toBe("dark");

      await fs.writeFile(junkPath, "{ not json");
      expect(readDisplayModeSync(junkPath)).toBeUndefined();
      expect(readDisplayModeSync(path.join(tmpDir, "nope", "settings.json"))).toBeUndefined();
    });

    it("does not persist an unknown mode through a save", async () => {
      const settingsPath = path.join(tmpDir, "save", "settings.json");
      await saveSettings(
        // A patch from an older/newer client; the store normalizes rather than
        // writing a value nothing can read back.
        { telemetryOptIn: false, recentDirs: [], displayMode: "sepia" as never },
        settingsPath,
      );
      expect(readDisplayModeSync(settingsPath)).toBe("dark");
    });
  });

  describe("explicit settingsPath", () => {
    it("reads and writes the given file instead of the home-dir default", async () => {
      const customPath = path.join(tmpDir, "custom-root", "settings.json");
      const a = await makeRealDir("a");
      await saveSettings({ telemetryOptIn: true, recentDirs: [a] }, customPath);

      expect(await hasStoredSettings(customPath)).toBe(true);
      expect(await loadSettings(customPath)).toEqual({ telemetryOptIn: true, recentDirs: [a], rollingSummary: false, displayMode: "dark" });
      // The (mocked-home) default location was never touched.
      expect(await hasStoredSettings()).toBe(false);
    });
  });

  describe("pruneDeadRecentDirs", () => {
    it("persists the removal of entries whose path no longer exists", async () => {
      const survivor = await makeRealDir("survivor");
      const doomed = await makeRealDir("doomed");
      await saveSettings({ telemetryOptIn: true, recentDirs: [doomed, survivor] });
      await fs.rm(doomed, { recursive: true, force: true });

      expect(await pruneDeadRecentDirs()).toEqual([doomed]);

      // Persisted on disk, not just filtered by loadSettings' own sanitize.
      const raw = JSON.parse(await fs.readFile(settingsFilePathFor(tmpDir), "utf-8")) as {
        telemetryOptIn: boolean;
        recentDirs: string[];
      };
      expect(raw.recentDirs).toEqual([survivor]);
      expect(raw.telemetryOptIn).toBe(true);
    });

    it("does not rewrite the file when every entry still exists", async () => {
      const a = await makeRealDir("a");
      await saveSettings({ telemetryOptIn: false, recentDirs: [a] });
      const before = await fs.stat(settingsFilePathFor(tmpDir));

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(await pruneDeadRecentDirs()).toEqual([]);
      const after = await fs.stat(settingsFilePathFor(tmpDir));
      expect(after.mtimeMs).toBe(before.mtimeMs);
    });

    it("does not create a settings file where none exists (first-run detection stays intact)", async () => {
      expect(await pruneDeadRecentDirs()).toEqual([]);
      expect(await hasStoredSettings()).toBe(false);
    });
  });
});

/** Mirrors settingsFilePath()'s HARNESS_PATHS.settings location for direct-write test setup. */
function settingsFilePathFor(home: string): string {
  return path.join(home, ".sapiom", "harness", "settings.json");
}
