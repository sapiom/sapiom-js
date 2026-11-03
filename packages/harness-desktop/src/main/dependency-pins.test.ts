/**
 * Dependency floors for the packaged runtime. A lockfile re-resolve, a merge or a
 * revert can quietly bring back an older Electron or builder chain; these read
 * the three files that decide what ships. Floors, not equalities, so a later
 * upgrade stays green.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), "utf8");
const pkg = JSON.parse(read("../../package.json")) as {
  dependencies?: Record<string, string>;
  devDependencies: Record<string, string>;
  engines: { node: string };
};
const lockfile = read("../../../../pnpm-lock.yaml");
const workspace = read("../../../../pnpm-workspace.yaml");

type Version = [number, number, number];

/** The x.y.z a version or a `^`/`~`/`>=` range starts from. */
function floorOf(spec: string): Version {
  const match = /^(?:\^|~|>=)?\s*(\d+)\.(\d+)\.(\d+)/.exec(spec);
  if (!match) throw new Error(`no version floor in "${spec}"`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function atLeast(actual: Version, minimum: string): boolean {
  const min = floorOf(minimum);
  for (let i = 0; i < 3; i += 1) {
    if (actual[i] !== min[i]) return actual[i] > min[i];
  }
  return true;
}

/** Every version of `name` in the lockfile's packages and snapshots sections. */
function lockedVersions(name: string): string[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const key = new RegExp(`^  '?${escaped}@(\\d+\\.\\d+\\.\\d+)[^:]*'?:$`, "gm");
  return [...new Set([...lockfile.matchAll(key)].map((match) => match[1]))];
}

const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

describe("package.json floors", () => {
  it("pins electron exactly, at 45.2.1 or later", () => {
    expect(pkg.devDependencies.electron).toMatch(/^\d+\.\d+\.\d+$/);
    expect(atLeast(floorOf(pkg.devDependencies.electron), "45.2.1")).toBe(true);
  });

  it.each([
    ["electron-builder", "26.18.0"],
    ["electron-updater", "6.8.11"],
    ["@electron/rebuild", "4.2.1"],
    ["@types/node", "24.0.0"],
  ])("declares %s from %s", (name, minimum) => {
    expect(allDeps[name], name).toBeDefined();
    expect(atLeast(floorOf(allDeps[name]), minimum)).toBe(true);
  });

  it("requires Node 22.12 or later, Electron's own floor", () => {
    expect(atLeast(floorOf(pkg.engines.node), "22.12.0")).toBe(true);
  });

  it("drops @electron/notarize", () => {
    expect(allDeps["@electron/notarize"]).toBeUndefined();
  });
});

describe("pnpm-lock.yaml floors", () => {
  it("locks electron at exactly the devDependency version", () => {
    expect(lockedVersions("electron")).toEqual([pkg.devDependencies.electron]);
  });

  it.each([
    ["app-builder-lib", "26.18.0"],
    ["@electron/rebuild", "4.0.0"],
  ])("locks %s at %s or later only", (name, minimum) => {
    const versions = lockedVersions(name);
    expect(versions.length, name).toBeGreaterThan(0);
    for (const version of versions) expect(atLeast(floorOf(version), minimum), `${name}@${version}`).toBe(true);
  });
});

describe("pnpm-workspace.yaml", () => {
  it("has no @electron/rebuild override, which would pin app-builder-lib's own below v4", () => {
    expect(workspace).not.toMatch(/^\s+["']?@electron\/rebuild["']?(@[^:]*)?\s*:/m);
  });
});
