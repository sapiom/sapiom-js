/**
 * The oldest macOS this build runs on, and the update-manifest floor that keeps
 * older Macs from installing it. Pure: no `electron`, so it is unit-tested and
 * `scripts/pack.mjs` imports it from `dist/` (same pattern as `update-policy`).
 *
 * `mac.minimumSystemVersion` in `electron-builder.yml` only sets the bundle's
 * `LSMinimumSystemVersion`. An installed app decides whether to take an update
 * from `latest-mac.yml`: electron-updater skips the update when the manifest's
 * `minimumSystemVersion` is above `os.release()`, which on macOS is the Darwin
 * version, not the marketing one. Without the stamp, a Mac below the floor
 * auto-updates into a build it cannot launch.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Electron 44+ requires macOS 13. Must equal `mac.minimumSystemVersion` (pinned by a test). */
export const MAC_MINIMUM_SYSTEM_VERSION = "13.0";

/** Darwin release of macOS 13 (macOS major + 9), what `os.release()` reports there. */
export const DARWIN_MINIMUM_RELEASE = "22.0.0";

const FIELD = /^minimumSystemVersion:.*$/m;

/** Sets the manifest's top-level `minimumSystemVersion`; every other line is left byte-identical. */
export function stampMinimumSystemVersion(manifest: string): string {
  const line = `minimumSystemVersion: ${DARWIN_MINIMUM_RELEASE}`;
  if (FIELD.test(manifest)) return manifest.replace(FIELD, line);
  return `${manifest}${manifest.endsWith("\n") || manifest === "" ? "" : "\n"}${line}\n`;
}

/**
 * Stamps every `*-mac.yml` in an electron-builder output dir and returns their
 * names. Throws when there is none, so a mac packaging run cannot silently
 * publish an unstamped manifest.
 */
export function stampMacManifests(releaseDir: string): string[] {
  const manifests = readdirSync(releaseDir).filter((name) => name.endsWith("-mac.yml"));
  if (manifests.length === 0) {
    throw new Error(`no *-mac.yml update manifest in ${releaseDir} to stamp`);
  }
  for (const name of manifests) {
    const file = join(releaseDir, name);
    writeFileSync(file, stampMinimumSystemVersion(readFileSync(file, "utf8")), "utf8");
  }
  return manifests;
}
