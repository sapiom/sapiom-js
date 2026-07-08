import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

let tmpDir: string;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return { ...actual, homedir: () => tmpDir };
});

import { hasStoredSettings, loadSettings, saveSettings, recordRecentDir } from "./settings.js";

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
    expect(await loadSettings()).toEqual({ telemetryOptIn: false, recentDirs: [] });
  });

  it("round-trips saved settings", async () => {
    const a = await makeRealDir("a");
    await saveSettings({ telemetryOptIn: true, recentDirs: [a] });
    expect(await hasStoredSettings()).toBe(true);
    expect(await loadSettings()).toEqual({ telemetryOptIn: true, recentDirs: [a] });
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
});

/** Mirrors settingsFilePath()'s HARNESS_PATHS.settings location for direct-write test setup. */
function settingsFilePathFor(home: string): string {
  return path.join(home, ".sapiom", "harness", "settings.json");
}
