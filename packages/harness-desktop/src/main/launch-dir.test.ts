import { describe, it, expect } from "vitest";
import { resolveLaunchDir } from "./launch-dir.js";

const HOME = "/Users/x/.sapiom/harness";

describe("resolveLaunchDir", () => {
  it("returns the harness home by default", () => {
    expect(resolveLaunchDir({ harnessHome: HOME, isDir: () => false })).toBe(HOME);
  });

  it("uses a valid SAPIOM_LAUNCH_DIR override", () => {
    const override = "/tmp/dev-workspace";
    expect(
      resolveLaunchDir({ override, harnessHome: HOME, isDir: (p) => p === override }),
    ).toBe(override);
  });

  it("falls back to the harness home when the override isn't a real dir", () => {
    expect(
      resolveLaunchDir({ override: "/does/not/exist", harnessHome: HOME, isDir: () => false }),
    ).toBe(HOME);
  });

  it("ignores an unset override", () => {
    expect(
      resolveLaunchDir({ override: undefined, harnessHome: HOME, isDir: () => false }),
    ).toBe(HOME);
  });

  // The regression this module exists to prevent: the launch dir must never be
  // a most-recent *project* dir — that is what nested `<launchDir>/projects/…`.
  // resolveLaunchDir takes no recentDirs input at all, so a drifted history
  // can't reach it; the harness home is the only non-override result.
  it("never returns a project dir even when one was the most recent (no recentDirs input)", () => {
    const recentProject = `${HOME}/projects/return-test/projects/pull-request-opens`;
    // Even if that path exists, it can only be selected via `override`; the
    // history path is gone, so the result is the stable home.
    expect(
      resolveLaunchDir({ harnessHome: HOME, isDir: (p) => p === recentProject }),
    ).toBe(HOME);
  });
});
