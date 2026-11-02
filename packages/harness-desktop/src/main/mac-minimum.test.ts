/**
 * The mac update-manifest floor. A wrong stamp does not fail loudly: a Mac below
 * the floor would auto-update into a build that cannot launch, or one above it
 * would stop receiving updates. The second suite runs the installed
 * electron-updater's own check against a stamped manifest, because that check
 * (not ours) is what an installed app applies.
 */
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  DARWIN_MINIMUM_RELEASE,
  stampMacManifests,
  stampMinimumSystemVersion,
} from "./mac-minimum.js";

// Shape of an electron-builder latest-mac.yml.
const MANIFEST = [
  "version: 0.5.0",
  "files:",
  "  - url: Sapiom-0.5.0-arm64-mac.zip",
  "    sha512: abc123==",
  "    size: 104857600",
  "path: Sapiom-0.5.0-arm64-mac.zip",
  "sha512: abc123==",
  "releaseDate: '2026-11-02T20:00:00.000Z'",
  "",
].join("\n");

describe("stampMinimumSystemVersion", () => {
  it("appends the floor and leaves every other line byte-identical", () => {
    const stamped = stampMinimumSystemVersion(MANIFEST);
    expect(stamped).toBe(`${MANIFEST}minimumSystemVersion: ${DARWIN_MINIMUM_RELEASE}\n`);
  });

  it("replaces an older value instead of adding a second line", () => {
    const stamped = stampMinimumSystemVersion(`${MANIFEST}minimumSystemVersion: 20.0.0\n`);
    expect(stamped.match(/^minimumSystemVersion:/gm)).toHaveLength(1);
    expect(stamped).toContain(`minimumSystemVersion: ${DARWIN_MINIMUM_RELEASE}`);
  });

  it("is a no-op on an already stamped manifest", () => {
    const once = stampMinimumSystemVersion(MANIFEST);
    expect(stampMinimumSystemVersion(once)).toBe(once);
  });

  it("adds the missing newline before the field", () => {
    expect(stampMinimumSystemVersion("version: 0.5.0")).toBe(
      `version: 0.5.0\nminimumSystemVersion: ${DARWIN_MINIMUM_RELEASE}\n`,
    );
  });
});

describe("stampMacManifests", () => {
  const dirs: string[] = [];
  const releaseDir = (files: Record<string, string>): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-mac-manifest-"));
    dirs.push(dir);
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
    return dir;
  };

  afterAll(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("stamps the mac manifests of both channels and nothing else", () => {
    const dir = releaseDir({
      "latest-mac.yml": MANIFEST,
      "beta-mac.yml": MANIFEST,
      "latest-linux.yml": MANIFEST,
    });
    expect(stampMacManifests(dir).sort()).toEqual(["beta-mac.yml", "latest-mac.yml"]);
    for (const name of ["latest-mac.yml", "beta-mac.yml"]) {
      expect(fs.readFileSync(path.join(dir, name), "utf8")).toBe(stampMinimumSystemVersion(MANIFEST));
    }
    expect(fs.readFileSync(path.join(dir, "latest-linux.yml"), "utf8")).toBe(MANIFEST);
  });

  it("throws when there is no mac manifest, so pack.mjs fails the build", () => {
    const dir = releaseDir({ "latest-linux.yml": MANIFEST });
    expect(() => stampMacManifests(dir)).toThrow(/no \*-mac\.yml/);
  });
});

describe("an installed app reading the stamped manifest", () => {
  // The real electron-updater: AppUpdater.js requires `electron` only lazily, and
  // reads `os.release()` through the CommonJS `os` object on every call.
  const require = createRequire(import.meta.url);
  const updaterDir = path.dirname(require.resolve("electron-updater/package.json"));
  const updaterRequire = createRequire(path.join(updaterDir, "package.json"));
  const { AppUpdater } = updaterRequire("./out/AppUpdater.js") as {
    AppUpdater: { prototype: { checkIfUpdateSupported(info: unknown): boolean } };
  };
  const yaml = updaterRequire("js-yaml") as { load(text: string): unknown };
  const cjsOs = updaterRequire("os") as typeof os;
  const updateInfo = yaml.load(stampMinimumSystemVersion(MANIFEST));
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  const supportedOn = (release: string): boolean => {
    vi.spyOn(cjsOs, "release").mockReturnValue(release);
    return AppUpdater.prototype.checkIfUpdateSupported.call({ _logger: logger }, updateInfo);
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips the update on macOS 11 and 12", () => {
    expect(supportedOn("20.6.0")).toBe(false);
    expect(supportedOn("21.6.0")).toBe(false);
  });

  it("takes the update on macOS 13 and later", () => {
    expect(supportedOn("22.6.0")).toBe(true);
    expect(supportedOn("24.1.0")).toBe(true);
  });
});
