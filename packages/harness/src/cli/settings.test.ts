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
    await saveSettings({ telemetryOptIn: true, recentDirs: ["/a"] });
    expect(await hasStoredSettings()).toBe(true);
    expect(await loadSettings()).toEqual({ telemetryOptIn: true, recentDirs: ["/a"] });
  });

  it("recordRecentDir prepends and dedupes", async () => {
    await recordRecentDir("/a");
    await recordRecentDir("/b");
    await recordRecentDir("/a");
    const settings = await loadSettings();
    expect(settings.recentDirs).toEqual(["/a", "/b"]);
  });

  it("recordRecentDir caps history at 10 entries", async () => {
    for (let i = 0; i < 15; i++) {
      await recordRecentDir(`/dir-${i}`);
    }
    const settings = await loadSettings();
    expect(settings.recentDirs).toHaveLength(10);
    expect(settings.recentDirs[0]).toBe("/dir-14");
  });
});
