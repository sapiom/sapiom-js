import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureSapiomMcp, resolveSapiomMcpEntry } from "./mcp-install.js";

let root: string;

function makePrefix(layout: "windows" | "posix", bin: unknown = "./dist/index.js"): string {
  root = mkdtempSync(path.join(tmpdir(), "sapiom-mcp-install-"));
  const modules =
    layout === "windows" ? path.join(root, "node_modules") : path.join(root, "lib", "node_modules");
  const pkgDir = path.join(modules, "@sapiom", "mcp");
  mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
  writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "@sapiom/mcp", bin }));
  writeFileSync(path.join(pkgDir, "dist", "index.js"), "// entry\n");
  return root;
}

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
  it("uses an existing install immediately and refreshes it in the background", async () => {
    const prefix = makePrefix("windows");
    const install = vi.fn(async () => ({ ok: true }));
    const entry = await ensureSapiomMcp({ prefix, smoke: false, devMode: false, install });
    expect(entry).toContain("index.js");
    // Background refresh was kicked off but not awaited for the result.
    expect(install).toHaveBeenCalledTimes(1);
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
    const entry = await ensureSapiomMcp({ prefix, smoke: false, devMode: false, install });
    expect(entry).toContain("index.js");
  });

  it("never touches the network in smoke, and never installs in dev", async () => {
    root = mkdtempSync(path.join(tmpdir(), "sapiom-mcp-install-"));
    const install = vi.fn(async () => ({ ok: true }));
    expect(await ensureSapiomMcp({ prefix: root, smoke: true, devMode: false, install })).toBeNull();
    expect(await ensureSapiomMcp({ prefix: root, smoke: false, devMode: true, install })).toBeNull();
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
      onLine: (line) => lines.push(line),
    });
    expect(entry).toContain("index.js");
    expect(lines.join("\n")).toContain("non-zero");
  });
});
