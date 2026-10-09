import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureSapiomMcp,
  isOlderVersion,
  resolveSapiomMcpEntry,
  sapiomMcpVersionAt,
} from "./mcp-install.js";

let root: string;

function makePrefix(
  layout: "windows" | "posix",
  bin: unknown = "./dist/index.js",
  version = "0.19.2",
): string {
  root = mkdtempSync(path.join(tmpdir(), "sapiom-mcp-install-"));
  const modules =
    layout === "windows" ? path.join(root, "node_modules") : path.join(root, "lib", "node_modules");
  writePackage(path.join(modules, "@sapiom", "mcp"), version, bin);
  return root;
}

function writePackage(pkgDir: string, version: string, bin: unknown = "./dist/index.js"): string {
  mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
  writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: "@sapiom/mcp", version, bin }),
  );
  writeFileSync(path.join(pkgDir, "dist", "index.js"), "// entry\n");
  return path.join(pkgDir, "dist", "index.js");
}

const latest = (version: string | null) => async () => version;

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resolveSapiomMcpEntry", () => {
  it("resolves the entry from the Windows global layout (<prefix>/node_modules)", () => {
    const prefix = makePrefix("windows");
    expect(resolveSapiomMcpEntry(prefix)).toBe(
      path.join(prefix, "node_modules", "@sapiom", "mcp", "dist", "index.js"),
    );
  });

  it("resolves the entry from the POSIX global layout (<prefix>/lib/node_modules)", () => {
    const prefix = makePrefix("posix");
    expect(resolveSapiomMcpEntry(prefix)).toBe(
      path.join(prefix, "lib", "node_modules", "@sapiom", "mcp", "dist", "index.js"),
    );
  });

  it("reads the bin path from the package rather than assuming a layout", () => {
    const prefix = makePrefix("windows", { "sapiom-mcp": "./dist/index.js" });
    expect(resolveSapiomMcpEntry(prefix)).toBe(
      path.join(prefix, "node_modules", "@sapiom", "mcp", "dist", "index.js"),
    );
  });

  it("returns null when the package (or its bin target) is absent", () => {
    root = mkdtempSync(path.join(tmpdir(), "sapiom-mcp-install-"));
    expect(resolveSapiomMcpEntry(root)).toBeNull();
  });
});

