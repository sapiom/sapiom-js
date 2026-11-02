/**
 * Version pins that must move together. Packaging runs in a `pnpm deploy --prod`
 * dir without the `electron` devDependency, so electron-builder builds whatever
 * `electronVersion` says; a one-sided bump ships a runtime the code and lockfile
 * were never tested on. The macOS floor is stated twice too (bundle plist and
 * update manifest), and the two must agree.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DARWIN_MINIMUM_RELEASE, MAC_MINIMUM_SYSTEM_VERSION } from "./mac-minimum.js";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  devDependencies: Record<string, string>;
};
const builderYml = readFileSync(new URL("../../electron-builder.yml", import.meta.url), "utf8");

describe("electron version pins", () => {
  it("pins the electron devDependency to an exact version", () => {
    expect(pkg.devDependencies.electron).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("packages the same Electron the devDependency installs", () => {
    expect(builderYml).toMatch(new RegExp(`^electronVersion: ${pkg.devDependencies.electron}$`, "m"));
  });
});

describe("macOS floor", () => {
  it("declares the same minimum in electron-builder.yml and mac-minimum.ts", () => {
    expect(builderYml).toMatch(
      new RegExp(`^  minimumSystemVersion: "${MAC_MINIMUM_SYSTEM_VERSION}"$`, "m"),
    );
  });

  it("maps it to its Darwin release (macOS major + 9)", () => {
    const major = Number(MAC_MINIMUM_SYSTEM_VERSION.split(".")[0]);
    expect(DARWIN_MINIMUM_RELEASE).toBe(`${major + 9}.0.0`);
  });
});
