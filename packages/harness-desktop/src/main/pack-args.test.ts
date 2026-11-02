/**
 * pack.mjs's argv allowlist. A spelling it lets through reaches electron-builder,
 * where a mac build could skip the update-manifest stamp or upload latest-mac.yml
 * before it; the spawn suite proves pack.mjs applies the check before any work.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type PackArgs = { platform: string; passthrough: string[] };
const { parsePackArgs } = (await import(
  new URL("../../scripts/pack-args.mjs", import.meta.url).href
)) as { parsePackArgs(argv: string[], host: string): PackArgs };
const packScript = fileURLToPath(new URL("../../scripts/pack.mjs", import.meta.url));

describe("parsePackArgs", () => {
  it("defaults to the host platform and drops empty args", () => {
    expect(parsePackArgs([], "--linux")).toEqual({ platform: "--linux", passthrough: [] });
    expect(parsePackArgs(["", "--mac", ""], "--linux")).toEqual({ platform: "--mac", passthrough: [] });
  });

  it("passes config overrides through, as the release run does", () => {
    expect(parsePackArgs(["--mac", "-c.mac.notarize=true"], "--linux")).toEqual({
      platform: "--mac",
      passthrough: ["-c.mac.notarize=true"],
    });
    expect(parsePackArgs(["--win", "--config.publish.channel=beta"], "--linux").passthrough).toEqual([
      "--config.publish.channel=beta",
    ]);
  });

  it("refuses any other platform spelling", () => {
    for (const platform of ["--macos", "-m", "-o", "--windows", "-l", "--mac=true", "-c.mac.notarize=true"]) {
      expect(() => parsePackArgs([platform], "--linux"), platform).toThrow(/platform must be one of/);
    }
  });

  it("refuses every passthrough arg that is not a config override", () => {
    for (const args of [
      ["--publish", "always"],
      ["--publish", "never"],
      ["--publish=onTag"],
      ["-p", "onTagOrDraft"],
      ["--p=always"],
      ["-mp=always"],
      ["--macos"],
      ["-m"],
      ["-c", "other-config.yml"],
      ["-c.mac.notarize=true", "--publish"],
    ]) {
      expect(() => parsePackArgs(["--mac", ...args], "--linux"), args.join(" ")).toThrow(
        /only -c\.<key> overrides/,
      );
    }
  });
});

describe("pack.mjs", () => {
  it("rejects a mac alias or a publish flag before it deploys or builds anything", () => {
    for (const args of [
      ["--macos", "--publish", "always"],
      ["-m"],
      ["--mac", "--publish", "always"],
      ["--linux", "--mac"],
    ]) {
      const result = spawnSync(process.execPath, [packScript, ...args], { encoding: "utf8" });
      expect(result.status, args.join(" ")).toBe(1);
      expect(result.stderr).toMatch(/pack\.mjs: (the platform must be one of|only -c\.<key> overrides)/);
      expect(result.stdout).not.toContain("[pack] pnpm deploy");
    }
  });
});