describe("ensureSapiomMcp", () => {
  it("keeps an install that matches the registry's latest, without reinstalling", async () => {
    // The refresh must never be backgrounded: boot bakes this path into every
    // session's MCP config, and npm refreshes by removing and re-extracting
    // that exact directory — racing the first session's spawn.
    const prefix = makePrefix("windows", undefined, "0.19.2");
    const install = vi.fn(async () => ({ ok: true }));
    const entry = await ensureSapiomMcp({
      prefix,
      smoke: false,
      devMode: false,
      install,
      latestVersion: latest("0.19.2"),
    });
    expect(entry).toContain("index.js");
    expect(install).not.toHaveBeenCalled();
  });

  it("reinstalls — awaited, before any session exists — when the registry has a newer release", async () => {
    // The shipped failure: a 0.18.0 install kept launching for days after
    // 0.19.0 published, because the refresh waited on a 7-day file age.
    const prefix = makePrefix("windows", undefined, "0.18.0");
    const install = vi.fn(async () => ({ ok: true }));
    const entry = await ensureSapiomMcp({
      prefix,
      smoke: false,
      devMode: false,
      install,
      latestVersion: latest("0.19.2"),
    });
    expect(install).toHaveBeenCalledTimes(1);
    expect(entry).toContain("index.js");
  });

  it("keeps the install when the registry is unreachable", async () => {
    const prefix = makePrefix("windows", undefined, "0.18.0");
    const install = vi.fn(async () => ({ ok: true }));
    const entry = await ensureSapiomMcp({
      prefix,
      smoke: false,
      devMode: false,
      install,
      latestVersion: async () => {
        throw new Error("offline");
      },
    });
    expect(install).not.toHaveBeenCalled();
    expect(entry).toContain("index.js");
  });

  it("keeps a usable install when a refresh fails, rather than falling back to npx", async () => {
    const prefix = makePrefix("windows", undefined, "0.18.0");
    const entry = await ensureSapiomMcp({
      prefix,
      smoke: false,
      devMode: false,
      install: async () => ({ ok: false }),
      latestVersion: latest("0.19.2"),
    });
    expect(entry).toContain("index.js");
  });

  it("launches the bundled copy when the install is older than it", async () => {
    // The harness's prompts are written against the bundled version: an
    // older install whose refresh failed must not be the one sessions get.
    const prefix = makePrefix("windows", undefined, "0.18.0");
    const bundled = writePackage(path.join(prefix, "app", "@sapiom", "mcp"), "0.19.2");
    const lines: string[] = [];
    const entry = await ensureSapiomMcp({
      prefix,
      smoke: false,
      devMode: false,
      install: async () => ({ ok: false }),
      latestVersion: latest(null),
      bundledEntry: bundled,
      onLine: (line) => lines.push(line),
    });
    expect(entry).toBe(bundled);
    expect(lines.join("\n")).toContain("older than the bundled 0.19.2");
  });

  it("prefers the install when it is as new as the bundled copy or newer", async () => {
    const prefix = makePrefix("windows", undefined, "0.20.0");
    const bundled = writePackage(path.join(prefix, "app", "@sapiom", "mcp"), "0.19.2");
    const entry = await ensureSapiomMcp({
      prefix,
      smoke: false,
      devMode: false,
      install: async () => ({ ok: true }),
      latestVersion: latest("0.20.0"),
      bundledEntry: bundled,
    });
    expect(entry).toBe(resolveSapiomMcpEntry(prefix));
  });

  it("launches the bundled copy when nothing could be installed", async () => {
    root = mkdtempSync(path.join(tmpdir(), "sapiom-mcp-install-"));
    const bundled = writePackage(path.join(root, "app", "@sapiom", "mcp"), "0.19.2");
    const entry = await ensureSapiomMcp({
      prefix: root,
      smoke: false,
      devMode: false,
      install: async () => ({ ok: false }),
      latestVersion: latest(null),
      bundledEntry: bundled,
    });
    expect(entry).toBe(bundled);
  });

  it("installs when missing, then resolves the fresh entry", async () => {
    root = mkdtempSync(path.join(tmpdir(), "sapiom-mcp-install-"));
    const prefix = root;
    const install = vi.fn(async () => {
      // Simulate npm materializing the package.
      const pkgDir = path.join(prefix, "node_modules", "@sapiom", "mcp");
      mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
      writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ bin: "./dist/index.js" }));
      writeFileSync(path.join(pkgDir, "dist", "index.js"), "");
      return { ok: true };
    });
    const entry = await ensureSapiomMcp({ prefix, smoke: false, devMode: false, install, latestVersion: latest(null) });
    expect(entry).toContain("index.js");
  });

  it("never touches the network in smoke, and never installs in dev", async () => {
    root = mkdtempSync(path.join(tmpdir(), "sapiom-mcp-install-"));
    const install = vi.fn(async () => ({ ok: true }));
    expect(await ensureSapiomMcp({ prefix: root, smoke: true, devMode: false, install, latestVersion: latest(null) })).toBeNull();
    expect(await ensureSapiomMcp({ prefix: root, smoke: false, devMode: true, install, latestVersion: latest(null) })).toBeNull();
    expect(install).not.toHaveBeenCalled();
  });

  it("in dev, uses an install a packaged run left but never refreshes it", async () => {
    // `pnpm dev` shares the packaged app's userData prefix: installing from
    // there would hit the registry every launch, clobber a locally-built test
    // copy, and rewrite a tree a packaged instance may be running from.
    const prefix = makePrefix("windows");
    const install = vi.fn(async () => ({ ok: true }));
    const entry = await ensureSapiomMcp({
      prefix,
      smoke: false,
      devMode: true,
      install,
      latestVersion: latest("9.9.9"),
    });
    expect(entry).toContain("index.js");
    expect(install).not.toHaveBeenCalled();
  });

  it("falls back to null (npx launch) when the install fails and nothing resolved — never throws", async () => {
    root = mkdtempSync(path.join(tmpdir(), "sapiom-mcp-install-"));
    const lines: string[] = [];
    const entry = await ensureSapiomMcp({
      prefix: root,
      smoke: false,
      devMode: false,
      install: async () => ({ ok: false }),
      latestVersion: latest(null),
      onLine: (line) => lines.push(line),
    });
    expect(entry).toBeNull();
    expect(lines.join("\n")).toContain("fall back");
  });

  it("wipes a TORN install before reinstalling — npm cannot repair over one", async () => {
    // The shipped state: the app quit mid-extraction, leaving the package dir
    // holding only its dependency subtree (no package.json, no dist). Every
    // reinstall then failed on the leftovers and every session fell back to
    // the npx launch — the persistent console window on Windows, forever.
    root = mkdtempSync(path.join(tmpdir(), "sapiom-mcp-install-"));
    const prefix = root;
    const pkgDir = path.join(prefix, "node_modules", "@sapiom", "mcp");
    mkdirSync(path.join(pkgDir, "node_modules", "zod"), { recursive: true });

    const lines: string[] = [];
    const install = vi.fn(async () => {
      // npm only succeeds because the torn tree is gone by the time it runs.
      expect(existsSync(pkgDir)).toBe(false);
      mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
      writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ bin: "./dist/index.js" }));
      writeFileSync(path.join(pkgDir, "dist", "index.js"), "");
      return { ok: true };
    });
    const entry = await ensureSapiomMcp({
      prefix,
      smoke: false,
      devMode: false,
      install,
      latestVersion: latest(null),
      onLine: (line) => lines.push(line),
    });
    expect(entry).toContain("index.js");
    expect(lines.join("\n")).toContain("torn");
  });

  it("uses the package when npm exits non-zero but the files resolved anyway", async () => {
    // npm can materialize a usable package and still exit non-zero (bin-shim
    // collision, unrelated EPERM). Trusting only the exit code left a machine
    // with the package on disk and sessions still on the npx launch.
    root = mkdtempSync(path.join(tmpdir(), "sapiom-mcp-install-"));
    const prefix = root;
    const lines: string[] = [];
    const install = vi.fn(async () => {
      const pkgDir = path.join(prefix, "node_modules", "@sapiom", "mcp");
      mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
      writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ bin: "./dist/index.js" }));
      writeFileSync(path.join(pkgDir, "dist", "index.js"), "");
      return { ok: false };
    });
    const entry = await ensureSapiomMcp({
      prefix,
      smoke: false,
      devMode: false,
      install,
      latestVersion: latest(null),
      onLine: (line) => lines.push(line),
    });
    expect(entry).toContain("index.js");
    expect(lines.join("\n")).toContain("non-zero");
  });
});

describe("version helpers", () => {
  it("compares release versions numerically", () => {
    expect(isOlderVersion("0.18.0", "0.19.2")).toBe(true);
    expect(isOlderVersion("0.9.0", "0.10.0")).toBe(true);
    expect(isOlderVersion("0.19.2", "0.19.2")).toBe(false);
    expect(isOlderVersion("1.0.0", "0.19.2")).toBe(false);
    expect(isOlderVersion(null, "0.19.2")).toBe(false);
    expect(isOlderVersion("0.18.0", "garbage")).toBe(false);
  });

  it("reads the version from the package that owns an entry", () => {
    root = mkdtempSync(path.join(tmpdir(), "sapiom-mcp-install-"));
    const entry = writePackage(path.join(root, "@sapiom", "mcp"), "0.19.2");
    expect(sapiomMcpVersionAt(entry)).toBe("0.19.2");
  });
});
